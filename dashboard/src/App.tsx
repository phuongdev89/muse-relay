import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchFleetActivity, listGroups, listMuses } from "./lib/api";
import { summarizeMuseFleet } from "./lib/format";
import { db } from "./lib/supabase";
import type { ActiveRoom, FleetActivityItem, Group, GroupMember, Muse } from "./types";
import { AddMuseWizard } from "./components/AddMuseWizard";
import { GroupRoom } from "./components/GroupRoom";
import { GroupWizard } from "./components/GroupWizard";
import { MenuIcon, PanelRightIcon, StarIcon } from "./components/Icons";
import { InspectorPanel } from "./components/InspectorPanel";
import { LoginView } from "./components/LoginView";
import { DeleteDialog, RenameDialog, RotateDialog } from "./components/MuseManage";
import { MuseRoom } from "./components/MuseRoom";
import { OverviewView } from "./components/OverviewView";
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
  const [groups, setGroups] = useState<Group[]>([]);
  const [members, setMembers] = useState<Map<string, GroupMember[]>>(new Map());
  const [active, setActive] = useState<ActiveRoom>(null);

  const [fleetItems, setFleetItems] = useState<FleetActivityItem[]>([]);
  const [fleetLoading, setFleetLoading] = useState(false);
  const [fleetError, setFleetError] = useState("");
  const [fleetUpdatedAt, setFleetUpdatedAt] = useState<Date | null>(null);

  const [showMuseWizard, setShowMuseWizard] = useState(false);
  const [showGroupWizard, setShowGroupWizard] = useState(false);
  const [museDialog, setMuseDialog] = useState<"rename" | "rotate" | "delete" | null>(null);

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
      await Promise.all([loadMuses(), loadGroups(), loadFleet()]);
      setActive((cur) => cur ?? { kind: "overview" });
    },
    [loadMuses, loadGroups, loadFleet],
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

  // Poll fleet activity while signed in so Overview + Sidebar statuses stay live
  useEffect(() => {
    if (!ownerEmail) return;
    const t = setInterval(() => {
      void loadFleet();
    }, FLEET_POLL_MS);
    return () => clearInterval(t);
  }, [ownerEmail, loadFleet]);

  async function logout() {
    await db.auth.signOut();
    setOwnerEmail("");
    setMuses([]);
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

  // ---- muse registry mutations ---------------------------------------------

  function onMuseCreated(muse: Muse) {
    setMuses((cur) =>
      cur.some((m) => m.recipient === muse.recipient) ? cur : [...cur, muse],
    );
    switchRoom({ kind: "muse", recipient: muse.recipient });
    void loadMuses();
    void loadFleet();
  }

  function onMuseRenamed(recipient: string, name: string) {
    setMuses((cur) => cur.map((m) => (m.recipient === recipient ? { ...m, name } : m)));
    toast("Đã đổi tên");
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
  }

  function onGroupCreated(groupId: string) {
    setShowGroupWizard(false);
    void loadGroups().then(() => switchRoom({ kind: "group", id: groupId }));
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

  const mobileTitle = activeMuse
    ? activeMuse.name
    : activeGroup
      ? activeGroup.name
      : "Tổng quan";

  const effectiveInspectorOpen = isDesktop ? desktopInspectorOpen : mobileInspectorOpen;

  return (
    <div id="app-view" className="fade">
      <Sidebar
        muses={muses}
        groups={groups}
        groupMembers={members}
        fleetSummary={fleetSummary}
        active={active}
        ownerEmail={ownerEmail}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
        onSwitchRoom={switchRoom}
        onAddMuse={() => setShowMuseWizard(true)}
        onAddGroup={() => setShowGroupWizard(true)}
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
            {activeMuse ? (
              <MuseRoom
                key={activeMuse.recipient}
                muse={activeMuse}
                inspectorOpen={effectiveInspectorOpen}
                onToggleInspector={toggleInspector}
                onOpenAction={setMuseDialog}
                onPathsChange={setThreadPaths}
                onMessageSent={() => void loadFleet()}
              />
            ) : activeGroup ? (
              <GroupRoom
                key={activeGroup.id}
                group={activeGroup}
                members={members.get(activeGroup.id) ?? []}
                inspectorOpen={effectiveInspectorOpen}
                onToggleInspector={toggleInspector}
                onPathsChange={setThreadPaths}
              />
            ) : (
              <OverviewView
                muses={muses}
                groups={groups}
                fleetItems={fleetItems}
                loading={fleetLoading}
                error={fleetError}
                updatedAt={fleetUpdatedAt}
                inspectorOpen={effectiveInspectorOpen}
                onToggleInspector={toggleInspector}
                onRefresh={() => {
                  void loadMuses();
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
            threadPaths={threadPaths}
            onMuseAction={(action) => {
              setMobileInspectorOpen(false);
              setMuseDialog(action);
            }}
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
          onRotated={() => undefined}
        />
      )}
      {activeMuse && museDialog === "delete" && (
        <DeleteDialog
          muse={activeMuse}
          onClose={() => setMuseDialog(null)}
          onDeleted={onMuseDeleted}
        />
      )}

      {showMuseWizard && (
        <AddMuseWizard onClose={() => setShowMuseWizard(false)} onCreated={onMuseCreated} />
      )}
      {showGroupWizard && (
        <GroupWizard
          muses={muses}
          onClose={() => setShowGroupWizard(false)}
          onCreated={onGroupCreated}
        />
      )}
      <ToastHost />
    </div>
  );
}
