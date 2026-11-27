#!/usr/bin/env python3
"""Pull + push daemon for Muse Relay v7 (session login + RLS isolation + E2E).

Same job as muse_client.py but meant to run forever in the background:
- pulls new user messages, verifies + decrypts them, then appends the
  DECRYPTED plaintext to state/inbox.jsonl (paginated, oldest first, own
  project only — RLS)
- pushes reply files outbox/<thread_id>.txt to Supabase ENCRYPTED, then
  deletes them
- NEVER writes replies itself and never touches MEMORY.md — replies are
  written by Muse's scheduled run / wake hook; this daemon only moves them.

E2E (v7): Supabase carries ciphertext only. A row is trusted only if it
decrypts with the verified web public key (crypto_box authentication).
Anything else is dropped, logged with metadata only, and never reaches the
inbox — see crypto.decrypt_row and the fail-closed matrix in the design.
The daemon processes NO messages until both keys are verified out of band
(see keys.py / safety.py).

Auth: the Muse's own Relay Session lives in state/session.json (chmod 600),
installed via `python3 relay_auth.py install-session`. config.json NEVER
holds a session token in v7. The rotated live token keeps the daemon alive
across restarts.

A lockfile (state/puller.lock) guarantees exactly ONE puller per folder:
if muse_client.py is running, this daemon exits immediately (and vice versa).

Protocol signals '...' (typing) and 'pong' (ready) are fixed constant
strings, not message content, and stay plaintext exactly as in v6 so both
endpoints recognise them without decrypting. They carry no user content.
"""
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import keys as relay_keys  # noqa: E402
import safety as relay_safety  # noqa: E402
from crypto import (  # noqa: E402
    DropMessage, decrypt_row, encrypt_reply_envelope,
)
from relay_auth import (  # noqa: E402
    AuthError, TransientError, acquire_lock, api, build_cfg, init_cursor,
    read_cursor, release_lock, send_pong_if_needed, signal_typing, write_cursor,
)

BASE = Path(__file__).resolve().parent
LOG = BASE / "state" / "poller.log"
POLL_PAUSE = 3.0
VERIFY_REMINDER_ROUNDS = 200  # ~10 minutes between "awaiting verification" logs

# Columns the v7 schema must have (migration step 1). The legacy "text"
# column is still selected: it carries only the two fixed protocol signals
# ('...' / 'pong') and, during the opt-in migration window, pre-E2E rows.
MESSAGE_SELECT = ("id,thread_id,role,ciphertext,nonce,sender_key_id,"
                  "enc_version,alg,text,created_at")


def log(msg):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n"
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass
    print(line, end="", flush=True)


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def try_pong(cfg):
    """Attempt the ready signal — non-fatal; retried each round until it succeeds."""
    try:
        return send_pong_if_needed(cfg, log=log)
    except AuthError as e:
        log(f"ready signal not sent: {e} — will retry")
        return False


def fetch(cfg, cursor):
    """All pages of new messages since cursor, oldest first, own project only (RLS)."""
    try:
        r = api(cfg, "GET", f"threads?select=id&project_id=eq.{cfg['pid']}", "fetching threads")
    except AuthError as e:
        raise AuthError(f"{e} — if the v7 schema is missing, add the ciphertext/nonce/"
                        "sender_key_id/enc_version/alg columns and the relay_keys table first")
    ids = ",".join(str(t["id"]) for t in r.json())
    if not ids:
        return []
    msgs = []
    while True:
        q = (f"messages?select={MESSAGE_SELECT}"
             f"&thread_id=in.({ids})&id=gt.{cursor + len(msgs) if msgs else cursor}"
             f"&order=id.asc&limit=200")
        try:
            r = api(cfg, "GET", q, "polling messages")
        except AuthError as e:
            raise AuthError(f"{e} — if the v7 schema is missing, add the ciphertext/nonce/"
                            "sender_key_id/enc_version/alg columns and the relay_keys table first")
        page = r.json()
        if not page:
            break
        msgs.extend(page)
        if len(page) < 200:
            break
    return msgs


def ensure_e2e_ready(cfg, key_state, published):
    """Key setup for this round. Returns (ready, web_row, published).

    - Publishes the Muse public key until the relay_keys row exists.
    - Syncs the web public key; a change revokes local verification and
      rewrites the safety number (key-substitution detector).
    - ready is True only when the Muse key is verified locally AND the web
      key row is verified. Until then the daemon processes nothing.
    Transient failures return ready=False (retry next round), never crash.
    """
    if not published:
        try:
            published = relay_keys.publish_public_key(cfg, key_state)
        except (TransientError, AuthError) as e:
            log(f"key publish deferred: {e} — will retry")
            return False, None, published
    try:
        web_row, changed = relay_keys.sync_web_key(cfg, key_state)
    except (TransientError, AuthError) as e:
        log(f"web key sync deferred: {e} — will retry")
        return False, None, published
    if changed:
        log("WARNING: web public key changed — verification revoked, "
            "re-verification required before any message is processed")
    if key_state.get("web_public_key") and key_state.get("muse_public_key"):
        try:
            number = relay_safety.compute_for_keys(
                key_state["muse_public_key"], key_state["web_public_key"],
                key_state["muse_key_id"], key_state["web_key_id"])
            relay_safety.write_safety_number(cfg["state_dir"], number)
        except Exception as e:  # safety number is advisory; never break the loop
            log(f"safety number not written: {e}")
    ready = bool(key_state.get("verified")) and bool(web_row and web_row.get("verified"))
    return ready, web_row, published


def process_rows(cfg, key_state, rows):
    """Decrypt + validate fetched user rows. Returns (accepted, thread_ids).

    Accepted rows are appended to state/inbox.jsonl as decrypted plaintext
    (this machine is an endpoint, so plaintext is allowed here). Dropped
    rows are logged with metadata only (id, thread, reason) — never content.
    The cursor is advanced past every fetched row: each row was examined,
    so a bad row cannot jam the loop by being re-fetched forever."""
    own_secret, _ = relay_keys.muse_keys(key_state)
    web_public, web_key_id = relay_keys.web_keys(key_state)
    accepted = []
    threads = set()
    for m in rows:
        if m.get("role") != "user":
            continue
        try:
            kind, package = decrypt_row(m, own_secret, web_public, web_key_id,
                                        allow_legacy=cfg["allow_legacy_plaintext"])
        except DropMessage as e:
            log(f"dropped message id={m.get('id')} thread={m.get('thread_id')} "
                f"sender_key_id={m.get('sender_key_id')} reason={e.reason}")
            continue
        accepted.append({
            "id": m["id"], "thread_id": m["thread_id"], "role": "user",
            "text": package["body"], "created_at": m.get("created_at"),
            "e2e": kind == "e2e",
        })
        threads.add(m["thread_id"])
        if kind == "legacy":
            log(f"legacy plaintext message id={m['id']} thread={m['thread_id']} "
                "accepted once (migration window)")
    if accepted:
        with open(BASE / "state" / "inbox.jsonl", "a", encoding="utf-8") as f:
            for line in accepted:
                f.write(json.dumps(line, ensure_ascii=False) + "\n")
    return accepted, threads


def push_outbox(cfg, key_state):
    """Encrypt each outbox/<thread_id>.txt reply and POST the envelope.
    No plaintext content is ever written to Supabase."""
    own_secret, _ = relay_keys.muse_keys(key_state)
    web_public, _ = relay_keys.web_keys(key_state)
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
        envelope = encrypt_reply_envelope(
            text, str(f.stem), _now_iso(),
            own_secret, web_public, key_state["muse_key_id"])
        body = {"thread_id": int(f.stem), "project_id": cfg["pid"], "role": "muse"}
        body.update(envelope)
        try:
            api(cfg, "POST", "messages", f"sending the reply for thread {f.stem}",
                extra_headers={"Prefer": "return=minimal", "Content-Type": "application/json"},
                data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
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
        if cfg.get("session_in_config"):
            log("WARNING: RELAY_SESSION in config.json is IGNORED in v7 — the session "
                "lives in state/session.json only; remove it from config.json")
        if not acquire_lock(cfg["state_dir"]):
            log("another puller (muse_client/poller) is already running — exiting")
            return
    except AuthError as e:
        log(f"cannot start: {e}")
        sys.exit(1)

    log("daemon start — E2E v7, session login, RLS-isolated, one puller, ~3s per round")
    try:
        try:
            key_state = relay_keys.get_or_create_keys(cfg["state_dir"])
        except relay_keys.KeysError as e:
            log(f"cannot start: {e}")
            sys.exit(1)
        pr = api(cfg, "GET", "projects?select=id,muse_id,name,tags", "fetching the project").json()
        if not pr:
            log("no project visible for this login — check the Relay Session in "
                "state/session.json with the owner (fresh one-time password, "
                "setup_guide.txt STEP 5)")
            return
        cfg["pid"] = pr[0]["id"]
        try:
            init_cursor(cfg)  # first run only: start at the newest id, never replay history
        except TransientError as e:
            log(f"cannot initialize the cursor: {e} — restart the daemon to retry")
            return
        cfg["cursor"] = read_cursor(cfg["state_dir"])
        pong_ok = try_pong(cfg)
        published = False
        backoff = 1
        rounds = 0
        while True:
            rounds += 1
            try:
                if not pong_ok:
                    pong_ok = try_pong(cfg)
                ready, _web_row, published = ensure_e2e_ready(cfg, key_state, published)
                if not ready:
                    if rounds == 1 or rounds % VERIFY_REMINDER_ROUNDS == 0:
                        log("keys not verified yet — waiting for out-of-band safety-number "
                            "verification; not processing messages")
                    time.sleep(POLL_PAUSE)
                    continue
                msgs = fetch(cfg, cfg["cursor"])
                if msgs:
                    accepted, threads = process_rows(cfg, key_state, msgs)
                    # one '...' typing signal per affected thread — best-effort, never breaks the pull
                    for tid in sorted(threads):
                        try:
                            signal_typing(cfg, tid)
                        except AuthError as e:
                            log(f"typing signal skipped thread={tid}: {e}")
                    cfg["cursor"] = max(m["id"] for m in msgs)
                    write_cursor(cfg["state_dir"], cfg["cursor"])
                    if accepted:
                        log(f"inbox +{len(accepted)} new messages, cursor={cfg['cursor']}")
                push_outbox(cfg, key_state)
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
