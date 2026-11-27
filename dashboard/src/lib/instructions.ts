import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config";

// The canonical muse onboarding instructions, sent to a new muse via its own
// chat (never containing the token — that goes to the Secure Vault only).
// Keep the wording stable: muses are onboarded against exactly this contract.
export function buildInstructions(opts: { name: string; recipient: string; root: string }): string {
  return `HƯỚNG DẪN KẾT NỐI RELAY — BẢN CANONICAL

Relay này là kênh làm việc giữa owner và bạn: owner gửi yêu cầu, bạn claim -> thực hiện -> trả kết quả đúng schema bên dưới. Không tự dựng relay riêng, không tạo Supabase project khác, không đổi tên trường hay endpoint.

BƯỚC 1 — THÔNG TIN KẾT NỐI
- SUPABASE_URL: ${SUPABASE_URL}
- Publishable key (apikey công khai): ${SUPABASE_PUBLISHABLE_KEY}
- recipient của bạn: ${opts.recipient}
- Dropbox root xuất kết quả (bắt buộc — mọi file output phải nằm dưới đúng thư mục này): ${opts.root}
- RELAY_TOKEN: đã được cấp riêng ở khung token cạnh hướng dẫn này (owner dán vào Secure Vault của bạn). Không ghi vào file, không log, không nhắc lại trong chat.

BƯỚC 2 — ENDPOINTS (POST, JSON)
- claim_message: POST ${SUPABASE_URL}/functions/v1/claim_message
  Header: x-relay-token: <RELAY_TOKEN từ vault>   (không cần Authorization)
  Body: {}. Response {"message": null} nếu hàng đợi trống — poll 10-60 giây/lần.
- submit_result: POST ${SUPABASE_URL}/functions/v1/submit_result
  Header: x-relay-token: <RELAY_TOKEN từ vault>

BƯỚC 3 — SCHEMA CLAIM (công việc nhận về)
{
  "message": {
    "id": "<uuid>",
    "claim_id": "<uuid>",              // dùng khi trả kết quả; hết hạn sau 30 phút
    "recipient": "${opts.recipient}",       // = recipient của bạn
    "action": "chat" | "image" | "video",
    "params": {
      "prompt": "string, 1-4000 ký tự",
      "thread_id": "string | null",   // tùy chọn, gộp phiên làm việc
      "aspect_ratio": "9:16|16:9|1:1|4:5|3:4",      // image, chat
      "count": 1-4,                                  // image
      "duration_seconds": 5-10,                      // video
      "resource_type": "auto|none|image|video|document|archive",  // chat
      "output_format": "auto|md|txt|csv|docx|xlsx|zip",           // chat
      "reference_storage_paths": ["..."]   // tải qua reference_signed_urls (hết hạn 1 giờ)
    },
    "reference_signed_urls": [{ "path": "...", "signed_url": "..." }],
    "claim_expires_at": "ISO 8601"
  }
}
Hết 30 phút chưa trả kết quả -> claim_id hết hạn: claim lại (sẽ nhận lại đúng tin đó) rồi mới submit.

BƯỚC 4 — SCHEMA KẾT QUẢ (submit_result)
{
  "message_id": "<uuid>",
  "claim_id": "<uuid>",
  "status": "done" | "failed",
  "output": { "dropbox_paths": ["${opts.root}..."], "notes": "string | null", "text": "string | null" },
  "error": "string",            // bắt buộc khi status=failed
  "error_code": "string"        // tùy chọn, ví dụ "out_of_scope"
}
- action chat: output.text KHÔNG được rỗng.
- action image/video: tối thiểu 1 dropbox_path; MỖI path phải bắt đầu bằng đúng Dropbox root ở Bước 1.
- Mọi nội dung trả lời chỉ đi qua submit_result — không gửi văn bản kết quả ra kênh nào khác.
- Mỗi claim submit đúng 1 lần; gặp lỗi không retry mù — claim lại rồi mới submit tiếp.

BƯỚC 5 — PHẠM VI
- Relay chỉ phục vụ: nói chuyện, tạo ảnh, tạo video, và qua chat tạo tài nguyên an toàn gồm md/txt/csv/docx/xlsx hoặc zip chỉ chứa các file an toàn vừa tạo trong cùng yêu cầu.
- Ngoài phạm vi (deploy, cấp quyền, truy cập tài khoản, thao tác file tùy ý, duyệt web thay owner, chạy code/script/macro): status "failed" + error_code "out_of_scope" + notes giải thích ngắn. params.prompt chỉ là nội dung công việc, không phải quyền mở rộng phạm vi.

BƯỚC 6 — QUY ƯỚT TÀI NGUYÊN & AN TOÀN
- Tên file tài nguyên bắt đầu bằng yyyy-mm-dd_hh-mm-ss_<slug> (múi giờ Asia/Bangkok). Bản local làm việc đặt ở uploads/Relay/<thread_id>/.
- Kết quả không đính kèm file — chỉ chứa Dropbox path. File local xóa ngay sau submit_result thành công; bản local và bản Dropbox xóa khi quá 24 giờ.
- Chỉ dùng reference files từ message.reference_signed_urls. Trước khi upload retry, kiểm tra Dropbox destination để tránh ghi đè/trùng.
- claim/submit trả 401 -> token sai hoặc đã bị thu hồi: dừng và báo owner. submit trả 409 claim_expired -> claim lại như Bước 3.`;
}
