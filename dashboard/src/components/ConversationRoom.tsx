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
import { useLang, type I18nKey } from "../lib/i18n";
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

const MODE_KEY: Record<ConversationMode, I18nKey> = {
  muse_single: "convMode.muse_single",
  muse_group: "convMode.muse_group",
  openai: "convMode.openai",
  mixed: "convMode.mixedFull",
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
  const { lang, t } = useLang();

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
    const tmr = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(tmr);
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
            ? t("museRoom.statusPending")
            : st === "processing"
              ? t("museRoom.statusProcessing", { name: singleMuseName })
              : st === "expired"
                ? t("museRoom.statusExpired")
                : null;
        const summary = paramsSummary(it.message.action, it.message.params, lang);

        list.push({
          id: `m-owner-${it.message.id}`,
          sortMs: new Date(it.message.created_at).getTime(),
          side: "owner",
          timeLabel: fmtTime(it.message.created_at, lang),
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
            const errText = it.result.error || t("api.failed");
            list.push({
              id: `m-res-${it.message.id}`,
              sortMs: new Date(it.result.created_at).getTime(),
              side: "muse",
              who: singleMuseName,
              dotColor: participantColorMap.get(`muse:${singleMuseRef}`),
              timeLabel: fmtTime(it.result.created_at, lang),
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
              timeLabel: t("museRoom.replyAt", { time: fmtTime(it.result.created_at, lang) }),
              state: "done",
              copyValue: text || undefined,
              footer: paths.length > 0 ? t("museRoom.dropboxFiles", { count: paths.length }) : null,
              text,
              isMarkdown: Boolean(text),
              paths,
              notes: it.result.output?.notes ?? null,
              errorText: null,
              extraLine:
                it.message.attempts > 1
                  ? t("museRoom.attemptNum", { n: it.message.attempts })
                  : null,
            });
          }
        }
      }

      for (const o of optimisticMuse) {
        list.push({
          id: `opt-${o.tempId}`,
          sortMs: o.sentAt,
          side: "owner",
          timeLabel: fmtTime(new Date(o.sentAt).toISOString(), lang),
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
            ? t("convRoom.waitingGroup")
            : b.state === "processing"
              ? t("convRoom.processingGroup")
              : null;
        return {
          id: `grp-${b.batchId}`,
          sortMs: new Date(b.time).getTime(),
          side: isOwner ? "owner" : "muse",
          who: b.name,
          dotColor: isOwner
            ? "var(--color-accent)"
            : participantColorMap.get(b.name) ?? "var(--color-busy)",
          timeLabel: fmtTime(b.time, lang),
          state: b.state,
          failed,
          statusText: failed ? (b.text ? b.error ?? t("api.failed") : null) : stateText,
          copyValue: b.text || undefined,
          text: b.text,
          isMarkdown: !isOwner && Boolean(b.text),
          paths: b.paths,
          notes: b.notes,
          errorText: failed && !b.text ? b.error ?? t("api.failed") : null,
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
                  ? t("convRoom.waitingNamedMuse", { name: singleMuseName })
                  : st === "processing"
                    ? t("museRoom.statusProcessing", { name: singleMuseName })
                    : st === "expired"
                      ? t("convRoom.expiredNamedMuse", { name: singleMuseName })
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
                  ? t("convRoom.waitingGroup")
                  : match.state === "processing"
                    ? t("convRoom.musesProcessing")
                    : match.state === "failed"
                      ? match.error ?? t("convRoom.museFailed")
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
          timeLabel: fmtTime(m.created_at, lang),
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
        const errText = failed ? m.error || t("convRoom.modelError") : null;
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
          timeLabel: fmtTime(m.created_at, lang),
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
              timeLabel: fmtTime(it.message.created_at, lang),
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
            const errText = failed ? it.result.error || t("api.failed") : null;
            const text = failed ? "" : it.result.output?.text ?? "";
            const paths = failed ? [] : it.result.output?.dropbox_paths ?? [];
            merged.push({
              id: `mix-m-res-${it.message.id}`,
              sortMs: new Date(it.result.created_at).getTime(),
              side: "muse",
              who: singleMuseName,
              dotColor: participantColorMap.get(`muse:${singleMuseRef}`),
              timeLabel: fmtTime(it.result.created_at, lang),
              state: failed ? "failed" : "done",
              failed,
              copyValue: failed ? errText ?? undefined : text || undefined,
              footer: paths.length > 0 ? t("museRoom.dropboxFiles", { count: paths.length }) : null,
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
            timeLabel: fmtTime(b.time, lang),
            state: b.state,
            failed,
            statusText: failed && b.text ? b.error ?? t("api.failed") : null,
            copyValue: b.text || undefined,
            text: b.text,
            isMarkdown: !isOwner && Boolean(b.text),
            paths: b.paths,
            notes: b.notes,
            errorText: failed && !b.text ? b.error ?? t("api.failed") : null,
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
    lang,
    museItems,
    oaiByRef,
    openaiMsgs,
    optimisticMuse,
    participantColorMap,
    singleMuseName,
    singleMuseRef,
    t,
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
      ...targets.map((tgt) => ({
        reqId: tgt.reqId,
        ref: tgt.ref,
        name: tgt.name,
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
              error: t("convRoom.missingAgentErr", { name: target.name }),
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
              error: res.error ?? t("convRoom.noResponse"),
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
      if (!singleMuseRef) return t("convRoom.noMuseErr");
      if (!singleMuseAlive) {
        return t("convRoom.museDeletedErr", { name: singleMuseName });
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
      if (!conversation.group_id) return t("convRoom.noGroupErr");
      if (activeGroupMuseCount === 0) {
        return t("convRoom.allGroupMusesDeletedErr");
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
          toast(t("convRoom.skipDeletedMuse", { name: singleMuseName }));
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
          if (mErr) toast(t("convRoom.sendMuseErr", { err: mErr }));
        }
      } else if (usesGroupMuse && conversation.group_id) {
        if (activeGroupMuseCount === 0) {
          toast(t("convRoom.skipDeletedGroup"));
        } else {
          const { error: gErr } = await sendGroupMessage({
            groupId: conversation.group_id,
            prompt,
            ownerName: OWNER_DISPLAY_NAME,
          });
          if (gErr) toast(t("convRoom.sendGroupErr", { err: gErr }));
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
      setDelError(t("convRoom.delErr", { err }));
      return;
    }
    toast(t("convRoom.delToast"));
    setConfirmDelete(false);
    props.onConversationDeleted(project.id, conversation.id);
  }

  const showSkeleton =
    loading && unifiedItems.length === 0 && inflightOai.length === 0 && !loadError;
  const hasContent = unifiedItems.length > 0 || inflightOai.length > 0;

  return (
    <section className="room-pane fade" aria-label={t("convRoom.aria", { title: conversation.title })}>
      <div className="pane-head">
        <div className="pane-title-group">
          <h2>{conversation.title}</h2>
          <span className="sub">
            {project.name} · {t(MODE_KEY[conversation.mode])} ·{" "}
            {loadError
              ? t("museRoom.loadErr", { err: loadError })
              : updatedAt
                ? t("ov.updated", { time: fmtClock(updatedAt, lang) })
                : t("ov.loading")}
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
            title={t("convRoom.deleteTitle")}
            aria-label={t("convRoom.deleteTitle")}
          >
            <TrashIcon size={14} />
            <span className="hide-xs">{t("common.delete")}</span>
          </button>
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
            title={t("convRoom.toggleDetailsTitle")}
            aria-label={t("convRoom.toggleDetailsTitle")}
          >
            <PanelRightIcon size={15} />
            <span className="hide-xs">{t("common.details")}</span>
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
              title={deleted ? t("convRoom.deletedFromAdmin") : undefined}
            >
              <i style={{ background: memberDotColor(idx) }} />
              <span>{liveName}</span>
              <span className={`agent-kind-tag ${p.kind}`}>
                {p.kind === "muse" ? "Muse" : "OpenAI"}
              </span>
              {deleted && <span className="deleted-note">{t("convRoom.deletedTag")}</span>}
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
            <div className="thread-skeleton" aria-label={t("museRoom.loadingAria")}>
              <div className="skel-bubble owner" />
              <div className="skel-bubble muse" />
              <div className="skel-bubble owner short" />
            </div>
          )}

          {!loading && !hasContent && !loadError && (
            <div className="thread-empty">{t("convRoom.empty")}</div>
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
              timeLabel={fmtTime(inf.startedAt, lang)}
              statusText={t("convRoom.thinking", { name: inf.name })}
            >
              <div className="body typing-dots" aria-label={t("convRoom.generatingAria")}>
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
            aria-label={t("museRoom.scrollBottomAria")}
          >
            <ArrowDownIcon size={14} />
            <span>{t("museRoom.scrollBottom")}</span>
          </button>
        )}
      </div>

      <Composer
        placeholder={t("convRoom.composerPlaceholder", { title: conversation.title })}
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
          <h2 id="room-del-conv-title">
            {t("convRoom.delModalTitle", { title: conversation.title })}
          </h2>
          <p className="lead">
            {t("convRoom.delModalBody")} <strong>{project.name}</strong>.
          </p>
          <ErrorMsg text={delError} />
          <div className="actions">
            <button
              type="button"
              className={`btn btn-danger${deleting ? " is-loading" : ""}`}
              disabled={deleting}
              onClick={handleConfirmDelete}
            >
              {deleting ? t("common.deleting") : t("convRoom.delConfirm")}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setConfirmDelete(false)}
            >
              {t("common.keep")}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
