# E2E v7 — Trạng thái phía daemon + hợp đồng hai phía

> Nguồn: thread muse.ai `6cf71809-40aa-4e65-aa8f-ceb691dc0da7` (Muse 1) + thread `704bbf36-2857-40ee-9689-2ca1b13ba461`, ngày 18/11.
> Bản thiết kế phía web nằm ở `docs/e2e-webui-design.md` — file này chỉ ghi những gì phía daemon ĐÃ làm và những điểm hai phía phải khớp.

## Trạng thái phía daemon (Muse 1)

- **ĐÃ CODE XONG v7 E2E, 46/46 test đậu** (tự chạy lại bởi Muse 1). Zip `muse-relay-e2e-v7.zip` + `TEST_REPORT.md` nằm trong thread 6cf71809 (link upload hết hạn 48h từ tối 18/11 — cần sync thì nhờ Muse 1 gửi lại link).
- Modules: `crypto.py` (PyNaCl — chỗ DUY NHẤT được gọi), `keys.py`, `safety.py` (mã an toàn), poller + muse_client viết lại kiểu **fail-closed** (tin giả mạo rớt ngay ở bước giải mã, không hiển thị không trả lời).
- File cấu hình chỉ còn bản mẫu, không secret thật trong gói.

## 2 đính chính so với bản thiết kế (bắt buộc ghi nhớ)

1. Cột messages thật là **`text`** (không phải `content`). v7 chỉ ngừng ghi nội dung user vào đó, **GIỮ CỘT** cho 2 tín hiệu cố định `...` (typing) và `pong` (liveness). Muốn bỏ hẳn cột thì HAI PHÍA phải thống nhất chuyển 2 tín hiệu đó vào envelope trước.
2. Mã an toàn là **48 chữ số (12 nhóm × 4)** — con số 60 trong bản thiết kế là typo.

## Hợp đồng crypto (chốt, không đổi)

- **crypto_box** của libsodium (X25519 + XSalsa20-Poly1305). Mã hóa bằng **secret MÌNH + public ĐỐI PHƯƠNG**; giải mã bằng secret mình + public người gửi. Không shared key, không double ratchet.
- Mỗi đầu (browser + daemon) tự tạo keypair. Private key **không bao giờ** rời thiết bị, không gửi server dưới mọi hình thức.
- Chỉ mã hóa **nội dung tin**. Metadata plaintext để định tuyến: `id`, `thread_id`, `role`, `created_at`.
- Bảng mới **`relay_keys`** chỉ chứa public key của các đầu; không private key trên server.
- Xác minh khóa: public key đẩy lên Supabase chỉ là vận chuyển — hai đầu đối chiếu **mã an toàn 48 chữ số** qua kênh NGOÀI relay (chat Muse chính thức) rồi mới mark verified. Public key đổi bất thường → dừng xử lý + cảnh báo.
- Tin giải mã/xác thực thất bại → loại ngay, không hiển thị, không trả lời.

## Đã chốt với owner (không bàn lại)

- BỎ tính năng gợi ý tiêu đề thread tự động (nó phải đọc plaintext DB). Thread hiển thị bằng preview tin đầu sau giải mã hoặc tên user tự đặt.
- Mất private key = mất lịch sử cũ — không backdoor, không recovery key, chỉ có luồng re-key.
- Attachments giai đoạn 1 KHÔNG mã hóa file.
- Tin cũ trước E2E (plaintext) vẫn hiện được, đánh dấu nhẹ là chưa mã hóa.

## Thứ tự cắt chuyển (CHƯA cắt)

1. Web side xong theo `docs/e2e-webui-design.md` (có các điểm `[CẦN DAEMON CHỐT]` ở §7 cần thống nhất với Muse 1).
2. Cross-test bắt buộc: ciphertext tier WebCrypto phải trùng **byte-for-byte** với PyNaCl `crypto_box_easy` (§1.1, §9 của bản thiết kế web).
3. Test liên thông browser ↔ daemon.
4. Owner duyệt → mới cắt chuyển relay đang chạy (client + UI + xử lý tin cũ đồng thời). Cắt sớm = đứt relay vì web chưa đọc được tin mã hóa.

## Attachments — hướng đã chốt 18/11 tối (thread 704bbf36)

- **Google Drive qua rclone** (owner đã gật "setup rclone Drive luôn"). Owner cần làm đúng 1 lần: mở link Google → Cho phép (Google bắt buộc duyệt trên trang Google, trả lời tin nhắn không cấp được quyền).
- Supabase Storage bị owner LOẠI (5GB bandwidth — vài file video là hết). Bỏ Dropbox (2 bước, rườm rà).
- Cần sửa AGENTS.md từ "chỉ Dropbox" sang Drive/rclone + thêm đoạn code up file nhỏ vào relay.

## Bài học từ instruction-test 17/11 (thread 704bbf36)

Password nhập qua **secure form KHÔNG đọc được bởi daemon** (vault của platform không extract được) → mọi pattern cài đặt cho Muse lạ phải để mật khẩu đến được file config/state do **chính Muse viết**. Pattern chuẩn: mật khẩu dùng-1-lần qua chat → Muse đăng nhập trong phút đầu → **tự rotate** bằng GoTrue `PUT /auth/v1/user` → mã qua chat chết trong ~60s.
