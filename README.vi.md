[English](README.md) | **Tiếng Việt**

# Muse Relay

Relay điều phối giữa **dashboard của owner** và **các Muse** (AI agents bất đồng bộ): owner gửi việc qua giao diện chat (kênh trực tiếp hoặc trong Project/Conversation), mỗi Muse claim → thực hiện → trả kết quả về **Dropbox root riêng của nó**. Dashboard cũng hỗ trợ thêm **Projects / Conversations** và gọi trực tiếp các **OpenAI-compatible endpoints** (`/chat/completions`).
Backend là Supabase (Auth + Postgres + Storage + Edge Functions); dashboard là app React + Vite + TypeScript tĩnh.

## Kiến trúc

```
Dashboard (React + Vite, file tĩnh)
    │  Supabase Auth (email/password, chỉ owner) + REST đọc trạng thái (RLS owner-only)
    │  submit_message (Edge Function, verify JWT + HMAC ký bản tin)
    │  OpenAI-compatible agents → gọi trực tiếp POST .../chat/completions (lưu vào relay_openai_messages)
    ▼
Supabase Postgres ── relay_messages / relay_results (frozen — Nyx đang chạy production)
    │                relay_muses (registry: token chỉ lưu SHA-256, fail-closed, telemetry heartbeat)
    │                relay_groups / relay_group_members / relay_group_posts (v6)
    │                relay_agents_openai / relay_projects / relay_project_agents /
    │                relay_conversations / relay_openai_messages (v7)
    ▼
Muse ×N ── claim_message (x-relay-token → đúng 1 hàng registry, stamp last_claim_at)
    │       làm việc → lưu file vào Dropbox root riêng
    └───── submit_result (validate path dưới đúng root, HMAC/claim verify, stamp last_result_at)
```

Nguyên tắc bất biến (đọc kỹ trước khi sửa):

1. **Nyx là production frozen** — `relay_messages` / `relay_results` không alter; mọi thay đổi
   function/schema phải additive + fallback-safe, và kiểm chứng bằng suite acceptance xanh.
2. **Không Muse nào đặc quyền** — xác thực đi qua `relay_muses` (hash-only); miss/lỗi → 401.
   Mỗi request submit phải chỉ đích danh `recipient` (UUID) hoặc `group_id` — không có Muse mặc định.
3. **Token Muse chỉ nằm trong Secure Vault của Muse** — không qua chat, không log, không file.
   Dashboard chỉ hiển thị token đúng một lần lúc tạo/rotate.
4. Server giữ đúng 2 secret: `RELAY_SIGNING_SECRET` (HMAC) + `RELAY_OWNER_ID` (allowlist).

## Telemetry trạng thái Muse (`relay_muses`)

Bảng `relay_muses` theo dõi vòng đời kết nối và heartbeat của từng Muse (bổ sung qua `20261127000500_relay_muses_last_claim.sql` và `20261127000700_muse_connection_state.sql` cùng trigger `trg_relay_muses_connection_state`):

- `setup_done` — `true` khi Muse đã từng claim ít nhất một lần (tự động set khi `last_claim_at` được ghi).
- `first_connected_at` — mốc thời gian Muse claim thành công lần đầu tiên.
- `last_claim_at` — stamp mỗi lần `claim_message` xác thực hợp lệ (kể cả khi hàng đợi rỗng), dùng để nhận diện trạng thái `Live` (≤ 3 phút), `Chờ nhịp` (≤ 15 phút), hoặc `Offline`.
- `last_result_at` — stamp mỗi lần `submit_result` ghi kết quả thành công.
- `token_rotated_at` — mốc thời gian owner rotate token từ dashboard; nếu mới hơn `last_claim_at`, dashboard hiển thị trạng thái chờ Muse kết nối lại bằng token mới.

## Cấu trúc thư mục

```
dashboard/                 App React + Vite + TypeScript (song ngữ EN/VI, Dark/Light theme)
  └─ src/
     ├─ lib/               config, supabase client, api, instructions, dropbox, format, i18n, theme
     ├─ components/        LoginView, Sidebar, OverviewView, AgentsAdminView, ProjectView,
     │                     ConversationRoom, MuseRoom, Composer, InspectorPanel,
     │                     AddMuseWizard, ProjectWizard, NewConversationModal,
     │                     OpenAIAgentModal, MuseManage, TokenPanel, MarkdownBody, MessageBubble, ui
     └─ styles/            tokens.css (dual Dark/Light tokens) + app.css
supabase/
  ├─ functions/            3 Edge Functions (Deno) + helper dùng chung:
  │                        _shared/relay.ts, submit_message, claim_message, submit_result
  ├─ migrations/           9 file SQL schema additive (chạy qua SQL Editor hoặc db push):
  │                        20261127000000_relay.sql .. 20261127000700_muse_connection_state.sql
  ├─ config.toml           Cấu hình verify_jwt cho 3 Edge Functions
  └─ README.md             TÀI LIỆU CHI TIẾT: schema, contract Muse, quy trình vận hành
scripts/
  ├─ deploy-functions.sh   Deploy 3 Edge Functions (cần SUPABASE_ACCESS_TOKEN trong .env)
  └─ acceptance-tests.sh   Suite test nghiệm thu chạy trực tiếp lên project live
docs/examples/             Ví dụ code phía Muse/client gọi submit_message (submit-example.ts)
.env.example               Bản mẫu 8 biến môi trường (kèm chú thích vai trò từng biến)
```

## Chạy dashboard

```bash
cd dashboard
npm install
npm run dev        # http://localhost:5173
npm run build      # bundle tĩnh vào dashboard/dist/ (tsc --noEmit && vite build)
npm run preview    # xem thử bản build trên http://localhost:4173
```

Đăng nhập bằng tài khoản owner (đăng ký công khai đã tắt trên Supabase project).

## Deploy backend

```bash
bash scripts/deploy-functions.sh      # deploy 3 Edge Functions
npx --yes supabase db push            # hoặc dán các file trong supabase/migrations/ vào SQL Editor
bash scripts/acceptance-tests.sh      # suite nghiệm thu — phải PASS=53 FAIL=0
```

Suite chạy thẳng lên project live và tự dọn sạch hàng test (daemon Nyx LIVE — hàng test quên
sẽ bị nó "ăn" như việc thật; sweep cuối khối phòng trường hợp đó).

## Tài liệu sâu hơn

- [`supabase/README.md`](supabase/README.md) — schema từng bảng, contract claim/result của Muse, quy trình thêm/rotate/xoá Muse, cơ chế group chat, ghi chú vận hành.
- [`.env.example`](.env.example) — vai trò từng biến, cách rotate, cách kiểm tra khớp hash registry.
