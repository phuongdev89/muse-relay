"""Smoke test end-to-end cho Muse Relay.

Chạy server trước rồi:

    uvicorn server:app --port 8765
    python smoke_test.py http://127.0.0.1:8765 [--admin-token <token>]

Không truyền --admin-token thì đọc token từ data/admin_token.txt (server tự sinh).
"""
import secrets
import sys
import threading
import time
from pathlib import Path

import requests

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000").rstrip("/")
ADMIN = None
for i, a in enumerate(sys.argv):
    if a == "--admin-token":
        ADMIN = sys.argv[i + 1]
if not ADMIN:
    ADMIN = (Path(__file__).resolve().parent / "data" / "admin_token.txt").read_text().strip()

AH = {"Authorization": "Bearer " + ADMIN}
FAILS = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (f" — {extra}" if extra and not cond else ""))
    if not cond:
        FAILS.append(name)


muse_id = "muse_test_" + secrets.token_hex(4)
r = requests.post(f"{BASE}/api/conversations", headers=AH, json={"muse_id": muse_id, "name": "Muse Test"})
check("tạo hội thoại", r.status_code == 200, r.text)
conv = r.json()
MH = {"Authorization": "Bearer " + conv["token"]}

r = requests.get(f"{BASE}/api/me", headers=MH)
check("/api/me", r.status_code == 200 and r.json()["muse_id"] == muse_id, r.text)

r = requests.post(f"{BASE}/api/messages", headers=AH, json={"conversation_id": conv["id"], "text": "xin chào Muse"})
check("admin gửi tin", r.status_code == 200, r.text)

r = requests.get(f"{BASE}/api/poll", headers=MH, params={"after": 0, "wait": 5})
msgs = r.json()["messages"]
check("muse poll nhận tin", any(m["text"] == "xin chào Muse" for m in msgs), r.text)

r = requests.post(f"{BASE}/api/reply", headers=MH, json={"text": "chào anh!"})
check("muse reply", r.status_code == 200, r.text)

r = requests.get(f"{BASE}/api/messages", headers=AH, params={"conversation_id": conv["id"]})
texts = [(m["role"], m["text"]) for m in r.json()["messages"]]
check("admin đọc đủ 2 chiều", ("user", "xin chào Muse") in texts and ("muse", "chào anh!") in texts, r.text)

# long-poll: đang giữ kết nối thì có tin phải trả gần như ngay
# lấy đúng mốc id mới nhất hiện tại để poller chỉ đợi tin phát sinh sau này
r0 = requests.get(f"{BASE}/api/poll", headers=MH, params={"after": 0, "wait": 0})
base_after = r0.json()["messages"][-1]["id"]

t0 = time.monotonic()
holder = {}


def poller():
    rr = requests.get(f"{BASE}/api/poll", headers=MH, params={"after": base_after, "wait": 8})
    holder["t"] = time.monotonic() - t0
    holder["msgs"] = rr.json()["messages"]


th = threading.Thread(target=poller)
th.start()
time.sleep(1)
requests.post(f"{BASE}/api/messages", headers=AH, json={"conversation_id": conv["id"], "text": "long-poll ok"})
th.join(timeout=15)
check("long-poll trả ngay khi có tin (<4s)", holder.get("t", 99) < 4, f"took {holder.get('t'):.2f}s" if "t" in holder else "no result")
check("long-poll có tin mới", any(m["text"] == "long-poll ok" for m in holder.get("msgs", [])))

# 50 poller đồng thời trong ~6s đều phải nhận tin
got = [False] * 50
stop = time.monotonic() + 6


def worker(i):
    after = base_after
    while time.monotonic() < stop and not got[i]:
        try:
            rr = requests.get(f"{BASE}/api/poll", headers=MH, params={"after": after, "wait": 3})
            for m in rr.json()["messages"]:
                after = m["id"]
                if m["text"] == "load ok":
                    got[i] = True
        except requests.RequestException:
            time.sleep(0.5)


ths = [threading.Thread(target=worker, args=(i,)) for i in range(50)]
for t in ths:
    t.start()
time.sleep(1)
for _ in range(3):
    requests.post(f"{BASE}/api/messages", headers=AH, json={"conversation_id": conv["id"], "text": "load ok"})
    time.sleep(0.2)
for t in ths:
    t.join()
check("50 poller đồng thời đều nhận tin", all(got), f"{sum(got)}/50")

r = requests.get(f"{BASE}/api/poll", headers={"Authorization": "Bearer sai"})
check("token sai bị chặn 401", r.status_code == 401)

# dọn dữ liệu test
try:
    from server import db

    with db() as c:
        c.execute("DELETE FROM messages WHERE conversation_id = ?", (conv["id"],))
        c.execute("DELETE FROM conversations WHERE id = ?", (conv["id"],))
    print("đã dọn dữ liệu test")
except Exception as e:
    print(f"(không dọn được dữ liệu test: {e})")

print("TẤT CẢ PASS" if not FAILS else "THẤT BẠI: " + ", ".join(FAILS))
sys.exit(1 if FAILS else 0)
