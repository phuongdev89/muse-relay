import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  callOpenAIChatCompletion,
  deleteConversation,
  fetchGroupThread,
  fetchMuseThread,
  fetchOpenAIMessages,
  insertOpenAIMessage,
  sendGroupMessage,
  sendMessage,
  uploadFileToMuseDropbox,
  type OpenAIChatHistoryTurn,
} from "../../lib/api";
import { getConfig } from "../../lib/config";
import {
  MAX_ATTACH_FILES,
  mergeAttachmentFiles,
  stripDropboxInputNote,
} from "../../lib/dropbox";
import {
  fmtClock,
  fmtTime,
  memberDotColor,
  museEmailOf,
  ownerState,
  paramsSummary,
} from "../../lib/format";
import { useLang, type I18nKey } from "../../lib/i18n";
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
} from "../../types";
import { Composer } from "../chat/Composer";
import {
  ArrowDownIcon,
  PanelRightIcon,
  PaperclipIcon,
  RefreshIcon,
  TrashIcon,
} from "../common/Icons";
import { MarkdownBody } from "../chat/MarkdownBody";
import { MessageBubble, ResourceCards, UrlPreviews } from "../chat/MessageBubble";
import { ErrorMsg, Modal, toast } from "../common/ui";

const POLL_MS = 10000;

const MODE_KEY: Record<ConversationMode, I18nKey> = {
  muse_single: "convMode.muse_single",
  muse_group: "convMode.muse_group",
  openai: "convMode.openai",
  mixed: "convMode.mixedFull",
};

interface OptimisticConvSend {
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
  priorSnapshot: UnifiedItem[];
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
  isTyping?: boolean;
  typingAria?: string;
  statusText?: string | null;
  footer?: string | null;
  copyValue?: string;
  text: string;
  isMarkdown: boolean;
  paths: string[];
  notes: string | null;
  errorText: string | null;
  extraLine?: string | null;
  retryTempId?: string;
  retryError?: string | null;
  attachedFileNames?: string[];
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
  const ownerDisplayName = getConfig().ownerDisplayName;

  const [museItems, setMuseItems] = useState<ThreadItem[]>([]);
  const [groupBubbles, setGroupBubbles] = useState<GroupBubble[]>([]);
  const [openaiMsgs, setOpenaiMsgs] = useState<OpenAIMessage[]>([]);
  const [optimisticSends, setOptimisticSends] = useState<OptimisticConvSend[]>([]);
  const [inflightOai, setInflightOai] = useState<InflightOpenAI[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);

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
  const dragDepthRef = useRef(0);
  const convIdRef = useRef(conversation.id);
  convIdRef.current = conversation.id;

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
  const groupMusesLabel = useMemo(
    () =>
      museParticipants
        .map((p) => museByRef.get(p.ref)?.name ?? p.name)
        .filter(Boolean)
        .join(", ") || "Muse",
    [museParticipants, museByRef],
  );

  const load = useCallback(async () => {
    const targetConvId = conversation.id;
    const errs: string[] = [];
    const tasks: Promise<void>[] = [];

    if (usesSingleMuse && singleMuseRef) {
      tasks.push(
        fetchMuseThread(singleMuseRef, targetConvId).then(({ items, error }) => {
          if (convIdRef.current !== targetConvId) return;
          if (error) errs.push(error);
          else {
            setMuseItems(items);
            if (conversation.mode === "muse_single") {
              setOptimisticSends((cur) =>
                cur.filter((o) => {
                  if (o.status === "failed" || o.status === "sending") return true;
                  const targetPrompt = o.finalPrompt ?? o.prompt;
                  const landed = items.some(
                    (it) =>
                      (o.messageId && it.message.id === o.messageId) ||
                      (it.message.params.prompt === targetPrompt &&
                        new Date(it.message.created_at).getTime() >= o.sentAt - 2000),
                  );
                  const stale = Date.now() - o.sentAt > 30000;
                  return !landed && !stale;
                }),
              );
            }
          }
        }),
      );
    }

    if (usesGroupMuse && conversation.group_id) {
      tasks.push(
        fetchGroupThread(conversation.group_id).then(({ bubbles, error }) => {
          if (convIdRef.current !== targetConvId) return;
          if (error) errs.push(error);
          else {
            setGroupBubbles(bubbles);
            if (conversation.mode === "muse_group") {
              setOptimisticSends((cur) =>
                cur.filter((o) => {
                  if (o.status === "failed" || o.status === "sending") return true;
                  const landed = bubbles.some(
                    (b) =>
                      b.kind === "owner" &&
                      b.text.trim() === o.prompt.trim() &&
                      new Date(b.time).getTime() >= o.sentAt - 2000,
                  );
                  const stale = Date.now() - o.sentAt > 30000;
                  return !landed && !stale;
                }),
              );
            }
          }
        }),
      );
    }

    if (usesOpenAI) {
      tasks.push(
        fetchOpenAIMessages(targetConvId).then(({ data, error }) => {
          if (convIdRef.current !== targetConvId) return;
          if (error) errs.push(error);
          else setOpenaiMsgs(data);
        }),
      );
    }

    await Promise.all(tasks);
    if (convIdRef.current !== targetConvId) return;
    setLoading(false);
    setLoadError(errs.join(" · "));
    setUpdatedAt(new Date());
  }, [
    conversation.id,
    conversation.group_id,
    conversation.mode,
    singleMuseRef,
    usesGroupMuse,
    usesOpenAI,
    usesSingleMuse,
  ]);

  useEffect(() => {
    setMuseItems([]);
    setGroupBubbles([]);
    setOpenaiMsgs([]);
    setOptimisticSends([]);
    setInflightOai([]);
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
    const shouldPoll = usesSingleMuse || usesGroupMuse;
    if (!shouldPoll) return;
    const tmr = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(tmr);
  }, [load, usesSingleMuse, usesGroupMuse]);

  // Build unified chronological items
  const unifiedItems = useMemo<UnifiedItem[]>(() => {
    const appendOptimistic = (list: UnifiedItem[]) => {
      for (const o of optimisticSends) {
        const summary = paramsSummary(o.action, o.params, lang);
        const optStatus =
          o.status === "sending"
            ? o.uploadingCount
              ? t("museRoom.uploadingFiles", { count: o.uploadingCount })
              : t("museRoom.sendingStatus")
            : o.status === "pending"
              ? conversation.mode === "muse_group"
                ? t("convRoom.waitingGroup")
                : t("museRoom.statusPending")
              : null;
        list.push({
          id: `opt-${o.tempId}`,
          sortMs: o.sentAt,
          side: "owner",
          who: conversation.mode === "mixed" || conversation.mode === "muse_group"
            ? ownerDisplayName
            : undefined,
          dotColor: "var(--color-accent)",
          timeLabel: fmtTime(new Date(o.sentAt).toISOString(), lang),
          state: o.status === "failed" ? "failed" : "pending",
          failed: o.status === "failed",
          statusText: optStatus,
          footer: summary || null,
          copyValue: o.prompt,
          text: o.prompt,
          isMarkdown: false,
          paths: [],
          notes: null,
          errorText: null,
          retryTempId: o.status === "failed" ? o.tempId : undefined,
          retryError: o.status === "failed" ? o.error ?? t("api.failed") : null,
          attachedFileNames: o.files.length > 0 ? o.files.map((f) => f.name) : undefined,
        });
      }
      return list;
    };

    // Pure single Muse mode
    if (conversation.mode === "muse_single") {
      const list: UnifiedItem[] = [];
      for (const it of museItems) {
        const st = ownerState(
          it.message.status,
          it.message.expires_at,
          it.message.claim_expires_at,
        );
        const promptText = stripDropboxInputNote(it.message.params.prompt ?? "");
        const refPaths = it.message.params.reference_dropbox_paths ?? [];
        const statusText =
          st === "pending"
            ? t("museRoom.statusPending")
            : st === "expired"
              ? t("museRoom.statusExpired")
              : null;
        const summary = paramsSummary(it.message.action, it.message.params, lang);
        const createdMs = new Date(it.message.created_at).getTime();

        list.push({
          id: `m-owner-${it.message.id}`,
          sortMs: createdMs,
          side: "owner",
          timeLabel: fmtTime(it.message.created_at, lang),
          state: st,
          failed: st === "failed",
          statusText: st === "failed" ? null : statusText,
          footer: summary || null,
          copyValue: promptText,
          text: promptText,
          isMarkdown: false,
          paths: refPaths,
          notes: null,
          errorText: st === "failed" && it.result?.error ? it.result.error : null,
        });

        if (!it.result && st === "processing") {
          list.push({
            id: `m-typing-${it.message.id}`,
            sortMs: createdMs + 1,
            side: "muse",
            who: singleMuseName,
            dotColor: participantColorMap.get(`muse:${singleMuseRef}`),
            timeLabel: "",
            state: "processing",
            isTyping: true,
            typingAria: t("museRoom.typingAria", { name: singleMuseName }),
            text: "",
            isMarkdown: false,
            paths: [],
            notes: null,
            errorText: null,
          });
        }

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

      return appendOptimistic(list);
    }

    // Pure Muse group mode
    if (conversation.mode === "muse_group") {
      const list: UnifiedItem[] = [];
      const hasMuseProcessingBubble = groupBubbles.some(
        (b) => b.kind === "muse" && b.state === "processing",
      );
      groupBubbles.forEach((b) => {
        const isOwner = b.kind === "owner";
        const failed = b.state === "failed";
        const isMuseTyping = !isOwner && b.state === "processing";
        const stateText =
          isOwner && b.state === "pending" ? t("convRoom.waitingGroup") : null;
        const sortMs = new Date(b.time).getTime();

        list.push({
          id: `grp-${b.batchId}`,
          sortMs,
          side: isOwner ? "owner" : "muse",
          who: b.name,
          dotColor: isOwner
            ? "var(--color-accent)"
            : participantColorMap.get(b.name) ?? "var(--color-busy)",
          timeLabel: isMuseTyping ? "" : fmtTime(b.time, lang),
          state: b.state,
          failed,
          isTyping: isMuseTyping,
          typingAria: isMuseTyping ? t("museRoom.typingAria", { name: b.name }) : undefined,
          statusText: failed ? (b.text ? b.error ?? t("api.failed") : null) : stateText,
          copyValue: b.text || undefined,
          text: b.text,
          isMarkdown: !isOwner && Boolean(b.text),
          paths: b.paths,
          notes: b.notes,
          errorText: failed && !b.text ? b.error ?? t("api.failed") : null,
        });

        if (isOwner && b.state === "processing" && !hasMuseProcessingBubble) {
          list.push({
            id: `grp-typing-${b.batchId}`,
            sortMs: sortMs + 1,
            side: "muse",
            who: groupMusesLabel,
            dotColor: "var(--color-busy)",
            timeLabel: "",
            state: "processing",
            isTyping: true,
            typingAria: t("convRoom.museTypingAria"),
            text: "",
            isMarkdown: false,
            paths: [],
            notes: null,
            errorText: null,
          });
        }
      });
      return appendOptimistic(list);
    }

    // Pure OpenAI or Mixed mode: merge OpenAI messages + Muse stream chronologically
    const merged: UnifiedItem[] = [];
    const matchedMuseOwnerIds = new Set<string>();
    const hasGroupMuseProcessingBubble = groupBubbles.some(
      (b) => b.kind === "muse" && b.state === "processing",
    );

    for (const m of openaiMsgs) {
      const mMs = new Date(m.created_at).getTime();
      if (m.role === "owner") {
        let state: string | undefined;
        let failed = false;
        let statusText: string | null = null;
        let errorText: string | null = null;
        let ownerPaths: string[] = [];
        let pendingTypingItem: UnifiedItem | null = null;

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
              ownerPaths = match.message.params.reference_dropbox_paths ?? [];
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
                  : st === "expired"
                    ? t("convRoom.expiredNamedMuse", { name: singleMuseName })
                    : null;
              if (st === "failed" && match.result?.error) {
                errorText = match.result.error;
              }
              if (!match.result && st === "processing") {
                pendingTypingItem = {
                  id: `mix-m-typing-${match.message.id}`,
                  sortMs: mMs + 1,
                  side: "muse",
                  who: singleMuseName,
                  dotColor: participantColorMap.get(`muse:${singleMuseRef}`),
                  timeLabel: "",
                  state: "processing",
                  isTyping: true,
                  typingAria: t("museRoom.typingAria", { name: singleMuseName }),
                  text: "",
                  isMarkdown: false,
                  paths: [],
                  notes: null,
                  errorText: null,
                };
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
                  : match.state === "failed"
                    ? match.error ?? t("convRoom.museFailed")
                    : null;
              if (match.state === "processing" && !hasGroupMuseProcessingBubble) {
                pendingTypingItem = {
                  id: `mix-g-typing-${match.batchId}`,
                  sortMs: mMs + 1,
                  side: "muse",
                  who: groupMusesLabel,
                  dotColor: "var(--color-busy)",
                  timeLabel: "",
                  state: "processing",
                  isTyping: true,
                  typingAria: t("convRoom.museTypingAria"),
                  text: "",
                  isMarkdown: false,
                  paths: [],
                  notes: null,
                  errorText: null,
                };
              }
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
          paths: ownerPaths,
          notes: null,
          errorText,
        });
        if (pendingTypingItem) merged.push(pendingTypingItem);
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
          const createdMs = new Date(it.message.created_at).getTime();
          const st = ownerState(
            it.message.status,
            it.message.expires_at,
            it.message.claim_expires_at,
          );
          if (!matchedMuseOwnerIds.has(it.message.id)) {
            const promptText = stripDropboxInputNote(it.message.params.prompt ?? "");
            const refPaths = it.message.params.reference_dropbox_paths ?? [];
            merged.push({
              id: `mix-m-owner-${it.message.id}`,
              sortMs: createdMs,
              side: "owner",
              who: ownerDisplayName,
              dotColor: "var(--color-accent)",
              timeLabel: fmtTime(it.message.created_at, lang),
              state: st,
              failed: st === "failed",
              statusText:
                st === "pending"
                  ? t("convRoom.waitingNamedMuse", { name: singleMuseName })
                  : st === "expired"
                    ? t("convRoom.expiredNamedMuse", { name: singleMuseName })
                    : null,
              copyValue: promptText,
              text: promptText,
              isMarkdown: false,
              paths: refPaths,
              notes: null,
              errorText: st === "failed" && it.result?.error ? it.result.error : null,
            });
            if (!it.result && st === "processing") {
              merged.push({
                id: `mix-m-typing-${it.message.id}`,
                sortMs: createdMs + 1,
                side: "muse",
                who: singleMuseName,
                dotColor: participantColorMap.get(`muse:${singleMuseRef}`),
                timeLabel: "",
                state: "processing",
                isTyping: true,
                typingAria: t("museRoom.typingAria", { name: singleMuseName }),
                text: "",
                isMarkdown: false,
                paths: [],
                notes: null,
                errorText: null,
              });
            }
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
          const isMuseTyping = !isOwner && b.state === "processing";
          const sortMs = new Date(b.time).getTime();
          merged.push({
            id: `mix-g-${b.batchId}`,
            sortMs,
            side: isOwner ? "owner" : "muse",
            who: b.name,
            dotColor: isOwner
              ? "var(--color-accent)"
              : participantColorMap.get(b.name) ?? "var(--color-busy)",
            timeLabel: isMuseTyping ? "" : fmtTime(b.time, lang),
            state: b.state,
            failed,
            isTyping: isMuseTyping,
            typingAria: isMuseTyping ? t("museRoom.typingAria", { name: b.name }) : undefined,
            statusText: failed && b.text ? b.error ?? t("api.failed") : null,
            copyValue: b.text || undefined,
            text: b.text,
            isMarkdown: !isOwner && Boolean(b.text),
            paths: b.paths,
            notes: b.notes,
            errorText: failed && !b.text ? b.error ?? t("api.failed") : null,
          });
          if (isOwner && b.state === "processing" && !hasGroupMuseProcessingBubble) {
            merged.push({
              id: `mix-g-typing-${b.batchId}`,
              sortMs: sortMs + 1,
              side: "muse",
              who: groupMusesLabel,
              dotColor: "var(--color-busy)",
              timeLabel: "",
              state: "processing",
              isTyping: true,
              typingAria: t("convRoom.museTypingAria"),
              text: "",
              isMarkdown: false,
              paths: [],
              notes: null,
              errorText: null,
            });
          }
        }
      }
    }

    appendOptimistic(merged);

    merged.sort((a, b) => {
      if (a.sortMs !== b.sortMs) return a.sortMs - b.sortMs;
      if (a.side === b.side) return 0;
      return a.side === "owner" ? -1 : 1;
    });

    return merged;
  }, [
    conversation.mode,
    groupBubbles,
    groupMusesLabel,
    lang,
    museItems,
    oaiByRef,
    openaiMsgs,
    optimisticSends,
    ownerDisplayName,
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
    const historyTurns: OpenAIChatHistoryTurn[] = priorHistory
      .filter((u) => !u.failed && !u.isTyping && u.text.trim().length > 0)
      .slice(-16)
      .map((u) => ({
        role: u.side === "owner" ? "user" : "assistant",
        content:
          u.side === "muse" && multiAgent && u.who ? `[${u.who}]: ${u.text}` : u.text,
        status: "done",
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

          const res = await callOpenAIChatCompletion(target.agent, historyTurns, prompt);

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
  const canAttach = usesSingleMuse && singleMuseAlive;

  function markOptimisticFailed(tempId: string, convId: string, error: string) {
    if (convIdRef.current !== convId) return;
    setOptimisticSends((cur) =>
      cur.map((item) =>
        item.tempId === tempId
          ? { ...item, status: "failed", uploadingCount: undefined, error }
          : item,
      ),
    );
  }

  async function uploadAttachedFiles(
    tempId: string,
    convId: string,
    targetRecipient: string,
    files: File[],
  ): Promise<string[] | null> {
    const uploadedPaths: string[] = [];
    for (const file of files) {
      const res = await uploadFileToMuseDropbox({
        recipient: targetRecipient,
        threadId: convId,
        file,
      });
      if (res.error || !res.dropbox_path) {
        markOptimisticFailed(
          tempId,
          convId,
          t("dropbox.uploadErr", {
            name: file.name,
            err: res.error ?? t("api.failed"),
          }),
        );
        return null;
      }
      uploadedPaths.push(res.dropbox_path);
    }
    return uploadedPaths;
  }

  async function dispatchConvSend(
    tempId: string,
    convId: string,
    action: ActionMode,
    params: MessageParams,
    files: File[],
    priorSnapshot: UnifiedItem[],
  ) {
    const basePrompt = params.prompt ?? "";

    // 1. Pure single Muse mode (supports Chat, Image, Video + thread_id = conversation.id)
    if (conversation.mode === "muse_single") {
      if (!singleMuseRef) {
        markOptimisticFailed(tempId, convId, t("convRoom.noMuseErr"));
        return;
      }
      if (!singleMuseAlive) {
        markOptimisticFailed(
          tempId,
          convId,
          t("convRoom.museDeletedErr", { name: singleMuseName }),
        );
        return;
      }

      let finalParams: MessageParams = { ...params, thread_id: convId };
      if (files.length > 0) {
        const uploadedPaths = await uploadAttachedFiles(tempId, convId, singleMuseRef, files);
        if (!uploadedPaths) return;
        finalParams = {
          ...finalParams,
          reference_dropbox_paths: [
            ...(finalParams.reference_dropbox_paths ?? []),
            ...uploadedPaths,
          ],
        };
      }

      const { data, error } = await sendMessage({
        recipient: singleMuseRef,
        action,
        params: finalParams,
      });
      if (convIdRef.current !== convId) return;
      if (error) {
        markOptimisticFailed(tempId, convId, error);
        return;
      }

      setOptimisticSends((cur) =>
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
      return;
    }

    // 2. Pure Muse group mode
    if (conversation.mode === "muse_group") {
      if (!conversation.group_id) {
        markOptimisticFailed(tempId, convId, t("convRoom.noGroupErr"));
        return;
      }
      if (activeGroupMuseCount === 0) {
        markOptimisticFailed(tempId, convId, t("convRoom.allGroupMusesDeletedErr"));
        return;
      }
      const { error } = await sendGroupMessage({
        groupId: conversation.group_id,
        prompt: basePrompt,
        ownerName: ownerDisplayName,
      });
      if (convIdRef.current !== convId) return;
      if (error) {
        markOptimisticFailed(tempId, convId, error);
        return;
      }
      setOptimisticSends((cur) =>
        cur.map((item) =>
          item.tempId === tempId
            ? { ...item, status: "pending", uploadingCount: undefined, error: undefined }
            : item,
        ),
      );
      await load();
      props.onMessageSent?.();
      return;
    }

    // 3. OpenAI or Mixed mode: upload attachments if single Muse present, then persist owner message
    const finalPrompt = basePrompt;
    let uploadedRefs: string[] = [];
    if (conversation.mode === "mixed" && usesSingleMuse && files.length > 0) {
      if (!singleMuseRef || !singleMuseAlive) {
        markOptimisticFailed(
          tempId,
          convId,
          t("convRoom.museDeletedErr", { name: singleMuseName }),
        );
        return;
      }
      const uploaded = await uploadAttachedFiles(tempId, convId, singleMuseRef, files);
      if (!uploaded) return;
      uploadedRefs = uploaded;
    }

    const { data: savedOwner, error: ownerErr } = await insertOpenAIMessage({
      conversation_id: convId,
      role: "owner",
      agent_ref: null,
      agent_name: ownerDisplayName,
      content: finalPrompt,
      status: "done",
    });
    if (convIdRef.current !== convId) return;
    if (ownerErr) {
      markOptimisticFailed(tempId, convId, ownerErr);
      return;
    }

    setOptimisticSends((cur) => cur.filter((item) => item.tempId !== tempId));
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
              prompt: finalPrompt,
              thread_id: convId,
              resource_type: "auto",
              output_format: "auto",
              ...(uploadedRefs.length > 0 ? { reference_dropbox_paths: uploadedRefs } : {}),
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
            prompt: finalPrompt,
            ownerName: ownerDisplayName,
          });
          if (gErr) toast(t("convRoom.sendGroupErr", { err: gErr }));
        }
      }
      props.onMessageSent?.();
      void load();
    }

    // Dispatch OpenAI side in background
    void dispatchOpenAI(finalPrompt, priorSnapshot);
  }

  function handleSend(action: ActionMode, params: MessageParams, files: File[]) {
    const tempId = crypto.randomUUID();
    const sentAt = Date.now();
    const prompt = params.prompt ?? "";
    const priorSnapshot = [...unifiedItems];
    forceScrollRef.current = true;
    setOptimisticSends((cur) => [
      ...cur,
      {
        tempId,
        action,
        params,
        prompt,
        files,
        sentAt,
        status: "sending",
        uploadingCount: files.length > 0 ? files.length : undefined,
        priorSnapshot,
      },
    ]);
    void dispatchConvSend(tempId, conversation.id, action, params, files, priorSnapshot);
  }

  function retrySend(tempId: string) {
    const target = optimisticSends.find((o) => o.tempId === tempId);
    if (!target || target.status !== "failed") return;
    const retriedAt = Date.now();
    setOptimisticSends((cur) =>
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
    void dispatchConvSend(
      tempId,
      conversation.id,
      target.action,
      target.params,
      target.files,
      target.priorSnapshot,
    );
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

  function hasFilePayload(e: DragEvent<HTMLElement>): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes("Files");
  }

  function handleDragEnter(e: DragEvent<HTMLElement>) {
    if (!canAttach || !hasFilePayload(e)) return;
    e.preventDefault();
    dragDepthRef.current++;
    setIsDragging(true);
  }

  function handleDragOver(e: DragEvent<HTMLElement>) {
    if (!canAttach || !hasFilePayload(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(e: DragEvent<HTMLElement>) {
    if (!canAttach) return;
    if (dragDepthRef.current > 0) dragDepthRef.current--;
    if (dragDepthRef.current === 0 || !e.currentTarget.contains(e.relatedTarget as Node | null)) {
      dragDepthRef.current = 0;
      setIsDragging(false);
    }
  }

  function handleDrop(e: DragEvent<HTMLElement>) {
    if (!canAttach || !hasFilePayload(e)) return;
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

  const showSkeleton =
    loading && unifiedItems.length === 0 && inflightOai.length === 0 && !loadError;
  const hasContent = unifiedItems.length > 0 || inflightOai.length > 0;

  return (
    <section
      className="room-pane fade"
      aria-label={t("convRoom.aria", { title: conversation.title })}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && canAttach && (
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
          const subtitle =
            p.kind === "muse"
              ? museEmailOf(liveMuse)
              : liveOai?.model?.trim() || null;
          return (
            <span
              key={`${p.kind}:${p.ref}`}
              className={`member-chip${deleted ? " deleted" : ""}`}
              title={deleted ? t("convRoom.deletedFromAdmin") : subtitle ?? undefined}
            >
              <i style={{ background: memberDotColor(idx) }} />
              <span className="member-chip-main">
                <span className="member-chip-top">
                  <span className="member-chip-name">{liveName}</span>
                  <span className={`agent-kind-tag ${p.kind}`}>
                    {p.kind === "muse" ? "Muse" : "OpenAI"}
                  </span>
                  {deleted && <span className="deleted-note">{t("convRoom.deletedTag")}</span>}
                </span>
                {subtitle && <span className="member-chip-sub">{subtitle}</span>}
              </span>
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
              timeLabel={it.timeLabel || undefined}
              copyValue={it.copyValue}
              footer={it.footer}
              statusText={it.statusText}
              after={
                it.retryTempId ? (
                  <div className="bubble-retry-row">
                    <button
                      type="button"
                      className="btn-ghost btn-sm bubble-retry-btn"
                      onClick={() => retrySend(it.retryTempId!)}
                    >
                      <RefreshIcon size={12} />
                      <span>{t("common.retry")}</span>
                    </button>
                  </div>
                ) : undefined
              }
            >
              {it.isTyping ? (
                <div
                  className="body typing-dots"
                  role="status"
                  aria-label={it.typingAria ?? t("convRoom.museTypingAria")}
                >
                  <span />
                  <span />
                  <span />
                </div>
              ) : it.errorText ? (
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
              {it.attachedFileNames && it.attachedFileNames.length > 0 && (
                <div className="statusline">
                  {t("dropbox.attachedFiles", { count: it.attachedFileNames.length })}:{" "}
                  {it.attachedFileNames.join(", ")}
                </div>
              )}
              {it.retryError && <div className="statusline err">{it.retryError}</div>}
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
              <div
                className="body typing-dots"
                role="status"
                aria-label={t("convRoom.generatingAria")}
              >
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
        allowAttachments={canAttach}
        files={attachedFiles}
        onFilesChange={setAttachedFiles}
        mentionNames={
          conversation.group_id
            ? museParticipants.map((p) => p.name)
            : undefined
        }
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
