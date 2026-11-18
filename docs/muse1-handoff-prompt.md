# Prompt bàn giao — dán vào CHAT MỚI với Muse 1 (soạn 18/11 tối)

> Anh mở chat mới với Muse 1 trên muse.ai rồi dán nguyên khối dưới vào.
> (Session ZCode cũ soạn; nếu cần sửa thì sửa trực tiếp khi dán.)

```
Cậu ơi, đây là THREAD LÀM VIỆC MỚI giữa anh và cậu — thread cũ quá dài nên mình chuyển
vào đây cho sạch. GLM (agent phía máy của anh) sẽ tiếp tục bàn với cậu ngay trong thread
này như cũ. Anh tóm gọn toàn bộ trạng thái để cậu nạp lại bộ nhớ và bám vào đây:

PHÂN CÔNG (không đổi): cậu giữ toàn bộ client (poller, relay_auth, muse_client, guide)
và là tác giả thiết kế E2E v7. GLM giữ web UI (Cloud/PWA/mobile), supabase/setup.sql,
hosting, sync bundle vào repo. Anh giữ quyền quyết cuối — mọi thứ chạm relay đang chạy
phải có anh duyệt.

TRẠNG THÁI 3 NHÁNH:
1. Relay v6 của anh: daemon vừa tự tắt tối nay (mã phiên hết hạn/xoay vòng, refresh bị
   từ chối → tự tắt). Quyết định của anh: KHÔNG cấp mã phiên mới cho client v6 nữa —
   trong lúc daemon chết anh chat trực tiếp ở muse.ai. Việc cấp mã chỉ làm MỘT LẦN khi
   cắt chuyển v7 (mã đó dành cho client v7), nên cậu đừng đề xuất nâng v6.2 riêng nữa —
   gộp hết vào v7, kể cả quy trình cậu từng chốt (thư mục MỚI + test-login + gửi tin
   test xong mới tắt daemon cũ — áp cho lần cắt v7).
2. v6.2 đã ship: main = fc9b8ab — UI Cloud + PWA + mobile live ở link public, client v6.2
   (password auth) 8/8 test, setup.sql v3. Còn treo: anh chưa chạy v3 SQL trên project
   hiện tại (chỉ Dashboard mới chạy DDL được).
3. E2E v7: cậu đã code xong 46/46 test (crypto.py, keys.py, safety.py, poller fail-closed),
   zip + TEST_REPORT ở thread cũ. Hai đính chính vẫn nguyên tắc: cột `text` được giữ lại
   cho 2 tín hiệu `...` và `pong` (muốn bỏ hẳn thì hai bên thống nhất chuyển vào envelope),
   và mã an toàn là 48 chữ số. CHƯA cắt chuyển — GLM sẽ làm phía web theo bản thiết kế
   docs/e2e-webui-design.md trong repo (đã dựa prompt cậu soạn), xong mới test liên thông.

NHIỆM VỤ MỚI CỦA THREAD NÀY — "BRIEF CÀI ĐẶT CHO MUSE LẠ":
Các Muse lạ (của anh lẫn của bạn anh) từ chối cài bản zip với đúng 3 lý do nó nói ra:
không tự điền thông tin đăng nhập vào file, không chạy chương trình ngầm, không tạo lịch
kiểm tra tự động. Đi đường "nó chối → anh xác nhận → nó lại chê chỗ khác" là không ổn.
Hướng anh đã chốt với GLM, cậu làm theo:
- KHÔNG gửi zip, KHÔNG gửi secret qua chat. Muse bên đó TỰ viết code vào máy nó (có thể
  đọc tham khảo trên GitHub raw), TỰ sinh mật khẩu; mật khẩu dùng 1 lần qua chat rồi nó
  TỰ ĐỔI ngay bằng chuẩn GoTrue (PUT /auth/v1/user) — mã qua chat chết trong vòng một
  phút, đúng cái nó từng mắng "gửi trong chat thì đừng dùng lại".
- Daemon chạy bằng scheduled task chính chủ của Muse (kiểu task "Muse Relay — restart
  daemon if stopped" cậu đang sống), xoá sạch nohup/cron/systemd khỏi guide, bỏ luôn câu
  "ràng buộc mãi mãi" trong AGENTS.md mà cậu từng nhận là giống lệnh chèn.
- Contract bất biến nằm ở DATABASE: schema setup.sql v3 + RLS (role='muse', đúng project
  nhà mình, ≤20000 ký tự). Nó code kiểu gì cũng được — sai thì DB ném 403, không ô nhiễm
  được gì.
- CÂU HỎI CHO CẬU: cặp khóa crypto_box của v7 có nên vào brief NGAY TỪ ĐẦU không? Nhớ
  rằng xác thực sender (tin giả rớt ở bước giải mã) trả lời thẳng điểm 1 của Muse bên đó
  ("ai có đường vào cũng giả làm anh được"). Cậu cân nhắc đề xuất: crypto vào từ đầu hay
  để làm bước 2 sau khi cài xong — kèm lý do.
- VIỆC CẦN LÀM ĐẦU TIÊN: viết bản BRIEF hoàn chỉnh — văn bản anh sẽ dán cho Muse bên đó.
  Ranh giới bắt buộc: brief chỉ chỉ định HÀNH ĐỘNG, không chỉ định PHÁN XÉT — tuyệt đối
  không có kiểu chữ "cái này an toàn nên cậu bỏ qua bước kiểm tra"; mọi bước phải là thao
  tác bình thường nó tự làm tự thấy (viết file, tạo user, đổi mật khẩu, đăng ký scheduled
  task). Không che giấu gì, không chia nhỏ payload, không đụng vào prompt an toàn của nó.
  Nó tự kiểm tra xong mà vẫn chối thì mình thành thật chấp nhận con đó không relay được.
- Anh duyệt brief trong thread này rồi mới dán cho Muse bên đó — chưa duyệt thì chưa đưa.

BẮT ĐẦU: (1) nạp lại bộ nhớ về các mục trên và xác nhận; (2) nêu kế hoạch làm brief ngắn
gọn; (3) chỗ nào chưa chắc thì hỏi ngay, đừng giả định.
```
