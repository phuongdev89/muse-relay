import { useEffect, useMemo, useState } from "react";
import { museConnectionInfo, type MuseFleetSummary } from "../lib/format";
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

export type { ActiveRoom };

const CONV_MODE_SHORT: Record<ConversationMode, string> = {
  muse_single: "1 Muse",
  muse_group: "Nhóm",
  openai: "OpenAI",
  mixed: "Mix",
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
        aria-label="Điều hướng chính"
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
            aria-label="Đóng thanh điều hướng"
          >
            <XIcon size={16} />
          </button>
        </div>

        <nav className="rail-top-nav" aria-label="Điều hướng cấp cao">
          <button
            type="button"
            className={`rail-nav-item${active?.kind === "overview" ? " active" : ""}`}
            onClick={() => selectRoom({ kind: "overview" })}
          >
            <OverviewIcon size={16} />
            <span className="nm">Tổng quan</span>
            {totalActiveJobs > 0 && (
              <span className="rail-badge busy" title={`${totalActiveJobs} việc đang chạy`}>
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
            <span className="nm">Quản trị Agent</span>
          </button>
        </nav>

        <div className="rail-search">
          <SearchIcon size={14} className="rail-search-icon" />
          <input
            type="search"
            value={query}
            placeholder="Tìm Project, hội thoại, Muse…"
            aria-label="Tìm Project, cuộc hội thoại hoặc Muse"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className="rail-search-clear"
              onClick={() => setQuery("")}
              aria-label="Xoá từ khoá tìm kiếm"
            >
              <XIcon size={13} />
            </button>
          )}
        </div>

        <div className="rail-scroll">
          {/* Project-Centric Tree */}
          <nav className="rail-section" aria-label="Danh sách Project">
            <div className="rail-label-row">
              <span className="rail-label">PROJECT ({projects.length})</span>
              <button
                type="button"
                className="rail-add-icon"
                onClick={() => {
                  onCloseMobile();
                  props.onAddProject();
                }}
                title="Tạo project mới"
                aria-label="Tạo project mới"
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
                        aria-label={isExpanded ? `Thu gọn ${project.name}` : `Mở rộng ${project.name}`}
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
                        <span className="rail-badge" title={`${agentCount} Agent trong Project`}>
                          {agentCount}
                        </span>
                      </button>

                      <div className="proj-quick-actions">
                        <button
                          type="button"
                          className="proj-action-btn"
                          title="Cuộc hội thoại mới"
                          aria-label={`Cuộc hội thoại mới trong ${project.name}`}
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
                          title="Cài đặt Project"
                          aria-label={`Cài đặt ${project.name}`}
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
                          <span className="proj-conv-empty">Chưa có hội thoại</span>
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
                                  {CONV_MODE_SHORT[c.mode]} · {c.participants.length}
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
                  {projects.length === 0 ? "Chưa có Project nào" : "Không tìm thấy Project"}
                </span>
              )}
            </div>
          </nav>

          {/* Direct 1:1 Muse Channels */}
          <nav className="rail-section" aria-label="Kênh trực tiếp với Muse">
            <div className="rail-label-row">
              <span className="rail-label">KÊNH TRỰC TIẾP ({muses.length})</span>
            </div>

            <div className="rail-rooms">
              {filteredMuses.map((m) => {
                const isMuseActive =
                  active?.kind === "muse" && active.recipient === m.recipient;
                const conn = museConnectionInfo(m);
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
                        title={`${activeJobs} việc đang chạy`}
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
                  {muses.length === 0 ? "Chưa có Muse nào" : "Không tìm thấy Muse"}
                </span>
              )}
            </div>
          </nav>
        </div>

        <div className="rail-foot">
          <div className="theme-toggle" role="radiogroup" aria-label="Chế độ giao diện">
            <button
              type="button"
              role="radio"
              aria-checked={theme === "dark"}
              className={`theme-opt${theme === "dark" ? " on" : ""}`}
              onClick={() => setTheme("dark")}
            >
              <MoonIcon size={13} />
              <span>Tối</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={theme === "light"}
              className={`theme-opt${theme === "light" ? " on" : ""}`}
              onClick={() => setTheme("light")}
            >
              <SunIcon size={13} />
              <span>Sáng</span>
            </button>
          </div>

          <div className="owner-chip">
            <span className="em" title={ownerEmail}>{ownerEmail}</span>
            <button
              type="button"
              className="btn-quiet btn-logout"
              onClick={props.onLogout}
              title="Đăng xuất"
              aria-label="Đăng xuất"
            >
              <LogOutIcon size={14} />
              <span>Thoát</span>
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
