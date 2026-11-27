import { useEffect, useState, type ReactNode } from "react";
import { getDropboxTempLink, type DropboxTempLinkResult } from "../lib/api";
import { fileName, resourceKind, resourceLabel } from "../lib/dropbox";
import { fmtFileSize } from "../lib/format";
import { useLang } from "../lib/i18n";
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  LinkIcon,
  ResourceKindIcon,
  XIcon,
} from "./Icons";
import { Modal, copyText, toast } from "./ui";

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
  /** extra status sentence under the footer */
  statusText?: string | null;
  failed?: boolean;
  /** text copied when user clicks the hover/focus-within copy action */
  copyValue?: string;
  children?: ReactNode;
  /** muted params line under owner bubbles */
  footer?: ReactNode;
  /** optional action row (e.g. Retry button) rendered below the bubble */
  after?: ReactNode;
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

  const copyBtn = p.copyValue ? (
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
  ) : null;

  const hasFoot = Boolean(p.state || p.timeLabel);

  return (
    <div className={`bubble ${p.side}${p.failed ? " failed" : ""}`}>
      {p.who !== undefined && (
        <div className="meta">
          <i
            className="who-dot"
            style={{ background: p.dotColor ?? "var(--color-accent)" }}
          />
          <span className="who">{p.who}</span>
        </div>
      )}

      <div className="bubble-body-row">
        {p.side === "owner" && copyBtn}
        <div className="bubble-content">{p.children}</div>
        {p.side === "muse" && copyBtn}
      </div>

      {hasFoot && (
        <div className="bubble-foot">
          {p.side === "owner" && p.state ? <Ticks state={p.state} /> : null}
          {p.side === "muse" && p.state ? <ChipOf state={p.state} /> : null}
          {p.timeLabel && <span className="when">{p.timeLabel}</span>}
        </div>
      )}

      {p.footer && <div className="paramsline">{p.footer}</div>}
      {p.statusText && <div className="statusline">{p.statusText}</div>}
      {p.after}
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

// ---- dropbox resource preview & download -----------------------------------

async function triggerFileDownload(url: string, name: string) {
  try {
    const res = await fetch(url);
    if (res.ok) {
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
      return;
    }
  } catch {
    // CORS or network fetch blocked: fall back to direct browser download/tab
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.target = "_blank";
  a.rel = "noreferrer noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function ResourceCard({ path }: { path: string }) {
  const { lang, t } = useLang();
  const [temp, setTemp] = useState<DropboxTempLinkResult | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTemp(null);
    void getDropboxTempLink(path).then((res) => {
      if (!cancelled) setTemp(res);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const kind = resourceKind(path);
  const name = fileName(path);
  const link = temp?.link ?? null;

  async function handleDownload() {
    if (downloading) return;
    setDownloading(true);
    try {
      const res = link ? temp : await getDropboxTempLink(path);
      if (res && !link) setTemp(res);
      if (res?.link) {
        await triggerFileDownload(res.link, name);
      } else if (res?.notConfigured) {
        toast(t("dropbox.notConfiguredErr"));
      } else {
        toast(t("dropbox.downloadErr", { err: res?.error ?? t("api.failed") }));
      }
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="res-card">
      <div className="res-card-top">
        <span className="res-icon" aria-hidden="true">
          <ResourceKindIcon path={path} size={18} />
        </span>
        <span className="res-info">
          <span className="res-name" title={name}>{name}</span>
          <span className="res-kind">
            {resourceLabel(path, lang)}
            {temp?.size != null ? ` · ${fmtFileSize(temp.size, lang)}` : ""}
          </span>
          <code className="res-path">{path}</code>
        </span>
        <div className="res-actions">
          {link && kind !== "image" && kind !== "video" && kind !== "audio" && (
            <a
              href={link}
              target="_blank"
              rel="noreferrer noopener"
              className="btn-quiet res-action-pill"
              title={t("dropbox.openPreview")}
              aria-label={`${t("dropbox.openPreview")} ${name}`}
            >
              <ExternalLinkIcon size={13} />
              <span className="hide-xs">{t("dropbox.openPreview")}</span>
            </a>
          )}
          <button
            type="button"
            className="btn-quiet btn-icon-copy"
            disabled={downloading}
            title={t("dropbox.download")}
            aria-label={`${t("dropbox.download")} ${name}`}
            onClick={() => void handleDownload()}
          >
            <DownloadIcon size={13} />
          </button>
          <button
            type="button"
            className="btn-quiet btn-icon-copy"
            title={t("res.copyPathTitle")}
            aria-label={t("res.copyPathAria", { name })}
            onClick={() => copyText(path, t("res.copyPathToast"))}
          >
            <CopyIcon size={13} />
          </button>
        </div>
      </div>

      {link && kind === "image" && (
        <button
          type="button"
          className="res-media-img-btn"
          onClick={() => setPreviewOpen(true)}
          aria-label={t("dropbox.previewModalTitle", { name })}
        >
          <img src={link} alt={name} loading="lazy" />
        </button>
      )}

      {link && kind === "video" && (
        <video className="res-media-video" controls preload="metadata" src={link} />
      )}

      {link && kind === "audio" && (
        <audio className="res-media-audio" controls preload="metadata" src={link} />
      )}

      {temp?.notConfigured && (
        <div className="res-hint">{t("dropbox.notConfiguredHint")}</div>
      )}

      {previewOpen && link && (
        <Modal
          open
          wide
          onClose={() => setPreviewOpen(false)}
          labelledBy="res-preview-title"
        >
          <div className="res-modal-head">
            <h2 id="res-preview-title" className="res-modal-title">
              {t("dropbox.previewModalTitle", { name })}
            </h2>
            <button
              type="button"
              className="btn-quiet"
              onClick={() => setPreviewOpen(false)}
              aria-label={t("dropbox.closePreview")}
            >
              <XIcon size={16} />
            </button>
          </div>
          <div className="res-modal-body">
            <img src={link} alt={name} className="res-modal-img" />
          </div>
          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={downloading}
              onClick={() => void handleDownload()}
            >
              <DownloadIcon size={14} />
              <span>{downloading ? t("dropbox.downloading") : t("dropbox.download")}</span>
            </button>
            <a
              href={link}
              target="_blank"
              rel="noreferrer noopener"
              className="btn-ghost"
            >
              <ExternalLinkIcon size={14} />
              <span>{t("dropbox.openPreview")}</span>
            </a>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setPreviewOpen(false)}
            >
              {t("dropbox.closePreview")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function ResourceCards({ paths }: { paths: string[] }) {
  if (paths.length === 0) return null;
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  if (uniquePaths.length === 0) return null;
  return (
    <div className="res-list">
      {uniquePaths.map((path) => (
        <ResourceCard key={path} path={path} />
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
