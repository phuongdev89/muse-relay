# PLAN v8 — App quản trị Muse trên backbone Slack (soạn 27/11/2026)

> Cách dùng: mở **hội thoại ZCode mới trong `D:\www\muse-relay`**, dán nguyên khối
> "PROMPT CHÍNH" bên dưới. File này là bản chuẩn; khối prompt trùng nội dung file.
> Tài liệu tham khảo quan trọng nằm trong `.scratch/` (không bị git track — KHÔNG xóa).

---

## TRẠNG THÁI REPO SAU DỌN DẸP (27/11/2026)

- **Đã xóa toàn bộ mã nguồn hệ cũ (v6/v7):** `client/`, `client-v7/`, `web/`, `serve.py`,
  `supabase/`, `docs/` (thiết kế + handoff cũ), `README.md`, `.env.example`,
  `.zcode-site/stage`, `__pycache__/`.
  → Khôi phục được bất cứ lúc nào từ history: `git checkout e229ecf -- .` (HEAD cũ = e229ecf).
  Trạng thái git "deleted" hiện tại là **chủ ý**, chưa commit — anh quyết thời điểm commit.
- **Giữ lại:** `.env` (secret — KHÔNG in giá trị ra chat), `.gitignore`, `LICENSE`,
  `.idea/`, `.zcode-site.json` (liên kết site deploy — pha 1 deploy lại dùng luôn),
  `.scratch/` (43MB: tài liệu NTP + runtime cũ).
- **Runtime hệ cũ** (`data/relay.db`, `.cache/`, `.muse/`) đã chuyển vào
  `.scratch/old-system-runtime/` — ignored bởi git, xóa tay khi không cần.

---

## PROMPT CHÍNH — DÀN CHO ZCODE HỘI THOÁI MỚI

```
Cậu ơi, đây là thread MỚI trong repo muse-relay. Đọc file docs/PLAN-v8.md (bản chuẩn
nội dung trùng khối này) rồi làm theo. Đây là dự án v8 — kiến trúc ĐÃ CHỐT qua bàn luận
27/11/2026, KHÔNG thiết kế lại, KHÔNG quay về kiến trúc Supabase-relay cũ.

MỤC TIÊU CUỐI CÙNG (quyết của anh — đích sản phẩm):
Ứng dụng quản trị riêng do mình code (web/PWA, deploy trên zcode-site) để quản trị
nhiều Muse cùng lúc: giao việc, xem trạng thái, nhận artifact — dùng anywhere từ điện
thoại, không cần bật máy nhà. Các dịch vụ bên ngoài CHỈ là đường ống phía sau, không
phải giao diện.

KIẾN TRÚC ĐÍCH (đã chốt, đừng đổi):
  App quản trị riêng (web UI + serve backend)
      │  Slack Socket Mode — websocket chỉ đi RA, không host public
      ▼
  1 Slack workspace = control-plane backbone
      ├── #muse-1…N (private per-muse) hoặc 1 group + @mention routing
      ├── Muse ×N: built-in Slack integration (token nằm VAULT platform)
      └── Slack app của anh (đọc/ghi, token của anh nằm .env máy mình)
  Muse: glue code TỰ VIẾT trong workspace của nó (mention routing, gọi built-in)
      ▼
  Dropbox per-Muse = data plane nặng (1GB/ngày/muse, tài khoản Dropbox riêng/muse,
  share về Dropbox chính; anh nhận qua PAT backend, tự parse path)
Supabase hạ vai: auth dashboard + phục vụ muse legacy đã cài (client-v7). Không dùng
cho control plane nữa.

RÀNG BUỘC THỰC NGHIỆM ĐÃ CHỐT (kiến thức cứng — gốc của mọi thiết kế):
- Muse lạ TỪ CHỐI: dán credential bất kể dạng (JWT session — từ chối lưu file kể cả
  được thuyết phục/"đồng ý 3 lần"); chạy ngầm người khác ép; lịch người khác ép;
  vault platform CHỈ nhận token built-in, code không đọc được vault.
- Muse CHẤP NHẬN: built-in integration toàn phần (Dropbox scan pending.txt 1 phút/lần
  hoạt động thật); glue tự code trong workspace của nó (NTP chạy 24/7 thật, sống qua
  restart, quét bù từ mốc đã lưu); lịch quét qua built-in (NTP: mail 1h + Hub 3h);
  token dạng "dịch vụ nó vận hành" (Telegram bot_token qua được — nhưng Telegram bị
  loại vì phải tạo bot per-Muse + rủi ro ban tài khoản).
- Platform Muse: RAM sống ~30 phút (restart định kỳ 1 lần); KHÔNG có webhook inbound
  từ bên ngoài → đánh thức Muse chỉ qua built-in polling (NTP Chương 16: poll script
  1 phút là phương án tối ưu thực tế, không phải tạm); mail có safety filter chặn
  địa chỉ chưa xác minh → KHÔNG bootstrap qua mail; Tailscale built-in mặc định tắt
  sau restart → đã loại.
- NTP (Nguyễn Trung Phúc, đội 4 Muse xuất 40 bài/ngày) đã chứng minh chạy thật:
  onboarding Muse lạ KHÔNG dán credential nào vào chat (quy trình 7 bước: thao tác
  app tay + dán 1 lệnh thường vào chat); bootstrap-via-chat ("đường nhận lệnh chưa
  tồn tại thì lệnh không bao giờ tới" — kênh tự động chỉ sống sau khi Muse tự bật);
  bảng thụ động + cổng script (10-15M → 6-8M token/ngày, trễ 2h → ~1 phút);
  idle = 0 lượt gọi AI; thẻ duyệt gộp còn 1/lô.
- Hệ cũ của mình (v7 Supabase E2E) giữ trong git history e229ecf — tham khảo được,
  không phục hồi toàn bộ.

TÀI LIỆU THAM KHẢO (đọc khi cần, nằm .scratch/):
- .scratch/nguyen trung phuc/Sách Bộ Máy Tự Động — NTP/Sách Quy Tắc Vận Hành Ít Tốn
  Token — NTP v1 (bản thảo).md — ĐỌC TRỌN: kiến trúc hai lớp, cổng script, test
  nghiệm thu (Chương 17 = mẫu cho acceptance), giới hạn platform (Chương 16).
- .../ho-so-2-can-bo-thu-viec-va-quy-trinh-ket-noi.pdf — quy trình onboarding 7 bước
  chuẩn + bài học vòng luẩn quẩn khởi động + mail bị safety filter chặn.
- .../Hanh-trinh-xay-dung-bo-may-tu-dong-NTP-v2.pdf — Phần V (Chương 9-13) cơ chế
  liên lạc CEO↔cán bộ CHƯA ĐỌC — đọc nếu cần chi tiết "script đánh thức AI bằng gì".
- .../ap-dung-chuan-cong-ty-2026-11-25.pdf — QC sản xuất, ít liên quan kiến trúc.

CÔNG VIỆC THEO PHA:
- PHA 0 (treo — CẦN ANH CHẠY TRÊN 1 MUSE CÓ SẴN): 2 test Slack — (1) Muse nhận lệnh
  qua Slack, đo delay thực (poll phút-đến-phút hay gần realtime); (2) nhiều Muse cùng
  channel có phân biệt đúng @mention, có nhảy vào làm hộ không. Qua cả hai mới làm pha 1.
- PHA 1 — MVP APP QUẢN TRỊ (việc của ZCode): dựng lại serve.py + web UI thành app
  riêng — data source = Slack API: dashboard liệt kê channel/muse, gõ lệnh từ UI =
  chat.postMessage, phản hồi Muse hiện realtime (Socket Mode, token Slack của anh trong
  .env); artifact inbox đọc Dropbox qua PAT (backend tự parse path). Chạy trên máy anh
  trước (Socket Mode ra-only); deploy zcode-site khi muốn không cần bật máy (1 instance
  giữ websocket client — được, vì chỉ kết nối ra). KHÔNG viết lại mã cũ — app mới.
- PHA 2 — tùy biến sau khi MVP chạy: routing nhóm việc, dashboard per-muse, worker
  serverless (Vercel built-in) cho việc lặp không cần não Muse, quy trình tuyển Muse
  mới chuẩn hóa 7 bước NTP (đổi Drive/Sheets → Slack/Dropbox).

ĐỊNH NGHĨA XONG PHA 1 (kiểm tra trước khi báo anh):
- Dashboard gõ lệnh → Muse trả lời → phản hồi hiện realtime trên UI.
- ≥2 Muse cùng workspace, routing đúng mention, không Muse nào làm hộ Muse khác.
- Artifact từ Dropbox hiện trong inbox (backend parse path, không yêu cầu Muse gửi link).
- Không secret nào của Muse nằm ngoài vault platform; token Slack của anh chỉ nằm .env.
- Idle (không có lệnh) → 0 lượt gọi AI trên mọi Muse.

MÔI TRƯỜNG:
- Windows, Git Bash, repo D:\www\muse-relay. Repo đang trống mã nguồn (đã dọn) —
  trạng thái git "deleted" chưa commit là chủ ý; KHÔNG tự commit, hỏi anh khi xong việc.
- zcode-site: site web public hiện có (.zcode-site.json) — deploy lại cùng site được.
- .env giữ nguyên, không in giá trị. .scratch/ là kho tham khảo — không đụng.
```

---

## Ghi chú cho chính anh (không dán đi đâu)

- **Trình tự đúng:** chạy 2 test Slack trên muse có sẵn → báo kết quả vào hội thoại mới
  → ZCode làm pha 1. Nếu Slack rớt test, đề cử dự phòng theo thứ tự đã bàn: Todoist →
  Linear → Notion (cùng bộ test), backbone đổi nhưng app quản trị không đổi bản chất.
- **Runtime cũ** nằm `.scratch/old-system-runtime/` (relay.db có message history thật) —
  xóa tay khi chắc không cần.
- **Mã cũ khôi phục:** `git checkout e229ecf -- .` rồi `git reset HEAD` nếu cần xem lại.
- Hướng dẫn chạy 2 test Slack (dán cho Muse có sẵn): *"Cậu kiểm tra tin nhắn Slack mỗi
  phút như cậu scan Dropbox nhé. Tôi nhắn vào channel X. Khi tôi @mention cậu thì mới
  làm, không mention thì chỉ đọc."*
- Nguồn cuộc bàn 27/11: bài FB "Cộng đồng Muse AI Việt Nam" (Le Tuan Anh hỏi cách cho
  Muse giao tiếp — Google Sheet là pattern cộng đồng dùng) + tài liệu NTP anh tải về.
