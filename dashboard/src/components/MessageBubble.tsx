import { useState, type ReactNode } from "react";
import { fileName, resourceLabel } from "../lib/dropbox";
import { useLang } from "../lib/i18n";
import { CheckIcon, CopyIcon, LinkIcon, ResourceKindIcon } from "./Icons";
import { copyText } from "./ui";

// ---- status ticks (owner-side message states) ------------------------------

export function Ticks({ state }: { state: string }) {
  const { t } = useLang();
  const stroke = "currentColor";
  if (state === "done") {
    return (
      <svg className="ticks ticks-done" width="17" height="12" viewBox="0 0 20 12" fill="none" aria-label={t("ticks.done")}>
        <path d="M1 6.5l3.5 3.5L11 2.5" stroke={stroke} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M8.5 6.5L12 10l6.5-7.5" stroke={stroke} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" opacity="0.55" />
      </svg>
    );
  }
  if (state === "failed") {
    return (
      <svg className="ticks ticks-failed" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-label={t("ticks.failed")}>
        <path d="M2 2l8 8M10 2l-8 8" stroke={stroke} strokeWidth="1.75" strokeLinecap="round" />
      </svg>
    );
  }
  if (state === "processing") {
    return <span className="ticks tick-spin" role="status" aria-label={t("ticks.processing")} />;
  }
  if (state === "expired") {
    return (
      <svg className="ticks ticks-expired" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-label={t("ticks.expired")}>
        <circle cx="6" cy="6" r="4.6" stroke={stroke} strokeWidth="1.5" />
        <path d="M6 3.6V6l1.8 1.2" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg className="ticks ticks-pending" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-label={t("ticks.pending")}>
      <circle cx="6" cy="6" r="4.6" stroke={stroke} strokeWidth="1.5" strokeDasharray="2.2 1.8" />
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
  /** extra status sentence under the body */
  statusText?: string | null;
  failed?: boolean;
  /** text copied when user clicks the hover/focus-within copy action */
  copyValue?: string;
  children?: ReactNode;
  /** muted params line under owner bubbles */
  footer?: ReactNode;
}

export function MessageBubble(p: BubbleProps) {
  const [copied, setCopied] = useState(false);
  const { t } = useLang();

  async function handleCopy() {
    if (!p.copyValue) return;
    const ok = await copyText(p.copyValue, t("msg.copiedContent"));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  }

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
        {p.copyValue ? (
          <button
            type="button"
            className={`bubble-copy${copied ? " copied" : ""}`}
            onClick={handleCopy}
            title={t("msg.copyAria")}
            aria-label={t("msg.copyAria")}
          >
            {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
            <span>{copied ? t("common.copied") : t("common.copy")}</span>
          </button>
        ) : null}
      </div>
      {p.children}
      {p.footer && <div className="paramsline">{p.footer}</div>}
      {p.statusText && <div className="statusline">{p.statusText}</div>}
    </div>
  );
}

function ChipOf({ state }: { state: string }) {
  const { t } = useLang();
  const label =
    state === "pending"
      ? t("chip.shortPending")
      : state === "processing"
        ? t("chip.shortWriting")
        : state === "failed"
          ? t("chip.failed")
          : state === "expired"
            ? t("chip.expired")
            : t("chip.done");
  return <span className={`chip ${state}`}>{label}</span>;
}

// ---- dropbox resource preview ----------------------------------------------

export function ResourceCards({ paths }: { paths: string[] }) {
  const { lang, t } = useLang();
  if (paths.length === 0) return null;
  return (
    <div className="res-list">
      {paths.map((path) => (
        <div key={path} className="res-card">
          <span className="res-icon" aria-hidden="true">
            <ResourceKindIcon path={path} size={18} />
          </span>
          <span className="res-info">
            <span className="res-name">{fileName(path)}</span>
            <span className="res-kind">{resourceLabel(path, lang)}</span>
            <code className="res-path">{path}</code>
          </span>
          <button
            type="button"
            className="btn-quiet btn-icon-copy"
            title={t("res.copyPathTitle")}
            aria-label={t("res.copyPathAria", { name: fileName(path) })}
            onClick={() => copyText(path, t("res.copyPathToast"))}
          >
            <CopyIcon size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Inline previews for any http(s) links carried in text/notes. */
export function UrlPreviews({ text }: { text: string }) {
  const { t } = useLang();
  const urls = [...new Set(text.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [])];
  if (urls.length === 0) return null;
  return (
    <div className="url-previews">
      {urls.map((u) =>
        /\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(u) ? (
          <a key={u} href={u} target="_blank" rel="noreferrer noopener" className="url-img">
            <img src={u} alt={t("msg.imgPreviewAlt")} loading="lazy" />
          </a>
        ) : (
          <a key={u} href={u} target="_blank" rel="noreferrer noopener" className="url-link">
            <LinkIcon size={12} />
            <span>{u.length > 64 ? u.slice(0, 64) + "…" : u}</span>
          </a>
        ),
      )}
    </div>
  );
}
