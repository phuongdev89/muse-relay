import { useCallback, useEffect, useRef, useState } from "react";
import { fetchGroupThread, sendGroupMessage } from "../lib/api";
import { OWNER_DISPLAY_NAME } from "../lib/config";
import { fmtClock, fmtTime } from "../lib/format";
import type { ActionMode, Group, GroupBubble, GroupMember, MessageParams } from "../types";
import { Composer } from "./Composer";
import { MessageBubble, ResourceCards } from "./MessageBubble";

const POLL_MS = 10000;

// Stable per-session hue per member for the sender dot.
const MEMBER_HUES = [75, 155, 240, 25, 320, 190, 280];

const STATE_TEXT: Record<GroupBubble["state"], string | null> = {
  pending: "đang chờ các Muse nhận việc…",
  processing: "đang được xử lý…",
  done: null,
  failed: null,
};

export function GroupRoom(props: { group: Group; members: GroupMember[] }) {
  const { group, members } = props;
  const [bubbles, setBubbles] = useState<GroupBubble[]>([]);
  const [loadError, setLoadError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  const hueOf = useCallback(
    (name: string) => {
      const idx = members.findIndex((m) => m.name === name);
      return idx >= 0 ? MEMBER_HUES[idx % MEMBER_HUES.length] : 200;
    },
    [members],
  );

  const load = useCallback(async () => {
    const { bubbles: fresh, error } = await fetchGroupThread(group.id);
    if (error) {
      setLoadError(error);
      return;
    }
    setLoadError("");
    setBubbles(fresh);
    setUpdatedAt(new Date());
  }, [group.id]);

  useEffect(() => {
    setBubbles([]);
    setUpdatedAt(null);
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [bubbles.length, group.id]);

  async function handleSend(_action: ActionMode, params: MessageParams): Promise<string | null> {
    // Group rooms are chat-only (the server rejects other actions).
    const { error } = await sendGroupMessage({
      groupId: group.id,
      prompt: params.prompt ?? "",
      ownerName: OWNER_DISPLAY_NAME,
    });
    if (error) return error;
    await load();
    return null;
  }

  return (
    <section className="room-pane fade" aria-label={`Nhóm ${group.name}`}>
      <div className="pane-head">
        <h2>{group.name}</h2>
        <span className="sub">
          owner khởi xướng · tối đa 12 lượt tự động ·{" "}
          {loadError ? `lỗi tải: ${loadError}` : updatedAt ? `cập nhật ${fmtClock(updatedAt)}` : "đang tải…"}
        </span>
        <span className="grow" />
        <button type="button" className="btn-ghost" onClick={load}>Làm mới</button>
      </div>

      <div className="members-chips">
        {members.map((m, i) => (
          <span key={`${m.group_id}:${m.muse_recipient}`} className="member-chip">
            <i style={{ background: `oklch(70% 0.12 ${MEMBER_HUES[i % MEMBER_HUES.length]})` }} />
            {m.name}
          </span>
        ))}
        {members.length === 0 && <span className="hint">Chưa có thành viên</span>}
      </div>

      <div className="thread" ref={threadRef} aria-live="polite">
        {bubbles.length === 0 && !loadError && (
          <div className="thread-empty">Chưa có hội thoại — nói đầu tiên để bắt đầu.</div>
        )}
        {bubbles.map((b) => {
          const isOwner = b.kind === "owner";
          const failed = b.state === "failed";
          return (
            <MessageBubble
              key={b.batchId}
              side={isOwner ? "owner" : "muse"}
              who={b.name}
              dotColor={isOwner ? "var(--color-accent)" : `oklch(70% 0.12 ${hueOf(b.name)})`}
              state={b.state}
              failed={failed}
              timeLabel={fmtTime(b.time)}
              statusText={failed ? b.error ?? "thất bại" : STATE_TEXT[b.state]}
            >
              {b.text && <div className="body">{b.text}</div>}
              {b.paths.length > 0 && <ResourceCards paths={b.paths} />}
              {b.notes && <div className="statusline">{b.notes}</div>}
              {!b.text && b.paths.length === 0 && (b.state === "pending" || b.state === "processing") && null}
            </MessageBubble>
          );
        })}
      </div>

      <Composer
        placeholder={`Nói với nhóm ${group.name}… (Ctrl+Enter để gửi)`}
        onSend={handleSend}
        mediaModes={false}
      />
    </section>
  );
}
