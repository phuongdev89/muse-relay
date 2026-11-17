#!/usr/bin/env python3
# ============================================================
# Muse Relay — local server: hosts the web UI + proxies Supabase
#
# All keys live in .env (repo root) — NO key ever reaches the browser:
#   SUPABASE_PROJECT_ID=abcdefghijklmnopqrst      (20-letter ref)
#   SUPABASE_SECRET_KEY=sb_secret_… or eyJ…      (server-side, so sb_secret_ works)
#   SUPABASE_PUBLISHABLE_KEY=sb_publishable_…    (public key — goes into the wizard's instruction)
#
# Run:    python3 serve.py            → http://127.0.0.1:8080
#   --host 0.0.0.0 --port 8080        (expose to the LAN if you want)
#
# Endpoint:
#   /                      static web/
#   /config                → {project_id} cho trang
#   /sb/<path>             Supabase proxy (REST/Auth) — injects the SECRET_KEY
#   /api/events            SSE — server polls messages every 3s, streams to the page
# ============================================================
import argparse
import json
import os
import random
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
ENV_FILE = ROOT / ".env"

CFG = {
    "project_id": "",
    "secret_key": "",
    "publishable": "",
}
POLL_INTERVAL = 3  # seconds — the SSE poll rhythm against Supabase


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


# ---------- HTTP handler ----------

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quiet log — skip static-file noise
        if "/sb/" in self.path or "/api/" in self.path:
            sys.stdout.write("[req] %s\n" % (fmt % args))

    # ----- helpers -----
    def _json(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

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

    # ----- routes -----
    def do_GET(self):
        if self.path == "/config":
            self._json(200, {"project_id": CFG["project_id"], "publishable_key": CFG["publishable"]})
        elif self.path == "/api/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            try:
                sse_events(self.wfile)
            except (BrokenPipeError, ConnectionResetError):
                pass  # client disconnected — normal
        elif self.path.startswith("/sb/"):
            self._proxy_sb()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith("/sb/"):
            return self._proxy_sb()
        self._json(404, {"error": "not found"})

    def do_PATCH(self):
        if self.path.startswith("/sb/"):
            return self._proxy_sb()
        self._json(404, {"error": "not found"})

    do_PUT = do_PATCH
    do_DELETE = do_PATCH


def main():
    ap = argparse.ArgumentParser(description="Muse Relay local server")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8080)
    args = ap.parse_args()

    if not load_env():
        print("[serve] No valid .env — create a .env at the repo root with:")
        print("  SUPABASE_PROJECT_ID=<20-letter ref>")
        print("  SUPABASE_SECRET_KEY=<sb_secret_… or legacy JWT eyJ…>")
        sys.exit(1)
    if "." in CFG["project_id"] or len(CFG["project_id"]) != 20 or not CFG["project_id"].isalpha():
        print(f"[serve] WARNING: SUPABASE_PROJECT_ID '{CFG['project_id']}' does not look like a 20-letter ref")

    print(f"[serve] Publishable key: {'OK — goes into the wizard instruction' if CFG['publishable'] else 'MISSING — add SUPABASE_PUBLISHABLE_KEY to .env'}")
    check_keys()

    handler = lambda *a, **kw: Handler(*a, directory=str(WEB_DIR), **kw)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"[serve] Web UI: http://{args.host}:{args.port}  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[serve] server stopped — see you")


if __name__ == "__main__":
    main()
