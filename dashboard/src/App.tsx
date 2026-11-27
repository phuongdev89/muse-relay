import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchFleetActivity,
  listConversations,
  listGroups,
  listMuses,
  listOpenAIAgents,
  listProjectAgents,
  listProjects,
} from "./lib/api";
import { summarizeMuseFleet } from "./lib/format";
import { db } from "./lib/supabase";
import type {
  ActiveRoom,
  Conversation,
  FleetActivityItem,
  Group,
  GroupMember,
  Muse,
  OpenAIAgent,
  Project,
  ProjectAgent,
} from "./types";
import { AddMuseWizard } from "./components/AddMuseWizard";
import { AgentsAdminView } from "./components/AgentsAdminView";
import { ConversationRoom } from "./components/ConversationRoom";
import { GroupRoom } from "./components/GroupRoom";
import { MenuIcon, PanelRightIcon, StarIcon } from "./components/Icons";
import { InspectorPanel } from "./components/InspectorPanel";
import { LoginView } from "./components/LoginView";
import {
  ClearMuseHistoryDialog,
  DeleteDialog,
  DeleteGroupDialog,
  RenameDialog,
  RotateDialog,
} from "./components/MuseManage";
import { MuseRoom } from "./components/MuseRoom";
import { NewConversationModal } from "./components/NewConversationModal";
import { OverviewView } from "./components/OverviewView";
import { ProjectView } from "./components/ProjectView";
import { ProjectWizard } from "./components/ProjectWizard";
import { Sidebar } from "./components/Sidebar";
import { ToastHost, toast } from "./components/ui";

const INSPECTOR_KEY = "muse_relay_inspector";
const FLEET_POLL_MS = 10000;

function readDesktopInspectorPref(): boolean {
  try {
    return localStorage.getItem(INSPECTOR_KEY) !== "false";
  } catch {
    return true;
  }
}

export default function App() {
  const [booted, setBooted] = useState(false);
  const [ownerEmail, setOwnerEmail] = useState("");
  const [muses, setMuses] = useState<Muse[]>([]);
  const [openaiAgents, setOpenaiAgents] = useState<OpenAIAgent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectAgents, setProjectAgents] = useState<ProjectAgent[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [members, setMembers] = useState<Map<string, GroupMember[]>>(new Map());
  const [active, setActive] = useState<ActiveRoom>(null);

  const [fleetItems, setFleetItems] = useState<FleetActivityItem[]>([]);
  const [fleetLoading, setFleetLoading] = useState(false);
  const [fleetError, setFleetError] = useState("");
  const [fleetUpdatedAt, setFleetUpdatedAt] = useState<Date | null>(null);

  const [showMuseWizard, setShowMuseWizard] = useState(false);
  const [projectWizard, setProjectWizard] = useState<{
    open: boolean;
    project: Project | null;
  }>({ open: false, project: null });
  const [newConvProject, setNewConvProject] = useState<Project | null>(null);
  const [museDialog, setMuseDialog] = useState<"rename" | "rotate" | "delete" | "clear" | null>(
    null,
  );
  const [museRefreshTick, setMuseRefreshTick] = useState(0);
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<Group | null>(null);

  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [desktopInspectorOpen, setDesktopInspectorOpen] = useState<boolean>(() =>
    readDesktopInspectorPref(),
  );
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.matchMedia("(min-width: 1100px)").matches : true,
  );
  const [threadPaths, setThreadPaths] = useState<string[]>([]);

  useEffect(() => {
    const mqDesktop = window.matchMedia("(min-width: 1100px)");
    const mqTabletUp = window.matchMedia("(min-width: 769px)");
    const onDesktopChange = (e: MediaQueryListEvent) => {
      setIsDesktop(e.matches);
      if (e.matches) setMobileInspectorOpen(false);
    };
    const onTabletUpChange = (e: MediaQueryListEvent) => {
      if (e.matches) setMobileNavOpen(false);
    };
    mqDesktop.addEventListener("change", onDesktopChange);
    mqTabletUp.addEventListener("change", onTabletUpChange);
    return () => {
      mqDesktop.removeEventListener("change", onDesktopChange);
      mqTabletUp.removeEventListener("change", onTabletUpChange);
    };
  }, []);

  const loadMuses = useCallback(async () => {
    const { data, error } = await listMuses();
    if (error) toast("Lỗi tải danh sách Muse: " + error);
    setMuses(data);
    return data;
  }, []);

  const loadOpenAIAgents = useCallback(async () => {
    const { data, error } = await listOpenAIAgents();
    if (error) toast("Lỗi tải OpenAI Agents: " + error);
    setOpenaiAgents(data);
    return data;
  }, []);

  const loadProjects = useCallback(async () => {
    const { data, error } = await listProjects();
    if (error) toast("Lỗi tải danh sách Project: " + error);
    setProjects(data);
    return data;
  }, []);

  const loadProjectAgents = useCallback(async () => {
    const { data, error } = await listProjectAgents();
    if (error) toast("Lỗi tải Agent của Project: " + error);
    setProjectAgents(data);
    return data;
  }, []);

  const loadConversations = useCallback(async () => {
    const { data, error } = await listConversations();
    if (error) toast("Lỗi tải cuộc hội thoại: " + error);
    setConversations(data);
    return data;
  }, []);

  const loadGroups = useCallback(async () => {
    const { groups: gs, members: ms, error } = await listGroups();
    if (error) toast("Lỗi tải nhóm: " + error);
    const byGroup = new Map<string, GroupMember[]>();
    for (const m of ms) {
      const list = byGroup.get(m.group_id) ?? [];
      list.push(m);
      byGroup.set(m.group_id, list);
    }
    setGroups(gs);
    setMembers(byGroup);
    return gs;
  }, []);

  const loadFleet = useCallback(async () => {
    const { items, error } = await fetchFleetActivity(80);
    setFleetLoading(false);
    if (error) {
      setFleetError(error);
      return;
    }
    setFleetError("");
    setFleetItems(items);
    setFleetUpdatedAt(new Date());
  }, []);

  const enterApp = useCallback(
    async (email: string) => {
      setOwnerEmail(email);
      setFleetLoading(true);
      await Promise.all([
        loadMuses(),
        loadOpenAIAgents(),
        loadProjects(),
        loadProjectAgents(),
        loadConversations(),
        loadGroups(),
        loadFleet(),
      ]);
      setActive((cur) => cur ?? { kind: "overview" });
    },
    [
      loadMuses,
      loadOpenAIAgents,
      loadProjects,
      loadProjectAgents,
      loadConversations,
      loadGroups,
      loadFleet,
    ],
  );

  useEffect(() => {
    (async () => {
      const {
        data: { session },
      } = await db.auth.getSession();
      if (session?.user?.email) await enterApp(session.user.email);
      setBooted(true);
    })();
  }, [enterApp]);

  // Poll fleet activity & muse live telemetry while signed in
  useEffect(() => {
    if (!ownerEmail) return;
    const t = setInterval(() => {
      void loadFleet();
      void loadMuses();
    }, FLEET_POLL_MS);
    return () => clearInterval(t);
  }, [ownerEmail, loadFleet, loadMuses]);

  async function logout() {
    await db.auth.signOut();
    setOwnerEmail("");
    setMuses([]);
    setOpenaiAgents([]);
    setProjects([]);
    setProjectAgents([]);
    setConversations([]);
    setGroups([]);
    setMembers(new Map());
    setFleetItems([]);
    setFleetError("");
    setFleetUpdatedAt(null);
    setActive(null);
    setMobileNavOpen(false);
    setMobileInspectorOpen(false);
    setThreadPaths([]);
  }

  function switchRoom(room: ActiveRoom) {
    setActive(room);
    setMuseDialog(null);
    setThreadPaths([]);
  }

  function toggleInspector() {
    if (isDesktop) {
      setDesktopInspectorOpen((cur) => {
        const next = !cur;
        try {
          localStorage.setItem(INSPECTOR_KEY, String(next));
        } catch {
          // ignore
        }
        return next;
      });
    } else {
      setMobileInspectorOpen((cur) => !cur);
    }
  }

  // ---- muse & openai mutations ---------------------------------------------

  function onMuseCreated(muse: Muse) {
    setMuses((cur) =>
      cur.some((m) => m.recipient === muse.recipient) ? cur : [...cur, muse],
    );
    if (active?.kind !== "agents") {
      switchRoom({ kind: "muse", recipient: muse.recipient });
    }
    void loadMuses();
    void loadFleet();
  }

  function onMuseRenamed(recipient: string, name: string) {
    setMuses((cur) => cur.map((m) => (m.recipient === recipient ? { ...m, name } : m)));
    toast("Đã đổi tên");
    void loadProjectAgents();
  }

  function onMuseDeleted(recipient: string) {
    const remaining = muses.filter((m) => m.recipient !== recipient);
    setMuses(remaining);
    setMuseDialog(null);
    if (active?.kind === "muse" && active.recipient === recipient) {
      switchRoom({ kind: "overview" });
    }
    toast("Đã xoá Muse");
    void loadGroups();
    void loadFleet();
    void loadProjectAgents();
  }

  function onOpenAIChanged() {
    void loadOpenAIAgents();
    void loadProjectAgents();
  }

  function onGroupDeleted(groupId: string) {
    setGroups((cur) => cur.filter((g) => g.id !== groupId));
    setDeleteGroupTarget(null);
    if (active?.kind === "group" && active.id === groupId) {
      switchRoom({ kind: "overview" });
    }
    void loadGroups();
    void loadFleet();
  }

  // ---- project & conversation mutations ------------------------------------

  function onProjectSaved(projectId: string, isNew: boolean) {
    void Promise.all([loadProjects(), loadProjectAgents()]).then(() => {
      if (isNew) {
        switchRoom({ kind: "project", projectId });
      }
    });
  }

  function onProjectDeleted(projectId: string) {
    setProjects((cur) => cur.filter((p) => p.id !== projectId));
    if (
      (active?.kind === "project" && active.projectId === projectId) ||
      (active?.kind === "conversation" && active.projectId === projectId)
    ) {
      switchRoom({ kind: "overview" });
    }
    void loadProjects();
    void loadProjectAgents();
    void loadConversations();
    void loadGroups();
  }

  function onConversationCreated(conv: Conversation) {
    setConversations((cur) => [...cur, conv]);
    void loadConversations();
    void loadGroups();
    switchRoom({
      kind: "conversation",
      projectId: conv.project_id,
      conversationId: conv.id,
    });
  }

  function onConversationDeleted(projectId: string, conversationId: string) {
    setConversations((cur) => cur.filter((c) => c.id !== conversationId));
    void loadConversations();
    void loadGroups();
    switchRoom({ kind: "project", projectId });
  }

  const fleetSummary = useMemo(
    () => summarizeMuseFleet(muses, fleetItems),
    [muses, fleetItems],
  );

  if (!booted) return <div className="boot-screen">MUSE RELAY…</div>;

  if (!ownerEmail) {
    return (
      <>
        <LoginView onSignedIn={(email) => enterApp(email)} />
        <ToastHost />
      </>
    );
  }

  const activeMuse =
    active?.kind === "muse"
      ? muses.find((m) => m.recipient === active.recipient) ?? null
      : null;
  const activeGroup =
    active?.kind === "group"
      ? groups.find((g) => g.id === active.id) ?? null
      : null;

  const activeProjectId =
    active?.kind === "project" || active?.kind === "conversation"
      ? active.projectId
      : null;
  const activeProject = activeProjectId
    ? projects.find((p) => p.id === activeProjectId) ?? null
    : null;
  const activeProjectAgents = activeProjectId
    ? projectAgents.filter((pa) => pa.project_id === activeProjectId)
    : [];
  const activeProjectConversations = activeProjectId
    ? conversations.filter((c) => c.project_id === activeProjectId)
    : [];
  const activeConversation =
    active?.kind === "conversation"
      ? conversations.find((c) => c.id === active.conversationId) ?? null
      : null;

  const mobileTitle =
    active?.kind === "agents"
      ? "Quản trị Agent"
      : activeConversation
        ? activeConversation.title
        : activeProject
          ? activeProject.name
          : activeMuse
            ? activeMuse.name
            : activeGroup
              ? activeGroup.name
              : "Tổng quan";

  const effectiveInspectorOpen = isDesktop ? desktopInspectorOpen : mobileInspectorOpen;

  return (
    <div id="app-view" className="fade">
      <Sidebar
        muses={muses}
        projects={projects}
        projectAgents={projectAgents}
        conversations={conversations}
        fleetSummary={fleetSummary}
        active={active}
        ownerEmail={ownerEmail}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
        onSwitchRoom={switchRoom}
        onAddProject={() => setProjectWizard({ open: true, project: null })}
        onEditProject={(project) => setProjectWizard({ open: true, project })}
        onNewConversation={(project) => setNewConvProject(project)}
        onLogout={logout}
      />

      <div className="workspace-col">
        <header className="mobile-topbar">
          <button
            type="button"
            className="btn-quiet mobile-icon-btn"
            onClick={() => setMobileNavOpen(true)}
            aria-label="Mở menu điều hướng"
          >
            <MenuIcon size={18} />
          </button>
          <div className="mobile-topbar-title">
            <StarIcon size={15} className="mobile-brand-star" />
            <span>{mobileTitle}</span>
          </div>
          <button
            type="button"
            className="btn-quiet mobile-icon-btn"
            onClick={() => setMobileInspectorOpen(true)}
            aria-label="Mở bảng thông tin chi tiết"
          >
            <PanelRightIcon size={17} />
          </button>
        </header>

        <div className="workspace-body">
          <main className="main">
            {active?.kind === "agents" ? (
              <AgentsAdminView
                muses={muses}
                openaiAgents={openaiAgents}
                projectAgents={projectAgents}
                fleetSummary={fleetSummary}
                inspectorOpen={effectiveInspectorOpen}
                onToggleInspector={toggleInspector}
                onRefresh={() => {
                  void loadMuses();
                  void loadOpenAIAgents();
                  void loadProjectAgents();
                  void loadFleet();
                }}
                onAddMuse={() => setShowMuseWizard(true)}
                onOpenMuseRoom={(recipient) => switchRoom({ kind: "muse", recipient })}
                onMuseRenamed={onMuseRenamed}
                onMuseRotated={() => void loadMuses()}
                onMuseDeleted={onMuseDeleted}
                onOpenAIChanged={onOpenAIChanged}
              />
            ) : active?.kind === "conversation" && activeProject && activeConversation ? (
              <ConversationRoom
                key={activeConversation.id}
                project={activeProject}
                conversation={activeConversation}
                muses={muses}
                openaiAgents={openaiAgents}
                inspectorOpen={effectiveInspectorOpen}
                onToggleInspector={toggleInspector}
                onPathsChange={setThreadPaths}
                onConversationDeleted={onConversationDeleted}
                onMessageSent={() => void loadFleet()}
              />
            ) : active?.kind === "project" && activeProject ? (
              <ProjectView
                key={activeProject.id}
                project={activeProject}
                projectAgents={activeProjectAgents}
                conversations={activeProjectConversations}
                muses={muses}
                openaiAgents={openaiAgents}
                fleetSummary={fleetSummary}
                inspectorOpen={effectiveInspectorOpen}
                onToggleInspector={toggleInspector}
                onEditProject={() => setProjectWizard({ open: true, project: activeProject })}
                onNewConversation={() => setNewConvProject(activeProject)}
                onOpenConversation={(conversationId) =>
                  switchRoom({
                    kind: "conversation",
                    projectId: activeProject.id,
                    conversationId,
                  })
                }
                onProjectDeleted={onProjectDeleted}
                onProjectAgentsChanged={() => void loadProjectAgents()}
                onConversationsChanged={() => {
                  void loadConversations();
                  void loadGroups();
                }}
              />
            ) : activeMuse ? (
              <MuseRoom
                key={activeMuse.recipient}
                muse={activeMuse}
                inspectorOpen={effectiveInspectorOpen}
                onToggleInspector={toggleInspector}
                onOpenAction={setMuseDialog}
                onPathsChange={setThreadPaths}
                onMessageSent={() => void loadFleet()}
                refreshTrigger={museRefreshTick}
              />
            ) : activeGroup ? (
              <GroupRoom
                key={activeGroup.id}
                group={activeGroup}
                members={members.get(activeGroup.id) ?? []}
                inspectorOpen={effectiveInspectorOpen}
                onToggleInspector={toggleInspector}
                onDeleteGroup={() => setDeleteGroupTarget(activeGroup)}
                onPathsChange={setThreadPaths}
              />
            ) : (
              <OverviewView
                muses={muses}
                projectsCount={projects.length}
                openaiCount={openaiAgents.length}
                fleetItems={fleetItems}
                loading={fleetLoading}
                error={fleetError}
                updatedAt={fleetUpdatedAt}
                inspectorOpen={effectiveInspectorOpen}
                onToggleInspector={toggleInspector}
                onRefresh={() => {
                  void loadMuses();
                  void loadOpenAIAgents();
                  void loadProjects();
                  void loadProjectAgents();
                  void loadConversations();
                  void loadGroups();
                  void loadFleet();
                }}
                onOpenMuse={(recipient) => switchRoom({ kind: "muse", recipient })}
                onAddMuse={() => setShowMuseWizard(true)}
              />
            )}
          </main>

          <InspectorPanel
            desktopOpen={desktopInspectorOpen}
            mobileOpen={mobileInspectorOpen}
            onCloseMobile={() => setMobileInspectorOpen(false)}
            active={active}
            muse={activeMuse}
            museSummary={activeMuse ? fleetSummary.get(activeMuse.recipient) ?? null : null}
            group={activeGroup}
            groupMembers={activeGroup ? members.get(activeGroup.id) ?? [] : []}
            musesCount={muses.length}
            openaiCount={openaiAgents.length}
            project={activeProject}
            projectAgents={activeProjectAgents}
            projectConversationsCount={activeProjectConversations.length}
            conversation={activeConversation}
            muses={muses}
            openaiAgents={openaiAgents}
            threadPaths={threadPaths}
            onMuseAction={(action) => {
              setMobileInspectorOpen(false);
              setMuseDialog(action);
            }}
            onDeleteGroup={
              activeGroup
                ? () => {
                    setMobileInspectorOpen(false);
                    setDeleteGroupTarget(activeGroup);
                  }
                : undefined
            }
            onEditProject={
              activeProject
                ? () => setProjectWizard({ open: true, project: activeProject })
                : undefined
            }
            onNewConversation={
              activeProject ? () => setNewConvProject(activeProject) : undefined
            }
          />
        </div>
      </div>

      {activeMuse && museDialog === "rename" && (
        <RenameDialog
          muse={activeMuse}
          onClose={() => setMuseDialog(null)}
          onRenamed={onMuseRenamed}
        />
      )}
      {activeMuse && museDialog === "rotate" && (
        <RotateDialog
          muse={activeMuse}
          onClose={() => setMuseDialog(null)}
          onRotated={() => void loadMuses()}
        />
      )}
      {activeMuse && museDialog === "delete" && (
        <DeleteDialog
          muse={activeMuse}
          onClose={() => setMuseDialog(null)}
          onDeleted={onMuseDeleted}
        />
      )}
      {activeMuse && museDialog === "clear" && (
        <ClearMuseHistoryDialog
          muse={activeMuse}
          onClose={() => setMuseDialog(null)}
          onCleared={() => {
            setMuseRefreshTick((n) => n + 1);
            setThreadPaths([]);
            void loadFleet();
          }}
        />
      )}
      {deleteGroupTarget && (
        <DeleteGroupDialog
          group={deleteGroupTarget}
          onClose={() => setDeleteGroupTarget(null)}
          onDeleted={onGroupDeleted}
        />
      )}

      {showMuseWizard && (
        <AddMuseWizard onClose={() => setShowMuseWizard(false)} onCreated={onMuseCreated} />
      )}
      {projectWizard.open && (
        <ProjectWizard
          project={projectWizard.project}
          existingAgents={
            projectWizard.project
              ? projectAgents.filter((pa) => pa.project_id === projectWizard.project?.id)
              : []
          }
          muses={muses}
          openaiAgents={openaiAgents}
          onClose={() => setProjectWizard({ open: false, project: null })}
          onSaved={onProjectSaved}
        />
      )}
      {newConvProject && (
        <NewConversationModal
          project={newConvProject}
          projectAgents={projectAgents.filter((pa) => pa.project_id === newConvProject.id)}
          muses={muses}
          openaiAgents={openaiAgents}
          onClose={() => setNewConvProject(null)}
          onEditProjectAgents={() => setProjectWizard({ open: true, project: newConvProject })}
          onCreated={onConversationCreated}
        />
      )}
      <ToastHost />
    </div>
  );
}
