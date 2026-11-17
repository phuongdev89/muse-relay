# Muse Relay v4

Điều phối nhiều **Muse AI** chạy trên máy riêng: bạn chat với từng Muse qua web UI, Muse chạy một client nhỏ trên máy của nó để nhận và trả lời tin.

```
[serve.py (máy bạn) + web UI] ⇄ [Supabase: Postgres + Realtime] ⇄ [Muse client trên máy từng Muse]
```

- **Key không bao giờ nằm trong browser**: `serve.py` đọc `.env` và đứng ra proxy mọi call Supabase; web UI chỉ nói chuyện với server local.
- **Mỗi Muse = 1 tài khoản riêng (email/password) chịu RLS**: Muse A không thể đọc dữ liệu của Muse B — cô lập ở tầng database, không phải tầng ứng dụng.
- **File/ảnh/video không đi qua hệ thống**: Muse tự upload lên Dropbox của chính nó rồi trả link trong tin nhắn.

## Cài đặt (5 phút, 1 lần)

1. Tạo project trên [supabase.com](https://supabase.com) → **SQL Editor** → dán `supabase/setup.sql` → **Run**.
2. Copy file `.env.example` thành `.env` rồi điền:

   ```ini
   SUPABASE_PROJECT_ID=abcdefghijklmnopqrst    # 20 chữ cái ref (phần trước .supabase.co)
   SUPABASE_SECRET_KEY=sb_secret_…             # Dashboard → Settings → API → Secret key
   SUPABASE_PAT=sbp_…                          # tuỳ chọn — Account → Access Tokens
   ```

   - `SUPABASE_SECRET_KEY`: dạng mới `sb_secret_…` hay legacy JWT `eyJ…` đều được (server-side không bị chặn như browser).
3. Cài `requests` (`pip install requests`) nếu chưa có.

## Chạy

```bash
python3 serve.py            # → http://127.0.0.1:8080
# mở cho LAN: python3 serve.py --host 0.0.0.0
```

Server vừa host web UI, vừa proxy Supabase (`/sb/*`), vừa làm realtime (SSE `/api/events`, poll 3s) và tạo key (`/api/create-muse-keys`). Đổi máy: copy repo + `.env`, chạy lại — hết.

## Tạo Muse mới

1. Web UI → **＋ New Muse**:
   - **B1**: điền **Muse Name** — Muse ID tự slug theo tên (bỏ dấu tiếng Việt, sửa tay được), chọn tag năng lực (chat / image / video).
   - **B2**: hệ thống tạo **account login riêng cho Muse** (email + password random 24) và hiện **khung instruction tiếng Anh** (kèm Email + Password để copy) — bấm **Copy**.
2. Dán instruction vào chat của Muse. Muse tự tải zip (link trong instruction), tự điền `config.json`, rồi hiện **secure form "Muse Relay password"** — bạn copy Password từ B2 (hoặc ⚙ → Token) dán vào form (tuyệt đối không dán vào chat).
3. Muse login → RLS khóa nó vào đúng project của nó → chạy daemon → bạn gửi tin thử → Muse trả lời. Xong!

## Muse client hoạt động thế nào

Client trên máy Muse chỉ cần 3 thứ: **Project ID + Publishable key** (nằm trong `config.json`, không secret) và **Secret key** (owner nhập qua secure form — chỉ sống trong biến môi trường, không ghi đĩa).

- **Daemon** `poller.py` chạy nền, ~3 giây một vòng: tin mới (role `user`) → `state/inbox.jsonl`; reply của Muse ghi vào `outbox/<thread_id>.txt` → daemon đẩy lên Supabase rồi xóa file.
- **Cursor** `state/cursor.json` ghi atomically — restart không xử lý lại tin cũ, không sót tin mới.
- **Lịch của nền tảng Muse**: mỗi 3 phút kiểm tra daemon còn sống (không sống thì tự start lại); hook 10 giây đánh thức Muse khi có tin mới.
- Chi tiết luật vận hành cho Muse: `AGENTS.md` trong bộ setup (Dropbox-only cho asset gửi qua relay, inbox/outbox, cấm đụng cursor…).

## Tags chat/image/video

Tag năng lực do **server phân phối** (cột `tags` trong bảng projects — sửa ngay trong web UI: hover Muse → ⚙):

| Tag | Muse được làm gì |
|---|---|
| `chat` | Chỉ trò chuyện bằng chữ |
| `image` | Tạo/sửa ảnh → upload Dropbox → trả link |
| `video` | Tạo video → upload Dropbox → trả link |

## Bảo mật

- **Browser không giữ key nào** — mọi key nằm trong `.env` trên máy bạn (git-ignored). Mất máy ≠ mất key trong cache trình duyệt.
- **Secret Key của project** chỉ nằm trong `.env` trên máy bạn (git-ignored) — dùng cho server/UI, không bao giờ đưa cho Muse.
- **Muse không cầm secret key nào**: nó login bằng email/password riêng, mọi request chịu RLS — **Muse A không thể đọc dữ liệu của Muse B ở tầng database** (đã kiểm chứng bằng JWT trực tiếp).
- **Password của Muse** chỉ đi qua secure form của nền tảng Muse — không chat, không file, không log; mất máy Muse cũng không lộ project của người khác.
- **1 Muse = 1 auth account**: xóa Muse trong web UI (⚙) là xóa account + dữ liệu của nó (cascade) — truy cập bị thu hồi tức thì.
- Tin nhắn qua relay chỉ là text; asset bắt buộc qua Dropbox link.

## Kiểm thử

```bash
python3 web/test_client_mock.py     # test client, không cần internet
```

## Cấu trúc thư mục

```
muse-relay/
├── README.md              ← tệp này
├── serve.py               ← server local: host UI + proxy Supabase + SSE realtime
├── .env.example           ← mẫu .env (copy thành .env rồi điền key)
├── supabase/
│   └── setup.sql          ← chạy 1 lần trong SQL Editor của Supabase
├── web/
│   └── index.html         ← web UI (một file duy nhất, không key)
└── client/                ← mã nguồn bộ setup Muse (= nội dung muse-relay.zip)
    ├── muse_client.py     ← clientforeground: poll 1 vòng rồi exit (cron)
    ├── poller.py          ← daemon nền chính (chạy vô hạn, ~3s/vòng)
    ├── relay_auth.py      ← dùng chung: login GoTrue + session refresh + lockfile
    ├── config.json        ← Project ID + Publishable Key + Muse Email (public)
    ├── AGENTS.md          ← luật vận hành áp đặt cho Muse
    ├── setup_guide.txt    ← hướng dẫn cài đặt từng bước cho Muse
    └── run.sh / run.bat / start_daemon.sh / restart_poller.sh
```

> Bộ zip gửi Muse được đóng gói từ `client/`: `cd client && zip -r ../muse-relay.zip .`
> Nhánh `web` trên GitHub giữ file `muse-relay.zip` — link tải nằm trong instruction của wizard.
