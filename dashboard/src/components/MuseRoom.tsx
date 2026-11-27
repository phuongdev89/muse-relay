import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchMuseThread, sendMessage } from "../lib/api";
import { fmtClock, fmtTime, ownerState, paramsSummary } from "../lib/format";
import type { ActionMode, MessageParams, Muse, ThreadItem } from "../types";
import { Composer } from "./Composer";
import { ArrowDownIcon, PanelRightIcon, RefreshIcon } from "./Icons";
import { MarkdownBody } from "./MarkdownBody";
import { MessageBubble, ResourceCards, UrlPreviews } from "./MessageBubble";
import { MuseManageMenu } from "./MuseManage";

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
  onOpenAction: (action: "rename" | "rotate" | "delete") => void;
  onPathsChange: (paths: string[]) => void;
  onMessageSent?: () => void;
}) {
  const { muse, onPathsChange } = props;
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

  // Poll + reload on room switch
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
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

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
    if (st === "pending") return "đang chờ Muse nhận việc…";
    if (st === "processing") return `${muse.name} đang xử lý…`;
    if (st === "expired") return "hết hạn chờ — Muse không nhận hoặc không trả kết quả trong 30 phút.";
    return null;
  };

  const showSkeleton = loading && items.length === 0 && pending.length === 0 && !loadError;
  const hasContent = items.length > 0 || pending.length > 0;

  return (
    <section className="room-pane fade" aria-label={`Phòng ${muse.name}`}>
      <div className="pane-head">
        <div className="pane-title-group">
          <h2>{muse.name}</h2>
          <span className="sub">
            {loadError
              ? `lỗi tải: ${loadError}`
              : updatedAt
                ? `cập nhật ${fmtClock(updatedAt)} · tự cập nhật 10s`
                : "đang tải…"}
          </span>
        </div>
        <span className="grow" />
        <div className="pane-actions">
          <MuseManageMenu
            onRename={() => props.onOpenAction("rename")}
            onRotate={() => props.onOpenAction("rotate")}
            onDelete={() => props.onOpenAction("delete")}
          />
          <button type="button" className="btn-ghost" onClick={load}>
            <RefreshIcon size={14} />
            <span className="hide-xs">Làm mới</span>
          </button>
          <button
            type="button"
            className={`btn-ghost btn-inspector-toggle${props.inspectorOpen ? " active" : ""}`}
            onClick={props.onToggleInspector}
            aria-pressed={props.inspectorOpen}
            title="Đóng/mở hồ sơ Muse"
          >
            <PanelRightIcon size={15} />
            <span className="hide-xs">Chi tiết</span>
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
            <div className="thread-skeleton" aria-label="Đang tải hội thoại">
              <div className="skel-bubble owner" />
              <div className="skel-bubble muse" />
              <div className="skel-bubble owner short" />
              <div className="skel-bubble muse wide" />
            </div>
          )}

          {!loading && items.length === 0 && pending.length === 0 && !loadError && (
            <div className="thread-empty">
              Phòng trống — nhắn tin đầu tiên cho {muse.name} bên dưới.
            </div>
          )}

          {items.map((it) => {
            const st = ownerState(it.message.status, it.message.expires_at, it.message.claim_expires_at);
            const summary = paramsSummary(it.message.action, it.message.params);
            const promptText = it.message.params.prompt ?? "";
            return (
              <div key={it.message.id} className="exchange">
                <MessageBubble
                  side="owner"
                  state={st}
                  failed={st === "failed"}
                  timeLabel={fmtTime(it.message.created_at)}
                  copyValue={promptText}
                  footer={summary || null}
                  statusText={st === "failed" ? null : ownerStatusText(it)}
                >
                  <div className="body">{promptText}</div>
                  {st === "failed" && it.result?.error && (
                    <div className="statusline err">{it.result.error}</div>
                  )}
                </MessageBubble>
                {it.result && <MuseReply museName={muse.name} item={it} />}
              </div>
            );
          })}

          {pending.map((o) => (
            <div key={o.tempId} className="exchange">
              <MessageBubble
                side="owner"
                state="pending"
                timeLabel={fmtTime(new Date(o.sentAt).toISOString())}
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
            aria-label="Cuộn xuống tin mới nhất"
          >
            <ArrowDownIcon size={14} />
            <span>Xuống cuối</span>
          </button>
        )}
      </div>

      <Composer
        placeholder={`Nhắn cho ${muse.name}… (Enter gửi, Shift+Enter xuống dòng)`}
        onSend={handleSend}
      />
    </section>
  );
}

function MuseReply(props: { museName: string; item: ThreadItem }) {
  const { result, message } = props.item;
  const r = result;
  if (!r) return null;
  if (r.status === "failed") {
    const errText = r.error || "thất bại";
    return (
      <MessageBubble
        side="muse"
        state="failed"
        failed
        timeLabel={fmtTime(r.created_at)}
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
      timeLabel={`trả lời ${fmtTime(r.created_at)}`}
      copyValue={text || undefined}
      footer={paths.length > 0 ? `${paths.length} tệp trên Dropbox` : null}
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
        <div className="statusline">nhận việc lần {message.attempts}</div>
      )}
    </MessageBubble>
  );
}
