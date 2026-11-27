import type { ReactNode } from "react";
import { resourceIcon, fileName, resourceLabel } from "../lib/dropbox";
import { copyText } from "./ui";

// ---- status ticks (owner-side message states) ------------------------------

export function Ticks({ state }: { state: string }) {
  const stroke = "currentColor";
  if (state === "done") {
    return (
      <svg className="ticks ticks-done" width="17" height="12" viewBox="0 0 20 12" fill="none" aria-label="đã xong">
        <path d="M1 6.5l3.5 3.5L11 2.5" stroke={stroke} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M8.5 6.5L12 10l6.5-7.5" stroke={stroke} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" opacity="0.55" />
      </svg>
    );
  }
  if (state === "failed") {
    return (
      <svg className="ticks ticks-failed" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-label="thất bại">
        <path d="M2 2l8 8M10 2l-8 8" stroke={stroke} strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  }
  if (state === "processing") {
    return <span className="ticks tick-spin" role="status" aria-label="đang xử lý" />;
  }
  if (state === "expired") {
    return (
      <svg className="ticks ticks-expired" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-label="hết hạn">
        <circle cx="6" cy="6" r="4.6" stroke={stroke} strokeWidth="1.4" />
        <path d="M6 3.6V6l1.8 1.2" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg className="ticks ticks-pending" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-label="đã gửi, chờ nhận">
      <circle cx="6" cy="6" r="4.6" stroke={stroke} strokeWidth="1.4" strokeDasharray="2.2 1.8" />
    </svg>
  );
}

// ---- bubble ----------------------------------------------------------------

export interface BubbleProps {
  side: "owner" | "muse";
  /** sender dot color (group rooms); muse 1:1 rooms omit it */
  dotColor?: string;
  who?: string;
  timeLabel?: string;
  /** owner 1:1 → OwnerState · group → BatchState; renders ticks or chip */
  state?: string;
  /** extra status sentence under the body ("đang chờ Muse nhận việc…") */
  statusText?: string | null;
  failed?: boolean;
  children?: ReactNode;
  /** muted params line under owner bubbles */
  footer?: ReactNode;
}

export function MessageBubble(p: BubbleProps) {
  return (
    <div className={`bubble ${p.side}${p.failed ? " failed" : ""}`}>
      <div className="meta">
        {p.who !== undefined && (
          <>
            <i
              className="who-dot"
              style={{ background: p.dotColor ?? "var(--color-accent)" }}
            />
            <span className="who">{p.who}</span>
          </>
        )}
        {p.side === "owner" && p.state ? <Ticks state={p.state} /> : null}
        {p.timeLabel && <span className="when">{p.timeLabel}</span>}
        {p.side === "muse" && p.state ? <ChipOf state={p.state} /> : null}
      </div>
      {p.children}
      {p.footer && <div className="paramsline">{p.footer}</div>}
      {p.statusText && <div className="statusline">{p.statusText}</div>}
    </div>
  );
}

function ChipOf({ state }: { state: string }) {
  const label =
    state === "pending" ? "chờ" : state === "processing" ? "đang viết" : state === "failed" ? "lỗi" : "xong";
  return <span className={`chip ${state}`}>{label}</span>;
}

// ---- dropbox resource preview ----------------------------------------------

export function ResourceCards({ paths }: { paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <div className="res-list">
      {paths.map((path) => (
        <div key={path} className="res-card">
          <span className="res-icon" aria-hidden="true">{resourceIcon(path)}</span>
          <span className="res-info">
            <span className="res-name">{fileName(path)}</span>
            <span className="res-kind">{resourceLabel(path)}</span>
            <code className="res-path">{path}</code>
          </span>
          <button
            type="button"
            className="btn-quiet"
            title="Copy đường dẫn Dropbox"
            onClick={() => copyText(path, "Đã copy đường dẫn")}
          >
            copy
          </button>
        </div>
      ))}
    </div>
  );
}

/** Inline previews for any http(s) links carried in text/notes. */
export function UrlPreviews({ text }: { text: string }) {
  const urls = [...new Set(text.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [])];
  if (urls.length === 0) return null;
  return (
    <div className="url-previews">
      {urls.map((u) =>
        /\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(u) ? (
          <a key={u} href={u} target="_blank" rel="noreferrer" className="url-img">
            <img src={u} alt="preview" loading="lazy" />
          </a>
        ) : (
          <a key={u} href={u} target="_blank" rel="noreferrer" className="url-link">
            🔗 {u.length > 64 ? u.slice(0, 64) + "…" : u}
          </a>
        ),
      )}
    </div>
  );
}
