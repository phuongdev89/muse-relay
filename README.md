# Muse Relay v2

Điều phối nhiều **Muse AI** chạy trên máy riêng: bạn chat với từng Muse qua web UI tĩnh, Muse chạy một client nhỏ trên máy của nó để nhận và trả lời tin — **không cần server trung gian**.

```
[Web UI tĩnh trên GitHub Pages] ⇄ [Supabase: Auth + Postgres RLS + Realtime] ⇄ [muse_client.py trên máy từng Muse]
```

- **Không server riêng**: web UI là một file HTML tĩnh; dữ liệu (tài khoản Muse, thread, tin nhắn) nằm toàn bộ trên Supabase của bạn.
- **File/ảnh/video không đi qua hệ thống**: Muse tự upload lên Dropbox của chính nó (kết nối native sẵn có) rồi trả link trong tin nhắn.
- **Mỗi Muse = 1 project**: tài khoản riêng, tag năng lực riêng (chat/image/video), chỉ đọc/ghi được dữ liệu của mình nhờ RLS.

## Kết nối Supabase (3 phút)

1. Tạo project mới trên [supabase.com](https://supabase.com) (miễn phí).
2. Mở **SQL Editor** → dán toàn bộ nội dung `supabase/setup.sql` → bấm **Run**. Script tạo bảng + RLS + realtime, chạy lại không lỗi.
3. Vào **Settings → API**, copy 3 giá trị: **Project URL**, **anon key**, **service key**.

> **Lưu ý SERVICE_KEY**: key dán vào web UI phải là **service_role key dạng legacy JWT (chuỗi bắt đầu bằng `eyJ...`)** — key mới dạng `sb_secret_` bị Supabase chặn khi gọi từ trình duyệt (trả 401, đã kiểm chứng).
> Key ANON thì dùng `sb_publishable_` (dạng mới) hoặc legacy đều được từ trình duyệt.

> **Dạng key**: Muse client chạy trên máy Muse bằng python nên dùng dạng key nào của Supabase cũng ổn; riêng web UI chạy trong trình duyệt phải tuân theo lưu ý SERVICE_KEY phía trên. Tuyệt đối không commit key thật vào repo.

## Chạy web UI

**Chạy local:**

```bash
cd web
python -m http.server 8000
```

Mở http://localhost:8000 → lần đầu thấy màn **Settings**: dán Project URL + anon key + service key → bấm **Kiểm tra kết nối**. Key lưu vào localStorage của trình duyệt, lần sau vào thẳng.

**Hoặc** dùng bản đã deploy trên GitHub Pages (mục dưới) — cách dùng y hệt.

## Deploy GitHub Pages

1. Push repo lên GitHub (nhánh `main`).
2. Vào **Settings → Pages → Source: GitHub Actions**.
3. Workflow `.github/workflows/pages.yml` tự deploy thư mục `web/` mỗi lần push chạm `web/**` (có thể chạy tay từ tab **Actions**).

## Tạo Muse đầu tiên

1. Mở web UI → bấm **＋ New** → wizard 3 bước:
   - **B1**: đặt `muse_id`, tên, chọn tag năng lực (chat / image / video).
   - **B2**: hệ thống tạo tài khoản và hiện **email + password** của Muse — lưu ngay, bước sau Muse sẽ hỏi lại.
   - **B3**: tải `muse_<muse_id>_setup.zip` và copy nội dung `setup_guide.txt`.
2. Gửi zip + nội dung txt cho Muse (trên máy của Muse).
3. Muse tự làm theo `setup_guide.txt`: giải nén, tạo venv, **mở form xin `MUSE_EMAIL`/`MUSE_PASSWORD`** — chính là cặp email/password ở bước B2 — rồi chạy nền và xác nhận banner "đang nghe".
4. Bạn gửi tin thử trong web UI → Muse trả lời. Xong!

## Muse client hoạt động thế nào

`muse_client.py` chạy nền trên máy Muse, chỉ dùng `requests` + stdlib:

- **Polling**: mỗi `POLL_INTERVAL` giây (mặc định 3, tối thiểu 2) client hỏi Supabase có tin mới tính từ cursor không.
- **Giao thức inbox/outbox**:
  - Tin của bạn (role `user`) được ghi vào `state/inbox.jsonl` — mỗi dòng 1 JSON `{"id","thread_id","role","text","created_at"}`.
  - Muse trả lời bằng cách ghi tệp `outbox/<thread_id>.txt` (UTF-8, 1 tệp = 1 tin) — client tự đẩy lên Supabase rồi xóa tệp. Mỗi `thread_id` là một phiên hội thoại riêng giữ ngữ cảnh riêng.
- **Cursor**: `state/cursor.json` lưu "đã xử lý tới đâu" — restart không xử lý lại tin cũ.
- **Polling chết thì sao**: lỗi mạng → client tự backoff (1, 2, 4, 8... tối đa 60 giây); client hẳn chết → `run.sh` (hoặc systemd `Restart=always`) tự chạy lại sau 5 giây; cursor persist nên không sót, không trùng.

Chi tiết áp đặt cho Muse xem `web/templates/AGENTS.md` (luật vận hành) và `web/templates/setup_guide.txt` (hướng dẫn cài đặt).

## Tags chat/image/video

Mỗi Muse được gắn tag năng lực khi tạo (wizard bước B1), ghi vào `CAPABILITIES` trong `.env` của Muse đó:

| Tag | Muse được làm gì |
|---|---|
| `chat` | Chỉ trò chuyện bằng chữ |
| `image` | Tạo/sửa ảnh → upload Dropbox → trả link |
| `video` | Tạo video → upload Dropbox → trả link |

Một Muse có thể có nhiều tag. Muse chỉ thực hiện đúng năng lực được liệt kê.

## Bảo mật

- **Service key** chỉ nằm ở 2 chỗ: localStorage của trình duyệt admin (máy bạn) và file ngoài git (nếu bạn tự lưu). Không nằm trong zip/txt gửi Muse.
- **Dạng key trong web UI**: SERVICE_KEY phải là legacy JWT (bắt đầu bằng `eyJ...`) — key mới `sb_secret_` bị Supabase chặn khi gọi từ trình duyệt (401, đã kiểm chứng); ANON dùng `sb_publishable_` bình thường.
- **Zip và setup_guide.txt không chứa secret nào** — chỉ có URL + anon key + tag năng lực; mật khẩu Muse do owner điền trực tiếp vào form trên máy Muse.
- **1 Muse = 1 project = 1 bộ tài khoản riêng** (email + password riêng): lộ thông tin 1 Muse chỉ lộ đúng project đó; xóa Muse trong web UI là thu hồi ngay.
- **RLS trên Supabase**: Muse chỉ SELECT/INSERT được dữ liệu project của mình — muse A không đọc được tin của muse B (smoke test có case chứng minh riêng).
- **GitHub Pages chạy HTTPS sẵn** — tin nhắn và key không đi dưới dạng plaintext.

## Kiểm thử

```bash
# Test client không cần internet (mock auth + REST chạy local):
python3 web/test_client_mock.py

# Smoke test với Supabase thật (có test RLS cách ly + tự dọn dữ liệu test):
python3 web/smoke_test.py --url <PROJECT_URL> --anon <ANON_KEY> --service <SERVICE_KEY>
```

## Cấu trúc thư mục

```
muse-relay/
├── README.md                      ← tệp này
├── supabase/
│   └── setup.sql                  ← chạy 1 lần trong SQL Editor của Supabase
├── web/
│   ├── index.html                 ← web UI (một file duy nhất)
│   ├── smoke_test.py              ← smoke test với Supabase thật
│   ├── test_client_mock.py        ← test client với mock local
│   └── templates/                 ← nội dung zip gửi Muse
│       ├── muse_client.py         ← client chạy nền trên máy Muse
│       ├── env.template           ← .env mẫu (wizard điền sẵn URL/key/tag)
│       ├── requirements.txt       ← thư viện cần cho client
│       ├── run.sh                 ← Linux/macOS: tự restart client
│       ├── run.bat                ← Windows: tự restart client
│       ├── AGENTS.md              ← luật áp đặt cho Muse
│       └── setup_guide.txt        ← hướng dẫn cài đặt gửi Muse
└── .github/
    └── workflows/pages.yml        ← deploy web/ lên GitHub Pages
```

Các tệp của phương án cũ (server.py, manage.py, static/, ...) vẫn giữ nguyên trong repo nhưng không còn dùng — xem phụ lục dưới đây.

---

## Phụ lục — phương án cũ (FastAPI có server)

# Muse Relay

Server chuyển tiếp tin nhắn giữa **web chat của bạn** và **nhiều account Muse** — mỗi Muse có máy riêng chạy Python, long-poll tin mới rồi tự trả lời. Không cần tạo Telegram bot cho từng account (tránh nguy cơ bị ban khi có ~100 account).

```
[Web chat của bạn] ⇄ [Muse Relay (FastAPI + SQLite)] ⇄ [muse_client.py trên máy từng Muse]
```

- Mỗi account Muse = 1 hội thoại riêng + 1 token riêng, chỉ đọc/viết được hội thoại của mình.
- Long-poll tới 25s nên tin tới gần như realtime, không cần WebSocket.
- SQLite (WAL) lưu vĩnh viễn, restart không mất tin; cursor từng phía đảm bảo không sót/trùng tin.

## Chạy thử tại máy local

```bash
pip install -r requirements.txt
uvicorn server:app --port 8000
```

- Nếu chưa đặt `RELAY_ADMIN_TOKEN`, server tự sinh và lưu ở `data/admin_token.txt` (đồng thời in ra console).
- Mở http://localhost:8000 → dán admin token → bấm **＋** để tạo account Muse → nhận TOKEN cho Muse đó.

## Quản lý account Muse (CLI)

```bash
python manage.py add muse_001 "Muse 001"   # tạo + in token
python manage.py list
python manage.py token muse_001
python manage.py rm muse_001               # xóa account + tin nhắn của nó
```

## Chạy client trên máy Muse

```bash
pip install requests
python muse_client.py --url https://<server> --token <TOKEN>
```

Sửa hàm `handle()` trong `muse_client.py` để Muse xử lý tin nhắn theo ý mình. Cursor lưu tại `muse_cursor.json` nên restart không xử lý lại tin cũ.

## API

Auth: header `Authorization: Bearer <token>`.

| Method | Path | Ai | Mô tả |
|---|---|---|---|
| POST | /api/conversations | admin | tạo account Muse, trả token |
| GET | /api/conversations | admin | danh sách hội thoại + tin cuối + unread |
| POST | /api/messages | admin | gửi tin vào 1 hội thoại `{conversation_id, text}` |
| GET | /api/messages?conversation_id=&after= | admin | đọc tin của 1 hội thoại |
| POST | /api/read | admin | đánh dấu đã đọc |
| GET | /api/me | muse | thông tin account của mình |
| GET | /api/poll?after=&wait= | muse | long-poll tin mới (wait ≤ 55s) |
| POST | /api/reply | muse | trả lời `{text}` |
| GET | /api/health | tất cả | kiểm tra sống |

## Kiểm thử

```bash
uvicorn server:app --port 8765 &
python smoke_test.py http://127.0.0.1:8765
```

Smoke test gồm 10 bước: tạo hội thoại, gửi/nhận 2 chiều, long-poll trả ngay khi có tin, 50 poller đồng thời, chặn token sai.

## Deploy 24/7 (VPS)

Docker:

```bash
docker build -t muse-relay .
docker run -d --name muse-relay --restart unless-stopped -p 127.0.0.1:8000:8000 \
  -v muse-relay-data:/app/data -e RELAY_ADMIN_TOKEN=<token của anh> muse-relay
```

systemd (không dùng Docker):

```ini
# /etc/systemd/system/muse-relay.service
[Unit]
Description=Muse Relay
After=network.target

[Service]
WorkingDirectory=/opt/muse-relay
Environment=RELAY_ADMIN_TOKEN=<token của anh>
ExecStart=/opt/muse-relay/.venv/bin/uvicorn server:app --host 127.0.0.1 --port 8000
Restart=always

[Install]
WantedBy=multi-user.target
```

HTTPS bằng Caddy (domain trỏ A record về VPS):

```
relay.example.com {
    reverse_proxy 127.0.0.1:8000
}
```

## Bảo mật

- Bật HTTPS trước khi dùng thật — token đi qua mạng dưới dạng header.
- 1 token = 1 Muse: lộ token chỉ lộ đúng 1 hội thoại; thu hồi bằng `manage.py rm` rồi `add` lại.
- Admin token là chìa khóa toàn bộ hệ thống — đặt qua biến môi trường `RELAY_ADMIN_TOKEN`, không commit.
