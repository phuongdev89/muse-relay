[English](setup-guide.md) | **Tiếng Việt**

# Hướng dẫn Cài đặt, Triển khai & Vận hành

Tài liệu này hướng dẫn từng bước cài đặt **Muse Relay** từ đầu, triển khai backend trên Supabase, chạy Express server và React dashboard ở môi trường dev hoặc production, onboard agent, và chạy suite kiểm thử nghiệm thu.

---

## 1. Yêu cầu hệ thống

| Thành phần | Ghi chú |
|---|---|
| **Node.js >= 20.11** và **npm** | Bắt buộc vì `server/src/index.ts` và `server/src/env.ts` sử dụng `import.meta.dirname` (có từ Node 20.11). Kiểm tra bằng `node -v`. |
| **Project Supabase** | Tạo project trên [Supabase](https://supabase.com/). Cần chuẩn bị Project URL, Publishable key, Secret (service role) key và Personal Access Token (`sbp_...`). |
| **Dropbox Scoped App** *(tuỳ chọn)* | Chỉ cần nếu muốn preview file Dropbox và kéo-thả upload file (tối đa 50 MB) trực tiếp trên dashboard. |
| **Git Bash + Python 3** *(trên Windows)* | Cần thiết để chạy `scripts/deploy-functions.sh` và `scripts/acceptance-tests.sh` (`bash`, `curl`, `openssl`, `python`). |

---

## 2. Cấu hình biến môi trường (`.env`)

Sao chép [`.env.example`](../.env.example) thành `.env` ở thư mục gốc:

```bash
cp .env.example .env
```

> Không bao giờ commit `.env` (đã được git-ignore) và không dán secret key hay `RELAY_TOKEN` vào chat, log hoặc ảnh chụp màn hình.

### Giải thích đầy đủ 14 biến môi trường

#### Nền tảng Supabase & Relay

| Biến | Dùng bởi | Ý nghĩa |
|---|---|---|
| `SUPABASE_URL` | `server/`, scripts | Project URL (`https://<project-ref>.supabase.co`), cấp cho SPA lúc runtime qua `GET /api/config`. |
| `SUPABASE_PUBLISHABLE_KEY` | `server/`, scripts | Khóa công khai của Supabase, cấp cho SPA qua `GET /api/config`. Bảo mật thực sự dựa trên RLS + JWT + relay token. |
| `SUPABASE_SECRET_KEY` | `scripts/acceptance-tests.sh` | Service role key (**tuyệt mật**). Chỉ dùng cho admin script và suite test dọn dẹp dữ liệu; không bao giờ gửi xuống trình duyệt. |
| `SUPABASE_ACCESS_TOKEN` | `scripts/deploy-functions.sh`, CLI | Personal access token (`sbp_...` lấy ở Supabase Account → Access Tokens) để deploy Edge Functions và chạy migration. |

#### Owner & Secret cho Edge Functions

| Biến | Dùng bởi | Ý nghĩa |
|---|---|---|
| `RELAY_OWNER_ID` | Edge Functions, `server/` | UUID tài khoản owner trên Supabase Auth. Cả `submit_message` lẫn `server/src/auth.ts` (`requireOwnerAuth`) đều từ chối JWT của user khác. |
| `RELAY_SIGNING_SECRET` | Edge Functions | Secret HMAC-SHA256 (`openssl rand -hex 32`) chỉ lưu trong Supabase secrets. Dùng để ký bản tin khi `submit_message` và kiểm lại khi `claim_message`. |

#### Credential Muse mẫu (chỉ dùng cho Acceptance Suite)

| Biến | Dùng bởi | Ý nghĩa |
|---|---|---|
| `RELAY_TOKEN` | `scripts/acceptance-tests.sh` | Token giả lập Muse khi chạy test (`openssl rand -hex 32`). Server chỉ đối chiếu SHA-256 với cột `relay_muses.token_hash`. |
| `RELAY_RECIPIENT_ID` | `scripts/acceptance-tests.sh` | UUID `recipient` của Muse test tương ứng trong `relay_muses`. |

#### Express Server & Dashboard (`server/`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3000` | Cổng HTTP cho `server/` (phục vụ `/api/*` và `dashboard/dist/` ở production). |
| `OWNER_DISPLAY_NAME` | `Owner` | Tên hiển thị của owner do `GET /api/config` trả về cho giao diện dashboard. |

#### Dropbox OAuth Credentials (`server/`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `DROPBOX_APP_KEY` | — | App Key từ Dropbox App Console (`Scoped App` → `Full Dropbox`). |
| `DROPBOX_APP_SECRET` | — | App Secret dùng để làm mới OAuth access token. |
| `DROPBOX_REFRESH_TOKEN` | — | Refresh Token không hết hạn; `server/` tự cache access token trong RAM và tự refresh trước khi hết hạn. |
| `DROPBOX_ACCESS_TOKEN` | — | Access Token tĩnh/tạm thời (4 giờ), tuỳ chọn dự phòng khi không dùng bộ refresh credentials. |

Cách bật quyền trên [Dropbox App Console](https://www.dropbox.com/developers/apps):
1. Tạo **Scoped App** với phạm vi **Full Dropbox**.
2. Trong tab **Permissions**, bật `files.metadata.read`, `files.content.read`, và `files.content.write`.
3. Lấy Refresh Token (khuyên dùng) hoặc Generate Access Token, điền vào `.env` rồi khởi động lại `server/`.

---

## 3. Thiết lập Supabase

### 3.1 Tạo tài khoản Owner & tắt đăng ký công khai

1. Vào **Supabase Dashboard → Authentication → Users**, tạo tài khoản owner (email + password).
2. Sao chép **UUID** của user đó và điền vào `RELAY_OWNER_ID` trong `.env`.
3. Vào **Authentication → Sign In / Providers** và tắt **Allow new users to sign up** để ngăn người ngoài tự đăng ký.

### 3.2 Chạy tất cả 10 migrations

Thư mục [`supabase/migrations/`](../supabase/migrations/) gồm **10 migration SQL strictly additive**:

1. `20261127000000_relay.sql` — bảng `relay_messages`, `relay_results`, bucket riêng tư `relay-inputs`, RLS owner select.
2. `20261127000100_relay_chat.sql` — đảm bảo check constraint `action` cho phép `chat`, `image`, `video`.
3. `20261127000200_recipient_hash.sql` — cho phép `recipient` dạng UUID chữ thường bên cạnh `'nyx'`.
4. `20261127000300_relay_muses.sql` — bảng registry `relay_muses` (`token_hash` SHA-256, `dropbox_root`, RLS owner full).
5. `20261127000400_relay_groups.sql` — bảng `relay_groups`, `relay_group_members`, `relay_group_posts`.
6. `20261127000500_relay_muses_last_claim.sql` — thêm cột heartbeat `last_claim_at` cho `relay_muses`.
7. `20261127000550_relay_projects.sql` — các bảng v7 (`relay_agents_openai`, `relay_projects`, `relay_project_agents`, `relay_conversations`, `relay_openai_messages`).
8. `20261127000600_cleanup_legacy_and_owner_delete.sql` — cấp quyền `DELETE` cho owner trên `relay_messages`/`relay_results` và dọn dữ liệu cũ trước v7.
9. `20261127000700_muse_connection_state.sql` — thêm `setup_done`, `first_connected_at`, `last_result_at`, `token_rotated_at` + trigger `trg_relay_muses_connection_state`.
10. `20261127000800_relay_muses_email_owner.sql` — thêm cột metadata `email_owner` cho `relay_muses`.

Chạy qua Supabase CLI:

```bash
npx --yes supabase login
npx --yes supabase link --project-ref <your-project-ref>
npx --yes supabase db push
```

*(Hoặc mở **Supabase Dashboard → SQL Editor** và chạy lần lượt từng file từ `000000` đến `000800`.)*

### 3.3 Đặt 2 secret cho Edge Functions

Supabase chỉ cần đúng **2 secret**:

```bash
npx --yes supabase secrets set \
  RELAY_SIGNING_SECRET="<chuỗi-64-ký-tự-hex>" \
  RELAY_OWNER_ID="<uuid-user-owner>"
```

### 3.4 Deploy 3 Edge Functions

Chạy [`scripts/deploy-functions.sh`](../scripts/deploy-functions.sh) (đọc `SUPABASE_URL` và `SUPABASE_ACCESS_TOKEN` từ `.env`):

```bash
bash scripts/deploy-functions.sh
```

Lệnh này deploy `submit_message` (`verify_jwt = true`), `claim_message` (`verify_jwt = false`), và `submit_result` (`verify_jwt = false`) theo cấu hình trong [`supabase/config.toml`](../supabase/config.toml). *(Lưu ý: hàm `dropbox_proxy` cũ đã được gỡ bỏ và chuyển vào `server/`.)*

---

## 4. Chạy Dev & Build Production

Tất cả các script gốc nằm trong [`package.json`](../package.json):

```bash
# 1. Cài đặt dependencies cho cả server/ và dashboard/
npm run install:all

# 2. Kiểm tra TypeScript (server/ và dashboard/)
npm run typecheck

# 3. Chạy chế độ dev (Express :3000 + Vite HMR :5173 với proxy /api)
npm run dev
```

Cho môi trường **production** (chạy một cổng duy nhất phục vụ cả `/api/*` lẫn `dashboard/dist/`):

```bash
npm run build
npm start
```

Truy cập `http://localhost:5173` (dev) hoặc `http://localhost:3000` (production) và đăng nhập bằng tài khoản owner.

---

## 5. Sử dụng Dashboard

### 5.1 Onboard một Muse mới (`AddMuseWizard`)

1. Tại **Tổng quan** hoặc **Quản trị Agent**, bấm **Thêm Muse**.
2. Nhập **Tên Muse** và **Email sở hữu Muse** (ví dụ `alice@example.com`).
   - Dropbox root tự động sinh theo dạng `/<email-chữ-thường>/` (ví dụ `/alice@example.com/`) — không cần tự gõ dấu `/`.
3. Bấm **Tạo**. Wizard tạo `recipient` UUID + `RELAY_TOKEN` 64-hex, băm SHA-256 trên trình duyệt và lưu hash vào `relay_muses`.
4. Bước 2 hiển thị **hai khung tách biệt**:
   - **Khung RELAY_TOKEN**: Sao chép token và dán vào **Secure Vault** của Muse. Token chỉ hiện **đúng một lần** và không bao giờ nằm trong hướng dẫn.
   - **Khung Hướng dẫn chuẩn**: Sao chép gửi cho Muse để nó dựng endpoint `claim_message`, `submit_result`, `dropbox_root`, và lịch poll 10 giây / watchdog 10 phút.
5. **Khóa `setup_done` ban đầu**: Trước khi Muse thực hiện lần gọi `claim_message` xác thực đầu tiên (`setup_done = true`), thanh soạn tin trong phòng 1:1 sẽ bị khóa kèm banner chờ kết nối. Ngay khi Muse poll lần đầu, `claim_message` đặt `setup_done = true` và `last_claim_at`, dashboard tự mở khóa sau chu kỳ refresh 10 giây.

### 5.2 Rotate token, Đổi tên, Xóa lịch sử & Xóa Muse

- Trong **Quản trị Agent** hoặc menu **Quản lý ▾** ở phòng Muse:
  - **Đổi tên**: Cập nhật `relay_muses.name` và đồng bộ `agent_name` trong `relay_project_agents`.
  - **Rotate token**: Sinh token mới, cập nhật `token_hash` và `token_rotated_at`. Token cũ mất hiệu lực ngay (`401`); UI hiển thị trạng thái **Đang kết nối lại** cho tới khi Muse poll bằng token mới.
  - **Xóa lịch sử** *(trong phòng Muse 1:1)*: Xóa các `relay_messages` / `relay_results` trực tiếp của Muse đó.
  - **Xóa Muse**: Xóa hàng trong `relay_muses` (thu hồi quyền claim/submit ngay lập tức) và gỡ khỏi các project/nhóm.

### 5.3 Cấu hình Agent tương thích OpenAI

1. Vào **Quản trị Agent** → **Thêm Agent OpenAI**.
2. Điền **Tên**, **Base URL** (ví dụ `https://api.openai.com/v1`), **Model**, **API Key**, và **System Prompt** (tuỳ chọn).
3. Bấm **Kiểm tra kết nối** để gọi thử `/chat/completions` qua `POST /api/openai/test` (timeout 20 giây phía server, tránh giới hạn CORS trình duyệt).

### 5.4 Projects & Conversations

Bấm **+ Project mới** ở thanh **Sidebar** bên trái (`ProjectWizard`), gán các agent Muse hoặc OpenAI vào project, sau đó tạo **Hội thoại** (`NewConversationModal`) theo một trong 4 chế độ:

| Chế độ | Hoạt động |
|---|---|
| `muse_single` | Luồng 1:1 với một Muse (`chat`, `image`, `video` + tối đa 4 file đính kèm Dropbox ≤ 50 MB). |
| `muse_group` | Nhóm chat do owner khởi xướng qua `relay_groups`. `submit_result` tự fan-out sang các Muse thành viên khác tối đa `GROUP_TURN_LIMIT = 12` lượt. |
| `openai` | Gọi proxy `POST /api/openai/chat` phía server tới các agent OpenAI, lưu lịch sử tại `relay_openai_messages`. |
| `mixed` | Phát đồng thời mỗi tin nhắn của owner tới cả Muse Relay lẫn OpenAI agents trong cùng một dòng thời gian hợp nhất. |

---

## 6. Chạy Acceptance Tests & Xử lý sự cố

### 6.1 Chạy suite nghiệm thu live

[`scripts/acceptance-tests.sh`](../scripts/acceptance-tests.sh) chạy **53 assertions** trực tiếp trên project Supabase live, dùng thư mục tạm cô lập (không để lại file rác trong repo) và tự dọn sạch các bản ghi test:

```bash
bash scripts/acceptance-tests.sh
```

Kết quả mong đợi ở cuối log:

```text
RESULT: PASS=53 FAIL=0
```

> **Lưu ý**: Đảm bảo `RELAY_TOKEN` và `RELAY_RECIPIENT_ID` trong `.env` khớp với một hàng hợp lệ trong `relay_muses` trước khi chạy suite.

### 6.2 Xử lý sự cố thường gặp

| Triệu chứng | Nguyên nhân & Cách khắc phục |
|---|---|
| **`GET /api/config` báo `dropboxConfigured: false` hoặc upload trả `503 dropbox_not_configured`** | Điền `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, và `DROPBOX_REFRESH_TOKEN` (hoặc `DROPBOX_ACCESS_TOKEN` tạm thời) vào `.env` rồi restart `server/`. Kiểm tra Dropbox App đã bật `files.metadata.read`, `files.content.read`, `files.content.write`. |
| **API hoặc Edge Function trả `401` / `403 forbidden`** | Kiểm tra tài khoản đăng nhập có khớp đúng UUID `RELAY_OWNER_ID` trong `.env` và `supabase secrets` hay không. Với Muse (`claim_message` / `submit_result`), kiểm tra `x-relay-token` có khớp hash SHA-256 trong `relay_muses`. |
| **Phòng chat Muse 1:1 bị khóa ("Chờ Muse kết nối")** | `relay_muses.setup_done` vẫn là `false`. Kiểm tra Muse đã có đúng `SUPABASE_URL` và `RELAY_TOKEN` trong vault chưa và đã gọi `POST /functions/v1/claim_message` ít nhất một lần chưa. |
| **Kiểm tra khớp hash SHA-256 của `RELAY_TOKEN` cục bộ** | Chạy lệnh local (token không gửi ra ngoài):<br>`python -c "import hashlib; print(hashlib.sha256(input().encode()).hexdigest())"`<br>rồi đối chiếu với `select token_hash from public.relay_muses where name = '<Tên Muse>';` trong SQL Editor. |
| **Lỗi Node `import.meta.dirname` là `undefined`** | Nâng cấp Node.js lên phiên bản **>= 20.11** (`node -v`). |
| **Lỗi trên Windows khi chạy file `.sh`** | Chạy `bash scripts/...` bằng **Git Bash** và đảm bảo **Python 3** (`python`) có sẵn trong `PATH`. |
