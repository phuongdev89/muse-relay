import { useEffect } from "react";
import { fileName, resourceLabel } from "../../lib/dropbox";
import {
  fmtRelativeAge,
  fmtTime,
  initialsOf,
  memberDotColor,
  museConnectionInfo,
  type MuseFleetSummary,
} from "../../lib/format";
import { useLang, type I18nKey } from "../../lib/i18n";
import type {
  ActiveRoom,
  Conversation,
  ConversationMode,
  Muse,
  OpenAIAgent,
  Project,
  ProjectAgent,
} from "../../types";
import {
  BotIcon,
  CopyIcon,
  EditIcon,
  FolderIcon,
  KeyIcon,
  LayersIcon,
  MessageIcon,
  PlusIcon,
  ResourceKindIcon,
  SettingsIcon,
  TrashIcon,
  XIcon,
} from "../common/Icons";
import { Chip, copyText } from "../common/ui";

const STATUS_KEY: Record<string, I18nKey> = {
  processing: "chip.processing",
  pending: "chip.pending",
  error: "ov.kpiErrors",
  idle: "chip.idle",
};

const STATUS_CHIP: Record<string, string> = {
  processing: "processing",
  pending: "pending",
  error: "failed",
  idle: "idle",
};

const MODE_LABEL_KEY: Record<ConversationMode, I18nKey> = {
  muse_single: "insp.modeLabel.muse_single",
  muse_group: "insp.modeLabel.muse_group",
  openai: "insp.modeLabel.openai",
  mixed: "insp.modeLabel.mixed",
};

const MODE_DESC_KEY: Record<ConversationMode, I18nKey> = {
  muse_single: "insp.modeDesc.muse_single",
  muse_group: "insp.modeDesc.muse_group",
  openai: "insp.modeDesc.openai",
  mixed: "insp.modeDesc.mixed",
};

export function InspectorPanel(props: {
  desktopOpen: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  active: ActiveRoom;
  muse: Muse | null;
  museSummary: MuseFleetSummary | null;
  musesCount: number;
  openaiCount: number;
  project: Project | null;
  projectAgents: ProjectAgent[];
  projectConversationsCount: number;
  conversation: Conversation | null;
  muses: Muse[];
  openaiAgents: OpenAIAgent[];
  threadPaths: string[];
  onMuseAction: (action: "edit" | "rotate" | "delete" | "clear") => void;
  onEditProject?: () => void;
  onNewConversation?: () => void;
}) {
  const {
    desktopOpen,
    mobileOpen,
    onCloseMobile,
    active,
    muse,
    museSummary,
    project,
    projectAgents,
    projectConversationsCount,
    conversation,
    muses,
    openaiAgents,
    threadPaths,
  } = props;
  const { t } = useLang();

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseMobile();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileOpen, onCloseMobile]);

  const panelClass = `inspector${desktopOpen ? " desktop-open" : " desktop-closed"}${mobileOpen ? " mobile-open" : ""}`;

  const title =
    active?.kind === "agents"
      ? t("insp.titleAgents")
      : conversation
        ? t("insp.titleConv")
        : project && active?.kind === "project"
          ? t("insp.titleProj")
          : muse
            ? t("insp.titleMuse")
            : t("insp.titleOverview");

  return (
    <>
      {mobileOpen && (
        <div
          className="drawer-scrim inspector-scrim"
          aria-hidden="true"
          onClick={onCloseMobile}
        />
      )}
      <aside className={panelClass} aria-label={t("insp.aria")}>
        <div className="inspector-head">
          <span className="inspector-title">{title}</span>
          <button
            type="button"
            className="btn-quiet inspector-close"
            onClick={onCloseMobile}
            aria-label={t("insp.closeAria")}
          >
            <XIcon size={16} />
          </button>
        </div>

        <div className="inspector-body">
          {active?.kind === "agents" ? (
            <AgentsInspector musesCount={props.musesCount} openaiCount={props.openaiCount} />
          ) : conversation && project ? (
            <ConversationInspector
              project={project}
              conversation={conversation}
              muses={muses}
              openaiAgents={openaiAgents}
              paths={threadPaths}
            />
          ) : project && active?.kind === "project" ? (
            <ProjectInspector
              project={project}
              projectAgents={projectAgents}
              conversationsCount={projectConversationsCount}
              muses={muses}
              openaiAgents={openaiAgents}
              onEditProject={() => {
                onCloseMobile();
                props.onEditProject?.();
              }}
              onNewConversation={() => {
                onCloseMobile();
                props.onNewConversation?.();
              }}
            />
          ) : muse ? (
            <MuseInspector
              muse={muse}
              summary={museSummary}
              paths={threadPaths}
              onAction={props.onMuseAction}
            />
          ) : (
            <OverviewInspector />
          )}
        </div>
      </aside>
    </>
  );
}

function AgentsInspector({
  musesCount,
  openaiCount,
}: {
  musesCount: number;
  openaiCount: number;
}) {
  const { t } = useLang();
  return (
    <>
      <div className="insp-card insp-identity">
        <span className="avatar-monogram lg group">
          <BotIcon size={18} />
        </span>
        <div className="insp-identity-info">
          <strong className="insp-name">{t("insp.registryTitle")}</strong>
          <span className="insp-sub">
            {t("agents.sub", { muses: musesCount, openai: openaiCount })}
          </span>
        </div>
      </div>

      <div className="insp-section">
        <span className="insp-label">{t("insp.museAsyncLabel")}</span>
        <div className="insp-note-box">
          {t("insp.museAsyncBody1")} <code>recipient</code> {t("insp.museAsyncBody2")}{" "}
          <code>RELAY_TOKEN</code> {t("insp.museAsyncBody3")}
        </div>
      </div>

      <div className="insp-section">
        <span className="insp-label">{t("insp.oaiDirectLabel")}</span>
        <div className="insp-note-box">
          {t("insp.oaiDirectBody1")} <code>{"{base_url}/chat/completions"}</code>{" "}
          {t("insp.oaiDirectBody2")}
        </div>
      </div>

      <div className="insp-section">
        <span className="insp-label">{t("insp.deleteNoteLabel")}</span>
        <div className="insp-note-box">
          {t("insp.deleteNoteBody1")} <strong>Project</strong> {t("insp.deleteNoteBody2")}
        </div>
      </div>
    </>
  );
}

function ProjectInspector(props: {
  project: Project;
  projectAgents: ProjectAgent[];
  conversationsCount: number;
  muses: Muse[];
  openaiAgents: OpenAIAgent[];
  onEditProject: () => void;
  onNewConversation: () => void;
}) {
  const { project, projectAgents, conversationsCount, muses, openaiAgents } = props;
  const { lang, t } = useLang();
  const museMap = new Map(muses.map((m) => [m.recipient, m]));
  const oaiMap = new Map(openaiAgents.map((a) => [a.id, a]));

  return (
    <>
      <div className="insp-card insp-identity">
        <span className="avatar-monogram lg group">
          <LayersIcon size={18} />
        </span>
        <div className="insp-identity-info">
          <strong className="insp-name">{project.name}</strong>
          <span className="insp-sub">
            {t("insp.projMeta", { agents: projectAgents.length, convs: conversationsCount })}
          </span>
        </div>
      </div>

      {project.description && (
        <div className="insp-section">
          <span className="insp-label">{t("insp.projDesc")}</span>
          <div className="insp-note-box">{project.description}</div>
        </div>
      )}

      <div className="insp-section">
        <span className="insp-label">{t("insp.info")}</span>
        <div className="insp-kv">
          <span className="insp-k">{t("insp.projId")}</span>
          <div className="insp-copy-row">
            <code className="insp-code">{project.id}</code>
            <button
              type="button"
              className="btn-quiet btn-icon-copy"
              title={t("insp.projId")}
              aria-label={t("insp.projId")}
              onClick={() => copyText(project.id, t("insp.copyProjId"))}
            >
              <CopyIcon size={13} />
            </button>
          </div>
        </div>
        <div className="insp-kv">
          <span className="insp-k">{t("insp.createdDate")}</span>
          <span className="insp-v">{fmtTime(project.created_at, lang)}</span>
        </div>
      </div>

      <div className="insp-section">
        <span className="insp-label">
          {t("insp.assignedAgents", { count: projectAgents.length })}
        </span>
        {projectAgents.length === 0 ? (
          <p className="insp-empty">{t("insp.noAssignedAgents")}</p>
        ) : (
          <div className="insp-member-list">
            {projectAgents.map((pa, i) => {
              const liveName =
                pa.agent_kind === "muse"
                  ? museMap.get(pa.agent_ref)?.name ?? pa.agent_name
                  : oaiMap.get(pa.agent_ref)?.name ?? pa.agent_name;
              return (
                <div key={pa.id} className="insp-member-row">
                  <span className="insp-member-dot" style={{ background: memberDotColor(i) }} />
                  <div className="insp-member-meta">
                    <span className="insp-member-name">{liveName}</span>
                    <code className="insp-member-id">
                      {pa.agent_kind === "muse" ? "Muse Relay" : "OpenAI"} · {pa.agent_ref}
                    </code>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="insp-section">
        <span className="insp-label">{t("insp.quickActions")}</span>
        <div className="insp-actions">
          <button type="button" className="btn-ghost insp-action-btn" onClick={props.onNewConversation}>
            <PlusIcon size={14} />
            <span>{t("sidebar.newConv")}</span>
          </button>
          <button type="button" className="btn-ghost insp-action-btn" onClick={props.onEditProject}>
            <SettingsIcon size={14} />
            <span>{t("sidebar.projSettings")}</span>
          </button>
        </div>
      </div>
    </>
  );
}

function ConversationInspector(props: {
  project: Project;
  conversation: Conversation;
  muses: Muse[];
  openaiAgents: OpenAIAgent[];
  paths: string[];
}) {
  const { project, conversation, muses, openaiAgents, paths } = props;
  const { lang, t } = useLang();
  const museMap = new Map(muses.map((m) => [m.recipient, m]));
  const oaiMap = new Map(openaiAgents.map((a) => [a.id, a]));

  return (
    <>
      <div className="insp-card insp-identity">
        <span className="avatar-monogram lg group">
          <MessageIcon size={18} />
        </span>
        <div className="insp-identity-info">
          <strong className="insp-name">{conversation.title}</strong>
          <span className="insp-sub">
            {project.name} · {fmtTime(conversation.created_at, lang)}
          </span>
        </div>
      </div>

      <div className="insp-section">
        <span className="insp-label">{t("insp.opMode")}</span>
        <div className="insp-note-box">
          <strong>{t(MODE_LABEL_KEY[conversation.mode])}</strong>
          <p>{t(MODE_DESC_KEY[conversation.mode])}</p>
        </div>
      </div>

      <div className="insp-section">
        <span className="insp-label">
          {t("insp.participants", { count: conversation.participants.length })}
        </span>
        <div className="insp-member-list">
          {conversation.participants.map((p, i) => {
            const liveMuse = p.kind === "muse" ? museMap.get(p.ref) : undefined;
            const liveOai = p.kind === "openai" ? oaiMap.get(p.ref) : undefined;
            const displayName = liveMuse?.name ?? liveOai?.name ?? p.name;
            const deleted = !liveMuse && !liveOai;
            return (
              <div key={`${p.kind}:${p.ref}`} className="insp-member-row">
                <span className="insp-member-dot" style={{ background: memberDotColor(i) }} />
                <div className="insp-member-meta">
                  <span className="insp-member-name">
                    {displayName}
                    {deleted && (
                      <span className="deleted-note"> ({t("convRoom.deletedTag")})</span>
                    )}
                  </span>
                  <code className="insp-member-id">
                    {p.kind === "muse"
                      ? `Muse · ${liveMuse?.dropbox_root || p.ref}`
                      : `OpenAI · ${liveOai?.model || p.ref}`}
                  </code>
                </div>
                <button
                  type="button"
                  className="btn-quiet btn-icon-copy"
                  title={t("insp.copyIdAria", { name: displayName })}
                  aria-label={t("insp.copyIdAria", { name: displayName })}
                  onClick={() => copyText(p.ref, t("insp.copyIdToast", { name: displayName }))}
                >
                  <CopyIcon size={13} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {conversation.mode !== "openai" && (
        <div className="insp-section">
          <span className="insp-label">{t("insp.dropboxFiles", { count: paths.length })}</span>
          <InspectorFileList paths={paths} emptyText={t("insp.noFilesConv")} />
        </div>
      )}
    </>
  );
}

function MuseInspector(props: {
  muse: Muse;
  summary: MuseFleetSummary | null;
  paths: string[];
  onAction: (action: "edit" | "rotate" | "delete" | "clear") => void;
}) {
  const { muse, summary, paths } = props;
  const { lang, t } = useLang();
  const status = summary?.status ?? "idle";
  const conn = museConnectionInfo(muse, lang);

  return (
    <>
      <div className="insp-card insp-identity">
        <span className={`avatar-monogram lg status-${status}`}>
          {initialsOf(muse.name)}
        </span>
        <div className="insp-identity-info">
          <strong className="insp-name">{muse.name}</strong>
          <div className="insp-chip-row">
            <Chip state={conn.chipClass} label={conn.label} />
            <Chip state={STATUS_CHIP[status]} label={t(STATUS_KEY[status])} />
          </div>
        </div>
      </div>

      <div className="insp-section">
        <span className="insp-label">{t("insp.telemetry")}</span>
        <div className="insp-telemetry-list">
          <div className="insp-kv">
            <span className="insp-k">{t("insp.setupState")}</span>
            <span className="insp-v">
              {conn.setupDone ? t("insp.setupDone") : t("insp.setupPending")}
            </span>
          </div>
          <div className="insp-kv">
            <span className="insp-k">{t("insp.firstConnected")}</span>
            <span className="insp-v">
              {muse.first_connected_at
                ? `${fmtTime(muse.first_connected_at, lang)} · ${fmtRelativeAge(muse.first_connected_at, lang)}`
                : t("insp.notConnected")}
            </span>
          </div>
          <div className="insp-kv">
            <span className="insp-k">{t("insp.lastPoll")}</span>
            <span className="insp-v">
              {muse.last_claim_at
                ? `${fmtTime(muse.last_claim_at, lang)} · ${fmtRelativeAge(muse.last_claim_at, lang)}`
                : t("common.none")}
            </span>
          </div>
          <div className="insp-kv">
            <span className="insp-k">{t("insp.lastResult")}</span>
            <span className="insp-v">
              {muse.last_result_at
                ? `${fmtTime(muse.last_result_at, lang)} · ${fmtRelativeAge(muse.last_result_at, lang)}`
                : t("common.none")}
            </span>
          </div>
          <div className="insp-kv">
            <span className="insp-k">{t("insp.lastRotated")}</span>
            <span className="insp-v">
              {muse.token_rotated_at
                ? `${fmtTime(muse.token_rotated_at, lang)} · ${fmtRelativeAge(muse.token_rotated_at, lang)}`
                : t("insp.neverRotated")}
            </span>
          </div>
        </div>
      </div>

      <div className="insp-section">
        <span className="insp-label">{t("insp.identityFolder")}</span>
        <div className="insp-kv">
          <span className="insp-k">{t("insp.recipientUuid")}</span>
          <div className="insp-copy-row">
            <code className="insp-code">{muse.recipient}</code>
            <button
              type="button"
              className="btn-quiet btn-icon-copy"
              title={t("insp.recipientUuid")}
              aria-label={t("insp.recipientUuid")}
              onClick={() => copyText(muse.recipient, t("agents.copyUuidToast"))}
            >
              <CopyIcon size={13} />
            </button>
          </div>
        </div>

        <div className="insp-kv">
          <span className="insp-k">{t("agents.metaDropbox")}</span>
          <div className="insp-copy-row">
            <code className="insp-code">{muse.dropbox_root || "/"}</code>
            {muse.dropbox_root && (
              <button
                type="button"
                className="btn-quiet btn-icon-copy"
                title={t("agents.metaDropbox")}
                aria-label={t("agents.metaDropbox")}
                onClick={() => copyText(muse.dropbox_root, t("insp.copyRootToast"))}
              >
                <CopyIcon size={13} />
              </button>
            )}
          </div>
        </div>

        {muse.email_owner && (
          <div className="insp-kv">
            <span className="insp-k">{t("insp.ownerEmail")}</span>
            <span className="insp-v">{muse.email_owner}</span>
          </div>
        )}

        <div className="insp-kv">
          <span className="insp-k">{t("insp.createdDate")}</span>
          <span className="insp-v">{fmtTime(muse.created_at, lang)}</span>
        </div>
      </div>

      <div className="insp-section">
        <span className="insp-label">{t("insp.dropboxFiles", { count: paths.length })}</span>
        <InspectorFileList paths={paths} emptyText={t("insp.noFilesThread")} />
      </div>

      <div className="insp-section">
        <span className="insp-label">{t("insp.quickActions")}</span>
        <div className="insp-actions">
          <button type="button" className="btn-ghost insp-action-btn" onClick={() => props.onAction("edit")}>
            <EditIcon size={14} />
            <span>{t("insp.editMuse")}</span>
          </button>
          <button type="button" className="btn-ghost insp-action-btn" onClick={() => props.onAction("rotate")}>
            <KeyIcon size={14} />
            <span>{t("insp.rotateToken")}</span>
          </button>
          <button
            type="button"
            className="btn-ghost insp-action-btn danger"
            onClick={() => props.onAction("clear")}
          >
            <TrashIcon size={14} />
            <span>{t("insp.clearChannel")}</span>
          </button>
          <button
            type="button"
            className="btn-ghost insp-action-btn danger"
            onClick={() => props.onAction("delete")}
          >
            <TrashIcon size={14} />
            <span>{t("insp.deleteMuse")}</span>
          </button>
        </div>
      </div>
    </>
  );
}

function OverviewInspector() {
  const { t } = useLang();
  return (
    <>
      <div className="insp-section">
        <span className="insp-label">{t("insp.ovGuideTitle")}</span>
        <ol className="insp-guide-list">
          <li>
            <strong>{t("insp.ovStep1Title")}</strong> {t("insp.ovStep1Body")}
          </li>
          <li>
            <strong>{t("insp.ovStep2Title")}</strong> {t("insp.ovStep2Body")}
          </li>
          <li>
            <strong>{t("insp.ovStep3Title")}</strong> {t("insp.ovStep3Body")}
          </li>
        </ol>
      </div>

      <div className="insp-section">
        <span className="insp-label">{t("insp.ovDropboxTitle")}</span>
        <div className="insp-note-box">
          <div className="insp-note-line">
            <FolderIcon size={14} />
            <span>
              {t("insp.ovDropboxLine")} <code>/&lt;email&gt;/</code>.
            </span>
          </div>
          <p>{t("insp.ovDropboxNote")}</p>
        </div>
      </div>
    </>
  );
}

function InspectorFileList({ paths, emptyText }: { paths: string[]; emptyText: string }) {
  const { lang, t } = useLang();
  if (paths.length === 0) {
    return <p className="insp-empty">{emptyText}</p>;
  }
  return (
    <div className="insp-files">
      {paths.map((p) => (
        <div key={p} className="insp-file-item">
          <span className="insp-file-icon">
            <ResourceKindIcon path={p} size={15} />
          </span>
          <div className="insp-file-info">
            <span className="insp-file-name" title={fileName(p)}>{fileName(p)}</span>
            <span className="insp-file-kind">{resourceLabel(p, lang)}</span>
            <code className="insp-file-path">{p}</code>
          </div>
          <button
            type="button"
            className="btn-quiet btn-icon-copy"
            title={t("res.copyPathTitle")}
            aria-label={t("res.copyPathAria", { name: fileName(p) })}
            onClick={() => copyText(p, t("res.copyPathToast"))}
          >
            <CopyIcon size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
