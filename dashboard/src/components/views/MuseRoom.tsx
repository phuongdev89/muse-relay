import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { fetchMuseThread, sendMessage, uploadFileToMuseDropbox } from "../../lib/api";
import {
  MAX_ATTACH_FILES,
  mergeAttachmentFiles,
  stripDropboxInputNote,
} from "../../lib/dropbox";
import { fmtClock, fmtTime, museConnectionInfo, ownerState, paramsSummary } from "../../lib/format";
import { useLang } from "../../lib/i18n";
import type { ActionMode, MessageParams, Muse, ThreadItem } from "../../types";
import { Composer } from "../chat/Composer";
import {
  ArrowDownIcon,
  KeyIcon,
  LockIcon,
  PanelRightIcon,
  PaperclipIcon,
  RefreshIcon,
  TrashIcon,
} from "../common/Icons";
import { MarkdownBody } from "../chat/MarkdownBody";
import { MessageBubble, ResourceCards, UrlPreviews } from "../chat/MessageBubble";
import { capsToAllowedModes } from "../common/CapsPicker";
import { MuseManageMenu } from "../modals/MuseManage";
import { Chip, toast } from "../common/ui";

interface OptimisticSend {
  tempId: string;
  action: ActionMode;
  params: MessageParams;
  prompt: string;
  finalPrompt?: string;
  files: File[];
  sentAt: number;
  status: "sending" | "pending" | "failed";
  uploadingCount?: number;
  error?: string;
  messageId?: string;
}

const POLL_MS = 10000;

export function MuseRoom(props: {
  muse: Muse;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onOpenAction: (action: "edit" | "rotate" | "delete" | "clear") => void;
  onPathsChange: (paths: string[]) => void;
  onMessageSent?: () => void;
  refreshTrigger?: number;
}) {
  const { muse, onPathsChange } = props;
  const { lang, t } = useLang();

  // Direct-channel routing gates: only the action tabs the muse's caps allow.
  const museAllowedModes = useMemo(
    () => capsToAllowedModes(muse),
    [muse.cap_chat, muse.cap_image, muse.cap_video],
  );

  const [items, setItems] = useState<ThreadItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [pending, setPending] = useState<OptimisticSend[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isNearBottom, setIsNearBottom] = useState(true);

  const threadRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const forceScrollRef = useRef(true);
  const lastPathsKeyRef = useRef("");
  const dragDepthRef = useRef(0);
  const recipientRef = useRef(muse.recipient);
  recipientRef.current = muse.recipient;

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
    const targetRecipient = muse.recipient;
    const { items: fresh, error } = await fetchMuseThread(targetRecipient);
    if (recipientRef.current !== targetRecipient) return;
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
        if (o.status === "failed" || o.status === "sending") return true;
        const targetPrompt = o.finalPrompt ?? o.prompt;
        const landed = fresh.some(
          (it) =>
            (o.messageId && it.message.id === o.messageId) ||
            (it.message.params.prompt === targetPrompt &&
              new Date(it.message.created_at).getTime() >= o.sentAt - 2000),
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
    setAttachedFiles([]);
    setIsDragging(false);
    dragDepthRef.current = 0;
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

  // Typing indicator tracking: the processing flip doesn't change items.length,
  // so the effect above never fires on it. Force-scroll when the muse starts
  // typing; when the reply lands (typing ends) keep following while pinned.
  const typingCount = useMemo(
    () =>
      items.filter(
        (it) =>
          !it.result &&
          ownerState(it.message.status, it.message.expires_at, it.message.claim_expires_at) ===
            "processing",
      ).length,
    [items],
  );
  const prevTypingRef = useRef(0);
  useEffect(() => {
    const prev = prevTypingRef.current;
    prevTypingRef.current = typingCount;
    if (typingCount > prev) {
      scrollToBottom(false);
    } else if (typingCount < prev && isNearBottomRef.current) {
      scrollToBottom(false);
    }
  }, [typingCount, scrollToBottom]);

  // Aggregate deduplicated Dropbox paths for InspectorPanel
  const aggregatedPaths = useMemo(() => {
    const seen = new Set<string>();
    for (const it of items) {
      for (const p of it.message.params.reference_dropbox_paths ?? []) {
        if (p) seen.add(p);
      }
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

  async function dispatchOptimisticSend(
    tempId: string,
    targetRecipient: string,
    action: ActionMode,
    params: MessageParams,
    files: File[],
  ) {
    let finalParams: MessageParams = { ...params };
    if (files.length > 0) {
      const uploadedPaths: string[] = [];
      for (const file of files) {
        const res = await uploadFileToMuseDropbox({
          recipient: targetRecipient,
          threadId: params.thread_id,
          file,
        });
        if (res.error || !res.dropbox_path) {
          if (recipientRef.current !== targetRecipient) return;
          setPending((cur) =>
            cur.map((item) =>
              item.tempId === tempId
                ? {
                    ...item,
                    status: "failed",
                    uploadingCount: undefined,
                    error: t("dropbox.uploadErr", {
                      name: file.name,
                      err: res.error ?? t("api.failed"),
                    }),
                  }
                : item,
            ),
          );
          return;
        }
        uploadedPaths.push(res.dropbox_path);
      }

      const existingRefs = finalParams.reference_dropbox_paths ?? [];
      finalParams = {
        ...finalParams,
        reference_dropbox_paths: [...existingRefs, ...uploadedPaths],
      };
    }

    const { data, error } = await sendMessage({
      recipient: targetRecipient,
      action,
      params: finalParams,
    });

    if (recipientRef.current !== targetRecipient) return;

    if (error) {
      setPending((cur) =>
        cur.map((item) =>
          item.tempId === tempId
            ? {
                ...item,
                status: "failed",
                uploadingCount: undefined,
                error,
              }
            : item,
        ),
      );
      return;
    }

    setPending((cur) =>
      cur.map((item) =>
        item.tempId === tempId
          ? {
              ...item,
              status: "pending",
              uploadingCount: undefined,
              error: undefined,
              finalPrompt: finalParams.prompt,
              messageId: data?.message_id,
            }
          : item,
      ),
    );
    await load();
    props.onMessageSent?.();
  }

  function handleSend(action: ActionMode, params: MessageParams, files: File[]) {
    const tempId = crypto.randomUUID();
    const sentAt = Date.now();
    const promptText = params.prompt ?? "";
    forceScrollRef.current = true;
    setPending((cur) => [
      ...cur,
      {
        tempId,
        action,
        params,
        prompt: promptText,
        files,
        sentAt,
        status: "sending",
        uploadingCount: files.length > 0 ? files.length : undefined,
      },
    ]);
    void dispatchOptimisticSend(tempId, muse.recipient, action, params, files);
  }

  function retrySend(tempId: string) {
    const target = pending.find((o) => o.tempId === tempId);
    if (!target || target.status !== "failed") return;
    const retriedAt = Date.now();
    setPending((cur) =>
      cur.map((item) =>
        item.tempId === tempId
          ? {
              ...item,
              sentAt: retriedAt,
              status: "sending",
              error: undefined,
              uploadingCount: item.files.length > 0 ? item.files.length : undefined,
            }
          : item,
      ),
    );
    void dispatchOptimisticSend(
      tempId,
      muse.recipient,
      target.action,
      target.params,
      target.files,
    );
  }

  const ownerStatusText = (it: ThreadItem): string | null => {
    const st = ownerState(
      it.message.status,
      it.message.expires_at,
      it.message.claim_expires_at,
    );
    if (st === "pending") return t("museRoom.statusPending");
    if (st === "expired") return t("museRoom.statusExpired");
    return null;
  };

  const showSkeleton = loading && items.length === 0 && pending.length === 0 && !loadError;
  const hasContent = items.length > 0 || pending.length > 0;
  const conn = museConnectionInfo(muse, lang);
  const isLocked = !conn.setupDone;

  function hasFilePayload(e: DragEvent<HTMLElement>): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes("Files");
  }

  function handleDragEnter(e: DragEvent<HTMLElement>) {
    if (isLocked || !hasFilePayload(e)) return;
    e.preventDefault();
    dragDepthRef.current++;
    setIsDragging(true);
  }

  function handleDragOver(e: DragEvent<HTMLElement>) {
    if (isLocked || !hasFilePayload(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(e: DragEvent<HTMLElement>) {
    if (isLocked) return;
    if (dragDepthRef.current > 0) dragDepthRef.current--;
    if (dragDepthRef.current === 0 || !e.currentTarget.contains(e.relatedTarget as Node | null)) {
      dragDepthRef.current = 0;
      setIsDragging(false);
    }
  }

  function handleDrop(e: DragEvent<HTMLElement>) {
    if (isLocked || !hasFilePayload(e)) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragging(false);
    const dropped = Array.from(e.dataTransfer.files ?? []);
    if (dropped.length === 0) return;
    const { files, rejectedLarge, overflowCount } = mergeAttachmentFiles(
      attachedFiles,
      dropped,
      MAX_ATTACH_FILES,
    );
    setAttachedFiles(files);
    if (rejectedLarge.length > 0) {
      toast(t("composer.fileSizeErr", { name: rejectedLarge[0].name }));
    } else if (overflowCount > 0) {
      toast(t("composer.maxFilesErr", { max: MAX_ATTACH_FILES }));
    }
  }

  return (
    <section
      className="room-pane fade"
      aria-label={t("museRoom.aria", { name: muse.name })}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && !isLocked && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-card">
            <PaperclipIcon size={24} />
            <strong>{t("dropbox.dropTitle")}</strong>
            <span>{t("dropbox.dropSub")}</span>
          </div>
        </div>
      )}

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
            onEdit={() => props.onOpenAction("edit")}
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
            const promptText = stripDropboxInputNote(it.message.params.prompt ?? "");
            const refPaths = it.message.params.reference_dropbox_paths ?? [];
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
                  {refPaths.length > 0 && <ResourceCards paths={refPaths} />}
                  {st === "failed" && it.result?.error && (
                    <div className="statusline err">{it.result.error}</div>
                  )}
                </MessageBubble>
                {!it.result && st === "processing" && (
                  <MessageBubble
                    side="muse"
                    who={muse.name}
                    dotColor="var(--color-busy)"
                    state="processing"
                  >
                    <div
                      className="body typing-dots"
                      role="status"
                      aria-label={t("museRoom.typingAria", { name: muse.name })}
                    >
                      <span />
                      <span />
                      <span />
                    </div>
                  </MessageBubble>
                )}
                {it.result && <MuseReply item={it} />}
              </div>
            );
          })}

          {pending.map((o) => {
            const summary = paramsSummary(o.action, o.params, lang);
            const optStatusText =
              o.status === "sending"
                ? o.uploadingCount
                  ? t("museRoom.uploadingFiles", { count: o.uploadingCount })
                  : t("museRoom.sendingStatus")
                : o.status === "pending"
                  ? t("museRoom.statusPending")
                  : null;
            return (
              <div key={o.tempId} className="exchange">
                <MessageBubble
                  side="owner"
                  state={o.status === "failed" ? "failed" : "pending"}
                  failed={o.status === "failed"}
                  timeLabel={fmtTime(new Date(o.sentAt).toISOString(), lang)}
                  copyValue={o.prompt}
                  footer={summary || null}
                  statusText={optStatusText}
                  after={
                    o.status === "failed" ? (
                      <div className="bubble-retry-row">
                        <button
                          type="button"
                          className="btn-ghost btn-sm bubble-retry-btn"
                          onClick={() => retrySend(o.tempId)}
                        >
                          <RefreshIcon size={12} />
                          <span>{t("common.retry")}</span>
                        </button>
                      </div>
                    ) : undefined
                  }
                >
                  <div className="body">{o.prompt}</div>
                  {o.files.length > 0 && (
                    <div className="statusline">
                      {t("dropbox.attachedFiles", { count: o.files.length })}:{" "}
                      {o.files.map((f) => f.name).join(", ")}
                    </div>
                  )}
                  {o.status === "failed" && o.error && (
                    <div className="statusline err">{o.error}</div>
                  )}
                </MessageBubble>
              </div>
            );
          })}
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
        allowedModes={museAllowedModes}
        allowAttachments={!isLocked}
        files={attachedFiles}
        onFilesChange={setAttachedFiles}
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
