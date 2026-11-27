import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchGroupThread, sendGroupMessage } from "../lib/api";
import { OWNER_DISPLAY_NAME } from "../lib/config";
import { fmtClock, fmtTime, memberDotColor } from "../lib/format";
import type { ActionMode, Group, GroupBubble, GroupMember, MessageParams } from "../types";
import { Composer } from "./Composer";
import { ArrowDownIcon, PanelRightIcon, RefreshIcon } from "./Icons";
import { MarkdownBody } from "./MarkdownBody";
import { MessageBubble, ResourceCards, UrlPreviews } from "./MessageBubble";

const POLL_MS = 10000;

const STATE_TEXT: Record<GroupBubble["state"], string | null> = {
  pending: "đang chờ các Muse nhận việc…",
  processing: "đang được xử lý…",
  done: null,
  failed: null,
};

export function GroupRoom(props: {
  group: Group;
  members: GroupMember[];
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onPathsChange: (paths: string[]) => void;
}) {
  const { group, members, onPathsChange } = props;
  const [bubbles, setBubbles] = useState<GroupBubble[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);

  const threadRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const forceScrollRef = useRef(true);
  const lastPathsKeyRef = useRef("");

  const colorOf = useCallback(
    (name: string) => memberDotColor(members.findIndex((m) => m.name === name)),
    [members],
  );

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
    const { bubbles: fresh, error } = await fetchGroupThread(group.id);
    setLoading(false);
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
    setLoadError("");
    setLoading(true);
    forceScrollRef.current = true;
    isNearBottomRef.current = true;
    setIsNearBottom(true);
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (loading) return;
    if (forceScrollRef.current || isNearBottomRef.current) {
      forceScrollRef.current = false;
      scrollToBottom(false);
    }
  }, [bubbles.length, loading, group.id, scrollToBottom]);

  // Aggregate deduplicated Dropbox paths for InspectorPanel
  const aggregatedPaths = useMemo(() => {
    const seen = new Set<string>();
    for (const b of bubbles) {
      for (const p of b.paths) {
        if (p) seen.add(p);
      }
    }
    return [...seen];
  }, [bubbles]);

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

  async function handleSend(_action: ActionMode, params: MessageParams): Promise<string | null> {
    // Group rooms are chat-only (the server rejects other actions).
    const { error } = await sendGroupMessage({
      groupId: group.id,
      prompt: params.prompt ?? "",
      ownerName: OWNER_DISPLAY_NAME,
    });
    if (error) return error;
    forceScrollRef.current = true;
    await load();
    return null;
  }

  const showSkeleton = loading && bubbles.length === 0 && !loadError;

  return (
    <section className="room-pane fade" aria-label={`Nhóm ${group.name}`}>
      <div className="pane-head">
        <div className="pane-title-group">
          <h2>{group.name}</h2>
          <span className="sub">
            owner khởi xướng · tối đa 12 lượt tự động ·{" "}
            {loadError ? `lỗi tải: ${loadError}` : updatedAt ? `cập nhật ${fmtClock(updatedAt)}` : "đang tải…"}
          </span>
        </div>
        <span className="grow" />
        <div className="pane-actions">
          <button type="button" className="btn-ghost" onClick={load}>
            <RefreshIcon size={14} />
            <span className="hide-xs">Làm mới</span>
          </button>
          <button
            type="button"
            className={`btn-ghost btn-inspector-toggle${props.inspectorOpen ? " active" : ""}`}
            onClick={props.onToggleInspector}
            aria-pressed={props.inspectorOpen}
            title="Đóng/mở chi tiết nhóm"
          >
            <PanelRightIcon size={15} />
            <span className="hide-xs">Chi tiết</span>
          </button>
        </div>
      </div>

      <div className="members-chips">
        {members.map((m, i) => (
          <span key={`${m.group_id}:${m.muse_recipient}`} className="member-chip">
            <i style={{ background: memberDotColor(i) }} />
            {m.name}
          </span>
        ))}
        {members.length === 0 && <span className="hint">Chưa có thành viên</span>}
      </div>

      <div className="thread-wrap">
        <div
          className="thread"
          ref={threadRef}
          onScroll={handleScroll}
          aria-live="polite"
        >
          {showSkeleton && (
            <div className="thread-skeleton" aria-label="Đang tải hội thoại nhóm">
              <div className="skel-bubble owner" />
              <div className="skel-bubble muse" />
              <div className="skel-bubble muse wide" />
            </div>
          )}

          {!loading && bubbles.length === 0 && !loadError && (
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
                dotColor={isOwner ? "var(--color-accent)" : colorOf(b.name)}
                state={b.state}
                failed={failed}
                timeLabel={fmtTime(b.time)}
                copyValue={b.text || undefined}
                statusText={failed ? b.error ?? "thất bại" : STATE_TEXT[b.state]}
              >
                {b.text &&
                  (isOwner ? (
                    <div className="body">{b.text}</div>
                  ) : (
                    <>
                      <MarkdownBody text={b.text} />
                      <UrlPreviews text={b.text} />
                    </>
                  ))}
                {b.paths.length > 0 && <ResourceCards paths={b.paths} />}
                {b.notes && <div className="statusline">{b.notes}</div>}
              </MessageBubble>
            );
          })}
        </div>

        {!isNearBottom && bubbles.length > 0 && (
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
        placeholder={`Nói với nhóm ${group.name}… (Enter gửi, Shift+Enter xuống dòng)`}
        onSend={handleSend}
        mediaModes={false}
      />
    </section>
  );
}
