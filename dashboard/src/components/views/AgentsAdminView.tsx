import { useMemo, useState } from "react";
import { testOpenAIAgentConnection } from "../../lib/api";
import {
  fmtRelativeAge,
  fmtTime,
  initialsOf,
  museConnectionInfo,
  type MuseFleetSummary,
} from "../../lib/format";
import { useLang } from "../../lib/i18n";
import type { Muse, OpenAIAgent, ProjectAgent } from "../../types";
import {
  BotIcon,
  CheckIcon,
  CopyIcon,
  EditIcon,
  KeyIcon,
  MessageIcon,
  PanelRightIcon,
  PlugIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  StarIcon,
  TrashIcon,
  XIcon,
} from "../common/Icons";
import { DeleteDialog, RenameDialog, RotateDialog } from "../modals/MuseManage";
import { DeleteOpenAIDialog, OpenAIAgentModal } from "../modals/OpenAIAgentModal";
import { Chip, copyText } from "../common/ui";

type AgentFilter = "all" | "muse" | "openai";

interface ConnectionTestState {
  testing: boolean;
  ok?: boolean;
  latencyMs?: number;
  reply?: string;
  error?: string;
}

function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "••••••••";
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
}

function truncateUuid(uuid: string): string {
  if (uuid.length <= 14) return uuid;
  return `${uuid.slice(0, 8)}…${uuid.slice(-4)}`;
}

type PipeTone = "done" | "busy" | "wait" | "bad" | "muted";

function PipeNode({
  label,
  tone,
  checked,
}: {
  label: string;
  tone: PipeTone;
  checked?: boolean;
}) {
  return (
    <span className={`pipe-step tone-${tone}`}>
      <span className="pipe-node" aria-hidden="true">
        {checked ? <CheckIcon size={10} /> : <span className="pipe-dot" />}
      </span>
      <span className="pipe-label">{label}</span>
    </span>
  );
}

export function AgentsAdminView(props: {
  muses: Muse[];
  openaiAgents: OpenAIAgent[];
  projectAgents: ProjectAgent[];
  fleetSummary: Map<string, MuseFleetSummary>;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onRefresh: () => void;
  onAddMuse: () => void;
  onOpenMuseRoom: (recipient: string) => void;
  onMuseRenamed: (recipient: string, name: string) => void;
  onMuseRotated?: () => void;
  onMuseDeleted: (recipient: string) => void;
  onOpenAIChanged: () => void;
}) {
  const { muses, openaiAgents, projectAgents, fleetSummary } = props;
  const { lang, t } = useLang();
  const [filter, setFilter] = useState<AgentFilter>("all");
  const [query, setQuery] = useState("");

  // Muse dialogs
  const [museAction, setMuseAction] = useState<{
    muse: Muse;
    kind: "rename" | "rotate" | "delete";
  } | null>(null);

  // OpenAI dialogs
  const [oaiModal, setOaiModal] = useState<{ open: boolean; agent: OpenAIAgent | null }>({
    open: false,
    agent: null,
  });
  const [oaiDelete, setOaiDelete] = useState<OpenAIAgent | null>(null);

  // Per-agent connection test state
  const [testResults, setTestResults] = useState<Record<string, ConnectionTestState>>({});

  // Count how many projects each agent is assigned to
  const projectCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const pa of projectAgents) {
      const k = `${pa.agent_kind}:${pa.agent_ref}`;
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return map;
  }, [projectAgents]);

  // Fleet KPI metrics
  const fleetMetrics = useMemo(() => {
    let live = 0;
    let standby = 0;
    let notSetup = 0;
    let reconnecting = 0;
    let offline = 0;

    for (const m of muses) {
      const c = museConnectionInfo(m, lang);
      if (c.state === "live") live++;
      else if (c.state === "standby") standby++;
      else if (c.state === "not_setup") notSetup++;
      else if (c.state === "reconnecting") reconnecting++;
      else offline++;
    }

    let testedOk = 0;
    for (const a of openaiAgents) {
      if (testResults[a.id]?.ok) testedOk++;
    }

    return {
      live,
      standby,
      pendingOrOffline: notSetup + reconnecting + offline,
      notSetup: notSetup + reconnecting,
      offline,
      testedOk,
    };
  }, [muses, openaiAgents, testResults, lang]);

  const q = query.trim().toLowerCase();

  const filteredMuses = useMemo(() => {
    if (filter === "openai") return [];
    if (!q) return muses;
    return muses.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.recipient.toLowerCase().includes(q) ||
        m.dropbox_root.toLowerCase().includes(q) ||
        (m.email_owner ?? "").toLowerCase().includes(q),
    );
  }, [muses, filter, q]);

  const filteredOpenAI = useMemo(() => {
    if (filter === "muse") return [];
    if (!q) return openaiAgents;
    return openaiAgents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.model.toLowerCase().includes(q) ||
        a.base_url.toLowerCase().includes(q) ||
        a.system_prompt.toLowerCase().includes(q),
    );
  }, [openaiAgents, filter, q]);

  async function runConnectionTest(agent: OpenAIAgent) {
    setTestResults((cur) => ({ ...cur, [agent.id]: { testing: true } }));
    const res = await testOpenAIAgentConnection(agent);
    setTestResults((cur) => ({
      ...cur,
      [agent.id]: {
        testing: false,
        ok: res.ok,
        latencyMs: res.latencyMs,
        reply: res.reply,
        error: res.error,
      },
    }));
  }

  const totalCount = muses.length + openaiAgents.length;
  const visibleCount = filteredMuses.length + filteredOpenAI.length;

  return (
    <section className="admin-pane fade" aria-label={t("agents.aria")}>
      <div className="pane-head">
        <div className="pane-title-group">
          <h2>{t("agents.title")}</h2>
          <span className="sub">
            {t("agents.sub", { muses: muses.length, openai: openaiAgents.length })}
          </span>
        </div>
        <span className="grow" />
        <div className="pane-actions">
          <button
            type="button"
            className="btn-ghost"
            onClick={props.onRefresh}
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
            title={t("common.toggleInspector")}
            aria-label={t("common.toggleInspector")}
          >
            <PanelRightIcon size={15} />
            <span className="hide-xs">{t("common.details")}</span>
          </button>
        </div>
      </div>

      <div className="overview-scroll">
        {/* Top 4-Card Fleet Summary Strip */}
        <div className="admin-kpi-grid">
          <div className="admin-kpi-card">
            <span className="admin-kpi-label">{t("agents.kpiTotal")}</span>
            <strong className="admin-kpi-value">{totalCount}</strong>
            <span className="admin-kpi-sub">
              {t("agents.kpiTotalSub", { muses: muses.length, openai: openaiAgents.length })}
            </span>
          </div>
          <div className="admin-kpi-card tone-ok">
            <span className="admin-kpi-label">{t("agents.kpiLive")}</span>
            <strong className="admin-kpi-value">{fleetMetrics.live}</strong>
            <span className="admin-kpi-sub">
              {fleetMetrics.standby > 0
                ? t("agents.kpiLiveSubStandby", { count: fleetMetrics.standby })
                : t("agents.kpiLiveSub")}
            </span>
          </div>
          <div className="admin-kpi-card tone-wait">
            <span className="admin-kpi-label">{t("agents.kpiPendingOffline")}</span>
            <strong className="admin-kpi-value">{fleetMetrics.pendingOrOffline}</strong>
            <span className="admin-kpi-sub">
              {t("agents.kpiPendingOfflineSub", {
                notSetup: fleetMetrics.notSetup,
                offline: fleetMetrics.offline,
              })}
            </span>
          </div>
          <div className="admin-kpi-card tone-busy">
            <span className="admin-kpi-label">{t("agents.kpiOpenAI")}</span>
            <strong className="admin-kpi-value">{openaiAgents.length}</strong>
            <span className="admin-kpi-sub">
              {fleetMetrics.testedOk > 0
                ? t("agents.kpiOpenAITested", { ok: fleetMetrics.testedOk })
                : t("agents.kpiOpenAISub")}
            </span>
          </div>
        </div>

        {/* Refined Segmented Toolbar */}
        <div className="admin-toolbar">
          <div className="filter-bar" role="tablist" aria-label={t("agents.filterAria")}>
            <button
              type="button"
              role="tab"
              aria-selected={filter === "all"}
              className={`filter-bar-tab${filter === "all" ? " on" : ""}`}
              onClick={() => setFilter("all")}
            >
              <span>{t("agents.filterAll")}</span>
              <span className="filter-bar-count">{totalCount}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={filter === "muse"}
              className={`filter-bar-tab${filter === "muse" ? " on" : ""}`}
              onClick={() => setFilter("muse")}
            >
              <span>{t("agents.filterMuse")}</span>
              <span className="filter-bar-count">{muses.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={filter === "openai"}
              className={`filter-bar-tab${filter === "openai" ? " on" : ""}`}
              onClick={() => setFilter("openai")}
            >
              <span>{t("agents.filterOpenAI")}</span>
              <span className="filter-bar-count">{openaiAgents.length}</span>
            </button>
          </div>

          <div className="admin-search">
            <SearchIcon size={14} className="admin-search-icon" />
            <input
              type="search"
              value={query}
              placeholder={t("agents.searchPlaceholder")}
              aria-label={t("agents.searchAria")}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                type="button"
                className="rail-search-clear"
                onClick={() => setQuery("")}
                aria-label={t("sidebar.clearSearchAria")}
              >
                <XIcon size={13} />
              </button>
            )}
          </div>

          <div className="admin-toolbar-actions">
            <button type="button" className="btn-ghost" onClick={props.onAddMuse}>
              <PlusIcon size={14} />
              <span>{t("agents.addMuse")}</span>
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setOaiModal({ open: true, agent: null })}
            >
              <PlusIcon size={14} />
              <span>{t("agents.addOpenAI")}</span>
            </button>
          </div>
        </div>

        {visibleCount === 0 ? (
          <div className="ov-empty-card">
            <p>{totalCount === 0 ? t("agents.emptyAll") : t("agents.emptyFiltered")}</p>
            {totalCount === 0 && (
              <div className="empty-cta-row">
                <button type="button" className="btn-ghost" onClick={props.onAddMuse}>
                  <PlusIcon size={14} />
                  <span>{t("agents.addMuseRelay")}</span>
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setOaiModal({ open: true, agent: null })}
                >
                  <PlusIcon size={14} />
                  <span>{t("agents.addOpenAI")}</span>
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            {filteredMuses.length > 0 && (
              <section className="ov-section" aria-label={t("agents.museSectionAria")}>
                <div className="ov-section-head">
                  <div className="ov-section-title">
                    <StarIcon size={15} style={{ color: "var(--color-accent)" }} />
                    <h3>
                      {t("agents.filterMuse")} ({filteredMuses.length})
                    </h3>
                  </div>
                </div>

                <div className="agent-admin-grid">
                  {filteredMuses.map((m) => {
                    const summary = fleetSummary.get(m.recipient);
                    const activeCount = summary?.activeCount ?? 0;
                    const pCount = projectCounts.get(`muse:${m.recipient}`) ?? 0;
                    const conn = museConnectionInfo(m, lang);

                    const setupTone: PipeTone = conn.setupDone ? "done" : "wait";
                    const connTone: PipeTone = conn.connected
                      ? "done"
                      : conn.state === "reconnecting"
                        ? "wait"
                        : conn.state === "offline"
                          ? "bad"
                          : "muted";
                    const liveTone: PipeTone =
                      conn.state === "live"
                        ? "done"
                        : conn.state === "standby"
                          ? "busy"
                          : conn.state === "reconnecting"
                            ? "wait"
                            : conn.state === "offline"
                              ? "bad"
                              : "muted";

                    const edgeTone =
                      conn.state === "live"
                        ? "ok"
                        : conn.state === "standby"
                          ? "busy"
                          : conn.state === "offline"
                            ? "bad"
                            : "wait";

                    return (
                      <article
                        key={m.recipient}
                        className={`agent-card muse-card edge-${edgeTone}`}
                      >
                        <div className="agent-card-head">
                          <div className="fleet-identity">
                            <span className="avatar-wrap">
                              <span
                                className={`avatar-monogram status-${summary?.status ?? "idle"}`}
                              >
                                {initialsOf(m.name)}
                              </span>
                              <span
                                className={`avatar-status-dot ${conn.dotClass}`}
                                aria-hidden="true"
                              />
                            </span>
                            <div className="fleet-name-wrap">
                              <strong className="fleet-name" title={m.name}>
                                {m.name}
                              </strong>
                              <div className="agent-sub-tags">
                                <span className="agent-kind-tag muse">Muse Relay</span>
                                {activeCount > 0 && (
                                  <span className="agent-job-pill">
                                    {t("ov.runningJobs", { count: activeCount })}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                          <Chip state={conn.chipClass} label={conn.shortLabel} />
                        </div>

                        {/* Compact 3-step horizontal pipeline */}
                        <div
                          className="muse-pipeline"
                          role="group"
                          aria-label={`${m.name}: ${conn.label}`}
                          title={conn.detail}
                        >
                          <PipeNode
                            label={t("agents.pipeSetup")}
                            tone={setupTone}
                            checked={conn.setupDone}
                          />
                          <span
                            className={`pipe-line${conn.setupDone ? " filled" : ""}`}
                            aria-hidden="true"
                          />
                          <PipeNode
                            label={t("agents.pipeConnected")}
                            tone={connTone}
                            checked={conn.connected}
                          />
                          <span
                            className={`pipe-line${conn.connected ? " filled" : ""}`}
                            aria-hidden="true"
                          />
                          <PipeNode
                            label={t("agents.pipeLive")}
                            tone={liveTone}
                            checked={conn.state === "live"}
                          />
                        </div>

                        {!conn.setupDone && (
                          <div className="agent-setup-callout">
                            <span className="agent-setup-msg">{t("agents.setupCallout")}</span>
                            <button
                              type="button"
                              className="btn-ghost btn-sm agent-setup-btn"
                              onClick={() => setMuseAction({ muse: m, kind: "rotate" })}
                            >
                              <KeyIcon size={12} />
                              <span>{t("agents.getToken")}</span>
                            </button>
                          </div>
                        )}

                        <div className="agent-meta-grid">
                          <div className="agent-meta-pair">
                            <span className="agent-meta-k">{t("agents.metaDropbox")}</span>
                            <code className="agent-meta-code" title={m.dropbox_root || "/"}>
                              {m.dropbox_root || "/"}
                            </code>
                          </div>

                          <div className="agent-meta-pair">
                            <span className="agent-meta-k">{t("agents.metaUuid")}</span>
                            <span className="agent-meta-copy-wrap">
                              <code className="agent-meta-code" title={m.recipient}>
                                {truncateUuid(m.recipient)}
                              </code>
                              <button
                                type="button"
                                className="btn-quiet btn-icon-copy"
                                aria-label={t("agents.copyUuidAria", { name: m.name })}
                                title={t("agents.copyUuidAria", { name: m.name })}
                                onClick={() => copyText(m.recipient, t("agents.copyUuidToast"))}
                              >
                                <CopyIcon size={12} />
                              </button>
                            </span>
                          </div>

                          <div className="agent-meta-pair">
                            <span className="agent-meta-k">{t("agents.metaProjects")}</span>
                            <span className="agent-meta-v">
                              {t("agents.projectsValue", {
                                count: pCount,
                                date: fmtTime(m.created_at, lang),
                              })}
                            </span>
                          </div>

                          <div className="agent-meta-pair">
                            <span className="agent-meta-k">
                              {m.last_result_at
                                ? t("agents.metaLastResult")
                                : t("agents.metaEmail")}
                            </span>
                            <span
                              className="agent-meta-v"
                              title={
                                m.last_result_at
                                  ? fmtTime(m.last_result_at, lang)
                                  : m.email_owner ?? undefined
                              }
                            >
                              {m.last_result_at
                                ? fmtRelativeAge(m.last_result_at, lang)
                                : m.email_owner || t("common.none")}
                            </span>
                          </div>
                        </div>

                        <div className="agent-card-actions">
                          <button
                            type="button"
                            className="btn-ghost btn-sm agent-btn-primary"
                            onClick={() => props.onOpenMuseRoom(m.recipient)}
                          >
                            <MessageIcon size={13} />
                            <span>{t("agents.openDirectRoom")}</span>
                          </button>
                          <button
                            type="button"
                            className="btn-ghost btn-sm"
                            onClick={() => setMuseAction({ muse: m, kind: "rename" })}
                          >
                            <EditIcon size={13} />
                            <span>{t("agents.rename")}</span>
                          </button>
                          <button
                            type="button"
                            className="btn-ghost btn-sm"
                            onClick={() => setMuseAction({ muse: m, kind: "rotate" })}
                          >
                            <KeyIcon size={13} />
                            <span>{t("agents.rotate")}</span>
                          </button>
                          <button
                            type="button"
                            className="btn-ghost btn-sm btn-icon-only danger-text"
                            aria-label={t("agents.deleteMuseAria", { name: m.name })}
                            title={t("agents.deleteMuseAria", { name: m.name })}
                            onClick={() => setMuseAction({ muse: m, kind: "delete" })}
                          >
                            <TrashIcon size={13} />
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}

            {filteredOpenAI.length > 0 && (
              <section className="ov-section" aria-label={t("agents.openaiSectionAria")}>
                <div className="ov-section-head">
                  <div className="ov-section-title">
                    <BotIcon size={16} style={{ color: "var(--color-busy)" }} />
                    <h3>
                      {t("agents.filterOpenAI")} ({filteredOpenAI.length})
                    </h3>
                  </div>
                </div>

                <div className="agent-admin-grid">
                  {filteredOpenAI.map((a) => {
                    const testState = testResults[a.id];
                    const pCount = projectCounts.get(`openai:${a.id}`) ?? 0;

                    const statusPill = testState?.testing ? (
                      <span className="test-status-pill testing">{t("agents.testTesting")}</span>
                    ) : testState?.ok === true ? (
                      <span className="test-status-pill ok">
                        {t("agents.testOkPill", { ms: testState.latencyMs ?? 0 })}
                      </span>
                    ) : testState?.ok === false ? (
                      <span className="test-status-pill err">{t("agents.testErrPill")}</span>
                    ) : (
                      <span className="test-status-pill untested">{t("agents.testUntested")}</span>
                    );

                    return (
                      <article key={a.id} className="agent-card openai-card edge-busy">
                        <div className="agent-card-head">
                          <div className="fleet-identity">
                            <span className="avatar-monogram openai">
                              <BotIcon size={16} />
                            </span>
                            <div className="fleet-name-wrap">
                              <strong className="fleet-name" title={a.name}>
                                {a.name}
                              </strong>
                              <span className="agent-kind-tag openai">OpenAI Compatible</span>
                            </div>
                          </div>
                          <div className="openai-header-pills">
                            <span className="model-pill" title={a.model}>
                              {a.model}
                            </span>
                            {statusPill}
                          </div>
                        </div>

                        <div className="agent-meta-grid">
                          <div className="agent-meta-pair span-2">
                            <span className="agent-meta-k">{t("agents.metaEndpoint")}</span>
                            <code className="agent-meta-code" title={a.base_url}>
                              {a.base_url}
                            </code>
                          </div>

                          <div className="agent-meta-pair">
                            <span className="agent-meta-k">{t("agents.metaApiKey")}</span>
                            <code className="agent-meta-code">{maskApiKey(a.api_key)}</code>
                          </div>

                          <div className="agent-meta-pair">
                            <span className="agent-meta-k">{t("agents.metaProjects")}</span>
                            <span className="agent-meta-v">
                              {t("agents.projectsValue", {
                                count: pCount,
                                date: fmtTime(a.created_at, lang),
                              })}
                            </span>
                          </div>
                        </div>

                        {a.system_prompt && (
                          <div className="agent-prompt-box" title={a.system_prompt}>
                            <span className="agent-prompt-label">{t("agents.metaPrompt")}</span>
                            <p className="agent-prompt-text">{a.system_prompt}</p>
                          </div>
                        )}

                        {testState && !testState.testing && (
                          <div
                            className={`conn-status ${testState.ok ? "ok" : "err"}`}
                            role="status"
                          >
                            {testState.ok ? (
                              <>
                                <CheckIcon size={13} />
                                <span>
                                  {t("agents.testOkMsg", { ms: testState.latencyMs ?? 0 })}
                                  {testState.reply ? ` · "${testState.reply.slice(0, 36)}"` : ""}
                                </span>
                              </>
                            ) : (
                              <span>
                                {t("common.errorPrefix", { err: testState.error ?? "" })}
                              </span>
                            )}
                          </div>
                        )}

                        <div className="agent-card-actions">
                          <button
                            type="button"
                            className={`btn-ghost btn-sm agent-btn-primary${testState?.testing ? " is-loading" : ""}`}
                            disabled={testState?.testing}
                            onClick={() => void runConnectionTest(a)}
                          >
                            <PlugIcon size={13} />
                            <span>
                              {testState?.testing ? t("agents.testTesting") : t("agents.testBtn")}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="btn-ghost btn-sm"
                            onClick={() => setOaiModal({ open: true, agent: a })}
                          >
                            <EditIcon size={13} />
                            <span>{t("common.edit")}</span>
                          </button>
                          <button
                            type="button"
                            className="btn-ghost btn-sm btn-icon-only danger-text"
                            aria-label={t("agents.deleteOpenAIAria", { name: a.name })}
                            title={t("agents.deleteOpenAIAria", { name: a.name })}
                            onClick={() => setOaiDelete(a)}
                          >
                            <TrashIcon size={13} />
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      {museAction?.kind === "rename" && (
        <RenameDialog
          muse={museAction.muse}
          onClose={() => setMuseAction(null)}
          onRenamed={(recipient, name) => {
            props.onMuseRenamed(recipient, name);
            setMuseAction(null);
          }}
        />
      )}
      {museAction?.kind === "rotate" && (
        <RotateDialog
          muse={museAction.muse}
          onClose={() => setMuseAction(null)}
          onRotated={() => props.onMuseRotated?.()}
        />
      )}
      {museAction?.kind === "delete" && (
        <DeleteDialog
          muse={museAction.muse}
          onClose={() => setMuseAction(null)}
          onDeleted={(recipient) => {
            props.onMuseDeleted(recipient);
            setMuseAction(null);
          }}
        />
      )}

      {oaiModal.open && (
        <OpenAIAgentModal
          agent={oaiModal.agent}
          onClose={() => setOaiModal({ open: false, agent: null })}
          onSaved={() => props.onOpenAIChanged()}
        />
      )}

      {oaiDelete && (
        <DeleteOpenAIDialog
          agent={oaiDelete}
          onClose={() => setOaiDelete(null)}
          onDeleted={() => props.onOpenAIChanged()}
        />
      )}
    </section>
  );
}
