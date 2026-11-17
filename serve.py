#!/usr/bin/env python3
# ============================================================
# Muse Relay — local server: hosts the web UI + proxies Supabase
#
# All keys live in .env (repo root) — NO key ever reaches the browser:
#   SUPABASE_PROJECT_ID=abcdefghijklmnopqrst      (20-letter ref)
#   SUPABASE_SECRET_KEY=sb_secret_… or eyJ…      (server-side, so sb_secret_ works)
#   SUPABASE_PUBLISHABLE_KEY=sb_publishable_…    (public key — goes into the wizard's instruction)
#   PORT=8080                                     (web UI port — --port flag overrides)
#   WEB_UI_PASSWORD=…                             (login password — REQUIRED, without it the server exits)
#   API_KEY=mr_…                                  (Bearer key for /api/v1 — without it the REST API is disabled)
#
# Run:    python3 serve.py            → http://127.0.0.1:8080
#   --host 0.0.0.0 --port 8080        (expose to the LAN if you want)
#
# Endpoints (everything except /login + /logout sits behind the password login):
#   /login /logout         password gate (mr_session cookie, persisted in .cache/)
#   /                      static web/
#   /config                → {project_id} for the page
#   /sb/<path>             Supabase proxy (REST/Auth) — injects the SECRET_KEY
#   /api/events            SSE — server polls messages every 3s, streams to the page
#   /api/v1/*              REST API for scripts — Bearer API_KEY (docs at /docs, /redoc)
# ============================================================
import argparse
import hmac
import json
import os
import re
import secrets
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import requests

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
ENV_FILE = ROOT / ".env"
CACHE_DIR = ROOT / ".cache"
SESSIONS_FILE = CACHE_DIR / "web_sessions.json"

CFG = {
    "project_id": "",
    "secret_key": "",
    "publishable": "",
    "port": "",
    "web_password": "",
    "api_key": "",
}
POLL_INTERVAL = 3  # seconds — the SSE poll rhythm against Supabase

# ---------- web login ----------
SESSION_COOKIE = "mr_session"
SESSION_TTL = 30 * 24 * 3600  # 30 days
LOGIN_MAX_FAILS = 5           # consecutive failures per IP ...
LOGIN_LOCKOUT = 30            # ... then 429 for this many seconds

# ---------- REST API /api/v1 ----------
API_LIMIT_DEFAULT = 50
API_LIMIT_MAX = 200
MESSAGE_TEXT_MAX = 20000      # matches the messages.text CHECK in supabase/setup.sql
THREAD_TITLE_MAX = 500

_NUM_RE = re.compile(r"\d+")


def load_env():
    """Read .env (KEY=VALUE lines, # comments) into CFG."""
    if not ENV_FILE.exists():
        return False
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k == "SUPABASE_PROJECT_ID":
            CFG["project_id"] = v.lower()
        elif k == "SUPABASE_SECRET_KEY":
            CFG["secret_key"] = v
        elif k == "SUPABASE_PUBLISHABLE_KEY":
            CFG["publishable"] = v
        elif k == "PORT":
            CFG["port"] = v
        elif k == "WEB_UI_PASSWORD":
            CFG["web_password"] = v
        elif k == "API_KEY":
            CFG["api_key"] = v
    return bool(CFG["project_id"] and CFG["secret_key"])


def sb_url(path):
    return f"https://{CFG['project_id']}.supabase.co/{path.lstrip('/')}"


def sb_headers(extra=None):
    h = {"apikey": CFG["secret_key"], "Authorization": f"Bearer {CFG['secret_key']}"}
    if extra:
        h.update(extra)
    return h


def check_keys():
    """Probe once at startup — fail fast if .env is wrong."""
    try:
        r = requests.get(sb_url("/rest/v1/projects?select=id&limit=1"),
                         headers=sb_headers(), timeout=15)
        if r.status_code == 200:
            print(f"[serve] SECRET_KEY OK — project {CFG['project_id']}")
            return True
        print(f"[serve] WARNING: Supabase returned {r.status_code} — check SUPABASE_SECRET_KEY in .env")
    except Exception as e:
        print(f"[serve] WARNING: cannot reach Supabase — {e}")
    return False


# ---------- web sessions (persisted so a restart keeps the owner logged in) ----------

_SESSIONS = {}      # token -> expiry epoch
_SESS_LOCK = threading.Lock()
_LOGIN_FAILS = {}   # ip -> {"fails": n, "until": epoch} — brute-force guard, memory only
_LOGIN_LOCK = threading.Lock()


def load_sessions():
    """Load persisted sessions at startup, pruning expired ones."""
    with _SESS_LOCK:
        now = int(time.time())
        for tok in [t for t, e in _SESSIONS.items() if e <= now]:
            del _SESSIONS[tok]
        try:
            data = json.loads(SESSIONS_FILE.read_text(encoding="utf-8"))
        except Exception:
            return  # no file / corrupt file — start fresh
        for tok, exp in data.items():
            if isinstance(exp, (int, float)) and exp > now:
                _SESSIONS[tok] = int(exp)


def create_session(token):
    """Add a session, prune expired ones, persist atomically (tmp + rename)."""
    with _SESS_LOCK:
        _SESSIONS[token] = int(time.time()) + SESSION_TTL
        try:
            now = int(time.time())
            for tok in [t for t, e in _SESSIONS.items() if e <= now]:
                del _SESSIONS[tok]
            CACHE_DIR.mkdir(exist_ok=True)
            tmp = SESSIONS_FILE.with_suffix(".tmp")
            tmp.write_text(json.dumps(_SESSIONS), encoding="utf-8")
            os.replace(tmp, SESSIONS_FILE)
        except OSError as e:
            print(f"[serve] WARNING: cannot persist web sessions — {e}")


def login_throttled(ip):
    """Brute-force guard → (allowed, retry_after_seconds)."""
    with _LOGIN_LOCK:
        st = _LOGIN_FAILS.get(ip)
        if not st:
            return True, 0
        if st["until"] and time.time() < st["until"]:
            return False, int(st["until"] - time.time()) + 1
        del _LOGIN_FAILS[ip]  # lockout expired — fresh window
        return True, 0


def login_fail(ip):
    """Count a failed sign-in; lock the IP out after LOGIN_MAX_FAILS."""
    with _LOGIN_LOCK:
        st = _LOGIN_FAILS.setdefault(ip, {"fails": 0, "until": 0})
        st["fails"] += 1
        if st["fails"] >= LOGIN_MAX_FAILS:
            st["until"] = time.time() + LOGIN_LOCKOUT


def login_clear(ip):
    with _LOGIN_LOCK:
        _LOGIN_FAILS.pop(ip, None)


# ---------- REST API helpers ----------

def api_error(code, message):
    """Uniform error envelope for the REST API."""
    return {"error": {"code": code, "message": message}}


def parse_id_param(qs, name, required=True):
    """Pull a positive-integer query param → (value, error_message)."""
    vals = qs.get(name)
    if not vals or not vals[0].strip():
        return None, (f"missing required query parameter '{name}'" if required else None)
    s = vals[0].strip()
    if not _NUM_RE.fullmatch(s):
        return None, f"'{name}' must be a positive integer"
    return int(s), None


def field_int(data, name):
    """Validate a JSON body integer field (bools don't count as ints)."""
    v = data.get(name)
    if isinstance(v, bool) or not isinstance(v, int):
        return None, f"'{name}' is required and must be an integer"
    return v, None


def field_text(data, name, max_len):
    """Validate a JSON body text field: non-empty string, capped length."""
    v = data.get(name)
    if not isinstance(v, str) or not v.strip():
        return None, f"'{name}' is required and must be a non-empty string"
    if len(v) > max_len:
        return None, f"'{name}' must be at most {max_len} characters"
    return v, None


# ---------- SSE realtime ----------

def sse_events(wfile):
    """Poll messages every 3s; stream new ones (id > connection watermark) as SSE."""
    last_id = None
    last_beat = time.time()
    while True:
        try:
            r = requests.get(
                sb_url("/rest/v1/messages?select=id,project_id,thread_id,role,text,created_at&order=id.desc&limit=200"),
                headers=sb_headers(), timeout=15,
            )
            if r.status_code == 200:
                msgs = sorted(r.json(), key=lambda m: m["id"])
                if last_id is None:
                    last_id = msgs[-1]["id"] if msgs else 0  # never replay history
                new = [m for m in msgs if m["id"] > last_id]
                for m in new:
                    last_id = m["id"]
                    wfile.write(f"data: {json.dumps({'type': 'message', 'm': m}, ensure_ascii=False)}\n\n".encode("utf-8"))
                wfile.flush()
            elif not getattr(sse_events, "_warned", False):
                print(f"[serve] SSE poll returned {r.status_code} — check SECRET_KEY")
                sse_events._warned = True
        except (BrokenPipeError, ConnectionResetError):
            raise
        except Exception:
            pass  # network blip — retry next round
        if time.time() - last_beat > 15:
            try:
                wfile.write(b": hb\n\n")
                wfile.flush()
                last_beat = time.time()
            except (BrokenPipeError, ConnectionResetError):
                raise
            except Exception:
                pass
        time.sleep(POLL_INTERVAL)


# ---------- inline HTML pages (dark, matching the app; no external assets except doc viewers) ----------

LOGIN_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Muse Relay — Sign in</title>
<style>
  :root { --bg:#0f141a; --panel:#171e26; --border:#1e2733; --accent:#2f6fed;
          --text:#e8eef5; --muted:#a9b9cd; --danger:#da3633; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:var(--bg); color:var(--text);
         font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .card { width:min(360px,calc(100vw - 32px)); padding:32px 28px; background:var(--panel);
          border:1px solid var(--border); border-radius:10px; }
  h1 { margin:0 0 4px; font-size:20px; }
  .sub { margin:0 0 20px; color:var(--muted); font-size:12.5px; }
  .error:empty { display:none; }
  .error { margin:-8px 0 14px; color:var(--danger); font-size:12.5px; }
  label { display:block; margin-bottom:6px; color:var(--muted); font-size:12.5px; }
  input[type=password] { width:100%; padding:10px 12px; background:var(--bg); color:var(--text);
         border:1px solid var(--border); border-radius:8px; font-size:14px; outline:none; }
  input[type=password]:focus { border-color:var(--accent); }
  button { width:100%; margin-top:16px; padding:10px 12px; background:var(--accent); color:#fff;
           border:0; border-radius:8px; font-size:14px; font-weight:600; cursor:pointer; }
  button:hover { filter:brightness(1.12); }
  .credit { margin:18px 0 0; color:var(--muted); font-size:11px; text-align:center; }
</style>
</head>
<body>
  <div class="card">
    <h1>Muse Relay</h1>
    <p class="sub">Owner sign-in</p>
    <p class="error">__ERROR__</p>
    <form method="post" action="/login">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autofocus autocomplete="current-password" required>
      <button type="submit">Sign in</button>
    </form>
    <p class="credit">Built with ZCode</p>
  </div>
</body>
</html>
"""
LOGIN_ERROR_LINE = "Wrong password — try again."

SWAGGER_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Muse Relay API — Swagger UI</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
<style> html, body { margin:0; padding:0; background:#0f141a; } </style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
  window.addEventListener('load', function () {
    SwaggerUIBundle({ url: 'openapi.json', dom_id: '#swagger-ui' });
  });
</script>
</body>
</html>
"""

REDOC_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Muse Relay API — ReDoc</title>
<style> body { margin:0; padding:0; background:#0f141a; } </style>
</head>
<body>
<redoc spec-url="openapi.json"></redoc>
<script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
</body>
</html>
"""


# ---------- HTTP handler ----------

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quiet log — skip static-file noise
        if "/sb/" in self.path or "/api/" in self.path:
            sys.stdout.write("[req] %s\n" % (fmt % args))

    # ----- helpers -----
    def _json(self, status, body, headers=None):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _html(self, status, markup):
        data = markup.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _redirect(self, location, status=302, cookie=None):
        self.send_response(status)
        self.send_header("Location", location)
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _json_body(self):
        """Parse the request body as a JSON object → (data, error_message)."""
        raw = self._read_body()
        if not raw:
            return None, "empty request body — expected a JSON object"
        try:
            data = json.loads(raw.decode("utf-8", "replace"))
        except ValueError:
            return None, "request body is not valid JSON"
        if not isinstance(data, dict):
            return None, "request body must be a JSON object"
        return data, None

    def _proxy_sb(self):
        """Forward /sb/<path> to Supabase, injecting the SECRET_KEY."""
        target = self.path[len("/sb"):]
        body = self._read_body()
        fwd = {"Content-Type": self.headers.get("Content-Type", "application/json")}
        if self.headers.get("Prefer"):
            fwd["Prefer"] = self.headers.get("Prefer")
        try:
            r = requests.request(
                self.command, sb_url(target), headers=sb_headers(fwd),
                data=body if body else None, timeout=30,
            )
        except Exception as e:
            self._json(502, {"network": True, "message": f"could not reach Supabase: {e}"})
            return
        self.send_response(r.status_code)
        ct = r.headers.get("Content-Type", "application/json")
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(r.content)))
        self.end_headers()
        self.wfile.write(r.content)

    # ----- web login / session gate -----
    def _session_token(self):
        for part in self.headers.get("Cookie", "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == SESSION_COOKIE:
                return v
        return None

    def _session_ok(self):
        tok = self._session_token()
        if not tok:
            return False
        with _SESS_LOCK:
            exp = _SESSIONS.get(tok)
        return exp is not None and exp > time.time()

    def _is_public(self):
        """Login/logout are reachable without a session."""
        p = self.path.split("?", 1)[0]
        if p == "/login" and self.command in ("GET", "POST"):
            return True
        if p == "/logout" and self.command == "GET":
            return True
        return False

    def _gate(self):
        """Password gate for every route. /api/v1/* is exempt (Bearer auth there).
        Page-ish routes redirect to /login; JSON-ish routes get a flat 401."""
        p = self.path.split("?", 1)[0]
        if self._is_public() or p.startswith("/api/v1/"):
            return True
        if self._session_ok():
            return True
        if p == "/config" or p.startswith("/sb/") or p.startswith("/api/"):
            self._json(401, {"error": "unauthorized"})
        else:
            self._redirect("/login", status=302)
        return False

    def _handle_login_post(self):
        ip = self.client_address[0]
        ok, retry = login_throttled(ip)
        if not ok:
            return self._json(429, api_error("too_many_attempts",
                                             f"too many failed sign-ins — try again in {retry}s"),
                              {"Retry-After": str(retry)})
        form = parse_qs(self._read_body().decode("utf-8", "replace"), keep_blank_values=True)
        password = (form.get("password") or [""])[0]
        if not hmac.compare_digest(password.encode("utf-8"), CFG["web_password"].encode("utf-8")):
            login_fail(ip)
            return self._html(401, LOGIN_PAGE.replace("__ERROR__", LOGIN_ERROR_LINE))
        login_clear(ip)
        token = secrets.token_urlsafe(32)
        create_session(token)
        self._redirect("/", status=303,
                       cookie=f"{SESSION_COOKIE}={token}; Path=/; Max-Age={SESSION_TTL}; HttpOnly; SameSite=Lax")

    # ----- REST API /api/v1 (Bearer API_KEY, independent of the browser session) -----
    def _bearer_ok(self):
        """Constant-time check of 'Authorization: Bearer <API_KEY>'."""
        scheme, _, key = self.headers.get("Authorization", "").strip().partition(" ")
        if scheme.lower() != "bearer" or not key.strip():
            return False
        return hmac.compare_digest(key.strip().encode("utf-8"), CFG["api_key"].encode("utf-8"))

    def _handle_api_v1(self):
        p = self.path.split("?", 1)[0]
        if not CFG["api_key"]:
            return self._json(503, api_error("api_disabled", "API_KEY not set in .env"))
        if not self._bearer_ok():
            return self._json(401, api_error("unauthorized",
                                             "missing or invalid Authorization header — expected 'Bearer <API_KEY>'"))
        if p == "/api/v1/muses" and self.command == "GET":
            return self._api_muses()
        if p == "/api/v1/threads":
            if self.command == "GET":
                return self._api_threads_list()
            if self.command == "POST":
                return self._api_threads_create()
        if p == "/api/v1/messages":
            if self.command == "GET":
                return self._api_messages_list()
            if self.command == "POST":
                return self._api_messages_create()
        self._json(404, api_error("not_found", f"no route for {self.command} {p}"))

    def _sb_api(self, method, path, body=None, prefer=False):
        """Supabase REST call for the API; returns the response, or None after sending a 502."""
        headers = sb_headers({"Content-Type": "application/json"})
        if prefer:
            headers["Prefer"] = "return=representation"
        try:
            r = requests.request(method, sb_url(path), headers=headers,
                                 data=json.dumps(body, ensure_ascii=False) if body is not None else None,
                                 timeout=15)
        except Exception as e:
            self._json(502, api_error("upstream_error", f"could not reach Supabase: {e}"))
            return None
        if r.status_code not in (200, 201):
            self._json(502, api_error("upstream_error", f"Supabase returned {r.status_code}: {r.text[:200]}"))
            return None
        return r

    def _api_require(self, table, row_id, code, label, columns="id"):
        """Return the row with this id, or None after sending 404 (502 on upstream trouble)."""
        r = self._sb_api("GET", f"/rest/v1/{table}?select={columns}&id=eq.{row_id}&limit=1")
        if r is None:
            return None
        rows = r.json() or []
        if not rows:
            self._json(404, api_error(code, f"no {label} with id {row_id}"))
            return None
        return rows[0]

    def _api_muses(self):
        r = self._sb_api("GET", "/rest/v1/projects?select=id,muse_id,name,tags,email,created_at&order=id.asc")
        if r is None:
            return
        self._json(200, {"data": r.json()})

    def _api_threads_list(self):
        qs = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
        muse_id, err = parse_id_param(qs, "muse_id")
        if err:
            return self._json(400, api_error("invalid_request", err))
        if self._api_require("projects", muse_id, "muse_not_found", "muse") is None:
            return
        r = self._sb_api("GET",
                         f"/rest/v1/threads?select=id,project_id,title,created_at&project_id=eq.{muse_id}&order=id.asc")
        if r is None:
            return
        self._json(200, {"data": r.json()})

    def _api_threads_create(self):
        data, err = self._json_body()
        if err:
            return self._json(400, api_error("invalid_request", err))
        muse_id, err = field_int(data, "muse_id")
        if err:
            return self._json(400, api_error("invalid_request", err))
        title, err = field_text(data, "title", THREAD_TITLE_MAX)
        if err:
            return self._json(400, api_error("invalid_request", err))
        if self._api_require("projects", muse_id, "muse_not_found", "muse") is None:
            return
        r = self._sb_api("POST", "/rest/v1/threads",
                         body={"project_id": muse_id, "title": title}, prefer=True)
        if r is None:
            return
        rows = r.json() or [None]
        self._json(201, {"data": rows[0]})

    def _api_messages_list(self):
        qs = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
        thread_id, err = parse_id_param(qs, "thread_id")
        if err:
            return self._json(400, api_error("invalid_request", err))
        after_id, err = parse_id_param(qs, "after_id", required=False)
        if err:
            return self._json(400, api_error("invalid_request", err))
        limit = API_LIMIT_DEFAULT
        if "limit" in qs:
            s = qs["limit"][0].strip()
            if not _NUM_RE.fullmatch(s) or not 1 <= int(s) <= API_LIMIT_MAX:
                return self._json(400, api_error("invalid_request",
                                                 f"'limit' must be an integer between 1 and {API_LIMIT_MAX}"))
            limit = int(s)
        if self._api_require("threads", thread_id, "thread_not_found", "thread") is None:
            return
        path = (f"/rest/v1/messages?select=id,thread_id,project_id,role,text,created_at"
                f"&thread_id=eq.{thread_id}&order=id.asc&limit={limit}")
        if after_id is not None:
            path += f"&id=gt.{after_id}"
        r = self._sb_api("GET", path)
        if r is None:
            return
        self._json(200, {"data": r.json()})

    def _api_messages_create(self):
        data, err = self._json_body()
        if err:
            return self._json(400, api_error("invalid_request", err))
        thread_id, err = field_int(data, "thread_id")
        if err:
            return self._json(400, api_error("invalid_request", err))
        text, err = field_text(data, "text", MESSAGE_TEXT_MAX)
        if err:
            return self._json(400, api_error("invalid_request", err))
        # messages.project_id is NOT NULL with no default — copy it from the thread
        thread = self._api_require("threads", thread_id, "thread_not_found", "thread", columns="id,project_id")
        if thread is None:
            return
        r = self._sb_api("POST", "/rest/v1/messages",
                         body={"thread_id": thread_id, "project_id": thread["project_id"],
                               "role": "user", "text": text},
                         prefer=True)
        if r is None:
            return
        rows = r.json() or [None]
        self._json(201, {"data": rows[0]})

    # ----- routes -----
    def do_GET(self):
        if not self._gate():
            return
        p = self.path.split("?", 1)[0]
        if p == "/config":
            self._json(200, {"project_id": CFG["project_id"], "publishable_key": CFG["publishable"]})
        elif p == "/api/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            try:
                sse_events(self.wfile)
            except (BrokenPipeError, ConnectionResetError):
                pass  # client disconnected — normal
        elif p.startswith("/sb/"):
            self._proxy_sb()
        elif p.startswith("/api/v1/"):
            self._handle_api_v1()
        elif p == "/login":
            self._html(200, LOGIN_PAGE.replace("__ERROR__", ""))
        elif p == "/logout":
            self._redirect("/login", status=303,
                           cookie=f"{SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax")
        elif p == "/docs":
            self._html(200, SWAGGER_PAGE)
        elif p == "/redoc":
            self._html(200, REDOC_PAGE)
        else:
            super().do_GET()

    def do_POST(self):
        if not self._gate():
            return
        p = self.path.split("?", 1)[0]
        if p == "/login":
            self._handle_login_post()
        elif p.startswith("/sb/"):
            self._proxy_sb()
        elif p.startswith("/api/v1/"):
            self._handle_api_v1()
        else:
            self._json(404, {"error": "not found"})

    def do_PATCH(self):
        if not self._gate():
            return
        p = self.path.split("?", 1)[0]
        if p.startswith("/sb/"):
            return self._proxy_sb()
        if p.startswith("/api/v1/"):
            return self._handle_api_v1()
        self._json(404, {"error": "not found"})

    do_PUT = do_PATCH
    do_DELETE = do_PATCH

    def do_HEAD(self):
        if not self._gate():
            return
        super().do_HEAD()


def main():
    ap = argparse.ArgumentParser(description="Muse Relay local server")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=None,
                    help="overrides PORT from .env (default: PORT env, else 8080)")
    args = ap.parse_args()

    if not load_env():
        print("[serve] No valid .env — create a .env at the repo root with:")
        print("  SUPABASE_PROJECT_ID=<20-letter ref>")
        print("  SUPABASE_SECRET_KEY=<sb_secret_… or legacy JWT eyJ…>")
        sys.exit(1)

    # Port resolution: --port CLI flag > PORT env > 8080
    env_port = None
    if CFG["port"]:
        try:
            env_port = int(CFG["port"])
        except ValueError:
            print(f"[serve] WARNING: PORT '{CFG['port']}' in .env is not a number — using 8080")
    port = args.port if args.port is not None else (env_port or 8080)

    # The web UI must never run unprotected
    if not CFG["web_password"]:
        print("[serve] ERROR: WEB_UI_PASSWORD is not set in .env — refusing to start the web UI unprotected.")
        print("  Add a line  WEB_UI_PASSWORD=<your-password>  to .env, then restart.")
        sys.exit(1)

    if "." in CFG["project_id"] or len(CFG["project_id"]) != 20 or not CFG["project_id"].isalpha():
        print(f"[serve] WARNING: SUPABASE_PROJECT_ID '{CFG['project_id']}' does not look like a 20-letter ref")

    print(f"[serve] Publishable key: {'OK — goes into the wizard instruction' if CFG['publishable'] else 'MISSING — add SUPABASE_PUBLISHABLE_KEY to .env'}")
    check_keys()

    print(f"[serve] Auth: web login ON (WEB_UI_PASSWORD) — REST API: "
          f"{'ON (Bearer API_KEY, docs at /docs and /redoc)' if CFG['api_key'] else 'OFF (API_KEY missing — /api/v1/* returns 503)'}")
    load_sessions()

    handler = lambda *a, **kw: Handler(*a, directory=str(WEB_DIR), **kw)
    server = ThreadingHTTPServer((args.host, port), handler)
    print(f"[serve] Web UI: http://{args.host}:{port}  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[serve] server stopped — see you")


if __name__ == "__main__":
    main()
