# Muse Relay v2 — Design System UI

> **Người phụ trách**: ui-designer (pipeline Muse Relay v2)
> **Ngày**: 16/11/2026
> **Đầu vào**: `project-specs/muse-relay-v2-setup.md` (chủ yếu §8, §0.3), `project-tasks/muse-relay-v2-tasklist.md`, DNA dark theme của `static/index.html` (chỉ ĐỌC, không sửa)
> **Người tiêu dùng**: frontend-developer — dịch thẳng mọi giá trị dưới đây vào `<style>` trong `web/index.html` (MỘT file, không build step, không file CSS ngoài)
> **Acceptance số 1 từ owner**: "giao diện phải ngon"

## Phạm vi & ràng buộc

1. **Structure/layout bắt buộc theo spec §8 — bất khả xâm phạm** (sidebar trái, khối phải header+chat+composer, wizard 3 bước, Settings màn đầu). Document này chỉ CHỐT miền VISUAL: màu, chữ, khoảng cách, radius, shadow, motion, trạng thái.
2. **Desktop-only**: spec không yêu cầu responsive/mobile, tasklist cấm tự thêm. Layout cố định, không media query. Chỉ cần hoạt động tốt từ ~1100px trở lên.
3. **Giữ DNA dark theme của UI cũ** (`#0f141a / #171e26 / #243040 / #2f6fed / #243244 / #e8eef5 / #8b9bb0`) nhưng nâng cấp rõ rệt độ hoàn thiện (xem Phụ lục D).
4. **Màu chip theo spec §8 chốt cứng**: `chat` = xanh dương, `image` = xanh lá, `video` = tím. Bubble: user phải/xanh, muse trái/xanh đậm.
5. **Chuỗi literal bắt buộc giữ nguyên trong markup** (QA của TASK 5–7 grep đếm): `＋ New`, `Kiểm tra kết nối`, `Thread mới`, `⋮`, `⬇`, và URL CDN jsdelivr pin version. Không thay bằng icon SVG làm mất chuỗi này.
6. **Không emoji màu** trong UI. Chỉ dùng ký tự dòng chữ (＋ ⋮ ▾ ⬇ ✕ ✓ ⚠ ⓘ) hoặc SVG inline 16px, stroke 1.5, `currentColor`.

---

## 0. Nguyên tắc xuyên suốt

1. **Dark dev-tool, không màu mè** — chất diện mạo tham chiếu ZCode/Codex/Cursor: nền tối xanh-slate, border mảnh, một accent duy nhất (xanh dương) làm điểm nhấn, mọi thứ còn lại trung tính. Không gradient trang trí, không glow, không animation quá tay.
2. **Token-only** — 100% màu/px/ms lấy từ `:root`. Cấm hex/cỡ chữ/khoảng cách hardcode trong rule component. (Trừivial: giá trị `rgba` phái sinh từ token accent được viết sẵn trong token block bên dưới.)
3. **Lưới 4px** — mọi padding/margin/gap/height là bội của 4 (4/8/12/16/20/24/32/48). Không có 10px "chợ tình cờ"; nếu cần 10px thì chỉnh scale, không tự nhiên thêm.
4. **Tương phản đạt chuẩn** — text chính đạt WCAG AA (4.5:1), đã tính sẵn trong bảng A.1. Nếu frontend đổi bất kỳ màu nào, phải kiểm tra lại tương phản.
5. **Chuyển động tinh tế ≤ 240ms** — chỉ chuyển màu nền/border, fade, dịch 4–8px. Không bounce, không scale quá 2%, không parallax.
6. **Không component "mặc định browser"** — mọi `button`, `input`, `select`, `textarea`, `checkbox`, `scrollbar` đều được style đè; `appearance: none` cho control native.

---

# A. DESIGN TOKENS

## A.1 Màu — block `:root` copy-paste được

Đây là block hoàn chỉnh, dán thẳng vào đầu `<style>`:

```css
:root {
  /* ===== 1. NỀN (thang elevation, mịn từ tối → sáng) ===== */
  --bg-base:     #0f141a;  /* canvas chính: vùng chat, màn Settings, nền body (DNA cũ) */
  --bg-panel:    #171e26;  /* chrome: sidebar, header, dải composer (DNA cũ) */
  --bg-surface:  #1e2632;  /* bề mặt nổi 1: input, bubble muse, card đính kèm, dropdown, modal body */
  --bg-hover:    #222c3a;  /* hover: hàng sidebar, item menu, icon button */
  --bg-selected: #22304a;  /* thẻ project đang chọn, thread đang mở (DNA cũ .conv.active) */
  --bg-backdrop: rgba(6, 9, 14, 0.66);  /* lớp mờ sau modal */

  /* ===== 2. BORDER ===== */
  --border-subtle:  #1e2733;  /* divider trong panel */
  --border-default: #243040;  /* border chuẩn: input, card, ngăn panel (DNA cũ --line) */
  --border-strong:  #33445c;  /* border hover/focus, viền dropdown */

  /* ===== 3. CHỮ ===== */
  --text-primary:   #e8eef5;  /* tên project, nội dung tin, tiêu đề (DNA cũ --text) */
  --text-secondary: #a9b9cd;  /* muse_id, label form, mô tả */
  --text-muted:     #8b9bb0;  /* timestamp, hint, placeholder (DNA cũ --dim) */
  --text-on-accent: #ffffff;  /* chữ trên bubble user / nút primary / badge */

  /* ===== 4. ACCENT CHÍNH (xanh dương — bubble user, nút primary, chip chat) ===== */
  --accent:        #2f6fed;  /* DNA cũ --me */
  --accent-hover:  #4179f2;
  --accent-active: #2455c4;
  --accent-text:   #6ea8ff;  /* link, icon accent, dấu ✓ menu */

  /* ===== 5. CHIP 3 NĂNG LỰC (spec §8: chat=xanh dương, image=xanh lá, video=tím) ===== */
  /* chat */
  --chip-chat-fg:  #6ea8ff;
  --chip-chat-bg:  rgba(47, 111, 237, 0.16);
  --chip-chat-bd:  rgba(47, 111, 237, 0.38);
  /* image */
  --chip-image-fg: #56d364;
  --chip-image-bg: rgba(63, 185, 80, 0.13);
  --chip-image-bd: rgba(63, 185, 80, 0.36);
  /* video */
  --chip-video-fg: #d2a8ff;
  --chip-video-bg: rgba(137, 87, 229, 0.16);
  --chip-video-bd: rgba(137, 87, 229, 0.40);

  /* ===== 6. BUBBLE ===== */
  --bubble-user:      #2f6fed;
  --bubble-user-text: #ffffff;
  --bubble-user-time: #ffffff;  /* 4.55:1 trên #2f6fed — đạt AA */
  --bubble-muse:      #243244;  /* DNA cũ */
  --bubble-muse-text: #e8eef5;
  --bubble-muse-time: #8b9bb0;  /* 4.59:1 trên #243244 — đạt AA */
  --bubble-muse-bd:   #2c3a4e;  /* viền định hình bubble muse */

  /* ===== 7. SEMANTIC (chuẩn GitHub-dark, rất "dev-tool") ===== */
  --success:      #3fb950;  --success-text: #56d364;  --success-bg: rgba(63, 185, 80, 0.12);
  --warning:      #bb8009;  --warning-text: #d29922;  --warning-bg: rgba(187, 128, 9, 0.12);
  --danger:       #da3633;  --danger-text:  #f85149;  --danger-bg:  rgba(218, 54, 51, 0.12);
  --danger-hover: #e5534b;

  /* ===== 8. TYPOGRAPHY ===== */
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, "JetBrains Mono", "Cascadia Code", "SF Mono", Consolas, monospace;
  /* cỡ chữ dùng trực tiếp giá trị px trong bảng A.2, không cần var riêng */

  /* ===== 9. SPACING (lưới 4px) ===== */
  --sp-1: 4px;   --sp-2: 8px;   --sp-3: 12px;  --sp-4: 16px;
  --sp-5: 20px;  --sp-6: 24px;  --sp-8: 32px;  --sp-12: 48px;

  /* ===== 10. RADIUS ===== */
  --radius-chip:   999px;  /* chip tag, badge unread */
  --radius-sm:     6px;    /* tooltip, icon button */
  --radius-input:  8px;    /* input, button, item menu, thẻ sidebar */
  --radius-card:   10px;   /* card đính kèm, dropdown, toast */
  --radius-bubble: 14px;   /* bubble chat (góc ngoài rút còn 4px) */
  --radius-modal:  14px;   /* modal wizard/token/xóa */

  /* ===== 11. SHADOW ===== */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.35);
  --shadow-md: 0 2px 4px rgba(0, 0, 0, 0.30), 0 8px 24px rgba(0, 0, 0, 0.38);
  --shadow-lg: 0 4px 12px rgba(0, 0, 0, 0.40), 0 24px 64px rgba(0, 0, 0, 0.50);

  /* ===== 12. MOTION ===== */
  --dur-fast: 120ms;  /* hover màu nền/border/icon */
  --dur-base: 180ms;  /* dropdown, bubble tin mới, copy feedback */
  --dur-slow: 240ms;  /* modal mở/đóng, toast */
  --ease-out:    cubic-bezier(0.22, 1, 0.36, 1);
  --ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);

  /* ===== 13. SCROLLBAR / FOCUS / SELECTION / CARET ===== */
  --scrollbar-thumb:       #2b3849;
  --scrollbar-thumb-hover: #3a4c63;
  --focus:      #58a6ff;                       /* outline focus-visible */
  --focus-ring: 0 0 0 3px rgba(88, 166, 255, 0.28); /* glow kèm border input */
  --selection-bg: rgba(47, 111, 237, 0.45);
  --caret-color: var(--accent);

  /* ===== 14. KÍCH THƯỚC LAYOUT & Z-INDEX ===== */
  --sidebar-w:      300px;
  --header-h:       52px;
  --bubble-max-w:   680px;
  --composer-max-h: 160px;
  --modal-w:        560px;   /* wizard */
  --modal-sm-w:     420px;   /* token / xóa */
  --z-dropdown: 100;
  --z-modal:    200;
  --z-toast:    300;
}
```

### Bảng nghĩa & nơi dùng (tra nhanh)

| Token | Giá trị | Dùng ở |
|---|---|---|
| `--bg-base` | `#0f141a` | body, vùng chat, textarea guide, nền màn Settings |
| `--bg-panel` | `#171e26` | sidebar, header project, dải composer, card Settings, modal |
| `--bg-surface` | `#1e2632` | input, dropdown menu, card đính kèm, bubble muse* |
| `--bg-hover` | `#222c3a` | hover hàng sidebar/menu/icon button |
| `--bg-selected` | `#22304a` | thẻ project selected (+ inset accent 2px bên trái) |
| `--border-default` | `#243040` | mọi border mặt đắt: input, card, ngăn panel |
| `--text-secondary` | `#a9b9cd` | muse_id, label, mô tả empty state |
| `--text-muted` | `#8b9bb0` | timestamp, thời gian tương đối, hint, placeholder |
| `--accent` | `#2f6fed` | bubble user, nút primary, badge, chip chat, focus caret |

(*) Bubble muse dùng giá trị riêng `--bubble-muse` (#243244, đậm hơn `--bg-surface`) — giữ DNA cũ.

### Tương phản đã kiểm chứng (WCAG AA ≥ 4.5:1 cho text thường)

| Chữ | Nền | Tỉ lệ | Ghi chú |
|---|---|---|---|
| `--text-primary` #e8eef5 | `--bg-base` #0f141a | ~13.6:1 | vượt xa AA |
| `--text-secondary` #a9b9cd | `--bg-panel` #171e26 | ~8.4:1 | đạt AA |
| `--text-muted` #8b9bb0 | `--bg-panel` #171e26 | ~5.9:1 | đạt AA (timestamp) |
| `--text-muted` #8b9bb0 | `--bubble-muse` #243244 | ~4.6:1 | đạt AA |
| `--text-on-accent` #ffffff | `--accent` #2f6fed | ~4.55:1 | đạt AA (bubble user, nút, badge) |
| `--text-on-accent` #ffffff | `--danger` #da3633 | ~4.6:1 | đạt AA (nút Xóa) |
| `--chip-chat-fg` #6ea8ff | nền chip hiệu dụng ~#1b2b46 | ~5.9:1 | đạt AA (chip 10px/600) |
| `--chip-image-fg` #56d364 | nền chip hiệu dụng | ≥ 6:1 | đạt AA |
| `--chip-video-fg` #d2a8ff | nền chip hiệu dụng | ≥ 6:1 | đạt AA |
| `--accent-text` #6ea8ff | `--bg-base` | ~6:1 | link/icon |

**Quy luật**: timestamp trong bubble user PHẢI là `#ffffff` (không dùng opacity — opacity làm rơi tương phản dưới AA). Timestamp bubble muse dùng `--text-muted`.

## A.2 Typography

| Cấp | Cỡ | Weight | Line-height | Font | Dùng cho |
|---|---|---|---|---|---|
| Caption-2 | 10px | 600 / 700 | 1.2 | sans | chip tag (uppercase, letter-spacing 0.04em), badge unread |
| Caption | 11px | 400–500 | 1.35 | mono cho muse_id; sans cho còn lại | muse_id, timestamp, thời gian tương đối, hint composer, tooltip, nội dung callout phụ |
| Small | 12px | 400 (label: 600) | 1.45 | sans (key/credential: mono 12px) | preview sidebar, label form, item menu, stepper, nút Copy |
| Body-SM | 13px | 400 (tên/tiêu đề: 600) | 1.55 | sans | tên project (600), tên project trong header (600), text nút (600), toast (500), value input |
| Body | 14px | 400 | 1.60 (chat) / 1.50 (composer) | sans | nội dung bubble, textarea composer |
| Title | 15px | 600 | 1.3 | sans | tiêu đề modal |
| Title-LG | 16px | 600 | 1.3 | sans | tiêu đề màn Settings |

Quy ước:
- `body { font: 400 14px/1.5 var(--font-sans); -webkit-font-smoothing: antialiased; }` rồi các cấp ghi đè.
- **mono chỉ dùng cho dữ liệu máy**: muse_id, email Muse, password, key, tên file zip, nội dung setup_guide.txt, tên file trong card đính kèm. Đó là chi tiết tạo cảm giác dev-tool.
- Truncate 1 dòng: `white-space: nowrap; overflow: hidden; text-overflow: ellipsis;` — áp cho tên project, preview, tên file, tiêu đề thread. Bubble chat thì `white-space: pre-wrap; word-break: break-word;` (giữ DNA cũ).
- Chữ hoa chỉ dùng cho chip tag; không uppercase tiêu đề.

## A.3 Spacing / Radius / Shadow / Z-index

**Spacing** (bội 4px): `--sp-1..12`. Quy chiếu nhanh:

| Nơi dùng | Giá trị |
|---|---|
| Padding thẻ project sidebar | 10px 12px (10px = 2×4 + 2 cạnh; chấp nhận vì lưới 4px theo cặp 8+2 margin thẻ) — **chuẩn hóa: 8px 12px**, margin thẻ 0 8px, gap giữa thẻ 4px |
| Padding hàng brand / hàng search / New | 8px 12px, gap 8px |
| Padding header project | 0 16px |
| Padding vùng chat | 16px 24px, gap bubble 12px |
| Padding dải composer | 12px 16px |
| Padding bubble | 10px 14px |
| Padding modal | 24px (header 16px 24px) |
| Padding card Settings | 24px 32px |
| Padding input/button | 8px 12px |
| Gap chip–chip | 4px; gap chip↔muse_id | 6px |
| Khoảng cách label↔input | 6px; nhóm field↔field | 16px |

**Radius**: chip/badge `999px`, tooltip/icon-btn `6px`, input/button/menu-item/thẻ sidebar `8px`, card đính kèm/dropdown/toast `10px`, bubble `14px`, modal `14px`. Bubble có **góc ngoài rút ngắn**: user `border-radius: 14px 14px 4px 14px` (góc dưới-phải), muse `14px 14px 14px 4px` (góc dưới-trái) — chỉ đẹp khi bubble có timestamp dưới cùng bên trong.

**Shadow**: `--shadow-sm` cho card đính kèm + thẻ project selected; `--shadow-md` cho dropdown, tooltip, toast, card Settings; `--shadow-lg` cho modal. Panel nền phẳng (sidebar/header) KHÔNG shadow — chỉ border 1px `--border-default`. Bubble user có halo rất nhẹ: `0 1px 2px rgba(47,111,237,0.25)`; bubble muse không shadow, định hình bằng border `--bubble-muse-bd`.

**Z-index**: sticky header 50 → dropdown 100 → modal 200 → toast 300. Backdrop modal là chính phần tử modal (z 200).

## A.4 Motion

| Hoạt cảnh | Duration | Easing | Kỹ thuật |
|---|---|---|---|
| Hover màu (nền/border/chữ/icon) | `--dur-fast` 120ms | `--ease-out` | chỉ transition `background-color, border-color, color, box-shadow` |
| Dropdown menu / tooltip mở | `--dur-base` 180ms | `--ease-out` | fade + translateY(4px→0) |
| Modal mở | `--dur-slow` 240ms | `--ease-out` | backdrop fade; panel opacity 0→1 + scale(0.97→1). Đóng nhanh hơn: 160ms fade thuần |
| Toast vào | 200ms | `--ease-out` | fade + translateY(8px→0); ra 150ms fade |
| Bubble tin mới | 180ms | `--ease-out` | fade + translateY(4px→0) |
| Copy feedback ("✓ Đã copy") | 180ms | `--ease-out` | đổi text + màu `--success-text`, tự trở lại sau 1.2s |
| Spinner | 700ms/lòng | linear | SVG circle stroke-dash, 14–16px |

Quy tắc: KHÔNG animation cho chip, badge, scrollbar. KHÔNG `transform` trên nút khi hover (chỉ đổi màu); chỉ bubble tin mới và modal được phép transform. Luôn khai báo:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 1ms !important; animation-duration: 1ms !important; }
}
```

## A.5 Scrollbar mảnh / Focus ring / Selection / Caret — khai báo gốc

```css
/* Scrollbar mảnh (Chrome/Edge/Safari) */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
  border: 3px solid transparent;      /* mẹo padding trong: visible thumb chỉ 4px */
  background-clip: content-box;
  border-radius: 999px;
}
::-webkit-scrollbar-thumb:hover { background-color: var(--scrollbar-thumb-hover); }
/* Firefox */
* { scrollbar-width: thin; scrollbar-color: var(--scrollbar-thumb) transparent; }

/* Focus ring accessible: bàn phím mới hiện, chuột không */
:focus { outline: none; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 4px; }

/* Input focus (kèm glow): */
/* border-color: var(--accent); box-shadow: var(--focus-ring); */

::selection { background: var(--selection-bg); color: #ffffff; }
input, textarea { caret-color: var(--caret-color); }
```

Áp scrollbar cho: sidebar list, vùng chat, textarea guide, dropdown thread (max-height), textarea composer khi tràn.

---

# B. SPEC TRỰC QUAN TỪNG COMPONENT

## B.0 Khung tổng thể

```
┌────────────────┬──────────────────────────────────────────────────────────┐
│ SIDEBAR        │ HEADER PROJECT (52px, --bg-panel, border-bottom)         │
│ 300px          ├──────────────────────────────────────────────────────────┤
│ --bg-panel     │ VÙNG CHAT (--bg-base, scroll dọc)                        │
│ border-right   │                                                          │
│ --border-      │   bubble muse (trái)                                     │
│  default       │                          bubble user (phải)              │
│                ├──────────────────────────────────────────────────────────┤
│                │ COMPOSER (--bg-panel, border-top, padding 12px 16px)     │
└────────────────┴──────────────────────────────────────────────────────────┘
```

- `body { height: 100vh; display: flex; overflow: hidden; }` — trang KHÔNG cuộn, chỉ vùng chat + sidebar cuộn (giữ DNA cũ).
- Sidebar: `width: var(--sidebar-w); flex-shrink: 0;` Khối phải: `flex: 1; min-width: 0; display: flex; flex-direction: column;` (min-width: 0 bắt buộc để truncate hoạt động).
- Màn Settings và các modal phủ toàn khung bằng overlay riêng.

## B.1 Sidebar (300px)

Cấu trúc từ trên xuống: hàng brand → ô search → nút ＋ New → divider → danh sách thẻ project (scroll).

```
┌── SIDEBAR ──────────────────────────────────┐
│  ✦ Muse Relay                         ⚙    │  hàng brand, 44px
│  ┌───────────────────────────────────────┐  │
│  │ ⌕  Tìm Muse…                          │  │  search, cao 34px
│  └───────────────────────────────────────┘  │
│  ┌───────────────────────────────────────┐  │
│  │              ＋ New                    │  │  primary, cao 34px, full-width
│  └───────────────────────────────────────┘  │
│  ─────────────────────────────────────────  │  divider --border-subtle, 8px 0
│  ┌───────────────────────────────────────┐  │
│  │▐ Muse Thiết kế              5 phút    │  │  thẻ SELECTED
│  │▐ @muse_design  ●chat ●image    (3)   │  │
│  │▐ Bạn: gửi lại bản mockup mới nhé…    │  │
│  └───────────────────────────────────────┘  │
│  ┌───────────────────────────────────────┐  │
│  │  Muse Video                  2 giờ    │  │  thẻ thường
│  │  @muse_video  ●chat ●video            │  │
│  │  ⬇ render_final.mp4 · Dropbox         │  │
│  └───────────────────────────────────────┘  │
│         (scroll, scrollbar mảnh)            │
└─────────────────────────────────────────────┘
```

| Thành phần | Spec |
|---|---|
| Hàng brand | cao 44px, padding 8px 12px; glyph `✦` màu `--accent-text` 14px; tên "Muse Relay" 13px/600 `--text-primary`; nút gear (icon-btn ghost 28px, mở lại Settings) đẩy phải |
| Ô search | cao 34px, radius 8px, bg `--bg-base`, border 1px `--border-default`; icon kính lúp SVG 14px `--text-muted` đặt tuyệt đối trái 12px; padding-left 32px; text 13px; placeholder "Tìm Muse…" `--text-muted`; focus: border `--accent` + `--focus-ring` |
| Nút ＋ New | primary full-width cao 34px: bg `--accent`, chữ `＋ New` 13px/600 `--text-on-accent` (GIỮ literal "＋ New"), radius 8px; hover `--accent-hover`; active `--accent-active`; focus ring; đây là nút nổi bật nhất app |
| Divider | 1px `--border-subtle`, margin 8px 12px |

### Thẻ project (card)

Padding 8px 12px, radius 8px, margin 0 8px + 4px giữa các thẻ (không dùng border-bottom kiểu list cũ). 3 hàng, mỗi hàng 8px 0:

- **Hàng 1**: tên project 13px/600 `--text-primary` (truncate) — thời gian tương đối 11px/400 `--text-muted` đẩy phải.
- **Hàng 2**: `muse_id` 11px mono/500 `--text-secondary` (format `@muse_design`) — tag chips 3 màu — badge unread đẩy phải.
- **Hàng 3**: preview tin cuối 12px/400 `--text-muted` 1 dòng truncate; prefix vai trò: "Bạn: " (weight 500 `--text-secondary`) hoặc "Muse: "; nếu tin cuối chỉ chứa link Dropbox thì preview dạng "⬇ tên_file · Dropbox".

| Trạng thái | Spec |
|---|---|
| Thường | bg trong suốt (trên `--bg-panel`) |
| Hover | bg `--bg-hover`, transition `--dur-fast` |
| Selected | bg `--bg-selected` + `box-shadow: inset 2px 0 0 var(--accent)` (thanh accent 2px mép trái kiểu IDE) + `--shadow-sm` |
| Focus bàn phím | `:focus-visible` outline chuẩn |

### Chip tag (display-only, 3 màu cố định)

```
 ● chat          ● image         ● video
```

- Inline-flex, gap 4px; chip: padding 2px 8px, radius `999px`, border 1px màu `--chip-*-bd`, bg `--chip-*-bg`, chữ 10px/600 UPPERCASE letter-spacing 0.04em màu `--chip-*-fg`, dot tròn 6px màu `--chip-*-fg` trước chữ.
- Không hover, `cursor: default`. Thứ tự chip luôn: chat → image → video.
- Quá 3 chip không tồn tại (chỉ 3 loại) — không cần "+n".

### Badge unread

- Pill: min-width 18px, height 18px, padding 0 6px, radius 999, bg `--accent`, chữ 10px/700 `--text-on-accent`; >99 hiển thị "99+". Chỉ render khi unread > 0.

### Thời gian tương đối (vi-VN)

`bây giờ` (<1 phút) → `N phút` (<60) → `N giờ` (<24) → `N ngày` (<7) → `dd/mm` (còn lại; thêm `yyyy` nếu khác năm). Tooltip title = thời gian đầy đủ "14:03 · 16/11/2026".

### Menu ⋮ per project

Nút icon-btn ghost 24px (chỉ hiện khi hover thẻ, luôn hiện trên thẻ selected — chi tiết polish chống rối). Mở dropdown:

```
        ┌──────────────────┐
        │  Token           │   13px/500 --text-primary, item cao 32px,
        │  Xóa Muse (đỏ)   │   hover bg --bg-hover; "Xóa Muse" màu --danger-text
        └──────────────────┘   bg --bg-surface, radius 10px, border --border-strong,
                               shadow --shadow-md, min-width 160px, padding 4px
```

Item "Xóa Muse" hover: bg `--danger-bg`. Dropdown đặt z `--z-dropdown`; đóng khi click ngoài hoặc Esc.

## B.2 Header project (52px)

```
┌── HEADER ────────────────────────────────────────────────────────────────────────┐
│  Muse Thiết kế   @muse_design   ●chat ●image      [ ▾ Thread chính ] [＋ Thread mới] [⋮] │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- Cao `--header-h` 52px, flex align center, padding 0 16px, gap 8px, bg `--bg-panel`, border-bottom 1px `--border-default`.
- Tên project 14px/600 `--text-primary` (truncate, max-width ~30%); `muse_id` 11px mono `--text-muted`; chips giống B.1.
- Cụm phải (margin-left auto, gap 8px):
  - **Dropdown thread**: nút giống secondary (cao 30px, radius 8, border `--border-default`, text 12px/500 `--text-secondary`, chevron ▾ 10px `--text-muted`); label = tiêu đề thread hiện tại (truncate max-width 180px). Menu: bg `--bg-surface`, radius 10, border `--border-strong`, `--shadow-md`, max-height 280px scroll, item 32px/12.5px `--text-primary` truncate, item đang mở có dấu ✓ `--accent-text` đầu dòng; hover bg `--bg-hover`.
  - **＋ Thread mới**: nút secondary (literal "Thread mới" và ký tự ＋), cao 30px.
  - **⋮**: icon-btn ghost 28px → dropdown giống B.1 (Token / Xóa Muse).
- Khi chưa chọn project: header vẫn render nhưng nội dung mờ (`--text-muted`, "Muse Relay") hoặc ẩn cụm phải — không được vỡ layout.

## B.3 Vùng chat

```
┌── VÙNG CHAT (--bg-base, padding 16px 24px, gap 12px, scroll) ─────────────────────┐
│                                                                                   │
│ ┌───────────────────────────────────────────────┐                                 │
│ │ Đã xong. Bản mới nhất mình để Dropbox đây:    │  bubble MUSE (trái)             │
│ │ ┌─────────────────────────────────────────┐   │                                 │
│ │ │ ⬇  banner_nov_final.zip                 │   │  card đính kèm                  │
│ │ │    Dropbox · bấm để tải                 │   │                                 │
│ │ └─────────────────────────────────────────┘   │                                 │
│ │ 14:03                                         │  timestamp --text-muted         │
│ └───────────────────────────────────────────────┘                                 │
│                                                                                   │
│                                 ┌─────────────────────────────────────────────┐   │
│                                 │ Cho mình bản sửa màu ấm hơn nha             │   │
│                                 │                            14:05 · 16/11    │   │
│                                 └─────────────────────────────────────────────┘   │
│                                     bubble USER (phải)                            │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### Bubble

| Thuộc tính | User (phải) | Muse (trái) |
|---|---|---|
| Nền | `--bubble-user` #2f6fed | `--bubble-muse` #243244 |
| Border | không | 1px `--bubble-muse-bd` |
| Chữ | 14px/1.6 `--bubble-user-text` | 14px/1.6 `--bubble-muse-text` |
| Radius | `14px 14px 4px 14px` | `14px 14px 14px 4px` |
| Shadow | `0 1px 2px rgba(47,111,237,0.25)` | không |
| Padding | 10px 14px | 10px 14px |
| Max-width | `min(var(--bubble-max-w), 72%)` | như user |
| Canh | `align-self: flex-end` | `align-self: flex-start` |

- Timestamp trong bubble: 11px/400, margin-top 6px, display block, canh theo bubble (user: phải, `--bubble-user-time`; muse: trái, `--bubble-muse-time`). Format `HH:MM` vi-VN; khi hover bubble → tooltip title đầy đủ `HH:MM · dd/mm/yyyy`.
- Tin mới (realtime/POST thành công) vào với animation fade + translateY(4px), 180ms `--ease-out`.
- Text giữ nguyên xuống dòng: `pre-wrap` + `break-word` (DNA cũ).
- Bubble không có hover state (không tương tác) — `cursor: default`.

### Card đính kèm Dropbox (nội dung bubble, link nhận dạng theo §3)

```
┌─────────────────────────────────────────┐
│ ┌────┐  banner_nov_final.zip            │
│ │ ⬇  │  Dropbox · bấm để tải            │
│ └────┘                                 │
└─────────────────────────────────────────┘
```

- Phần tử `<a target="_blank" rel="noopener">` block, margin-top 8px so với dòng chữ; flex row, gap 10px, padding 8px 12px; max-width 420px; bg `--bg-surface` (trong bubble muse) / `rgba(255,255,255,0.12)` (trong bubble user — trắng mờ trên xanh, không đổi công thức sang màu khác); border 1px `--border-default`; radius `--radius-card` 10px.
- Ô icon: 34×34px, radius 8px, bg `rgba(47,111,237,0.16)`; glyph `⬇` (hoặc SVG download 16px) màu `--accent-text`. Trong bubble user: icon màu `--bubble-user-text`, ô bg `rgba(255,255,255,0.16)`.
- Tên file: 12.5px mono/500 `--text-primary` 1 dòng truncate. Dòng phụ: 11px `--text-muted` "Dropbox · bấm để tải".
- Hover: border `--border-strong` → chuyển `--accent-text` 30%? Đơn giản: border `--accent-text`, bg sáng hơn 4% (`#232d3b` trong muse bubble), transition `--dur-fast`. Không transform.
- Text gốc của tin giữ nguyên hiện bên trên/trong bubble (spec: "render thành card đính kèm (text giữ nguyên)").

### Trạng thái rỗng có ý nghĩa

Ba trạng thái, cùng công thức: căn giữa dọc-ngang, glyph `✦` 28px `--text-muted`, tiêu đề 14px/600 `--text-primary` (margin-top 12px), mô tả 13px/1.6 `--text-secondary` (margin-top 6px, max-width 360px, center).

```
┌── chưa chọn Muse ────────────────┐   ┌── thread trống ───────────────────┐
│                                  │   │                                   │
│               ✦                  │   │                ✦                  │
│        Chưa chọn Muse nào        │   │         Thread còn trống          │
│   Chọn một Muse ở sidebar, hoặc  │   │   Gửi lời chào đầu tiên cho       │
│   bấm ＋ New để tạo Muse đầu     │   │        @muse_design.              │
│         tiên.                    │   │                                   │
└──────────────────────────────────┘   └───────────────────────────────────┘
```

- Sidebar search không ra kết quả: một dòng 12px `--text-muted` center trong list: `Không có Muse nào khớp "…"`.
- Lỗi tải dữ liệu (fetch fail lần đầu): vùng chat hiện block callout `--danger-bg` + icon ⚠ `--danger-text` + nút secondary "Thử lại" — không để màn trắng câm lặng.

## B.4 Composer

```
┌── COMPOSER (--bg-panel, border-top 1px --border-default, padding 12px 16px) ───────┐
│ ┌──────────────────────────────────────────────────────────┐  ┌──────────────┐    │
│ │ Nhập tin nhắn cho Muse…                                  │  │     ➤       │    │
│ └──────────────────────────────────────────────────────────┘  └──────────────┘    │
│                        Enter để gửi · Shift+Enter để xuống dòng                   │
└───────────────────────────────────────────────────────────────────────────────────┘
```

- Khung nhập: wrapper flex 1, bg `--bg-surface`, border 1px `--border-default`, radius 12px, padding 8px 12px; `focus-within`: border `--accent` + `--focus-ring` — glow tinh tế, đúng chất dev-tool.
- Textarea bên trong: bg trong suốt, không border, không resize handle (`resize: none`), 14px/1.5 `--text-primary`, caret `--accent`; **tự giãn**: bắt đầu 1 dòng (cao ~22px text), tăng theo nội dung, trần `--composer-max-h` 160px rồi tự scroll (scrollbar mảnh).
- Nút gửi: 36×36px, radius 8px, bg `--accent`, icon paper-plane SVG 16px `--text-on-accent` (aria-label "Gửi"); hover `--accent-hover`; **disabled khi textarea rỗng hoặc đang POST**: opacity 0.45 + `cursor: not-allowed`; khi đang gửi: icon thay bằng spinner 14px, vẫn disabled.
- Hint: hàng riêng dưới wrapper, canh phải, 11px `--text-muted`, margin-top 6px: `Enter để gửi · Shift+Enter để xuống dòng`. (Chuỗi này là hint gốc của UI cũ — giữ đúng tinh thần.)
- Dải composer nền `--bg-panel`, border-top 1px `--border-default` — phân tách rõ khỏi vùng chat (nâng cấp so với cũ: cũ cùng nền, ranh giới mơ hồ).

## B.5 Wizard New Muse — modal 3 bước

Khung chung modal: width `--modal-w` 560px, max-height 80vh, flex column; bg `--bg-panel`, border 1px `--border-strong`, radius `--radius-modal`, `--shadow-lg`; header (padding 16px 24px, border-bottom `--border-subtle`, title 15px/600 + nút ✕ ghost 28px); body scroll (padding 24px, gap 16px); footer (padding 16px 24px, border-top `--border-subtle`, cụm nút đẩy phải, gap 8px). Backdrop: `--bg-backdrop` + `backdrop-filter: blur(4px)`; mở: fade 240ms + panel scale 0.97→1; Esc đóng (trừ khi đang loading).

### Stepper

```
    ① Thông tin ────────── ② Credentials ────────── ③ Tải cài đặt
```

- Căn giữa header body, margin-bottom 20px. Số bước: vòng tròn 22px, 12px/600.
- Trạng thái: **active** = bg `--accent`, số `--text-on-accent`, nhãn 12px/600 `--text-primary`; **done** = bg `--success-bg`, border 1px `rgba(63,185,80,0.4)`, dấu ✓ `--success-text`, nhãn `--text-secondary`; **upcoming** = bg trong suốt, border 1px `--border-default`, số `--text-muted`, nhãn `--text-muted`.
- Connector giữa 2 vòng: đường 2px radius 999, đã qua = `--accent` (opacity 0.45), chưa = `--border-default`; connector dài ~72px, margin 0 8px, căn giữa dọc.

### Bước 1 — Form thông tin

```
│  ① Thông tin ─────── ② Credentials ─────── ③ Tải cài đặt                        │
│                                                                                  │
│  MUSE ID *                                                                       │
│  ┌──────────────────────────────────────────────┐                                │
│  │ muse_design                                  │                                │
│  └──────────────────────────────────────────────┘                                │
│  ✓ Không trùng — khả dụng                    (hoặc ✕ chỉ cho [a-z0-9_], 3–40 ký tự)│
│                                                                                  │
│  TÊN HIỂN THỊ *                                                                  │
│  [ Muse Thiết kế                                    ]                            │
│                                                                                  │
│  NĂNG LỰC (chọn những gì Muse này làm được)                                      │
│  [✓ CHAT]   [ IMAGE ]   [ VIDEO ]                                                │
│                                                                                  │
│                                                  [ Hủy ]   [ Tiếp tục → ]        │
```

- Label: 12px/600 UPPERCASE letter-spacing 0.02em `--text-secondary`, margin-bottom 6px; dấu * màu `--danger-text`.
- Input value mono 12px cho muse_id; name dùng sans 13px.
- Feedback live dưới ô muse_id, 11.5px, margin-top 6px: hợp lệ + không trùng → `✓ Không trùng — khả dụng` màu `--success-text`; sai regex → `✕ Chỉ [a-z0-9_], dài 3–40 ký tự` màu `--danger-text`; trùng → `✕ muse_id đã tồn tại` màu `--danger-text`; khi check live: `Đang kiểm tra…` màu `--text-muted`. Input lỗi: border `--danger` + ring `rgba(218,54,51,0.25)`.
- Nút "Tiếp tục" disabled tới khi form hợp lệ (muse_id khớp regex + không trùng + name không rỗng; tags có thể rỗng — client mặc định chat).
- **Checkbox tags — dạng toggle-chip**: 3 nhãn chip lớn (padding 6px 12px, 12px/600). Chưa chọn: bg trong suốt, border `--border-default`, chữ `--text-muted`, checkbox vuông 14px rỗng. Chọn: chip dùng đúng màu năng lực (`--chip-*-bg/fg/bd`), checkbox 14px radius 4 bg `--accent` + tick trắng. **Bắt buộc giữ `<input type="checkbox">` thật ẩn bằng kỹ thuật visually-hidden** (QA TASK 7 đếm 3 checkbox chat/image/video).

### Bước 2 — Credentials (sau khi POST tạo thành công)

```
│  ② Credentials — thông tin đăng nhập của Muse                                   │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐    │
│  │  EMAIL       muse_design@muserelay.local                     [ Copy ]    │    │
│  │  ──────────────────────────────────────────────────────────────────      │    │
│  │  PASSWORD    Xk7_fP2m-Qa9Rt4wBz1LcH                          [ Copy ]    │    │
│  └──────────────────────────────────────────────────────────────────────────┘    │
│  ⚠ Lưu ngay — form cài đặt trên máy Muse sẽ hỏi 2 giá trị này. Không gửi qua     │
│    chat và sẽ không hiện lại lần sau.                                            │
│                                                                                  │
│                                                    [ ← Quay lại ]  [ Tiếp tục → ]│
```

- Khung credentials: bg `--bg-surface`, border `--border-default`, radius 10px, padding 12px 16px; mỗi hàng: label 11px/600 UPPERCASE `--text-muted` (cột ~90px) + giá trị mono 13px/500 `--text-primary` (select-all) + nút Copy (secondary nhỏ: padding 4px 10px, 12px/500) đẩy phải.
- Copy feedback: chữ nút → "✓ Đã copy" màu `--success-text` trong 1.2s rồi trở lại "Copy".
- Callout cảnh báo: bg `--warning-bg`, border 1px `rgba(210,153,34,0.4)`, radius 8px, padding 10px 12px; icon ⚠ `--warning-text`; chữ 12.5px/1.5 `--text-primary`.
- **Trạng thái loading khi tạo** (bấm Tiếp tục ở B1): nút "Tiếp tục" → spinner 14px + "Đang tạo…", disabled toàn bộ modal (không Esc, không ✕, stepper khóa); nếu lỗi (401/400…) → toast lỗi + giữ nguyên B1, nút trở lại bình thường.

### Bước 3 — Zip + setup_guide.txt

```
│  ③ Tải bộ cài đặt                                                               │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐    │
│  │ ┌────┐   muse_muse_design_setup.zip                        ┌──────────┐   │    │
│  │ │ ⬇  │   7 file · đóng gói bằng JSZip                      │ Tải zip  │   │    │
│  │ └────┘                                                     └──────────┘   │    │
│  └──────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
│  setup_guide.txt                                                          [Copy] │
│  ┌──────────────────────────────────────────────────────────────────────────┐    │
│  │ # HƯỚNG DẪN CÀI ĐẶT CHO MUSE                                             │    │
│  │ 1. Giải nén tệp zip…                                                     │    │
│  │ (readonly, mono 12px, cao ~220px, scroll)                                │    │
│  └──────────────────────────────────────────────────────────────────────────┘    │
│  ⚠ Gửi tệp zip + toàn bộ nội dung txt này cho Muse. Bộ cài KHÔNG chứa secret nào.│
│                                                             [ Đóng ]             │
```

- Card zip: giống ngôn ngữ card đính kèm B.3 (bg `--bg-surface`, border, radius 10, ô icon ⬇ 34px) + hàng metadata 11px `--text-muted` + nút "Tải zip" primary nhỏ đẩy phải. Khi fetch templates lỗi (mở qua `file://`) → trong card hiện callout danger: "Không đọc được templates — hãy chạy `python -m http.server` trong thư mục web/ rồi mở lại."
- Textarea guide: readonly, mono 12px/1.55, bg `--bg-base`, border `--border-default`, radius 8px, padding 12px, height 220px, scrollbar mảnh, màu `--text-secondary` (nội dung kỹ thuật, không cần sáng ký).
- Header hàng "setup_guide.txt" 12px/600 `--text-secondary` + nút Copy nhỏ.
- Footer B3: nút secondary "Đóng".
- Khi đang đóng gói zip: nút "Tải zip" → spinner + "Đang đóng gói…".

## B.6 Settings — màn đầu (chưa có key trong localStorage)

Full-screen trên `--bg-base`, căn giữa dọc-ngang, card 480px:

```
┌── SETTINGS ───────────────────────────────────────────────────────┐
│                                                                   │
│                          ✦  Muse Relay                            │
│              Kết nối Supabase của bạn để quản lý Muse             │
│                                                                   │
│   ┌───────────────────────────────────────────────────────────┐   │
│   │  SUPABASE_URL                                             │   │
│   │  ┌─────────────────────────────────────────────────────┐  │   │
│   │  │ https://abcdefgh.supabase.co                        │  │   │
│   │  └─────────────────────────────────────────────────────┘  │   │
│   │  ANON_KEY                                                 │   │
│   │  ┌─────────────────────────────────────────────────────┐  │   │
│   │  │ sb_publishable_•••••••••••••••••••••         [👁]   │  │   │
│   │  └─────────────────────────────────────────────────────┘  │   │
│   │  SERVICE_KEY                                              │   │
│   │  ┌─────────────────────────────────────────────────────┐  │   │
│   │  │ sb_secret_••••••••••••••••••••••••           [👁]   │  │   │
│   │  └─────────────────────────────────────────────────────┘  │   │
│   │  ┌─────────────────────────────────────────────────────┐  │   │
│   │  │                  Kiểm tra kết nối                    │  │   │
│   │  └─────────────────────────────────────────────────────┘  │   │
│   │  ✓ Kết nối thành công — đã lưu trên máy này               │   │
│   └───────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────┘
```

- Glyph `✦` 24px `--accent-text`; tên app 16px/600 `--text-primary` center; mô tả 13px `--text-secondary` center, margin-top 6px.
- Card: bg `--bg-panel`, border 1px `--border-default`, radius `--radius-modal`, `--shadow-md`, padding 24px 32px, margin-top 24px so với logo. Màn Settings nằm trong khung chính (thay sidebar+main) hoặc overlay toàn trang — frontend tự chọn, visual không đổi.
- Nhóm field: label 12px/600 UPPERCASE `--text-secondary`, cách input 6px, nhóm cách nhau 16px.
- Input: cao 38px, radius 8px, bg `--bg-surface`, border `--border-default`; URL: chữ mono 12px; 2 key: **`type="password"`** mono 12px + nút mắt (icon-btn ghost 24px trong input, absolute phải 8px) bật/tắt hiển thị. Focus: border `--accent` + `--focus-ring`.
- Nút "Kiểm tra kết nối": primary full-width cao 38px (GIỮ literal). Loading: spinner + "Đang kiểm tra…", disabled.
- Trạng thái kết quả (dòng 12.5px, margin-top 12px, có icon):
  - Thành công: ✓ `--success-text` — "Kết nối thành công — đã lưu trên máy này (localStorage)". Sau ~600ms chuyển thẳng vào app chính (fade 200ms).
  - Thất bại: ✕ `--danger-text` — message lỗi ngắn (VD: "401 — service key không hợp lệ. Kiểm tra lại SERVICE_KEY."); form giữ nguyên giá trị đã nhập, không xóa.

## B.7 Toast / Modal Token / Modal Xóa

### Toast lỗi (mọi lỗi fetch, 401/403 báo ngay)

```
                                            ┌──────────────────────────────┐
                                            │ ⚠ Lỗi gửi tin nhắn        ✕  │
                                            │   503 từ Supabase — thử lại. │
                                            └──────────────────────────────┘
     (góc dưới-phải, cách mép 16px, xếp chồng tối đa 3, gap 8px)
```

- Width 360px, bg `--bg-surface`, border 1px `--border-strong`, border-left 3px `--danger`, radius 10px, `--shadow-md`, padding 10px 12px; flex row gap 10px.
- Icon ⚠ 16px `--danger-text`; hàng 1: tiêu đề 13px/600 `--text-primary`; hàng 2: chi tiết 12px `--text-secondary` (mã HTTP + nguyên nhân ngắn); nút ✕ ghost 20px góc phải.
- Vào: fade + translateY(8px→0) 200ms `--ease-out`; tự tắt sau 5s (hover lên toast = tạm dừng đếm), ra: fade 150ms. Variant info (thành công copy… nếu cần): border-left `--success`, icon ✓ `--success-text`.

### Modal Token

```
┌── TOKEN (420px) ──────────────────────────────────┐
│  Token đăng nhập của Muse                    ✕    │
│  Muse Thiết kế — @muse_design                     │
│                                                   │
│  EMAIL                                            │
│  ┌──────────────────────────────────┐   [ Copy ]  │
│  │ muse_design@muserelay.local      │             │
│  └──────────────────────────────────┘             │
│  SECRET                                           │
│  ┌──────────────────────────────────┐   [ Copy ]  │
│  │ Xk7_fP2m-Qa9Rt4wBz1LcH           │             │
│  └──────────────────────────────────┘             │
│  ⓘ Secret chính là mật khẩu đăng nhập Supabase    │
│    của Muse — chỉ chủ sở hữu nhìn thấy.           │
└───────────────────────────────────────────────────┘
```

- Khung `--modal-sm-w` 420px, công thức modal chung B.5. Value: ô mono 13px bg `--bg-surface` border `--border-default` radius 8px padding 8px 12px (select-all) — nút Copy secondary cạnh phải.
- Đang tải `GET projects?id=eq.X`: 2 hàng skeleton (bg `--bg-hover`, radius 8, cao 34px, animation pulse 1.2s ease-in-out sáng↔tối 2%) + 12px `--text-muted` "Đang tải…".

### Modal Xóa Muse

```
┌── XÓA (420px) ────────────────────────────────────┐
│        ┌────┐                                     │
│        │ ⚠  │   Xóa Muse này?                     │
│        └────┘                                     │
│  Muse Thiết kế (@muse_design) sẽ bị xóa vĩnh      │
│  viễn: account đăng nhập của Muse, project, toàn  │
│  bộ threads và tin nhắn. Không thể hoàn tác.      │
│                                                   │
│                       [ Hủy ]   [ Xóa Muse ]      │
└───────────────────────────────────────────────────┘
```

- Icon ⚠ trong ô tròn 40px bg `--danger-bg`, màu `--danger-text`; tiêu đề 15px/600; body 13px/1.6 `--text-secondary` với tên + muse_id bọc `<strong>` màu `--text-primary`.
- Nút "Xóa Muse": danger solid (bg `--danger`, hover `--danger-hover`, chữ trắng — 4.6:1 đạt AA). Bấm → spinner + "Đang xóa…", modal khóa; xong → toast info "Đã xóa @muse_design" + sidebar cập nhật.
- Nút Hủy secondary. Esc = Hủy.

---

# C. NGUYÊN TẮC POLISH — CHECKLIST QA THẨM MỸ

QA (TASK 12) và owner sẽ soi danh sách này. Mỗi mục là một mốc chụp màn hình phải qua.

## C.1 Cân đối & alignment
- [ ] Mọi padding/margin/gap là bội 4px; không xuất hiện 5/7/10/15px "rơi rác".
- [ ] Thẻ sidebar canh lề trái/right tuyệt đối với nhau (margin 0 8px đồng nhất); text truncate không bao giờ tràn.
- [ ] Header 52px: tên, muse_id, chips, dropdown, nút — tất cả baseline giữa thẳng hàng; cụm phải không dính mép (cách phải 16px).
- [ ] Bubbles: lề trái bubble muse và lề phải bubble user thẳng trục 24px của vùng chat; không bubble nào vượt 72% bề ngang.
- [ ] Timestamp nằm trong bubble, không nhảy layout khi text 1 dòng vs nhiều dòng.
- [ ] Card đính kèm không rộng hơn bubble cha (trừ max-width riêng 420px).
- [ ] Modal: header/body/footer thẳng trục padding 24px; nút footer đẩy phải, không lệch giữa.
- [ ] Không control nào còn dáng native: `button/input/select/textarea/checkbox` đều custom (`appearance: none` nơi cần); không outline mặc định xanh của Chrome; không scrollbar mặc định.

## C.2 Tương phản
- [ ] Bảng contrast A.1 không bị phá: nhất quán `--text-on-accent` trên `--accent`/`--danger`; timestamp user bubble là `#ffffff` đặc (không opacity).
- [ ] Placeholder, hint, timestamp dùng `--text-muted` (đã đạt AA trên mọi nền trong app) — không tự pha màu nhạt hơn.
- [ ] Chip 10px nhưng weight 600 + fg đã tính contrast — không đổi sang màu khác.
- [ ] Focus ring `--focus` nhìn rõ trên cả `--bg-panel` và `--bg-base`.

## C.3 Nhất quán token
- [ ] `grep` trong file CSS (phần `<style>`): không còn hex nào ngoài các giá trị trong `:root` (ngoại lệ duy nhất được phép: `rgba` phái sinh đã liệt kê sẵn trong token block, và `transparent`/`#ffffff` khi đã có token tương ứng thì dùng token).
- [ ] Một màu = một ý nghĩa: xanh dương chỉ cho hành động chính + bubble user + chip chat; xanh lá chỉ chip image + thành công; tím chỉ chip video; đỏ chỉ hủy bỏ/lỗi.
- [ ] Cùng loại nút = cùng chiều cao (primary/secondary 34px, trong header 30px, trong modal theo hàng — chọn 1 chuẩn mỗi ngữ cảnh và giữ nguyên mọi nơi).
- [ ] Radius cùng loại = cùng giá trị mọi nơi (kiểm: thẻ sidebar, input, button, card, modal).
- [ ] Motion cùng loại = cùng duration (hover toàn app đúng 120ms; modal đúng 240ms).

## C.4 Cảm giác dev-tool (ZCode/Codex/Cursor)
- [ ] Mono font xuất hiện đúng chỗ: muse_id, email, password, key, tên file, textarea guide — tạo chất "kỹ thuật" ngay từ first glance.
- [ ] Thanh accent inset 2px trên thẻ selected; scrollbar mảnh 4px visible; caret xanh accent — ba chi tiết nhỏ nhưng là "signature" của chất IDE.
- [ ] Không gradient, không glow lòe loẹt, không icon emoji màu; accent dùng tiết chế: chỉbubble user, nút chính, badge, dot chip, focus.
- [ ] First paint: màn Settings phải "đẹp dùng được" — đây là màn đầu tiên owner thấy; canh giữa hoàn hảo, card có shadow-md.
- [ ] Mọi icon dùng ký tự đều cùng bộ: ＋ ⋮ ▾ ⬇ ✕ ✓ ⚠ ⓘ (không trộn emoji và glyph cùng vai trò).

## C.5 Accessibility (AA tối thiểu)
- [ ] Điều hướng bàn phím: Tab qua sidebar → thẻ → header → composer → gửi; Enter gửi; Esc đóng modal/dropdown; focus quay lại phần tử đã mở modal khi đóng.
- [ ] `:focus-visible` hiện trên mọi control; chuột click không nháy outline.
- [ ] Nút icon-only có `aria-label` ("Gửi", "Menu dự án", "Đóng", "Hiện key", "Copy email", "Copy secret").
- [ ] Modal chặn scroll nền; dropdown thread có max-height + scroll.
- [ ] `prefers-reduced-motion` tắt mọi animation (khai báo ở A.4).

## C.6 Bẫy thường gặp (anti-pattern — QA sẽ bắt)
- [ ] Đổi `--bubble-user-time` thành `rgba(255,255,255,.6)` cho "mềm mắt" → rơi dưới AA. Cấm.
- [ ] Dùng `#58a6ff` (focus) làm màu nút — nhầm lẫn với `--accent`. Cấm trộn 2 xanh khác nhau trong cùng vai trò.
- [ ] Thêm shadow cho sidebar/header (panel phẳng chỉ có border). Cấm.
- [ ] Hoạt ảnh scale/bounce trên hover nút hoặc thẻ. Cấm.
- [ ] Màu chip hardcode ở 2 nơi (sidebar + header) khác nhau → phải render từ cùng 1 hàm class `.chip--chat/.chip--image/.chip--video`.

---

# D. PHỤ LỤC — DNA cũ → nâng cấp (đối chiếu `static/index.html`)

| DNA cũ | Giữ / Nâng cấp |
|---|---|
| `--bg:#0f141a`, `--panel:#171e26`, `--line:#243040`, `--text:#e8eef5`, `--dim:#8b9bb0` | **Giữ nguyên** làm `--bg-base / --bg-panel / --border-default / --text-primary / --text-muted` — nhận diện màu không đổi |
| `--me:#2f6fed`, `--muse:#243244` | **Giữ nguyên** cho bubble user/muse; thêm border `#2c3a4e` cho bubble muse để tách khỏi nền |
| Nền only 1 tầng | **Nâng cấp**: thang elevation 5 bậc (`base→panel→surface→hover→selected`) + 3 mức border |
| Danh sách hội thoại full-bleed, ngăn bằng border-bottom | **Nâng cấp**: thẻ card radius 8px floating, hover nền riêng, selected có thanh accent inset 2px |
| Sidebar 280px, không brand | **Nâng cấp**: 300px + hàng brand `✦ Muse Relay` + nút gear mở Settings |
| Nút ＋ 15px chữ, không nhãn | **Nâng cấp**: ＋ New full-width primary 34px, nhãn rõ |
| Chỉ 1 cấp chữ (14/12/10) không mono | **Nâng cấp**: thang 7 cấp + mono cho muse_id/credential/tên file — chất dev-tool |
| Chat bubble radius 12px đều | **Nâng cấp**: radius 14px, góc ngoài 4px + timestamp đạt AA + halo 1px |
| Không link Dropbox, không tag chips, không badge | **Mới hoàn toàn** theo §8: chip 3 màu, badge unread, card đính kèm ⬇ |
| Không hover/focus/motion, dùng `alert()` | **Nâng cấp**: hover 120ms toàn app, focus ring chuẩn, toast thay alert, modal thay prompt |
| Composer dùng chung nền, nút Gửi chữ | **Nâng cấp**: khung composer riêng focus-within glow, nút gửi icon, hint giữ nguyên |
| Không scrollbar custom, không selection color | **Nâng cấp**: scrollbar mảnh 4px visible, selection accent 45%, caret accent |

**Tự đánh giá cuối**: hệ thống này cho frontend một bảng token đóng (không chỗ tự sáng tạo), 9 nhóm component có ASCII + bảng token, và checklist QA 6 nhóm. Mọi giá trị đều là hex/px/ms cụ thể — không mục nào "chọn sau".

---
**ui-designer** · Muse Relay v2 · 16/11/2026 · Sẵn sàng handoff cho frontend-developer (TASK 5→6→7)
