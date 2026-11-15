# Muse Relay v2 — Setup Spec (zero-server)

> Nguồn yêu cầu: hội thoại với owner (đã duyệt kế hoạch). Spec này là nguồn sự thật duy nhất cho cả pipeline.
> Owner nói tiếng Việt; toàn bộ UI/comment/docs viết tiếng Việt.

## 0. Yêu cầu gốc của owner (trích nguyên văn)

1. "tệp zip và tệp .txt để đưa cho Muse hướng dẫn Muse cài đặt, setup schedule polling như thế nào, polling chết thì làm sao, trong tệp zip cũng có sẵn tệp AGENTS.md áp đặt Muse không được gửi trả ảnh, video, tệp trực tiếp qua chat, luôn luôn phải tải lên dropbox rồi đưa link dropbox."
2. "trong tệp zip đó sẽ cần có .env, có tệp này Muse sẽ tự động hiện lên cái form để a điền token các thứ mà ko bị lộ hoặc phải setup tay"
3. "code phần giao diện phía anh giống như phần mềm agent của zcode, codex, antigravity... mỗi Muse giống như 1 project"
4. "khi anh muốn thêm 1 Muse mới, anh bấm vào New, setup wizard sẽ hiện lên ở đây, step cuối là tệp zip và hướng dẫn Muse cài đặt"
5. "việc quản trị Muse (project) và các thread nên lưu trên supabase hay máy trạm thì tùy em thiết kế" → ĐÃ CHỐT: lưu toàn bộ trên Supabase.
6. "mỗi 1 Muse anh cũng có thể đánh dấu tag rằng Muse này có thể làm những gì trong 3 thứ sau: chat, image, video"
7. "trọng web client là web tĩnh, triển khai lên github page, khi vô thì hỏi điền cái gì đó của supabase, xong lưu vào localstorage"
8. Muse có sẵn kết nối Dropbox native → hệ thống KHÔNG code gì phần Dropbox; chỉ áp đặt bằng AGENTS.md.

## 1. Kiến trúc

```
[Web UI tĩnh trên GitHub Pages] ⇄ [Supabase: Auth + Postgres RLS + Realtime] ⇄ [muse_client.py trên máy từng Muse]
```

- KHÔNG có server trung gian. File/ảnh/video KHÔNG đi qua hệ thống (Muse upload Dropbox rồi trả link trong text).
- Hệ thống cũ FastAPI (server.py, manage.py, static/, smoke_test.py, README cũ) **giữ nguyên, KHÔNG sửa, KHÔNG xóa**. Chỉ thêm file mới.
- Môi trường dev: `/mnt/d/AI/muse-relay`, Python 3.10 + requests, Node 22, Chrome + Playwright có sẵn.

## 2. Lược đồ Supabase (CHỐT CỨNG — file `supabase/setup.sql` đã viết, KHÔNG đổi schema)

- `projects(id bigint identity PK, muse_id text UNIQUE, name text, tags text[] — chỉ 'chat'/'image'/'video', user_id uuid → auth.users (auth user CỦA MUSE), email text UNIQUE — '<muse_id>@muserelay.local', secret text — password của Muse, created_at timestamptz)`
- `threads(id, project_id → projects CASCADE, title DEFAULT 'Thread mới', last_read_id bigint DEFAULT 0, created_at)`
- `messages(id, thread_id → threads CASCADE, project_id → projects CASCADE (denormalize cho RLS), role CHECK('user','muse'), text CHECK(char_length ≤ 20000), created_at)`
- RLS: Muse (authenticated) chỉ SELECT projects/threads/messages của mình (`projects.user_id = auth.uid()`), chỉ INSERT messages `role='muse'` + project thuộc mình + `threads.project_id` khớp `project_id`. Admin UI dùng service key (bypass RLS). Anon: không policy → thấy gì cũng không.
- `messages` thêm vào publication `supabase_realtime`.
- setup.sql phải idempotent (chạy lại không lỗi).

## 3. REST contract (PostgREST/GoTrue chuẩn Supabase)

- Header thường: `apikey: <ANON>`; admin: `apikey: <SERVICE>` + `Authorization: Bearer <SERVICE>`.
- Key dạng legacy JWT (anon/service_role) HOẶC key mới (`sb_publishable_...`/`sb_secret_...`) — NHƯNG có hạn chế đã xác chứng runtime (QA 16/11/2026): **Supabase trả 401 cho `sb_secret_` khi request mang User-Agent browser (Mozilla/...)** — tức web UI KHÔNG dùng được `sb_secret_` trong trình duyệt; legacy JWT service_role dùng được từ browser bình thường. `sb_publishable_` dùng tốt từ browser. Kết luận: web UI Settings → SERVICE_KEY phải dán **service_role JWT legacy (eyJ...)**; ANON có thể là `sb_publishable_`. Muse client (UA python-requests) dùng `sb_publishable_` không vấn đề. UI Settings khi test kết nối thất bại 401 với key bắt đầu `sb_secret_` phải hiện hint dẫn về legacy JWT. README phải ghi chú hạn chế này.
- Login Muse: `POST {url}/auth/v1/token?grant_type=password` body `{"email","password"}` → `access_token`, `user.id`. Access token hết hạn ~1h → client login lại khi gặp 401.
- Muse lấy project của mình: `GET /rest/v1/projects?select=id,muse_id,name,tags,email&user_id=eq.{uid}` (bearer access_token).
- Threads: `GET /rest/v1/threads?select=id,title&project_id=eq.{pid}&order=id.asc`.
- Poll: `GET /rest/v1/messages?select=id,thread_id,role,text,created_at&thread_id=in.({ids cách nhau phẩy})&id=gt.{cursor}&order=id.asc&limit=500`.
- Reply: `POST /rest/v1/messages` body `{"thread_id":n,"project_id":n,"role":"muse","text":"..."}` + `Prefer: return=minimal` → 201.
- Admin tạo Muse: `POST {url}/auth/v1/admin/users` body `{"email","password","email_confirm":true}` (service key) → `user.id`; rồi `POST /rest/v1/projects` body `{muse_id,name,tags,user_id,email,secret}` + `Prefer: return=representation`.
- Xóa Muse: `DELETE {url}/auth/v1/admin/users/{uid}` + `DELETE /rest/v1/projects?id=eq.{pid}` (cascade).
- Đánh dấu đọc: `PATCH /rest/v1/threads?id=eq.{tid}` body `{"last_read_id": <id tin lớn nhất thread>}`.
- Realtime web UI: supabase-js `createClient(url, SERVICE_KEY)` + channel `postgres_changes` INSERT table `messages`.
- Link Dropbox trong text: nhận dạng `https://(www.)?dropbox.com/...` hoặc `https://dl.dropboxusercontent.com/...` → render thành card đính kèm (text giữ nguyên).

## 4. Contract .env (repo: `web/templates/env.template` — vào zip đổi tên thành `.env`)

```
# === Muse Relay client config ===
SUPABASE_URL=            # wizard điền sẵn
SUPABASE_ANON_KEY=       # wizard điền sẵn
MUSE_EMAIL=              # TRỐNG → Muse mở form cho owner điền (không in giá trị ra chat)
MUSE_PASSWORD=           # TRỐNG → Muse mở form cho owner điền
CAPABILITIES=chat        # wizard điền theo tag: chat,image,video
POLL_INTERVAL=3          # giây, tối thiểu 2
```
Quy tắc wizard: thay đúng các dòng bắt đầu `SUPABASE_URL=`, `SUPABASE_ANON_KEY=`, `CAPABILITIES=chat` thành giá trị mới; MUSE_EMAIL/MUSE_PASSWORD giữ trống. ZIP/txt KHÔNG được chứa secret nào (service key, password).

## 5. Giao thức inbox/outbox của muse_client.py (CHỐT CỨNG)

- Client chạy nền trên máy Muse, chỉ dùng `requests` + stdlib. Đọc `.env` (cờ `--env`, mặc định `.env`).
- Khởi động: login → `GET projects?user_id=eq.{uid}` → banner `[#<project_id>] <muse_id> (<name>) đang nghe — tags=... — cursor=N`.
- Vòng lặp mỗi `POLL_INTERVAL` giây (±jitter 0–0.5s):
  1. Lấy danh sách `threads?select=id&project_id=eq.{pid}` → poll `messages?thread_id=in.(...)&id=gt.{cursor}&order=id.asc&limit=500`.
  2. Tin `role='user'` → append JSONL vào `state/inbox.jsonl` (mỗi dòng 1 JSON: `{"id","thread_id","role","text","created_at"}`). Tin `role='muse'` bỏ qua (echo của mình).
  3. Ghi cursor `state/cursor.json` (`{"after": N}`) — ghi atomically (tmp + rename) SAU khi append.
  4. Xử lý outbox: file `outbox/<thread_id>.txt` (sắp xếp theo mtime) — mỗi file = 1 reply cho thread đó → POST → thành công thì xóa file; lỗi 4xx (khác 401) → đổi tên `<tên>.err` (đừng retry vô hạn); 401 → login lại rồi thử lại 1 lần; lỗi mạng → giữ file, dừng vòng outbox, backoff.
- Backoff lỗi mạng/5xx/429: 1,2,4,8,... tối đa 60s, reset khi thành công. Cờ `--once`: poll 1 lượt + đẩy outbox rồi thoát (cho cron).
- KHÔNG in secret ra stdout. KeyboardInterrupt là lối thoát sạch.

## 6. AGENTS.md (áp đặt Muse — tiếng Việt)

- **Luật tuyệt đối**: CẤM gửi ảnh/video/file/base64 trực tiếp qua reply chat. Mọi tài sản (ảnh, video, file) phải upload lên Dropbox của mình (kết nối native có sẵn) rồi trả về LINK trong text reply — ưu tiên link tải trực tiếp (`dl.dropboxusercontent.com` hoặc `?dl=1`), kèm mô tả ngắn.
- Giao thức inbox/outbox (đọc `state/inbox.jsonl`, ghi `outbox/<thread_id>.txt`), mỗi thread_id = một phiên hội thoại riêng giữ ngữ cảnh riêng.
- Cấm sửa `state/cursor.json`; cấm POLL_INTERVAL < 2; cấm chạy 2 client cùng lúc; client chết → chạy lại `run.sh` (tự restart), cursor persist nên không xử lý lại tin cũ.
- Mô tả năng lực theo `CAPABILITIES` trong .env: `chat` (chỉ trò chuyện), `image` (tạo/sửa ảnh → upload Dropbox → link), `video` (tạo video → upload Dropbox → link). Chỉ thực hiện năng lực được liệt kê.

## 7. setup_guide.txt (tệp .txt đưa cho Muse)

Từng bước: giải nén → `python3 -m venv .venv` + `pip install -r requirements.txt` → đọc `.env`: giá trị TRỐNG (MUSE_EMAIL, MUSE_PASSWORD) thì **mở form cho owner điền** (không yêu cầu dán token vào chat, không in giá trị sau khi điền) → chạy nền: `nohup bash run.sh >/dev/null 2>&1 &` hoặc systemd unit mẫu (kèm trong txt) hoặc Windows `run.bat` → xác nhận banner "đang nghe" → chờ owner gửi tin thử → trả lời thử qua outbox → đọc kỹ AGENTS.md. Giải thích POLL_INTERVAL và xử lý khi polling chết.

## 8. Web UI (`web/index.html` — MỘT file, tiếng Việt, dark theme giống static/index.html cũ)

- CDN: supabase-js v2 + JSZip v3 (jsdelivr, pin version). KHÔNG build step, KHÔNG key thật trong code.
- **Màn Settings (lần đầu/缺 key)**: 3 ô SUPABASE_URL / ANON_KEY / SERVICE_KEY (password input) + nút "Kiểm tra kết nối" (`GET /rest/v1/projects?select=id&limit=1` bằng service key) → lưu localStorage (`mr_supabase_url`, `mr_anon_key`, `mr_service_key`); lần sau vào thẳng.
- **Layout kiểu agent-IDE (ZCode/Codex/Antigravity)**: sidebar trái (nút **＋ New**, ô search, thẻ project: name + muse_id + tag chips màu [chat=xanh dương, image=xanh lá, video=tím] + badge unread + preview tin cuối + thời gian tương đối; menu ⋮ per project: Token, Xóa) — khối phải: header project (name, muse_id, tag chips, chọn thread + nút ＋ Thread mới), vùng chat (bubble user phải/xanh, muse trái/xanh đậm, timestamp vi-VN, link Dropbox → card đính kèm ⬇), composer (textarea tự giãn, Enter gửi / Shift+Enter xuống dòng).
- **Wizard New Muse (modal 3 bước)**: B1: muse_id (regex `^[a-z0-9_]{3,40}$`, check trùng live qua `GET projects?muse_id=eq.X`), name, 3 checkbox tags. B2: sinh password ngẫu nhiên 24 ký tự (crypto.getRandomValues base64url) → POST admin user → INSERT project → hiện email + password (nút copy) + cảnh báo "lưu ngay, form của Muse sẽ hỏi". B3: fetch templates từ `templates/` (path tương đối; nếu mở file:// fetch lỗi → cảnh báo chạy qua `python -m http.server`) → JSZip dựng `muse_<muse_id>_setup.zip` (muse_client.py, AGENTS.md, setup_guide.txt, `.env` ← env.template đã điền URL/ANON/CAPABILITIES, requirements.txt, run.sh, run.bat) → nút tải + textarea setup_guide.txt + nút copy + note "gửi zip + nội dung txt này cho Muse".
- **Dữ liệu**: load đầu: `GET threads?select=id,project_id,title,last_read_id&order=id.asc` (service key) + `GET messages?select=id,project_id,thread_id,role,text,created_at&order=id.desc&limit=200` → dựng preview + unread client-side; realtime INSERT trên messages cập nhật chat mở + sidebar + unread; fallback refetch 30s. Mở thread: `GET messages?thread_id=eq.X&order=id.asc&limit=500` → render → PATCH last_read_id. Gửi: POST messages `{thread_id, project_id, role:'user', text}`. Thread mới: POST threads `{project_id, title}`.
- Project ⋮ → Token (modal email + secret, nút copy, GET projects?id=eq.X) / Xóa (confirm → DELETE admin user + project row).
- Mọi lỗi fetch → toast rõ ràng; 401/403 báo ngay.

## 9. Deploy

- `.github/workflows/pages.yml`: deploy thư mục `web/` lên GitHub Pages (push main + workflow_dispatch; dùng actions/configure-pages + upload-pages-artifact + deploy-pages). README ghi chú: Settings → Pages → Source: GitHub Actions.
- Chạy local: `python -m http.server` trong `web/`.

## 10. Files phải tạo (KHÔNG đụng file khác)

| File | Chủ trì |
|---|---|
| `supabase/setup.sql` | đã xong (lead) |
| `web/templates/muse_client.py` | backend |
| `web/smoke_test.py` | backend |
| `web/test_client_mock.py` | backend |
| `web/index.html` | frontend |
| `.github/workflows/pages.yml` | frontend |
| `web/templates/AGENTS.md` | docs |
| `web/templates/setup_guide.txt` | docs |
| `web/templates/env.template` | docs |
| `web/templates/requirements.txt` | docs |
| `web/templates/run.sh` | docs |
| `web/templates/run.bat` | docs |
| `README.md` | docs (viết lại; giữ nội dung cũ ở cuối dưới tiêu đề "Phụ lục — phương án cũ (FastAPI có server)") |

## 11. Definition of Done + Verification

1. `python3 -m py_compile web/templates/muse_client.py web/smoke_test.py web/test_client_mock.py` sạch.
2. `python3 web/test_client_mock.py` → tất cả PASS (mock auth+postgrest local, chạy client thật).
3. `web/smoke_test.py` viết sẵn theo spec, chạy được khi có key thật: `python3 web/smoke_test.py --url <URL> --anon <ANON> --service <SERVICE>` — gồm test RLS cách ly (muse B KHÔNG đọc được messages của muse A, KHÔNG insert được vào thread của A) + dọn dẹp dữ liệu test.
4. UI: mở qua http.server, screenshot màn Settings (bằng chứng Playwright), không có JS error console; wizard B1 render đúng 3 tags.
5. README đủ các mục: kết nối Supabase 3 phút, deploy Pages, tạo Muse, giao thức client, bảo mật.
6. Contract chéo khớp 100%: tên field, endpoint, key .env, tên file trong zip.
