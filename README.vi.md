[English](README.md) | **Tiếng Việt**

# Muse Relay

> Trung tâm điều phối bất đồng bộ và Supabase relay kết nối dashboard của owner với các AI agent Muse (mỗi agent cô lập trong Dropbox root riêng) và các endpoint tương thích OpenAI.

Muse Relay cho phép owner gửi các tác vụ `chat`, `image`, `video` tới từng Muse độc lập, tổ chức agent theo **Projects & Conversations**, preview hoặc upload file trực tiếp lên Dropbox root của từng Muse, và trò chuyện với các endpoint `/chat/completions` tương thích OpenAI. Hệ thống kết hợp Supabase (Auth, Postgres, Storage và 3 Deno Edge Functions) với backend **Node.js (>= 20.11) + Express 5 + TypeScript** (`server/`) cùng giao diện **React 18 + Vite 6 + TypeScript** (`dashboard/`).

---

## Khởi chạy nhanh (Quick Start)

> **Yêu cầu**: **Node.js >= 20.11** (bắt buộc cho `import.meta.dirname` trong `server/`), **npm**, một **Supabase project**, và trên Windows cần **Git Bash + Python 3** để chạy các script `.sh`. Xem hướng dẫn chi tiết từng bước tại [Hướng dẫn Cài đặt & Vận hành](docs/setup-guide.vi.md).

```bash
# 1. Tạo .env từ bản mẫu (14 biến môi trường)
cp .env.example .env

# 2. Cài dependencies cho cả server/ và dashboard/
npm run install:all

# 3. Kiểm tra kiểu TypeScript ở cả server/ và dashboard/
npm run typecheck

# 4. Chạy chế độ dev (Express :3000 + Vite HMR :5173 với proxy /api)
npm run dev
```

Cho **production** (biên dịch `server/dist/` và `dashboard/dist/`, phục vụ `/api/*` và static SPA trên cùng 1 cổng `PORT`, mặc định `3000`):

```bash
npm run build
npm start
```

Chạy 10 migrations, deploy 3 Edge Functions và chạy suite nghiệm thu 53 assertions:

```bash
npx --yes supabase db push            # áp dụng 10 migrations (000000..000800)
bash scripts/deploy-functions.sh      # deploy submit_message, claim_message, submit_result
bash scripts/acceptance-tests.sh      # kỳ vọng RESULT: PASS=53 FAIL=0
```

---

## Vai trò của `server/`

Toàn bộ cấu hình runtime, proxy Dropbox, proxy OpenAI và phục vụ bản build frontend trong production đều đi qua [`server/`](server/src/index.ts):

1. **Nạp `.env` lúc runtime (`GET /api/config`)**: Đọc `.env` khi khởi động và trả về `{ supabaseUrl, supabasePublishableKey, ownerDisplayName, dropboxConfigured }` kèm header `Cache-Control: no-store`. [`dashboard/src/lib/config.ts`](dashboard/src/lib/config.ts) (`loadRuntimeConfig`) nạp cấu hình này trước khi khởi tạo Supabase, giúp `dashboard/dist/` **không hardcode Supabase URL hay key**.
2. **Proxy Dropbox trực tiếp (`POST /api/dropbox/temp-link`, `POST /api/dropbox/upload`)**: Sau khi xác thực JWT của owner (`requireOwnerAuth`), `server/` gọi thẳng tới Dropbox API bằng credential trong `.env`. Endpoint upload nhận raw binary `application/octet-stream` tối đa **50 MB** và ghi thẳng vào `dropbox_root` của Muse (`0` tốn egress Supabase, thay thế `dropbox_proxy` Edge Function đã gỡ bỏ).
3. **Proxy OpenAI phía server (`POST /api/openai/test`, `POST /api/openai/chat`)**: Kiểm tra JWT owner, truy vấn `relay_agents_openai` qua PostgREST với RLS của owner, tự chèn `system_prompt` ở server và gọi `/chat/completions` từ Node (tránh giới hạn CORS trình duyệt và giữ API key ngoài payload chat).
4. **Phục vụ production trên 1 port duy nhất**: Khi có `dashboard/dist/index.html`, `server/` phục vụ đồng thời `/api/*` và static SPA trên `PORT` (mặc định `3000`). Khi dev, [`dashboard/vite.config.ts`](dashboard/vite.config.ts) proxy `/api` về `VITE_API_ORIGIN` (mặc định `http://127.0.0.1:3000`).

---

## Kiến trúc & Nguyên tắc bất biến

```text
Trình duyệt (React 18 + Vite 6 + TypeScript SPA — dashboard/)
    ├──► Express 5 Server (Node.js >= 20.11 + TypeScript — server/)
    │      ├─ GET  /api/health             Kiểm tra server sống
    │      ├─ GET  /api/config             Cấp cấu hình runtime từ .env (Cache-Control: no-store)
    │      ├─ POST /api/dropbox/temp-link  JWT owner → tạo link tạm Dropbox (0 Supabase egress)
    │      ├─ POST /api/dropbox/upload     JWT owner → upload raw binary ≤50 MB vào dropbox_root
    │      ├─ POST /api/openai/test        JWT owner → kiểm tra /chat/completions phía server
    │      ├─ POST /api/openai/chat        JWT owner → tra cứu RLS + gọi /chat/completions
    │      └─ GET  /*                      Phục vụ static SPA dashboard/dist/ trong production
    │
    └──► Supabase (Auth + Postgres + Storage + 3 Deno Edge Functions)
           ├─ Supabase Auth (email/password owner; đăng ký công khai đã tắt)
           ├─ REST đọc/ghi qua RLS (owner-only)
           └─ submit_message (verify_jwt = true; kiểm tra owner allowlist, ký HMAC-SHA256)
                │
                ▼
         Supabase Postgres (10 migrations strictly additive)
           ├─ relay_messages / relay_results (frozen — Nyx đang chạy production)
           ├─ relay_muses (registry: token chỉ lưu SHA-256, fail-closed, telemetry heartbeat)
           ├─ relay_groups / relay_group_members / relay_group_posts (v6 group fan-out)
           └─ relay_agents_openai / relay_projects / relay_project_agents /
              relay_conversations / relay_openai_messages (v7 projects & conversations)
                │
                ▼
         Muse ×N
           ├─ claim_message (x-relay-token → khớp SHA-256 trong relay_muses; stamp last_claim_at & setup_done)
           ├─ Thực thi job → lưu file kết quả vào Dropbox root riêng
           └─ submit_result (kiểm tra claim lease + prefix dropbox_root; stamp last_result_at)
```

### Nguyên tắc bất biến

1. **Nyx là production-frozen** — Không alter phá vỡ schema `relay_messages` / `relay_results`; mọi thay đổi phải strictly additive và kiểm chứng với `bash scripts/acceptance-tests.sh` (`PASS=53 FAIL=0`).
2. **Không Muse nào đặc quyền (fail-closed)** — Mọi xác thực Muse đi qua `sha256(x-relay-token)` trong `relay_muses`; miss/lỗi → `401`, không fallback. Mọi `submit_message` phải chỉ đích danh `recipient` UUID hoặc `group_id`.
3. **Token Muse chỉ nằm trong Secure Vault của Muse** — Không gửi qua chat, log, hay file; Dashboard chỉ hiện token đúng một lần lúc tạo (`AddMuseWizard.tsx`) hoặc rotate (`MuseManage.tsx`).
4. **Edge Functions giữ đúng 2 secret; `.env` runtime nằm ở `server/`** — Edge Functions chỉ dùng `RELAY_SIGNING_SECRET` và `RELAY_OWNER_ID`. Cấu hình server và Dropbox nằm trong `.env` ở root do `server/` đọc lúc runtime.

Chi tiết schema, RLS, contract và telemetry `relay_muses` (`setup_done`, `first_connected_at`, `last_claim_at`, `last_result_at`, `token_rotated_at`) xem tại [`docs/architecture.md`](docs/architecture.md).

---

## Cấu trúc thư mục

```text
package.json                       Script gốc: install:all, dev, build, start, typecheck
.env.example                       Bản mẫu chú thích đầy đủ 14 biến môi trường
docs/
  ├─ README.md                     Mục lục tài liệu (EN + VI)
  ├─ setup-guide.md                Hướng dẫn cài đặt, triển khai & vận hành (EN)
  ├─ setup-guide.vi.md             Hướng dẫn cài đặt, triển khai & vận hành (VI)
  ├─ architecture.md               Tài liệu kiến trúc, schema, contract & bảo mật
  └─ examples/submit-example.ts    Ví dụ TypeScript phía client gọi submit_message
server/                            Backend Node.js (>= 20.11) + Express 5 + TypeScript
  ├─ package.json                  Scripts: dev (tsx watch), typecheck, build (tsc), start
  ├─ tsconfig.json                 Cấu hình TypeScript NodeNext (src/ → dist/)
  └─ src/
     ├─ index.ts                   Express app, route /api/*, parser raw 50 MB, phục vụ static SPA
     ├─ env.ts                     Đọc .env lúc runtime và kiểm tra biến môi trường
     ├─ auth.ts                    Middleware requireOwnerAuth (JWT Supabase + RELAY_OWNER_ID)
     ├─ dropbox.ts                 Cache OAuth refresh token + /api/dropbox/{temp-link,upload}
     ├─ openai.ts                  Proxy /api/openai/{test,chat} (tra cứu RLS + system_prompt)
     └─ supabase.ts                Helper supabaseRestSelectSingle dùng JWT owner + RLS
dashboard/                         App React 18 + Vite 6 + TypeScript (song ngữ EN/VI, Dark/Light)
  ├─ index.html                    Entrypoint với script khởi tạo theme & ngôn ngữ trước paint
  ├─ package.json                  Scripts: dev, build (tsc --noEmit && vite build), preview
  ├─ vite.config.ts                Proxy /api khi dev về VITE_API_ORIGIN (mặc định http://127.0.0.1:3000)
  └─ src/
     ├─ main.tsx                   Gọi loadRuntimeConfig() và initSupabase() trước khi mount
     ├─ App.tsx                    Root state, auth session, polling 10s, điều hướng phòng chat
     ├─ types.ts                   Định nghĩa kiểu dữ liệu khớp schema Supabase
     ├─ lib/
     │  ├─ api.ts                  Supabase REST, Edge Functions, /api/dropbox/* & /api/openai/*
     │  ├─ config.ts               Nạp cấu hình runtime từ GET /api/config (no-store)
     │  ├─ dropbox.ts              Chuẩn hóa Dropbox root (/email/), helper upload 50 MB / 4 file
     │  ├─ format.ts               ownerState, summarizeMuseFleet, telemetry museConnectionInfo
     │  ├─ i18n.ts                 Từ điển song ngữ EN/VI & hook (localStorage: muse_relay_lang)
     │  ├─ instructions.ts         Bộ sinh hướng dẫn chuẩn cho Muse mới
     │  ├─ supabase.ts             Supabase browser client khởi tạo lazy
     │  └─ theme.ts                Hook theme Dark/Light (localStorage: muse_relay_theme)
     ├─ components/
     │  ├─ common/                 Icons.tsx, TokenPanel.tsx, ui.tsx
     │  ├─ layout/                 LoginView.tsx, Sidebar.tsx, InspectorPanel.tsx
     │  ├─ chat/                   Composer.tsx, MarkdownBody.tsx, MessageBubble.tsx
     │  ├─ views/                  OverviewView.tsx, AgentsAdminView.tsx, ProjectView.tsx,
     │  │                          MuseRoom.tsx, ConversationRoom.tsx
     │  └─ modals/                 AddMuseWizard.tsx, MuseManage.tsx, OpenAIAgentModal.tsx,
     │                             ProjectWizard.tsx, NewConversationModal.tsx
     └─ styles/                    tokens.css (Dark/Light tokens) + app.css
supabase/
  ├─ config.toml                   Cấu hình verify_jwt cho 3 Edge Functions
  ├─ README.md                     Tài liệu kỹ thuật chi tiết bằng tiếng Việt
  ├─ functions/                    3 Edge Functions đang hoạt động (dropbox_proxy đã gỡ → server/)
  │  ├─ _shared/relay.ts           Ký HMAC-SHA256, tra cứu SHA-256, validate, group fan-out
  │  ├─ submit_message/index.ts    Owner gửi tin (recipient trực tiếp hoặc group_id)
  │  ├─ claim_message/index.ts     Muse poll/claim (xác thực x-relay-token, stamp heartbeat)
  │  └─ submit_result/index.ts     Muse trả kết quả (kiểm tra lease + dropbox_root, group fan-out)
  └─ migrations/                   10 file SQL strictly additive:
     ├─ 20261127000000_relay.sql
     ├─ 20261127000100_relay_chat.sql
     ├─ 20261127000200_recipient_hash.sql
     ├─ 20261127000300_relay_muses.sql
     ├─ 20261127000400_relay_groups.sql
     ├─ 20261127000500_relay_muses_last_claim.sql
     ├─ 20261127000550_relay_projects.sql
     ├─ 20261127000600_cleanup_legacy_and_owner_delete.sql
     ├─ 20261127000700_muse_connection_state.sql
     └─ 20261127000800_relay_muses_email_owner.sql
scripts/
  ├─ deploy-functions.sh           Deploy submit_message, claim_message, submit_result từ .env
  └─ acceptance-tests.sh           Suite nghiệm thu 53 assertions dùng thư mục tạm cô lập
```

---

## Tài liệu chi tiết

- [`docs/README.md`](docs/README.md) — Mục lục tài liệu (Tiếng Anh & Tiếng Việt).
- [`docs/setup-guide.vi.md`](docs/setup-guide.vi.md) — Hướng dẫn cài đặt, triển khai, sử dụng Dashboard, chạy test và xử lý sự cố ([Bản tiếng Anh](docs/setup-guide.md)).
- [`docs/architecture.md`](docs/architecture.md) — Tài liệu kiến trúc hệ thống, route Express, cấu trúc React, schema/RLS Supabase, contract Muse và telemetry.
- [`supabase/README.md`](supabase/README.md) — Chi tiết 10 migrations, 3 Edge Functions, contract claim/result và ghi chú vận hành.
- [`docs/examples/submit-example.ts`](docs/examples/submit-example.ts) — Ví dụ TypeScript gọi `submit_message`.
- [`.env.example`](.env.example) — Bản mẫu chú thích 14 biến môi trường.
