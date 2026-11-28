import { useMemo, useState } from "react";
import { createConversation, createGroup, deleteGroup } from "../../lib/api";
import { useLang, type I18nKey } from "../../lib/i18n";
import type {
  Conversation,
  ConversationMode,
  ConversationParticipant,
  Muse,
  OpenAIAgent,
  Project,
  ProjectAgent,
} from "../../types";
import { ErrorMsg, Modal, toast } from "../common/ui";

const MODE_HINT_KEY: Record<ConversationMode, I18nKey> = {
  muse_single: "modeHint.muse_single",
  muse_group: "modeHint.muse_group",
  openai: "modeHint.openai",
  mixed: "modeHint.mixed",
};

/** Prefilled group rules (system prompt) for new group conversations.
 * Word choice matters: this text is fed to the agents themselves — address
 * them as "agent", never "Muse"/"bot" (each believes it is the only one). */
export const DEFAULT_GROUP_RULES = [
  "QUY CHẾ NHÓM (system prompt). Bạn là một agent thành viên của nhóm chat này, cùng Owner (người điều phối) và các agent thành viên khác.",
  "- Chỉ trả lời khi bạn được @-gọi (@Tên của bạn, hoặc @all — chỉ Owner được dùng). Không được @-gọi thì im lặng, không gửi gì cả.",
  "- Mỗi câu trả lời chỉ được @-gọi TỐI ĐA MỘT agent khác: đúng @Tên, không tự gọi chính mình, không gọi nhiều agent trong một output. Cần nhiều người tham gia thì @ đúng một agent điều phối, hoặc kết luận cho Owner rồi dừng.",
  "- Trả lời ngắn gọn, đúng việc được hỏi; không xã giao dài dòng, không lặp lại nội dung agent khác đã nói.",
  "- Tôn trọng lượt đi: chưa được @-gọi thì không spam, không nhắc lại câu cũ, không tự mở đề tài mới.",
  "- Nếu claim có reference_dropbox_paths: đó là tài nguyên Owner/agent khác chuyển cho bạn qua cầu relay, file nằm trong Dropbox của bạn — tải trực tiếp và dùng làm ngữ cảnh.",
].join("\n");

function resolveConversationMode(
  participants: ConversationParticipant[],
): ConversationMode | null {
  if (participants.length === 0) return null;
  const museCount = participants.filter((p) => p.kind === "muse").length;
  const openaiCount = participants.filter((p) => p.kind === "openai").length;
  if (museCount === 1 && openaiCount === 0) return "muse_single";
  if (museCount >= 2 && openaiCount === 0) return "muse_group";
  if (museCount === 0 && openaiCount >= 1) return "openai";
  return "mixed";
}

export function NewConversationModal(props: {
  project: Project;
  projectAgents: ProjectAgent[];
  muses: Muse[];
  openaiAgents: OpenAIAgent[];
  onClose: () => void;
  onEditProjectAgents?: () => void;
  onCreated: (conversation: Conversation) => void;
}) {
  const { t } = useLang();
  const [title, setTitle] = useState("");
  const [rules, setRules] = useState<string>(DEFAULT_GROUP_RULES);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const availableAgents = useMemo(() => {
    const museMap = new Map(props.muses.map((m) => [m.recipient, m]));
    const oaiMap = new Map(props.openaiAgents.map((a) => [a.id, a]));
    return props.projectAgents.map((pa) => {
      if (pa.agent_kind === "muse") {
        const m = museMap.get(pa.agent_ref);
        return {
          kind: "muse" as const,
          ref: pa.agent_ref,
          name: m?.name ?? pa.agent_name,
          sub: m?.dropbox_root || "Muse Relay",
        };
      }
      const a = oaiMap.get(pa.agent_ref);
      return {
        kind: "openai" as const,
        ref: pa.agent_ref,
        name: a?.name ?? pa.agent_name,
        sub: a?.model ?? "OpenAI Compatible",
      };
    });
  }, [props.projectAgents, props.muses, props.openaiAgents]);

  const [picked, setPicked] = useState<Map<string, ConversationParticipant>>(() => {
    const init = new Map<string, ConversationParticipant>();
    if (availableAgents.length === 1) {
      const only = availableAgents[0];
      init.set(`${only.kind}:${only.ref}`, {
        kind: only.kind,
        ref: only.ref,
        name: only.name,
      });
    }
    return init;
  });

  function toggle(item: { kind: "muse" | "openai"; ref: string; name: string }) {
    const key = `${item.kind}:${item.ref}`;
    setPicked((cur) => {
      const next = new Map(cur);
      if (next.has(key)) next.delete(key);
      else next.set(key, { kind: item.kind, ref: item.ref, name: item.name });
      return next;
    });
  }

  const participants = [...picked.values()];
  const resolvedMode = resolveConversationMode(participants);
  const museParticipants = participants.filter((p) => p.kind === "muse");
  /** group conversations (muse_group / mixed with muses) create a relay group */
  const willCreateGroup =
    museParticipants.length >= 2 ||
    (resolvedMode === "mixed" && museParticipants.length >= 1);

  async function submit() {
    if (saving) return;
    setError("");
    const trimmed = title.trim();
    if (trimmed.length < 1 || trimmed.length > 80) {
      setError(t("newConv.titleErr"));
      return;
    }
    if (!resolvedMode) {
      setError(t("newConv.pickErr"));
      return;
    }

    setSaving(true);
    let groupId: string | null = null;

    if (willCreateGroup) {
      const groupName = trimmed.slice(0, 64);
      const { id, error: gErr } = await createGroup(
        groupName,
        museParticipants.map((m) => ({
          muse_recipient: m.ref,
          name: m.name.slice(0, 64),
        })),
        rules,
      );
      if (gErr || !id) {
        setSaving(false);
        setError(t("newConv.groupErr", { err: gErr ?? t("common.unknown") }));
        return;
      }
      groupId = id;
    }

    const { data, error: cErr } = await createConversation({
      project_id: props.project.id,
      title: trimmed,
      mode: resolvedMode,
      group_id: groupId,
      participants,
    });
    setSaving(false);

    if (cErr || !data) {
      if (groupId) {
        await deleteGroup(groupId);
      }
      setError(t("newConv.createErr", { err: cErr ?? t("common.unknown") }));
      return;
    }

    toast(t("newConv.createdToast"));
    props.onCreated(data);
    props.onClose();
  }

  return (
    <Modal open onClose={props.onClose} labelledBy="new-conv-title">
      <h2 id="new-conv-title">{t("newConv.title", { name: props.project.name })}</h2>
      <p className="lead">{t("newConv.lead")}</p>

      <label htmlFor="conv-title">{t("newConv.titleLabel")}</label>
      <input
        id="conv-title"
        value={title}
        maxLength={80}
        placeholder={t("newConv.titlePlaceholder")}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
      />

      <label>{t("newConv.agentsLabel", { count: participants.length })}</label>
      <div className="check-list">
        {availableAgents.map((item) => {
          const key = `${item.kind}:${item.ref}`;
          return (
            <label key={key} className="check-item check-item-split">
              <span className="check-item-left">
                <input
                  type="checkbox"
                  checked={picked.has(key)}
                  onChange={() => toggle(item)}
                />
                <span className="check-item-name">{item.name}</span>
              </span>
              <span className="check-item-right">
                <span className={`agent-kind-tag ${item.kind}`}>
                  {item.kind === "muse" ? "Muse" : "OpenAI"}
                </span>
                <span className="check-item-sub">{item.sub}</span>
              </span>
            </label>
          );
        })}
        {availableAgents.length === 0 && (
          <div className="empty-inline-box">
            <span className="hint">{t("newConv.emptyAgents")}</span>
            {props.onEditProjectAgents && (
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => {
                  props.onClose();
                  props.onEditProjectAgents?.();
                }}
              >
                {t("newConv.assignBtn")}
              </button>
            )}
          </div>
        )}
      </div>

      {resolvedMode && (
        <div className="mode-preview-box">
          <strong>{t("newConv.modeDetected")}</strong> {t(MODE_HINT_KEY[resolvedMode])}
        </div>
      )}

      {/* Group rules (system prompt) — only for conversations that create a
       * linked relay group; hidden for muse_single / openai modes. */}
      {willCreateGroup && (
        <div className="new-conv-rules">
          <label htmlFor="conv-group-rules">{t("newConv.rulesLabel")}</label>
          <textarea
            id="conv-group-rules"
            rows={7}
            value={rules}
            placeholder={t("group.systemPromptPlaceholder")}
            onChange={(e) => setRules(e.target.value)}
          />
          <span className="hint">{t("newConv.rulesHint")}</span>
        </div>
      )}

      <ErrorMsg text={error} />
      <div className="actions">
        <button
          type="button"
          className={`btn${saving ? " is-loading" : ""}`}
          disabled={saving || availableAgents.length === 0}
          onClick={submit}
        >
          {saving ? t("newConv.creating") : t("newConv.startBtn")}
        </button>
        <button type="button" className="btn-ghost" onClick={props.onClose}>
          {t("common.cancel")}
        </button>
      </div>
    </Modal>
  );
}
