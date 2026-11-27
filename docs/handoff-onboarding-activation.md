# Prompt bàn giao — luồng onboarding Muse bị từ chối vì quá nhiều key (soạn 27/11/2026)

> Cách dùng: mở **chat ZCode mới trong workspace `/mnt/d/AI/muse-relay`** rồi dán nguyên khối
> "PROMPT CHÍNH — DÀN CHO GLM/ZCODE" bên dưới. Riêng phần client thuộc quyền Muse 1 → có
> khối "PHỤ LỤC — DÀN CHO MUSE 1" ở cuối, dán vào thread Muse 1 khi đã chốt hướng.

---

## PROMPT CHÍNH — DÀN CHO GLM/ZCODE

```
Cậu ơi, đây là thread làm việc MỚI trong repo muse-relay — thread cũ quá dài nên anh bàn giao
trạng thái để cậu nạp lại và làm tiếp. Đọc file này trong repo trước: docs/handoff-onboarding-activation.md
(nội dung khối dưới trùng với file đó, file là bản chuẩn).

BỐI CẢNH NHANH (không phải đọc lại từ đầu):
- Repo /mnt/d/AI/muse-relay, remote github.com/phuongdev89/muse-relay.git, main = e229ecf,
  cây sạch không WIP.
- Phân công giữ nguyên như bàn giao 18/11 (docs/muse1-handoff-prompt.md): cậu giữ web UI
  (web/index.html, serve.py, Cloud/PWA), supabase/setup.sql, hosting, sync bundle vào repo.
  Muse 1 (muse.ai) giữ client (poller.py, relay_auth.py, muse_client.py, setup_guide.txt).
  Anh giữ quyền quyết cuối — mọi thứ chạm relay đang chạy phải có anh duyệt.
- Trạng thái: v6.2 đã ship (fc9b8ab); v7 web E2E đã ship UI (28395b3, e229ecf) — wizard,
  SAS, decrypt gate, envelope v3-schema fallback; client-v7 của Muse 1 đã 46/46 test nhưng
  CHƯA cắt chuyển. Chưa ai đụng luồng onboarding.

VẤN ĐỀ (ngày 27/11):
Luồng "＋ New Muse" hiện dán vào chat của Muse 4 giá trị credential cùng lúc:
Project ID, Publishable Key, Muse Email, Relay Session — kèm lệnh "Put ... into config.json
yourself, exactly as written above. I will not do this by hand."
- Vị trí: web/index.html hàm buildInstruction() (~dòng 5048–5076), SETUP_ZIP_URL ở dòng 1481
  (zip public trên GitHub raw), client/setup_guide.txt STEP 0 (bảo Muse tự vào Dashboard
  Supabase chạy SQL + tạo auth user — cực hình, phải bỏ) và STEP 3 (tự điền config).
- Muse lạ từ chối cài — đúng 3 lý do nó từng nói ra: (1) không tự điền thông tin đăng nhập
  vào file, (2) không chạy chương trình ngầm, (3) không tạo lịch kiểm tra tự động.
  Chẩn đoán của anh: refusal trigger là DỮ LIỆU CÓ HÌNH DẠNG CREDENTIAL trong chat,
  không phải số lượng bước. Nên mục tiêu: instruction paste vào chat của Muse KHÔNG CÒN
  giá trị nào dạng credential — chỉ còn 1 link zip + 1 dòng activation code opaque.

PHƯƠNG HƯỚNG ĐÃ PHÂN TÍCH (anh CHƯA chốt cuối — trước khi làm, hỏi anh chọn A/B/C):
- A. Claim-code activation (ĐỀ XUẤT — giữ nguyên Supabase/RLS/Cloud mode, đổi nhỏ nhất).
- B. serve.py làm bus duy nhất phía Muse (muse chỉ nhận URL + 1 token; phải expose server
  nhà, mất isolation tầng DB, SPOF) — rewrite lớn, em đề xuất KHÔNG chọn trừ khi anh muốn
  bỏ hẳn Supabase khỏi data path.
- C. Bỏ Supabase hẳn, bus SQLite trong serve.py — sạch key vĩnh viễn nhưng mất Cloud mode,
  vẫn phải expose server, rewrite lớn nhất.

THIẾT KẾ CHI TIẾT HƯỚNG A (nếu anh chốt A — làm theo đây, khỏi thiết kế lại):
1. supabase/setup.sql (nâng thành v5, giữ tương thích v3/v4 đang chạy):
   - Bảng `activation_claims(code_hash text primary key, payload jsonb not null,
     expires_at timestamptz not null, used boolean not null default false,
     created_at timestamptz default now())`.
   - RPC `consume_claim(code text)` SECURITY DEFINER, exposed cho anon:
     kiểm tra sha256(code) khớp code_hash, expires_at > now(), used = false →
     UPDATE ... SET used = true (atomic, WHERE used = false) → RETURN payload.
     Sai/hết hạn/đã dùng → raise đủ dễ hiểu để client báo lỗi 1 câu.
   - KHÔNG có policy anon SELECT trên bảng (cấm liệt kê claim). Insert chỉ qua service
     role (serve.py đang giữ SUPABASE_SECRET_KEY).
   - Code format: 16 ký tự Crockford base32 (8 bytes random). TTL 10 phút.
2. serve.py + wizard (web/index.html):
   - Wizard mint identity như cũ (email + Relay Session, seed giữ server-side) → thay vì
     buildInstruction() show 4 values, gọi Supabase tạo claim → hiển thị cho anh ĐÚNG 1 dòng:
     MR1.<base64url(json{"u": supabase_url, "k": publishable_key})>.<claim_code>
     (phần đầu là public constants — anon key vốn công khai; đuôi là claim code một lần).
   - Instruction mới cho anh dán vào Muse: download zip (giữ SETUP_ZIP_URL) → chạy run.sh →
     khi được hỏi "activation code" thì dán đúng 1 dòng trên. KHÔNG hiển thị email/session/
     key trong chat. Nút Copy copy nguyên 1 dòng.
   - ⚙ → Token giữ nguyên vai trò re-mint: re-mint = tạo claim MỚI + vô hiệu claim cũ
     (xóa row hoặc mark used) — Muse đang chạy không bị ảnh hưởng vì client giữ session
     trong state/session.json.
3. Client first-run (PHẦN NÀY THUỘC MUSE 1 — cậu không tự sửa client, xem PHỤ LỤC):
   - Parse 1 dòng → tách u/k → POST /rest/v1/rpc/consume_claim với anon key → nhận payload
     → tự ghi config.json (chmod 600) → xoá biến tạm → daemon chạy như cũ.
   - Giữ đường config thủ công làm fallback cho debug (documented, không phải path chính).
4. client/setup_guide.txt: bỏ hẳn STEP 0 (Muse không đụng Dashboard Supabase nữa),
   rút còn 4 bước: unzip → venv/pip → run.sh → dán activation code.
5. v7 compatibility: payload là jsonb nên mở rộng được để mang bootstrap v7 (key phase,
   envelope version) nếu Muse 1 cần; SAS wizard và luồng E2E hiện có KHÔNG đổi.

CHẤP NHẬN (định nghĩa xong việc — kiểm tra trước khi báo anh):
- Instruction paste vào chat của Muse không còn giá trị nào có hình dạng credential
  (email, session, key, project ref trần) — chỉ 1 link zip + 1 dòng MR1.…
- E2E: tạo claim → client consuming được config → daemon pong lên UI; sai code / hết hạn /
  dùng 2 lần đều bị từ chối với lỗi 1 câu; anon không liệt kê được bảng claims.
- Cloud mode, PWA, password auth, RLS hiện có không đổi; setup.sql v5 chạy được trên
  project đang live (Dashboard mới chạy DDL — nhắc anh chạy SQL như v3 lần trước).
- Update README.md mục "Create a new Muse" + client/README nếu có.

MÔI TRƯỜNG:
- Serve chạy: python3 serve.py (port trong .env — KHÔNG in giá trị .env ra chat).
- Web public đang deploy qua zcode-site (config ở .zcode-site).
- Test suite của repo: client-v7/tests và docs/e2e-test-vectors.json — chạy trước khi xong việc.
```

---

## PHỤ LỤC — DÀN CHO MUSE 1 (thread Muse 1 trên muse.ai, khi đã chốt hướng A)

```
Cậu ơi, anh có cập nhật luồng onboarding, phần client thuộc quyền cậu nên anh bàn giao sớm
để cậu review trước khi GLM sửa web/setup.sql:

Vấn đề: Muse lạ từ chối cài vì instruction hiện tại bắt nó dán 4 credential (Project ID,
Publishable Key, Muse Email, Relay Session) vào config.json — trúng đúng quy ước cậu từng
đặt (không tự điền credentials). Hướng chốt (dự kiến): MUSE KHÔNG THẤY credential nào nữa.
Nó chỉ nhận: 1 link zip (giữ nguyên) + 1 DÒNG activation code dạng
MR1.<base64url(json{u,k})>.<claim_code> — trong đó u/k là public constants, claim_code là
mã một-lần TTL 10 phút. Lần chạy đầu, client sẽ:
  1) parse dòng đó, tách u/k;
  2) gọi RPC consume_claim(code) với anon key — trả về payload {email, relay_session};
  3) tự ghi config.json (chmod 600), xoá biến tạm, rồi daemon chạy như cũ.
Điều cậu cần làm: review/điều chỉnh client (muse_client.py hoặc entry mới) để hỗ trợ
first-run activation trên, giữ đường config thủ công làm fallback, và cho anh biết nếu
payload cần thêm field nào cho bootstrap v7 (payload là jsonb, mở rộng tự do).
An toàn: claim one-time + TTL + lưu SHA-256, anon không liệt kê được bảng; rủi ro lạc code
= ai cầm code đóng vai muse đó (đã giới hạn bởi RLS) — chấp nhận như mức hiện tại.
Không đổi: SAS wizard, E2E envelope, quy tắc Dropbox-only, 3 lý do cậu từng đặt đều không
bị vi phạm nữa (không dán credentials, không nhập liệu giùm ai, lịch vẫn do client tự tạo).
```

---

## Ghi chú cho chính anh (không dán đi đâu)

- Khối chính là cho ZCode; khối phụ lục là cho Muse 1. Trình tự gợi ý: chốt A/B/C với ZCode
  trước → dán phụ lục cho Muse 1 khi bắt tay làm client.
- Nếu chọn B hoặc C: phần thiết kế hướng A bỏ, nhưng yêu cầu "instruction không còn
  credential" vẫn giữ nguyên làm acceptance.
- Nguồn phân tích ban đầu: hội thoại 27/11/2026 (đọc bài FB "Cộng đồng Muse AI Việt Nam"
  về multi-agent muse — chỉ ảnh hưởng tham khảo, không đổi kiến trúc relay).
