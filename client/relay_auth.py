"""Shared Supabase auth + REST helpers for Muse Relay (GoTrue + RLS).

Auth model (v6): each Muse holds its OWN long-lived GoTrue session — the
"Relay Session" value the owner hands over as ordinary config. Supabase RLS
locks every request to that Muse's own project — a Muse can never read
another Muse's data, even with full access to this code.

- Everything lives in config.json as plain values: Project ID, Publishable Key,
  URL, Muse Email and RELAY_SESSION (the Muse's session — minted by the
  owner's web UI, ⚙ → Token).
- RELAY_SESSION renews itself: every refresh issues a new one, and the client
  keeps the live value in state/session.json (chmod 600) so background daemons
  survive restarts. If the value ever dies, the owner mints a fresh one and
  updates config.json.
"""
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
            "session refresh failed — this Relay Session is dead or rotated: mint a fresh "
            "value in the owner's web UI (⚙ → Token) and update RELAY_SESSION in config.json")
    j = r.json()
    return {"access_token": j["access_token"], "refresh_token": j["refresh_token"],
            "expires_at": time.time() + int(j.get("expires_in", 3600)) - 120}


def _session_path(state_dir):
    return Path(state_dir) / "session.json"


def get_session(cfg):
    """A valid session: the saved refresh-token file first, then the Relay
    Session from config.json. Saves the live (rotated) token on success."""
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
        pass  # missing/corrupt/stale session — fall through to the Relay Session
    if not cfg.get("session_ref"):
        raise AuthError(
            "no saved session and no RELAY_SESSION in config.json — ask the owner to mint "
            "a fresh value (web UI → ⚙ → Token) and put it in config.json")
    sess = _refresh_session(cfg, cfg["session_ref"])
    _save_session(sp, sess, cfg["email"])
    return sess


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
    """Cursor 'last_id' — shared by every puller. Corrupt file is FATAL (never re-read history)."""
    f = Path(state_dir) / "cursor.json"
    if f.exists():
        try:
            return int(json.loads(f.read_text(encoding="utf-8"))["last_id"])
        except (ValueError, KeyError, TypeError):
            raise AuthError(
                "state/cursor.json is corrupt — DO NOT delete it silently; ask the owner how to proceed "
                "(deleting it re-processes old messages)")
    return 0


def write_cursor(state_dir, n):
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
    """Best-effort '...' typing signal (role='muse') — one per thread that got new user messages."""
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
    """Assemble the runtime config. Raises AuthError with a clear message when incomplete."""
    cfg_file = read_config(Path(config_path))
    project_id = str(cfg_file.get("SUPABASE_PROJECT_ID", "") or os.environ.get("SUPABASE_PROJECT_ID", ""))
    url = str(cfg_file.get("SUPABASE_URL", "") or os.environ.get("SUPABASE_URL", "")).rstrip("/")
    if not url and project_id and "." not in project_id:
        url = f"https://{project_id}.supabase.co"
    cfg = {
        "project_id": project_id,
        "url": url,
        "publishable": str(cfg_file.get("SUPABASE_PUBLISHABLE_KEY", "") or os.environ.get("SUPABASE_PUBLISHABLE_KEY", "")),
        "email": str(cfg_file.get("MUSE_EMAIL", "") or os.environ.get("MUSE_EMAIL", "")).strip().lower(),
        "session_ref": str(cfg_file.get("RELAY_SESSION", "") or os.environ.get("RELAY_SESSION", "")).strip(),
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
    if not cfg["session_ref"]:
        raise AuthError(
            "RELAY_SESSION missing from config.json — mint a value in the owner's web UI "
            "(⚙ → Token) and put it there")
    return cfg
