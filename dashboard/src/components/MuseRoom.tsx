import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMuseThread, sendMessage } from "../lib/api";
import { fmtClock, fmtTime, ownerState, paramsSummary } from "../lib/format";
import type { ActionMode, MessageParams, Muse, ThreadItem } from "../types";
import { Composer } from "./Composer";
import { MessageBubble, ResourceCards, UrlPreviews } from "./MessageBubble";
import { DeleteDialog, MuseManageMenu, RenameDialog, RotateDialog } from "./MuseManage";

interface OptimisticSend {
  tempId: string;
  prompt: string;
  action: ActionMode;
  sentAt: number;
}

const POLL_MS = 10000;

export function MuseRoom(props: {
  muse: Muse;
  onRenamed: (recipient: string, name: string) => void;
  onDeleted: (recipient: string) => void;
}) {
  const { muse } = props;
  const [items, setItems] = useState<ThreadItem[]>([]);
  const [loadError, setLoadError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [pending, setPending] = useState<OptimisticSend[]>([]);
  const [dialog, setDialog] = useState<"rename" | "rotate" | "delete" | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const { items: fresh, error } = await fetchMuseThread(muse.recipient);
    if (error) {
      setLoadError(error);
      return;
    }
    setLoadError("");
    setItems(fresh);
    setUpdatedAt(new Date());
    // drop optimistic bubbles once the real row landed (or they go stale)
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

  // poll + reload on room switch
  useEffect(() => {
    setItems([]);
    setPending([]);
    setUpdatedAt(null);
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // keep the newest message in view (rAF: fonts/content settle after render)
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [items.length, pending.length, muse.recipient]);

  async function handleSend(action: ActionMode, params: MessageParams): Promise<string | null> {
    const { error } = await sendMessage({ recipient: muse.recipient, action, params });
    if (error) return error;
    setPending((cur) => [
      ...cur,
      { tempId: crypto.randomUUID(), prompt: params.prompt ?? "", action, sentAt: Date.now() },
    ]);
    await load();
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

  return (
    <section className="room-pane fade" aria-label={`Phòng ${muse.name}`}>
      <div className="pane-head">
        <h2>{muse.name}</h2>
        <span className="sub">
          {loadError ? `lỗi tải: ${loadError}` : updatedAt ? `cập nhật ${fmtClock(updatedAt)}` : "đang tải…"}
          {" · tự cập nhật 10s"}
        </span>
        <span className="grow" />
        <MuseManageMenu
          onRename={() => setDialog("rename")}
          onRotate={() => setDialog("rotate")}
          onDelete={() => setDialog("delete")}
        />
        <button type="button" className="btn-ghost" onClick={load}>Làm mới</button>
      </div>

      <div className="thread" ref={threadRef} aria-live="polite">
        {items.length === 0 && pending.length === 0 && !loadError && (
          <div className="thread-empty">
            Phòng trống — nhắn tin đầu tiên cho {muse.name} bên dưới.
          </div>
        )}
        {items.map((it) => {
          const st = ownerState(it.message.status, it.message.expires_at, it.message.claim_expires_at);
          const summary = paramsSummary(it.message.action, it.message.params);
          return (
            <div key={it.message.id} className="exchange">
              <MessageBubble
                side="owner"
                state={st}
                failed={st === "failed"}
                timeLabel={fmtTime(it.message.created_at)}
                footer={summary || null}
                statusText={st === "failed" ? null : ownerStatusText(it)}
              >
                <div className="body">{it.message.params.prompt}</div>
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
            <MessageBubble side="owner" state="pending" timeLabel={fmtTime(new Date(o.sentAt).toISOString())}>
              <div className="body">{o.prompt}</div>
            </MessageBubble>
          </div>
        ))}
      </div>

      <Composer
        placeholder={`Nhắn cho ${muse.name}… (Ctrl+Enter để gửi)`}
        onSend={handleSend}
      />

      {dialog === "rename" && (
        <RenameDialog muse={muse} onClose={() => setDialog(null)} onRenamed={props.onRenamed} />
      )}
      {dialog === "rotate" && (
        <RotateDialog muse={muse} onClose={() => setDialog(null)} onRotated={() => undefined} />
      )}
      {dialog === "delete" && (
        <DeleteDialog muse={muse} onClose={() => setDialog(null)} onDeleted={props.onDeleted} />
      )}
    </section>
  );
}

function MuseReply(props: { museName: string; item: ThreadItem }) {
  const { result, message } = props.item;
  const r = result;
  if (!r) return null;
  if (r.status === "failed") {
    return (
      <MessageBubble side="muse" state="failed" failed timeLabel={fmtTime(r.created_at)}>
        <div className="body err">{r.error || "thất bại"}</div>
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
      footer={paths.length > 0 ? `${paths.length} tệp trên Dropbox` : null}
    >
      {text && (
        <>
          <div className="body">{text}</div>
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
