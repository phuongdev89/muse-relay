"""Muse Relay v2 — client chạy nền trên máy Muse (poll Supabase, giao thức inbox/outbox).

Tin mới (role='user') được append vào state/inbox.jsonl — Muse đọc file này để xử lý
rồi ghi reply vào outbox/<thread_id>.txt; client tự POST reply về Supabase và xóa file.
Cursor tin đã đọc lưu state/cursor.json (ghi atomic) nên restart không xử lý lại tin cũ.

Cách chạy:
    pip install requests
    python3 muse_client.py                    # đọc .env ở thư mục hiện tại
    python3 muse_client.py --env /path/.env   # .env nằm chỗ khác
    python3 muse_client.py --once             # poll 1 lượt + đẩy outbox rồi thoát (cho cron)

.env gồm: SUPABASE_URL, SUPABASE_ANON_KEY, MUSE_EMAIL, MUSE_PASSWORD,
CAPABILITIES, POLL_INTERVAL (giây, tối thiểu 2). KHÔNG in secret ra stdout.
"""
import argparse
import json
import os
import random
import sys
import time
from pathlib import Path

import requests

TIMEOUT = 30  # giây cho 1 lần gọi HTTP


class LoiTamThoi(Exception):
    """Lỗi tạm thời (mạng/5xx/429) — backoff rồi thử lại, không thoát chương trình."""


# ---------- cấu hình ----------

def doc_env(duong_dan):
    """Đọc file .env: bỏ dòng trống, dòng #; tách key=value; bỏ quotes; bỏ comment cuối dòng."""
    if not duong_dan.exists():
        sys.exit(f"[muse] không thấy file .env tại {duong_dan}")
    env = {}
    for line in duong_dan.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]  # giá trị bọc quotes → lấy nguyên văn (password có thể chứa ký tự lạ)
        elif " #" in val:
            val = val.split(" #", 1)[0].strip()  # comment cuối dòng kiểu env.template
        env[key.strip()] = val
    return env


def nghi_backoff(cfg, ly_do):
    """Backoff lỗi tạm thời: 1→2→4→...→60s; reset về 1 khi thành công (§5)."""
    print(f"[muse] {ly_do} — thử lại sau {cfg['backoff']}s", file=sys.stderr)
    time.sleep(cfg["backoff"])
    cfg["backoff"] = min(cfg["backoff"] * 2, 60)


def dat_lai_backoff(cfg):
    cfg["backoff"] = 1


# ---------- Supabase ----------

def hdr_rest(cfg, token):
    return {"apikey": cfg["anon"], "Authorization": f"Bearer {token}"}


def dang_nhap(cfg):
    """POST /auth/v1/token?grant_type=password → (access_token, user.id). Sai thông tin → thoát."""
    while True:
        try:
            r = requests.post(
                f"{cfg['url']}/auth/v1/token?grant_type=password",
                headers={"apikey": cfg["anon"]},
                json={"email": cfg["email"], "password": cfg["password"]},
                timeout=TIMEOUT,
            )
        except requests.RequestException as e:
            nghi_backoff(cfg, f"lỗi mạng khi đăng nhập: {e}")
            continue
        if r.status_code == 429 or r.status_code >= 500:
            nghi_backoff(cfg, f"đăng nhập bị HTTP {r.status_code}")
            continue
        if r.status_code != 200:
            sys.exit(f"[muse] đăng nhập thất bại (HTTP {r.status_code}) — kiểm tra MUSE_EMAIL/MUSE_PASSWORD trong .env")
        d = r.json()
        dat_lai_backoff(cfg)
        print("[muse] đăng nhập OK")
        return d["access_token"], d["user"]["id"]


def lay_project(cfg, ses):
    """GET projects?user_id=eq.{uid} — RLS chỉ trả project của Muse mình."""
    while True:
        try:
            r = requests.get(
                f"{cfg['url']}/rest/v1/projects?select=id,muse_id,name,tags,email&user_id=eq.{ses['uid']}",
                headers=hdr_rest(cfg, ses["token"]),
                timeout=TIMEOUT,
            )
        except requests.RequestException as e:
            nghi_backoff(cfg, f"lỗi mạng khi lấy project: {e}")
            continue
        if r.status_code == 200:
            ds = r.json()
            dat_lai_backoff(cfg)
            return ds[0] if ds else None
        if r.status_code == 401:
            print("[muse] token bị từ chối khi lấy project — đăng nhập lại")
            ses["token"], ses["uid"] = dang_nhap(cfg)
            continue
        if r.status_code == 429 or r.status_code >= 500:
            nghi_backoff(cfg, f"lấy project bị HTTP {r.status_code}")
            continue
        sys.exit(f"[muse] lấy project thất bại (HTTP {r.status_code}): {r.text[:200]}")


def poll_status(cfg, ses, r, ten):
    """Xử lý status của GET poll: 200 → True; 401 → đăng nhập lại → False (chu kỳ kế poll tiếp);
    5xx/429 → LoiTamThoi; 4xx khác → lỗi cấu hình, thoát."""
    if r.status_code == 200:
        return True
    if r.status_code == 401:
        print(f"[muse] token hết hạn khi {ten} — đăng nhập lại, chu kỳ kế chạy tiếp")
        ses["token"], ses["uid"] = dang_nhap(cfg)
        return False
    if r.status_code == 429 or r.status_code >= 500:
        raise LoiTamThoi(f"{ten} bị HTTP {r.status_code}")
    sys.exit(f"[muse] {ten} thất bại (HTTP {r.status_code}): {r.text[:200]} — kiểm tra cấu hình")


def goi_get(cfg, ses, url, ten):
    """GET REST; lỗi mạng nâng LoiTamThoi cho chu kỳ xử lý."""
    try:
        return requests.get(url, headers=hdr_rest(cfg, ses["token"]), timeout=TIMEOUT)
    except requests.RequestException as e:
        raise LoiTamThoi(f"lỗi mạng khi {ten}: {e}") from None


# ---------- inbox / cursor (§5 bước 1–3) ----------

def doc_cursor(cfg):
    """Đọc {"after": N} từ state/cursor.json cũ; hỏng thì bắt đầu lại từ 0."""
    f = cfg["state_dir"] / "cursor.json"
    if f.exists():
        try:
            return int(json.loads(f.read_text(encoding="utf-8"))["after"])
        except (ValueError, KeyError, TypeError):
            print("[muse] cursor.json hỏng — bắt đầu lại từ 0")
    return 0


def ghi_cursor(cfg, n):
    """Ghi state/cursor.json atomically (tmp + rename). Muse CẤM sửa file này."""
    tmp = cfg["state_dir"] / "cursor.json.tmp"
    tmp.write_text(json.dumps({"after": n}), encoding="utf-8")
    os.replace(tmp, cfg["state_dir"] / "cursor.json")


def lay_tin(cfg, ses):
    """§5 bước 1–3: threads → messages mới (id>cursor) → inbox.jsonl (chỉ role='user') → cursor atomic."""
    r = goi_get(cfg, ses, f"{cfg['url']}/rest/v1/threads?select=id&project_id=eq.{cfg['pid']}", "lấy threads")
    if not poll_status(cfg, ses, r, "lấy threads"):
        return
    ids = ",".join(str(t["id"]) for t in r.json())
    if not ids:
        return
    r = goi_get(
        cfg, ses,
        f"{cfg['url']}/rest/v1/messages?select=id,thread_id,role,text,created_at"
        f"&thread_id=in.({ids})&id=gt.{cfg['cursor']}&order=id.asc&limit=500",
        "poll messages",
    )
    if not poll_status(cfg, ses, r, "poll messages"):
        return
    tin = r.json()
    if not tin:
        return
    # bước 2: role='user' → append JSONL vào inbox; role='muse' là echo của mình → bỏ qua
    with (cfg["state_dir"] / "inbox.jsonl").open("a", encoding="utf-8") as f:
        for m in tin:
            if m.get("role") == "user":
                f.write(json.dumps(
                    {"id": m["id"], "thread_id": m["thread_id"], "role": "user",
                     "text": m["text"], "created_at": m["created_at"]},
                    ensure_ascii=False) + "\n")
    # bước 3: cursor = id lớn nhất thấy được — ghi atomically SAU khi append
    cfg["cursor"] = max(cfg["cursor"], max(m["id"] for m in tin))
    ghi_cursor(cfg, cfg["cursor"])
    print(f"[muse] nhận {sum(1 for m in tin if m.get('role') == 'user')} tin user → inbox, cursor={cfg['cursor']}")


# ---------- outbox (§5 bước 4) ----------

def post_reply(cfg, ses, tid, text):
    """POST /rest/v1/messages role='muse' + Prefer: return=minimal (§3)."""
    hdr = hdr_rest(cfg, ses["token"])
    hdr["Prefer"] = "return=minimal"
    body = {"thread_id": tid, "project_id": cfg["pid"], "role": "muse", "text": text}
    try:
        return requests.post(f"{cfg['url']}/rest/v1/messages", headers=hdr, json=body, timeout=TIMEOUT)
    except requests.RequestException as e:
        raise LoiTamThoi(f"lỗi mạng khi gửi reply thread {tid}: {e}") from None


def day_outbox(cfg, ses):
    """§5 bước 4: outbox/<thread_id>.txt sắp theo mtime → POST → xóa file.
    4xx≠401 → đổi tên .err (không retry vô hạn); 401 → đăng nhập lại thử 1 lần;
    mạng/5xx/429 → giữ file, dừng vòng outbox, backoff."""
    files = sorted(cfg["outbox_dir"].glob("*.txt"), key=os.path.getmtime)
    for f in files:
        if not f.stem.isdigit():
            print(f"[muse] bỏ qua outbox/{f.name} — tên phải là <thread_id>.txt")
            continue
        text = f.read_text(encoding="utf-8").strip()
        if not text:
            print(f"[muse] outbox/{f.name} rỗng — bỏ")
            f.unlink()
            continue
        tid = int(f.stem)
        r = post_reply(cfg, ses, tid, text)
        if r.status_code == 401:
            print(f"[muse] token hết hạn khi gửi reply thread {tid} — đăng nhập lại, thử lại 1 lần")
            ses["token"], ses["uid"] = dang_nhap(cfg)
            r = post_reply(cfg, ses, tid, text)
        if r.status_code == 201:
            f.unlink()
            print(f"[muse] đã gửi reply thread {tid} — xóa outbox/{f.name}")
        elif 400 <= r.status_code < 500:
            err = cfg["outbox_dir"] / (f.name + ".err")
            f.rename(err)
            print(f"[muse] reply thread {tid} bị từ chối (HTTP {r.status_code}) — đổi tên {err.name}, không retry")
        else:  # 429/5xx → tạm thời, giữ file dừng vòng
            raise LoiTamThoi(f"gửi reply thread {tid} bị HTTP {r.status_code}")


def chu_ky(cfg, ses):
    """1 chu kỳ: poll tin mới → đẩy outbox. Lỗi tạm thời → backoff, giữ nguyên trạng thái."""
    try:
        lay_tin(cfg, ses)
        day_outbox(cfg, ses)
    except LoiTamThoi as e:
        nghi_backoff(cfg, str(e))
        return
    dat_lai_backoff(cfg)


# ---------- main ----------

def chay(cfg, once):
    """Khởi động: login → lấy project → banner → vòng lặp poll (± jitter)."""
    cfg["state_dir"].mkdir(parents=True, exist_ok=True)
    cfg["outbox_dir"].mkdir(parents=True, exist_ok=True)
    ses = {"token": "", "uid": ""}
    ses["token"], ses["uid"] = dang_nhap(cfg)
    pr = lay_project(cfg, ses)
    if not pr:
        sys.exit("[muse] không thấy project nào cho user này — admin chưa tạo Muse?")
    cfg["pid"] = pr["id"]
    cfg["cursor"] = doc_cursor(cfg)
    tags = ",".join(pr.get("tags") or [])
    print(f"[#{pr['id']}] {pr['muse_id']} ({pr['name']}) đang nghe — tags={tags} — cursor={cfg['cursor']}")
    while True:
        chu_ky(cfg, ses)
        if once:
            print("[muse] --once: xong 1 lượt — thoát")
            return
        time.sleep(max(2.0, cfg["interval"] + random.uniform(-0.5, 0.5)))  # ± jitter ≤0.5s, không nhanh hơn 2s


def main():
    ap = argparse.ArgumentParser(description="Muse Relay v2 client — poll Supabase, inbox/outbox cho Muse")
    ap.add_argument("--env", default=".env", help="đường dẫn file .env (mặc định .env)")
    ap.add_argument("--once", action="store_true", help="poll 1 lượt + đẩy outbox rồi thoát (cho cron)")
    args = ap.parse_args()

    env = doc_env(Path(args.env))
    cfg = {
        "url": env.get("SUPABASE_URL", "").rstrip("/"),
        "anon": env.get("SUPABASE_ANON_KEY", ""),
        "email": env.get("MUSE_EMAIL", ""),
        "password": env.get("MUSE_PASSWORD", ""),
        "backoff": 1,
        "state_dir": Path("state"),
        "outbox_dir": Path("outbox"),
    }
    for k, ten in (("url", "SUPABASE_URL"), ("anon", "SUPABASE_ANON_KEY"),
                   ("email", "MUSE_EMAIL"), ("password", "MUSE_PASSWORD")):
        if not cfg[k]:
            sys.exit(f"[muse] thiếu {ten} trong {args.env} — Muse mở form cho owner điền trực tiếp vào file rồi chạy lại")
    try:
        interval = int(str(env.get("POLL_INTERVAL", "") or 3))
    except ValueError:
        interval = 3
    if interval < 2:
        print("[muse] POLL_INTERVAL < 2 — nâng lên 2 (giới hạn tối thiểu)")
        interval = 2
    cfg["interval"] = interval

    try:
        chay(cfg, args.once)
    except KeyboardInterrupt:
        print("\n[muse] nhận Ctrl+C — thoát sạch, hẹn gặp lại")


if __name__ == "__main__":
    main()
