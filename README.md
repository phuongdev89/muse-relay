# Muse Relay

Relay điều phối giữa **dashboard của owner** và **các Muse** (AI agents): owner gửi việc qua
giao diện chat, mỗi Muse claim → thực hiện → trả kết quả về **Dropbox root riêng của nó**.
Backend là Supabase (Auth + Postgres + Edge Functions); dashboard là app React tĩnh.

## Kiến trúc

```
Dashboard (React + Vite, file tĩnh)
    │  Supabase Auth (email/password, chỉ owner) + REST đọc trạng thái (RLS owner-only)
    │  submit_message (Edge Function, verify JWT + HMAC ký bản tin)
    ▼
Supabase Postgres ── relay_messages / relay_results (frozen — Nyx đang chạy production)
    │                relay_muses (registry: token chỉ lưu SHA-256, fail-closed)
    │                relay_groups / relay_group_members / relay_group_posts (v6)
    ▼
Muse ×N ── claim_message (x-relay-token → đúng 1 hàng registry)
    │       làm việc → lưu file vào Dropbox root riêng
    └───── submit_result (validate path dưới đúng root, HMAC verify)
```

Nguyên tắc bất biến (đọc kỹ trước khi sửa):

1. **Nyx là production frozen** — `relay_messages` / `relay_results` không alter; mọi thay đổi
   function/schema phải additive + fallback-safe, và bằng chứng bằng suite acceptance xanh.
2. **Không Muse nào đặc quyền** — xác thực đi qua `relay_muses` (hash-only); miss/lỗi → 401.
   Mỗi request submit phải chỉ đích danh `recipient` (UUID) — không có Muse mặc định.
3. **Token Muse chỉ nằm trong Secure Vault của Muse** — không qua chat, không log, không file.
   Dashboard chỉ hiển thị token đúng một lần lúc tạo/rotate.
4. Server giữ đúng 2 secret: `RELAY_SIGNING_SECRET` (HMAC) + `RELAY_OWNER_ID` (allowlist).

## Cấu trúc thư mục

```
dashboard/                 App React + Vite + TypeScript (toàn bộ giao diện)
  └─ src/
     ├─ lib/               config, supabase client, api, instructions, dropbox helpers
     ├─ components/        Login, Sidebar, MuseRoom, GroupRoom, Composer, wizards, dialogs
     └─ styles/            tokens.css (Hallmark Midnight) + app.css
supabase/
  ├─ functions/            3 Edge Functions (Deno): submit_message, claim_message, submit_result
  ├─ migrations/           SQL schema (chạy trong SQL Editor hoặc db push)
  └─ README.md             TÀI LIỆU CHI TIẾT: schema, contract Muse, quy trình vận hành
scripts/
  ├─ deploy-functions.sh   Deploy 3 Edge Functions (cần SUPABASE_ACCESS_TOKEN trong .env)
  └─ acceptance-tests.sh   Suite test nghiệm thu chạy trực tiếp lên project live
docs/examples/             Ví dụ code phía Muse gọi submit_message
.env.example               Bản mẫu 8 biến môi trường (kèm chú thích vai trò từng biến)
```

## Chạy dashboard

```bash
cd dashboard
npm install
npm run dev        # http://localhost:5173
npm run build      # bundle tĩnh vào dashboard/dist/ — deploy được lên bất kỳ host tĩnh nào
npm run preview    # xem thử bản build trên http://localhost:4173
```

Đăng nhập bằng tài khoản owner (đăng ký công khai đã tắt trên Supabase project).

## Deploy backend

```bash
bash scripts/deploy-functions.sh      # deploy 3 Edge Functions
npx --yes supabase db push            # hoặc dán file trong supabase/migrations/ vào SQL Editor
bash scripts/acceptance-tests.sh      # suite nghiệm thu — phải PASS=49 FAIL=0
```

Suite chạy thẳng lên project live và tự dọn sạch hàng test (daemon Nyx LIVE — hàng test quên
sẽ bị nó "ăn" như việc thật; sweep cuối khối phòng trường hợp đó).

## Tài liệu sâu hơn

- `supabase/README.md` — schema từng bảng, contract claim/result của Muse, quy trình thêm/
  rotate/xoá Muse, cơ chế group chat, ghi chú vận hành.
- `.env.example` — vai trò từng biến, cách rotate, cách kiểm tra khớp hash registry.
