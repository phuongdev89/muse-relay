"""Client chạy trên máy của mỗi account Muse.

Mỗi account Muse chỉ cần URL server + token riêng (manage.py add in ra):

    pip install requests
    python muse_client.py --url https://relay.example.com --token <TOKEN>

Sửa hàm handle() để Muse xử lý tin nhắn theo cách của nó. Cursor tin đã đọc
được lưu vào file (mặc định muse_cursor.json) nên restart không xử lý lại tin cũ.
"""
import argparse
import json
import sys
import time
from pathlib import Path

import requests


def handle(text: str, msg: dict) -> str:
    """Muse xử lý tin nhắn ở đây và trả về chuỗi reply."""
    return f"[Muse nhận được]: {text}"


def main():
    ap = argparse.ArgumentParser(description="Muse Relay client")
    ap.add_argument("--url", required=True, help="URL server, vd https://relay.example.com")
    ap.add_argument("--token", required=True, help="token của account Muse này")
    ap.add_argument("--wait", type=int, default=25, help="số giây giữ kết nối long-poll")
    ap.add_argument("--state", default="muse_cursor.json", help="file lưu cursor tin đã đọc")
    args = ap.parse_args()

    base = args.url.rstrip("/")
    hdr = {"Authorization": f"Bearer {args.token}"}
    state = Path(args.state)
    after = 0
    if state.exists():
        try:
            after = int(json.loads(state.read_text()).get("after", 0))
        except (ValueError, TypeError):
            after = 0

    try:
        me = requests.get(f"{base}/api/me", headers=hdr, timeout=15)
        me.raise_for_status()
        info = me.json()
        print(f"[muse] #{info['conversation_id']} {info['muse_id']} ({info['name']}) — đang nghe, cursor={after}")
    except requests.RequestException as e:
        sys.exit(f"[muse] không kết nối được server: {e}")

    while True:
        try:
            r = requests.get(
                f"{base}/api/poll",
                headers=hdr,
                params={"after": after, "wait": args.wait},
                timeout=args.wait + 15,
            )
            r.raise_for_status()
            for m in r.json()["messages"]:
                after = max(after, m["id"])
                state.write_text(json.dumps({"after": after}))
                if m["role"] == "user":
                    reply = handle(m["text"], m)
                    requests.post(
                        f"{base}/api/reply", headers=hdr, json={"text": reply}, timeout=15
                    ).raise_for_status()
                    print(f"[muse] trả lời: {reply[:100]}")
        except requests.RequestException as e:
            print(f"[muse] lỗi mạng: {e} — thử lại sau 5s", file=sys.stderr)
            time.sleep(5)


if __name__ == "__main__":
    main()
