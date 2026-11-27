"""Muse Relay v7 — client on the Muse machine (session login + RLS isolation + E2E).

New messages (role='user') for YOUR project are verified + decrypted, then
appended as plaintext to state/inbox.jsonl — Muse reads that file, then
writes replies to outbox/<thread_id>.txt; the client encrypts each reply
and POSTs the envelope back, then deletes the file. The cursor lives in
state/cursor.json (shared key "last_id" with poller.py; a lockfile
state/puller.lock makes sure only ONE puller runs at a time).

Auth (v7 — RLS isolation): the client uses the Muse's own Relay Session,
which lives ONLY in state/session.json (chmod 600, installed via
`python3 relay_auth.py install-session`). Every request carries that
session's JWT and Supabase RLS restricts it to this Muse's own project —
this client physically cannot read another Muse's data.

E2E (v7): Supabase carries ciphertext only. A row is trusted only if it
decrypts with the verified web public key (crypto_box authentication).
Anything else is dropped, logged with metadata only, and never reaches the
inbox. The client processes NO messages until both keys are verified out
of band (see keys.py / safety.py).

How to run:
    pip install -r requirements.txt
    python3 muse_client.py                # indefinite poll loop (~3s pause)
    python3 muse_client.py --once         # one round + push the outbox, then exit (single check)

Only needs:
- config.json: SUPABASE_PROJECT_ID, SUPABASE_PUBLISHABLE_KEY (public), SUPABASE_URL,
  MUSE_EMAIL (no session token — see relay_auth.install_session)
- state/session.json: the Relay Session, installed after the one-time-password login (see relay_auth.install_session)
- state/keys.json: the Muse key pair, created automatically on first run
"""
import argparse
import json
import os
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

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

POLL_PAUSE = 3.0

# Columns the v7 schema must have (migration step 1). The legacy "text"
# column is still selected: it carries only the two fixed protocol signals
# ('...' / 'pong') and, during the opt-in migration window, pre-E2E rows.
MESSAGE_SELECT = ("id,thread_id,role,ciphertext,nonce,sender_key_id,"
                  "enc_version,alg,text,created_at")


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def backoff_sleep(cfg, reason):
    print(f"[muse] {reason} — retrying in {cfg['backoff']}s", file=sys.stderr)
    time.sleep(cfg["backoff"])
    cfg["backoff"] = min(cfg["backoff"] * 2, 60)


def fetch_project(cfg):
    """GET projects — RLS returns exactly this Muse's own row."""
    r = api(cfg, "GET", "projects?select=id,muse_id,name,tags,email", "fetching the project")
    rows = r.json()
    if not rows:
        sys.exit("[muse] no project visible for this login — check the Relay Session in "
                 "state/session.json, or the owner has not created the Muse yet")
    if len(rows) > 1:
        print(f"[muse] WARNING: {len(rows)} projects visible — expected 1. Tell the owner.", file=sys.stderr)
    return rows[0]


def ensure_e2e_ready(cfg, key_state, published):
    """Key setup for this round. Returns (ready, web_row, published).
    ready is True only when the Muse key is verified locally AND the web
    key row is verified. Transient failures return ready=False (retry)."""
    if not published:
        try:
            published = relay_keys.publish_public_key(cfg, key_state)
        except (TransientError, AuthError) as e:
            print(f"[muse] key publish deferred: {e} — will retry", file=sys.stderr)
            return False, None, published
    try:
        web_row, changed = relay_keys.sync_web_key(cfg, key_state)
    except (TransientError, AuthError) as e:
        print(f"[muse] web key sync deferred: {e} — will retry", file=sys.stderr)
        return False, None, published
    if changed:
        print("[muse] WARNING: web public key changed — verification revoked, "
              "re-verification required before any message is processed", file=sys.stderr)
    if key_state.get("web_public_key") and key_state.get("muse_public_key"):
        try:
            number = relay_safety.compute_for_keys(
                key_state["muse_public_key"], key_state["web_public_key"],
                key_state["muse_key_id"], key_state["web_key_id"])
            relay_safety.write_safety_number(cfg["state_dir"], number)
        except Exception as e:  # safety number is advisory; never break the loop
            print(f"[muse] safety number not written: {e}", file=sys.stderr)
    ready = bool(key_state.get("verified")) and bool(web_row and web_row.get("verified"))
    return ready, web_row, published


def fetch_messages(cfg, key_state):
    """All pages of new messages (id > cursor) for THIS project's threads,
    oldest first. Each user row is verified + decrypted; failures are
    dropped with a metadata-only log line, never written to the inbox."""
    own_secret, _ = relay_keys.muse_keys(key_state)
    web_public, web_key_id = relay_keys.web_keys(key_state)
    r = api(cfg, "GET", f"threads?select=id&project_id=eq.{cfg['pid']}", "fetching threads")
    ids = ",".join(str(t["id"]) for t in r.json())
    if not ids:
        return
    received = 0
    while True:
        q = (f"messages?select={MESSAGE_SELECT}"
             f"&thread_id=in.({ids})&id=gt.{cfg['cursor']}&order=id.asc&limit=200")
        r = api(cfg, "GET", q, "polling messages")
        page = r.json()
        if not page:
            return
        accepted = []
        threads = set()
        for m in page:
            if m.get("role") != "user":
                continue
            try:
                kind, package = decrypt_row(m, own_secret, web_public, web_key_id,
                                            allow_legacy=cfg["allow_legacy_plaintext"])
            except DropMessage as e:
                print(f"[muse] dropped message id={m.get('id')} thread={m.get('thread_id')} "
                      f"sender_key_id={m.get('sender_key_id')} reason={e.reason}",
                      file=sys.stderr)
                continue
            accepted.append({
                "id": m["id"], "thread_id": m["thread_id"], "role": "user",
                "text": package["body"], "created_at": m.get("created_at"),
                "e2e": kind == "e2e",
            })
            threads.add(m["thread_id"])
            if kind == "legacy":
                print(f"[muse] legacy plaintext message id={m['id']} thread={m['thread_id']} "
                      "accepted once (migration window)", file=sys.stderr)
        if accepted:
            with (cfg["state_dir"] / "inbox.jsonl").open("a", encoding="utf-8") as f:
                for line in accepted:
                    f.write(json.dumps(line, ensure_ascii=False) + "\n")
        # one '...' typing signal per affected thread — best-effort, never breaks the pull
        for tid in sorted(threads):
            try:
                signal_typing(cfg, tid)
            except AuthError as e:
                print(f"[muse] typing signal skipped (thread {tid}): {e}", file=sys.stderr)
        cfg["cursor"] = max(cfg["cursor"], max(m["id"] for m in page))
        write_cursor(cfg["state_dir"], cfg["cursor"])
        received += len(accepted)
        if len(page) < 200:  # caught up
            break
    if received:
        print(f"[muse] received {received} user messages -> inbox, cursor={cfg['cursor']}")


def push_outbox(cfg, key_state):
    """outbox/<thread_id>.txt sorted by mtime -> encrypt -> POST envelope ->
    delete. 4xx renames to .err (no retry). No plaintext content ever
    leaves this machine."""
    own_secret, _ = relay_keys.muse_keys(key_state)
    web_public, _ = relay_keys.web_keys(key_state)
    files = sorted(cfg["outbox_dir"].glob("*.txt"), key=os.path.getmtime)
    for f in files:
        if not f.stem.isdigit():
            print(f"[muse] skipping outbox/{f.name} — the name must be <thread_id>.txt")
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
        r = api(cfg, "POST", "messages", f"sending the reply for thread {f.stem}",
                extra_headers={"Prefer": "return=minimal", "Content-Type": "application/json"},
                data=json.dumps(body, ensure_ascii=False).encode("utf-8"), expect=(201,))
        f.unlink()
        print(f"[muse] sent the reply for thread {f.stem} — deleted outbox/{f.name}")


def cycle(cfg, key_state):
    try:
        fetch_messages(cfg, key_state)
        push_outbox(cfg, key_state)
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
    ap = argparse.ArgumentParser(description="Muse Relay v7 client — session login, RLS-isolated, E2E")
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--once", action="store_true", help="one round + push the outbox, then exit")
    args = ap.parse_args()

    try:
        cfg = build_cfg(args.config, "state", "outbox")
        cfg["state_dir"].mkdir(parents=True, exist_ok=True)
        cfg["outbox_dir"].mkdir(parents=True, exist_ok=True)
        if cfg.get("session_in_config"):
            print("[muse] WARNING: RELAY_SESSION in config.json is IGNORED in v7 — the session "
                  "lives in state/session.json only; remove it from config.json", file=sys.stderr)
        if not acquire_lock(cfg["state_dir"]):
            print("[muse] another puller (muse_client/poller) is already running — exiting")
            return
        try:
            try:
                key_state = relay_keys.get_or_create_keys(cfg["state_dir"])
            except relay_keys.KeysError as e:
                sys.exit(f"[muse] cannot start: {e}")
            pr = fetch_project(cfg)
            cfg["pid"] = pr["id"]
            try:
                init_cursor(cfg)  # first run only: start at the newest id, never replay history
            except TransientError as e:
                sys.exit(f"[muse] cannot initialize the cursor: {e} — start again to retry")
            cfg["cursor"] = read_cursor(cfg["state_dir"])
            tags = ",".join(pr.get("tags") or [])
            print(f"[#{pr['id']}] {pr['muse_id']} ({pr['name']}) is listening — tags={tags} — cursor={cfg['cursor']}")
            pong_ok = try_pong(cfg)
            published = False
            while True:
                if not pong_ok:
                    pong_ok = try_pong(cfg)
                ready, _web_row, published = ensure_e2e_ready(cfg, key_state, published)
                if not ready:
                    print("[muse] keys not verified yet — waiting for out-of-band safety-number "
                          "verification; not processing messages", file=sys.stderr)
                    if args.once:
                        return
                    time.sleep(POLL_PAUSE + random.uniform(-0.5, 0.5))
                    continue
                cycle(cfg, key_state)
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
