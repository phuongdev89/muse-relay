import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchMuseThread, sendMessage } from "../lib/api";
import { fmtClock, fmtTime, museConnectionInfo, ownerState, paramsSummary } from "../lib/format";
import { useLang } from "../lib/i18n";
import type { ActionMode, MessageParams, Muse, ThreadItem } from "../types";
import { Composer } from "./Composer";
import { ArrowDownIcon, KeyIcon, LockIcon, PanelRightIcon, RefreshIcon, TrashIcon } from "./Icons";
import { MarkdownBody } from "./MarkdownBody";
import { MessageBubble, ResourceCards, UrlPreviews } from "./MessageBubble";
import { MuseManageMenu } from "./MuseManage";
import { Chip } from "./ui";

interface OptimisticSend {
  tempId: string;
  prompt: string;
  action: ActionMode;
  sentAt: number;
}

const POLL_MS = 10000;

export function MuseRoom(props: {
  muse: Muse;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onOpenAction: (action: "rename" | "rotate" | "delete" | "clear") => void;
  onPathsChange: (paths: string[]) => void;
  onMessageSent?: () => void;
  refreshTrigger?: number;
}) {
  const { muse, onPathsChange } = props;
  const { lang, t } = useLang();

  const [items, setItems] = useState<ThreadItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [pending, setPending] = useState<OptimisticSend[]>([]);
  const [isNearBottom, setIsNearBottom] = useState(true);

  const threadRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const forceScrollRef = useRef(true);
  const lastPathsKeyRef = useRef("");

  const scrollToBottom = useCallback((smooth = false) => {
    const el = threadRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: smooth ? "smooth" : "auto",
      });
      isNearBottomRef.current = true;
      setIsNearBottom(true);
    });
  }, []);

  const load = useCallback(async () => {
    const { items: fresh, error } = await fetchMuseThread(muse.recipient);
    setLoading(false);
    if (error) {
      setLoadError(error);
      return;
    }
    setLoadError("");
    setItems(fresh);
    setUpdatedAt(new Date());
    setPending((cur) =>
      cur.filter((o) => {
        const landed = fresh.some(
          (it) =>
            it.message.params.prompt === o.prompt &&
            new Date(it.message.created_at).getTime() >= o.sentAt - 2000,
        );
        const stale = Date.now() - o.sentAt > 30000;
        return !landed && !stale;
      }),
    );
  }, [muse.recipient]);

  // Poll + reload on room switch or explicit clear
  useEffect(() => {
    setItems([]);
    setPending([]);
    setUpdatedAt(null);
    setLoadError("");
    setLoading(true);
    forceScrollRef.current = true;
    isNearBottomRef.current = true;
    setIsNearBottom(true);
    void load();
    const tmr = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(tmr);
  }, [load, props.refreshTrigger]);

  // Smart auto-scroll
  useEffect(() => {
    if (loading) return;
    if (forceScrollRef.current || isNearBottomRef.current) {
      forceScrollRef.current = false;
      scrollToBottom(false);
    }
  }, [items.length, pending.length, loading, muse.recipient, scrollToBottom]);

  // Aggregate deduplicated Dropbox paths for InspectorPanel
  const aggregatedPaths = useMemo(() => {
    const seen = new Set<string>();
    for (const it of items) {
      for (const p of it.result?.output?.dropbox_paths ?? []) {
        if (p) seen.add(p);
      }
    }
    return [...seen];
  }, [items]);

  useEffect(() => {
    const key = aggregatedPaths.join("\n");
    if (key !== lastPathsKeyRef.current) {
      lastPathsKeyRef.current = key;
      onPathsChange(aggregatedPaths);
    }
  }, [aggregatedPaths, onPathsChange]);

  function handleScroll() {
    const el = threadRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    isNearBottomRef.current = near;
    setIsNearBottom(near);
  }

  async function handleSend(action: ActionMode, params: MessageParams): Promise<string | null> {
    const { error } = await sendMessage({ recipient: muse.recipient, action, params });
    if (error) return error;
    forceScrollRef.current = true;
    setPending((cur) => [
      ...cur,
      { tempId: crypto.randomUUID(), prompt: params.prompt ?? "", action, sentAt: Date.now() },
    ]);
    await load();
    props.onMessageSent?.();
    return null;
  }

  const ownerStatusText = (it: ThreadItem): string | null => {
    const st = ownerState(
      it.message.status,
      it.message.expires_at,
      it.message.claim_expires_at,
    );
    if (st === "pending") return t("museRoom.statusPending");
    if (st === "processing") return t("museRoom.statusProcessing", { name: muse.name });
    if (st === "expired") return t("museRoom.statusExpired");
    return null;
  };

  const showSkeleton = loading && items.length === 0 && pending.length === 0 && !loadError;
  const hasContent = items.length > 0 || pending.length > 0;
  const conn = museConnectionInfo(muse, lang);
  const isLocked = !conn.setupDone;

  return (
    <section className="room-pane fade" aria-label={t("museRoom.aria", { name: muse.name })}>
      <div className="pane-head">
        <div className="pane-title-group">
          <div className="pane-title-row">
            <h2>{muse.name}</h2>
            <Chip state={conn.chipClass} label={conn.label} />
          </div>
          <span className="sub">
            {loadError
              ? t("museRoom.loadErr", { err: loadError })
              : updatedAt
                ? `${conn.detail} · ${t("ov.updated", { time: fmtClock(updatedAt, lang) })}`
                : `${conn.detail} · ${t("ov.loading")}`}
          </span>
        </div>
        <span className="grow" />
        <div className="pane-actions">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => props.onOpenAction("clear")}
            title={t("museRoom.clearHistoryTitle")}
            aria-label={t("museRoom.clearHistoryAria")}
          >
            <TrashIcon size={14} />
            <span className="hide-xs">{t("museRoom.clearHistory")}</span>
          </button>
          <MuseManageMenu
            onRename={() => props.onOpenAction("rename")}
            onRotate={() => props.onOpenAction("rotate")}
            onDelete={() => props.onOpenAction("delete")}
          />
          <button
            type="button"
            className="btn-ghost"
            onClick={load}
            title={t("common.refresh")}
            aria-label={t("common.refresh")}
          >
            <RefreshIcon size={14} />
            <span className="hide-xs">{t("common.refresh")}</span>
          </button>
          <button
            type="button"
            className={`btn-ghost btn-inspector-toggle${props.inspectorOpen ? " active" : ""}`}
            onClick={props.onToggleInspector}
            aria-pressed={props.inspectorOpen}
            title={t("museRoom.toggleProfileTitle")}
            aria-label={t("museRoom.toggleProfileTitle")}
          >
            <PanelRightIcon size={15} />
            <span className="hide-xs">{t("common.details")}</span>
          </button>
        </div>
      </div>

      <div className="thread-wrap">
        <div
          className="thread"
          ref={threadRef}
          onScroll={handleScroll}
          aria-live="polite"
        >
          {showSkeleton && (
            <div className="thread-skeleton" aria-label={t("museRoom.loadingAria")}>
              <div className="skel-bubble owner" />
              <div className="skel-bubble muse" />
              <div className="skel-bubble owner short" />
              <div className="skel-bubble muse wide" />
            </div>
          )}

          {!loading && items.length === 0 && pending.length === 0 && !loadError && (
            <div className="thread-empty">
              {t("museRoom.empty", { name: muse.name })}
            </div>
          )}

          {items.map((it) => {
            const st = ownerState(it.message.status, it.message.expires_at, it.message.claim_expires_at);
            const summary = paramsSummary(it.message.action, it.message.params, lang);
            const promptText = it.message.params.prompt ?? "";
            return (
              <div key={it.message.id} className="exchange">
                <MessageBubble
                  side="owner"
                  state={st}
                  failed={st === "failed"}
                  timeLabel={fmtTime(it.message.created_at, lang)}
                  copyValue={promptText}
                  footer={summary || null}
                  statusText={st === "failed" ? null : ownerStatusText(it)}
                >
                  <div className="body">{promptText}</div>
                  {st === "failed" && it.result?.error && (
                    <div className="statusline err">{it.result.error}</div>
                  )}
                </MessageBubble>
                {it.result && <MuseReply item={it} />}
              </div>
            );
          })}

          {pending.map((o) => (
            <div key={o.tempId} className="exchange">
              <MessageBubble
                side="owner"
                state="pending"
                timeLabel={fmtTime(new Date(o.sentAt).toISOString(), lang)}
                copyValue={o.prompt}
              >
                <div className="body">{o.prompt}</div>
              </MessageBubble>
            </div>
          ))}
        </div>

        {!isNearBottom && hasContent && (
          <button
            type="button"
            className="scroll-bottom-btn"
            onClick={() => scrollToBottom(true)}
            aria-label={t("museRoom.scrollBottomAria")}
          >
            <ArrowDownIcon size={14} />
            <span>{t("museRoom.scrollBottom")}</span>
          </button>
        )}
      </div>

      <Composer
        placeholder={
          isLocked
            ? t("museRoom.composerLockedPlaceholder", { name: muse.name })
            : t("museRoom.composerPlaceholder", { name: muse.name })
        }
        onSend={handleSend}
        disabled={isLocked}
        disabledBanner={
          isLocked ? (
            <div className="composer-lock-banner" role="status">
              <LockIcon size={15} className="composer-lock-icon" />
              <span className="composer-lock-text">
                {t("composer.lockText", { name: muse.name })}
              </span>
              <button
                type="button"
                className="btn-ghost btn-sm composer-lock-btn"
                onClick={() => props.onOpenAction("rotate")}
              >
                <KeyIcon size={13} />
                <span>{t("composer.getTokenRotate")}</span>
              </button>
            </div>
          ) : undefined
        }
      />
    </section>
  );
}

function MuseReply(props: { item: ThreadItem }) {
  const { lang, t } = useLang();
  const { result, message } = props.item;
  const r = result;
  if (!r) return null;
  if (r.status === "failed") {
    const errText = r.error || t("api.failed");
    return (
      <MessageBubble
        side="muse"
        state="failed"
        failed
        timeLabel={fmtTime(r.created_at, lang)}
        copyValue={errText}
      >
        <div className="body err">{errText}</div>
        {r.output?.notes && <div className="statusline">{r.output.notes}</div>}
      </MessageBubble>
    );
  }
  const text = r.output?.text ?? "";
  const paths = r.output?.dropbox_paths ?? [];
  return (
    <MessageBubble
      side="muse"
      state="done"
      timeLabel={t("museRoom.replyAt", { time: fmtTime(r.created_at, lang) })}
      copyValue={text || undefined}
      footer={paths.length > 0 ? t("museRoom.dropboxFiles", { count: paths.length }) : null}
    >
      {text && (
        <>
          <MarkdownBody text={text} />
          <UrlPreviews text={text} />
        </>
      )}
      <ResourceCards paths={paths} />
      {r.output?.notes && <div className="statusline">{r.output.notes}</div>}
      {message.attempts > 1 && (
        <div className="statusline">{t("museRoom.attemptNum", { n: message.attempts })}</div>
      )}
    </MessageBubble>
  );
}
