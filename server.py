"""Muse Relay — server chuyển tiếp tin nhắn giữa web chat và nhiều account Muse.

Chạy:
    uvicorn server:app --host 0.0.0.0 --port 8000

Môi trường:
    RELAY_ADMIN_TOKEN  token quản trị (không set thì tự sinh, lưu ở data/admin_token.txt)
    RELAY_DATA         thư mục chứa relay.db (mặc định ./data)
    RELAY_DB           đường dẫn sqlite đầy đủ (ghi đè RELAY_DATA)
"""
import asyncio
import os
import secrets
import sqlite3
import time
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.security.utils import get_authorization_scheme_param
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("RELAY_DATA", BASE_DIR / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = Path(os.environ.get("RELAY_DB", DATA_DIR / "relay.db"))

ADMIN_TOKEN = os.environ.get("RELAY_ADMIN_TOKEN", "")
if not ADMIN_TOKEN:
    _token_file = DATA_DIR / "admin_token.txt"
    if _token_file.exists():
        ADMIN_TOKEN = _token_file.read_text().strip()
    else:
        ADMIN_TOKEN = secrets.token_urlsafe(24)
        _token_file.write_text(ADMIN_TOKEN)
        print(f"[muse-relay] admin token: {ADMIN_TOKEN}  (lưu tại {_token_file})")

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations(
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    muse_id       TEXT UNIQUE NOT NULL,
    name          TEXT NOT NULL,
    token         TEXT UNIQUE NOT NULL,
    last_read_id  INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages(
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    role            TEXT NOT NULL CHECK(role IN ('user','muse')),
    text            TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
"""


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=10000")
    return conn


with db() as _c:
    _c.executescript(SCHEMA)


class Notifier(asyncio.Condition):
    async def ping(self):
        async with self:
            self.notify_all()


NOTIFIER = Notifier()

app = FastAPI(title="Muse Relay", docs_url=None, redoc_url=None)


# ---------- auth ----------
def _bearer(request: Request) -> str:
    scheme, param = get_authorization_scheme_param(request.headers.get("Authorization", ""))
    if scheme.lower() != "bearer" or not param:
        raise HTTPException(401, "Thiếu bearer token")
    return param


def admin_guard(request: Request) -> None:
    if not secrets.compare_digest(_bearer(request), ADMIN_TOKEN):
        raise HTTPException(401, "Sai admin token")


def muse_guard(request: Request) -> dict:
    token = _bearer(request)
    with db() as c:
        row = c.execute("SELECT * FROM conversations WHERE token = ?", (token,)).fetchone()
    if row is None:
        raise HTTPException(401, "Sai muse token")
    return dict(row)


# ---------- models ----------
class ConvIn(BaseModel):
    muse_id: str
    name: str


class SendIn(BaseModel):
    conversation_id: int
    text: str


class ReplyIn(BaseModel):
    text: str


class ReadIn(BaseModel):
    conversation_id: int


# ---------- endpoints admin ----------
@app.post("/api/conversations", dependencies=[Depends(admin_guard)])
def create_conversation(body: ConvIn):
    with db() as c:
        dup = c.execute("SELECT 1 FROM conversations WHERE muse_id = ?", (body.muse_id,)).fetchone()
        if dup:
            raise HTTPException(409, f"muse_id '{body.muse_id}' đã tồn tại")
        token = "muse_" + secrets.token_urlsafe(24)
        cur = c.execute(
            "INSERT INTO conversations(muse_id, name, token) VALUES(?, ?, ?)",
            (body.muse_id, body.name, token),
        )
        return {"id": cur.lastrowid, "muse_id": body.muse_id, "name": body.name, "token": token}


@app.get("/api/conversations", dependencies=[Depends(admin_guard)])
def list_conversations():
    with db() as c:
        rows = c.execute(
            """
            SELECT c.id, c.muse_id, c.name, c.created_at,
                   (SELECT MAX(id) FROM messages WHERE conversation_id = c.id) AS last_msg_id,
                   (SELECT text FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS preview,
                   (SELECT role FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS preview_role,
                   (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS preview_at,
                   (SELECT COUNT(*) FROM messages
                     WHERE conversation_id = c.id AND role = 'muse' AND id > c.last_read_id) AS unread
            FROM conversations c
            ORDER BY COALESCE(last_msg_id, 0) DESC, c.id
            """
        ).fetchall()
    return {"conversations": [dict(r) for r in rows]}


@app.post("/api/read", dependencies=[Depends(admin_guard)])
def mark_read(body: ReadIn):
    with db() as c:
        c.execute(
            "UPDATE conversations SET last_read_id = "
            "(SELECT COALESCE(MAX(id), 0) FROM messages WHERE conversation_id = ?) WHERE id = ?",
            (body.conversation_id, body.conversation_id),
        )
    return {"ok": True}


@app.get("/api/messages", dependencies=[Depends(admin_guard)])
def read_messages(conversation_id: int, after: int = 0, limit: int = 500):
    with db() as c:
        rows = c.execute(
            "SELECT id, role, text, created_at FROM messages "
            "WHERE conversation_id = ? AND id > ? ORDER BY id LIMIT ?",
            (conversation_id, after, min(limit, 1000)),
        ).fetchall()
    return {"conversation_id": conversation_id, "messages": [dict(r) for r in rows]}


@app.post("/api/messages", dependencies=[Depends(admin_guard)])
async def send_message(body: SendIn):
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "Tin nhắn rỗng")
    with db() as c:
        conv = c.execute("SELECT id FROM conversations WHERE id = ?", (body.conversation_id,)).fetchone()
        if conv is None:
            raise HTTPException(404, "Không tìm thấy hội thoại")
        cur = c.execute(
            "INSERT INTO messages(conversation_id, role, text) VALUES(?, 'user', ?)",
            (body.conversation_id, text),
        )
        mid = cur.lastrowid
    await NOTIFIER.ping()
    return {"ok": True, "id": mid}


# ---------- endpoints muse ----------
@app.get("/api/me")
def me(conv: dict = Depends(muse_guard)):
    return {"conversation_id": conv["id"], "muse_id": conv["muse_id"], "name": conv["name"]}


@app.get("/api/poll")
async def poll(after: int = 0, wait: int = 25, conv: dict = Depends(muse_guard)):
    """Long-poll tin mới: giữ request tới khi có tin hoặc hết wait (tối đa 55s)."""
    wait = max(0, min(wait, 55))
    deadline = time.monotonic() + wait
    while True:
        with db() as c:
            rows = c.execute(
                "SELECT id, role, text, created_at FROM messages "
                "WHERE conversation_id = ? AND id > ? ORDER BY id",
                (conv["id"], after),
            ).fetchall()
        if rows or wait == 0 or time.monotonic() >= deadline:
            return {"conversation_id": conv["id"], "messages": [dict(r) for r in rows]}
        try:
            async with NOTIFIER:
                await asyncio.wait_for(NOTIFIER.wait(), timeout=min(0.5, deadline - time.monotonic()))
        except asyncio.TimeoutError:
            pass


@app.post("/api/reply")
async def reply(body: ReplyIn, conv: dict = Depends(muse_guard)):
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "Tin nhắn rỗng")
    with db() as c:
        cur = c.execute(
            "INSERT INTO messages(conversation_id, role, text) VALUES(?, 'muse', ?)",
            (conv["id"], text),
        )
        mid = cur.lastrowid
    await NOTIFIER.ping()
    return {"ok": True, "id": mid}


@app.get("/api/health")
def health():
    return {"ok": True}


app.mount("/", StaticFiles(directory=BASE_DIR / "static", html=True), name="static")
