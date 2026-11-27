import { useMemo, useState } from "react";
import { deleteConversation, deleteProject, removeProjectAgent } from "../../lib/api";
import { fmtTime, initialsOf, memberDotColor, type MuseFleetSummary } from "../../lib/format";
import { useLang, type I18nKey } from "../../lib/i18n";
import type {
  Conversation,
  ConversationMode,
  Muse,
  OpenAIAgent,
  Project,
  ProjectAgent,
} from "../../types";
import {
  BotIcon,
  ChevronRightIcon,
  MessageIcon,
  PanelRightIcon,
  PlusIcon,
  SettingsIcon,
  StarIcon,
  TrashIcon,
  UsersIcon,
} from "../common/Icons";
import { Chip, ErrorMsg, Modal, toast } from "../common/ui";

const MODE_KEY: Record<ConversationMode, I18nKey> = {
  muse_single: "convMode.muse_single",
  muse_group: "convMode.muse_group",
  openai: "convMode.openai",
  mixed: "convMode.mixed",
};

export function ProjectView(props: {
  project: Project;
  projectAgents: ProjectAgent[];
  conversations: Conversation[];
  muses: Muse[];
  openaiAgents: OpenAIAgent[];
  fleetSummary: Map<string, MuseFleetSummary>;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onEditProject: () => void;
  onNewConversation: () => void;
  onOpenConversation: (conversationId: string) => void;
  onProjectDeleted: (projectId: string) => void;
  onProjectAgentsChanged: () => void;
  onConversationsChanged: () => void;
}) {
  const { project, projectAgents, conversations, muses, openaiAgents, fleetSummary } = props;
  const { lang, t } = useLang();
  const [confirmDeleteProject, setConfirmDeleteProject] = useState(false);
  const [confirmDeleteConv, setConfirmDeleteConv] = useState<Conversation | null>(null);
  const [busy, setBusy] = useState(false);
  const [delErr, setDelErr] = useState("");

  const museMap = useMemo(() => new Map(muses.map((m) => [m.recipient, m])), [muses]);
  const oaiMap = useMemo(() => new Map(openaiAgents.map((a) => [a.id, a])), [openaiAgents]);

  async function handleRemoveAgent(pa: ProjectAgent) {
    const err = await removeProjectAgent(project.id, pa.agent_kind, pa.agent_ref);
    if (err) {
      toast(t("proj.removeAgentErr", { err }));
      return;
    }
    toast(t("proj.removeAgentOk", { name: pa.agent_name }));
    props.onProjectAgentsChanged();
  }

  async function handleConfirmDeleteProject() {
    if (busy) return;
    setBusy(true);
    setDelErr("");
    const err = await deleteProject(project.id);
    setBusy(false);
    if (err) {
      setDelErr(t("proj.delErr", { err }));
      return;
    }
    toast(t("proj.delOk"));
    setConfirmDeleteProject(false);
    props.onProjectDeleted(project.id);
  }

  async function handleConfirmDeleteConv() {
    if (!confirmDeleteConv || busy) return;
    setBusy(true);
    setDelErr("");
    const err = await deleteConversation(confirmDeleteConv.id, confirmDeleteConv.group_id);
    setBusy(false);
    if (err) {
      setDelErr(t("convRoom.delErr", { err }));
      return;
    }
    toast(t("convRoom.delToast"));
    setConfirmDeleteConv(null);
    props.onConversationsChanged();
  }

  return (
    <section className="overview-pane fade" aria-label={`Project ${project.name}`}>
      <div className="pane-head">
        <div className="pane-title-group">
          <h2>{project.name}</h2>
          <span className="sub">
            {t("proj.meta", {
              agents: projectAgents.length,
              convs: conversations.length,
              time: fmtTime(project.created_at, lang),
            })}
          </span>
        </div>
        <span className="grow" />
        <div className="pane-actions">
          <button type="button" className="btn" onClick={props.onNewConversation}>
            <PlusIcon size={14} />
            <span>{t("proj.newConv")}</span>
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={props.onEditProject}
            title={t("proj.settings")}
            aria-label={t("proj.settings")}
          >
            <SettingsIcon size={14} />
            <span className="hide-xs">{t("proj.settings")}</span>
          </button>
          <button
            type="button"
            className="btn-ghost danger-text"
            onClick={() => {
              setDelErr("");
              setConfirmDeleteProject(true);
            }}
            title={t("proj.delTitle")}
            aria-label={t("proj.delTitle")}
          >
            <TrashIcon size={14} />
            <span className="hide-xs">{t("common.delete")}</span>
          </button>
          <button
            type="button"
            className={`btn-ghost btn-inspector-toggle${props.inspectorOpen ? " active" : ""}`}
            onClick={props.onToggleInspector}
            aria-pressed={props.inspectorOpen}
            title={t("proj.toggleInfoTitle")}
            aria-label={t("proj.toggleInfoTitle")}
          >
            <PanelRightIcon size={15} />
            <span className="hide-xs">{t("common.details")}</span>
          </button>
        </div>
      </div>

      <div className="overview-scroll">
        {project.description && (
          <div className="project-desc-banner">{project.description}</div>
        )}

        {/* Assigned Agents */}
        <section className="ov-section" aria-label={t("proj.agentsAria")}>
          <div className="ov-section-head">
            <h3>{t("proj.agentsTitle", { count: projectAgents.length })}</h3>
            <button type="button" className="btn-ghost btn-sm" onClick={props.onEditProject}>
              <PlusIcon size={14} />
              <span>{t("proj.manageAgents")}</span>
            </button>
          </div>

          {projectAgents.length === 0 ? (
            <div className="ov-empty-card">
              <p>{t("proj.emptyAgents")}</p>
              <button type="button" className="btn-ghost" onClick={props.onEditProject}>
                <SettingsIcon size={14} />
                <span>{t("proj.pickAgents")}</span>
              </button>
            </div>
          ) : (
            <div className="project-agents-grid">
              {projectAgents.map((pa) => {
                const isMuse = pa.agent_kind === "muse";
                const liveMuse = isMuse ? museMap.get(pa.agent_ref) : undefined;
                const liveOai = !isMuse ? oaiMap.get(pa.agent_ref) : undefined;
                const displayName = liveMuse?.name ?? liveOai?.name ?? pa.agent_name;
                const summary = isMuse ? fleetSummary.get(pa.agent_ref) : undefined;
                const status = summary?.status ?? "idle";

                return (
                  <div key={pa.id} className="project-agent-card">
                    <div className="project-agent-top">
                      <span
                        className={`avatar-monogram ${isMuse ? `status-${status}` : "openai"}`}
                      >
                        {isMuse ? initialsOf(displayName) : <BotIcon size={15} />}
                      </span>
                      <div className="fleet-name-wrap">
                        <strong className="fleet-name">{displayName}</strong>
                        <span className="project-agent-sub">
                          <span className={`agent-kind-tag ${pa.agent_kind}`}>
                            {isMuse ? "Muse Relay" : "OpenAI"}
                          </span>
                          {liveOai?.model && <span className="agent-sub-code">{liveOai.model}</span>}
                          {liveMuse?.dropbox_root && (
                            <span className="agent-sub-code">{liveMuse.dropbox_root}</span>
                          )}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="btn-quiet danger-text"
                        title={t("proj.removeAgentAria", { name: displayName })}
                        aria-label={t("proj.removeAgentAria", { name: displayName })}
                        onClick={() => void handleRemoveAgent(pa)}
                      >
                        <TrashIcon size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Conversations */}
        <section className="ov-section" aria-label={t("proj.convsAria")}>
          <div className="ov-section-head">
            <div className="ov-section-title">
              <MessageIcon size={15} />
              <h3>{t("proj.convsTitle", { count: conversations.length })}</h3>
            </div>
            <button type="button" className="btn btn-sm" onClick={props.onNewConversation}>
              <PlusIcon size={14} />
              <span>{t("proj.newConv")}</span>
            </button>
          </div>

          {conversations.length === 0 ? (
            <div className="ov-empty-card">
              <p>{t("proj.emptyConvs")}</p>
              <button type="button" className="btn" onClick={props.onNewConversation}>
                <PlusIcon size={15} />
                <span>{t("proj.firstConv")}</span>
              </button>
            </div>
          ) : (
            <div className="conv-list">
              {conversations.map((c) => {
                return (
                  <div key={c.id} className="conv-row-wrap">
                    <button
                      type="button"
                      className="conv-row"
                      onClick={() => props.onOpenConversation(c.id)}
                    >
                      <span className={`conv-mode-icon mode-${c.mode}`}>
                        {c.mode === "muse_single" ? (
                          <StarIcon size={15} />
                        ) : c.mode === "muse_group" ? (
                          <UsersIcon size={15} />
                        ) : (
                          <BotIcon size={15} />
                        )}
                      </span>
                      <span className="conv-row-body">
                        <span className="conv-row-top">
                          <strong className="conv-row-title">{c.title}</strong>
                          <Chip state="idle" label={t(MODE_KEY[c.mode])} />
                          <span className="conv-row-time">{fmtTime(c.created_at, lang)}</span>
                        </span>
                        <span className="conv-row-parts">
                          {c.participants.map((p, idx) => {
                            const liveMuse = p.kind === "muse" ? museMap.get(p.ref) : undefined;
                            const liveOai = p.kind === "openai" ? oaiMap.get(p.ref) : undefined;
                            const liveName = liveMuse?.name ?? liveOai?.name ?? p.name;
                            const deleted = !liveMuse && !liveOai;
                            return (
                              <span
                                key={`${p.kind}:${p.ref}`}
                                className={`conv-part-pill${deleted ? " deleted" : ""}`}
                                title={deleted ? t("convRoom.deletedFromAdmin") : undefined}
                              >
                                <i style={{ background: memberDotColor(idx) }} />
                                <span>{liveName}</span>
                                {deleted && (
                                  <span className="deleted-note">({t("convRoom.deletedTag")})</span>
                                )}
                              </span>
                            );
                          })}
                        </span>
                      </span>
                      <ChevronRightIcon size={15} className="activity-arrow" />
                    </button>
                    <button
                      type="button"
                      className="btn-quiet conv-del-btn danger-text"
                      title={t("proj.delConvAria", { title: c.title })}
                      aria-label={t("proj.delConvAria", { title: c.title })}
                      onClick={() => {
                        setDelErr("");
                        setConfirmDeleteConv(c);
                      }}
                    >
                      <TrashIcon size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {confirmDeleteProject && (
        <Modal
          open
          onClose={() => setConfirmDeleteProject(false)}
          labelledBy="del-proj-title"
        >
          <h2 id="del-proj-title">{t("proj.delModalTitle", { name: project.name })}</h2>
          <p className="lead">{t("proj.delLead")}</p>
          <ErrorMsg text={delErr} />
          <div className="actions">
            <button
              type="button"
              className={`btn btn-danger${busy ? " is-loading" : ""}`}
              disabled={busy}
              onClick={handleConfirmDeleteProject}
            >
              {busy ? t("common.deleting") : t("proj.delTitle")}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setConfirmDeleteProject(false)}
            >
              {t("common.keep")}
            </button>
          </div>
        </Modal>
      )}

      {confirmDeleteConv && (
        <Modal
          open
          onClose={() => setConfirmDeleteConv(null)}
          labelledBy="del-conv-title"
        >
          <h2 id="del-conv-title">
            {t("convRoom.delModalTitle", { title: confirmDeleteConv.title })}
          </h2>
          <p className="lead">{t("proj.delConvLead")}</p>
          <ErrorMsg text={delErr} />
          <div className="actions">
            <button
              type="button"
              className={`btn btn-danger${busy ? " is-loading" : ""}`}
              disabled={busy}
              onClick={handleConfirmDeleteConv}
            >
              {busy ? t("common.deleting") : t("convRoom.delConfirm")}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setConfirmDeleteConv(null)}
            >
              {t("common.keep")}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
