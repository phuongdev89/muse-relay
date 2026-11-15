"""Smoke test THẬT cho Muse Relay v2 trên Supabase (KHÁC với smoke_test.py bản cũ ở root).

Kiểm tra end-to-end theo spec §2/§3: service key, tạo/xóa muse tạm qua admin,
login Muse bằng anon key, RLS cách ly giữa 2 muse (B KHÔNG đọc được tin của A,
KHÔNG ghi được vào thread của A), reply role='muse', dọn dẹp dữ liệu test trong finally.

Cách chạy (1 trong 3 cách — ưu tiên theo thứ tự):
    python3 web/smoke_test.py --url <URL> --anon <ANON> --service <SERVICE>
    SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_KEY=... python3 web/smoke_test.py
    python3 web/smoke_test.py        # tự đọc /mnt/d/AI/muse-relay/.cache/supabase.env

Key có thể là legacy JWT (anon/service_role) hoặc dạng mới sb_publishable_/sb_secret_
— code chỉ truyền chuỗi vào header, KHÔNG decode, KHÔNG in key/password ra stdout.
"""
import argparse
import os
import random
import secrets
import string
import sys
from pathlib import Path

import requests

ENV_CACHE = Path("/mnt/d/AI/muse-relay/.cache/supabase.env")
FAILS = []


def check(ten, ok, extra=""):
    print(("PASS " if ok else "FAIL ") + ten + (f" — {extra}" if extra and not ok else ""))
    if not ok:
        FAILS.append(ten)


def doc_env(duong_dan):
    """Đọc file .env kiểu KEY=VALUE (bỏ dòng #, dòng trống; bỏ quotes)."""
    env = {}
    for line in duong_dan.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        env[k.strip()] = v
    return env


def lay_keys():
    """Lấy URL/anon/service từ argv → env → .cache/supabase.env."""
    ap = argparse.ArgumentParser(description="Smoke test Muse Relay v2 trên Supabase thật")
    ap.add_argument("--url", help="SUPABASE_URL, vd https://xxxx.supabase.co")
    ap.add_argument("--anon", help="SUPABASE_ANON_KEY (legacy JWT hoặc sb_publishable_)")
    ap.add_argument("--service", help="SERVICE_KEY (legacy JWT hoặc sb_secret_)")
    a = ap.parse_args()
    url = a.url or os.environ.get("SUPABASE_URL", "")
    anon = a.anon or os.environ.get("SUPABASE_ANON_KEY", "")
    service = a.service or os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not (url and anon and service) and ENV_CACHE.exists():
        env = doc_env(ENV_CACHE)
        url = url or env.get("SUPABASE_URL", "")
        anon = anon or env.get("SUPABASE_ANON_KEY", "")
        service = service or env.get("SUPABASE_SERVICE_KEY", "")
    if not (url and anon and service):
        sys.exit("[smoke] thiếu key — truyền --url/--anon/--service, hoặc env, hoặc để sẵn .cache/supabase.env")
    return url.rstrip("/"), anon, service


# ---------- header chuẩn §3 ----------

def h_service(service):
    return {"apikey": service, "Authorization": f"Bearer {service}", "Content-Type": "application/json"}


def h_anon(anon, token=None):
    h = {"apikey": anon, "Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


# ---------- tạo / dọn muse tạm ----------

def tao_muse(url, service, rand, ten):
    """Tạo muse tạm: admin user → project row (tags=['chat']) → thread đầu tiên.
    Không raise — trả dict kèm field 'loi' để finally vẫn dọn được phần đã tạo."""
    d = {"muse_id": f"smoke_{rand}", "email": f"muse_smoke_{rand}@muserelay.local",
         "pwd": secrets.token_urlsafe(18), "uid": None, "pid": None, "tid": None, "loi": None}
    r = requests.post(f"{url}/auth/v1/admin/users", headers=h_service(service),
                      json={"email": d["email"], "password": d["pwd"], "email_confirm": True}, timeout=30)
    if r.status_code not in (200, 201):
        d["loi"] = f"tạo admin user thất bại (HTTP {r.status_code}): {r.text[:300]}"
        return d
    d["uid"] = r.json()["id"]
    r = requests.post(f"{url}/rest/v1/projects",
                      headers={**h_service(service), "Prefer": "return=representation"},
                      json={"muse_id": d["muse_id"], "name": ten, "tags": ["chat"],
                            "user_id": d["uid"], "email": d["email"], "secret": d["pwd"]}, timeout=30)
    if r.status_code not in (200, 201):
        d["loi"] = f"tạo project thất bại (HTTP {r.status_code}): {r.text[:300]}"
        return d
    d["pid"] = r.json()[0]["id"]
    r = requests.post(f"{url}/rest/v1/threads",
                      headers={**h_service(service), "Prefer": "return=representation"},
                      json={"project_id": d["pid"], "title": f"smoke thread {rand}"}, timeout=30)
    if r.status_code not in (200, 201):
        d["loi"] = f"tạo thread thất bại (HTTP {r.status_code}): {r.text[:300]}"
        return d
    d["tid"] = r.json()[0]["id"]
    return d


def xoa_muse(url, service, d):
    """Dọn muse tạm: xóa project row (cascade threads/messages) + xóa admin user."""
    loi = []
    if d.get("pid"):
        r = requests.request("DELETE", f"{url}/rest/v1/projects?id=eq.{d['pid']}", headers=h_service(service), timeout=30)
        if r.status_code not in (200, 204, 404):
            loi.append(f"project HTTP {r.status_code}")
    if d.get("uid"):
        r = requests.request("DELETE", f"{url}/auth/v1/admin/users/{d['uid']}", headers=h_service(service), timeout=30)
        if r.status_code not in (200, 204, 404):
            loi.append(f"user HTTP {r.status_code}")
    return loi


def login_muse(url, anon, d):
    """Login muse bằng anon key + password → (access_token, uid) hoặc (None, None)."""
    r = requests.post(f"{url}/auth/v1/token?grant_type=password", headers=h_anon(anon),
                      json={"email": d["email"], "password": d["pwd"]}, timeout=30)
    if r.status_code == 200 and r.json().get("access_token"):
        return r.json()["access_token"], r.json()["user"]["id"]
    check(f"{d['muse_id']}: login grant_type=password", False, f"HTTP {r.status_code}")
    return None, None


# ---------- kịch bản smoke ----------

def main():
    url, anon, service = lay_keys()
    rand_a = "".join(random.choices(string.ascii_lowercase + string.digits, k=12))
    A = B = None
    try:
        # (1) service key đọc được project (bypass RLS)
        r = requests.get(f"{url}/rest/v1/projects?select=id&limit=1", headers=h_service(service), timeout=30)
        check("1. service key GET projects → 200", r.status_code == 200, f"HTTP {r.status_code}")

        # (2) tạo muse tạm A: admin user + project (tags=['chat']) + thread
        A = tao_muse(url, service, rand_a, "Muse Smoke A")
        check("2. tạo muse tạm A (admin user + project + thread)", not A["loi"], A["loi"] or "")
        if A["loi"]:
            return

        # (3) A login bằng anon key + password
        tok_a, uid_a = login_muse(url, anon, A)
        check("3. muse A login → có access_token", bool(tok_a))
        if not tok_a:
            return

        # (4) A GET projects?user_id=eq.<uid> — RLS chỉ cho thấy đúng project của mình
        r = requests.get(f"{url}/rest/v1/projects?select=id,muse_id&user_id=eq.{uid_a}",
                         headers=h_anon(anon, tok_a), timeout=30)
        ds = r.json() if r.status_code == 200 else []
        check("4. A GET projects (RLS) → thấy đúng 1 project của mình",
              r.status_code == 200 and len(ds) == 1 and ds and ds[0]["id"] == A["pid"],
              f"HTTP {r.status_code} ds={ds}")

        # (5) admin gửi tin role='user' vào thread A
        r = requests.post(f"{url}/rest/v1/messages", headers=h_service(service),
                          json={"thread_id": A["tid"], "project_id": A["pid"], "role": "user",
                                "text": "xin chào muse smoke A"}, timeout=30)
        check("5. admin gửi tin role='user' vào thread A → 201",
              r.status_code == 201, f"HTTP {r.status_code} {r.text[:200]}")

        # (6) A poll messages?thread_id=in.(tid)&id=gt.0 → nhận tin
        r = requests.get(
            f"{url}/rest/v1/messages?select=id,thread_id,role,text,created_at"
            f"&thread_id=in.({A['tid']})&id=gt.0&order=id.asc&limit=500",
            headers=h_anon(anon, tok_a), timeout=30)
        tin = r.json() if r.status_code == 200 else []
        check("6. A poll messages → nhận tin user vừa gửi",
              r.status_code == 200 and any(m.get("text") == "xin chào muse smoke A" and m.get("role") == "user" for m in tin),
              f"HTTP {r.status_code} n={len(tin)}")

        # (7) A POST reply role='muse' → 201
        r = requests.post(f"{url}/rest/v1/messages",
                          headers={**h_anon(anon, tok_a), "Prefer": "return=minimal"},
                          json={"thread_id": A["tid"], "project_id": A["pid"], "role": "muse",
                                "text": "chào anh, muse smoke A đây"}, timeout=30)
        check("7. A POST reply role='muse' → 201", r.status_code == 201, f"HTTP {r.status_code} {r.text[:200]}")

        # (8) admin GET messages → đủ 2 chiều
        r = requests.get(f"{url}/rest/v1/messages?select=role,text&thread_id=eq.{A['tid']}&order=id.asc",
                         headers=h_service(service), timeout=30)
        cap = [(m.get("role"), m.get("text")) for m in (r.json() if r.status_code == 200 else [])]
        check("8. admin đọc messages → đủ 2 chiều user+muse",
              ("user", "xin chào muse smoke A") in cap and ("muse", "chào anh, muse smoke A đây") in cap,
              f"cap={cap}")

        # (9) muse tạm B + RLS cách ly
        rand_b = "".join(random.choices(string.ascii_lowercase + string.digits, k=12))
        B = tao_muse(url, service, rand_b, "Muse Smoke B")
        check("9a. tạo muse tạm B (admin user + project + thread)", not B["loi"], B["loi"] or "")
        if B["loi"]:
            return
        tok_b, uid_b = login_muse(url, anon, B)
        check("9b. muse B login → có access_token", bool(tok_b))
        if not tok_b:
            return

        # RLS cách ly ĐỌC: B nhìn messages của thread A → phải rỗng
        r = requests.get(
            f"{url}/rest/v1/messages?select=id,thread_id&thread_id=in.({A['tid']})&id=gt.0&order=id.asc",
            headers=h_anon(anon, tok_b), timeout=30)
        tin_b = r.json() if r.status_code == 200 else None
        check("9c. RLS cách ly đọc: B GET messages thread A → PHẢI RỖNG",
              r.status_code == 200 and tin_b == [], f"HTTP {r.status_code} tin_b={tin_b}")

        # RLS cách ly projects: B không thấy project A
        r = requests.get(f"{url}/rest/v1/projects?select=id&user_id=eq.{uid_b}",
                         headers=h_anon(anon, tok_b), timeout=30)
        ds_b = r.json() if r.status_code == 200 else []
        check("9d. RLS cách ly projects: B không thấy project A",
              r.status_code == 200 and len(ds_b) == 1 and ds_b and ds_b[0]["id"] == B["pid"],
              f"ds_b={ds_b}")

        # RLS cách ly GHI: B POST message vào thread A → phải bị từ chối 4xx
        r = requests.post(f"{url}/rest/v1/messages",
                          headers={**h_anon(anon, tok_b), "Prefer": "return=minimal"},
                          json={"thread_id": A["tid"], "project_id": A["pid"], "role": "muse",
                                "text": "B cố ghi vào thread A"}, timeout=30)
        check("9e. RLS cách ly ghi: B POST message vào thread A → PHẢI 4xx",
              400 <= r.status_code < 500, f"HTTP {r.status_code}")

        # B POST bình thường vào project/thread của mình → 201
        r = requests.post(f"{url}/rest/v1/messages",
                          headers={**h_anon(anon, tok_b), "Prefer": "return=minimal"},
                          json={"thread_id": B["tid"], "project_id": B["pid"], "role": "muse",
                                "text": "B tự reply thread của B"}, timeout=30)
        check("9f. B POST message vào project/thread của B → 201",
              r.status_code == 201, f"HTTP {r.status_code} {r.text[:200]}")
    finally:
        # (10) dọn dẹp: xóa project row (cascade threads/messages) + xóa admin user A/B
        loi = []
        for d in (A, B):
            if d:
                loi += [f"{d['muse_id']}: {x}" for x in xoa_muse(url, service, d)]
        check("10. dọn dẹp dữ liệu test (xóa user + project A/B)", not loi, "; ".join(loi) or "đã xóa sạch")
        print("đã dọn dữ liệu test" if not loi else f"(dọn chưa sạch: {loi})")

    print()
    print("TẤT CẢ PASS" if not FAILS else "THẤT BẠI: " + ", ".join(FAILS))
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
