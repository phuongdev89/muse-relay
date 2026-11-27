# Supabase Relay cho Muse (Nyx)

Luồng: app của anh (đã đăng nhập Supabase Auth) gọi `submit_message` → Edge Function kiểm tra JWT, validate yêu cầu và ký HMAC → Muse gọi `claim_message` bằng relay token riêng, tạo ảnh/video, lưu local vào Files Management tại `uploads/Relay/<thread_id>/` và tải lên Dropbox `/nolanthomas825cxoz@lappies.net/<thread_id>/` → Muse gọi `submit_result` → app đọc trạng thái từ `relay_messages` / `relay_results`. Mọi tên file tài nguyên đều có tiền tố `yyyy-mm-dd_hh-mm-ss_<slug tên file>`.

Phạm vi thực thi bị khóa cứng: `action` chỉ gồm `chat`, `image` hoặc `video`, tham số theo schema cố định. `chat` là action full tính năng trong phạm vi relay: nếu nội dung chat yêu cầu tạo tài nguyên ảnh/video hoặc tài liệu an toàn (`md`, `txt`, `csv`, `docx`, `xlsx`) hay `zip` chứa các file an toàn vừa tạo, kết quả trả về gồm cả `output.text` và `output.dropbox_paths`; nếu chỉ nói chuyện, kết quả chỉ có `output.text`. Kết quả tài nguyên ghi vào thư mục Dropbox cố định. Mọi việc khác như deploy, cấp quyền, truy cập tài khoản, thao tác file tùy ý hay chạy code đều nằm ngoài relay và phải làm trong app Muse chính. Secret key của Supabase không rời khỏi Supabase; Muse chỉ giữ relay token riêng trong kho an toàn.

## 1. Chuẩn bị Auth

1. Trong Supabase Dashboard → Authentication → Users, tạo user của anh (nếu chưa có).
2. Ghi lại UUID của user đó.
3. Sau khi tạo xong, tắt đăng ký công khai (Authentication → Sign In / Providers → tắt "Allow new users to sign up") để không ai tự tạo tài khoản mới.

## 2. Chạy SQL

Mở SQL Editor, dán toàn bộ `supabase/migrations/20261127000000_relay.sql` và chạy. File này tạo 2 bảng `relay_messages`, `relay_results`, bật RLS (user chỉ đọc được dòng của mình, không insert/update trực tiếp được), và bucket riêng tư `relay-inputs` cho ảnh tham chiếu.

## 3. Đặt secrets cho Edge Functions

Tạo 2 chuỗi ngẫu nhiên dài riêng biệt (ví dụ `openssl rand -hex 32` chạy 2 lần), rồi đặt:

```bash
supabase secrets set RELAY_SIGNING_SECRET=<chuỗi-ngẫu-nhiên-1>
supabase secrets set RELAY_TOKEN=<chuỗi-ngẫu-nhiên-2>
supabase secrets set RELAY_OWNER_ID=<uuid-user-của-anh>
supabase secrets set RELAY_RECIPIENT_ID=<recipient-uuid>
```

Tạo `RELAY_RECIPIENT_ID` bằng đoạn code này rồi báo mã UUID cho Muse:

```js
const recipientId = crypto.randomUUID();
console.log(recipientId);
```

- `RELAY_SIGNING_SECRET`: chỉ ở trong Supabase, không đưa cho ai.
- `RELAY_TOKEN`: lát nữa anh nhập vào link an toàn của Muse, không gửi trong chat.
- `RELAY_OWNER_ID`: chỉ user này mới gửi được yêu cầu và được claim.
- `RELAY_RECIPIENT_ID`: mã recipient dạng UUID giống `RELAY_OWNER_ID`; app gửi kèm `recipient` này khi gọi `submit_message`.

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
2. Đăng nhập rồi gửi 1 yêu cầu ảnh theo `client/submit-example.ts` → nhận `message_id`, bảng `relay_messages` có dòng `pending`.
3. Sửa tay `params` của dòng đó trong SQL Editor → lần claim tiếp theo phải đánh dấu `failed` với lỗi `invalid_signature`.
4. Gọi `claim_message` 2 lần liên tiếp với cùng relay token → lần đầu nhận message, lần hai nhận `message: null` (hoặc message kế tiếp), không trùng.
5. Gọi `submit_result` sai `claim_id` → phải nhận 409.

## 6. Bật action chat full tính năng và recipient UUID trên bản đã deploy

Nếu project đã chạy bản đầu (chỉ `image`/`video`), chạy thêm `supabase/migrations/20261127000100_relay_chat.sql` trong SQL Editor. Sau đó đặt `RELAY_RECIPIENT_ID` như mục 3 và deploy lại cả 3 hàm:

```bash
supabase functions deploy submit_message
supabase functions deploy claim_message
supabase functions deploy submit_result
```

## 7. Phần của Muse

Sau khi deploy xong, anh gửi cho Muse:

- Project ref (chuỗi `<ref>` trong `https://<ref>.supabase.co`).
- Publishable key (khóa công khai, an toàn để chia sẻ).

Không gửi secret key và không gửi relay token trong chat. Muse sẽ tạo link nhập relay token vào kho an toàn và xử lý relay theo luồng claim → chat/tạo ảnh/video → tải lên Dropbox `/nolanthomas825cxoz@lappies.net/<thread_id>/` → ghi result. Quyền ghi Dropbox đã được cấp.

## 8. Thêm Muse mới (multi-muse, từ v5)

Nyx là đường **legacy**: token nằm ở secrets `RELAY_TOKEN` / `RELAY_RECIPIENT_ID`, không đụng vào, daemon đang live. Các Muse mới đăng ký qua bảng `relay_muses`:

1. Trong dashboard, bấm **＋ Thêm Muse** → điền tên + Dropbox root của nó (thư mục gốc xuất kết quả, dạng `/ten@domain.com/`).
2. Wizard tự sinh recipient UUID + relay token mới, lưu **chỉ hash SHA-256** của token vào bảng `relay_muses` (RLS: chỉ owner đọc/ghi).
3. Bước cuối hiện khung hướng dẫn hoàn chỉnh (endpoint, schema claim/result, Dropbox root, token) — copy nguyên khung gửi cho Muse qua chat của nó. **Token chỉ hiện một lần**; lỡ tắt phải xoá Muse đó và tạo lại.

Cơ chế đảm bảo mỗi Muse độc lập:

- `claim_message` resolve `x-relay-token` → hash → đúng 1 hàng `relay_muses`, chỉ claim được tin có `recipient` của mình. Token của Muse A không bao giờ thấy hàng đợi của Muse B.
- `submit_result` kiểm hàng tin thuộc về Muse đang gọi; Dropbox path phải nằm dưới **root riêng của Muse đó** (không ghi chéo thư mục của nhau).
- Muse mới có thể trả lỗi dạng `error` hoặc `error_code` (vd `out_of_scope`) — server nhận cả hai.
- Nếu bảng `relay_muses` lỗi, chỉ các Muse mới bị từ chối — đường legacy của Nyx vẫn hoạt động.

## Ghi chú vận hành

- Mỗi yêu cầu chỉ claim được trong 30 phút từ lúc gửi; quá hạn sẽ bị bỏ qua.
- Claim có thời hạn 30 phút; nếu Muse không ghi result trong thời gian đó, `submit_result` sẽ bị từ chối với `claim_expired`.
- Ảnh tham chiếu: tải lên bucket `relay-inputs` dưới thư mục `<uuid-của-anh>/...`, rồi truyền đường dẫn vào `reference_storage_paths`. Muse nhận link ký tạm thời 1 giờ qua `claim_message`.
- Thu hồi quyền của Nyx: đổi `RELAY_TOKEN` trong secrets, Muse mất quyền claim ngay.
- Thu hồi quyền của Muse mới: xoá hàng tương ứng trong `relay_muses` (SQL Editor hoặc service key) — mất quyền claim ngay, token cũ vô nghĩa.
- **KHÔNG sửa schema `relay_messages` / `relay_results`**: Nyx đang chạy production theo schema này; mọi thay đổi phải backward-compatible tuyệt đối.
- Bảng `relay_muses` là một phần của schema: 3 functions đọc nó ở mỗi claim/submit. Không drop, không đổi tên cột; nếu lỡ lỗi, Nyx không chết (fallback legacy) nhưng các Muse mới sẽ không claim được cho đến khi bảng hoạt động trở lại.
- Mọi tài nguyên tạo qua relay đều lưu local vào Files Management tại `uploads/Relay/<thread_id>/` và tải lên Dropbox `/nolanthomas825cxoz@lappies.net/<thread_id>/`; result chỉ chứa đường dẫn Dropbox, không đính kèm file. File làm việc local bị xóa ngay sau khi ghi result thành công; bản local trong Files Management và bản trên Dropbox đều bị xóa khi quá 24 giờ tuổi.
