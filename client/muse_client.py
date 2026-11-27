"""Muse Relay v6.2 — client on the Muse machine (session login + RLS isolation).

New messages (role='user') for YOUR project are appended to state/inbox.jsonl —
Muse reads that file, then writes replies to outbox/<thread_id>.txt; the client
POSTs each reply back and deletes the file. The cursor lives in state/cursor.json
(shared key "last_id" with poller.py; a lockfile state/puller.lock makes sure only
ONE puller runs at a time).

Auth (v6.2 — RLS isolation): the client uses the Muse's own long-lived GoTrue
session, which renews itself on every refresh. First setup needs ONE of:
RELAY_SESSION (legacy v6, from the owner's web UI) or MUSE_PASSWORD (new in
v6.2 — the daemon mints a session once, saves it to state/session.json, then
removes the password from config.json). Every request carries that session's
JWT and Supabase RLS restricts it to this Muse's own project — this client
physically cannot read another Muse's data.

How to run:
    pip install -r requirements.txt
    python3 muse_client.py                # indefinite poll loop (~3s pause)
    python3 muse_client.py --once         # one round + push the outbox, for cron
    python3 relay_auth.py test-login      # check the login without polling

Only needs:
- config.json: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY (public), MUSE_EMAIL,
  plus RELAY_SESSION or MUSE_PASSWORD on first setup (see relay_auth.py).
  SUPABASE_PROJECT_ID is optional.
- state/session.json: created automatically on first login (chmod 600).
"""
import argparse
import json
import os
import random
import sys
import time

from relay_auth import (
    AuthError, TransientError, acquire_lock, api, build_cfg, init_cursor,
    read_cursor, release_lock, send_pong_if_needed, signal_typing, write_cursor,
)

POLL_PAUSE = 3.0


def backoff_sleep(cfg, reason):
    print(f"[muse] {reason} — retrying in {cfg['backoff']}s", file=sys.stderr)
    time.sleep(cfg["backoff"])
    cfg["backoff"] = min(cfg["backoff"] * 2, 60)


def fetch_project(cfg):
    """GET projects — RLS returns exactly this Muse's own row."""
    r = api(cfg, "GET", "projects?select=id,muse_id,name,tags,email", "fetching the project")
    rows = r.json()
    if not rows:
        sys.exit("[muse] no project visible for this login — check MUSE_EMAIL and the "
                 "credential in config.json (RELAY_SESSION or MUSE_PASSWORD), "
                 "or the owner has not created the Muse yet")
    if len(rows) > 1:
        print(f"[muse] WARNING: {len(rows)} projects visible — expected 1. Tell the owner.", file=sys.stderr)
    return rows[0]


def fetch_messages(cfg):
    """All pages of new messages (id > cursor) for THIS project's threads, oldest first."""
    r = api(cfg, "GET", f"threads?select=id&project_id=eq.{cfg['pid']}", "fetching threads")
    ids = ",".join(str(t["id"]) for t in r.json())
    if not ids:
        return
    received = 0
    while True:
        q = (f"messages?select=id,thread_id,role,text,created_at"
             f"&thread_id=in.({ids})&id=gt.{cfg['cursor']}&order=id.asc&limit=200")
        r = api(cfg, "GET", q, "polling messages")
        page = r.json()
        if not page:
            return
        with (cfg["state_dir"] / "inbox.jsonl").open("a", encoding="utf-8") as f:
            for m in page:
                if m.get("role") == "user":
                    f.write(json.dumps(
                        {"id": m["id"], "thread_id": m["thread_id"], "role": "user",
                         "text": m["text"], "created_at": m["created_at"]},
                        ensure_ascii=False) + "\n")
        # one '...' typing signal per affected thread — best-effort, never breaks the pull
        for tid in sorted({m["thread_id"] for m in page if m.get("role") == "user"}):
            try:
                signal_typing(cfg, tid)
            except AuthError as e:
                print(f"[muse] typing signal skipped (thread {tid}): {e}", file=sys.stderr)
        cfg["cursor"] = max(cfg["cursor"], max(m["id"] for m in page))
        write_cursor(cfg["state_dir"], cfg["cursor"])
        received += sum(1 for m in page if m.get("role") == "user")
        if len(page) < 200:  # caught up
            break
    if received:
        print(f"[muse] received {received} user messages -> inbox, cursor={cfg['cursor']}")


def push_outbox(cfg):
    """outbox/<thread_id>.txt sorted by mtime -> POST -> delete. 4xx renames to .err (no retry)."""
    files = sorted(cfg["outbox_dir"].glob("*.txt"), key=os.path.getmtime)
    for f in files:
        if not f.stem.isdigit():
            print(f"[muse] skipping outbox/{f.name} — the name must be <thread_id>.txt")
            continue
        text = f.read_text(encoding="utf-8").strip()
        if not text:
            f.unlink()
            continue
        body = json.dumps({"thread_id": int(f.stem), "project_id": cfg["pid"], "role": "muse", "text": text},
                          ensure_ascii=False)
        r = api(cfg, "POST", "messages", f"sending the reply for thread {f.stem}",
                extra_headers={"Prefer": "return=minimal", "Content-Type": "application/json"},
                data=body.encode("utf-8"), expect=(201,))
        f.unlink()
        print(f"[muse] sent the reply for thread {f.stem} — deleted outbox/{f.name}")


def cycle(cfg):
    try:
        fetch_messages(cfg)
        push_outbox(cfg)
    except TransientError as e:
        backoff_sleep(cfg, str(e))
        return
    cfg["backoff"] = 1


def try_pong(cfg):
    """Attempt the ready signal — non-fatal; retried each cycle until it succeeds."""
    try:
        return send_pong_if_needed(cfg)
    except AuthError as e:
        print(f"[muse] ready signal not sent: {e}", file=sys.stderr)
        return False


def main():
    ap = argparse.ArgumentParser(description="Muse Relay v6.2 client — session login, RLS-isolated")
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--once", action="store_true", help="one round + push the outbox, then exit")
    args = ap.parse_args()

    try:
        cfg = build_cfg(args.config, "state", "outbox")
        cfg["state_dir"].mkdir(parents=True, exist_ok=True)
        cfg["outbox_dir"].mkdir(parents=True, exist_ok=True)
        if not acquire_lock(cfg["state_dir"]):
            print("[muse] another puller (muse_client/poller) is already running — exiting")
            return
        try:
            pr = fetch_project(cfg)
            cfg["pid"] = pr["id"]
            try:
                init_cursor(cfg)  # first run only: start at the newest id, never replay history
            except TransientError as e:
                sys.exit(f"[muse] cannot initialize the cursor: {e} — start again to retry")
            cfg["cursor"] = read_cursor(cfg["state_dir"])
            tags = ",".join(pr.get("tags") or [])
            print(f"[#{pr['id']}] {pr['muse_id']} ({pr['name']}) is listening — tags={tags} — "
                  f"cursor={cfg['cursor']} — auth={cfg.get('auth_source')}")
            pong_ok = try_pong(cfg)
            while True:
                if not pong_ok:
                    pong_ok = try_pong(cfg)
                cycle(cfg)
                if args.once:
                    print("[muse] --once: one round done — exiting")
                    return
                time.sleep(POLL_PAUSE + random.uniform(-0.5, 0.5))
        finally:
            release_lock(cfg["state_dir"])
    except AuthError as e:
        print(f"[muse] {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n[muse] received Ctrl+C — exiting cleanly, see you later")


if __name__ == "__main__":
    main()
