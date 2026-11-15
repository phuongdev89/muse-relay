"""Test mock cho muse_client.py — giả lập GoTrue + PostgREST (subset contract §3).

Chạy: python3 web/test_client_mock.py  (không cần internet, chỉ requests + stdlib)

Mock server (http.server) chạy trong thread trên 127.0.0.1, dữ liệu in-memory:
- POST /auth/v1/token?grant_type=password — kiểm email/password khớp dict user
- GET  /rest/v1/projects?user_id=eq.<uid>
- GET  /rest/v1/threads?project_id=eq.<pid>
- GET  /rest/v1/messages?thread_id=in.(...)&id=gt.<n>&order=id.asc&limit=<n>
- POST /rest/v1/messages — Prefer: return=minimal → 201, không body

muse_client.py THẬT chạy như subprocess với thư mục tmp (.env điền xong — có
comment/quotes/dòng trống để test bộ parse — + outbox sẵn 1 file reply). Kiểm tra:
banner, inbox.jsonl, cursor.json atomic, outbox POST → xóa file, 4xx → .err,
500 → retry lần 2 thành công, không lộ secret. Tự dọn tmp + tắt server trong finally.
"""
import json
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
KHACH = ROOT / "web" / "templates" / "muse_client.py"

KET_QUA = []


def kt(ten, ok, chi_tiet=""):
    print(("PASS " if ok else "FAIL ") + ten + (f" — {chi_tiet}" if chi_tiet and not ok else ""))
    KET_QUA.append(bool(ok))


# ---------- mock Supabase in-memory ----------

class MockState:
    """Dữ liệu giả lập của Supabase (users, projects, threads, messages)."""

    def __init__(self):
        self.anon = "sb_publishable_mock_anon_0000000000000000"
        self.users = {}        # email -> {"password", "uid"}
        self.tokens = set()    # access_token còn hiệu lực
        self.projects = []
        self.threads = []
        self.messages = []
        self.nxt_project = 9   # project đầu tiên = 10
        self.nxt_thread = 99   # thread đầu tiên = 100
        self.nxt_msg = 999     # message đầu tiên = 1000
        self.posts = []        # (body, prefer) của mọi POST /rest/v1/messages
        self.reject_post = False  # True → mọi POST messages trả 400 (giả lập 4xx)
        self.fail_next_post = 0   # n POST đầu trả 500 (giả lập lỗi tạm thời)


ST = MockState()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass  # tắt log mặc định để stdout test sạch

    def _tra(self, code, obj=None):
        data = b"" if obj is None else json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if data:
            self.wfile.write(data)

    def _doc_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n)) if n else {}

    def _auth_ok(self):
        """REST cần apikey=anon + bearer token do mock cấp (giả lập GoTrue)."""
        auth = self.headers.get("Authorization", "")
        token = auth[7:] if auth.startswith("Bearer ") else ""
        return self.headers.get("apikey") == ST.anon and token in ST.tokens

    def do_POST(self):
        u = urlparse(self.path)
        body = self._doc_body()
        if u.path == "/auth/v1/token":
            if "grant_type=password" not in (u.query or ""):
                return self._tra(400, {"error": "unsupported_grant_type"})
            us = ST.users.get(body.get("email", ""))
            if not us or us["password"] != body.get("password", ""):
                return self._tra(400, {"error": "invalid_grant", "error_description": "Sai email hoặc password"})
            tok = "tok_" + uuid.uuid4().hex
            ST.tokens.add(tok)
            return self._tra(200, {"access_token": tok, "token_type": "bearer",
                                   "user": {"id": us["uid"], "email": body.get("email")}})
        if u.path == "/rest/v1/messages":
            if not self._auth_ok():
                return self._tra(401, {"message": "JWT không hợp lệ (mock)"})
            ST.posts.append((body, self.headers.get("Prefer", "")))
            if ST.reject_post:
                return self._tra(400, {"message": "vi phạm RLS (mock)"})
            if ST.fail_next_post > 0:
                ST.fail_next_post -= 1
                return self._tra(500, {"message": "mock lỗi 500 tạm thời"})
            if not isinstance(body.get("thread_id"), int) or body.get("role") != "muse":
                return self._tra(400, {"message": "body reply không hợp lệ (mock)"})
            if not any(t["id"] == body["thread_id"] for t in ST.threads):
                return self._tra(400, {"message": "thread không tồn tại (mock)"})
            ST.nxt_msg += 1
            ST.messages.append({"id": ST.nxt_msg, "thread_id": body["thread_id"],
                                "project_id": body.get("project_id"), "role": body["role"],
                                "text": body.get("text", ""), "created_at": "2026-01-01T00:00:00Z"})
            if "return=representation" in self.headers.get("Prefer", ""):
                return self._tra(201, ST.messages[-1])
            return self._tra(201)  # Prefer: return=minimal → không body
        return self._tra(404, {"message": "không hỗ trợ (mock)"})

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query, keep_blank_values=True)
        if not self._auth_ok():
            return self._tra(401, {"message": "JWT không hợp lệ (mock)"})
        if u.path == "/rest/v1/projects":
            uid = (q.get("user_id", [""])[0] or "")[3:]  # bỏ tiền tố "eq."
            return self._tra(200, [p for p in ST.projects if p["user_id"] == uid])
        if u.path == "/rest/v1/threads":
            pid = (q.get("project_id", [""])[0] or "")[3:]
            return self._tra(200, [t for t in ST.threads if t["project_id"] == int(pid)])
        if u.path == "/rest/v1/messages":
            raw = q.get("thread_id", [""])[0]
            m = re.fullmatch(r"in\.\((.*)\)", raw)
            ids = {int(x) for x in m.group(1).split(",") if x.strip()} if m else set()
            cursor = int((q.get("id", ["gt.0"])[0] or "gt.0")[3:])  # "gt.N"
            limit = int(q.get("limit", ["500"])[0])
            ds = [ms for ms in ST.messages if ms["thread_id"] in ids and ms["id"] > cursor]
            ds.sort(key=lambda ms: ms["id"])  # order=id.asc
            return self._tra(200, ds[:limit])
        return self._tra(404, {"message": "không hỗ trợ (mock)"})


# ---------- dữ liệu + môi trường test ----------

def tao_mock_user(email, password, muse_id, name):
    """Tạo user + project + thread đầu tiên của mock; trả về {"uid","pid","tid"}."""
    uid = "uid-" + uuid.uuid4().hex[:8]
    ST.users[email] = {"password": password, "uid": uid}
    ST.nxt_project += 1
    pid = ST.nxt_project
    ST.projects.append({"id": pid, "muse_id": muse_id, "name": name, "tags": ["chat"],
                        "user_id": uid, "email": email, "secret": password})
    ST.nxt_thread += 1
    tid = ST.nxt_thread
    ST.threads.append({"id": tid, "project_id": pid, "title": "thread mock"})
    return {"uid": uid, "pid": pid, "tid": tid}


def tao_tin(tid, pid, role, text):
    ST.nxt_msg += 1
    ST.messages.append({"id": ST.nxt_msg, "thread_id": tid, "project_id": pid, "role": role,
                        "text": text, "created_at": "2026-01-01T00:00:00Z"})
    return ST.nxt_msg


def viet_env(thu_muc, port, email, password):
    """Ghi .env vào thư mục tmp — cố tình có dòng #, dòng trống, quotes, inline comment
    để đồng thời test bộ parse .env của client (login thành công = parse đúng)."""
    env = Path(thu_muc) / ".env"
    env.write_text(
        "# comment đầu file\n"
        "\n"
        f"SUPABASE_URL=http://127.0.0.1:{port}\n"
        f'SUPABASE_ANON_KEY="{ST.anon}"\n'
        f"MUSE_EMAIL={email}\n"
        f"MUSE_PASSWORD='{password}'\n"
        "CAPABILITIES=chat\n"
        "POLL_INTERVAL=2   # giây poll\n",
        encoding="utf-8")
    return env


def chay_client(thu_muc, env_path, them=()):
    return subprocess.run([sys.executable, str(KHACH), "--env", str(env_path), *them],
                          cwd=str(thu_muc), capture_output=True, text=True, timeout=60)


# ---------- các case ----------

def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    tmp_goc = Path(tempfile.mkdtemp(prefix="muse_mock_"))
    try:
        # ---- dữ liệu mock: user + project #10 + thread #100 + 2 tin user + 1 echo muse
        pw = "Tr0ngBan!-mock"
        email = "muse_mock@muserelay.local"
        us = tao_mock_user(email, pw, "muse_mock", "Muse Mock")
        id1 = tao_tin(us["tid"], us["pid"], "user", "tin thu nhat")
        tao_tin(us["tid"], us["pid"], "muse", "echo cua muse - phai bo qua")
        id3 = tao_tin(us["tid"], us["pid"], "user", "tin thu hai")

        # ---- CASE 1–4: 1 lượt --once (banner + inbox + cursor + outbox POST + xóa file)
        tmp1 = tmp_goc / "case_ok"
        tmp1.mkdir()
        (tmp1 / "outbox").mkdir()
        (tmp1 / "outbox" / f"{us['tid']}.txt").write_text("day la reply tu outbox", encoding="utf-8")
        env1 = viet_env(tmp1, port, email, pw)
        cp = chay_client(tmp1, env1, ("--once",))
        out, err = cp.stdout, cp.stderr
        banner = f"[#{us['pid']}] muse_mock (Muse Mock) đang nghe — tags=chat — cursor=0"
        kt("CASE 1: client chạy sạch (exit 0) + banner khởi động đúng §5",
           cp.returncode == 0 and banner in out,
           f"rc={cp.returncode} out={out!r} err={err!r}")

        inbox = tmp1 / "state" / "inbox.jsonl"
        dong = [json.loads(x) for x in inbox.read_text(encoding="utf-8").splitlines()] if inbox.exists() else []
        kt("CASE 2: inbox.jsonl đủ 2 tin user đúng thứ tự id.asc, echo role='muse' bị bỏ qua",
           [d.get("id") for d in dong] == [id1, id3]
           and all(d.get("role") == "user" for d in dong)
           and all(set(d) == {"id", "thread_id", "role", "text", "created_at"} for d in dong)
           and dong[0]["text"] == "tin thu nhat" and dong[1]["text"] == "tin thu hai"
           and all(d["thread_id"] == us["tid"] for d in dong),
           f"dong={dong!r}")

        cursor = tmp1 / "state" / "cursor.json"
        try:
            sau = json.loads(cursor.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001 — hiển thị lỗi parse trong chi tiết case
            sau = {"_loi": str(e)}
        kt("CASE 3: cursor.json = {'after': <id tin lớn nhất>}, ghi sau khi append (atomic)",
           sau == {"after": id3},
           f"cursor={sau!r} id1={id1} id3={id3}")

        posts = list(ST.posts)
        bai = tmp1 / "outbox" / f"{us['tid']}.txt"
        kt("CASE 4: outbox → POST đúng thread/project/role='muse'/text + Prefer return=minimal → file bị xóa",
           len(posts) == 1
           and posts[0][0].get("thread_id") == us["tid"]
           and posts[0][0].get("project_id") == us["pid"]
           and posts[0][0].get("role") == "muse"
           and posts[0][0].get("text") == "day la reply tu outbox"
           and "return=minimal" in posts[0][1]
           and not bai.exists(),
           f"posts={posts!r} file_con={bai.exists()} err={err!r}")

        # ---- CASE 5: POST trả 400 (4xx ≠ 401) → file đổi tên .err, KHÔNG retry
        tmp5 = tmp_goc / "case_400"
        tmp5.mkdir()
        (tmp5 / "outbox").mkdir()
        (tmp5 / "outbox" / f"{us['tid']}.txt").write_text("reply bi tu choi 400", encoding="utf-8")
        env5 = viet_env(tmp5, port, email, pw)
        truoc5 = len(ST.posts)
        ST.reject_post = True
        cp5 = chay_client(tmp5, env5, ("--once",))
        ST.reject_post = False
        err_f = tmp5 / "outbox" / f"{us['tid']}.txt.err"
        goc_f = tmp5 / "outbox" / f"{us['tid']}.txt"
        kt("CASE 5: reply bị 400 (4xx≠401) → đổi tên .err, không retry (đúng 1 POST)",
           cp5.returncode == 0 and err_f.exists() and not goc_f.exists()
           and len(ST.posts) - truoc5 == 1,
           f"rc={cp5.returncode} file_err={err_f.exists()} goc_con={goc_f.exists()} "
           f"posts+={len(ST.posts) - truoc5} out={cp5.stdout!r} err={cp5.stderr!r}")

        # ---- CASE 6: stdout/stderr của client không chứa password/anon key
        tat_ca_out = out + err + cp5.stdout + cp5.stderr
        kt("CASE 6: client KHÔNG in secret (password/anon key) ra stdout/stderr",
           pw not in tat_ca_out and ST.anon not in tat_ca_out,
           f"out={tat_ca_out!r}")

        # ---- CASE 7: POST lần đầu 500 → client backoff, chu kỳ kế retry → lần 2 OK, file chỉ xóa khi OK
        tmp7 = tmp_goc / "case_500"
        tmp7.mkdir()
        (tmp7 / "outbox").mkdir()
        (tmp7 / "outbox" / f"{us['tid']}.txt").write_text("reply thu sau khi 500", encoding="utf-8")
        env7 = viet_env(tmp7, port, email, pw)
        truoc7 = len(ST.posts)
        ST.fail_next_post = 1
        proc = subprocess.Popen([sys.executable, str(KHACH), "--env", str(env7)],
                                cwd=str(tmp7), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        het_file = False
        moc = time.monotonic() + 30
        while time.monotonic() < moc:
            if not (tmp7 / "outbox" / f"{us['tid']}.txt").exists():
                het_file = True
                break
            time.sleep(0.2)
        proc.terminate()
        try:
            out7, err7 = proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            out7, err7 = proc.communicate()
        so_post = len(ST.posts) - truoc7
        kt("CASE 7: POST 500 lần đầu → client retry chu kỳ kế → lần 2 OK → file chỉ xóa sau khi OK",
           het_file and so_post == 2 and ST.posts[-1][0].get("text") == "reply thu sau khi 500",
           f"het_file={het_file} posts+={so_post} out={out7!r} err={err7!r}")

        tat_ca_out += out7 + err7
        kt("CASE 8: tổng hợp — không secret trong toàn bộ output của mọi lần chạy client",
           pw not in tat_ca_out and ST.anon not in tat_ca_out)

        # ---- tổng kết
        tot, ok = len(KET_QUA), sum(KET_QUA)
        print()
        print(f"KẾT QUẢ: {ok}/{tot} case PASS — " + ("TẤT CẢ PASS" if ok == tot else "THẤT BẠI"))
        return 0 if ok == tot else 1
    finally:
        shutil.rmtree(tmp_goc, ignore_errors=True)
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    sys.exit(main())
