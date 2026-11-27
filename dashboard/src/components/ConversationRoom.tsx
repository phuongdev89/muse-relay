import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  callOpenAIChatCompletion,
  deleteConversation,
  fetchGroupThread,
  fetchMuseThread,
  fetchOpenAIMessages,
  insertOpenAIMessage,
  sendGroupMessage,
  sendMessage,
} from "../lib/api";
import { OWNER_DISPLAY_NAME } from "../lib/config";
import { fmtClock, fmtTime, memberDotColor, ownerState, paramsSummary } from "../lib/format";
import type {
  ActionMode,
  Conversation,
  ConversationMode,
  GroupBubble,
  MessageParams,
  Muse,
  OpenAIAgent,
  OpenAIMessage,
  Project,
  ThreadItem,
} from "../types";
import { Composer } from "./Composer";
import {
  ArrowDownIcon,
  PanelRightIcon,
  RefreshIcon,
  TrashIcon,
} from "./Icons";
import { MarkdownBody } from "./MarkdownBody";
import { MessageBubble, ResourceCards, UrlPreviews } from "./MessageBubble";
import { ErrorMsg, Modal, toast } from "./ui";

const POLL_MS = 10000;

const MODE_LABEL: Record<ConversationMode, string> = {
  muse_single: "1:1 Muse",
  muse_group: "Nhóm Muse",
  openai: "OpenAI",
  mixed: "Hỗn hợp Muse + OpenAI",
};

interface OptimisticMuseSend {
  tempId: string;
  prompt: string;
  sentAt: number;
}

interface InflightOpenAI {
  reqId: string;
  ref: string;
  name: string;
  startedAt: string;
}

interface UnifiedItem {
  id: string;
  sortMs: number;
  side: "owner" | "muse";
  who?: string;
  dotColor?: string;
  timeLabel: string;
  state?: string;
  failed?: boolean;
  statusText?: string | null;
  footer?: string | null;
  copyValue?: string;
  text: string;
  isMarkdown: boolean;
  paths: string[];
  notes: string | null;
  errorText: string | null;
  extraLine?: string | null;
}

export function ConversationRoom(props: {
  project: Project;
  conversation: Conversation;
  muses: Muse[];
  openaiAgents: OpenAIAgent[];
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onPathsChange: (paths: string[]) => void;
  onConversationDeleted: (projectId: string, conversationId: string) => void;
  onMessageSent?: () => void;
}) {
  const { project, conversation, muses, openaiAgents, onPathsChange } = props;

  const [museItems, setMuseItems] = useState<ThreadItem[]>([]);
  const [groupBubbles, setGroupBubbles] = useState<GroupBubble[]>([]);
  const [openaiMsgs, setOpenaiMsgs] = useState<OpenAIMessage[]>([]);
  const [optimisticMuse, setOptimisticMuse] = useState<OptimisticMuseSend[]>([]);
  const [inflightOai, setInflightOai] = useState<InflightOpenAI[]>([]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [delError, setDelError] = useState("");

  const threadRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const forceScrollRef = useRef(true);
  const lastPathsKeyRef = useRef("");

  const museParticipants = useMemo(
    () => conversation.participants.filter((p) => p.kind === "muse"),
    [conversation.participants],
  );
  const openaiParticipants = useMemo(
    () => conversation.participants.filter((p) => p.kind === "openai"),
    [conversation.participants],
  );

  const museByRef = useMemo(() => new Map(muses.map((m) => [m.recipient, m])), [muses]);
  const oaiByRef = useMemo(() => new Map(openaiAgents.map((a) => [a.id, a])), [openaiAgents]);

  const participantColorMap = useMemo(() => {
    const map = new Map<string, string>();
    conversation.participants.forEach((p, idx) => {
      const color = memberDotColor(idx);
      map.set(`${p.kind}:${p.ref}`, color);
      map.set(p.name, color);
      const liveName =
        p.kind === "muse" ? museByRef.get(p.ref)?.name : oaiByRef.get(p.ref)?.name;
      if (liveName) map.set(liveName, color);
    });
    return map;
  }, [conversation.participants, museByRef, oaiByRef]);

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

  const usesSingleMuse =
    conversation.mode === "muse_single" ||
    (conversation.mode === "mixed" && museParticipants.length === 1);
  const usesGroupMuse =
    conversation.mode === "muse_group" ||
    (conversation.mode === "mixed" && museParticipants.length >= 2);
  const usesOpenAI =
    conversation.mode === "openai" || conversation.mode === "mixed";

  const singleMuseRef = usesSingleMuse ? museParticipants[0]?.ref ?? "" : "";
  const singleMuseName =
    (singleMuseRef ? museByRef.get(singleMuseRef)?.name : undefined) ??
    museParticipants[0]?.name ??
    "Muse";

  const load = useCallback(async () => {
    const errs: string[] = [];

    const tasks: Promise<void>[] = [];

    if (usesSingleMuse && singleMuseRef) {
      tasks.push(
        fetchMuseThread(singleMuseRef, conversation.id).then(({ items, error }) => {
          if (error) errs.push(error);
          else {
            setMuseItems(items);
            setOptimisticMuse((cur) =>
              cur.filter((o) => {
                const landed = items.some(
                  (it) =>
                    it.message.params.prompt === o.prompt &&
                    new Date(it.message.created_at).getTime() >= o.sentAt - 2000,
                );
                const stale = Date.now() - o.sentAt > 30000;
                return !landed && !stale;
              }),
            );
          }
        }),
      );
    }

    if (usesGroupMuse && conversation.group_id) {
      tasks.push(
        fetchGroupThread(conversation.group_id).then(({ bubbles, error }) => {
          if (error) errs.push(error);
          else setGroupBubbles(bubbles);
        }),
      );
    }

    if (usesOpenAI) {
      tasks.push(
        fetchOpenAIMessages(conversation.id).then(({ data, error }) => {
          if (error) errs.push(error);
          else setOpenaiMsgs(data);
        }),
      );
    }

    await Promise.all(tasks);
    setLoading(false);
    setLoadError(errs.join(" · "));
    setUpdatedAt(new Date());
  }, [conversation.id, conversation.group_id, singleMuseRef, usesGroupMuse, usesOpenAI, usesSingleMuse]);

  useEffect(() => {
    setMuseItems([]);
    setGroupBubbles([]);
    setOpenaiMsgs([]);
    setOptimisticMuse([]);
    setInflightOai([]);
    setUpdatedAt(null);
    setLoadError("");
    setLoading(true);
    forceScrollRef.current = true;
    isNearBottomRef.current = true;
    setIsNearBottom(true);

    void load();
    const shouldPoll = usesSingleMuse || usesGroupMuse;
    if (!shouldPoll) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load, usesSingleMuse, usesGroupMuse]);

  // Build unified chronological items
  const unifiedItems = useMemo<UnifiedItem[]>(() => {
    // Pure single Muse mode
    if (conversation.mode === "muse_single") {
      const list: UnifiedItem[] = [];
      for (const it of museItems) {
        const st = ownerState(
          it.message.status,
          it.message.expires_at,
          it.message.claim_expires_at,
        );
        const promptText = it.message.params.prompt ?? "";
        const statusText =
          st === "pending"
            ? "đang chờ Muse nhận việc…"
            : st === "processing"
              ? `${singleMuseName} đang xử lý…`
              : st === "expired"
                ? "hết hạn chờ — Muse không nhận hoặc không trả kết quả trong 30 phút."
                : null;
        const summary = paramsSummary(it.message.action, it.message.params);

        list.push({
          id: `m-owner-${it.message.id}`,
          sortMs: new Date(it.message.created_at).getTime(),
          side: "owner",
          timeLabel: fmtTime(it.message.created_at),
          state: st,
          failed: st === "failed",
          statusText: st === "failed" ? null : statusText,
          footer: summary || null,
          copyValue: promptText,
          text: promptText,
          isMarkdown: false,
          paths: [],
          notes: null,
          errorText: st === "failed" && it.result?.error ? it.result.error : null,
        });

        if (it.result) {
          if (it.result.status === "failed") {
            const errText = it.result.error || "thất bại";
            list.push({
              id: `m-res-${it.message.id}`,
              sortMs: new Date(it.result.created_at).getTime(),
              side: "muse",
              who: singleMuseName,
              dotColor: participantColorMap.get(`muse:${singleMuseRef}`),
              timeLabel: fmtTime(it.result.created_at),
              state: "failed",
              failed: true,
              copyValue: errText,
              text: "",
              isMarkdown: false,
              paths: [],
              notes: it.result.output?.notes ?? null,
              errorText: errText,
            });
          } else {
            const text = it.result.output?.text ?? "";
            const paths = it.result.output?.dropbox_paths ?? [];
            list.push({
              id: `m-res-${it.message.id}`,
              sortMs: new Date(it.result.created_at).getTime(),
              side: "muse",
              who: singleMuseName,
              dotColor: participantColorMap.get(`muse:${singleMuseRef}`),
              timeLabel: `trả lời ${fmtTime(it.result.created_at)}`,
              state: "done",
              copyValue: text || undefined,
              footer: paths.length > 0 ? `${paths.length} tệp trên Dropbox` : null,
              text,
              isMarkdown: Boolean(text),
              paths,
              notes: it.result.output?.notes ?? null,
              errorText: null,
              extraLine:
                it.message.attempts > 1 ? `nhận việc lần ${it.message.attempts}` : null,
            });
          }
        }
      }

      for (const o of optimisticMuse) {
        list.push({
          id: `opt-${o.tempId}`,
          sortMs: o.sentAt,
          side: "owner",
          timeLabel: fmtTime(new Date(o.sentAt).toISOString()),
          state: "pending",
          copyValue: o.prompt,
          text: o.prompt,
          isMarkdown: false,
          paths: [],
          notes: null,
          errorText: null,
        });
      }
      return list;
    }

    // Pure Muse group mode
    if (conversation.mode === "muse_group") {
      return groupBubbles.map((b) => {
        const isOwner = b.kind === "owner";
        const failed = b.state === "failed";
        const stateText =
          b.state === "pending"
            ? "đang chờ các Muse nhận việc…"
            : b.state === "processing"
              ? "đang được xử lý…"
              : null;
        return {
          id: `grp-${b.batchId}`,
          sortMs: new Date(b.time).getTime(),
          side: isOwner ? "owner" : "muse",
          who: b.name,
          dotColor: isOwner
            ? "var(--color-accent)"
            : participantColorMap.get(b.name) ?? "var(--color-busy)",
          timeLabel: fmtTime(b.time),
          state: b.state,
          failed,
          statusText: failed ? (b.text ? b.error ?? "thất bại" : null) : stateText,
          copyValue: b.text || undefined,
          text: b.text,
          isMarkdown: !isOwner && Boolean(b.text),
          paths: b.paths,
          notes: b.notes,
          errorText: failed && !b.text ? b.error ?? "thất bại" : null,
        };
      });
    }

    // Pure OpenAI or Mixed mode: merge OpenAI messages + Muse stream chronologically
    const merged: UnifiedItem[] = [];
    const matchedMuseOwnerIds = new Set<string>();

    for (const m of openaiMsgs) {
      const mMs = new Date(m.created_at).getTime();
      if (m.role === "owner") {
        let state: string | undefined;
        let failed = false;
        let statusText: string | null = null;
        let errorText: string | null = null;

        if (conversation.mode === "mixed") {
          if (usesSingleMuse) {
            const match = museItems.find(
              (it) =>
                !matchedMuseOwnerIds.has(it.message.id) &&
                (it.message.params.prompt ?? "").trim() === m.content.trim() &&
                Math.abs(new Date(it.message.created_at).getTime() - mMs) <= 20000,
            );
            if (match) {
              matchedMuseOwnerIds.add(match.message.id);
              const st = ownerState(
                match.message.status,
                match.message.expires_at,
                match.message.claim_expires_at,
              );
              state = st;
              failed = st === "failed";
              statusText =
                st === "pending"
                  ? `đang chờ ${singleMuseName} nhận việc…`
                  : st === "processing"
                    ? `${singleMuseName} đang xử lý…`
                    : st === "expired"
                      ? `hết hạn chờ ${singleMuseName}`
                      : null;
              if (st === "failed" && match.result?.error) {
                errorText = match.result.error;
              }
            }
          } else if (usesGroupMuse) {
            const match = groupBubbles.find(
              (b) =>
                b.kind === "owner" &&
                !matchedMuseOwnerIds.has(b.batchId) &&
                b.text.trim() === m.content.trim() &&
                Math.abs(new Date(b.time).getTime() - mMs) <= 20000,
            );
            if (match) {
              matchedMuseOwnerIds.add(match.batchId);
              state = match.state;
              failed = match.state === "failed";
              statusText =
                match.state === "pending"
                  ? "đang chờ các Muse nhận việc…"
                  : match.state === "processing"
                    ? "các Muse đang xử lý…"
                    : match.state === "failed"
                      ? match.error ?? "Muse thất bại"
                      : null;
            }
          }
        }

        merged.push({
          id: `oai-owner-${m.id}`,
          sortMs: mMs,
          side: "owner",
          who: conversation.mode === "mixed" ? m.agent_name : undefined,
          dotColor: "var(--color-accent)",
          timeLabel: fmtTime(m.created_at),
          state,
          failed,
          statusText,
          copyValue: m.content,
          text: m.content,
          isMarkdown: false,
          paths: [],
          notes: null,
          errorText,
        });
      } else {
        const failed = m.status === "failed";
        const errText = failed ? m.error || "lỗi gọi model" : null;
        const liveName = (m.agent_ref ? oaiByRef.get(m.agent_ref)?.name : undefined) ?? m.agent_name;
        merged.push({
          id: `oai-agent-${m.id}`,
          sortMs: mMs,
          side: "muse",
          who: liveName,
          dotColor:
            (m.agent_ref ? participantColorMap.get(`openai:${m.agent_ref}`) : undefined) ??
            participantColorMap.get(m.agent_name) ??
            "var(--color-busy)",
          timeLabel: fmtTime(m.created_at),
          state: failed ? "failed" : "done",
          failed,
          copyValue: failed ? errText ?? undefined : m.content,
          text: failed ? "" : m.content,
          isMarkdown: !failed && Boolean(m.content),
          paths: [],
          notes: null,
          errorText: errText,
        });
      }
    }

    if (conversation.mode === "mixed") {
      if (usesSingleMuse) {
        for (const it of museItems) {
          if (!matchedMuseOwnerIds.has(it.message.id)) {
            const st = ownerState(
              it.message.status,
              it.message.expires_at,
              it.message.claim_expires_at,
            );
            const promptText = it.message.params.prompt ?? "";
            merged.push({
              id: `mix-m-owner-${it.message.id}`,
              sortMs: new Date(it.message.created_at).getTime(),
              side: "owner",
              who: OWNER_DISPLAY_NAME,
              dotColor: "var(--color-accent)",
              timeLabel: fmtTime(it.message.created_at),
              state: st,
              failed: st === "failed",
              copyValue: promptText,
              text: promptText,
              isMarkdown: false,
              paths: [],
              notes: null,
              errorText: st === "failed" && it.result?.error ? it.result.error : null,
            });
          }

          if (it.result) {
            const failed = it.result.status === "failed";
            const errText = failed ? it.result.error || "thất bại" : null;
            const text = failed ? "" : it.result.output?.text ?? "";
            const paths = failed ? [] : it.result.output?.dropbox_paths ?? [];
            merged.push({
              id: `mix-m-res-${it.message.id}`,
              sortMs: new Date(it.result.created_at).getTime(),
              side: "muse",
              who: singleMuseName,
              dotColor: participantColorMap.get(`muse:${singleMuseRef}`),
              timeLabel: fmtTime(it.result.created_at),
              state: failed ? "failed" : "done",
              failed,
              copyValue: failed ? errText ?? undefined : text || undefined,
              footer: paths.length > 0 ? `${paths.length} tệp trên Dropbox` : null,
              text,
              isMarkdown: !failed && Boolean(text),
              paths,
              notes: it.result.output?.notes ?? null,
              errorText: errText,
            });
          }
        }
      } else if (usesGroupMuse) {
        for (const b of groupBubbles) {
          if (b.kind === "owner" && matchedMuseOwnerIds.has(b.batchId)) continue;
          const isOwner = b.kind === "owner";
          const failed = b.state === "failed";
          merged.push({
            id: `mix-g-${b.batchId}`,
            sortMs: new Date(b.time).getTime(),
            side: isOwner ? "owner" : "muse",
            who: b.name,
            dotColor: isOwner
              ? "var(--color-accent)"
              : participantColorMap.get(b.name) ?? "var(--color-busy)",
            timeLabel: fmtTime(b.time),
            state: b.state,
            failed,
            statusText: failed && b.text ? b.error ?? "thất bại" : null,
            copyValue: b.text || undefined,
            text: b.text,
            isMarkdown: !isOwner && Boolean(b.text),
            paths: b.paths,
            notes: b.notes,
            errorText: failed && !b.text ? b.error ?? "thất bại" : null,
          });
        }
      }
    }

    merged.sort((a, b) => {
      if (a.sortMs !== b.sortMs) return a.sortMs - b.sortMs;
      if (a.side === b.side) return 0;
      return a.side === "owner" ? -1 : 1;
    });

    return merged;
  }, [
    conversation.mode,
    groupBubbles,
    museItems,
    oaiByRef,
    openaiMsgs,
    optimisticMuse,
    participantColorMap,
    singleMuseName,
    singleMuseRef,
    usesGroupMuse,
    usesSingleMuse,
  ]);

  // Smart auto-scroll
  useEffect(() => {
    if (loading) return;
    if (forceScrollRef.current || isNearBottomRef.current) {
      forceScrollRef.current = false;
      scrollToBottom(false);
    }
  }, [unifiedItems.length, inflightOai.length, loading, conversation.id, scrollToBottom]);

  // Aggregate Dropbox paths for InspectorPanel
  const aggregatedPaths = useMemo(() => {
    const seen = new Set<string>();
    for (const item of unifiedItems) {
      for (const p of item.paths) {
        if (p) seen.add(p);
      }
    }
    return [...seen];
  }, [unifiedItems]);

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

  async function dispatchOpenAI(prompt: string, priorHistory: UnifiedItem[]) {
    const targets = openaiParticipants.map((p) => ({
      reqId: crypto.randomUUID(),
      ref: p.ref,
      name: oaiByRef.get(p.ref)?.name ?? p.name,
      agent: oaiByRef.get(p.ref) ?? null,
    }));

    const nowIso = new Date().toISOString();
    setInflightOai((cur) => [
      ...cur,
      ...targets.map((t) => ({
        reqId: t.reqId,
        ref: t.ref,
        name: t.name,
        startedAt: nowIso,
      })),
    ]);

    const multiAgent = conversation.participants.length > 1;
    const historyTurns = priorHistory
      .filter((u) => !u.failed && u.text.trim().length > 0)
      .slice(-24)
      .map((u) => ({
        role: (u.side === "owner" ? "user" : "assistant") as "user" | "assistant",
        content:
          u.side === "muse" && multiAgent && u.who ? `[${u.who}]: ${u.text}` : u.text,
      }));

    await Promise.allSettled(
      targets.map(async (target) => {
        try {
          if (!target.agent) {
            await insertOpenAIMessage({
              conversation_id: conversation.id,
              role: "agent",
              agent_ref: target.ref,
              agent_name: target.name,
              content: "",
              status: "failed",
              error: `Agent "${target.name}" không còn tồn tại trong Quản trị Agent.`,
            });
            return;
          }

          const messages: { role: "system" | "user" | "assistant"; content: string }[] = [];
          if (target.agent.system_prompt?.trim()) {
            messages.push({ role: "system", content: target.agent.system_prompt.trim() });
          }
          messages.push(...historyTurns);
          messages.push({ role: "user", content: prompt });

          const res = await callOpenAIChatCompletion({
            agent: target.agent,
            messages,
          });

          if (res.error || !res.content) {
            await insertOpenAIMessage({
              conversation_id: conversation.id,
              role: "agent",
              agent_ref: target.agent.id,
              agent_name: target.agent.name,
              content: "",
              status: "failed",
              error: res.error ?? "Không nhận được phản hồi.",
            });
          } else {
            await insertOpenAIMessage({
              conversation_id: conversation.id,
              role: "agent",
              agent_ref: target.agent.id,
              agent_name: target.agent.name,
              content: res.content,
              status: "done",
              error: null,
            });
          }
        } finally {
          setInflightOai((cur) => cur.filter((x) => x.reqId !== target.reqId));
          const { data, error: fetchErr } = await fetchOpenAIMessages(conversation.id);
          if (!fetchErr) setOpenaiMsgs(data);
        }
      }),
    );
  }

  const singleMuseAlive = Boolean(singleMuseRef && museByRef.has(singleMuseRef));
  const activeGroupMuseCount = museParticipants.filter((p) => museByRef.has(p.ref)).length;

  async function handleSend(action: ActionMode, params: MessageParams): Promise<string | null> {
    const prompt = params.prompt ?? "";

    // 1. Pure single Muse mode (supports Chat, Image, Video + thread_id = conversation.id)
    if (conversation.mode === "muse_single") {
      if (!singleMuseRef) return "Không tìm thấy Muse trong cuộc hội thoại này.";
      if (!singleMuseAlive) {
        return `Muse "${singleMuseName}" đã bị xoá khỏi Quản trị Agent nên không thể nhận tin nhắn mới.`;
      }
      const { error } = await sendMessage({
        recipient: singleMuseRef,
        action,
        params: { ...params, thread_id: conversation.id },
      });
      if (error) return error;
      forceScrollRef.current = true;
      setOptimisticMuse((cur) => [
        ...cur,
        { tempId: crypto.randomUUID(), prompt, sentAt: Date.now() },
      ]);
      await load();
      props.onMessageSent?.();
      return null;
    }

    // 2. Pure Muse group mode
    if (conversation.mode === "muse_group") {
      if (!conversation.group_id) return "Cuộc hội thoại chưa có nhóm Muse liên kết.";
      if (activeGroupMuseCount === 0) {
        return "Tất cả Muse trong nhóm này đã bị xoá khỏi Quản trị Agent.";
      }
      const { error } = await sendGroupMessage({
        groupId: conversation.group_id,
        prompt,
        ownerName: OWNER_DISPLAY_NAME,
      });
      if (error) return error;
      forceScrollRef.current = true;
      await load();
      props.onMessageSent?.();
      return null;
    }

    // 3. OpenAI or Mixed mode: persist owner message in relay_openai_messages first
    const priorSnapshot = [...unifiedItems];
    const { data: savedOwner, error: ownerErr } = await insertOpenAIMessage({
      conversation_id: conversation.id,
      role: "owner",
      agent_ref: null,
      agent_name: OWNER_DISPLAY_NAME,
      content: prompt,
      status: "done",
    });
    if (ownerErr) return ownerErr;

    if (savedOwner) {
      setOpenaiMsgs((cur) => [...cur, savedOwner]);
    }
    forceScrollRef.current = true;

    // Dispatch Muse side if mixed
    if (conversation.mode === "mixed") {
      if (usesSingleMuse && singleMuseRef) {
        if (!singleMuseAlive) {
          toast(`Muse "${singleMuseName}" đã bị xoá — bỏ qua phần Muse.`);
        } else {
          const { error: mErr } = await sendMessage({
            recipient: singleMuseRef,
            action: "chat",
            params: {
              prompt,
              thread_id: conversation.id,
              resource_type: "auto",
              output_format: "auto",
            },
          });
          if (mErr) toast("Lỗi gửi tới Muse: " + mErr);
        }
      } else if (usesGroupMuse && conversation.group_id) {
        if (activeGroupMuseCount === 0) {
          toast("Các Muse trong nhóm đã bị xoá — bỏ qua phần Muse.");
        } else {
          const { error: gErr } = await sendGroupMessage({
            groupId: conversation.group_id,
            prompt,
            ownerName: OWNER_DISPLAY_NAME,
          });
          if (gErr) toast("Lỗi gửi tới nhóm Muse: " + gErr);
        }
      }
      props.onMessageSent?.();
      void load();
    }

    // Dispatch OpenAI side in background so UI stays responsive
    void dispatchOpenAI(prompt, priorSnapshot);
    return null;
  }

  async function handleConfirmDelete() {
    if (deleting) return;
    setDeleting(true);
    setDelError("");
    const err = await deleteConversation(conversation.id, conversation.group_id);
    setDeleting(false);
    if (err) {
      setDelError("Lỗi xoá cuộc hội thoại: " + err);
      return;
    }
    toast("Đã xoá cuộc hội thoại");
    setConfirmDelete(false);
    props.onConversationDeleted(project.id, conversation.id);
  }

  const showSkeleton =
    loading && unifiedItems.length === 0 && inflightOai.length === 0 && !loadError;
  const hasContent = unifiedItems.length > 0 || inflightOai.length > 0;

  return (
    <section className="room-pane fade" aria-label={`Cuộc hội thoại ${conversation.title}`}>
      <div className="pane-head">
        <div className="pane-title-group">
          <h2>{conversation.title}</h2>
          <span className="sub">
            {project.name} · {MODE_LABEL[conversation.mode]} ·{" "}
            {loadError
              ? `lỗi tải: ${loadError}`
              : updatedAt
                ? `cập nhật ${fmtClock(updatedAt)}`
                : "đang tải…"}
          </span>
        </div>
        <span className="grow" />
        <div className="pane-actions">
          <button
            type="button"
            className="btn-ghost danger-text"
            onClick={() => {
              setDelError("");
              setConfirmDelete(true);
            }}
            title="Xoá cuộc hội thoại"
          >
            <TrashIcon size={14} />
            <span className="hide-xs">Xoá</span>
          </button>
          <button type="button" className="btn-ghost" onClick={load}>
            <RefreshIcon size={14} />
            <span className="hide-xs">Làm mới</span>
          </button>
          <button
            type="button"
            className={`btn-ghost btn-inspector-toggle${props.inspectorOpen ? " active" : ""}`}
            onClick={props.onToggleInspector}
            aria-pressed={props.inspectorOpen}
            title="Đóng/mở chi tiết cuộc hội thoại"
          >
            <PanelRightIcon size={15} />
            <span className="hide-xs">Chi tiết</span>
          </button>
        </div>
      </div>

      <div className="members-chips">
        {conversation.participants.map((p, idx) => {
          const liveMuse = p.kind === "muse" ? museByRef.get(p.ref) : undefined;
          const liveOai = p.kind === "openai" ? oaiByRef.get(p.ref) : undefined;
          const liveName = liveMuse?.name ?? liveOai?.name ?? p.name;
          const deleted = !liveMuse && !liveOai;
          return (
            <span
              key={`${p.kind}:${p.ref}`}
              className={`member-chip${deleted ? " deleted" : ""}`}
              title={deleted ? "Agent đã bị xoá khỏi Quản trị Agent" : undefined}
            >
              <i style={{ background: memberDotColor(idx) }} />
              <span>{liveName}</span>
              <span className={`agent-kind-tag ${p.kind}`}>
                {p.kind === "muse" ? "Muse" : "OpenAI"}
              </span>
              {deleted && <span className="deleted-note">đã xoá</span>}
            </span>
          );
        })}
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
            </div>
          )}

          {!loading && !hasContent && !loadError && (
            <div className="thread-empty">
              Cuộc hội thoại trống — gửi tin nhắn đầu tiên bên dưới.
            </div>
          )}

          {unifiedItems.map((it) => (
            <MessageBubble
              key={it.id}
              side={it.side}
              who={it.who}
              dotColor={it.dotColor}
              state={it.state}
              failed={it.failed}
              timeLabel={it.timeLabel}
              copyValue={it.copyValue}
              footer={it.footer}
              statusText={it.statusText}
            >
              {it.errorText ? (
                <div className="body err">{it.errorText}</div>
              ) : it.text ? (
                it.isMarkdown ? (
                  <>
                    <MarkdownBody text={it.text} />
                    <UrlPreviews text={it.text} />
                  </>
                ) : (
                  <div className="body">{it.text}</div>
                )
              ) : null}
              {it.paths.length > 0 && <ResourceCards paths={it.paths} />}
              {it.notes && <div className="statusline">{it.notes}</div>}
              {it.extraLine && <div className="statusline">{it.extraLine}</div>}
            </MessageBubble>
          ))}

          {inflightOai.map((inf) => (
            <MessageBubble
              key={`inflight-${inf.reqId}`}
              side="muse"
              who={inf.name}
              dotColor={participantColorMap.get(`openai:${inf.ref}`) ?? "var(--color-busy)"}
              state="processing"
              timeLabel={fmtTime(inf.startedAt)}
              statusText={`${inf.name} đang suy nghĩ…`}
            >
              <div className="body typing-dots" aria-label="Đang tạo phản hồi">
                <span />
                <span />
                <span />
              </div>
            </MessageBubble>
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
        placeholder={`Nhắn trong "${conversation.title}"… (Enter gửi, Shift+Enter xuống dòng)`}
        onSend={handleSend}
        mediaModes={conversation.mode === "muse_single"}
        hideThreadInput={conversation.mode === "muse_single"}
      />

      {confirmDelete && (
        <Modal
          open
          onClose={() => setConfirmDelete(false)}
          labelledBy="room-del-conv-title"
        >
          <h2 id="room-del-conv-title">Xoá cuộc hội thoại — {conversation.title}</h2>
          <p className="lead">
            Hành động này sẽ xoá cuộc hội thoại khỏi Project <strong>{project.name}</strong>.
          </p>
          <ErrorMsg text={delError} />
          <div className="actions">
            <button
              type="button"
              className={`btn btn-danger${deleting ? " is-loading" : ""}`}
              disabled={deleting}
              onClick={handleConfirmDelete}
            >
              {deleting ? "Đang xoá…" : "Xoá cuộc hội thoại"}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setConfirmDelete(false)}
            >
              Giữ lại
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
