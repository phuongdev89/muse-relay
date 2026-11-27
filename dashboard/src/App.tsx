import { useCallback, useEffect, useState } from "react";
import { listGroups, listMuses } from "./lib/api";
import type { Group, GroupMember, Muse } from "./types";
import { AddMuseWizard } from "./components/AddMuseWizard";
import { GroupRoom } from "./components/GroupRoom";
import { GroupWizard } from "./components/GroupWizard";
import { LoginView } from "./components/LoginView";
import { MuseRoom } from "./components/MuseRoom";
import { Sidebar, type ActiveRoom } from "./components/Sidebar";
import { ToastHost, toast } from "./components/ui";
import { db } from "./lib/supabase";

export default function App() {
  const [booted, setBooted] = useState(false);
  const [ownerEmail, setOwnerEmail] = useState("");
  const [muses, setMuses] = useState<Muse[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [members, setMembers] = useState<Map<string, GroupMember[]>>(new Map());
  const [active, setActive] = useState<ActiveRoom>(null);
  const [showMuseWizard, setShowMuseWizard] = useState(false);
  const [showGroupWizard, setShowGroupWizard] = useState(false);

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

  const enterApp = useCallback(async (email: string) => {
    setOwnerEmail(email);
    const [museList, groupList] = await Promise.all([loadMuses(), loadGroups()]);
    setActive((cur) => {
      if (cur) return cur;
      if (museList.length > 0) return { kind: "muse", recipient: museList[0].recipient };
      if (groupList.length > 0) return { kind: "group", id: groupList[0].id };
      return null;
    });
  }, [loadMuses, loadGroups]);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await db.auth.getSession();
      if (session?.user?.email) await enterApp(session.user.email);
      setBooted(true);
    })();
  }, [enterApp]);

  async function logout() {
    await db.auth.signOut();
    setOwnerEmail("");
    setMuses([]);
    setGroups([]);
    setMembers(new Map());
    setActive(null);
  }

  // ---- muse registry mutations ---------------------------------------------

  function onMuseCreated(muse: Muse) {
    setMuses((cur) =>
      cur.some((m) => m.recipient === muse.recipient) ? cur : [...cur, muse],
    );
    setActive({ kind: "muse", recipient: muse.recipient });
    void loadMuses();
  }

  function onMuseRenamed(recipient: string, name: string) {
    setMuses((cur) => cur.map((m) => (m.recipient === recipient ? { ...m, name } : m)));
    toast("Đã đổi tên");
  }

  function onMuseDeleted(recipient: string) {
    const remaining = muses.filter((m) => m.recipient !== recipient);
    setMuses(remaining);
    if (active?.kind === "muse" && active.recipient === recipient) {
      setActive(remaining.length > 0 ? { kind: "muse", recipient: remaining[0].recipient } : null);
    }
    toast("Đã xoá Muse");
    void loadGroups(); // memberships may have changed
  }

  function onGroupCreated(groupId: string) {
    setShowGroupWizard(false);
    void loadGroups().then(() => setActive({ kind: "group", id: groupId }));
  }

  if (!booted) return <div className="boot-screen">…</div>;

  const activeMuse = active?.kind === "muse"
    ? muses.find((m) => m.recipient === active.recipient) ?? null
    : null;
  const activeGroup = active?.kind === "group"
    ? groups.find((g) => g.id === active.id) ?? null
    : null;

  if (!ownerEmail) {
    return (
      <>
        <LoginView onSignedIn={(email) => enterApp(email)} />
        <ToastHost />
      </>
    );
  }

  return (
    <div id="app-view" className="fade">
      <Sidebar
        muses={muses}
        groups={groups}
        groupMembers={members}
        active={active}
        ownerEmail={ownerEmail}
        onSwitchRoom={setActive}
        onAddMuse={() => setShowMuseWizard(true)}
        onAddGroup={() => setShowGroupWizard(true)}
        onLogout={logout}
      />

      <main className="main">
        {activeMuse ? (
          <MuseRoom
            key={activeMuse.recipient}
            muse={activeMuse}
            onRenamed={onMuseRenamed}
            onDeleted={onMuseDeleted}
          />
        ) : activeGroup ? (
          <GroupRoom
            key={activeGroup.id}
            group={activeGroup}
            members={members.get(activeGroup.id) ?? []}
          />
        ) : (
          <section className="main-empty fade">
            <h2>Chưa có phòng nào</h2>
            <p className="sub">Bấm “＋ Thêm Muse” ở thanh trái để đăng ký Muse đầu tiên.</p>
            <button className="btn" onClick={() => setShowMuseWizard(true)}>＋ Thêm Muse</button>
          </section>
        )}
      </main>

      {showMuseWizard && (
        <AddMuseWizard onClose={() => setShowMuseWizard(false)} onCreated={onMuseCreated} />
      )}
      {showGroupWizard && (
        <GroupWizard muses={muses} onClose={() => setShowGroupWizard(false)} onCreated={onGroupCreated} />
      )}
      <ToastHost />
    </div>
  );
}
