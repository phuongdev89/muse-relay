import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import {
  getDropboxTempLink,
  getDropboxThumb,
  type DropboxTempLinkResult,
} from "../../lib/api";
import {
  dropboxWebUrl,
  extractUrls,
  fileName,
  isImageUrl,
  resourceKind,
  resourceLabel,
} from "../../lib/dropbox";
import { fmtFileSize } from "../../lib/format";
import { useLang } from "../../lib/i18n";
import type { ReplyToMeta } from "../../types";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileTextIcon,
  LinkIcon,
  PlayIcon,
  PrinterIcon,
  ReplyIcon,
  ResourceKindIcon,
  XIcon,
} from "../common/Icons";
import { copyText, toast } from "../common/ui";
import { previewKindOf, type PdfActions } from "./previewKind";

// video.js + react-markdown are heavy: load the preview renderers only when a
// gallery modal actually opens (keeps the initial chat bundle lean).
const ResourcePreviewBody = lazy(() =>
  import("./ResourcePreview").then((m) => ({ default: m.ResourcePreviewBody })),
);

function PreviewSuspenseFallback() {
  const { t } = useLang();
  return (
    <div className="res-state">
      <span className="res-spinner" aria-hidden="true" />
      <span className="res-state-text">{t("res.loadingPreview")}</span>
    </div>
  );
}

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
  /** verbose notes hidden behind a toggle button in the footer */
  notes?: string | null;
  /** quoted parent message rendered above the bubble body */
  replyTo?: ReplyToMeta | null;
  /** click handler for the Reply button in the footer */
  onReply?: () => void;
  children?: ReactNode;
  /** muted params line under owner bubbles */
  footer?: ReactNode;
  /** optional action row (e.g. Retry button) rendered below the bubble */
  after?: ReactNode;
}

export function MessageBubble(p: BubbleProps) {
  const [copied, setCopied] = useState(false);
  const [verboseOpen, setVerboseOpen] = useState(false);
  const { t } = useLang();

  async function handleCopy() {
    if (!p.copyValue) return;
    const ok = await copyText(p.copyValue, t("msg.copiedContent"));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  }

  const hasNotes = Boolean(p.notes && p.notes.trim().length > 0);

  const copyBtn = p.copyValue ? (
    <button
      type="button"
      className={`bubble-foot-btn bubble-copy${copied ? " copied" : ""}`}
      onClick={handleCopy}
      title={t("msg.copyAria")}
      aria-label={t("msg.copyAria")}
    >
      {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
      <span>{copied ? t("common.copied") : t("common.copy")}</span>
    </button>
  ) : null;

  const replyBtn = p.onReply ? (
    <button
      type="button"
      className="bubble-foot-btn bubble-reply-btn"
      onClick={p.onReply}
      title={t("msg.replyAria")}
      aria-label={t("msg.replyAria")}
    >
      <ReplyIcon size={12} />
      <span>{t("msg.reply")}</span>
    </button>
  ) : null;

  const verboseBtn = hasNotes ? (
    <button
      type="button"
      className={`bubble-foot-btn bubble-verbose-btn${verboseOpen ? " active" : ""}`}
      onClick={() => setVerboseOpen((v) => !v)}
      aria-expanded={verboseOpen}
      title={t("msg.verboseAria")}
      aria-label={t("msg.verboseAria")}
    >
      <FileTextIcon size={12} />
      <span>{t("msg.verbose")}</span>
    </button>
  ) : null;

  const hasFoot = Boolean(p.state || p.timeLabel || copyBtn || replyBtn || verboseBtn);

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
        <div className="bubble-content">
          {p.replyTo && (
            <div className="bubble-reply-quote">
              <span className="bubble-reply-sender">{p.replyTo.sender}</span>
              {p.replyTo.excerpt && (
                <span className="bubble-reply-excerpt">{p.replyTo.excerpt}</span>
              )}
            </div>
          )}
          {p.children}
        </div>
      </div>

      {hasFoot && (
        <div className={`bubble-foot${p.side === "muse" ? " muse-flow" : ""}`}>
          {/* Owner bubbles (right side): actions (copy · reply · verbose)
           * cluster on the LEFT, timestamp + ticks pushed to the RIGHT.
           * Muse bubbles (left side): single flow — status chip → timestamp
           * → actions, per owner layout rule. Clusters wrap internally when
           * the bubble gets too narrow. */}
          {p.side === "muse" ? (
            <>
              <div className="bubble-foot-status">
                {p.state ? <ChipOf state={p.state} /> : null}
                {p.timeLabel && <span className="when">{p.timeLabel}</span>}
              </div>
              <div className="bubble-foot-actions">
                {verboseBtn}
                {copyBtn}
                {replyBtn}
              </div>
            </>
          ) : (
            <>
              <div className="bubble-foot-actions">
                {copyBtn}
                {replyBtn}
                {verboseBtn}
              </div>
              <div className="bubble-foot-status">
                {p.timeLabel && <span className="when">{p.timeLabel}</span>}
                {p.state ? <Ticks state={p.state} /> : null}
              </div>
            </>
          )}
        </div>
      )}

      {verboseOpen && hasNotes && (
        <div className="bubble-verbose-notes">{p.notes}</div>
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

// ---- dropbox resource cards + gallery ---------------------------------------

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

/** Download flow shared by the card button row and the gallery action row. */
function useResourceDownload(path: string, name: string) {
  const { t } = useLang();
  const [downloading, setDownloading] = useState(false);

  const download = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await getDropboxTempLink(path);
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
  }, [path, name, downloading, t]);

  return { downloading, download };
}

// ---- media frame dimensions (kills the 16:9→real-ratio jump) ---------------
// Once an image has loaded once, its natural size is remembered (memory +
// localStorage) so the reserved frame can use the exact aspect ratio on every
// later render instead of the 16:9 default.

const DIMS_STORAGE_KEY = "muse_res_dims_v1";
const DIMS_STORAGE_MAX = 400;
const dimsByPath = new Map<string, { w: number; h: number }>();

// Compact media frames (Telegram-style): the reserved frame never gets taller
// than FRAME_MAX_HEIGHT — portrait media shrinks the frame's width instead of
// growing its height. Values mirror .res-card max-width in app.css.
const CARD_MAX_WIDTH = 384; // 24rem
const FRAME_MAX_HEIGHT = 240;

try {
  const raw = localStorage.getItem(DIMS_STORAGE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw) as Record<string, { w: number; h: number }>;
    for (const [k, v] of Object.entries(parsed)) {
      if (v && typeof v.w === "number" && typeof v.h === "number") dimsByPath.set(k, v);
    }
  }
} catch {
  // corrupt storage — start fresh, writes below recreate it
}

function rememberDims(path: string, d: { w: number; h: number }): void {
  try {
    const raw = localStorage.getItem(DIMS_STORAGE_KEY);
    const obj = raw ? (JSON.parse(raw) as Record<string, { w: number; h: number }>) : {};
    obj[path] = d;
    const keys = Object.keys(obj);
    if (keys.length > DIMS_STORAGE_MAX) {
      for (const k of keys.slice(0, keys.length - DIMS_STORAGE_MAX + 50)) delete obj[k];
    }
    localStorage.setItem(DIMS_STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // quota or privacy mode — in-memory cache still works
  }
}

function ResourceCard({ path, onOpen }: { path: string; onOpen: () => void }) {
  const { lang, t } = useLang();
  const [temp, setTemp] = useState<DropboxTempLinkResult | null>(null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [fullReady, setFullReady] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(
    () => dimsByPath.get(path) ?? null,
  );
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { downloading, download } = useResourceDownload(path, fileName(path));

  useEffect(() => {
    let cancelled = false;
    setTemp(null);
    setThumbUrl(null);
    setFullReady(false);
    setDims(dimsByPath.get(path) ?? null);
    void getDropboxTempLink(path).then((res) => {
      if (!cancelled) setTemp(res);
    });
    void getDropboxThumb(path).then((url) => {
      if (!cancelled) setThumbUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const onFullImageLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalWidth && img.naturalHeight) {
      const d = { w: img.naturalWidth, h: img.naturalHeight };
      dimsByPath.set(path, d);
      rememberDims(path, d);
      setDims(d);
    }
    setFullReady(true);
  };

  const kind = resourceKind(path);
  const name = fileName(path);
  const link = temp?.link ?? null;

  const frameStyle = useMemo(() => {
    if (!dims) return undefined;
    const ratio = dims.w / dims.h;
    const width = Math.min(CARD_MAX_WIDTH, Math.round(FRAME_MAX_HEIGHT * ratio));
    return {
      aspectRatio: `${dims.w} / ${dims.h}`,
      width: `${width}px`,
      maxWidth: "100%",
      marginInline: "auto",
    };
  }, [dims]);

  const hoverPlay = () => {
    const v = videoRef.current;
    if (v) void v.play().catch(() => undefined);
  };
  const hoverReset = () => {
    const v = videoRef.current;
    if (v) {
      v.pause();
      try {
        v.currentTime = 0;
      } catch {
        // metadata not seekable yet — harmless
      }
    }
  };

  return (
    <div className="res-card">
      {(kind === "image" || kind === "video") && (
        <button
          type="button"
          className="res-media-thumb"
          style={frameStyle}
          onClick={onOpen}
          title={name}
          aria-label={t("dropbox.previewModalTitle", { name })}
        >
          {/* Frame always mounts so the card keeps its height while the
           * temp link / thumb / full media are still loading. */}
          <span className="res-media-frame" style={frameStyle}>
            {thumbUrl && (
              <img
                className="res-media-lqip"
                src={thumbUrl}
                alt=""
                aria-hidden="true"
                draggable={false}
              />
            )}
            {kind === "image" && link && (
              <img
                src={link}
                alt={name}
                loading="lazy"
                draggable={false}
                className={fullReady ? "res-media-full" : "res-media-full is-loading"}
                onLoad={onFullImageLoad}
              />
            )}
            {kind === "video" && link && (
              <>
                <video
                  ref={videoRef}
                  src={link}
                  preload="metadata"
                  muted
                  playsInline
                  tabIndex={-1}
                  onMouseEnter={hoverPlay}
                  onMouseLeave={hoverReset}
                />
                <span className="res-play-overlay" aria-hidden="true">
                  <PlayIcon size={20} />
                </span>
              </>
            )}
            {!link && <span className="res-media-skeleton" aria-hidden="true" />}
          </span>
        </button>
      )}

      {link && kind === "audio" && (
        <audio className="res-media-audio" controls preload="metadata" src={link} />
      )}

      <div className="res-card-info">
        <span className="res-name" title={name}>{name}</span>
        <span className="res-kind">
          {resourceLabel(path, lang)}
          {temp?.size != null ? ` · ${fmtFileSize(temp.size, lang)}` : ""}
        </span>
      </div>

      <div className="res-actions">
        <a
          href={dropboxWebUrl(path)}
          target="_blank"
          rel="noreferrer noopener"
          className="btn-quiet res-action-pill"
          title={t("res.openDropbox")}
          aria-label={`${t("res.openDropbox")}: ${name}`}
        >
          <ExternalLinkIcon size={13} />
          <span className="hide-xs">{t("res.openDropbox")}</span>
        </a>
        <button
          type="button"
          className="btn-quiet res-action-pill"
          title={t("res.copyPathTitle")}
          aria-label={t("res.copyPathAria", { name })}
          onClick={() => copyText(path, t("res.copyPathToast"))}
        >
          <CopyIcon size={13} />
          <span className="hide-xs">{t("res.copy")}</span>
        </button>
        <button
          type="button"
          className="btn-quiet res-action-pill"
          disabled={downloading}
          title={t("dropbox.download")}
          aria-label={`${t("dropbox.download")} ${name}`}
          onClick={() => void download()}
        >
          <DownloadIcon size={13} />
          <span className="hide-xs">{downloading ? t("dropbox.downloading") : t("dropbox.download")}</span>
        </button>
      </div>

      {temp?.notConfigured && (
        <div className="res-config-hint">{t("dropbox.notConfiguredHint")}</div>
      )}
    </div>
  );
}

// ---- gallery / lightbox (full-bleed, floating glass chrome) --------------------

const CHROME_HIDE_MS = 2500;
const HINT_HIDE_MS = 4500;

function linkPhaseOf(
  temp: DropboxTempLinkResult | null,
): "loading" | "ready" | "error" | "not-configured" {
  if (!temp) return "loading";
  if (temp.notConfigured) return "not-configured";
  return temp.link ? "ready" : "error";
}

function ResourceGallery({
  paths,
  index,
  onNavigate,
  onClose,
}: {
  paths: string[];
  index: number;
  onNavigate: (idx: number) => void;
  onClose: () => void;
}) {
  const { lang, t } = useLang();
  const [thumbs, setThumbs] = useState<Map<string, DropboxTempLinkResult>>(new Map());
  const [attempt, setAttempt] = useState(0);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [hintVisible, setHintVisible] = useState(true);
  const [ready, setReady] = useState(false);
  const [stalePath, setStalePath] = useState<string | null>(null);
  const printRef = useRef<PdfActions | null>(null);
  const staleActionsRef = useRef<PdfActions | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const chromeTimer = useRef<number | null>(null);

  const total = paths.length;
  const clamped = Math.min(Math.max(index, 0), total - 1);
  const path = paths[clamped];
  const name = fileName(path);
  const previewKind = previewKindOf(path);
  const temp = thumbs.get(path) ?? null;
  const { downloading, download } = useResourceDownload(path, name);

  // Prefetch temp links for every sibling (cached upstream, 30 min TTL) —
  // feeds the filmstrip, the stage, and the header size info. Nav is instant.
  const pathsKey = paths.join("\n");
  useEffect(() => {
    let cancelled = false;
    for (const p of pathsKey.split("\n")) {
      void getDropboxTempLink(p).then((res) => {
        if (!cancelled) setThumbs((prev) => new Map(prev).set(p, res));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [pathsKey, attempt]);

  // Keep the previous media mounted (dimmed) until the new one is displayed —
  // no blank flash while the next temp link / content is fetching.
  const prevPathRef = useRef(path);
  useEffect(() => {
    if (prevPathRef.current !== path) {
      setStalePath(prevPathRef.current);
      setReady(false);
      prevPathRef.current = path;
    }
  }, [path]);
  useEffect(() => {
    if (ready) setStalePath(null);
  }, [ready]);
  const markReady = useCallback(() => setReady(true), []);

  // Escape closes; ←/→ navigate siblings when the message has >1 attachments.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowLeft" && total > 1) {
        onNavigate((clamped - 1 + total) % total);
      } else if (e.key === "ArrowRight" && total > 1) {
        onNavigate((clamped + 1) % total);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [clamped, total, onClose, onNavigate]);

  // Focus the lightbox on open; restore focus to the trigger on close.
  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    rootRef.current?.focus();
    return () => {
      prevFocus?.focus?.();
    };
  }, []);

  // Floating chrome auto-hides after ~2.5s without pointer activity.
  useEffect(() => {
    const wake = () => {
      setChromeVisible(true);
      if (chromeTimer.current != null) window.clearTimeout(chromeTimer.current);
      chromeTimer.current = window.setTimeout(() => setChromeVisible(false), CHROME_HIDE_MS);
    };
    wake();
    const el = rootRef.current;
    el?.addEventListener("mousemove", wake);
    el?.addEventListener("touchstart", wake, { passive: true });
    const hintTimer = window.setTimeout(() => setHintVisible(false), HINT_HIDE_MS);
    return () => {
      el?.removeEventListener("mousemove", wake);
      el?.removeEventListener("touchstart", wake);
      if (chromeTimer.current != null) window.clearTimeout(chromeTimer.current);
      window.clearTimeout(hintTimer);
    };
  }, []);

  // Keep the active filmstrip thumb in view while navigating.
  useEffect(() => {
    const active = stripRef.current?.querySelector<HTMLElement>(".res-thumb.active");
    active?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [clamped, thumbs]);

  const downloadSlot = (
    <button
      type="button"
      className="btn"
      aria-label={downloading ? t("dropbox.downloading") : t("dropbox.download")}
      disabled={downloading}
      onClick={() => void download()}
    >
      <DownloadIcon size={14} />
      <span>{downloading ? t("dropbox.downloading") : t("dropbox.download")}</span>
    </button>
  );

  const renderBody = (bodyPath: string, stale: boolean) => {
    const tt = thumbs.get(bodyPath) ?? null;
    return (
      <ResourcePreviewBody
        key={bodyPath}
        path={bodyPath}
        link={tt?.link ?? null}
        linkPhase={linkPhaseOf(tt)}
        linkError={tt?.error}
        onRetryTempLink={() => setAttempt((a) => a + 1)}
        downloadSlot={downloadSlot}
        pdfActionsRef={stale ? staleActionsRef : printRef}
        sizeHint={tt?.size ?? null}
        onReady={stale ? undefined : markReady}
      />
    );
  };

  const chromeClass = (base: string) => `${base}${chromeVisible ? "" : " is-off"}`;

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className={`res-lightbox${chromeVisible ? "" : " chrome-hidden"}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="res-lightbox-title"
      onClick={(e) => {
        // Backdrop click closes: the lightbox root itself, the decorative
        // vignette, and the stage wrappers (letterbox area around the media).
        // Clicks on the media or any control bubble from deeper children and
        // never match these, so they keep the lightbox open.
        const el = e.target as HTMLElement;
        if (
          e.target === e.currentTarget ||
          el === stageRef.current ||
          el.classList.contains("res-vignette") ||
          el.classList.contains("res-stage-body") ||
          el.classList.contains("res-stage-under") ||
          el.classList.contains("res-stage-over")
        ) {
          onClose();
        }
      }}
    >
      <div className="res-vignette" aria-hidden="true" />

      <header className={chromeClass("res-chrome-top")}>
        <span id="res-lightbox-title" className="res-lightbox-title" title={name}>
          {name}
        </span>
        <span className="res-chrome-sep" aria-hidden="true">·</span>
        <span className="res-lightbox-sub">
          {resourceLabel(path, lang)}
          {temp?.size != null ? ` · ${fmtFileSize(temp.size, lang)}` : ""}
        </span>
        {total > 1 && (
          <span className="res-lightbox-count">
            {clamped + 1} / {total}
          </span>
        )}
        <span className="grow" />
        <button
          type="button"
          className="btn-quiet"
          onClick={onClose}
          aria-label={t("dropbox.closePreview")}
        >
          <XIcon size={16} />
        </button>
      </header>

      <div className="res-stage" ref={stageRef}>
        {total > 1 && (
          <button
            type="button"
            className="res-lightbox-nav res-lightbox-nav-prev"
            onClick={() => onNavigate((clamped - 1 + total) % total)}
            aria-label={t("res.prev")}
            title={t("res.prev")}
          >
            <ChevronLeftIcon size={20} />
          </button>
        )}
        <Suspense fallback={<PreviewSuspenseFallback />}>
          <div className="res-stage-body">
            {stalePath && stalePath !== path && (
              <div className="res-stage-under" aria-hidden="true">
                {renderBody(stalePath, true)}
              </div>
            )}
            <div className="res-stage-over">{renderBody(path, false)}</div>
          </div>
        </Suspense>
        {total > 1 && (
          <button
            type="button"
            className="res-lightbox-nav res-lightbox-nav-next"
            onClick={() => onNavigate((clamped + 1) % total)}
            aria-label={t("res.next")}
            title={t("res.next")}
          >
            <ChevronRightIcon size={20} />
          </button>
        )}
      </div>

      <aside className={chromeClass("res-chrome-actions")}>
        {downloadSlot}
        <a
          href={dropboxWebUrl(path)}
          target="_blank"
          rel="noreferrer noopener"
          className="btn-ghost"
          aria-label={t("res.openDropbox")}
        >
          <ExternalLinkIcon size={14} />
          <span>{t("res.openDropbox")}</span>
        </a>
        {previewKind === "pdf" && (
          <>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => printRef.current?.print()}
              disabled={downloading}
            >
              <PrinterIcon size={14} />
              <span>{t("res.print")}</span>
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => printRef.current?.openInNewTab()}
              title={t("dropbox.openPreview")}
            >
              {t("dropbox.openPreview")}
            </button>
          </>
        )}
      </aside>

      {total > 1 && (
        <div className={chromeClass("res-filmstrip")} ref={stripRef}>
          {paths.map((p, i) => {
            const tt = thumbs.get(p) ?? null;
            const k = previewKindOf(p);
            const thumbLink = tt?.link ?? null;
            return (
              <button
                key={p}
                type="button"
                className={`res-thumb${i === clamped ? " active" : ""}`}
                onClick={() => onNavigate(i)}
                aria-label={fileName(p)}
                aria-current={i === clamped ? "true" : undefined}
                title={fileName(p)}
              >
                {thumbLink && k === "image" ? (
                  <img src={thumbLink} alt="" loading="lazy" draggable={false} />
                ) : thumbLink && k === "video" ? (
                  <video src={thumbLink} preload="metadata" muted playsInline tabIndex={-1} />
                ) : (
                  <span className="res-thumb-chip" aria-hidden="true">
                    <ResourceKindIcon path={p} size={22} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div
        className={`res-hint${hintVisible && chromeVisible ? "" : " is-off"}${total > 1 ? " has-strip" : ""}`}
        aria-hidden="true"
      >
        {t("res.hint")}
      </div>
    </div>
  );
}

export function ResourceCards({ paths }: { paths: string[] }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  if (paths.length === 0) return null;
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  if (uniquePaths.length === 0) return null;
  const activeIdx = openIdx != null && openIdx < uniquePaths.length ? openIdx : null;
  return (
    <>
      <div className="res-list">
        {uniquePaths.map((path, idx) => (
          <ResourceCard key={path} path={path} onOpen={() => setOpenIdx(idx)} />
        ))}
      </div>
      {activeIdx != null && (
        <ResourceGallery
          paths={uniquePaths}
          index={activeIdx}
          onNavigate={setOpenIdx}
          onClose={() => setOpenIdx(null)}
        />
      )}
    </>
  );
}

/** Inline previews for any http(s) links carried in text/notes. */
export function UrlPreviews({ text }: { text: string }) {
  const { t } = useLang();
  const urls = [...new Set(extractUrls(text))];
  if (urls.length === 0) return null;
  return (
    <div className="url-previews">
      {urls.map((u) =>
        isImageUrl(u) ? (
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
