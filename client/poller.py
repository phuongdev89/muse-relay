#!/usr/bin/env python3
"""Pull + push daemon for Muse Relay v6 (session login + RLS isolation).

Same job as muse_client.py but meant to run forever in the background:
- pulls new user messages into state/inbox.jsonl (paginated, oldest first, own project only — RLS)
- pushes reply files outbox/<thread_id>.txt to Supabase, then deletes them
- NEVER writes replies itself and never touches MEMORY.md — replies are written by
  Muse's scheduled run / wake hook; this daemon only moves them.

Auth: uses the Muse's own Relay Session value from config.json (long-lived GoTrue
session); the rotated live token in state/session.json (chmod 600) keeps the
daemon alive across restarts — config.json never needs changing again unless
the session is revoked.

A lockfile (state/puller.lock) guarantees exactly ONE puller per folder:
if muse_client.py is running, this daemon exits immediately (and vice versa).
"""
import json
import os
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from relay_auth import (  # noqa: E402
    AuthError, TransientError, acquire_lock, api, build_cfg, init_cursor,
    read_cursor, release_lock, send_pong_if_needed, signal_typing, write_cursor,
)

BASE = Path(__file__).resolve().parent
LOG = BASE / "state" / "poller.log"
POLL_PAUSE = 3.0


def log(msg):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n"
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass
    print(line, end="", flush=True)


def try_pong(cfg):
    """Attempt the ready signal — non-fatal; retried each round until it succeeds."""
    try:
        return send_pong_if_needed(cfg, log=log)
    except AuthError as e:
        log(f"ready signal not sent: {e} — will retry")
        return False


def fetch(cfg, cursor):
    """All pages of new messages since cursor, oldest first, own project only (RLS)."""
    r = api(cfg, "GET", f"threads?select=id&project_id=eq.{cfg['pid']}", "fetching threads")
    ids = ",".join(str(t["id"]) for t in r.json())
    if not ids:
        return []
    msgs = []
    while True:
        q = (f"messages?select=id,thread_id,role,text,created_at"
             f"&thread_id=in.({ids})&id=gt.{cursor + len(msgs) if msgs else cursor}"
             f"&order=id.asc&limit=200")
        r = api(cfg, "GET", q, "polling messages")
        page = r.json()
        if not page:
            break
        msgs.extend(page)
        if len(page) < 200:
            break
    return msgs


def push_outbox(cfg):
    outbox = BASE / "outbox"
    outbox.mkdir(parents=True, exist_ok=True)
    for f in sorted(outbox.glob("*.txt"), key=os.path.getmtime):
        if not f.stem.isdigit():
            log(f"push skipped {f.name} — the name must be <thread_id>.txt")
            continue
        text = f.read_text(encoding="utf-8").strip()
        if not text:
            f.unlink()
            continue
        try:
            api(cfg, "POST", "messages", f"sending the reply for thread {f.stem}",
                extra_headers={"Prefer": "return=minimal", "Content-Type": "application/json"},
                data=json.dumps({"thread_id": int(f.stem), "project_id": cfg["pid"],
                                 "role": "muse", "text": text}, ensure_ascii=False).encode("utf-8"),
                expect=(201,))
            f.unlink()
            log(f"push ok thread={f.stem}")
        except TransientError as e:
            log(f"push failed thread={f.stem}: {e} — will retry next round")
        except AuthError as e:
            log(f"push REJECTED thread={f.stem}: {e} — renamed to {f.name}.err, no retry")
            f.rename(f.with_suffix(".txt.err"))


def main():
    try:
        cfg = build_cfg(BASE / "config.json", BASE / "state", BASE / "outbox")
        cfg["state_dir"].mkdir(parents=True, exist_ok=True)
        if not acquire_lock(cfg["state_dir"]):
            log("another puller (muse_client/poller) is already running — exiting")
            return
    except AuthError as e:
        log(f"cannot start: {e}")
        sys.exit(1)

    log("daemon start — session login, RLS-isolated, one puller, ~3s per round")
    try:
        pr = api(cfg, "GET", "projects?select=id,muse_id,name,tags", "fetching the project").json()
        if not pr:
            log("no project visible for this login — check Muse Email / RELAY_SESSION in config.json with the owner")
            return
        cfg["pid"] = pr[0]["id"]
        try:
            init_cursor(cfg)  # first run only: start at the newest id, never replay history
        except TransientError as e:
            log(f"cannot initialize the cursor: {e} — restart the daemon to retry")
            return
        cfg["cursor"] = read_cursor(cfg["state_dir"])
        pong_ok = try_pong(cfg)
        backoff = 1
        while True:
            try:
                if not pong_ok:
                    pong_ok = try_pong(cfg)
                msgs = fetch(cfg, cfg["cursor"])
                new = [m for m in msgs if m.get("role") == "user"]
                if new:
                    with open(BASE / "state" / "inbox.jsonl", "a", encoding="utf-8") as f:
                        for m in new:
                            f.write(json.dumps(m, ensure_ascii=False) + "\n")
                    # one '...' typing signal per affected thread — best-effort, never breaks the pull
                    for tid in sorted({m["thread_id"] for m in new}):
                        try:
                            signal_typing(cfg, tid)
                        except AuthError as e:
                            log(f"typing signal skipped thread={tid}: {e}")
                    cfg["cursor"] = max(m["id"] for m in msgs)
                    write_cursor(cfg["state_dir"], cfg["cursor"])
                    log(f"inbox +{len(new)} new messages, cursor={cfg['cursor']}")
                push_outbox(cfg)
                backoff = 1
            except TransientError as e:
                log(f"{e} — backing off {backoff}s")
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)
            except AuthError as e:
                log(f"fatal: {e}")
                break
            time.sleep(POLL_PAUSE)
    finally:
        release_lock(cfg["state_dir"])


if __name__ == "__main__":
    main()
