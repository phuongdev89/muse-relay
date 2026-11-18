"""Shared Supabase auth + REST helpers for Muse Relay v6.2 (GoTrue + RLS).

Auth model (v6.2): each Muse holds its OWN long-lived GoTrue session.
Supabase RLS locks every request to that Muse's own project — a Muse can
never read another Muse's data, even with full access to this code.

How a session is obtained, in priority order (first one that works wins):
  1. state/session.json — the saved, rotated refresh token (chmod 600).
     This is what every restart uses. It is written by _save_session().
  2. RELAY_SESSION in config.json (legacy v6) — a refresh token minted by
     the owner's web UI (Settings -> Token). Still fully supported, so an
     existing v6 install keeps working with zero config change.
  3. MUSE_PASSWORD in config.json (or env MUSE_PASSWORD) — NEW in v6.2.
     On first run only, the daemon exchanges email + password for a
     session with grant_type=password, saves the refresh token to
     state/session.json, and then SCRUBS MUSE_PASSWORD out of config.json
     (see scrub_password_from_config). Later runs use (1) and never need
     the password again. The password is never logged and never put in
     an error message.

- config.json holds: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY (public),
  MUSE_EMAIL, plus ONE of RELAY_SESSION / MUSE_PASSWORD on first setup.
  SUPABASE_PROJECT_ID is optional — only a fallback for building the URL.
- The UI (Cloud mode) signs in with the SAME MUSE_EMAIL + MUSE_PASSWORD
  in the browser (signInWithPassword). That creates a SEPARATE GoTrue
  session for the UI; it does not rotate or revoke the daemon's session.
  Both sessions belong to the same auth user, so RLS sees the same
  auth.uid() on both sides. (Not yet verified live — see README.md.)
- NEVER put a Supabase secret key (service_role), PAT, or dashboard
  password anywhere in this code or config. The GoTrue password here
  must be a relay-only password, unique per Muse, never reused elsewhere.
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

def _token_post(cfg, grant_type, payload, source_label):
    """One POST to /auth/v1/token. Returns a session dict on HTTP 200.

    Never logs or echoes the payload (it may contain a password or a
    refresh token). 400/401 become AuthError with a source-specific hint;
    429/5xx become TransientError; anything else becomes AuthError.
    """
    try:
        r = requests.post(
            f"{cfg['url']}/auth/v1/token?grant_type={grant_type}",
            headers={"apikey": cfg["publishable"], "Content-Type": "application/json"},
            data=json.dumps(payload), timeout=TIMEOUT,
        )
    except requests.RequestException as e:
        # Network down / DNS / timeout: transient, never a credential fault.
        raise TransientError(f"{source_label} network error ({type(e).__name__}) — retry later")
    if r.status_code == 200:
        j = r.json()
        return {"access_token": j["access_token"], "refresh_token": j["refresh_token"],
                "expires_at": time.time() + int(j.get("expires_in", 3600)) - 120}
    if r.status_code == 429 or r.status_code >= 500:
        raise TransientError(f"{source_label} returned HTTP {r.status_code} — retry later")
    if grant_type == "password":
        raise AuthError(
            f"{source_label} failed (HTTP {r.status_code}) — wrong MUSE_EMAIL / "
            "MUSE_PASSWORD, or the auth user has not confirmed its email yet. "
            "If the user was created with a fake @muserelay.local address, it "
            "must be created with Auto Confirm (Dashboard) or email_confirm=true "
            "(Admin API); a normal sign-up email can never arrive there.")
    raise AuthError(
        f"{source_label} failed (HTTP {r.status_code}) — this Relay Session is "
        "dead or rotated: mint a fresh value in the owner's web UI "
        "(Settings -> Token) and update RELAY_SESSION in config.json, or "
        "put MUSE_PASSWORD in config.json once so the daemon can mint a new one.")


def _refresh_session(cfg, refresh_token):
    """Exchange a refresh token for a live session (also the seed path:
    the RELAY_SESSION value in config.json IS a refresh token)."""
    return _token_post(cfg, "refresh_token", {"refresh_token": refresh_token},
                       "session refresh")


def _login_with_password(cfg):
    """Mint a session from email + password (grant_type=password).

    First-run only. The caller saves the returned refresh token and then
    scrubs the password from config.json — this function itself never
    stores the password anywhere.
    """
    if not cfg.get("email") or not cfg.get("password"):
        raise AuthError("password login needs MUSE_EMAIL and MUSE_PASSWORD")
    return _token_post(cfg, "password",
                       {"email": cfg["email"], "password": cfg["password"]},
                       "password login")


def _session_path(state_dir):
    return Path(state_dir) / "session.json"


def _has_saved_session(state_dir, email):
    """True when state/session.json holds a refresh token for this email."""
    try:
        saved = json.loads(_session_path(state_dir).read_text(encoding="utf-8"))
        return bool(saved.get("refresh_token") and saved.get("email") == email)
    except Exception:
        return False


def scrub_password_from_config(cfg):
    """Remove MUSE_PASSWORD from config.json after a successful first mint.

    Best-effort only: a failure here never breaks the login (the session
    is already saved in state/session.json). Returns True when the password
    was removed, False otherwise. The file is rewritten atomically and
    left at chmod 600. Only touches the file when the password actually
    came from that file (not from the environment).
    """
    if not cfg.get("password_from_config"):
        return False
    path = cfg.get("config_path")
    if not path:
        return False
    try:
        data = read_config(Path(path))
        if "MUSE_PASSWORD" not in data:
            return True
        del data["MUSE_PASSWORD"]
        tmp = Path(str(path) + ".tmp")
        tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        os.chmod(tmp, 0o600)
        os.replace(tmp, Path(path))
        return True
    except Exception as e:  # noqa: BLE001 - scrub must never break login
        print(f"[muse] warning: could not scrub MUSE_PASSWORD from config.json: {e}",
              file=sys.stderr)
        return False


def get_session(cfg):
    """A valid session, in priority order: saved file, RELAY_SESSION,
    then MUSE_PASSWORD (first run only). Saves the live (rotated) token
    on success. Sets cfg['auth_source'] to which path worked:
    'saved-session' | 'relay-session' | 'password'.

    A dead saved/legacy token falls through to the next source instead
    of failing outright (v6 raised immediately). A TransientError
    (network/429/5xx) still propagates at once — retrying with another
    credential would hit the same outage.
    """
    sp = _session_path(cfg["state_dir"])
    errors = []

    # 1. Saved session file.
    try:
        saved = json.loads(sp.read_text(encoding="utf-8"))
        if saved.get("refresh_token") and saved.get("email") == cfg["email"]:
            sess = _refresh_session(cfg, saved["refresh_token"])
            _save_session(sp, sess, cfg["email"])
            cfg["auth_source"] = "saved-session"
            return sess
    except TransientError:
        raise
    except AuthError as e:
        errors.append(f"saved session: {e}")
    except Exception:
        pass  # missing/corrupt/stale saved session — try the next source

    # 2. Legacy RELAY_SESSION from config.json (v6 backward compat).
    if cfg.get("session_ref"):
        try:
            sess = _refresh_session(cfg, cfg["session_ref"])
            _save_session(sp, sess, cfg["email"])
            cfg["auth_source"] = "relay-session"
            return sess
        except TransientError:
            raise
        except AuthError as e:
            errors.append(f"RELAY_SESSION: {e}")

    # 3. Password mint (v6.2 first run).
    if cfg.get("password"):
        sess = _login_with_password(cfg)
        _save_session(sp, sess, cfg["email"])
        cfg["auth_source"] = "password"
        scrub_password_from_config(cfg)
        cfg["password"] = ""  # drop it from memory once the session is saved
        return sess

    detail = "; ".join(errors) if errors else "no credential was available"
    raise AuthError(
        "no usable session — " + detail + ". Fix one of these: (a) put a fresh "
        "RELAY_SESSION in config.json (web UI -> Settings -> Token), or "
        "(b) put MUSE_PASSWORD in config.json once (the daemon mints a session "
        "and then removes the password from the file).")


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
        try:
            r = requests.request(method, url, headers=hdr, data=data, timeout=TIMEOUT)
        except requests.RequestException as e:
            raise TransientError(f"{name} network error ({type(e).__name__}) — retry later")
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
    take the MAX of the two so the cursor never goes backwards.
    """
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
    """Assemble the runtime config. Raises AuthError with a clear message when incomplete.

    New in v6.2: RELAY_SESSION is optional. A first-run install needs
    exactly one of RELAY_SESSION / MUSE_PASSWORD, unless a saved session
    already exists in state/session.json (restarts after the password was
    scrubbed). SUPABASE_PROJECT_ID is optional — only a fallback for
    building SUPABASE_URL when the URL itself is missing.
    """
    cfg_file = read_config(Path(config_path))
    project_id = str(cfg_file.get("SUPABASE_PROJECT_ID", "") or os.environ.get("SUPABASE_PROJECT_ID", ""))
    url = str(cfg_file.get("SUPABASE_URL", "") or os.environ.get("SUPABASE_URL", "")).rstrip("/")
    if not url and project_id and "." not in project_id:
        url = f"https://{project_id}.supabase.co"
    password_from_config = bool(cfg_file.get("MUSE_PASSWORD"))
    password = str(cfg_file.get("MUSE_PASSWORD", "") or os.environ.get("MUSE_PASSWORD", "")).strip()
    email = str(cfg_file.get("MUSE_EMAIL", "") or os.environ.get("MUSE_EMAIL", "")).strip().lower()
    cfg = {
        "project_id": project_id,
        "url": url,
        "publishable": str(cfg_file.get("SUPABASE_PUBLISHABLE_KEY", "") or os.environ.get("SUPABASE_PUBLISHABLE_KEY", "")),
        "email": email,
        "session_ref": str(cfg_file.get("RELAY_SESSION", "") or os.environ.get("RELAY_SESSION", "")).strip(),
        "password": password,
        "password_from_config": password_from_config,
        "config_path": Path(config_path),
        "auth_source": None,
        "state_dir": Path(state_dir),
        "outbox_dir": Path(outbox_dir),
        "session": None,
    }
    if not cfg["url"]:
        raise AuthError("SUPABASE_URL missing from config.json (or SUPABASE_PROJECT_ID to build it)")
    if not cfg["publishable"]:
        raise AuthError("SUPABASE_PUBLISHABLE_KEY missing from config.json")
    if not cfg["email"]:
        raise AuthError("MUSE_EMAIL missing from config.json")
    if not cfg["session_ref"] and not cfg["password"] and not _has_saved_session(Path(state_dir), email):
        raise AuthError(
            "no credential in config.json — put ONE of these in for first setup: "
            "RELAY_SESSION (legacy, from the web UI -> Settings -> Token) or "
            "MUSE_PASSWORD (new in v6.2 — the daemon mints a session once, then "
            "removes the password from config.json). Restarts after that need "
            "neither, because state/session.json holds the live session.")
    return cfg


def _test_login_cli():
    """Operator check: python3 relay_auth.py test-login --config config.json

    Exchanges the configured credential for a live session and prints
    which auth path worked. Prints NO token, NO password, NO refresh
    token — only the auth source and the Muse email.
    """
    ap = argparse.ArgumentParser(description="Muse Relay v6.2 — test the login without running the daemon")
    ap.add_argument("cmd", choices=["test-login"])
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--state-dir", default="state")
    ap.add_argument("--outbox-dir", default="outbox")
    args = ap.parse_args()
    try:
        cfg = build_cfg(args.config, args.state_dir, args.outbox_dir)
        sess = get_session(cfg)
        print(f"[muse] login OK — auth_source={cfg.get('auth_source')} email={cfg['email']} "
              f"access_token_expires_in_s={max(0, int(sess['expires_at'] - time.time()))}")
        return 0
    except (AuthError, TransientError) as e:
        print(f"[muse] login FAILED: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(_test_login_cli())
