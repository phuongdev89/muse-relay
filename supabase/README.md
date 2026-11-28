# Supabase Relay cho Muse

Luồng tổng thể: owner đăng nhập Supabase Auth trên Dashboard → gọi `submit_message` → Edge Function kiểm tra JWT, đối chiếu `RELAY_OWNER_ID`, validate tham số và ký HMAC-SHA256 → Muse poll `claim_message` bằng `x-relay-token` riêng (hash SHA-256 tra cứu trong `relay_muses`), xử lý tác vụ, tải tài nguyên (nếu có) lên Dropbox root riêng (`/<email>/`) → Muse gọi `submit_result` → Dashboard đọc trạng thái và kết quả từ `relay_messages` / `relay_results` qua RLS. Mọi tên file tài nguyên đều có tiền tố `yyyy-mm-dd_hh-mm-ss_<slug>` theo múi giờ `Asia/Bangkok`.

Phạm vi thực thi được khóa cứng: `action` chỉ gồm `chat`, `image` hoặc `video` theo schema cố định. `chat` là action đầy đủ tính năng trong phạm vi relay: nếu nội dung yêu cầu tạo tài nguyên ảnh/video hoặc tài liệu an toàn (`md`, `txt`, `csv`, `docx`, `xlsx`) hay `zip` chỉ chứa các file an toàn vừa tạo, kết quả trả về gồm cả `output.text` và `output.dropbox_paths`; nếu chỉ hội thoại, kết quả chỉ có `output.text`. Mọi tác vụ ngoài phạm vi (deploy, cấp quyền, truy cập tài khoản, thao tác file tùy ý hay chạy code) đều bị từ chối với `error_code: "out_of_scope"`. Secret key của Supabase không rời khỏi Supabase; Muse chỉ giữ `RELAY_TOKEN` riêng trong Secure Vault.

> Xem thêm: [Hướng dẫn Cài đặt & Vận hành](../docs/setup-guide.vi.md) · [Architecture Reference](../docs/architecture.md)

---

## 1. Chuẩn bị Auth

1. Trong **Supabase Dashboard → Authentication → Users**, tạo tài khoản user của owner (nếu chưa có) và ghi lại **UUID**.
2. Vào **Authentication → Sign In / Providers → tắt "Allow new users to sign up"** để khóa đăng ký công khai.

---

## 2. Chạy 10 SQL Migrations

Thư mục [`migrations/`](migrations/) gồm **10 file migration strictly additive** (không bao giờ sửa phá vỡ schema `relay_messages` / `relay_results` mà Nyx đang chạy production). Chạy bằng `npx --yes supabase db push` hoặc dán lần lượt vào **SQL Editor**:

1. [`20261127000000_relay.sql`](migrations/20261127000000_relay.sql) — tạo `relay_messages`, `relay_results`, index, RLS owner-select, và bucket riêng tư `relay-inputs` cho ảnh tham chiếu.
2. [`20261127000100_relay_chat.sql`](migrations/20261127000100_relay_chat.sql) — đảm bảo check constraint `action` cho phép `chat`, `image`, `video`.
3. [`20261127000200_recipient_hash.sql`](migrations/20261127000200_recipient_hash.sql) — mở rộng `recipient` cho phép UUID chữ thường bên cạnh `'nyx'`.
4. [`20261127000300_relay_muses.sql`](migrations/20261127000300_relay_muses.sql) — tạo bảng registry `relay_muses` (`recipient`, `name`, `token_hash` 64-hex SHA-256 unique, `dropbox_root`, RLS owner full).
5. [`20261127000400_relay_groups.sql`](migrations/20261127000400_relay_groups.sql) — tạo 3 bảng group chat: `relay_groups`, `relay_group_members`, `relay_group_posts`.
6. [`20261127000500_relay_muses_last_claim.sql`](migrations/20261127000500_relay_muses_last_claim.sql) — thêm cột `last_claim_at` để theo dõi heartbeat khi Muse poll `claim_message`.
7. `20261127000550_relay_projects.sql` — thêm 5 bảng v7 cho Projects, Conversations & OpenAI-compatible agents: `relay_agents_openai`, `relay_projects`, `relay_project_agents`, `relay_conversations`, `relay_openai_messages` (RLS owner full).
8. [`20261127000600_cleanup_legacy_and_owner_delete.sql`](migrations/20261127000600_cleanup_legacy_and_owner_delete.sql) — cấp quyền `DELETE` cho owner (qua RLS) trên `relay_messages` và `relay_results` để hỗ trợ xóa lịch sử phòng Muse 1:1, đồng thời dọn dữ liệu legacy trước v7 mà vẫn giữ nguyên `relay_muses`.
9. [`20261127000700_muse_connection_state.sql`](migrations/20261127000700_muse_connection_state.sql) — thêm các cột telemetry `setup_done`, `first_connected_at`, `last_result_at`, `token_rotated_at` vào `relay_muses`, backfill Muse đang chạy, và gắn trigger `trg_relay_muses_connection_state` (`sync_muse_connection_state()`).
10. `20261127000800_relay_muses_email_owner.sql` — thêm cột metadata `email_owner` trên `relay_muses` để lưu email sở hữu song song với `dropbox_root`.

---

## 3. Đặt đúng 2 secrets cho Edge Functions

Tạo chuỗi ngẫu nhiên (ví dụ `openssl rand -hex 32`), rồi cấu hình đúng **2 secret** trên Supabase:

```bash
npx --yes supabase secrets set \
  RELAY_SIGNING_SECRET="<chuỗi-64-ký-tự-hex>" \
  RELAY_OWNER_ID="<uuid-user-của-owner>"
```

- `RELAY_SIGNING_SECRET`: chỉ nằm trong Supabase secrets, không cấp cho bất kỳ ai — khóa HMAC-SHA256 để ký bản tin khi `submit_message` và kiểm lại khi `claim_message`.
- `RELAY_OWNER_ID`: chỉ user UUID này mới gửi được yêu cầu.

> Token và recipient của từng Muse **không** lưu dưới dạng secret trên server: mỗi Muse có 1 token riêng sinh lúc tạo/rotate trong Dashboard, server chỉ lưu SHA-256 trong `relay_muses.token_hash`.

---

## 4. Deploy 3 Edge Functions

Dự án dùng [`config.toml`](config.toml) với **3 Edge Functions** (Edge Function `dropbox_proxy` cũ đã được gỡ bỏ; proxy Dropbox nay chạy trực tiếp trong [`server/`](../server/src/dropbox.ts) bằng `.env` để không tốn egress Supabase):

- [`submit_message`](functions/submit_message/index.ts) (`verify_jwt = true`) — xác thực JWT + `RELAY_OWNER_ID`, validate tham số, hỗ trợ gửi trực tiếp theo `recipient` hoặc fan-out theo `group_id`, ký HMAC-SHA256.
- [`claim_message`](functions/claim_message/index.ts) (`verify_jwt = false`, xác thực qua header `x-relay-token`) — đối chiếu SHA-256 với `relay_muses`, stamp `last_claim_at` + `setup_done = true`, kiểm tra chữ ký HMAC, cấp lease `claim_id` 30 phút và tạo `reference_signed_urls` 1 giờ cho bucket `relay-inputs`.
- [`submit_result`](functions/submit_result/index.ts) (`verify_jwt = false`, xác thực qua header `x-relay-token`) — kiểm tra quyền sở hữu `recipient`, khớp `claim_id` và hạn lease, kiểm tra mọi `output.dropbox_paths` bắt đầu đúng bằng `dropbox_root` của Muse đó, stamp `last_result_at`, và tự fan-out lượt tiếp theo nếu thuộc nhóm chat.

Deploy đồng loạt bằng script (đọc `SUPABASE_URL` và `SUPABASE_ACCESS_TOKEN` từ `.env`):

```bash
bash scripts/deploy-functions.sh
```

---

## 5. Quản lý Muse, Telemetry & Kết nối (v5 + v8 + v9)

**Không Muse nào là Muse chính (fail-closed)**: mọi Muse — kể cả Nyx — đều là một hàng trong `relay_muses`, xác thực qua `sha256(x-relay-token)`. Token không hợp lệ hoặc bảng `relay_muses` lỗi sẽ trả `401` ngay lập tức, không fallback. Tin thiếu `recipient` trả `400`; `recipient` chưa đăng ký trả `403`.

### Quy trình thêm Muse mới (`AddMuseWizard`)

1. Trong Dashboard (Overview hoặc Agent Admin), bấm **Thêm Muse** → nhập **Tên Muse** và **Email sở hữu Muse** (`email_owner`). Dropbox root tự sinh dạng `/<email>/` (chữ thường), không phải gõ dấu `/`.
2. Wizard sinh `recipient` UUID + `RELAY_TOKEN` ngẫu nhiên, băm SHA-256 trên trình duyệt rồi lưu vào `relay_muses`.
3. Bước cuối hiện **hai khung tách biệt**:
   - **Khung `RELAY_TOKEN`** — sao chép để dán vào **Secure Vault** của Muse (hiển thị **duy nhất một lần**, không bao giờ nằm trong khung hướng dẫn).
   - **Khung Hướng dẫn chuẩn** — endpoint, schema `claim_message`/`submit_result`, `dropbox_root`, quy ước đặt tên `yyyy-mm-dd_hh-mm-ss_<slug>`, quy tắc dọn local/Dropbox sau 24 giờ (bao gồm sidecar metadata), và nghi thức an toàn inbox: bản đọc bị gắn cờ an toàn/prompt-injection → submit failed `safety_check_failed` từ sidecar, không xử lý prompt.
4. **Khóa `setup_done` ban đầu**: Khi mới tạo, `setup_done = false`. Thanh soạn tin trong phòng chat 1:1 của Muse đó sẽ bị khóa cho tới khi Muse gọi `claim_message` xác thực thành công lần đầu (lúc đó `claim_message` và trigger `trg_relay_muses_connection_state` đặt `setup_done = true`, `first_connected_at`, và `last_claim_at`).

### Cột Telemetry trên `relay_muses` (v9)

| Cột | Ý nghĩa |
|---|---|
| `setup_done` | `true` ngay sau lần `claim_message` hợp lệ đầu tiên (tự cập nhật bởi `claim_message` + trigger `sync_muse_connection_state()`). |
| `first_connected_at` | Thời điểm kết nối thành công đầu tiên. |
| `last_claim_at` | Cập nhật mỗi lần `claim_message` xác thực hợp lệ (kể cả khi hàng đợi rỗng) → hiển thị trạng thái `live` (≤ 3 phút), `standby` (≤ 15 phút), hoặc `offline`. |
| `last_result_at` | Cập nhật best-effort mỗi lần `submit_result` thành công. |
| `token_rotated_at` | Gắn mốc thời gian khi owner rotate token; nếu mới hơn `last_claim_at`, Dashboard hiện trạng thái **Đang kết nối lại**. |

### Quản lý Muse hiện có

Trong **Quản trị Agent** hoặc menu **Quản lý ▾** tại phòng Muse:
- **Đổi tên**: cập nhật `relay_muses.name` và đồng bộ `relay_project_agents.agent_name`.
- **Rotate token**: sinh token mới, ghi đè `token_hash` và đặt `token_rotated_at`; token cũ vô hiệu ngay lập tức (`401`).
- **Xóa lịch sử** *(v8, phòng Muse 1:1)*: xóa `relay_messages` / `relay_results` của riêng Muse đó qua quyền `DELETE` RLS của owner.
- **Xóa Muse**: xóa hàng `relay_muses` (thu hồi quyền claim/submit ngay) và gỡ khỏi các project/nhóm.

---

## 6. Projects, Conversations & Group Chat (v6 + v7)

- **Group chat (`20261127000400_relay_groups.sql`)**: Gồm `relay_groups`, `relay_group_members`, `relay_group_posts` (owner chỉ đọc, Edge Functions ghi qua service role).
  - Khi owner gửi vào `group_id` (`action: "chat"`), `submit_message` tạo 1 hàng `relay_messages` cho từng member ở `turn = 1` với prompt `"[<Tên owner>]: <nội dung>"`.
  - Khi một Muse hoàn tất (`status: "done"` với `output.text` khác rỗng), `submit_result` tự động fan-out sang các member **khác** ở `turn + 1` với prompt `"[<Tên Muse>]: <text>"` (truncate ≤ 3800 ký tự). Dừng khi đạt `GROUP_TURN_LIMIT = 12`; mỗi tin mới của owner reset về `turn = 1`.
- **Projects & Conversations (`20261127000550_relay_projects.sql`)**: Gồm `relay_agents_openai`, `relay_projects`, `relay_project_agents`, `relay_conversations`, `relay_openai_messages`.
  - Trên Dashboard, toàn bộ điều hướng nằm ở **Sidebar bên trái** (Tổng quan, Quản trị Agent, danh sách **Projects & Conversations**, và kênh **Direct Muses**).
  - Mỗi conversation hỗ trợ 4 chế độ: `muse_single`, `muse_group`, `openai` (gọi qua [`server/`](../server/src/openai.ts)), và `mixed` (phát đồng thời cho cả Muse và OpenAI agents).

---

## 7. Chạy Acceptance Tests (53 Assertions)

[`scripts/acceptance-tests.sh`](../scripts/acceptance-tests.sh) chạy trực tiếp trên project Supabase live, dùng thư mục tạm cô lập (không tạo rác trong repo) và tự dọn sạch toàn bộ bản ghi test ở cuối script:

```bash
bash scripts/acceptance-tests.sh
```

Kết quả bắt buộc: `RESULT: PASS=53 FAIL=0` (bao gồm các khối xác thực, fail-closed, cách ly multi-muse, heartbeat `last_claim_at`, cleanup, group fan-out/turn cap/isolation, và legacy queue).

> **Lưu ý vận hành**: Nếu có daemon Nyx đang chạy live, các test gửi trực tiếp tới queue test riêng (`T-MM` / `T-HB` / `T-LG` seed Muse tạm) để tránh xung đột với Nyx production; nếu gặp race ở test đầu vào, chạy lại một lần nữa.

---

## 8. Ghi chú vận hành nhanh

- Thời hạn claim mỗi message từ lúc gửi là **30 phút** (`expires_at`); quá hạn sẽ bị bỏ qua.
- Lease xử lý (`claim_expires_at`) là **30 phút**; quá hạn khi `submit_result` trả `409 claim_expired` (Muse cần `claim_message` lại để lấy `claim_id` mới).
- Ảnh tham chiếu tải lên bucket `relay-inputs` theo đường dẫn `<owner-uuid>/...`; `claim_message` cấp `reference_signed_urls` có hạn 1 giờ.
- File đính kèm upload từ Dashboard đi qua `POST /api/dropbox/upload` trên `server/` (giới hạn 50 MB/file, tối đa 4 file/lần) trực tiếp lên Dropbox root của Muse mà không qua Supabase Storage hay Edge Functions.
- Mọi tài nguyên do Muse tạo được lưu local tại `uploads/Relay/<thread_id>/` và tải lên `${dropbox_root}<thread_id>/`; bản làm việc local xóa ngay sau khi `submit_result` thành công, bản local trong Files Management và bản trên Dropbox xóa sau **24 giờ**.
