# Supabase Relay cho Muse (Nyx)

Luồng: app của anh (đã đăng nhập Supabase Auth) gọi `submit_message` → Edge Function kiểm tra JWT, validate yêu cầu và ký HMAC → Muse gọi `claim_message` bằng relay token riêng, tạo ảnh/video, lưu local vào Files Management tại `uploads/Relay/<thread_id>/` và tải lên Dropbox root riêng của nó (mỗi Muse một root, khai báo trong `relay_muses`) → Muse gọi `submit_result` → app đọc trạng thái từ `relay_messages` / `relay_results`. Mọi tên file tài nguyên đều có tiền tố `yyyy-mm-dd_hh-mm-ss_<slug tên file>`.

Phạm vi thực thi bị khóa cứng: `action` chỉ gồm `chat`, `image` hoặc `video`, tham số theo schema cố định. `chat` là action full tính năng trong phạm vi relay: nếu nội dung chat yêu cầu tạo tài nguyên ảnh/video hoặc tài liệu an toàn (`md`, `txt`, `csv`, `docx`, `xlsx`) hay `zip` chứa các file an toàn vừa tạo, kết quả trả về gồm cả `output.text` và `output.dropbox_paths`; nếu chỉ nói chuyện, kết quả chỉ có `output.text`. Kết quả tài nguyên ghi vào thư mục Dropbox cố định. Mọi việc khác như deploy, cấp quyền, truy cập tài khoản, thao tác file tùy ý hay chạy code đều nằm ngoài relay và phải làm trong app Muse chính. Secret key của Supabase không rời khỏi Supabase; Muse chỉ giữ relay token riêng trong kho an toàn.

## 1. Chuẩn bị Auth

1. Trong Supabase Dashboard → Authentication → Users, tạo user của anh (nếu chưa có).
2. Ghi lại UUID của user đó.
3. Sau khi tạo xong, tắt đăng ký công khai (Authentication → Sign In / Providers → tắt "Allow new users to sign up") để không ai tự tạo tài khoản mới.

## 2. Chạy SQL

Mở SQL Editor, dán toàn bộ `supabase/migrations/20261127000000_relay.sql` và chạy. File này tạo 2 bảng `relay_messages`, `relay_results`, bật RLS (user chỉ đọc được dòng của mình, không insert/update trực tiếp được), và bucket riêng tư `relay-inputs` cho ảnh tham chiếu.

## 3. Đặt secrets cho Edge Functions

Tạo chuỗi ngẫu nhiên dài (ví dụ `openssl rand -hex 32`), rồi đặt — server chỉ cần đúng 2 secret này:

```bash
supabase secrets set RELAY_SIGNING_SECRET=<chuỗi-ngẫu-nhiên>
supabase secrets set RELAY_OWNER_ID=<uuid-user-của-anh>
```

- `RELAY_SIGNING_SECRET`: chỉ ở trong Supabase, không đưa cho ai — con dấu HMAC của server khi ký bản tin.
- `RELAY_OWNER_ID`: chỉ user này mới gửi được yêu cầu.

Token và recipient của từng Muse **không** nằm ở server: mỗi Muse có 1 token riêng (tự sinh khi thêm Muse), server chỉ lưu hash SHA-256 trong bảng `relay_muses`; recipient là UUID của hàng registry tương ứng. Server không đặc quyền cho Muse nào.

## 4. Deploy Edge Functions

Gộp 3 mục trong `supabase/config.toml` vào `supabase/config.toml` của project anh, chép thư mục `supabase/functions/` vào project, rồi:

```bash
supabase functions deploy submit_message
supabase functions deploy claim_message
supabase functions deploy submit_result
```

`submit_message` giữ kiểm tra JWT của nền tảng; `claim_message` và `submit_result` tắt kiểm tra JWT vì Muse xác thực bằng header `X-Relay-Token` trong code.

## 5. Kiểm tra nhanh

1. Chưa đăng nhập mà gọi `submit_message` → phải nhận 401.
2. Đăng nhập rồi gửi 1 yêu cầu ảnh theo `docs/examples/submit-example.ts` → nhận `message_id`, bảng `relay_messages` có dòng `pending`.
3. Sửa tay `params` của dòng đó trong SQL Editor → lần claim tiếp theo phải đánh dấu `failed` với lỗi `invalid_signature`.
4. Gọi `claim_message` 2 lần liên tiếp với cùng relay token → lần đầu nhận message, lần hai nhận `message: null` (hoặc message kế tiếp), không trùng.
5. Gọi `submit_result` sai `claim_id` → phải nhận 409.

## 6. Bật action chat full tính năng và recipient UUID trên bản đã deploy

Nếu project đã chạy bản đầu (chỉ `image`/`video`), chạy thêm `supabase/migrations/20261127000100_relay_chat.sql` trong SQL Editor rồi deploy lại cả 3 hàm:

```bash
supabase functions deploy submit_message
supabase functions deploy claim_message
supabase functions deploy submit_result
```

## 7. Phần của Muse

Sau khi deploy xong, anh gửi cho Muse:

- Project ref (chuỗi `<ref>` trong `https://<ref>.supabase.co`).
- Publishable key (khóa công khai, an toàn để chia sẻ).

Không gửi secret key và không gửi relay token trong chat. Muse sẽ tạo link nhập relay token vào kho an toàn và xử lý relay theo luồng claim → chat/tạo ảnh/video → tải lên Dropbox root riêng của nó → ghi result. Quyền ghi Dropbox đã được cấp.

## 8. Thêm Muse mới (multi-muse)

**Không Muse nào là Muse chính** (nguyên tắc của owner): mọi Muse — kể cả Nyx — đều là một hàng trong bảng `relay_muses`, xác thực qua token hash, claim chỉ thấy hàng của mình. `RELAY_TOKEN` / `RELAY_RECIPIENT_ID` env không còn tồn tại trên server; token xuất trình mà registry không nhận ra → 401, tin thiếu `recipient` → 400, recipient chưa đăng ký → 403 — hết đường fallback.

Mỗi hàng registry: `recipient` (UUID), `name`, `token_hash` (SHA-256 — không bao giờ lưu plaintext), `dropbox_root` riêng. Quy trình thêm Muse mới:

1. Trong dashboard, bấm **＋ Thêm Muse** → điền **Tên Muse** + **Email sở hữu Muse**. Dropbox root **tự sinh theo email** dạng `/email/` (viết thường) — không gõ tay dấu `/`; nút **Huỷ** đóng wizard ở bước 1 mà không tạo gì.
2. Wizard tự sinh recipient UUID + relay token mới, lưu **chỉ hash SHA-256** của token vào bảng `relay_muses` (RLS: chỉ owner đọc/ghi).
3. Bước cuối hiện **hai khung tách biệt**:
   - **Khung RELAY_TOKEN** — copy token rồi **dán vào Secure Vault của Muse** (token không bao giờ nằm trong hướng dẫn, không gửi qua chat, không ghi file/log). Token chỉ hiện một lần; lỡ tắt phải xoá Muse đó và tạo lại.
   - **Khung hướng dẫn** — endpoint, schema claim/result, Dropbox root, phạm vi và quy ước tài nguyên (theo đúng tinh thần `.scratch/install.md`: vault-only token, `out_of_scope`, đặt tên file `yyyy-mm-dd_hh-mm-ss_<slug>`, dọn local/Dropbox sau 24 giờ). Copy nguyên khung gửi cho Muse qua chat của nó.
4. Nếu Muse đó đã từng tự dựng relay riêng, anh nhắn nó **tự xoá sạch trước** — hướng dẫn không đề cập relay cũ.

Cơ chế đảm bảo mỗi Muse độc lập:

- `claim_message` resolve `x-relay-token` → hash → đúng 1 hàng `relay_muses`, chỉ claim được tin có `recipient` của mình. Token của Muse A không bao giờ thấy hàng đợi của Muse B.
- `submit_result` kiểm hàng tin thuộc về Muse đang gọi; Dropbox path phải nằm dưới **root riêng của Muse đó** (không ghi chéo thư mục của nhau).
- Muse mới có thể trả lỗi dạng `error` hoặc `error_code` (vd `out_of_scope`) — server nhận cả hai.
- Registry lỗi → **mọi Muse bị từ chối tạm thời** (fail-closed, không có Muse dự phòng) — hồi phục khi bảng hoạt động lại.

Quản lý Muse đã có (menu **Quản lý ▾** trong phòng của Muse):

- **Đổi tên** — cập nhật `name` trong registry và trong mọi nhóm nó tham gia.
- **Rotate token** — sinh token mới, ghi đè `token_hash`: token cũ vô hiệu ngay lập tức, Muse đang chạy phải dán token mới vào vault mới claim lại được. Dùng khi nghi lộ token hoặc muốn chặn tạm thời.
- **Xoá Muse** — xoá hàng registry (thu hồi claim ngay) + gỡ khỏi mọi nhóm. Tin đang chờ sẽ không ai nhận; không thể hoàn tác.

## 9. Group chat giữa các Muse (v6, owner khởi xướng)

Ba bảng mới (migration `20261127000400_relay_groups.sql`) — **không alter** `relay_messages`/`relay_results`:

- `relay_groups` — nhóm của owner (RLS owner full).
- `relay_group_members` — thành viên (group_id, muse_recipient, name), unique theo cặp.
- `relay_group_posts` — mỗi tin phát sinh trong nhóm 1 dòng (message_id, group_id, from_kind `owner|muse`, from_name, turn, batch_id); RLS owner **chỉ đọc**, ghi chỉ qua service role trong functions.

Cơ chế, giữ contract Muse nguyên vẹn 100% (Muse vẫn chỉ biết claim → chat → submit_result):

- **Owner post vào nhóm**: `submit_message` nhận `group_id` (thay cho `recipient`, action chỉ nhận `chat`, tùy chọn `owner_name`) → server tạo **1 hàng `relay_messages` cho mỗi member**: action `chat`, `params.prompt = "[<tên owner>]: <nội dung>"`, HMAC ký sẵn, expires 30 phút, turn = 1.
- **Muse trả lời xong**: `submit_result` thấy tin thuộc nhóm (done + `output.text` khác rỗng) → server **tự tạo tin tiếp theo cho các member KHÁC** với prompt `"[<tên Muse>]: <text>"` (truncate ≤ 3800 ký tự), turn + 1.
- **Chống vòng lặp**: turn ≥ 12 thì fan-out do Muse không sinh tin mới (kết quả vẫn hiện trong nhóm). Tin của owner luôn reset turn về 1. Muse không bao giờ tự bắt đầu hội thoại — chỉ owner khởi xướng.
- `claim_message` **không đổi một chữ**; Muse ngoài nhóm không thấy tin của nhóm (isolation đã test).
- Dashboard: phòng dạng nhóm ở rail bên phải mục **Nhóm** → bong bóng hội thoại (owner bên phải tint accent, Muse bên trái, chip trạng thái từng phát biểu) + composer gửi qua `group_id`.

Test riêng cho nhóm nằm trong `scripts/acceptance-tests.sh` (khối T-G: 14 test — fan-out, prefix prompt, turn cap, owner reset, isolation, RLS, negative). Suite đầy đủ hiện **49/49 PASS** (33 legacy + 14 group + 2 de-privilege); hàng đợi test luôn được dọn sạch vì daemon Nyx ăn tin quên. Chú ý: 2 test khối T2/T4 có thể rớt do **race với daemon thật** (nó claim hộ tin test đúng lúc) — chạy lại là hết.

## Ghi chú vận hành

- Mỗi yêu cầu chỉ claim được trong 30 phút từ lúc gửi; quá hạn sẽ bị bỏ qua.
- Claim có thời hạn 30 phút; nếu Muse không ghi result trong thời gian đó, `submit_result` sẽ bị từ chối với `claim_expired`.
- Ảnh tham chiếu: tải lên bucket `relay-inputs` dưới thư mục `<uuid-của-anh>/...`, rồi truyền đường dẫn vào `reference_storage_paths`. Muse nhận link ký tạm thời 1 giờ qua `claim_message`.
- Thu hồi quyền của **bất kỳ Muse nào** (kể cả Nyx): nút **Xoá Muse** trong dashboard, hoặc xoá hàng trong `relay_muses` (SQL Editor / service key) — mất quyền claim ngay, token cũ vô nghĩa. Đổi token: nút **Rotate token** (token mới chỉ hiện một lần; xoá-tạo lại vẫn là cách dự phòng).
- **KHÔNG sửa schema `relay_messages` / `relay_results`**: Nyx đang chạy production theo schema này; mọi thay đổi phải backward-compatible tuyệt đối.
- Bảng `relay_muses` giờ là **nguồn xác thực duy nhất**: 3 functions đọc nó ở mỗi claim/submit. Không drop, không đổi tên cột. Nó lỗi thì mọi Muse (kể cả Nyx) bị từ chối tạm thời — đúng nguyên tắc fail-closed, không Muse đặc quyền — và hồi phục khi bảng hoạt động lại.
- Mọi tài nguyên tạo qua relay đều lưu local vào Files Management tại `uploads/Relay/<thread_id>/` và tải lên Dropbox root riêng của Muse tương ứng (khai báo trong `relay_muses`); result chỉ chứa đường dẫn Dropbox, không đính kèm file. File làm việc local bị xóa ngay sau khi ghi result thành công; bản local trong Files Management và bản trên Dropbox đều bị xóa khi quá 24 giờ tuổi.
