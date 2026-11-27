import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import videojs from "video.js";
import type Player from "video.js/dist/types/player";
import "video.js/dist/video-js.css";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { fileName } from "../../lib/dropbox";
import { useLang } from "../../lib/i18n";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  RefreshIcon,
  ResourceKindIcon,
} from "../common/Icons";
import { copyText } from "../common/ui";
import { previewKindOf, type FetchableKind, type PdfActions } from "./previewKind";

// ---- central content fetch (temp link → blob/text) ---------------------------

/** Text-ish previews above this size show the "too large" placeholder. */
const MAX_TEXT_PREVIEW_BYTES = 5 * 1024 * 1024;

type FetchedState =
  | { stage: "loading" }
  | { stage: "error"; message: string }
  | { stage: "too-large" }
  | { stage: "binary" }
  | { stage: "pdf"; blob: Blob }
  | { stage: "text"; text: string };

function decodeSafe(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Ratio of U+FFFD replacement chars in a UTF-8 decode, probing a boundary-safe prefix. */
function replacementRatio(bytes: Uint8Array): number {
  let end = Math.min(bytes.length, 262144);
  let continuations = 0;
  while (continuations < 4 && end - continuations > 0 && (bytes[end - 1 - continuations] & 0xc0) === 0x80) {
    continuations++;
  }
  if (continuations > 0 && end - continuations > 0) {
    // also drop the lead byte of the split sequence
    end -= continuations + ((bytes[end - 1 - continuations] & 0x80) !== 0 ? 1 : 0);
  }
  const sample = bytes.subarray(0, end);
  if (sample.length === 0) return 0;
  const text = decodeSafe(sample);
  let bad = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0xfffd) bad++;
  }
  return bad / text.length;
}

function looksBinary(bytes: Uint8Array): boolean {
  const probeLen = Math.min(bytes.length, 8192);
  for (let i = 0; i < probeLen; i++) {
    if (bytes[i] === 0) return true; // NUL byte → binary
  }
  return replacementRatio(bytes) > 0.1;
}

function useFetchedPreview(
  link: string,
  kind: FetchableKind,
  sizeHint?: number | null,
) {
  const [state, setState] = useState<FetchedState>({ stage: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ stage: "loading" });
    void (async () => {
      try {
        if (kind !== "pdf" && sizeHint != null && sizeHint > MAX_TEXT_PREVIEW_BYTES) {
          setState({ stage: "too-large" });
          return;
        }
        const res = await fetch(link);
        if (!res.ok) {
          if (!cancelled) setState({ stage: "error", message: `HTTP ${res.status}` });
          return;
        }
        const blob = await res.blob();
        if (cancelled) return;
        if (kind !== "pdf" && blob.size > MAX_TEXT_PREVIEW_BYTES) {
          setState({ stage: "too-large" });
          return;
        }
        if (kind === "pdf") {
          setState({ stage: "pdf", blob });
          return;
        }
        const buf = await blob.arrayBuffer();
        if (cancelled) return;
        const bytes = new Uint8Array(buf);
        if (kind === "binary" && looksBinary(bytes)) {
          setState({ stage: "binary" });
          return;
        }
        setState({ stage: "text", text: decodeSafe(bytes) });
      } catch (err) {
        if (!cancelled) {
          setState({
            stage: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [link, kind, sizeHint, attempt]);

  return { state, retry: () => setAttempt((a) => a + 1) };
}

// ---- shared states -----------------------------------------------------------

function LoadingState() {
  const { t } = useLang();
  return (
    <div className="res-state">
      <span className="res-spinner" aria-hidden="true" />
      <span className="res-state-text">{t("res.loadingPreview")}</span>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message?: string; onRetry: () => void }) {
  const { t } = useLang();
  return (
    <div className="res-state">
      <span className="res-state-text res-state-err">
        {t("common.errorPrefix", { err: message || t("api.failed") })}
      </span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
        <RefreshIcon size={13} />
        <span>{t("common.retry")}</span>
      </button>
    </div>
  );
}

function PlaceholderState({ text, downloadSlot }: { text: string; downloadSlot: ReactNode }) {
  return (
    <div className="res-state">
      <span className="res-state-icon" aria-hidden="true">
        <ResourceKindIcon path="no-preview.bin" size={26} />
      </span>
      <span className="res-state-text">{text}</span>
      {downloadSlot}
    </div>
  );
}

// ---- video.js player (modal) --------------------------------------------------

function VideoJsPlayer({ src, onReady }: { src: string; onReady?: () => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<Player | null>(null);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // video.js dispose() removes the player element from the DOM, so a fresh
    // <video> is created per mount (StrictMode- and navigation-safe).
    const videoEl = document.createElement("video");
    videoEl.className = "video-js";
    container.appendChild(videoEl);

    const player = videojs(videoEl, {
      controls: true,
      fluid: true,
      preload: "auto",
      sources: [{ src }],
    });
    playerRef.current = player;
    player.one("loadeddata", () => onReadyRef.current?.());
    if (player.readyState() >= 2) onReadyRef.current?.();

    return () => {
      playerRef.current = null;
      player.dispose();
    };
  }, [src]);

  return <div data-vjs-player ref={containerRef} className="res-video-shell" />;
}

// ---- zoomable image (click / wheel / drag-pan / double-click) ------------------

const IMG_MAX_ZOOM = 2.5;
const CLICK_TOGGLE_MS = 240;
const PAN_START_PX = 4;

interface ImgTransform {
  s: number;
  x: number;
  y: number;
}

function clampPan(value: number, max: number): number {
  return Math.min(max, Math.max(-max, value));
}

function ZoomableImage({ src, alt, onReady }: { src: string; alt: string; onReady?: () => void }) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [tf, setTf] = useState<ImgTransform>({ s: 1, x: 0, y: 0 });
  const tfRef = useRef<ImgTransform>(tf);
  const clickTimer = useRef<number | null>(null);
  const pan = useRef<{
    id: number;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    moved: boolean;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  });

  // Cached images can finish loading before React attaches onLoad.
  const notifyIfComplete = useCallback(() => {
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth > 0) onReadyRef.current?.();
  }, []);
  useEffect(() => {
    notifyIfComplete();
  }, [notifyIfComplete, src]);

  const commit = useCallback((next: ImgTransform) => {
    tfRef.current = next;
    setTf(next);
  }, []);

  /** Zoom to `nextS` keeping the point under (clientX, clientY) visually fixed. */
  const applyZoomAt = useCallback(
    (clientX: number, clientY: number, nextS: number) => {
      const el = frameRef.current;
      if (!el) return;
      const cur = tfRef.current;
      const rect = el.getBoundingClientRect();
      // rect reflects the current transform — recover the untransformed center
      const centerX = rect.left + rect.width / 2 - cur.x;
      const centerY = rect.top + rect.height / 2 - cur.y;
      const cx = clientX - centerX;
      const cy = clientY - centerY;
      const ratio = nextS / cur.s;
      let x = cx - ratio * (cx - cur.x);
      let y = cy - ratio * (cy - cur.y);
      if (nextS <= 1) {
        x = 0;
        y = 0;
      } else {
        const layoutW = rect.width / cur.s;
        const layoutH = rect.height / cur.s;
        x = clampPan(x, ((nextS - 1) * layoutW) / 2);
        y = clampPan(y, ((nextS - 1) * layoutH) / 2);
      }
      commit({ s: nextS, x, y });
    },
    [commit],
  );

  // Wheel zoom toward the cursor (non-passive so the lightbox never scrolls).
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const next = Math.min(IMG_MAX_ZOOM, Math.max(1, tfRef.current.s * factor));
      applyZoomAt(e.clientX, e.clientY, next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyZoomAt]);

  // Clear any pending single-click toggle when the image goes away.
  useEffect(
    () => () => {
      if (clickTimer.current != null) window.clearTimeout(clickTimer.current);
    },
    [],
  );

  const scheduleToggle = useCallback(
    (clientX: number, clientY: number) => {
      if (clickTimer.current != null) window.clearTimeout(clickTimer.current);
      clickTimer.current = window.setTimeout(() => {
        clickTimer.current = null;
        applyZoomAt(clientX, clientY, tfRef.current.s === 1 ? IMG_MAX_ZOOM : 1);
      }, CLICK_TOGGLE_MS);
    },
    [applyZoomAt],
  );

  return (
    <div
      ref={frameRef}
      className={`res-img-frame${tf.s > 1 ? " is-zoomed" : ""}${dragging ? " is-panning" : ""}`}
      style={{ transform: `translate3d(${tf.x}px, ${tf.y}px, 0) scale(${tf.s})` }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        pan.current = {
          id: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          baseX: tfRef.current.x,
          baseY: tfRef.current.y,
          moved: false,
        };
        if (tfRef.current.s > 1) setDragging(true);
      }}
      onPointerMove={(e) => {
        const p = pan.current;
        const el = frameRef.current;
        if (!p || p.id !== e.pointerId || !el) return;
        const dx = e.clientX - p.startX;
        const dy = e.clientY - p.startY;
        if (!p.moved && Math.hypot(dx, dy) > PAN_START_PX) p.moved = true;
        if (p.moved && tfRef.current.s > 1) {
          const rect = el.getBoundingClientRect();
          const layoutW = rect.width / tfRef.current.s;
          const layoutH = rect.height / tfRef.current.s;
          commit({
            s: tfRef.current.s,
            x: clampPan(p.baseX + dx, ((tfRef.current.s - 1) * layoutW) / 2),
            y: clampPan(p.baseY + dy, ((tfRef.current.s - 1) * layoutH) / 2),
          });
        }
      }}
      onPointerUp={(e) => {
        const p = pan.current;
        pan.current = null;
        setDragging(false);
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // capture already released
        }
        if (p && !p.moved) scheduleToggle(e.clientX, e.clientY);
      }}
      onPointerCancel={() => {
        pan.current = null;
        setDragging(false);
      }}
      onDoubleClick={(e) => {
        if (clickTimer.current != null) {
          window.clearTimeout(clickTimer.current);
          clickTimer.current = null;
        }
        applyZoomAt(e.clientX, e.clientY, tfRef.current.s >= IMG_MAX_ZOOM ? 1 : IMG_MAX_ZOOM);
      }}
    >
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        draggable={false}
        onLoad={() => {
          onReadyRef.current?.();
        }}
      />
    </div>
  );
}

// ---- pdf via blob objectURL ---------------------------------------------------

function PdfViewer({
  blob,
  actionsRef,
}: {
  blob: Blob;
  actionsRef: MutableRefObject<PdfActions | null>;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(blob);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [blob]);

  useEffect(() => {
    if (!blobUrl) return;
    actionsRef.current = {
      print: () => {
        iframeRef.current?.contentWindow?.focus();
        iframeRef.current?.contentWindow?.print();
      },
      openInNewTab: () => {
        const a = document.createElement("a");
        a.href = blobUrl;
        a.target = "_blank";
        document.body.appendChild(a);
        a.click();
        a.remove();
      },
    };
    return () => {
      actionsRef.current = null;
    };
  }, [blobUrl, actionsRef]);

  if (!blobUrl) return <LoadingState />;
  return <iframe ref={iframeRef} className="res-pdf-frame" title="PDF preview" src={blobUrl} />;
}

// ---- markdown (react-markdown + remark-gfm, safe links) -----------------------

const MD_COMPONENTS: Components = {
  a({ node: _node, href, children, ...rest }) {
    const safe = typeof href === "string" && /^https?:\/\//i.test(href) ? href : null;
    if (!safe) return <span {...rest}>{children}</span>;
    return (
      <a {...rest} href={safe} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  img({ node: _node, src, alt, ...rest }) {
    const safe = typeof src === "string" && /^https?:\/\//i.test(src) ? src : null;
    if (!safe) return null;
    return <img {...rest} src={safe} alt={alt ?? ""} loading="lazy" />;
  },
};

function MarkdownView({ text }: { text: string }) {
  return (
    <div className="res-md-preview">
      <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {text}
      </Markdown>
    </div>
  );
}

// ---- collapsible JSON tree (no new dep) ----------------------------------------

const JSON_PATH_SEP = "\u001F";
/** Container nodes at depth ≤ 2 start expanded; deeper ones start collapsed. */
const JSON_DEFAULT_DEPTH = 2;

interface JsonContainer {
  pathKey: string;
  depth: number;
}

function collectJsonContainers(
  value: unknown,
  depth: number,
  pathKey: string,
  out: JsonContainer[],
): void {
  if (value === null || typeof value !== "object") return;
  out.push({ pathKey, depth });
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      collectJsonContainers(item, depth + 1, `${pathKey}${JSON_PATH_SEP}${i}`, out);
    });
  } else {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectJsonContainers(v, depth + 1, `${pathKey}${JSON_PATH_SEP}${k}`, out);
    }
  }
}

function JsonPrimitive({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return <span className="json-v-str">{JSON.stringify(value)}</span>;
  }
  if (typeof value === "number") {
    return <span className="json-v-num">{String(value)}</span>;
  }
  if (typeof value === "boolean") {
    return <span className="json-v-bool">{String(value)}</span>;
  }
  return <span className="json-v-null">null</span>;
}

function JsonNode(props: {
  name: string | null;
  value: unknown;
  pathKey: string;
  collapsed: ReadonlySet<string>;
  onToggle: (pathKey: string) => void;
}) {
  const { name, value, pathKey, collapsed, onToggle } = props;

  if (value === null || typeof value !== "object") {
    return (
      <div className="json-line">
        {name !== null && (
          <>
            <span className="json-toggle-spacer" aria-hidden="true" />
            <span className="json-key">&quot;{name}&quot;</span>
            <span className="json-colon">: </span>
          </>
        )}
        <JsonPrimitive value={value} />
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const isCollapsed = collapsed.has(pathKey);
  const count = isArray
    ? value.length
    : Object.keys(value as Record<string, unknown>).length;
  const openBrace = isArray ? "[" : "{";
  const closeBrace = isArray ? "]" : "}";

  if (isCollapsed) {
    return (
      <div className="json-line">
        <button
          type="button"
          className="json-toggle"
          onClick={() => onToggle(pathKey)}
          aria-expanded={false}
          aria-label={name ?? "root"}
        >
          <ChevronRightIcon size={12} />
        </button>
        {name !== null && (
          <>
            <span className="json-key">&quot;{name}&quot;</span>
            <span className="json-colon">: </span>
          </>
        )}
        <span className="json-brace">{openBrace}</span>
        <span className="json-summary">{count}</span>
        <span className="json-brace">{closeBrace}</span>
      </div>
    );
  }

  const entries: [string, unknown][] = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(value as Record<string, unknown>);

  return (
    <div className="json-node">
      <div className="json-line">
        <button
          type="button"
          className="json-toggle"
          onClick={() => onToggle(pathKey)}
          aria-expanded={true}
          aria-label={name ?? "root"}
        >
          <ChevronDownIcon size={12} />
        </button>
        {name !== null && (
          <>
            <span className="json-key">&quot;{name}&quot;</span>
            <span className="json-colon">: </span>
          </>
        )}
        <span className="json-brace">{openBrace}</span>
      </div>
      <div className="json-children">
        {entries.map(([k, v]) => (
          <JsonNode
            key={k}
            name={isArray ? null : k}
            value={v}
            pathKey={`${pathKey}${JSON_PATH_SEP}${k}`}
            collapsed={collapsed}
            onToggle={onToggle}
          />
        ))}
      </div>
      <div className="json-line json-close">
        <span className="json-toggle-spacer" aria-hidden="true" />
        <span className="json-brace">{closeBrace}</span>
      </div>
    </div>
  );
}

function JsonView({ text }: { text: string }) {
  const { t } = useLang();
  const parsed = useMemo<{ ok: true; data: unknown } | { ok: false }>(() => {
    try {
      return { ok: true, data: JSON.parse(text) as unknown };
    } catch {
      return { ok: false };
    }
  }, [text]);

  const allContainers = useMemo(() => {
    const out: JsonContainer[] = [];
    if (parsed.ok) collectJsonContainers(parsed.data, 0, "root", out);
    return out;
  }, [parsed]);

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    return new Set(
      allContainers
        .filter((c) => c.depth >= JSON_DEFAULT_DEPTH + 1)
        .map((c) => c.pathKey),
    );
  });

  const onToggle = useCallback((pathKey: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(pathKey)) next.delete(pathKey);
      else next.add(pathKey);
      return next;
    });
  }, []);

  if (!parsed.ok) {
    // Not valid JSON → fall back to the raw text view
    return <pre className="res-code-view"><code>{text}</code></pre>;
  }

  return (
    <div className="res-json">
      <div className="res-json-toolbar">
        <button
          type="button"
          className="btn-quiet"
          onClick={() => setCollapsed(new Set())}
        >
          {t("res.expandAll")}
        </button>
        <button
          type="button"
          className="btn-quiet"
          onClick={() => setCollapsed(new Set(allContainers.map((c) => c.pathKey)))}
        >
          {t("res.collapseAll")}
        </button>
        <span className="grow" />
        <button
          type="button"
          className="btn-quiet"
          onClick={() => void copyText(JSON.stringify(parsed.data, null, 2), t("common.copied"))}
        >
          {t("res.copyJson")}
        </button>
      </div>
      <div className="res-json-tree">
        <JsonNode
          name={null}
          value={parsed.data}
          pathKey="root"
          collapsed={collapsed}
          onToggle={onToggle}
        />
      </div>
    </div>
  );
}

// ---- public entry: modal body per kind -----------------------------------------

export interface ResourcePreviewBodyProps {
  path: string;
  /** Temp link for the resource; null while still fetching. */
  link: string | null;
  linkPhase: "loading" | "ready" | "error" | "not-configured";
  linkError?: string;
  /** Re-fetch the temp link (retry). */
  onRetryTempLink: () => void;
  /** Ready-made download button shown by the too-large / no-preview placeholders. */
  downloadSlot: ReactNode;
  /** Print / open-in-new-tab hooks populated when a PDF is mounted. */
  pdfActionsRef: MutableRefObject<PdfActions | null>;
  /** Known file size from the temp-link response, for the 5 MB text guard. */
  sizeHint?: number | null;
  /** Fires once the body's content is actually displayed (or terminally failed). */
  onReady?: () => void;
}

export function ResourcePreviewBody(p: ResourcePreviewBodyProps) {
  const { t } = useLang();
  const kind = previewKindOf(p.path);
  const onReadyRef = useRef(p.onReady);
  useEffect(() => {
    onReadyRef.current = p.onReady;
  });

  // Terminal link states mean no more fetching will happen — release the
  // gallery's "keep previous media visible" layer.
  const linkTerminal = p.linkPhase === "not-configured" || p.linkPhase === "error";
  useEffect(() => {
    if (linkTerminal) onReadyRef.current?.();
  }, [linkTerminal]);

  if (p.linkPhase === "not-configured") {
    return (
      <div className="res-state">
        <span className="res-state-icon" aria-hidden="true">
          <ResourceKindIcon path={p.path} size={26} />
        </span>
        <span className="res-state-text">{t("dropbox.notConfiguredHint")}</span>
      </div>
    );
  }
  if (p.linkPhase === "error") {
    return <ErrorState message={p.linkError} onRetry={p.onRetryTempLink} />;
  }
  if (p.linkPhase === "loading" || !p.link) {
    return <LoadingState />;
  }

  const link = p.link;

  if (kind === "image") {
    return <ZoomableImage src={link} alt={fileName(p.path)} onReady={() => onReadyRef.current?.()} />;
  }
  if (kind === "video") {
    return <VideoJsPlayer src={link} onReady={() => onReadyRef.current?.()} />;
  }
  if (kind === "audio") {
    return (
      <audio
        className="res-lightbox-audio"
        controls
        preload="metadata"
        src={link}
        onCanPlay={() => onReadyRef.current?.()}
        onLoadedMetadata={() => onReadyRef.current?.()}
        onError={() => onReadyRef.current?.()}
      />
    );
  }
  return <FetchedPreview path={p.path} link={link} kind={kind} sizeHint={p.sizeHint ?? null} downloadSlot={p.downloadSlot} pdfActionsRef={p.pdfActionsRef} onReady={() => onReadyRef.current?.()} />;
}

function FetchedPreview(p: {
  path: string;
  link: string;
  kind: FetchableKind;
  sizeHint: number | null;
  downloadSlot: ReactNode;
  pdfActionsRef: MutableRefObject<PdfActions | null>;
  onReady?: () => void;
}) {
  const { t } = useLang();
  const { state, retry } = useFetchedPreview(p.link, p.kind, p.sizeHint);

  const onReadyRef = useRef(p.onReady);
  useEffect(() => {
    onReadyRef.current = p.onReady;
  });
  useEffect(() => {
    if (state.stage !== "loading") onReadyRef.current?.();
  }, [state]);

  switch (state.stage) {
    case "loading":
      return <LoadingState />;
    case "error":
      return <ErrorState message={state.message} onRetry={retry} />;
    case "too-large":
      return (
        <PlaceholderState
          text={t("res.tooLarge")}
          downloadSlot={p.downloadSlot}
        />
      );
    case "binary":
      return (
        <PlaceholderState
          text={t("res.noPreview")}
          downloadSlot={p.downloadSlot}
        />
      );
    case "pdf":
      return <PdfViewer blob={state.blob} actionsRef={p.pdfActionsRef} />;
    case "text":
      if (p.kind === "md") return <MarkdownView text={state.text} />;
      if (p.kind === "json") return <JsonView text={state.text} />;
      return (
        <pre className="res-code-view">
          <code>{state.text}</code>
        </pre>
      );
  }
}
