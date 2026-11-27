import { useEffect, useMemo, useState } from "react";
import { museConnectionInfo, type MuseFleetSummary } from "../lib/format";
import { useLang, type I18nKey } from "../lib/i18n";
import { useTheme } from "../lib/theme";
import type {
  ActiveRoom,
  Conversation,
  ConversationMode,
  Muse,
  Project,
  ProjectAgent,
} from "../types";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  LayersIcon,
  LogOutIcon,
  MessageIcon,
  MoonIcon,
  OverviewIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  StarIcon,
  SunIcon,
  XIcon,
} from "./Icons";
import { LangToggle } from "./ui";

export type { ActiveRoom };

const CONV_MODE_SHORT_KEY: Record<ConversationMode, I18nKey> = {
  muse_single: "convModeShort.muse_single",
  muse_group: "convModeShort.muse_group",
  openai: "convModeShort.openai",
  mixed: "convModeShort.mixed",
};

export function Sidebar(props: {
  muses: Muse[];
  projects: Project[];
  projectAgents: ProjectAgent[];
  conversations: Conversation[];
  fleetSummary: Map<string, MuseFleetSummary>;
  active: ActiveRoom;
  ownerEmail: string;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onSwitchRoom: (room: ActiveRoom) => void;
  onAddProject: () => void;
  onEditProject: (project: Project) => void;
  onNewConversation: (project: Project) => void;
  onLogout: () => void;
}) {
  const {
    muses,
    projects,
    projectAgents,
    conversations,
    fleetSummary,
    active,
    ownerEmail,
    mobileOpen,
    onCloseMobile,
  } = props;

  const [query, setQuery] = useState("");
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const { theme, setTheme } = useTheme();
  const { lang, t } = useLang();

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseMobile();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileOpen, onCloseMobile]);

  const totalActiveJobs = useMemo(() => {
    let total = 0;
    for (const s of fleetSummary.values()) total += s.activeCount;
    return total;
  }, [fleetSummary]);

  const agentCountByProject = useMemo(() => {
    const map = new Map<string, number>();
    for (const pa of projectAgents) {
      map.set(pa.project_id, (map.get(pa.project_id) ?? 0) + 1);
    }
    return map;
  }, [projectAgents]);

  const convsByProject = useMemo(() => {
    const map = new Map<string, Conversation[]>();
    for (const c of conversations) {
      const list = map.get(c.project_id) ?? [];
      list.push(c);
      map.set(c.project_id, list);
    }
    return map;
  }, [conversations]);

  const q = query.trim().toLowerCase();

  const filteredProjects = useMemo(() => {
    if (!q) {
      return projects.map((p) => ({
        project: p,
        convs: convsByProject.get(p.id) ?? [],
      }));
    }
    const res: { project: Project; convs: Conversation[] }[] = [];
    for (const p of projects) {
      const allConvs = convsByProject.get(p.id) ?? [];
      const projMatches = p.name.toLowerCase().includes(q);
      const matchingConvs = allConvs.filter((c) => c.title.toLowerCase().includes(q));
      if (projMatches || matchingConvs.length > 0) {
        res.push({
          project: p,
          convs: projMatches ? allConvs : matchingConvs,
        });
      }
    }
    return res;
  }, [projects, convsByProject, q]);

  const filteredMuses = useMemo(() => {
    if (!q) return muses;
    return muses.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.dropbox_root.toLowerCase().includes(q),
    );
  }, [muses, q]);

  function selectRoom(room: ActiveRoom) {
    props.onSwitchRoom(room);
    onCloseMobile();
  }

  function toggleProjectExpand(projectId: string) {
    setCollapsedProjects((cur) => {
      const next = new Set(cur);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  function expandProject(projectId: string) {
    setCollapsedProjects((cur) => {
      if (!cur.has(projectId)) return cur;
      const next = new Set(cur);
      next.delete(projectId);
      return next;
    });
  }

  return (
    <>
      {mobileOpen && (
        <div
          className="drawer-scrim rail-scrim"
          aria-hidden="true"
          onClick={onCloseMobile}
        />
      )}
      <aside
        className={`rail${mobileOpen ? " mobile-open" : ""}`}
        aria-label={t("sidebar.navAria")}
      >
        <div className="rail-head">
          <div className="wordmark">
            <StarIcon size={18} />
            <span>Muse Relay</span>
            <span className="brand-pill">Command</span>
          </div>
          <button
            type="button"
            className="btn-quiet rail-close"
            onClick={onCloseMobile}
            aria-label={t("sidebar.closeAria")}
          >
            <XIcon size={16} />
          </button>
        </div>

        <nav className="rail-top-nav" aria-label={t("sidebar.topNavAria")}>
          <button
            type="button"
            className={`rail-nav-item${active?.kind === "overview" ? " active" : ""}`}
            onClick={() => selectRoom({ kind: "overview" })}
          >
            <OverviewIcon size={16} />
            <span className="nm">{t("sidebar.overview")}</span>
            {totalActiveJobs > 0 && (
              <span
                className="rail-badge busy"
                title={t("sidebar.activeJobsTitle", { count: totalActiveJobs })}
              >
                {totalActiveJobs}
              </span>
            )}
          </button>

          <button
            type="button"
            className={`rail-nav-item${active?.kind === "agents" ? " active" : ""}`}
            onClick={() => selectRoom({ kind: "agents" })}
          >
            <BotIcon size={16} />
            <span className="nm">{t("sidebar.agents")}</span>
          </button>
        </nav>

        <div className="rail-search">
          <SearchIcon size={14} className="rail-search-icon" />
          <input
            type="search"
            value={query}
            placeholder={t("sidebar.searchPlaceholder")}
            aria-label={t("sidebar.searchAria")}
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

        <div className="rail-scroll">
          {/* Project-Centric Tree */}
          <nav className="rail-section" aria-label={t("sidebar.projectsAria")}>
            <div className="rail-label-row">
              <span className="rail-label">
                {t("sidebar.projectsLabel", { count: projects.length })}
              </span>
              <button
                type="button"
                className="rail-add-icon"
                onClick={() => {
                  onCloseMobile();
                  props.onAddProject();
                }}
                title={t("sidebar.newProject")}
                aria-label={t("sidebar.newProject")}
              >
                <PlusIcon size={14} />
              </button>
            </div>

            <div className="proj-tree">
              {filteredProjects.map(({ project, convs }) => {
                const isProjActive =
                  active?.kind === "project" && active.projectId === project.id;
                const hasActiveConv =
                  active?.kind === "conversation" && active.projectId === project.id;
                const isExpanded =
                  Boolean(q) || hasActiveConv || !collapsedProjects.has(project.id);
                const agentCount = agentCountByProject.get(project.id) ?? 0;

                return (
                  <div key={project.id} className="proj-node">
                    <div className={`proj-head${isProjActive ? " active" : ""}`}>
                      <button
                        type="button"
                        className="proj-chevron"
                        aria-expanded={isExpanded}
                        aria-label={
                          isExpanded
                            ? t("sidebar.collapseProj", { name: project.name })
                            : t("sidebar.expandProj", { name: project.name })
                        }
                        onClick={() => toggleProjectExpand(project.id)}
                      >
                        {isExpanded ? <ChevronDownIcon size={13} /> : <ChevronRightIcon size={13} />}
                      </button>

                      <button
                        type="button"
                        className="proj-link"
                        onClick={() => {
                          expandProject(project.id);
                          selectRoom({ kind: "project", projectId: project.id });
                        }}
                      >
                        <LayersIcon size={14} className="proj-icon" />
                        <span className="nm">{project.name}</span>
                        <span
                          className="rail-badge"
                          title={t("sidebar.agentsInProj", { count: agentCount })}
                        >
                          {agentCount}
                        </span>
                      </button>

                      <div className="proj-quick-actions">
                        <button
                          type="button"
                          className="proj-action-btn"
                          title={t("sidebar.newConv")}
                          aria-label={t("sidebar.newConvIn", { name: project.name })}
                          onClick={() => {
                            onCloseMobile();
                            props.onNewConversation(project);
                          }}
                        >
                          <PlusIcon size={13} />
                        </button>
                        <button
                          type="button"
                          className="proj-action-btn"
                          title={t("sidebar.projSettings")}
                          aria-label={t("sidebar.projSettingsOf", { name: project.name })}
                          onClick={() => {
                            onCloseMobile();
                            props.onEditProject(project);
                          }}
                        >
                          <SettingsIcon size={12} />
                        </button>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="proj-convs">
                        {convs.length === 0 ? (
                          <span className="proj-conv-empty">{t("sidebar.noConvs")}</span>
                        ) : (
                          convs.map((c) => {
                            const isConvActive =
                              active?.kind === "conversation" &&
                              active.conversationId === c.id;
                            return (
                              <button
                                key={c.id}
                                type="button"
                                className={`conv-nav-item${isConvActive ? " active" : ""}`}
                                onClick={() =>
                                  selectRoom({
                                    kind: "conversation",
                                    projectId: project.id,
                                    conversationId: c.id,
                                  })
                                }
                              >
                                <MessageIcon size={12} className="conv-nav-icon" />
                                <span className="nm">{c.title}</span>
                                <span className="conv-nav-hint">
                                  {t(CONV_MODE_SHORT_KEY[c.mode])} · {c.participants.length}
                                </span>
                              </button>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {filteredProjects.length === 0 && (
                <span className="rail-empty">
                  {projects.length === 0
                    ? t("sidebar.noProjects")
                    : t("sidebar.noMatchingProjects")}
                </span>
              )}
            </div>
          </nav>

          {/* Direct 1:1 Muse Channels */}
          <nav className="rail-section" aria-label={t("sidebar.directAria")}>
            <div className="rail-label-row">
              <span className="rail-label">
                {t("sidebar.directLabel", { count: muses.length })}
              </span>
            </div>

            <div className="rail-rooms">
              {filteredMuses.map((m) => {
                const isMuseActive =
                  active?.kind === "muse" && active.recipient === m.recipient;
                const conn = museConnectionInfo(m, lang);
                const summary = fleetSummary.get(m.recipient);
                const activeJobs = summary?.activeCount ?? 0;

                return (
                  <button
                    key={m.recipient}
                    type="button"
                    className={`room${isMuseActive ? " active" : ""}`}
                    onClick={() => selectRoom({ kind: "muse", recipient: m.recipient })}
                    title={`${m.name} · ${conn.label} (${conn.detail})`}
                  >
                    <span className={`dot ${conn.dotClass}`} aria-hidden="true" />
                    <span className="nm">{m.name}</span>
                    {activeJobs > 0 ? (
                      <span
                        className="rail-badge busy"
                        title={t("sidebar.activeJobsTitle", { count: activeJobs })}
                      >
                        {activeJobs}
                      </span>
                    ) : (
                      <span className={`rail-direct-badge state-${conn.state}`}>
                        {conn.shortLabel}
                      </span>
                    )}
                  </button>
                );
              })}

              {filteredMuses.length === 0 && (
                <span className="rail-empty">
                  {muses.length === 0 ? t("sidebar.noMuses") : t("sidebar.noMatchingMuses")}
                </span>
              )}
            </div>
          </nav>
        </div>

        <div className="rail-foot">
          <div className="rail-controls-row">
            <div className="theme-toggle" role="radiogroup" aria-label={t("sidebar.themeAria")}>
              <button
                type="button"
                role="radio"
                aria-checked={theme === "dark"}
                className={`theme-opt${theme === "dark" ? " on" : ""}`}
                onClick={() => setTheme("dark")}
              >
                <MoonIcon size={13} />
                <span>{t("login.dark")}</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={theme === "light"}
                className={`theme-opt${theme === "light" ? " on" : ""}`}
                onClick={() => setTheme("light")}
              >
                <SunIcon size={13} />
                <span>{t("login.light")}</span>
              </button>
            </div>
            <LangToggle compact />
          </div>

          <div className="owner-chip">
            <span className="em" title={ownerEmail}>{ownerEmail}</span>
            <button
              type="button"
              className="btn-quiet btn-logout"
              onClick={props.onLogout}
              title={t("sidebar.logout")}
              aria-label={t("sidebar.logout")}
            >
              <LogOutIcon size={14} />
              <span>{t("sidebar.logoutShort")}</span>
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
