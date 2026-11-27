# HANDOFF — muse-relay phiên tiếp theo (v6: group chat giữa các Muse + redesign UI)

> Cách dùng: mở hội thoại ZCode MỚI trong `D:\www\muse-relay`, dán nguyên khối
> **PROMPT CHÍNH** bên dưới. Memory index của project sẽ tự nạp thêm ngữ cảnh.

---

## PROMPT CHÍNH (dán nguyên khối này vào phiên mới)

Tiếp tục dự án muse-relay. Trạng thái đã chốt ở phiên trước — **đọc kỹ, không thiết kế lại** các phần ghi "ĐÃ CHỐT".

### 1) Trạng thái hiện tại (ĐÃ CHỐT)

- Relay **v5 multi-muse LIVE** trên Supabase project "Muse Relay v2" (ref `oxhhhuklumscmyopjayv`), acceptance **33/33 PASS**. Commit local `0a02d4b` trên branch `new` (72 files: purge v6/v7 cũ + toàn bộ v5) — **CHƯA push** (chủ đăng chặn push để bàn giao; việc đầu tiên của bạn là `git push -u origin new`).
- Kiến trúc: 3 Edge Functions — `submit_message` (verify_jwt=true), `claim_message` + `submit_result` (verify_jwt=false, xác thực bằng header `x-relay-token`). Bảng: `relay_messages`, `relay_results`, `relay_muses` (registry multi-muse, token chỉ lưu **hash SHA-256**; hàng Nyx là display-only token_hash NULL). Bucket riêng tư `relay-inputs`. RLS owner-only cho app; functions dùng service role.
- Claim response (canonical, KHÔNG đổi): `{message: {id, claim_id, recipient, action, params, reference_signed_urls, claim_expires_at}}` hoặc `{message: null}`. Lease 30 phút, claim window 30 phút, HMAC ký `{id,owner_id,recipient,action,params,nonce,expires_at_unix}` (stable key-sorted stringify).
- **Nyx** = đường legacy: token ở secrets `RELAY_TOKEN`/`RELAY_RECIPIENT_ID`, Dropbox prefix `/nolanthomas825cxoz@lappies.net/`, daemon LIVE claim ~80s. `resolveMuse()` tra `relay_muses` theo hash trước, lỗi/miss → fallback legacy.
- Dashboard `dashboard/index.html` (static, supabase-js UMD CDN): login email+password, phòng theo từng Muse, wizard **＋ Thêm Muse** (sinh recipient UUID + token, token chỉ hiện 1 lần, bước cuối copy khung hướng dẫn gửi Muse), server test đang chạy `python -m http.server 8123 --directory dashboard --bind 127.0.0.1`.
- Suite: `scripts/acceptance-tests.sh` (33 test, kết thúc có sweep xoá `params->>prompt=like.%5BACCEPTANCE%5D*` vì daemon Nyx ăn tin quên). Deploy: `scripts/deploy-functions.sh` (npx supabase, cần `--yes`).
- Muse #2 (recipient `5477f339-2407-4d2f-8116-f4ffa0ee15d4`) chưa đăng ký — ANH sẽ tự dùng wizard, bạn không cần làm gì phần này.

### 2) Việc phải làm, theo thứ tự

**Bước 0 — push:** `git push -u origin new`. (Chủ đăng ĐÃ cấp quyền commit + push cho phiên này; commit và push lại sau khi xong mỗi phần lớn.)

**Bước 1 — GROUP CHAT: các Muse nói chuyện với nhau trong group, owner khởi xướng.** Thiết kế ĐÃ CHỐT:

- **2+1 bảng MỚI** (migration `20261127000400_relay_groups.sql`), **KHÔNG alter `relay_messages`/`relay_results`**:
  - `relay_groups` (id uuid pk, owner_id uuid, name text, created_at) — RLS owner full (`owner_id = (select auth.uid())`), owner insert trực tiếp từ dashboard.
  - `relay_group_members` (group_id fk, muse_recipient uuid, name text, joined_at; unique(group_id, muse_recipient)) — RLS owner full.
  - `relay_group_posts` (message_id uuid pk fk→relay_messages, group_id fk, owner_id uuid, from_kind text check in ('owner','muse'), from_name text, turn int) — RLS **owner SELECT only**; ghi chỉ qua service role trong functions.
- **Fan-out giữ contract Muse nguyên vẹn 100%** — Muse vẫn chỉ biết claim → chat → submit_result:
  - Owner post vào group: `submit_message` nhận `body.group_id` (thay cho `recipient`; action chỉ nhận `chat` trong group). Server resolve members từ `relay_group_members` (service role), tạo **1 hàng `relay_messages` cho MỖI member**: action `chat`, `params = {prompt: "[<from_name>]: <nội dung>"}` (from_name = tên owner trong group), status pending, HMAC ký bằng `signMessage()` đã có, `owner_id` = owner uid, expires 30 phút. Ghi 1 hàng `relay_group_posts` cho mỗi tin sinh ra (turn = 1, from_kind 'owner').
  - Muse trả lời: `submit_result` trên tin thuộc group (join `relay_group_posts`), status `done`, action `chat`, `output.text` khác rỗng → server **tự tạo tin tiếp theo cho các member KHÁC**: prompt `"[<tên Muse vừa trả lời>]: <text>"` (truncate text còn ≤ ~3800 ký tự + "…"), turn = turn cũ + 1, from_kind 'muse'. Muse khác claim như công việc bình thường. Owner thấy tất cả qua dashboard (đọc DB trực tiếp).
  - **Chống vòng lặp vô hạn:** nếu `turn >= 12`, fan-out do Muse KHÔNG tạo tin mới (kết quả vẫn hiện trong group); tin của owner luôn được gửi và **reset turn về 1**. Owner = người khởi xướng duy nhất: tin đầu tiên của một group phải từ owner (Muse không bao giờ tự bắt đầu — cơ chế claim sẵn đảm bảo điều này).
  - `claim_message`: **KHÔNG đổi một chữ**. Muse không thuộc group: mọi path cũ y nguyên (không có group_id → behavior cũ).
- **Dashboard (làm cùng bước redesign ở Bước 2):** phòng loại "Group" mới — tạo group (đặt tên, tick chọn các Muse từ `relay_muses`), hội thoại dạng **bubble chat** (owner 1 bên, các Muse phân biệt màu/tên), composer gửi vào group qua `{group_id, action:'chat', params}`, status từng post (pending/processing/done + text/paths từ `relay_results` join theo `message_id`), refresh 10s như hiện tại.
- **Tests** (thêm vào `scripts/acceptance-tests.sh`, khối mới sau T-MM, chạy TRƯỚC các test legacy khác để hàng đợi sạch): tạo 2 muse test trong `relay_muses` (hash token như T-MM) + 1 group; owner post → cả 2 member nhận tin riêng (claim bởi token đúng member); member A trả lời (submit_result done + text) → member B nhận tin mới với prompt prefix "[<A>]:"; turn >= 12 không sinh tin mới; tin owner reset turn; Muse ngoài group không thấy tin group; **không bao giờ gửi tin test cho recipient Nyx thật**; dọn sạch group/members/posts/messages cuối khối. Suite phải 100% xanh + các test legacy vẫn xanh (bằng chứng Nyx không bị ảnh hưởng), deploy functions, chạy suite.

**Bước 2 — Gọi skill `hallmark` redesign giao diện dashboard cho thật đẹp.** Phạm vi: toàn bộ app — màn login, thanh phòng (Muse + Groups), group chat bubbles, wizard Thêm Muse, composer, danh sách công việc. **Chỉ đổi UI/CSS/markup — KHÔNG đổi logic gọi API** (tên bảng, payload, endpoints giữ nguyên). Giao diện tiếng Việt, giữ đủ thông tin như bản hiện có.

**Bước 3 — chốt:** cập nhật `supabase/README.md` (thêm mục group chat: cách tạo group, quy tắc owner khởi xướng, giới hạn turn), commit + push.

### 3) Nguyên tắc bắt buộc (không vi phạm)

1. **Nyx là production frozen** (mệnh lệnh chủ đăng): mọi thay đổi function/schema phải additive + fallback-safe cho đường legacy; bảng `relay_messages`/`relay_results` KHÔNG alter; bằng chứng = suite legacy xanh + daemon thật vẫn chạy.
2. **Bảo mật:** không bao giờ in giá trị `.env` (chỉ tên biến); RELAY_TOKEN/token Muse chỉ vào vault Muse, không qua chat/log; publishable key + ref + recipient UUID là public-safe.
3. **Mỗi Muse tin mình là DUY NHẤT** (máy riêng, không phải agent trỏ về server lớn): không bao giờ tiết lộ sự tồn tại của Muse anh em trong text hướng dẫn/response; owner là người khởi xướng mọi hội thoại.
4. **Harness Windows Git Bash:** không đưa tiếng Việt/quote vào curl argv — JSON body viết ra FILE (`printf %s` hoặc python), đọc response bằng `python -X utf8`; temp file để dưới `.scratch/`; `npx --yes supabase` cho CLI; Management API `POST /v1/projects/{ref}/database/query` với PAT từ `.env` để apply migration (SQL viết file → python bọc JSON → curl `--data-binary @file`).
5. Repo: `.env`, `.scratch/`, `client/config.json`, `client/state/` đã git-ignored — đừng bao giờ commit chúng.

### 4) Chấp nhận xong khi nào

- `git log` có ≥2 commit mới (group chat + UI), cả hai đã push lên `origin/new`.
- Suite acceptance in `RESULT: PASS=… FAIL=0` với tổng số test ≥ 40 (33 cũ + group mới).
- Dashboard có thể: tạo group 2 Muse, owner nói đầu → Muse A claim → A trả lời → Muse B nhận lời A → B trả lời → owner thấy đủ hội thoại dạng bubble.
- Nyx: tin thật vào phòng Nyx vẫn done bình thường (không bị ảnh hưởng).

---

## Ghi chú cho chủ đăng (không dán vào phiên mới)

- Commit `0a02d4b` đã chứa toàn bộ v5 + purge v6/v7; nếu muốn xem lại: `git show 0a02d4b --stat`.
- Nếu phiên mới hỏi về quyết định đã có sẵn trong tài liệu này → trả lời nó đọc lại mục tương ứng, không tranh luận lại.
- Trên dashboard hiện tại, anh vẫn dùng được đầy đủ v5 trong lúc chờ phiên mới (phòng Muse + wizard).
