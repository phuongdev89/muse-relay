# Muse Relay v2 — Tasklist Pipeline Dev-QA

> **Nguồn sự thật duy nhất**: `project-specs/muse-relay-v2-setup.md` — mọi "Yêu cầu" bên dưới là TRÍCH NGUYÊN VĂN từ spec. Không thêm tính năng ngoài spec.
> **Kiểm đếm orchestrator**: task được đếm bằng `grep -c "^### \[ \]"` trên file này → hiện tại **12 task**.

## Tóm tắt spec (trích nguyên văn)

**Kiến trúc** (§1): `[Web UI tĩnh trên GitHub Pages] ⇄ [Supabase: Auth + Postgres RLS + Realtime] ⇄ [muse_client.py trên máy từng Muse]` — "KHÔNG có server trung gian."

**Môi trường dev** (§1): "Môi trường dev: `/mnt/d/AI/muse-relay`, Python 3.10 + requests, Node 22, Chrome + Playwright có sẵn."

**Ngôn ngữ** (§0 header): "Owner nói tiếng Việt; toàn bộ UI/comment/docs viết tiếng Việt."

**Yêu cầu gốc owner** (§0, liên quan trực tiếp):
- "trọng web client là web tĩnh, triển khai lên github page, khi vô thì hỏi điền cái gì đó của supabase, xong lưu vào localstorage"
- "khi anh muốn thêm 1 Muse mới, anh bấm vào New, setup wizard sẽ hiện lên ở đây, step cuối là tệp zip và hướng dẫn Muse cài đặt"
- "mỗi 1 Muse anh cũng có thể đánh dấu tag rằng Muse này có thể làm những gì trong 3 thứ sau: chat, image, video"
- "trong tệp zip đó sẽ cần có .env, có tệp này Muse sẽ tự động hiện lên cái form để a điền token các thứ mà ko bị lộ hoặc phải setup tay"

## Luật thực thi pipeline (áp dụng MỌI task)

1. **KHÔNG đụng file cũ** (§1: "Hệ thống cũ FastAPI ... giữ nguyên, KHÔNG sửa, KHÔNG xóa"): `server.py`, `manage.py`, `muse_client.py` (root — bản cũ), `smoke_test.py` (root — bản cũ), `static/`, `data/`, `Dockerfile`, `.gitignore`, `requirements.txt` (root). File mới nằm ở đường dẫn khác hẳn.
2. **`supabase/setup.sql` ĐÃ XONG bởi lead — KHÔNG đọc lại để sửa, KHÔNG đổi schema.**
3. **KHÔNG background process**: mọi lệnh dev/QA KHÔNG bao giờ append `&`, KHÔNG start server nền. `python -m http.server` (§9: "Chạy local: `python -m http.server` trong `web/`.") chạy **foreground ở terminal QA riêng**, tắt sau khi chụp xong. (Lệnh `nohup ... &` trong spec §7 là NỘI DUNG văn bản của `setup_guide.txt`, không phải lệnh pipeline thực thi.)
4. **KHÔNG secret trong repo/code/docs**: keys thật Supabase chỉ nằm ở `/mnt/d/AI/muse-relay/.cache/supabase.env` (biến `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`). Cấm sao chép giá trị key vào bất kỳ file nào (§8: "KHÔNG key thật trong code"; §4: "ZIP/txt KHÔNG được chứa secret nào (service key, password)").
5. **Thư mục chưa tồn tại**: `web/`, `web/templates/`, `.github/workflows/` — task đầu của mỗi stream tự `mkdir -p` thư mục cha của file mình tạo.
6. **3 stream chạy SONG SONG, không đụng chung file**; trong cùng stream chạy tuần tự theo số task (frontend T5→T6→T7; backend T1→T2 trước T3/T4). Stream docs tự do.
7. Spec §8 dùng dark theme "giống static/index.html cũ" — được phép ĐỌC `static/index.html` để tham khảo màu, KHÔNG được sửa file đó.
8. Spec không yêu cầu responsive/mobile — KHÔNG tự thêm. Layout desktop IDE theo §8.

---

## STREAM BACKEND — agent dev: `backend-architect`

### [x] TASK 1: muse_client.py — nhận tin (login, poll, inbox, cursor)
**Files thuộc quyền**:
- `web/templates/muse_client.py` (tạo mới)

**Yêu cầu (trích spec)**:
- §5: "Client chạy nền trên máy Muse, chỉ dùng `requests` + stdlib. Đọc `.env` (cờ `--env`, mặc định `.env`)."
- §4 contract .env — client đọc đúng các key: `SUPABASE_URL=`, `SUPABASE_ANON_KEY=`, `MUSE_EMAIL=`, `MUSE_PASSWORD=`, `CAPABILITIES=chat`, `POLL_INTERVAL=3  # giây, tối thiểu 2`.
- §3: "Login Muse: `POST {url}/auth/v1/token?grant_type=password` body `{\"email\",\"password\"}` → `access_token`, `user.id`. Access token hết hạn ~1h → client login lại khi gặp 401."
- §3: "Muse lấy project của mình: `GET /rest/v1/projects?select=id,muse_id,name,tags,email&user_id=eq.{uid}` (bearer access_token)."
- §5: "Khởi động: login → `GET projects?user_id=eq.{uid}` → banner `[#<project_id>] <muse_id> (<name>) đang nghe — tags=... — cursor=N`."
- §5 bước 1–2 của vòng lặp: "Lấy danh sách `threads?select=id&project_id=eq.{pid}` → poll `messages?thread_id=in.({ids cách nhau phẩy})&id=gt.{cursor}&order=id.asc&limit=500`." — "Tin `role='user'` → append JSONL vào `state/inbox.jsonl` (mỗi dòng 1 JSON: `{\"id\",\"thread_id\",\"role\",\"text\",\"created_at\"}`). Tin `role='muse'` bỏ qua (echo của mình)."
- §5 bước 3: "Ghi cursor `state/cursor.json` (`{\"after\": N}`) — ghi atomically (tmp + rename) SAU khi append."
- §4: "MUSE_EMAIL= # TRỐNG → Muse mở form cho owner điền (không in giá trị ra chat)" — client chỉ cần đọc .env; form là việc của Muse theo AGENTS.md/setup_guide, client KHÔNG tự vẽ form.

**Acceptance criteria (lệnh chạy được)**:
- `python3 -m py_compile web/templates/muse_client.py` → exit 0.
- `grep -c "grant_type=password" web/templates/muse_client.py` ≥ 1.
- `grep -c "thread_id=in.(" web/templates/muse_client.py` ≥ 1 và `grep -c "order=id.asc" web/templates/muse_client.py` ≥ 1 và `grep -c "limit=500" web/templates/muse_client.py` ≥ 1.
- `grep -c "inbox.jsonl" web/templates/muse_client.py` ≥ 1 và `grep -c "cursor.json" web/templates/muse_client.py` ≥ 1.
- `grep -c "đang nghe" web/templates/muse_client.py` ≥ 1 (banner đúng định dạng spec).
- Chỉ dùng `requests` + stdlib: `python3 -I -c "import ast,sys; tree=ast.parse(open('web/templates/muse_client.py').read()); mods={a.name.split('.')[0] for n in ast.walk(tree) if isinstance(n,ast.Import) for a in n.names} | {n.module.split('.')[0] for n in ast.walk(tree) if isinstance(n,ast.ImportFrom) and n.module}; bad=mods-{'requests'}-set(sys.stdlib_module_names); print('OK' if not bad else bad)"` → in `OK`.
- Không in secret: `grep -nE "print\(.*(MUSE_PASSWORD|password|access_token|ANON_KEY)" web/templates/muse_client.py` → không có dòng nào in giá trị (chỉ được phép tham chiếu tên biến).

**QA method (evidence-collector)**: chạy lại toàn bộ lệnh acceptance trên, lưu output + exit code; đọc code đối chiếu từng mũi §5 bước 1–3 (thứ tự append inbox → ghi cursor atomic). Hành vi runtime được chứng minh gián tiếp qua TASK 3 (mock chạy client thật).

---

### [x] TASK 2: muse_client.py — gửi tin (outbox, backoff, --once, thoát sạch)
**Files thuộc quyền**:
- `web/templates/muse_client.py` (tiếp tục từ TASK 1)

**Yêu cầu (trích spec)**:
- §5 bước 4: "Xử lý outbox: file `outbox/<thread_id>.txt` (sắp xếp theo mtime) — mỗi file = 1 reply cho thread đó → POST → thành công thì xóa file; lỗi 4xx (khác 401) → đổi tên `<tên>.err` (đừng retry vô hạn); 401 → login lại rồi thử lại 1 lần; lỗi mạng → giữ file, dừng vòng outbox, backoff."
- §3: "Reply: `POST /rest/v1/messages` body `{\"thread_id\":n,\"project_id\":n,\"role\":\"muse\",\"text\":\"...\"}` + `Prefer: return=minimal` → 201."
- §5: "Backoff lỗi mạng/5xx/429: 1,2,4,8,... tối đa 60s, reset khi thành công. Cờ `--once`: poll 1 lượt + đẩy outbox rồi thoát (cho cron)."
- §5: "vòng lặp mỗi `POLL_INTERVAL` giây (±jitter 0–0.5s)".
- §5: "KHÔNG in secret ra stdout. KeyboardInterrupt là lối thoát sạch."

**Acceptance criteria (lệnh chạy được)**:
- `python3 -m py_compile web/templates/muse_client.py` → exit 0.
- `grep -c "return=minimal" web/templates/muse_client.py` ≥ 1 (POST reply đúng Prefer header).
- `grep -c "outbox" web/templates/muse_client.py` ≥ 1 và `grep -c "getmtime" web/templates/muse_client.py` ≥ 1 (sắp xếp theo mtime).
- `grep -c "\.err" web/templates/muse_client.py` ≥ 1 (đổi tên lỗi 4xx).
- `grep -c "\-\-once" web/templates/muse_client.py` ≥ 1 (argparse cờ --once).
- `grep -c "KeyboardInterrupt" web/templates/muse_client.py` ≥ 1.
- Backoff max 60s: `grep -cE "min\(.*60|60\)" web/templates/muse_client.py` ≥ 1 (logic 1,2,4,8,...,60).
- Jitter: `grep -cE "random\.(uniform|randint)" web/templates/muse_client.py` ≥ 1.
- Re-login khi 401: `grep -cE "401" web/templates/muse_client.py` ≥ 1.

**QA method (evidence-collector)**: chạy lại acceptance greps + py_compile; đọc code đối chiếu 4 nhánh lỗi của §5 bước 4 (thành công / 4xx≠401 / 401 / lỗi mạng). Hành vi runtime thực chứng qua TASK 3 (mock test case outbox 201 + outbox 4xx).

---

### [x] TASK 3: test_client_mock.py — mock auth+postgrest local, chạy client thật PASS
**Files thuộc quyền**:
- `web/test_client_mock.py` (tạo mới)

**Yêu cầu (trích spec)**:
- §11.2: "`python3 web/test_client_mock.py` → tất cả PASS (mock auth+postgrest local, chạy client thật)."
- Mock phải mô phỏng đúng REST contract §3 mà client gọi: login `/auth/v1/token?grant_type=password`, `/rest/v1/projects`, `/rest/v1/threads`, `/rest/v1/messages` (GET poll + POST reply + `Prefer: return=minimal`).
- Mock chạy bằng stdlib (`http.server` trong thread, bind localhost), KHÔNG cần internet, KHÔNG cần package ngoài requests.

**Acceptance criteria (lệnh chạy được)**:
- `python3 -m py_compile web/test_client_mock.py` → exit 0.
- `python3 web/test_client_mock.py` → exit 0, stdout chứa chữ `PASS` cho từng case và tổng kết all-pass; toàn bộ request chỉ hướng về `http://127.0.0.1:<port>` (không có call ra ngoài).
- Case tối thiểu phải có (mỗi case 1 dòng PASS trên stdout):
  1. login + banner khởi động đúng §5;
  2. 2 tin `role='user'` → `state/inbox.jsonl` nhận đủ 2 dòng JSON đúng thứ tự `id.asc`, `role='muse'` echo bị bỏ qua;
  3. `state/cursor.json` = `{"after": <id tin lớn nhất>}` và được ghi SAU khi append (atomic);
  4. outbox 1 file → POST reply 201 (`Prefer: return=minimal`) → file bị xóa;
  5. outbox lỗi 4xx ≠ 401 → file đổi tên `.err`, không retry;
  6. stdout của client trong lúc test KHÔNG chứa password/secret (assert trong test).
- Dữ liệu test (state/, outbox/) nằm trong thư mục tmp của test, tự dọn sau khi chạy.

**QA method (evidence-collector)**: chạy `python3 web/test_client_mock.py` trong môi trường sạch, lưu stdout + exit code; grep stdout đếm số dòng PASS ≥ 6 case nêu trên.

---

### [x] TASK 4: smoke_test.py — smoke thật + RLS cách ly + dọn dẹp
**Files thuộc quyền**:
- `web/smoke_test.py` (tạo mới — KHÁC với `smoke_test.py` bản cũ ở root, không đụng file cũ)

**Yêu cầu (trích spec)**:
- §11.3: "`web/smoke_test.py` viết sẵn theo spec, chạy được khi có key thật: `python3 web/smoke_test.py --url <URL> --anon <ANON> --service <SERVICE>` — gồm test RLS cách ly (muse B KHÔNG đọc được messages của muse A, KHÔNG insert được vào thread của A) + dọn dẹp dữ liệu test."
- §2 RLS: "Muse (authenticated) chỉ SELECT projects/threads/messages của mình (`projects.user_id = auth.uid()`), chỉ INSERT messages `role='muse'` + project thuộc mình + `threads.project_id` khớp `project_id`."
- §3 admin: "Admin tạo Muse: `POST {url}/auth/v1/admin/users` body `{\"email\",\"password\",\"email_confirm\":true}` (service key) → `user.id`; rồi `POST /rest/v1/projects` body `{muse_id,name,tags,user_id,email,secret}` + `Prefer: return=representation`." — "Xóa Muse: `DELETE {url}/auth/v1/admin/users/{uid}` + `DELETE /rest/v1/projects?id=eq.{pid}` (cascade)."

**Acceptance criteria (lệnh chạy được)**:
- `python3 -m py_compile web/smoke_test.py` → exit 0.
- CLI 3 cờ: `grep -c "\-\-url" web/smoke_test.py` ≥ 1, `grep -c "\-\-anon" web/smoke_test.py` ≥ 1, `grep -c "\-\-service" web/smoke_test.py` ≥ 1.
- Tạo/xóa admin: `grep -c "admin/users" web/smoke_test.py` ≥ 2; login 2 muse: `grep -c "grant_type=password" web/smoke_test.py` ≥ 2.
- Cleanup: `grep -c "DELETE" web/smoke_test.py` ≥ 1.
- Case bắt buộc: (a) tạo muse A + muse B (admin, dữ liệu test tên phân biệt `smoke_*`); (b) A login, tạo thread, gửi message; (c) B login → GET messages của A → 0 dòng; (d) B POST message vào thread của A → bị từ chối (4xx); (e) B POST message bình thường vào project/thread của B → 201; (f) dọn dẹp: xóa toàn bộ user + project + dữ liệu test.

**QA method (evidence-collector)** — chạy THẬT với keys có sẵn (KHÔNG ghi key vào bất kỳ file nào):
```bash
set -a; . /mnt/d/AI/muse-relay/.cache/supabase.env; set +a
python3 web/smoke_test.py --url "$SUPABASE_URL" --anon "$SUPABASE_ANON_KEY" --service "$SUPABASE_SERVICE_KEY"
```
→ exit 0, mọi case PASS trong đó có 2 case RLS cách ly; log không chứa secret; sau khi chạy, query lại xác nhận không còn dữ liệu `smoke_*` trên Supabase.

---

## STREAM FRONTEND — agent dev: `frontend-developer` (chạy tuần tự T5→T6→T7)

### [x] TASK 5: index.html — khung trang + Settings + CDN + localStorage
**Files thuộc quyền**:
- `web/index.html` (tạo mới; `mkdir -p web` nếu chưa có)

**Yêu cầu (trích spec)**:
- §8: "Web UI (`web/index.html` — MỘT file, tiếng Việt, dark theme giống static/index.html cũ)".
- §8: "CDN: supabase-js v2 + JSZip v3 (jsdelivr, pin version). KHÔNG build step, KHÔNG key thật trong code."
- §8: "**Màn Settings (lần đầu/缺 key)**: 3 ô SUPABASE_URL / ANON_KEY / SERVICE_KEY (password input) + nút \"Kiểm tra kết nối\" (`GET /rest/v1/projects?select=id&limit=1` bằng service key) → lưu localStorage (`mr_supabase_url`, `mr_anon_key`, `mr_service_key`); lần sau vào thẳng."
- §8: "Mọi lỗi fetch → toast rõ ràng; 401/403 báo ngay."
- §1: web tĩnh, không server — mở được qua `python -m http.server` trong `web/`.

**Acceptance criteria (lệnh chạy được)**:
- `grep -c "cdn.jsdelivr.net" web/index.html` = 2 (supabase-js + jszip) và URL CDN có số version pin cụ thể (grep khớp `supabase-js@2` và `jszip@3`).
- `grep -c "mr_supabase_url" web/index.html` ≥ 1, `grep -c "mr_anon_key" web/index.html` ≥ 1, `grep -c "mr_service_key" web/index.html` ≥ 1.
- `grep -c "Kiểm tra kết nối" web/index.html` ≥ 1.
- `grep -c 'type="password"' web/index.html` ≥ 2 (ô ANON_KEY và SERVICE_KEY).
- `grep -c "rest/v1/projects?select=id&limit=1" web/index.html` ≥ 1 (endpoint kiểm tra kết nối đúng §8).
- Không key thật: `grep -cE "sb_publishable_[A-Za-z0-9]{8,}|sb_secret_[A-Za-z0-9]{8,}|eyJhbGciOi" web/index.html` = 0.
- Chưa có logic wizard/chat ở task này là bình thường — task này chỉ khung + Settings + toast; nhưng cấu trúc code phải để chỗ mở rộng cho T6/T7 (một file duy nhất).

**QA method (evidence-collector)**: chạy `python3 -m http.server 8000` foreground trong `web/` (terminal riêng, tắt sau khi xong); Playwright mở `http://localhost:8000` (localStorage trống) → màn Settings hiện 3 ô + nút; chụp screenshot làm bằng chứng; thu JS console → không có error; nhập URL/keys thật từ `.cache/supabase.env` → "Kiểm tra kết nối" thành công → reload trang vẫn nhận key từ localStorage (không hiện Settings lại).

---

### [x] TASK 6: index.html — layout agent-IDE + dữ liệu + realtime + composer
**Files thuộc quyền**:
- `web/index.html` (tiếp tục từ TASK 5)

**Yêu cầu (trích spec)**:
- §8: "**Layout kiểu agent-IDE (ZCode/Codex/Antigravity)**: sidebar trái (nút **＋ New**, ô search, thẻ project: name + muse_id + tag chips màu [chat=xanh dương, image=xanh lá, video=tím] + badge unread + preview tin cuối + thời gian tương đối; menu ⋮ per project: Token, Xóa) — khối phải: header project (name, muse_id, tag chips, chọn thread + nút ＋ Thread mới), vùng chat (bubble user phải/xanh, muse trái/xanh đậm, timestamp vi-VN, link Dropbox → card đính kèm ⬇), composer (textarea tự giãn, Enter gửi / Shift+Enter xuống dòng)."
- §8: "**Dữ liệu**: load đầu: `GET threads?select=id,project_id,title,last_read_id&order=id.asc` (service key) + `GET messages?select=id,project_id,thread_id,role,text,created_at&order=id.desc&limit=200` → dựng preview + unread client-side; realtime INSERT trên messages cập nhật chat mở + sidebar + unread; fallback refetch 30s. Mở thread: `GET messages?thread_id=eq.X&order=id.asc&limit=500` → render → PATCH last_read_id. Gửi: POST messages `{thread_id, project_id, role:'user', text}`. Thread mới: POST threads `{project_id, title}`."
- §3: "Realtime web UI: supabase-js `createClient(url, SERVICE_KEY)` + channel `postgres_changes` INSERT table `messages`."
- §3: "Link Dropbox trong text: nhận dạng `https://(www.)?dropbox.com/...` hoặc `https://dl.dropboxusercontent.com/...` → render thành card đính kèm (text giữ nguyên)."

**Acceptance criteria (lệnh chạy được)**:
- `grep -c "postgres_changes" web/index.html` ≥ 1.
- `grep -c "last_read_id" web/index.html` ≥ 2 (GET select + PATCH mark-read).
- `grep -c "dl.dropboxusercontent.com" web/index.html` ≥ 1 và `grep -c "dropbox.com" web/index.html` ≥ 1 (nhận dạng 2 mẫu link).
- Composer: `grep -c "shiftKey" web/index.html` ≥ 1 (Shift+Enter xuống dòng).
- `grep -c "Thread mới" web/index.html` ≥ 1; `grep -c "＋ New" web/index.html` ≥ 1.
- Tag chips 3 màu: `grep -ciE "chat" web/index.html` ≥ 1, `image` ≥ 1, `video` ≥ 1 (chips render từ tags của project; màu theo spec — kiểm tra visual qua screenshot).
- Không key thật trong code (grep như TASK 5) = 0.

**QA method (evidence-collector)**: seed dữ liệu thật qua service key (script REST nhỏ tạo project + thread + vài message `role='user'`/`role='muse'` tên `smoke_*`, DỌN SAU KHI CHỤP); mở web → sidebar hiện thẻ project đúng preview + unread; mở thread → bubbles user phải/muse trái, timestamp vi-VN; gõ tin → Enter gửi → message hiện + PATCH last_read_id xuất hiện trong network log; insert 1 message mới bằng service key → realtime cập nhật chat/sidebar không cần reload; chụp screenshot sidebar + chat; JS console sạch; cleanup dữ liệu `smoke_*` (DELETE admin user + project + cascade).

---

### [x] TASK 7: index.html — wizard New Muse + Token/Xóa + workflow Pages
**Files thuộc quyền**:
- `web/index.html` (tiếp tục từ TASK 6)
- `.github/workflows/pages.yml` (tạo mới; `mkdir -p .github/workflows`)

**Yêu cầu (trích spec)**:
- §8: "**Wizard New Muse (modal 3 bước)**: B1: muse_id (regex `^[a-z0-9_]{3,40}$`, check trùng live qua `GET projects?muse_id=eq.X`), name, 3 checkbox tags. B2: sinh password ngẫu nhiên 24 ký tự (crypto.getRandomValues base64url) → POST admin user → INSERT project → hiện email + password (nút copy) + cảnh báo \"lưu ngay, form của Muse sẽ hỏi\". B3: fetch templates từ `templates/` (path tương đối; nếu mở file:// fetch lỗi → cảnh báo chạy qua `python -m http.server`) → JSZip dựng `muse_<muse_id>_setup.zip` (muse_client.py, AGENTS.md, setup_guide.txt, `.env` ← env.template đã điền URL/ANON/CAPABILITIES, requirements.txt, run.sh, run.bat) → nút tải + textarea setup_guide.txt + nút copy + note \"gửi zip + nội dung txt này cho Muse\"."
- §8: "Project ⋮ → Token (modal email + secret, nút copy, GET projects?id=eq.X) / Xóa (confirm → DELETE admin user + project row)."
- §9: "`.github/workflows/pages.yml`: deploy thư mục `web/` lên GitHub Pages (push main + workflow_dispatch; dùng actions/configure-pages + upload-pages-artifact + deploy-pages)."
- §4 quy tắc điền .env trong zip: "thay đúng các dòng bắt đầu `SUPABASE_URL=`, `SUPABASE_ANON_KEY=`, `CAPABILITIES=chat` thành giá trị mới; MUSE_EMAIL/MUSE_PASSWORD giữ trống."

**Acceptance criteria (lệnh chạy được)**:
- Regex muse_id: `grep -c 'a-z0-9_]{3,40}' web/index.html` ≥ 1.
- Password 24 ký tự: `grep -c "getRandomValues" web/index.html` ≥ 1.
- Admin user: `grep -c "admin/users" web/index.html` ≥ 1; `grep -c "email_confirm" web/index.html` ≥ 1.
- Check trùng live: `grep -c "muse_id=eq." web/index.html` ≥ 1.
- JSZip + tên zip: `grep -c "JSZip" web/index.html` ≥ 1; `grep -c "muse_" web/index.html` ≥ 1 (tên `muse_<muse_id>_setup.zip`).
- Zip đủ 7 file: `grep -c "muse_client.py" web/index.html` ≥ 1, và `AGENTS.md`, `setup_guide.txt`, `env.template`, `requirements.txt`, `run.sh`, `run.bat` mỗi tên ≥ 1 lần trong code dựng zip.
- Cảnh báo file://: `grep -c "http.server" web/index.html` ≥ 1.
- Token modal: `grep -c "projects?id=eq." web/index.html` ≥ 1.
- pages.yml: `grep -c "actions/configure-pages" .github/workflows/pages.yml` ≥ 1; `grep -c "actions/upload-pages-artifact" .github/workflows/pages.yml` ≥ 1; `grep -c "actions/deploy-pages" .github/workflows/pages.yml` ≥ 1; `grep -c "workflow_dispatch" .github/workflows/pages.yml` ≥ 1; trigger push nhánh `main`; artifact trỏ đúng thư mục `web/`.
- .env trong zip KHÔNG chứa secret service: logic chỉ điền URL + ANON_KEY + CAPABILITIES (code review — grep `CAPABILITIES=` trong web/index.html ≥ 1).

**QA method (evidence-collector)**: Playwright — mở wizard: B1 render đúng 3 checkbox tags (chat/image/video) + muse_id sai regex bị chặn live; B2 tạo muse `smoke_*` THẬT qua Supabase (keys từ `.cache/supabase.env`) → màn hiện email + password + nút copy; B3 fetch templates (server http.server foreground đang chạy trong `web/`) → tải zip → `unzip -l muse_<id>_setup.zip` đúng 7 mục gồm `.env`; giải nén, đối chiếu `.env` đã điền URL/ANON/CAPABILITIES và MUSE_EMAIL/MUSE_PASSWORD trống; rồi dọn dẹp: xóa muse `smoke_*` qua modal Xóa (hoặc DELETE admin) — chụp screenshot từng bước B1/B2/B3 + lưu `unzip -l`.

---

## STREAM DOCS — agent dev: `technical-writer`

### [x] TASK 8: Bộ template vận hành — env.template, requirements.txt, run.sh, run.bat
**Files thuộc quyền**:
- `web/templates/env.template` (tạo mới)
- `web/templates/requirements.txt` (tạo mới)
- `web/templates/run.sh` (tạo mới)
- `web/templates/run.bat` (tạo mới)

**Yêu cầu (trích spec)**:
- §4 contract .env NGUYÊN VĂN (file `env.template` phải khớp 1:1):
```
# === Muse Relay client config ===
SUPABASE_URL=            # wizard điền sẵn
SUPABASE_ANON_KEY=       # wizard điền sẵn
MUSE_EMAIL=              # TRỐNG → Muse mở form cho owner điền (không in giá trị ra chat)
MUSE_PASSWORD=           # TRỐNG → Muse mở form cho owner điền
CAPABILITIES=chat        # wizard điền theo tag: chat,image,video
POLL_INTERVAL=3          # giây, tối thiểu 2
```
- §4: "ZIP/txt KHÔNG được chứa secret nào (service key, password)."
- §5: client "chỉ dùng `requests` + stdlib" → `requirements.txt` chỉ chứa `requests` (đừng pin version — spec không yêu cầu pin).
- §7: client chạy qua `run.sh` (Linux/macOS, kèm `python3 -m venv .venv` + `pip install -r requirements.txt`) và `run.bat` (Windows) — script tự chuẩn bị venv rồi chạy `muse_client.py`; `run.sh` phải đọc được `.env` theo cờ mặc định (client lo, script chỉ đảm bảo gọi đúng file).

**Acceptance criteria (lệnh chạy được)**:
- env.template đủ 6 key đúng thứ tự §4: `grep -cE "^(SUPABASE_URL|SUPABASE_ANON_KEY|MUSE_EMAIL|MUSE_PASSWORD|CAPABILITIES|POLL_INTERVAL)=" web/templates/env.template` = 6.
- `grep -c "POLL_INTERVAL=3" web/templates/env.template` = 1 và `grep -c "tối thiểu 2" web/templates/env.template` = 1.
- Không secret: `grep -cE "sb_publishable_|sb_secret_|eyJhbGciOi" web/templates/env.template` = 0.
- requirements.txt: `grep -cix "requests" web/templates/requirements.txt` = 1 và tổng số dòng không trống không comment = 1 (chỉ requests).
- run.sh cú pháp đúng: `bash -n web/templates/run.sh` → exit 0; `grep -c "muse_client.py" web/templates/run.sh` ≥ 1; `grep -c "\.venv" web/templates/run.sh` ≥ 1; `grep -c "requirements.txt" web/templates/run.sh` ≥ 1.
- run.bat: `grep -ci "muse_client.py" web/templates/run.bat` ≥ 1 và có logic venv/pip tương ứng Windows.

**QA method (evidence-collector)**: chạy toàn bộ lệnh trên, lưu output; đọc trực quan 4 file đối chiếu §4 + §7; kiểm file không chứa giá trị secret nào.

---

### [x] TASK 9: AGENTS.md (áp đặt Muse) + setup_guide.txt (hướng dẫn cài đặt)
**Files thuộc quyền**:
- `web/templates/AGENTS.md` (tạo mới)
- `web/templates/setup_guide.txt` (tạo mới)

**Yêu cầu (trích spec)**:
- §6 NGUYÊN VĂN 4 luật (AGENTS.md phải chứa đủ, tiếng Việt):
  - "**Luật tuyệt đối**: CẤM gửi ảnh/video/file/base64 trực tiếp qua reply chat. Mọi tài sản (ảnh, video, file) phải upload lên Dropbox của mình (kết nối native có sẵn) rồi trả về LINK trong text reply — ưu tiên link tải trực tiếp (`dl.dropboxusercontent.com` hoặc `?dl=1`), kèm mô tả ngắn."
  - "Giao thức inbox/outbox (đọc `state/inbox.jsonl`, ghi `outbox/<thread_id>.txt`), mỗi thread_id = một phiên hội thoại riêng giữ ngữ cảnh riêng."
  - "Cấm sửa `state/cursor.json`; cấm POLL_INTERVAL < 2; cấm chạy 2 client cùng lúc; client chết → chạy lại `run.sh` (tự restart), cursor persist nên không xử lý lại tin cũ."
  - "Mô tả năng lực theo `CAPABILITIES` trong .env: `chat` (chỉ trò chuyện), `image` (tạo/sửa ảnh → upload Dropbox → link), `video` (tạo video → upload Dropbox → link). Chỉ thực hiện năng lực được liệt kê."
- §7 NGUYÊN VĂN (setup_guide.txt): "Từng bước: giải nén → `python3 -m venv .venv` + `pip install -r requirements.txt` → đọc `.env`: giá trị TRỐNG (MUSE_EMAIL, MUSE_PASSWORD) thì **mở form cho owner điền** (không yêu cầu dán token vào chat, không in giá trị sau khi điền) → chạy nền: `nohup bash run.sh >/dev/null 2>&1 &` hoặc systemd unit mẫu (kèm trong txt) hoặc Windows `run.bat` → xác nhận banner \"đang nghe\" → chờ owner gửi tin thử → trả lời thử qua outbox → đọc kỹ AGENTS.md. Giải thích POLL_INTERVAL và xử lý khi polling chết."

**Acceptance criteria (lệnh chạy được)**:
- AGENTS.md: `grep -c "CẤM" web/templates/AGENTS.md` ≥ 1; `grep -c "Dropbox" web/templates/AGENTS.md` ≥ 2; `grep -c "dl.dropboxusercontent.com" web/templates/AGENTS.md` ≥ 1; `grep -c "inbox.jsonl" web/templates/AGENTS.md` ≥ 1; `grep -c "outbox/" web/templates/AGENTS.md` ≥ 1; `grep -c "cursor.json" web/templates/AGENTS.md` ≥ 1; `grep -c "POLL_INTERVAL" web/templates/AGENTS.md` ≥ 1; `grep -c "CAPABILITIES" web/templates/AGENTS.md` ≥ 1.
- setup_guide.txt: `grep -c "python3 -m venv .venv" web/templates/setup_guide.txt` ≥ 1; `grep -c "requirements.txt" web/templates/setup_guide.txt` ≥ 1; `grep -c "run.sh" web/templates/setup_guide.txt` ≥ 1; `grep -c "run.bat" web/templates/setup_guide.txt` ≥ 1; `grep -ci "systemd" web/templates/setup_guide.txt` ≥ 1 (unit mẫu kèm trong txt); `grep -c "đang nghe" web/templates/setup_guide.txt` ≥ 1; `grep -c "AGENTS.md" web/templates/setup_guide.txt` ≥ 1; `grep -c "POLL_INTERVAL" web/templates/setup_guide.txt` ≥ 1; giải thích polling chết: `grep -ciE "polling chết|client chết|chết" web/templates/setup_guide.txt` ≥ 1.
- Không secret: `grep -cE "sb_publishable_|sb_secret_|eyJhbGciOi" web/templates/AGENTS.md web/templates/setup_guide.txt` = 0 (cả hai file).
- `MUSE_EMAIL`/`MUSE_PASSWORD` được nhắc đúng vai trò "form cho owner điền": `grep -c "MUSE_EMAIL" web/templates/setup_guide.txt` ≥ 1, `grep -c "MUSE_PASSWORD" web/templates/setup_guide.txt` ≥ 1.

**QA method (evidence-collector)**: chạy toàn bộ greps, lưu output; đọc trực quan 2 file: tiếng Việt trọn vẹn, đúng 4 luật §6, đúng trình tự từng bước §7, systemd unit mẫu có sẵn trong txt, không có placeholder secret.

---

### [x] TASK 10: README.md — viết lại + giữ nội dung cũ làm phụ lục
**Files thuộc quyền**:
- `README.md` (root — CHỈ task này được phép sửa README)

**Yêu cầu (trích spec)**:
- §10: "`README.md` | docs (viết lại; giữ nội dung cũ ở cuối dưới tiêu đề \"Phụ lục — phương án cũ (FastAPI có server)\")".
- §11.5: "README đủ các mục: kết nối Supabase 3 phút, deploy Pages, tạo Muse, giao thức client, bảo mật."
- §9: "README ghi chú: Settings → Pages → Source: GitHub Actions."
- §1 kiến trúc mới + §4 contract .env + §5 giao thức inbox/outbox + §6/§7 con trỏ tới AGENTS.md/setup_guide.txt — mô tả ngắn gọn, KHÔNG sao chép nguyên cả spec.

**Acceptance criteria (lệnh chạy được)**:
- Phụ lục: `grep -c "Phụ lục — phương án cũ (FastAPI có server)" README.md` = 1.
- Nội dung cũ còn nguyên dưới phụ lục (các câu đặc trưng của README cũ 106 dòng): `grep -c "Server chuyển tiếp tin nhắn giữa" README.md` ≥ 1 và `grep -c "long-poll tin mới rồi tự trả lời" README.md` ≥ 1.
- Mục mới đủ: `grep -ciE "kết nối Supabase" README.md` ≥ 1; `grep -ci "GitHub Pages" README.md` ≥ 1; `grep -c "Settings → Pages → Source: GitHub Actions" README.md` ≥ 1; `grep -ciE "tạo Muse|New Muse" README.md` ≥ 1; `grep -ciE "giao thức" README.md` ≥ 1; `grep -ciE "bảo mật" README.md` ≥ 1.
- Mô tả kiến trúc mới: `grep -c "muse_client.py" README.md` ≥ 1 và `grep -ci "supabase" README.md` ≥ 3.
- Không secret: `grep -cE "sb_publishable_[A-Za-z0-9]{8,}|sb_secret_[A-Za-z0-9]{8,}|eyJhbGciOi" README.md` = 0.

**QA method (evidence-collector)**: chạy greps; xác nhận bằng cấu trúc: phần mới ở đầu, tiêu đề phụ lục, rồi toàn bộ nội dung README cũ (đối chiếu độ dài: tổng dòng README mới > 106 dòng cũ); lưu screenshot/head README làm bằng chứng.

---

## STREAM TÍCH HỢP

### [x] TASK 11: Contract chéo khớp giữa các file
**Agent**: `code-reviewer` (review-only; nếu lệch contract thì BÁO và stream chủ quản sửa, reviewer chạy lại checklist đến khớp 100%)
**Files thuộc quyền**: KHÔNG sửa file — chỉ ĐỌC toàn bộ: `web/templates/muse_client.py`, `web/smoke_test.py`, `web/test_client_mock.py`, `web/index.html`, `.github/workflows/pages.yml`, `web/templates/AGENTS.md`, `web/templates/setup_guide.txt`, `web/templates/env.template`, `web/templates/requirements.txt`, `web/templates/run.sh`, `web/templates/run.bat`, `README.md`.

**Yêu cầu (trích spec)**:
- §11.6: "Contract chéo khớp 100%: tên field, endpoint, key .env, tên file trong zip."

**Checklist lệnh chạy được (mỗi lệnh phải ra kết quả mong đợi)**:
- Endpoint login khớp client + smoke: `grep -l "auth/v1/token?grant_type=password" web/templates/muse_client.py web/smoke_test.py` → cả 2 file.
- Endpoint admin khớp smoke + wizard: `grep -l "auth/v1/admin/users" web/smoke_test.py web/index.html` → cả 2.
- REST projects/threads/messages: `grep -l "rest/v1/projects" web/templates/muse_client.py web/smoke_test.py web/index.html`; `grep -l "rest/v1/messages" web/templates/muse_client.py web/smoke_test.py web/index.html`; `grep -l "rest/v1/threads" web/templates/muse_client.py web/index.html` → đủ file theo spec.
- Key .env khớp 4 nơi (env.template ↔ client ↔ wizard điền zip ↔ setup_guide): `grep -l "SUPABASE_URL" web/templates/env.template web/templates/muse_client.py web/index.html web/templates/setup_guide.txt` → cả 4; `grep -l "MUSE_EMAIL" web/templates/env.template web/templates/muse_client.py web/templates/setup_guide.txt web/index.html` → cả 4; `grep -l "CAPABILITIES" web/templates/env.template web/templates/muse_client.py web/templates/AGENTS.md web/index.html` → cả 4.
- Field chốt: `grep -l "last_read_id" web/index.html web/templates/muse_client.py` (client ghi cursor local riêng — last_read_id là của PATCH web; nếu client không dùng last_read_id thì đó KHÔNG là lệch: đối chiếu spec §3 PATCH là việc của web UI); `grep -l "role='muse'\|\"role\":\"muse\"\|role='user'\|\"role\":\"user\"" web/templates/muse_client.py web/index.html web/smoke_test.py` → đủ 3; `grep -l "return=minimal" web/templates/muse_client.py web/index.html` (client reply + web gửi tin đều dùng Prefer chuẩn PostgREST) — web có thể gửi không cần Prefer: chỉ bắt buộc client; reviewer đối chiếu spec §3 từng dòng REST contract.
- Tên file zip khớp templates thật: code dựng zip trong `web/index.html` phải liệt kê đúng 7 file và thư mục `web/templates/` trên đĩa chứa đúng các file đó (`ls web/templates` = AGENTS.md, env.template, muse_client.py, requirements.txt, run.bat, run.sh, setup_guide.txt).
- Banner khớp client ↔ setup_guide: `grep -l "đang nghe" web/templates/muse_client.py web/templates/setup_guide.txt` → cả 2.
- localStorage khớp Settings ↔ mọi nơi dùng key: `mr_supabase_url`, `mr_anon_key`, `mr_service_key` chỉ xuất hiện với đúng 3 tên này trong `web/index.html`.
- Regex muse_id + password 24 ký tự chỉ nằm ở wizard (`web/index.html`) khớp spec §8.

**Acceptance criteria**: toàn bộ checklist trên ra kết quả mong đợi; mọi điểm lệch được ghi rõ (file, dòng, spec §nào) và chuyển stream chủ quản sửa; sau vòng sửa, reviewer chạy lại toàn bộ checklist → 100% khớp.

**QA method (evidence-collector)**: tự chạy lại toàn bộ checklist, lưu từng lệnh + output; báo ĐẠT chỉ khi mọi lệnh khớp.

---

### [x] TASK 12: Final integration reality-check
**Agent**: `reality-checker` (không sửa code; chỉ chạy verification toàn bộ Definition of Done và báo từng mục Đạt/Chưa; mục Chưa được trả về stream chủ quản rồi chạy lại)
**Files thuộc quyền**: KHÔNG sửa file — chỉ thực thi verification.

**Yêu cầu (trích spec)** — §11 "Definition of Done + Verification" NGUYÊN VĂN 6 mục:
1. "`python3 -m py_compile web/templates/muse_client.py web/smoke_test.py web/test_client_mock.py` sạch."
2. "`python3 web/test_client_mock.py` → tất cả PASS (mock auth+postgrest local, chạy client thật)."
3. "`web/smoke_test.py` viết sẵn theo spec, chạy được khi có key thật: `python3 web/smoke_test.py --url <URL> --anon <ANON> --service <SERVICE>` — gồm test RLS cách ly (muse B KHÔNG đọc được messages của muse A, KHÔNG insert được vào thread của A) + dọn dẹp dữ liệu test."
4. "UI: mở qua http.server, screenshot màn Settings (bằng chứng Playwright), không có JS error console; wizard B1 render đúng 3 tags."
5. "README đủ các mục: kết nối Supabase 3 phút, deploy Pages, tạo Muse, giao thức client, bảo mật."
6. "Contract chéo khớp 100%: tên field, endpoint, key .env, tên file trong zip."

**Acceptance criteria (lệnh chạy được, từng mục DoD)**:
- DoD 1: `python3 -m py_compile web/templates/muse_client.py web/smoke_test.py web/test_client_mock.py` → exit 0, không output lỗi.
- DoD 2: `python3 web/test_client_mock.py` → exit 0 + all PASS.
- DoD 3: `set -a; . /mnt/d/AI/muse-relay/.cache/supabase.env; set +a; python3 web/smoke_test.py --url "$SUPABASE_URL" --anon "$SUPABASE_ANON_KEY" --service "$SUPABASE_SERVICE_KEY"` → exit 0, gồm 2 case RLS cách ly PASS, cleanup xong (KHÔNG ghi key vào file báo cáo).
- DoD 4: `python3 -m http.server 8000` foreground trong `web/` (terminal riêng) → Playwright chụp màn Settings + wizard B1 (3 checkbox tags) → bằng chứng PNG + console không JS error.
- DoD 5: greps mục README của TASK 10 tất cả khớp.
- DoD 6: checklist TASK 11 tất cả khớp.
- Bằng chứng không đụng file cũ: `ls -la server.py manage.py muse_client.py smoke_test.py Dockerfile .gitignore requirements.txt` + `ls static data` — so với trạng thái trước pipeline (orchestrator khuyến nghị lưu `md5sum` các file cũ TRƯỚC khi chạy pipeline để đối chiếu sau).

**QA method (evidence-collector)**: tổng hợp bằng chứng từng mục DoD thành bảng Đạt/Chưa kèm lệnh + output; chỉ chốt project DONE khi cả 6 mục Đạt. Báo cáo KHÔNG chứa secret/key.

---

## Quality Requirements (bắt buộc toàn pipeline)

- [ ] KHÔNG background process — cấm append `&` trong mọi lệnh dev/QA (nội dung văn bản trong `setup_guide.txt` trích spec là ngoại lệ — đó là nội dung file, không phải lệnh thực thi).
- [ ] KHÔNG start server lâu dài; `python -m http.server` chỉ chạy foreground trong phiên QA, tắt ngay sau khi chụp.
- [ ] KHÔNG secret/key trong bất kỳ file nào của repo (code, docs, README, tasklist, báo cáo). Keys thật chỉ đọc từ `/mnt/d/AI/muse-relay/.cache/supabase.env` tại runtime.
- [ ] KHÔNG đụng file cũ: `server.py`, `manage.py`, `muse_client.py` (root), `smoke_test.py` (root), `static/`, `data/`, `Dockerfile`, `.gitignore`, `requirements.txt` (root), `supabase/setup.sql`.
- [ ] Toàn bộ UI + comment + docs bằng tiếng Việt (§0 header).
- [ ] Mỗi file mới đúng chủ trì theo bảng §10 của spec — không stream nào đụng file của stream khác.
- [ ] Mỗi task hoàn thành trong 1 lượt dev + QA (kích thước 30–60 phút).

## Technical Notes

**Stack (trích spec §1)**: Python 3.10 + requests (client — "chỉ dùng `requests` + stdlib"), web tĩnh HTML/JS thuần (supabase-js v2 + JSZip v3 qua jsdelivr pin version, KHÔNG build step), Node 22 + Chrome + Playwright có sẵn cho QA UI, GitHub Pages deploy qua Actions.

**Lưu ý cho evidence-collector**: keys thật nằm ở `/mnt/d/AI/muse-relay/.cache/supabase.env` (biến `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`) — dùng để chạy smoke thật + seed/dọn dữ liệu UI test; tuyệt đối không in/sao chép giá trị key vào bằng chứng.

**Timeline**: spec không đặt deadline — 12 task, mỗi task 1 lượt dev+QA; 3 stream dev chạy song song, 2 task tích hợp chạy cuối theo trình tự T11 → T12.
