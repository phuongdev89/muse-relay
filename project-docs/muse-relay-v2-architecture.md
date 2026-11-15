# Muse Relay v2 — Kiến trúc kỹ thuật & Nền tảng UX

> Chủ trì: ArchitectUX | Ngày: 2026-11-16
> Nguồn sự thật duy nhất: `project-specs/muse-relay-v2-setup.md` (mọi tham chiếu § bên dưới thuộc spec đó).
> Tài liệu nền cho developer (frontend T5–T7, backend T1–T4): chỉ cấu trúc + quyết định thiết kế, KHÔNG chứa code triển khai. Đối chiếu 12 task trong `project-tasks/muse-relay-v2-tasklist.md`.

---

## A. KIẾN TRÚC KỸ THUẬT

### A1. Sơ đồ dòng dữ liệu

```
┌────────────────────────┐  HTTPS fetch / supabase-js   ┌───────────────────────────────┐
│ Web UI tĩnh            │ ───────────────────────────▶ │ Supabase                      │
│ (GitHub Pages → web/)  │  PostgREST REST · GoTrue     │  ├ GoTrue: login + admin/users│
│ 1 file index.html      │  Realtime websocket          │  ├ PostgREST: REST + RLS      │
│ giữ SERVICE key (admin)│ ◀─────────────────────────── │  ├ Postgres: projects/threads/│
└────────────────────────┘  postgres_changes INSERT     │  │  messages (+ RLS)          │
        ▲                    table messages             │  └ Realtime: publication      │
        │ .env (URL + ANON,                             │    supabase_realtime          │
        │ KHÔNG service key)                            └───────────────────────────────┘
┌───────┴────────────────┐  HTTPS REST (requests+stdlib)          ▲
│ muse_client.py         │ ───────────────────────────────────────┘
│ chạy nền máy mỗi Muse  │  GoTrue login → access_token (bearer)
│ state/inbox.jsonl ·    │  poll messages id>cursor · POST reply qua outbox
│ outbox/<tid>.txt ·     │  CHỈ polling (POLL_INTERVAL ≥ 2s) — không dùng realtime
│ state/cursor.json      │
└────────────────────────┘
```

- KHÔNG server trung gian (§1). File/ảnh/video không đi qua hệ thống — Muse upload Dropbox rồi trả link trong text (§0.8, §6).
- Hệ FastAPI cũ (root) giữ nguyên, không liên kết gì với hệ mới (§1).

**Vai trò 3 loại khoá (chìa khoá):**

| Khoá | Ai giữ | Gửi vào đâu | Quyền / giới hạn |
|---|---|---|---|
| ANON key (`sb_publishable_…` hoặc legacy JWT) | Web UI (localStorage máy owner) + Muse (dòng `SUPABASE_ANON_KEY=` trong .env) | Header `apikey` cho mọi call REST/GoTrue | Chỉ định danh dự án; quyền thật do RLS + bearer quyết định. Hai dạng key dùng như nhau, code không phân biệt (§3) |
| SERVICE key (`sb_secret_…` hoặc legacy) | **Chỉ Web UI của owner** (localStorage) | Header `apikey` + `Authorization: Bearer` | Bypass RLS — toàn quyền. CẤM xuất hiện trong zip/.env/txt/client/docs (§4) |
| Muse access_token (JWT, hạn ~1h) | `muse_client.py` sau khi login | Header `Authorization: Bearer` trên REST | RLS khoá theo `projects.user_id = auth.uid()`; hết hạn → re-login khi gặp 401 (§3, §5) |

### A2. Luồng auth

1. **Muse client** (§3, §5): `POST {url}/auth/v1/token?grant_type=password` body `{"email","password"}` → nhận `access_token` + `user.id` → `GET /rest/v1/projects?select=id,muse_id,name,tags,email&user_id=eq.{uid}` → banner khởi động. Token ~1h: gặp **401 → login lại → thử lại đúng 1 lần** (outbox); với poll thì re-login rồi chạy chu kỳ kế. Sai thông tin (400/400 grant) → log lỗi rõ, KHÔNG in secret.
2. **Admin web**: không login GoTrue — service key trong header trực tiếp (bypass RLS). GoTrue chỉ được gọi ở endpoint `admin/users` (tạo/xoá user của Muse).
3. **Web UI không dùng session GoTrue** của Muse; mọi quyền của web = quyền service key. Đây là lý do web chỉ chạy trên máy owner (localStorage), không chia sẻ cho người khác.

### A3. Sơ đồ trạng thái web UI (state machine)

```
                 đủ 3 key trong localStorage (mr_*)
   ┌──────────┐  kiểm tra kết nối OK   ┌────────────────────────┐
   │ SETTINGS │ ─────────────────────▶ │ LOADED (sidebar+threads)│
   └──────────┘                        └────────────────────────┘
      ▲   ▲  key thiếu/hết hiệu lực      │  chọn project → chọn thread
      │   │ (401/403 → toast + nút       ▼
      │   │  "Mở Settings")          ┌──────────────┐  nút ＋ New
      │   └──────────────────────────│ OPEN_THREAD  │ ─────────▶ WIZARD B1→B2→B3 (modal)
      │                              └──────────────┘
      │                                 ▲ │  menu ⋮ → Token (modal chồng)
      └── xoá key / xoá Muse cuối ──────┘ │  menu ⋮ → Xóa (modal confirm) → xong về LOADED
```

**Trạng thái lỗi (chồng lên trạng thái chính, không đổi route):**

| Tình huống | Hành vi |
|---|---|
| Fetch fail (mạng/5xx/429) | Toast đỏ; giữ nguyên dữ liệu lần fetch trước; polling 30s + realtime tự reconnect tự thử lại |
| "Kiểm tra kết nối" fail | Toast đúng nguyên nhân (URL sai / key sai / mạng); KHÔNG lưu localStorage khi fail |
| 401/403 bằng service key | Toast ngay + nút "Mở Settings" (key sai hoặc đã đổi) |
| Fetch templates fail khi mở `file://` (chỉ Wizard B3) | Toast cảnh báo: mở qua `python -m http.server` trong `web/` (§8 B3) |
| Mất realtime (channel CLOSE/ERROR) | Gắn nhãn "Ngoại tuyến — polling 30s" nhỏ ở header; fallback polling tự che phủ; khi channel SUBSCRIBED lại thì bỏ nhãn |
| Gửi tin fail | Toast + trả text về composer (không mất nội dung người dùng đã gõ) |

### A4. Realtime wiring (§3, §8)

- `supabase-js createClient(url, SERVICE_KEY)` → channel `postgres_changes` event **INSERT** bảng `messages` (không filter — nhận toàn bộ rồi lọc client-side; service key bypass RLS nên nhận đủ).
- Mỗi tin INSERT đến: (a) `thread_id === activeThreadId` → append vào khung chat + auto-scroll + `PATCH last_read_id` (đang mở = đã đọc ngay); (b) tin của thread khác → cập nhật unread của project + preview sidebar + re-render thẻ; (c) luôn cập nhật preview của sidebar kể cả khi chat đang mở.
- **Fallback polling 30s**: `setInterval` refetch `messages?order=id.desc&limit=200` (bộ rời — rebuild preview/unread); nếu realtime đang offline thì refetch thêm thread đang mở bằng GET `thread_id=eq.X`. Polling chạy song song mãi, không tắt khi realtime sống — giữ code đơn giản và chống lệch.
- Cờ `status` của channel được lưu vào state (`realtime.status`) để hiển thị nhãn ngoại tuyến.

### A5. Mô hình dữ liệu client-side (frontend dịch thẳng thành JS)

```
state:
  settings:  { url, anonKey, serviceKey }              // ← localStorage mr_supabase_url / mr_anon_key / mr_service_key
  projects:  [ { id, muse_id, name, tags[], email, secret } ]   // GET projects (service)
  threads:   [ { id, project_id, title, last_read_id } ]        // GET threads order=id.asc
  messagesByThread: Map<threadId, Message[]>           // cache; Message = {id, thread_id, project_id, role, text, created_at}
  unread:  Map<projectId, int>                         // tổng các messages.id > threads.last_read_id của project đó
  preview: Map<projectId, { text, role, createdAt }>   // tin có id lớn nhất của project (prefix "Bạn:"/"Muse:")
  activeProjectId: int | null
  activeThreadId:  int | null
  realtime: { status: 'connected' | 'offline' }
  wizard:   { step: 1|2|3, muse_id, name, tags[], email, password, userId, projectId }
```

- **Quy tắc unread**: chỉ đếm client-side từ bộ 200 tin mới nhất + realtime; khi mở thread → GET đủ 500 tin → render → `PATCH last_read_id = max(id)` → reset unread của project về 0.
- **Preview**: dựng từ messages desc 200, lấy id lớn nhất mỗi project; realtime INSERT lớn hơn id hiện có → thay preview.
- **threads của project** lọc từ `threads[]` theo `project_id`, thứ tự id.asc (giữ nguyên thứ tự spec, không sort thêm).
- Search sidebar: lọc `muse_id + name` theo input, chỉ là render filter, không đụng state gốc.

### A6. Error handling pattern chung

1. **Gate trước khi gọi API**: mọi hành động gọi Supabase phải qua một bước kiểm tra `settings` đủ 3 giá trị; thiếu → về SETTINGS, không gửi request dở dang. Nút double-submit bị khoá trong lúc chờ (Kiểm tra kết nối, Tạo Muse B2, Gửi).
2. **Toast là kênh lỗi duy nhất**: một container fixed góc dưới-phải; 4 mức info/thành công/cảnh báo/lỗi. Lỗi fetch hiện nguyên nhân ngắn gọn; 401/403 toast kèm nút "Mở Settings". Toast lỗi tự tắt sau ~5s, toast 401/403 giữ đến khi tương tác.
3. **Retry**: không retry tự động vô hạn — fallback polling 30s là retry nền; realtime tự reconnect của supabase-js; hành động do người dùng khởi phát (gửi tin) chỉ retry tay. (Outbox client-side có backoff riêng theo §5 — không trộn với web.)
4. **Không bao giờ log/print key**: toast chỉ nói "SERVICE_KEY bị từ chối", không in giá trị key (§5 tinh thần chung của pipeline: cấm secret lộ ra).

---

## B. NỀN TẢNG UX

### B1. Luồng người dùng chính

1. **Lần đầu vào trang** → màn Settings → điền URL/ANON/SERVICE → "Kiểm tra kết nối" OK → lưu localStorage → vào thẳng màn chính. Lần sau vào trang: có đủ key → bỏ qua Settings.
2. **Chọn project → chọn thread → chat**: bấm thẻ sidebar → khung phải render header + danh sách thread (dropdown) → chọn thread → GET tin → đọc, gửi qua composer.
3. **New Muse wizard 3 bước** (modal từ nút ＋ New): B1 điền muse_id/name/tags (check trùng live) → B2 tạo user+project, hiện email/password copy ngay + cảnh báo "lưu ngay, form của Muse sẽ hỏi" → B3 tải zip + copy nội dung setup_guide.txt → "gửi zip + nội dung txt này cho Muse".
4. **Xem token / xóa project**: menu ⋮ trên thẻ → Token (modal email + secret, nút copy, GET `projects?id=eq.X` lấy mới) / Xóa (modal xác nhận → DELETE admin user + DELETE project row → cascade).
5. **Tạo thread mới**: nút ＋ Thread mới ở header → POST threads `{project_id, title}` → chọn luôn thread vừa tạo.

### B2. Wireframe chữ

**Settings (chưa có key):**
```
┌────────────────────────────────────────────────────────┐
│           Muse Relay — Kết nối Supabase                │
│   Điền thông tin dự án Supabase (lưu cục bộ máy bạn).  │
│                                                        │
│   SUPABASE_URL   [ https://xxxx.supabase.co         ]  │
│   ANON_KEY       [ ●●●●●●●●●●●●●●●●  (password)     ]  │
│   SERVICE_KEY    [ ●●●●●●●●●●●●●●●●  (password)     ]  │
│                                                        │
│              [ Kiểm tra kết nối ]  ← loading: "Đang    │
│                                       kiểm tra…"       │
│   Lỗi → toast góc dưới-phải. 401/403 → toast + ghi rõ. │
│   OK → lưu localStorage, vào màn chính ngay.           │
└────────────────────────────────────────────────────────┘
```

**Màn chính (sidebar + khối phải):**
```
┌──── sidebar 280px ─────────────────────┬──── khối phải ──────────────────────────────┐
│ [＋ New]  [ Tìm Muse…               ]  │ <name> (<muse_id>)  [chat][image]           │
│ ┌────────────────────────────────────┐ │ Thread: [ ▼ Thread mới (id 7) ] [＋ Thread  │
│ │ ★ Tên Muse A          [chat]  (3) │ │          mới]                               │
│ │   muse_001                         │ ├─────────────────────────────────────────────┤
│ │   Bạn: gửi file giúp… · 5 phút     │ │  ┌───────────────────────────┐              │
│ │                            ⬤3      │ │  │ Muse: tôi đã xử lý… 10:24 │ ← nền #243244│
│ ├────────────────────────────────────┤ │  └───────────────────────────┘              │
│ │ Tên Muse B        [image][video]   │ │   [⬇ Tài khoản_dropbox …]  ← card đính kèm  │
│ │   muse_002                         │ │              ┌───────────────────────────┐  │
│ │   Muse: Đã upload link ⬇… · 2 giờ  │ │              │ Bạn: gửi giúp…     10:26  │  │
│ ├────────────────────────────────────┤ │              └───────────────────────────┘  │
│ │ (⋮ góc phải thẻ → Token / Xóa)     │ │                    … (tự cuộn đáy)          │
│ └────────────────────────────────────┘ ├─────────────────────────────────────────────┤
│  ★ = đang chọn, nền #22304a            │ [ textarea tự giãn…                         │
│                                        │  Enter gửi · Shift+Enter xuống dòng      ]  │
│                                        │                                      [Gửi]  │
└────────────────────────────────────────┴─────────────────────────────────────────────┘
```

**Wizard B1 — thông tin Muse:**
```
┌───────── Wizard: New Muse — Bước 1/3 ──────────────┐
│  muse_id *   [ muse_001            ]               │
│              Regex ^[a-z0-9_]{3,40}$; sai → đỏ    │
│              live; trùng → "muse_id đã tồn tại"   │
│              (GET projects?muse_id=eq.X)          │
│  Tên hiển thị [ Muse 001           ]               │
│  Năng lực:   [x] chat  [ ] image  [ ] video        │
│                        [ Huỷ ]   [ Tiếp → ]        │
└────────────────────────────────────────────────────┘
```

**Wizard B2 — tạo user + project, hiện mật khẩu:**
```
┌───────── Wizard: New Muse — Bước 2/3 ──────────────┐
│  (đang tạo: nút Tiếp khoá, nhãn "Đang tạo…")       │
│  ✓ Đã tạo Muse!                                    │
│  Email:     muse_001@muserelay.local      [Copy]   │
│  Mật khẩu:  Xy3…24 ký tự                  [Copy]   │
│  ⚠ LƯU NGAY — form .env trên máy Muse sẽ hỏi lại.  │
│                [ ← Bước trước ]  [ Tiếp → ]        │
└────────────────────────────────────────────────────┘
```

**Wizard B3 — gói cài đặt:**
```
┌───────── Wizard: New Muse — Bước 3/3 ──────────────┐
│  Gói cài đặt: muse_muse_001_setup.zip   [⬇ Tải]    │
│  ┌─ Xem trước setup_guide.txt (cuộn được) ───────┐ │
│  │ 1. Giải nén … 2. python3 -m venv .venv …      │ │
│  └───────────────────────────────────────────────┘ │
│  [ Copy nội dung hướng dẫn ]                       │
│  📌 Gửi zip + nội dung txt này cho Muse.           │
│  (fetch templates lỗi khi file:// → toast cảnh     │
│   báo: chạy python -m http.server trong web/)      │
│                [ ← Bước trước ]  [ Hoàn tất ]      │
└────────────────────────────────────────────────────┘
```

**Modal Token:**
```
┌───────── Token của "Tên Muse A" ────────────┐
│  Thông tin đăng nhập cho muse_client.py     │
│  Email:   muse_001@muserelay.local  [Copy]  │
│  Secret:  ●●●●●●●●●●●●●●            [Copy]  │
│  (GET projects?id=eq.X — lấy giá trị mới)   │
│                                     [Đóng]  │
└─────────────────────────────────────────────┘
```

**Modal xác nhận Xóa:**
```
┌───────── Xoá Muse? ─────────────────────────┐
│  Xoá "Tên Muse A" (muse_001)?               │
│  Sẽ xoá: user auth + project + TOÀN BỘ      │
│  threads/messages (cascade). Không hoàn tác.│
│        [ Huỷ ]   [ Xoá vĩnh viễn ]  ← đỏ    │
└─────────────────────────────────────────────┘
```

### B3. Trạng thái rỗng & loading (cảm giác agent-IDE)

- **Sidebar rỗng** (chưa project nào): một dòng text dim giữa sidebar — "Chưa có Muse nào. Bấm ＋ New để tạo Muse đầu tiên." Nút ＋ New vẫn nổi rõ ở header.
- **Chưa chọn thread** (mới chọn project / vào app): khung phải center text dim giống bản cũ — "Chọn một thread phía trên (mới tạo: nhắn tin đầu tiên để gọi Muse)". Composer vẫn hiện nhưng nút Gửi khoá khi chưa có thread.
- **Thread rỗng** (thread mới chưa tin): duy nhất 1 bubble placeholder hệ thống — "Chưa có tin nào. Gửi lời đầu cho <name> — Muse trả lời qua client chạy trên máy nó (mất vài giây theo POLL_INTERVAL)."
- **Loading kiểu IDE**: sidebar lúc fetch đầu = vài thẻ xám shimmer (không spinner to); khung chat khi mở thread = spinner nhỏ giữa vùng chat; composer không khoá khi đang load (được gõ trước). Nút Gửi: khoá + nhãn "Đang gửi…" trong lúc POST; nút wizard "Tạo Muse" tương tự. Mọi loading ngắn (<300ms hiển thị trễ để tránh nhấp nháy).

### B4. Điểm nhấn UX

- **Composer**: Enter gửi / Shift+Enter xuống dòng (kiểm tra `shiftKey`); textarea tự giãn theo nội dung (tối đa ~6 dòng rồi cuộn); trim trước khi gửi; rỗng → nút Gửi mờ; sau gửi giữ focus về composer; gửi fail → trả text về composer (A3).
- **Badge unread realtime**: đếm tin `id > last_read_id`, badge tròn nền xanh `--me` góc phải thẻ, ẩn khi 0; cập nhật tức thì từ realtime INSERT.
- **Preview tin cuối trên sidebar**: 1 dòng ellipsis, prefix "Bạn:"/"Muse:" theo role, kèm thời gian tương đối (vừa xong / n phút / n giờ / hôm qua / dd/mm).
- **Tag chips 3 màu**: `chat` = xanh dương, `image` = xanh lá, `video` = tím — hiện ở cả thẻ sidebar lẫn header project; render từ `tags[]` thật, không chip nào khi tags rỗng.
- **Link Dropbox** (`https://(www.)?dropbox.com/…` hoặc `https://dl.dropboxusercontent.com/…`): text giữ nguyên, link được render thêm thành card đính kèm có biểu tượng ⬇, bấm mở tab mới (?dl=1 ưu tiên tải).
- **Timestamp vi-VN**: `toLocaleString('vi-VN')` dạng `10:24 · 16/11/2026` trong bubble.

### B5. Theme DNA (từ `static/index.html` — spec §8 "dark theme giống bản cũ")

| Token | Giá trị | Dùng cho |
|---|---|---|
| `--bg` | `#0f141a` | nền app |
| `--panel` | `#171e26` | sidebar, composer, input |
| `--line` | `#243040` | viền, đường kẻ |
| `--me` | `#2f6fed` | bubble user (phải), badge unread, nút chính, chip chat |
| `--muse` | `#243244` | bubble muse (trái) |
| `--text` | `#e8eef5` | chữ chính |
| `--dim` | `#8b9bb0` | chữ phụ, placeholder, timestamp |
| hover/active thẻ | `#1d2632` / `#22304a` | trạng thái thẻ sidebar |
| chip image / chip video | xanh lá / tím (tông sáng vừa nền tối) | tag chips |

- Font `system-ui`, radius 8–12px, bubble max-width 70%, dark-only. **Không làm light mode / theme toggle** — spec §8 chốt dark theme một file, tasklist cấm thêm tính năng ngoài spec (lệch có chủ đích với mặc định cá nhân của ArchitectUX; đã báo orchestrator).
- Không responsive/mobile — layout desktop IDE cố định theo §8 và luật tasklist số 8.

---

## C. THỨ TỰ TRIỂN KHAI CHO DEVELOPER

1. **T5 — nền**: khung 1 file `web/index.html` (style tokens B5 → layout → components), CDN pin supabase-js@2 + jszip@3, Settings + "Kiểm tra kết nối" + toast + localStorage. Để sẵn chỗ mở rộng cho T6/T7 (một file duy nhất).
2. **T6 — sườn dữ liệu**: state A5 → fetch lần đầu (threads + messages desc 200) → render sidebar (preview/unread/chips) → header + dropdown thread → khung chat (GET 500 + PATCH last_read_id) → composer → realtime channel + fallback 30s (A4) → nhận diện link Dropbox.
3. **T7 — lớp quản trị**: wizard 3 bước (regex muse_id, check trùng live, password 24 ký tự `crypto.getRandomValues`, POST admin user + INSERT project, JSZip 7 file với `.env` chỉ điền URL/ANON/CAPABILITIES), modal Token, modal Xóa, workflow `pages.yml` (push main + workflow_dispatch, artifact thư mục `web/`).
4. Đối chiếu chéo endpoint/field theo §3 ở từng bước; mọi chuỗi UI tiếng Việt (§0); KHÔNG key thật trong code; không đụng file cũ và `supabase/setup.sql`.

---
**ArchitectUX — handoff cho frontend-developer (T5→T7) và backend-architect (T1→T4). Bám 100% spec §1–§9; không thêm tính năng ngoài spec.**
