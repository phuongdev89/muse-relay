"""CLI quản lý account Muse của Muse Relay (chạy cùng nơi với server).

    python manage.py add <muse_id> [tên]   tạo account, in token
    python manage.py list                  danh sách account
    python manage.py token <muse_id>       xem lại token
    python manage.py rm <muse_id>          xóa account + tin nhắn của nó
"""
import argparse
import secrets
import sys

from server import db


def cmd_add(a):
    with db() as c:
        if c.execute("SELECT 1 FROM conversations WHERE muse_id = ?", (a.muse_id,)).fetchone():
            sys.exit(f"muse_id '{a.muse_id}' đã tồn tại")
        token = "muse_" + secrets.token_urlsafe(24)
        c.execute(
            "INSERT INTO conversations(muse_id, name, token) VALUES(?, ?, ?)",
            (a.muse_id, a.name, token),
        )
    print(f"Đã tạo '{a.name}' ({a.muse_id})")
    print(f"TOKEN: {token}")
    print(f"Muse chạy: python muse_client.py --url <URL server> --token {token}")


def cmd_list(_):
    with db() as c:
        rows = c.execute(
            "SELECT id, muse_id, name, created_at FROM conversations ORDER BY id"
        ).fetchall()
    for r in rows:
        print(f"#{r['id']:>4}  {r['muse_id']:<28} {r['name']:<32} tạo {r['created_at']}")
    print(f"Tổng: {len(rows)} account")


def cmd_token(a):
    with db() as c:
        row = c.execute(
            "SELECT name, token FROM conversations WHERE muse_id = ?", (a.muse_id,)
        ).fetchone()
    if row is None:
        sys.exit("Không tìm thấy muse_id này")
    print(f"{row['name']}: {row['token']}")


def cmd_rm(a):
    with db() as c:
        row = c.execute("SELECT id FROM conversations WHERE muse_id = ?", (a.muse_id,)).fetchone()
        if row is None:
            sys.exit("Không tìm thấy muse_id này")
        c.execute("DELETE FROM messages WHERE conversation_id = ?", (row["id"],))
        c.execute("DELETE FROM conversations WHERE id = ?", (row["id"],))
    print(f"Đã xóa {a.muse_id} cùng toàn bộ tin nhắn")


def main():
    ap = argparse.ArgumentParser(description="Quản lý account Muse")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("add")
    p.add_argument("muse_id")
    p.add_argument("name", nargs="?", default=None)
    p.set_defaults(fn=cmd_add)

    p = sub.add_parser("list")
    p.set_defaults(fn=cmd_list)

    p = sub.add_parser("token")
    p.add_argument("muse_id")
    p.set_defaults(fn=cmd_token)

    p = sub.add_parser("rm")
    p.add_argument("muse_id")
    p.set_defaults(fn=cmd_rm)

    a = ap.parse_args()
    if a.cmd == "add" and not a.name:
        a.name = a.muse_id
    a.fn(a)


if __name__ == "__main__":
    main()
