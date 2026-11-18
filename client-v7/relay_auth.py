"""Shared Supabase auth + REST helpers for Muse Relay v7 (GoTrue + RLS + E2E).

Auth model (v7): each Muse holds its OWN long-lived GoTrue session — the
"Relay Session" (a GoTrue refresh token) that Muse installs with
`python3 relay_auth.py install-session` after logging in once with the
owner's one-time password (see setup_guide.txt STEP 5). The token goes
straight to state/session.json (chmod 600); the daemon reads it from
there. The one-time password is never written to any file. config.json
NEVER contains a session token in v7 — a RELAY_SESSION left in config.json
is ignored with a loud warning.

Supabase RLS locks every request to that Muse's own project — a Muse can
never read another Muse's data, even with full access to this code.

E2E note: this module handles transport auth only. Message encryption lives
in crypto.py / keys.py / safety.py. The daemon's own protocol signals
'...' (typing) and 'pong' (ready) are fixed constant strings, not message
content, and stay plaintext exactly as in v6 so both endpoints recognise
them without decrypting; they carry no user content.

NEVER put a Supabase secret key (service_role), PAT, or password anywhere
in this code or config — the Relay Session (RLS-scoped) is the only
credential this side uses.
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

import requests

TIMEOUT = 30


class TransientError(Exception):
    """Transient error (network/5xx/429) — back off and retry."""


class AuthError(Exception):
    """Fatal auth/config error — do not retry, tell the owner."""


# ---------- config ----------

def read_config(path):
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return {}


# ---------- login / session ----------

def _refresh_session(cfg, refresh_token):
    """Exchange a refresh token for a live session (also the seed path:
    the Relay Session value in config.json IS a refresh token)."""
    r = requests.post(
        f"{cfg['url']}/auth/v1/token?grant_type=refresh_token",
        headers={"apikey": cfg["publishable"], "Content-Type": "application/json"},
        data=json.dumps({"refresh_token": refresh_token}), timeout=TIMEOUT,
    )
    if r.status_code != 200:
        raise AuthError(
            "session refresh failed — this Relay Session is dead or rotated: ask the owner "
            "for a fresh one-time password and repeat the login in setup_guide.txt STEP 5")
    j = r.json()
    return {"access_token": j["access_token"], "refresh_token": j["refresh_token"],
            "expires_at": time.time() + int(j.get("expires_in", 3600)) - 120}


def _session_path(state_dir):
    return Path(state_dir) / "session.json"


def get_session(cfg):
    """A valid session, from state/session.json ONLY (v7).

    The file holds the live (rotated) refresh token, written by
    install_session() after Muse logs in once with the owner's one-time
    password (setup_guide.txt STEP 5). config.json is deliberately NOT
    consulted: a session token must never sit in the install config. If the
    file is missing or the token is dead, fail with a clear message — never
    fall back to any other credential (no secret key, no PAT, no password
    exists here)."""
    sp = _session_path(cfg["state_dir"])
    try:
        saved = json.loads(sp.read_text(encoding="utf-8"))
        if saved.get("refresh_token") and saved.get("email") == cfg["email"]:
            sess = _refresh_session(cfg, saved["refresh_token"])
            _save_session(sp, sess, cfg["email"])
            return sess
    except AuthError:
        raise
    except Exception:
        pass  # missing/corrupt/stale session — report it, do not guess
    raise AuthError(
        "no usable session in state/session.json — ask the owner for a fresh "
        "one-time password, log in once (setup_guide.txt STEP 5), and install "
        "the new session with: "
        "python3 relay_auth.py install-session --config config.json "
        "(the value is written to state/session.json, never to config.json)")


def install_session(state_dir, email, refresh_token):
    """Store a fresh Relay Session (refresh token) in state/session.json
    (chmod 600, atomic write). Called by Muse with the refresh token from
    the one-time-password login (setup_guide.txt STEP 5) — the token is
    piped on stdin, never written to config.json. Returns True."""
    if not refresh_token or not str(refresh_token).strip():
        raise AuthError("install-session: empty session value — nothing stored")
    if not email:
        raise AuthError("install-session: no MUSE_EMAIL — check config.json")
    sp = _session_path(state_dir)
    _save_session(sp, {"refresh_token": str(refresh_token).strip()}, email)
    return True


def _save_session(sp, sess, email):
    sp.parent.mkdir(parents=True, exist_ok=True)
    tmp = sp.with_suffix(".tmp")
    tmp.write_text(json.dumps({"email": email, "refresh_token": sess["refresh_token"]}),
                   encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, sp)


def ensure_session(cfg):
    """A session that is still fresh enough; refresh when close to expiry."""
    if cfg.get("session") and cfg["session"]["expires_at"] > time.time():
        return cfg["session"]
    cfg["session"] = get_session(cfg)
    return cfg["session"]


# ---------- REST ----------

def rest_headers(cfg):
    ensure_session(cfg)
    return {"apikey": cfg["publishable"], "Authorization": f"Bearer {cfg['session']['access_token']}"}


def api(cfg, method, path, name, extra_headers=None, data=None, expect=(200, 201)):
    """One REST call with automatic ONE re-login + retry on 401 (expired token)."""
    url = f"{cfg['url']}/rest/v1/{path.lstrip('/')}"
    for attempt in (0, 1):
        hdr = rest_headers(cfg)
        if extra_headers:
            hdr.update(extra_headers)
        r = requests.request(method, url, headers=hdr, data=data, timeout=TIMEOUT)
        if r.status_code == 401 and attempt == 0:
            cfg["session"] = None  # force refresh and retry once
            continue
        break
    if r.status_code in expect:
        return r
    if r.status_code == 401 or r.status_code == 403:
        raise AuthError(f"{name} rejected (HTTP {r.status_code}) — RLS says this is not your project")
    if r.status_code == 429 or r.status_code >= 500:
        raise TransientError(f"{name} returned HTTP {r.status_code}")
    raise AuthError(f"{name} failed (HTTP {r.status_code}): {r.text[:200]}")


# ---------- single-puller lock ----------

def acquire_lock(state_dir):
    """Only ONE puller (muse_client OR poller) may run per folder. Returns True if acquired."""
    lock = Path(state_dir) / "puller.lock"
    Path(state_dir).mkdir(parents=True, exist_ok=True)
    if lock.exists():
        try:
            old = int(lock.read_text(encoding="utf-8").strip() or 0)
            os.kill(old, 0)  # still alive?
            return False
        except (ValueError, ProcessLookupError, PermissionError):
            pass  # stale lock — take over
    lock.write_text(str(os.getpid()), encoding="utf-8")
    return True


def release_lock(state_dir):
    try:
        (Path(state_dir) / "puller.lock").unlink()
    except OSError:
        pass


def read_cursor(state_dir):
    """Cursor 'last_id' — shared by every puller. Corrupt file is FATAL (never re-read history).
    The unified key is 'last_id'; if a legacy 'after' key is still present,
    take the MAX of the two so the cursor never goes backwards."""
    f = Path(state_dir) / "cursor.json"
    if f.exists():
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            return max(int(data["last_id"]), int(data.get("after", 0)))
        except (ValueError, KeyError, TypeError):
            raise AuthError(
                "state/cursor.json is corrupt — DO NOT delete it silently; ask the owner how to proceed "
                "(deleting it re-processes old messages)")
    return 0


def write_cursor(state_dir, n):
    Path(state_dir).mkdir(parents=True, exist_ok=True)
    tmp = Path(state_dir) / "cursor.json.tmp"
    tmp.write_text(json.dumps({"last_id": n}), encoding="utf-8")
    os.replace(tmp, Path(state_dir) / "cursor.json")


def init_cursor(cfg):
    """First run only: start the cursor at the newest existing message id (RLS scopes the query).

    Never touches an existing cursor file — a corrupt one stays fatal (see read_cursor);
    without this, the first run would replay the entire history.
    Needs a session — call it only after the project has been fetched.
    """
    f = Path(cfg["state_dir"]) / "cursor.json"
    if f.exists():
        return
    r = api(cfg, "GET", "messages?select=id&order=id.desc&limit=1", "initializing the cursor")
    rows = r.json()
    write_cursor(cfg["state_dir"], rows[0]["id"] if rows else 0)


# ---------- internal signals ('...' typing, 'pong' ready) ----------

def signal_typing(cfg, thread_id):
    """Best-effort '...' typing signal (role='muse') — one per thread that got new user messages.
    NOTE (v7): '...' is a fixed protocol constant, not message content, so it
    stays plaintext exactly as in v6. Both endpoints recognise it without
    decrypting; it carries no user content."""
    try:
        api(cfg, "POST", "messages", "sending the typing signal",
            extra_headers={"Prefer": "return=minimal", "Content-Type": "application/json"},
            data=json.dumps({"thread_id": int(thread_id), "project_id": cfg["pid"], "role": "muse",
                             "text": "..."}, ensure_ascii=False).encode("utf-8"),
            expect=(201,))
    except TransientError as e:
        # the signal is optional — the reply matters more, so note it and move on
        print(f"typing signal for thread {thread_id} not sent: {e}", file=sys.stderr)


def send_pong_if_needed(cfg, log=print):
    """Ready signal: one 'pong' (role='muse') so the web UI unlocks this Muse.

    Target: the thread titled 'setup', else the project's lowest-id thread; with no
    threads at all, stay silent and let the caller retry later. Skipped when the
    target thread already contains a muse 'pong'. Returns True when a pong exists
    (pre-existing or just sent), False when there is nothing to pong into yet
    (TransientError included — retry on a later cycle).
    NOTE (v7): 'pong' is a fixed protocol constant, not message content, so it
    stays plaintext exactly as in v6. Both endpoints recognise it without
    decrypting; it carries no user content.
    """
    try:
        r = api(cfg, "GET", f"threads?select=id,title&project_id=eq.{cfg['pid']}&order=id.asc",
                "fetching threads for the ready signal")
        threads = r.json()
        if not threads:
            return False
        target = next((t for t in threads if t.get("title") == "setup"), threads[0])
        r = api(cfg, "GET",
                f"messages?select=id&thread_id=eq.{target['id']}&role=eq.muse&text=eq.pong&limit=1",
                "checking for an existing ready signal")
        if r.json():
            return True
        api(cfg, "POST", "messages", "sending the ready signal",
            extra_headers={"Prefer": "return=minimal", "Content-Type": "application/json"},
            data=json.dumps({"thread_id": target["id"], "project_id": cfg["pid"], "role": "muse",
                             "text": "pong"}, ensure_ascii=False).encode("utf-8"),
            expect=(201,))
        log("[muse] pong sent — told the relay this Muse is ready")
        return True
    except TransientError:
        return False


def build_cfg(config_path, state_dir, outbox_dir):
    """Assemble the runtime config. Raises AuthError with a clear message when incomplete.

    v7: config.json holds ONLY public/operational values (project id, URL,
    publishable key, Muse email) plus E2E options. It NEVER holds a Relay
    Session — the session lives in state/session.json (see install_session).
    A RELAY_SESSION left in config.json is IGNORED (cfg["session_in_config"]
    flags it so the caller can warn loudly); the daemon will not use it.
    """
    cfg_file = read_config(Path(config_path))
    project_id = str(cfg_file.get("SUPABASE_PROJECT_ID", "") or os.environ.get("SUPABASE_PROJECT_ID", ""))
    url = str(cfg_file.get("SUPABASE_URL", "") or os.environ.get("SUPABASE_URL", "")).rstrip("/")
    if not url and project_id and "." not in project_id:
        url = f"https://{project_id}.supabase.co"
    try:
        enc_version = int(cfg_file.get("ENC_VERSION", 1))
    except (TypeError, ValueError):
        raise AuthError("ENC_VERSION in config.json must be the number 1")
    if enc_version != 1:
        raise AuthError(f"ENC_VERSION {enc_version} is not supported — this build only speaks v1")
    cfg = {
        "project_id": project_id,
        "url": url,
        "publishable": str(cfg_file.get("SUPABASE_PUBLISHABLE_KEY", "") or os.environ.get("SUPABASE_PUBLISHABLE_KEY", "")),
        "email": str(cfg_file.get("MUSE_EMAIL", "") or os.environ.get("MUSE_EMAIL", "")).strip().lower(),
        "session_ref": "",
        "session_in_config": bool(cfg_file.get("RELAY_SESSION") or os.environ.get("RELAY_SESSION")),
        "allow_legacy_plaintext": bool(cfg_file.get("ALLOW_LEGACY_PLAINTEXT", False)),
        "enc_version": enc_version,
        "state_dir": Path(state_dir),
        "outbox_dir": Path(outbox_dir),
        "session": None,
    }
    if not cfg["project_id"] or not cfg["url"]:
        raise AuthError("SUPABASE_PROJECT_ID / SUPABASE_URL missing from config.json")
    if not cfg["publishable"]:
        raise AuthError("SUPABASE_PUBLISHABLE_KEY missing from config.json")
    if not cfg["email"]:
        raise AuthError("MUSE_EMAIL missing from config.json")
    return cfg


def _install_session_cli():
    """Operator CLI: store a fresh Relay Session in state/session.json.
    Usage: python3 relay_auth.py install-session --config config.json
    The refresh token is read from STDIN (Muse pipes the refresh token from
    its one-time-password login). The value is never printed, never
    written to config.json, and never passed through chat."""
    ap = argparse.ArgumentParser(description="Muse Relay v7 — install a Relay Session")
    ap.add_argument("cmd", choices=["install-session"])
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--state-dir", default="state")
    args = ap.parse_args()
    cfg_file = read_config(Path(args.config))
    email = str(cfg_file.get("MUSE_EMAIL", "") or os.environ.get("MUSE_EMAIL", "")).strip().lower()
    token = sys.stdin.read().strip()
    try:
        install_session(args.state_dir, email, token)
    except AuthError as e:
        print(f"[relay_auth] {e}", file=sys.stderr)
        sys.exit(1)
    print("[relay_auth] session installed in state/session.json (600) — "
          "the daemon can now log in; remove any RELAY_SESSION from config.json")


if __name__ == "__main__":
    _install_session_cli()
