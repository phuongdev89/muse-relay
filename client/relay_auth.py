"""Shared Supabase auth + REST helpers for Muse Relay (GoTrue + RLS).

Auth model (v4): each Muse logs in with its OWN email/password (GoTrue).
Supabase RLS locks every request to that Muse's own project — a Muse can
never read another Muse's data, even with full access to this code.

- Non-secret values live in config.json: Project ID, Publishable Key, URL, Muse Email.
- The ONLY secret is the relay password: MUSE_PASSWORD environment variable
  (entered by the owner in the secure form; never written to disk).
- After the first login, a refresh token is kept in state/session.json (chmod 600)
  so background daemons can keep the session alive forever without the password.
"""
import json
import os
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

def _login_password(cfg):
    """Password grant — needs MUSE_PASSWORD in the environment."""
    pw = os.environ.get("MUSE_PASSWORD", "")
    if not pw:
        raise AuthError(
            "MUSE_PASSWORD is missing from the environment — show the secure form "
            "'Muse Relay password' to the owner, then start again")
    r = requests.post(
        f"{cfg['url']}/auth/v1/token?grant_type=password",
        headers={"apikey": cfg["publishable"], "Content-Type": "application/json"},
        data=json.dumps({"email": cfg["email"], "password": pw}), timeout=TIMEOUT,
    )
    if r.status_code != 200:
        raise AuthError(f"login failed (HTTP {r.status_code}) — check Muse Email / relay password")
    j = r.json()
    return {"access_token": j["access_token"], "refresh_token": j["refresh_token"],
            "expires_at": time.time() + int(j.get("expires_in", 3600)) - 120}


def _refresh_session(cfg, refresh_token):
    r = requests.post(
        f"{cfg['url']}/auth/v1/token?grant_type=refresh_token",
        headers={"apikey": cfg["publishable"], "Content-Type": "application/json"},
        data=json.dumps({"refresh_token": refresh_token}), timeout=TIMEOUT,
    )
    if r.status_code != 200:
        raise AuthError("session refresh failed — the relay password may have been rotated")
    j = r.json()
    return {"access_token": j["access_token"], "refresh_token": j["refresh_token"],
            "expires_at": time.time() + int(j.get("expires_in", 3600)) - 120}


def _session_path(state_dir):
    return Path(state_dir) / "session.json"


def get_session(cfg):
    """A valid session: refresh-token file first, then password login from env. Saves on success."""
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
        pass  # missing/corrupt/stale session — fall through to password login
    sess = _login_password(cfg)
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
