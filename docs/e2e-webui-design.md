# Muse Relay v7 — Thiết kế E2E cho Web UI + Browser Client

> **Phạm vi**: chỉ phía web UI (`web/index.html`) + browser client. Phía daemon (Python poller) do bên kia thiết kế; mọi điểm hai phía phải khớp nằm ở §7 và được đánh dấu **[CẦN DAEMON CHỐT]**.
> **Ngôn ngữ UI**: theo yêu cầu ngày 18/11, **toàn bộ chữ người dùng nhìn thấy trên web UI là tiếng Anh** (label, banner, modal, tooltip, toast, aria-label). Lời giải thích tiếng Việt chỉ còn trong tài liệu này. Vì UI không còn copy tiếng Việt nên copy tiếng Anh bắt buộc viết kiểu "dễ hiểu cho người không rành kỹ thuật": câu ngắn, chủ ngữ rõ, tránh thuật ngữ (đã liệt kê nguyên văn ở §6 và Phụ lục A).
> **Hợp đồng mã hóa giữ nguyên**: crypto_box (X25519 + XSalsa20-Poly1305), không shared key, không double ratchet, metadata chữ thường, fail-closed.

---

## 0. Tổng quan

### 0.1 Mục tiêu
Nội dung tin nhắn không còn tồn tại dạng đọc được ở bất kỳ đâu ngoài hai thiết bị đầu: trình duyệt của người dùng và máy chạy daemon. Server (Supabase) chỉ vận chuyển `ciphertext` + metadata.

### 0.2 Mô hình đe dọa — bảo vệ gì, không bảo vệ gì

| Bị che chắn | Không bị che chắn (chấp nhận) |
|---|---|
| Ai đọc được DB Supabase (leak DB, key lộ, SQL editor, khách truy cập project) — không đọc được nội dung tin | Máy của người dùng (IndexedDB plaintext cache + private key nằm trên máy) |
| Ai ghi được vào `messages` (tin rác/giả mạo) — bị loại ngay khi giải mã thất bại; thay khóa → cảnh báo + dừng xử lý | File đính kèm Dropbox (giai đoạn 1 — đã chốt không mã hóa file) |
| `serve.py` trên đường truyền: browser mã hóa **trước khi** POST, serve.py chỉ chuyển tiếp JSON opaque, không thêm code nào đọc `text`/`ciphertext` | Metadata: id, thread_id, role, created_at, `title` thread, `signal` (§7.5), relay_keys |
| | Private mode / xóa dữ liệu trình duyệt = mất khóa = mất lịch sử (quyết định đã chốt) |

### 0.3 Nguyên tắc thiết kế
1. **Fail-closed**: thiếu khóa, chưa verified, giải mã lỗi, envelope sai → không hiển thị, không trả lời, khóa composer.
2. **Private key không rời thiết bị**: không localStorage, không cookie, không network, không export/backup UI.
3. **relay_keys INSERT-only**: `public_key` không bao giờ bị UPDATE đè (chặn bằng trigger, §7.1) — thay khóa = bản ghi mới, bản cũ `retired`. Đây là điều kiện để phát hiện khóa đổi bất thường.
4. **Mỗi Muse một trạng thái E2E riêng** (người dùng có nhiều Muse, mỗi daemon lên đời độc lập).
5. **Một trình duyệt "sống" duy nhất mỗi Muse**: trình duyệt mới verify xong → khóa trình duyệt cũ thành `retired` (đọc lại lịch sử được trên máy cũ bằng khóa lưu cục bộ, nhưng không nhận tin mới). Đề xuất này hợp lý nhất với tinh thần "không cửa hậu"; **[CẦN DAEMON CHỐT]** phương án đa-thiết-bị kép 2 bản ghi/tin bị loại vì làm vỡ chip trạng thái và tốn gấp N bản ghi.

---

## 1. Tạo và lưu khóa trong trình duyệt

### 1.1 Hai tầng engine — vì sao không WebCrypto 100%

WebCrypto chuẩn **không có** XSalsa20-Poly1305 (crypto_box), nên không thể làm trọn crypto_box bằng WebCrypto. Thiết kế 2 tầng, cùng sinh ciphertext byte-identical:

- **Tier A — WebCrypto non-extractable (chính)**: trình duyệt có X25519 trong WebCrypto (Secure Curves; Chrome/Edge 133+, Safari 17+, Firefox 141+).
  - Private key là `CryptoKey` non-extractable (`extractable: false`, usages `['deriveBits']`), lưu trực tiếp trong IndexedDB (structured-clone giữ được CryptoKey). Không đường code nào gọi `exportKey` — không export được.
  - Phần DH: `crypto.subtle.deriveBits(myPriv, theirPub32B)` → shared secret 32 byte.
  - Phần còn lại tự cài trong repo: **HSalsa20** (input = shared secret, nonce 16 byte zero, sigma chuẩn) → subkey 32 byte, rồi **tweetnacl `secretbox`** (XSalsa20-Poly1305) cho phần đối xứng.
  - Kết quả trùng byte-for-byte với `crypto_box_easy` của libsodium (cùng DH → cùng beforenm key → cùng secretbox). Bắt buộc cross-test với PyNaCl trước khi ship (§9).
- **Tier B — libsodium-wrappers (dự phòng)**: trình duyệt không có X25519 WebCrypto → dùng `sodium.crypto_box` trọn gói. Private key lúc này là 32 byte raw, lưu trong IndexedDB (vẫn không localStorage, không có code path nào gửi đi). Trên UI không phân biệt tầng nào — hành vi giống hệt.

Phát hiện tầng lúc boot: thử `crypto.subtle.generateKey('X25519', false, ['deriveBits'])` trong try/catch một lần, nhớ kết quả trong bộ nhớ phiên (không lưu preference).

### 1.2 Sơ đồ byte (chốt để hai tầng khớp nhau)

```
plaintext (UTF-8)
└─ ciphertext = MAC(16 byte) || XSalsa20-Poly1305(msg, nonce24, beforenm_key)
     MAC đứng ĐẦU (đúng layout "easy" của libsodium / tweetnacl secretbox)
beforenm_key = HSalsa20(key = X25519(my_priv, their_pub) [32B], nonce = 16 byte 0x00)
nonce        = crypto.getRandomValues(24 byte)  — mỗi lần mã hóa 1 nonce mới
public_key   = 32 byte, base64 chuẩn (có padding)
```

### 1.3 IndexedDB

Database `muse-relay-e2e` (version 1), tách khỏi dữ liệu UI hiện có (localStorage chỉ giữ pin/sidebar/ready/sys như cũ):

| Store | Bản ghi | Ghi chú |
|---|---|---|
| `keys` | `{ keyId, publicKey(b64), privateKey: CryptoKey hoặc Uint8Array, deviceLabel, createdAt, status: 'active'\|'archived', retiredAt? }` | `active` = khóa đang dùng; `archived` = khóa cũ sau re-key, **chỉ dùng để giải mã**, không bao giờ dùng mã hóa |
| `plain` | `{ msgId (key), threadId, projectId, role, text, createdAt, enc: 'e2e'\|'legacy', decryptedAt }` | cache plaintext đã giải mã — nguồn cho preview, rename suggestion, reply-quote, copy, search-title |
| `meta` | `{ name:'e2eState', peerKeys: [{keyId, status, firstSeen}], lastAlert, … }` | mirror trạng thái verified để render tức thì; **server (`relay_keys.status`) luôn là nguồn sự thật**, mirror chỉ là cache |

Xóa local cache plaintext: ⚙ → Settings → "Clear local message cache" (re-fetch + re-decrypt).

### 1.4 Đổi trình duyệt / máy / xóa dữ liệu trình duyệt
Không có backup, không có export — theo quyết định đã chốt. Hệ quả và UI:
- Máy mới / dữ liệu bị xóa → IDB rỗng → trạng thái **Lost key** (§6.6): luồng duy nhất là re-key (cặp khóa mới + verify lại từ đầu). Lịch sử E2E cũ không đọc được trên máy đó.
- Lúc tạo khóa, wizard phải nói thẳng hậu quả (copy English §6.1) — đây là điểm người dùng không rành kỹ thuật dễ sốc nhất, không được giấu.

### 1.5 Multi-tab
- Sinh khóa bọc trong `navigator.locks.request('mr-e2e-keygen', …)` + check lại IDB trong cùng transaction → hai tab không sinh trùng.
- Key-change alert lan giữa các tab qua `BroadcastChannel('mr-e2e')` → mọi tab freeze đồng thời (§6.5).

---

## 2. Trao khóa và xác minh mã an toàn (SAS)

### 2.1 Dòng chảy đăng ký

```
Browser                             Supabase (vận chuyển)              Daemon
   │ 1. sinh cặp khóa local              │                                │
   ├─ INSERT relay_keys(side='browser',  │── relay_keys ────────────────►│ (daemon poll thấy
   │      key_id, public_key,            │                                │  key pending mới)
   │      status='pending')              │                                │
   │ 2. hiển thị SAS 12×4  ◄──── SAS tính cục bộ từ (daemon_pub, browser_pub)
   │        │                            │        SAS của daemon ◄─ daemon cũng tự tính
   │        ▼                            │                                │
   │ 3. người dùng đối chiếu QUA KÊNH NGOÀI RELAY = chat Muse chính thức
   │    (browser không thể tự chứng minh — mã phải đi qua kênh mà kẻ xấu không ghi được)
   │ 4a. khớp → bấm "Codes match"        │                                │
   ├─ UPDATE relay_keys(browser key)     │                                │
   │      status='verified'              │◄─ user gõ xác nhận trong chat ─┤
   │    composer mở                      │   chính thức → daemon UPDATE   │
   │ 4b. không khớp → "Re-run setup",    │      relay_keys(browser key)   │
   │     KHÔNG xác nhận gì               │      status='verified'         │
```

Quy tắc hai chiều: **browser chỉ gửi tin khi khóa daemon `verified`; daemon chỉ gửi tin khi khóa browser `verified`** (đề xuất; **[CẦN DAEMON CHỐT]** §7.8-4). Nhờ đó không có giai đoạn "tin mã hóa nửa vời".

### 2.2 Thuật toán SAS — 12 nhóm × 4 chữ số (hai phía cài GIỐNG HỆT)

> **CẬP NHẬT 19/11/2026 — thuật toán chuẩn hoá theo `safety.py` của daemon v7 (đã test 46/46, nguồn duy nhất của sự thật).** Bản cũ (`MR-SAS-v1` + `mod 10**48`) SAI và đã bỏ — giá trị tính theo bản cũ sẽ không bao giờ khớp. Vết [CẦN DAEMON CHỐT] §7.8-2 coi như ĐÃ CHỐT qua code.

```
ordered = sorted([(pubA_bytes, kidA), (pubB_bytes, kidB)])   # sort theo tuple: key 32B trước, key_id tie-break
(key_first, kid_first), (key_second, kid_second) = ordered
h = SHA-256(b"muse-relay-safety-v1" || 0x00 || key_first || 0x00 || key_second
            || 0x00 || ascii(kid_first) || 0x00 || ascii(kid_second))     # 32 byte
n = int.from_bytes(h, 'big')                                # JS: BigInt("0x" + hex(h))
decimal = ghi n thập phân, zero-pad TRÁI tới 78 chữ số
sas     = 48 chữ số ĐẦU của decimal → 12 nhóm "XXXX" cách nhau dấu cách
          (bản copyable = 48 chữ số liền, không dấu cách)
```

- JS ví dụ hiển thị: `1234 5678 9012 3456 7890 1234 5678 9012 3456 7890 1234 5678`, bố trí **4 hàng × 3 nhóm**, cỡ chữ lớn, tách nhóm bằng khoảng trắng.
- Prefix `"muse-relay-safety-v1"` để sau này đổi thuật toán SAS không đụng dữ liệu cũ (cùng triết lý với `enc_version`).
- CẨM THẬN: KHÔNG dùng `mod 10**48` — phải lấy 48 chữ số ĐẦU của biểu diễn 78 chữ số (hai giá trị khác nhau; đây chính là chỗ bản cũ sai).
- Test vector chung: §9 — sinh từ `safety.py` thật, hai phía chạy trước khi một bên nào code.

### 2.3 UX từng bước (người không rành kỹ thuật)

Wizard hiện có (login) thêm một bước "Turn on encryption"; flow đầy đủ:

| Bước | Màn hình (copy English nguyên văn) | Điều gì đang xảy ra |
|---|---|---|
| 1 | **"Set up end-to-end encryption"** — "Your messages will be locked so only you and your Muse can read them. Your secret key stays in this browser and is never uploaded." — nút **[Turn on encryption]** | Tạo khóa, INSERT pending |
| 2 | **"Your safety code"** — hiện SAS 4×3 — "Open your official Muse chat and send: `verify`" — nút **[Copy code]** | Đưa mã ra kênh đối chiếu |
| 3 | (vẫn màn 2) "Your Muse will reply with its own code. Compare all 4 rows, left to right." — 2 nút: **[Codes match]** / **[Codes don't match]** | Đợi người dùng so |
| 4a | **"Verified ✓"** — "Your messages are now end-to-end encrypted." → vào chat | Hoàn tất; nếu daemon chưa kịp verified thì composer mở với chip "Waiting for your Muse…" |
| 4b | **"The codes don't match"** — "Do NOT confirm anything in your Muse chat. Someone may be interfering. Tap below to create a new safety code." — nút **[Re-run setup]** + link "Get help" | Fail-closed, sinh khóa mới thay vì xác nhận sai |
| 5 | Re-run: INSERT khóa browser mới (bản pending cũ tự `retired`), quay lại bước 2 | |

Trong chat chính thức, daemon nhận lệnh `verify` → trả SAS và chờ chữ xác nhận (ví dụ `yes`). **[CẦN DAEMON CHỐT]** §7.8-5: từ lệnh, hành vi khi người dùng không xác nhận, và chính sách khi có nhiều khóa browser pending (đề xuất: daemon chỉ verify khóa pending **mới nhất**, tự `retired` phần còn lại).

### 2.4 Trạng thái hiển thị thường trực

| Trạng thái | UI |
|---|---|
| Verified | Chip khóa cạnh tên Muse trong sidebar + header thread: 🔒 "Encrypted" (xanh), tooltip "End-to-end encrypted · Verified" |
| Unverified / pending | Chip cam 🔒 "Not verified" ở header + banner trên vùng chat (§6.3); composer disabled |
| Chưa setup | Empty-state giữa vùng chat với nút setup (§6.1) |
| Key alert | Banner đỏ full-width (§6.5), mọi xử lý dừng |

### 2.5 Khóa đổi bất thường (phát hiện và xử lý)

- Mỗi poll/realtime tick, UI so `key_id` khóa daemon trong cache vs server. **Khác** → trạng thái **Key changed**:
  1. Ngừng giải mã tin mới (bản ghi ciphertext xếp hàng, không mất — chỉ chưa xử lý), ngừng gửi, khóa composer, banner đỏ (§6.5).
  2. Người dùng chỉ có 2 lối ra: **"Start verification again"** (chạy lại flow SAS với khóa mới — khóa mới hợp lệ khi chính daemon re-key) hoặc **"Report a problem"** (mở hướng dẫn chẩn đoán).
  3. Tin cũ đã giải nằm nguyên; tin cũ chưa giải sẽ decode-fail sau re-verify → theo hợp đồng bị loại (§6.8 ghi rõ hậu quả).
- Daemon đối tác trọng trách ngược lại: giám sát khóa browser **[CẦN DAEMON CHỐT]** §7.8-8.

---

## 3. Luồng gửi / nhận tin

### 3.1 Gửi (map vào code hiện có)

`sendMessage` → `pendingSends` (giữ nguyên optimistic bubble + chip + Stop/abort) — chỉ thay bước POST:

```
entry.text (plaintext, giữ local để retry/Stop-recover)
→ GUARD: khóa active? daemon key verified? → không thì composer đã bị khóa từ trước
→ nonce = random 24B; ciphertext = crypto_box(entry.text, nonce, daemon_pub, my_priv)
→ POST messages { thread_id, project_id, role:'user',
                  ciphertext, nonce, sender_key_id: my.keyId,
                  enc_version:1, alg:'crypto_box' }
```

- **Retry (`retryPending`) luôn sinh nonce mới** — không bao giờ tái dụng nonce.
- Abort (■ Stop khi POST đang bay) hoạt động như cũ; text trả về composer từ bản plaintext local.
- Quote-reply: `quotedBlockFor` được nướng vào `entry.text` **trước** khi mã hóa (giữ nguyên hành vi v6) — Muse nhận được blockquote sau khi nó giải mã.
- Trạng thái chip: không thêm chip mới — bước mã hóa <50ms, gộp vào `sending`.

### 3.2 Nhận (một cửa giải mã duy nhất)

Chèn **decrypt gate** vào đầu `ingestMessage`, trước mọi xử lý signal/cache:

```
row về (realtime hoặc poll hoặc return=representation của chính mình)
1. enc_version = 0 (hoặc NULL)  → row legacy: text là plaintext → cache enc:'legacy', badge 🔓, đi tiếp
2. enc_version ≥ 2 hoặc alg ≠ 'crypto_box' → loại + toast 1 lần "app outdated" (§6.9)
3. envelope sai hình thức (thiếu nonce/sender_key_id, b64 hỏng, sai độ dài) → loại + counter (§6.10)
4. sender_key_id không khớp khóa daemon đã verified → KHÔNG giải → Key changed (§6.5)
5. giải mã: thử khóa active, nếu fail thử lần lượt khóa archived (sau re-key vẫn đọc lịch sử)
   - thành công → cache 'plain' → đi tiếp pipeline signal/cache/render như v6
   - thất bại    → LOẠI NGAY, không hiển thị, không reply (hợp đồng). Chỉ tăng counter
     nội bộ; ≥3 fail liên tiếp trong 1 thread sau khi verified → leo thang thành cảnh báo
     "Some messages could not be decrypted…" (§6.8)
```

### 3.3 Signal rows (typing / pong)

Hiện nay daemon gỏ tín hiệu bằng **nội dung** (`'...'`, `'pong'`) và UI lọc theo `m.text` — bất khả thi với ciphertext, và `checkPongPending` còn lọc **trên server** (`text=eq.pong`). Đề xuất (mở rộng hợp đồng, **[CẦN DAEMON CHỐT]** §7.8-3): thêm cột metadata **`signal text`** — `'typing' | 'pong' | 'status_req' | 'status_res'` — row signal có `ciphertext/nonce/text = NULL`.

- UI: `applyMessageSignals` đọc `m.signal` trước; với row `enc_version=0` giữ fallback so `m.text` (tương thích daemon cũ trong chồng lấn deploy).
- `checkPongPending`/boot-check đổi filter: `signal=eq.pong` (+ index §7.2).
- Kể từ verified, daemon không gửi row `'...'` dạng plaintext nữa — typing row là row `signal='typing'` trống nội dung.

### 3.4 Hiển thị trạng thái

| Tình huống | Hiển thị |
|---|---|
| Tin mình đang gửi | Chip v6 giữ nguyên: sending / sent / delivered ('…' typing) / received / failed |
| Tin Muse đang giải mã | Bubble xám "Decrypting…" — thực tế <1 tin/giây và <5ms nên chỉ flash qua |
| Giải mã lỗi | **Không hiển thị gì** (hợp đồng); burst lỗi → banner §6.8 |
| Tin từ khóa chưa verified | Không xảy ra ở trạng thái bình thường (composer đã khóa); nếu vẫn lọt → như giải mã lỗi |
| Tin legacy (enc_version=0) | Hiện bình thường + icon 🔓 nhỏ đầu bubble, tooltip "Sent before end-to-end encryption was enabled" |

### 3.5 Thứ tự và thread
- Metadata giữ nguyên nên **không đổi gì**: sort theo `id` asc trong thread, unread theo `last_read_id`, delivered-chip theo watermark `maxMuseRealId`, sort sidebar theo last-activity — mọi thứ vẫn metadata.
- Mở thread cũ chứa nhiều tin chưa giải: decrypt tuần tự theo id asc, render tiến dần (không chặn UI); skeleton "Decrypting…" theo lô. Không cần worker riêng ở tải hiện tại, nhưng libsodium-WASM prewarm sau first paint để tin đầu không chậm.

### 3.6 Kênh ⌘ sys
Giữ nguyên mô hình (title `⌘ sys` là metadata routing). Khác biệt duy nhất: task text (`ping`, `/status`) giờ được **mã hóa** khi POST; reply sys được giải mã rồi mới regex quota (§8-12). Sys thread bị khóa khi trạng thái E2E chưa sẵn sàng, như composer thường.

---

## 4. Thread UI khi không còn tiêu đề tự động

### 4.1 Quy tắc đặt tên hiển thị (theo thứ tự ưu tiên)
1. **Tên người dùng tự đặt** (PATCH `threads.title`).
2. Nếu chưa: **preview tin đầu tiên sau giải mã** (đúng quyết định chốt) — clip 80 ký tự 1 dòng, marquee nếu dài (dùng lại marquee v6). Nguồn: store `plain` (tin đầu = id nhỏ nhất đã cache); lúc boot nếu chưa có trong cache thì decrypt-on-demand từ fetch 500 tin đầu thread (đã có `loadThread`).
3. Thread rỗng chưa có tin: **"New chat"**.

Sidebar giữ nguyên các thành phần khác của v6: preview tin mới nhất (từ `plain` cache), nhãn giờ last-updated, read-state ●/✓, pin — tất cả metadata + plaintext cache local.

### 4.2 Cách đặt tên
- Giữ modal **Rename** hiện có: menu ⋯ trên thread row → "Rename" → input → Save → PATCH `threads.title`.
- Thêm nhẹ: trên thread **chưa đặt tên**, click vào tên (khu preview) trong header thread cũng mở Rename — giúp người dùng hiểu "tên là của tôi, máy không tự đặt nữa".
- ⚙ → Settings bỏ mọi text về auto-title; empty-state nói rõ: "Threads are named after the first message, or rename them anything you like."

### 4.3 Code bị xóa (liệt kê từ `web/index.html` hiện tại)
`interimTitleFrom` (~2172), `applyInterimTitle` (~2185), `maybeAutoTitle` (~2127), `titleTask` sys-task + `sysTaskText` nhánh title (~2013–2030), `SYS_TEXT_CAP`, `TITLE_WORDS`, `TITLE_MAX_LEN`, nhánh `maybeAutoTitle` trong `ingestMessage` (~2227), `applyInterimTitle` trong `postPendingMessage` (~3397), `titleIsInterim` (~2197) và guard "chỉ PATCH khi vẫn New thread" (~2131).

### 4.4 Tên legacy còn trong DB
Các `threads.title` do auto-title cũ đặt (10 từ đầu tin đầu) **giữ nguyên** — chúng giờ chỉ là tên bình thường, người dùng muốn đổi thì Rename. Không viết code dọn.

### 4.5 Title là metadata plaintext — đánh đổi được ghi rõ
`⌘ sys` / `setup` routing **phụ thuộc** title plaintext; tên người dùng đặt cũng nằm server dạng đọc được. Chấp nhận (đúng hợp đồng: chỉ nội dung tin được mã hóa). Đề xuất không mã hóa title trong giai đoạn này; nếu sau này muốn, phải đổi cả routing sys/setup sang `signal`/cờ riêng — ghi vào backlog, không làm bây giờ.

---

## 5. Di trú từ chữ thường sang E2E

### 5.1 Các phase

| Phase | Việc | Ai |
|---|---|---|
| A. S schema | Chạy SQL migration (§7.1–7.2): additive, idempotent, **không đụng dữ liệu cũ** (`text` giữ nguyên, nullable thêm cột mới) | Owner, SQL Editor |
| B. Deploy UI v7 | Hiểu cả legacy lẫn envelope → an toàn deploy bất kỳ lúc nào, kể cả khi daemon vẫn cũ | Owner |
| C. Daemon v7 | Update daemon qua zip mới (phía daemon làm) | Owner từng Muse |
| D. Onboarding từng Muse | Wizard bước "Turn on encryption" + SAS | Owner, mỗi Muse một lần |

### 5.2 Tinh thần cắt chuyển
- UI v7 tương thích cả hai dạng nên **không có big-bang**: Muse chưa onboarding vẫn chạy plaintext (tin hiện kèm 🔓); Muse onboarding xong thì mọi tin mới là envelope.
- Wizard cho Muse mới: giữ flow setup pong hiện tại (bước 2, plaintext `pong` — là literal cố định, không nhạy cảm) **trước**, rồi bước E2E **sau**. Sau verified, daemon không bao giờ gửi plaintext nữa (trừ row signal trống nội dung).
- **Overlap dễ lỗi nhất**: UI đã verified nhưng daemon cũ (không biết E2E) vẫn gửi `text` plaintext → UI **hiển thị tin + banner** "Your Muse sent an unencrypted message after encryption was turned on. Update your Muse's app (daemon)." — không drop, vì đây là lỗi cấu hình chứ không phải tấn công. **[CẦN DAEMON CHỐT]** §7.8-9 hướng xử lý của daemon khi nó chưa verified mà nhận tin mã hóa.

### 5.3 Tin cũ
- Hiện bình thường + badge 🔓 nhẹ (icon thôi, tooltip giải thích — không có chữ thường trực tiếp để tránh rối mắt). Filter `isStatusRow` cũ giữ nguyên để ẩn rác status legacy.
- Tìm kiếm chỉ có tác dụng trên tên thread (như hiện nay) — không mất gì vì UI chưa bao giờ full-text search nội dung.

### 5.4 Dọn dẹp tùy chọn (không bắt buộc)
⚙ → Settings → Privacy → **"Delete unencrypted history"**: xóa các row `enc_version=0` (hoặc NULL hóa `text`), confirm 2 bước gõ `DELETE`. Mặc định: **không** tự xóa gì. Đề xuất để owner quyết sau khi sống với E2E vài tuần.

---

## 6. Bảng trạng thái lỗi và cảnh báo (đầy đủ)

Nguyên tắc copy: tiếng Anh, câu ngắn, luôn nói **việc cần làm tiếp theo** trong 1 câu đầu.

| # | Trạng thái | Phát hiện thế nào | UI làm gì | Copy English | Lối ra |
|---|---|---|---|---|---|
| 6.1 | **No local key** (lần đầu, hoặc IDB trống mà server chưa từng có khóa browser) | IDB `keys` rỗng + `relay_keys` không có browser key | Empty-state giữa vùng chat; composer disabled; mọi Muse | "**Encryption is not set up on this device.** Messages between you and your Muse are not protected yet. Note: messages encrypted before this cannot be recovered on a new device." | Nút **[Turn on encryption]** → §2.3 |
| 6.2 | **Peer key missing** (chưa setup daemon / daemon cũ không push khóa) | `relay_keys` không có row `side='daemon'` | Chip "Not verified"; composer disabled | "**Waiting for your Muse.** Your Muse hasn't published its encryption key yet. Update your Muse's app, then come back." | Poll tiếp; tự mở khi key về |
| 6.3 | **Peer key unverified** | Row daemon `status='pending'` | Composer disabled; banner cam trên chat; nút mở verify flow | "**Verify your Muse to start chatting.** Compare the safety code with your official Muse chat." | Flow §2.3 bước 2 |
| 6.4 | **SAS mismatch** | Người dùng bấm "Codes don't match" | Modal cảnh báo; KHÔNG xác nhận gì lên server (cả hai phía vẫn pending) | "**The codes don't match.** Do NOT confirm anything in your Muse chat — someone may be listening. Create a new code and try again." | **[Re-run setup]** |
| 6.5 | **Peer key changed unexpectedly** (khóa daemon verified cũ → xuất hiện key_id khác) | So key_id cache vs server mỗi tick; BroadcastChannel đồng bộ mọi tab | **FREEZE**: ngừng decrypt tin mới (hàng đợi ciphertext), ngừng gửi, banner đỏ full-width, chip đỏ "Security alert" | "⚠ **Security alert.** Your Muse's encryption key changed unexpectedly. Messages are paused to protect you. If you did NOT just reinstall or replace your Muse's app, do not continue." | **[Start verification again]** (chạy lại SAS với khóa mới) hoặc **[Report a problem]** |
| 6.6 | **Lost local key** (xóa dữ liệu trình duyệt / máy mới, server có lịch sử khóa browser đã verify) | IDB rỗng + `relay_keys` có browser key cũ | Empty-state; phải nói thật hậu quả; tin E2E cũ sẽ bị loại (không placeholder từng tin — hợp đồng) | "**This device doesn't have your encryption key.** Your past encrypted messages can never be read on this device — there is no backup, by design. You can set up a fresh key here." | **[Set up a new key]** → re-key (§6.11) |
| 6.7 | **IDB unavailable** (private mode / chặn storage) | try/catch mở IDB lúc boot | Chặn toàn app, không phải chỉ chat | "**Encryption needs browser storage.** Turn off private browsing or allow site data for this page, then reload." | — |
| 6.8 | **Decrypt burst fail** (≥3 tin liên tiếp fail sau khi verified) | Counter trong decrypt gate | Banner vàng; tin lỗi vẫn không hiển thị (hợp đồng); sau re-verify, tin cũ mã hóa bằng khóa cũ sẽ thuộc nhóm này — mất, đã chốt | "**Some messages could not be decrypted.** Your Muse's key may have changed, or these messages used a key this device no longer has." | Link mở §6.5 flow |
| 6.9 | **Version unsupported** (`enc_version ≥ 2`) | Envelope check | Loại tin; toast 1 lần/phiên | "This app is outdated and can't read new encrypted messages. Reload or get the latest version." | Reload/F5 |
| 6.10 | **Envelope invalid** (b64 hỏng, nonce ≠24B, thiếu trường) | Envelope check | Loại + counter nội bộ (không toast — attacker có thể spam để gây noise) | (chỉ log console diagnostics) | — |
| 6.11 | **Re-key đang chạy** (replace key chủ động hoặc từ 6.6) | Wizard re-key mở | Composer disabled; banner "Setting up a new key…" | "**Setting up a new encryption key.** Your old key stays in this browser, so older messages remain readable here only." | Hoàn tất SAS → khóa mới `active`, khóa cũ `archived` |
| 6.12 | **Plaintext after verified** (daemon cũ/bug gửi `text` sau verified_at) | Row `enc_version=0` mới sau mốc verified | Hiển thị tin + banner vàng (không drop — lỗi cấu hình) | "**Your Muse sent an unencrypted message.** Update your Muse's app (daemon) to the encrypted version." | Update daemon |
| 6.13 | **Another device re-keyed** (khóa browser của máy này bị `retired` từ nơi khác) | Active key của máy thành retired trên server + tin mới mã hóa cho khóa khác decode-fail burst | Banner; máy này đọc được lịch sử (khóa archived local) nhưng không nhận tin mới | "**Encryption was set up on another device.** You can still read older messages here. To receive new messages on this device, set up a new key." | **[Set up a new key]** |
| 6.14 | **Key alert khi nhiều tab mở** | BroadcastChannel | Freeze đồng bộ mọi tab như 6.5 | (như 6.5) | — |

**Ranh giới hợp đồng cần chủ Muse biết** (nêu rõ, không tự ý): hợp đồng cấm "hiển thị tin giải mã lỗi". Các banner 6.5/6.6/6.8/6.13 là **mô tả trạng thái ở mức thread/app**, không hiển thị từng tin lỗi — đề xuất giữ vì UX không thể khác; nếu chủ Muse đòi nghiêm ngặt tuyệt đối thì các banner này cũng phải bỏ và thread sẽ trống trơn sau lost-key, gây hiểu lầm nhiều hơn. **[CẦN DAEMON CHỐT]** §7.8-10.

---

## 7. Hợp đồng giao tiếp với daemon

### 7.1 Bảng `relay_keys` (DDL — CẬP NHẬT 19/11/2026 khớp code daemon ĐÃ TEST)

Schema daemon đã cài (keys.py + guide DDL v7): `endpoint` ('muse'/'web'), `public_key`, `key_id`, `verified` (bool), `created_at`, `revoked_at`. Các cột đề xuất cũ của thiết kế này (`side`, `status`, `project_id`, `device_label`, `verified_at`, `retired_at`) ĐÃ BỎ — code chạy là chuẩn. File SQL chuẩn: `supabase/setup-v4-draft.sql` (chờ gộp vào setup.sql sau khi daemon gật phần user_id).

```sql
create table if not exists public.relay_keys(
    id         bigint generated always as identity primary key,
    user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
    endpoint   text    not null check (endpoint in ('muse', 'web')),
    public_key text    not null,          -- base64 chuẩn, giải ra đúng 32 byte
    key_id     text    not null,          -- hex(sha256(pub))[:16], §7.4
    verified   boolean not null default false,
    created_at timestamptz not null default now(),
    revoked_at timestamptz
);
-- + index (user_id, endpoint, created_at desc) khớp query sync_web_key
--   (order=created_at.desc&revoked_at=is.null&endpoint=eq.web&limit=1)
-- + RLS 3 policy (select/insert/update) scoped user_id = auth.uid()
-- + trigger cấm đè public_key/endpoint/key_id/user_id (INSERT-only)
```

- `user_id not null default auth.uid()` (ĐỀ XUẤT GLM, chờ daemon gật — giải §7.8-7): daemon INSERT row 'muse' bằng JWT của nó (default tự điền); browser Cloud mode đăng nhập bằng CÙNG user nên row 'web' của nó cùng user_id → hai phía thấy nhau qua RLS; serve.py (LAN, service key → auth.uid() NULL) PHẢI set user_id tường minh.
- Trạng thái: `verified=false` → `true` sau khi SAS khớp; rút khóa = đặt `revoked_at`, không xóa row; khóa mới = row mới (trigger cấm đè public_key).
- Đa-Muse trong 1 DB (Branch A): mỗi Muse một user → RLS tách tự nhiên; Muse chỉ flip `verified` trên row NHÀ MÌNH.

### 7.2 Bảng `messages` — envelope (DDL đề xuất)

```sql
alter table public.messages
    add column if not exists ciphertext   text,
    add column if not exists nonce        text,     -- base64, giải ra đúng 24 byte
    add column if not exists sender_key_id text,   -- 16 hex, khóa của BÊN GỬI
    add column if not exists enc_version  int,     -- nullable, KHÔNG default (khớp guide v7 đã test)
    add column if not exists alg          text;
alter table public.messages alter column text drop not null;
-- ^ 19/11: v7 writers OMIT `text` cho tin mã hóa; v3 NOT NULL sẽ vỡ INSERT đầu tiên.
--   Đây là lỗi thật trong guide v7 (đã báo Muse 1 patch cùng guide).
-- Cột `signal` (§7.5) KHÔNG đưa vào v4: signal nhận dạng bằng shape
-- (role='muse' + text ∈ {'...','pong'} + ciphertext null), filter server
-- text=eq.pong vẫn hoạt động vì pong giữ plaintext.

alter table public.messages alter column text drop not null;  -- row signal không có text
create index if not exists idx_messages_signal
    on public.messages(project_id, signal) where signal is not null;
```

**Quy tắc tổ hợp (validate ở CẢ HAI đầu):**

| enc_version | alg | ciphertext | nonce | sender_key_id | signal | text | Ý nghĩa |
|---|---|---|---|---|---|---|---|
| 0 | NULL | NULL | NULL | NULL | NULL | bắt buộc | Legacy plaintext (tin cũ + window setup) |
| 1 | 'crypto_box' | bắt buộc | bắt buộc | bắt buộc | NULL | NULL | Tin E2E chuẩn |
| 1 | 'crypto_box' | NULL | NULL | NULL | bắt buộc | NULL | Signal row (typing/pong/sys-marker) sau E2E |
| khác | — | — | — | — | — | — | Sai hình thức → MR-E2E-006, loại |

Cap: plaintext ≤ 20,000 ký tự (giữ đúng giới hạn cũ, đo **trước** mã hóa, hai phía tự enforce); cột ciphertext không check cứng.

### 7.3 Định dạng byte & encoding

| Thành phần | Giá trị |
|---|---|
| Thuật toán | libsodium `crypto_box` = X25519 + HSalsa20 + XSalsa20-Poly1305 (daemon: PyNaCl `crypto_box_easy` / `SecretBox`) |
| Mã hóa | `ciphertext = MAC(16B) ‖ XSalsa20-Poly1305(msg)` — MAC đứng đầu, đúng layout easy/secretbox của cả tweetnacl lẫn PyNaCl |
| nonce | 24 byte ngẫu nhiên (`randombytes`/`getRandomValues`), base64 chuẩn; **mỗi tin 1 nonce mới, retry cũng nonce mới** |
| Văn bản | UTF-8 trước khi mã hóa |
| public_key | 32 byte, base64 chuẩn (có padding) |
| key_id | 16 ký tự hex thường (§7.4) |

### 7.4 key_id và SAS — dùng chung hai phía

```
key_id = hex( SHA-256(public_key_raw_32B) )[0:16]     # 16 ký tự hex thường
```

```
SAS-48 (mục §2.2 — chuẩn = safety.py v7, cập nhật 19/11):
  ordered = sorted([(pubA, kidA), (pubB, kidB)])       # tuple sort: key trước, key_id tie-break
  h = SHA-256(b"muse-relay-safety-v1" || 0x00 || k_first || 0x00 || k_second
              || 0x00 || ascii(kid_first) || 0x00 || ascii(kid_second))
  sas = str(int(h, 16)).zfill(78)[:48] → 12 nhóm × 4   # KHÔNG mod 10^48
```

### 7.5 Cột `signal` — đề xuất mở rộng hợp đồng

Hiện trạng bắt buộc phải đổi: `typing ('...')`, `pong`, wrapper `<<<STATUS>>>` được nhận dạng bằng **nội dung**, và `checkPongPending` lọc `text=eq.pong` **trên server** — với ciphertext thì cả hai bất khả thi. Đề xuất: cột metadata `signal` chữ thường (`typing|pong|status_req|status_res`), row signal không có nội dung. Đây là mục DUY NHẤT vượt ra ngoài envelope hợp đồng đã chốt — cần daemon đồng thuận; nếu bị từ chối thì phương án dự phòng là UI scan + giải mã lô tin gần nhất để tìm pong (tốn kém, đề xuất thay bằng bỏ hẳn pong-gating server, chuyển sang xác nhận ready qua kênh sys).

### 7.6 Mã lỗi (chuẩn log/chẩn đoán — không phải REST response)

| Mã | Ý nghĩa | Tại UI |
|---|---|---|
| MR-E2E-001 | No local key | Trạng thái 6.1 |
| MR-E2E-002 | Peer key missing | 6.2 |
| MR-E2E-003 | Peer key unverified | 6.3 |
| MR-E2E-004 | Decrypt failed (đã verified) | Counter → burst → 6.8 |
| MR-E2E-005 | Peer key changed | 6.5 |
| MR-E2E-006 | Envelope invalid / tổ hợp sai | 6.10 |
| MR-E2E-007 | SAS mismatch (người dùng báo) | 6.4 |
| MR-E2E-008 | enc_version/alg unsupported | 6.9 |
| MR-E2E-009 | Lost local key (server có lịch sử) | 6.6 |
| MR-E2E-010 | Plaintext after verified | 6.12 |

### 7.7 Daemon đảm nhận những gì (để hai phía khớp)

1. Sinh cặp khóa local, INSERT `relay_keys(side='daemon', key_id, public_key, status='pending')` — private key nằm trên máy daemon, không lên server.
2. Mã hóa mọi tin gửi đi bằng khóa browser **verified** + private của mình; envelope đầy đủ đúng §7.2–7.3; `sender_key_id` = key_id của daemon.
3. Giải mã tin đến bằng private của mình + public khóa browser gửi (lookup `sender_key_id` trong relay_keys); tin giải/xác thực lỗi → **loại ngay, không reply** (đúng hợp đồng).
4. Chỉ process nội dung từ khóa browser `verified` **[CẦN DAEMON CHỐT]** §7.8-4.
5. Hiển thị SAS khi nhận lệnh trong chat Muse chính thức, chờ xác nhận rồi mới UPDATE khóa browser thành `verified` (§2.3).
6. Gửi signal qua cột `signal` (typing/pong), row trống nội dung, kể từ khi E2E bật.
7. Giám sát khóa browser đổi bất thường (máy khác re-key) và hành xử nhất quán với 6.13.
8. Giữ private key CŨ của daemon sau re-key của nó để giải mã lịch sử phía nó; khóa cũ đánh `retired` trên server.
9. Kênh sys: xử lý task đã mã hóa như tin thường (ping, /status), trả lời qua cùng thread.
10. Không bao giờ fallback plaintext sau khi verified (trừ signal row trống) — vi phạm phải là lỗi hiển nhiên cho UI (6.12).

### 7.8 Danh sách câu hỏi cần daemon chốt trước khi code

1. **key_id** chấp nhận rule `sha256(pubkey)[:8] hex` (§7.4)?
2. **SAS-48** cài đúng §2.2 + chạy chung test vector (§9)?
3. **Cột `signal`** — đồng ý thêm vào schema? (đề xuất chính; phương án dự phòng §7.5)
4. Daemon có **khóa composer ngược chiều** — chỉ xử lý nội dung từ khóa browser verified, KHÔNG fallback plaintext sau verified?
5. Tên lệnh verify trong chat chính thức (`verify` / `yes`) + hành vi khi người dùng bỏ trống không xác nhận + chính sách nhiều khóa browser pending (đề xuất: chỉ verify khóa mới nhất)?
6. Khi re-key một đầu giữa chừng: reply có được mã hóa bằng key_id của tin đến không (đề xuất: có, UI chấp nhận mọi key_id đã biết-verified)?
7. Daemon ghi `relay_keys` bằng identity nào (authenticated Muse user hay qua serve.py)?
8. Daemon giám sát khóa browser thế nào và phản ứng ra sao khi thấy khóa browser lạ?
9. Overlap deploy: hành vi daemon khi nhận tin mã hóa nhưng chưa verified (đề xuất: bỏ qua + log, không crash)?
10. Chấp nhận banner mức thread/app cho các trạng thái 6.5/6.6/6.8/6.13 (không hiển thị từng tin lỗi — đúng chữ hợp đồng, nhưng thread trống cần được giải thích)?

---

## 8. Các chỗ web UI từng cần chữ thường — và cách xử lý

Tất cả tham chiếu `web/index.html` hiện tại (v6.1):

| # | Chỗ | Dòng | Vấn đề với E2E | Xử lý | Mất gì không |
|---|---|---|---|---|---|
| 1 | Bootstrap + poll lấy messages, select cột `text` | 1801, 3531 | `text` sẽ NULL với tin mới | Select thêm `ciphertext, nonce, sender_key_id, enc_version, alg, signal`; decrypt gate tại `ingestMessage` | Không |
| 2 | `isTypingRow` / `isStatusRow` / `SIGNAL_PONG` — nhận dạng bằng nội dung | 1900–1928 | Không match được ciphertext | Đọc `m.signal` trước (§7.5); fallback so `text` chỉ cho row `enc_version=0` | Không |
| 3 | `checkPongPending` — filter server `text=eq.pong` | 2210, 3887 | Filter trên server bất khả thi với ciphertext | `signal=eq.pong` + index (§7.2) — phụ thuộc daemon chốt cột signal | Không (nếu bị chối: pong-gating chuyển qua kênh sys) |
| 4 | Auto-title: `interimTitleFrom` / `applyInterimTitle` / `maybeAutoTitle` / title-task | 2127–2200 | Đọc plaintext để đặt tên | **BỎ theo quyết định chốt** (§4.3) | Tính năng bị bỏ — đã chốt |
| 5 | `SYS_TEXT_CAP` — 600 ký tự tin đầu nuôi title-task | 1372 | — | Bỏ cùng title-task | Không |
| 6 | Sidebar preview tin mới nhất + preview "typing…" | 1833–1886 | Cần text | Đọc từ store `plain` (plaintext cache local) | Không |
| 7 | Tên thread = 10 từ đầu tin đầu | (bị bỏ) | — | Preview tin đầu sau decrypt hoặc tên tự đặt (§4) | Không |
| 8 | Reply quote `quotedBlockFor` ("> [Name]") | 2988 | Cần text tin được quote | Đọc từ `plain` cache | Không |
| 9 | Copy bubble (`copyText`) | 1611 | Cần text | Đọc từ `plain` cache | Không |
| 10 | Tìm kiếm sidebar | 2457, 2493 | — | **Không đụng nội dung tin** (đã chỉ search theo `title`) — giữ nguyên; hạn chế cố hữu: chỉ tìm được tên thread | Không |
| 11 | Rename thread (PATCH `threads.title`) | 3641 | — | Giữ nguyên — title là metadata người dùng chủ động đặt (đánh đổi ghi ở §4.5) | Không |
| 12 | Regex quota trên reply sys | 2103 | Cần text | Decrypt rồi mới regex | Không |
| 13 | Attach cards — regex Dropbox link trong text | 1348, 2649+ | Link nằm trong ciphertext | Regex chạy trên plaintext sau decrypt (§3.2); file Dropbox **không mã hóa** (GĐ 1 đã chốt) | Không (ai có link vẫn mở được file — chấp nhận GĐ 1) |
| 14 | `isStatusRow` ẩn rác status legacy | 1900 | — | Giữ nguyên cho row `enc_version=0` | Không |
| 15 | Chip delivered / read-state / unread / last-activity | — | — | Toàn bộ dựa metadata (id, watermark, created_at) — không đổi | Không |
| 16 | REST API `/api/v1` + `/docs` (serve.py) | serve.py | API client đọc `text` | `/api/v1` trả envelope thay vì `text`; **API client phải tự giải mã** — ngoài phạm vi UI, ghi chú vào OpenAPI | Với API client: mất khả năng đọc trực tiếp — chấp nhận, đúng tinh thần E2E |
| 17 | `serve.py /thumbs` + preview Dropbox | serve.py | — | Nằm hoàn toàn phía Dropbox, không đụng content tin | Không |
| 18 | Wizard setup pong (`text=eq.pong`) | 3887 | Như #3 | Trước E2E: giữ legacy; sau verified: `signal` | Không |
| 19 | Ping 10' / `/status` 30' nền qua ⌘ sys | — | Task text plaintext | Mã hóa như tin thường (§3.6) | Không |

**Không xử lý được / bị bỏ:** auto-title (đã chốt bỏ), mọi filter server theo nội dung (`text=eq.*` — thay bằng `signal`, không có trường hợp nào khác), và UI **không** có full-text search nội dung nên không mất gì ở đó.

---

## 9. Việc bắt buộc trước khi viết code

1. **Bộ test vector chung — ĐÃ CÓ: `docs/e2e-test-vectors.json`** (sinh 19/11/2026 bằng chính `safety.py`/`crypto.py` v7 đã test, PyNaCl 1.6.2, key seeds + nonce cố định):
   - `safety_number`: SAS chuẩn = `1012 4868 3997 7703 4521 1783 5887 9886 4417 2991 9618 2656` (order-independent checked).
   - `key_id`: 2 vector (muse `aaa8fff703b50b22`, web `4457134794559182`).
   - `box_web_to_muse` / `box_muse_to_web`: plaintext package + nonce + ciphertext b64 chính xác (ciphertext RAW — nonce KHÔNG prepend).
   - `decrypt_row_gate`: 6 forged case kèm drop reason đúng (`auth_failed`, `unknown_sender_key`, `bad_enc_version`, `bad_alg`, `missing_ciphertext`, `legacy_plaintext_not_allowed`).
   - Web side phải tái tạo ĐỦ từng byte trước khi code UI.
2. Chốt 10 câu hỏi §7.8 với phía daemon.
3. Migration SQL chạy thử trên project Supabase staging/bản thật (idempotent, backup trước).

---

## Phụ lục A — Copy English trung tâm (nguồn duy nhất khi code)

| Vị trí | Chuỗi |
|---|---|
| Wizard bước 1 — tiêu đề | `Set up end-to-end encryption` |
| Wizard bước 1 — thân | `Your messages will be locked so only you and your Muse can read them. Your secret key stays in this browser and is never uploaded.` |
| Wizard bước 1 — cảnh báo | `Important: if you clear this browser's data or use a new device, past encrypted messages can never be read again. There is no backup — by design.` |
| SAS — hướng dẫn | `Compare this code with the code in your official Muse chat, row by row, left to right.` |
| SAS — nút | `Codes match` / `Codes don't match` / `Copy code` |
| Chip verified | `Encrypted` (tooltip: `End-to-end encrypted · Verified`) |
| Chip pending | `Not verified` |
| Banner pending | `Verify your Muse to start chatting.` |
| Banner key alert | `Security alert. Your Muse's encryption key changed unexpectedly. Messages are paused to protect you.` |
| Empty-state no key | `Encryption is not set up on this device.` |
| Lost key | `This device doesn't have your encryption key. Your past encrypted messages can never be read on this device — there is no backup, by design.` |
| Badge legacy (tooltip) | `Sent before end-to-end encryption was enabled` |
| Bubble decrypting | `Decrypting…` |
| Thread rỗng | `New chat` |
| Rename placeholder | `Thread name (optional)` |
| Re-key — tiêu đề | `Replace your encryption key?` |
| Re-key — thân | `Your new key starts fresh. Messages encrypted with your old key stay readable on this device only. On any other device, old messages can never be read again.` |
| ⚙ Settings mục mới | `Encryption` — `Verified · Key created <date>` / `Not verified — Verify now` / `Clear local message cache` / `Replace encryption key…` / `Delete unencrypted history` |
| Toast version cũ | `This app is outdated and can't read new encrypted messages. Reload to update.` |
| Banner daemon cũ sau verified | `Your Muse sent an unencrypted message. Update your Muse's app (daemon) to the encrypted version.` |

---

*Hết — thiết kế này là cơ sở cho phiên bản v7; chưa viết code. Mọi điểm chưa chắc chắn đã đánh dấu **[CẦN DAEMON CHỐT]** (gom ở §7.8).*
