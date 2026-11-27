import { useEffect, useMemo, useState } from "react";
import type { MuseFleetSummary } from "../lib/format";
import { useTheme } from "../lib/theme";
import type { ActiveRoom, Group, GroupMember, Muse } from "../types";
import {
  LogOutIcon,
  MoonIcon,
  OverviewIcon,
  PlusIcon,
  SearchIcon,
  StarIcon,
  SunIcon,
  UsersIcon,
  XIcon,
} from "./Icons";

export type { ActiveRoom };

export function Sidebar(props: {
  muses: Muse[];
  groups: Group[];
  groupMembers: Map<string, GroupMember[]>;
  fleetSummary: Map<string, MuseFleetSummary>;
  active: ActiveRoom;
  ownerEmail: string;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onSwitchRoom: (room: ActiveRoom) => void;
  onAddMuse: () => void;
  onAddGroup: () => void;
  onLogout: () => void;
}) {
  const { muses, groups, groupMembers, fleetSummary, active, ownerEmail, mobileOpen, onCloseMobile } = props;
  const [query, setQuery] = useState("");
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

  const q = query.trim().toLowerCase();
  const filteredMuses = useMemo(
    () => (q ? muses.filter((m) => m.name.toLowerCase().includes(q)) : muses),
    [muses, q],
  );
  const filteredGroups = useMemo(
    () => (q ? groups.filter((g) => g.name.toLowerCase().includes(q)) : groups),
    [groups, q],
  );

  function selectRoom(room: ActiveRoom) {
    props.onSwitchRoom(room);
    onCloseMobile();
  }

  function handleAddMuse() {
    onCloseMobile();
    props.onAddMuse();
  }

  function handleAddGroup() {
    onCloseMobile();
    props.onAddGroup();
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

        <div className="rail-search">
          <SearchIcon size={14} className="rail-search-icon" />
          <input
            type="search"
            value={query}
            placeholder="Tìm Muse hoặc nhóm…"
            aria-label="Tìm Muse hoặc nhóm"
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
          <nav className="rail-section" aria-label="Phòng Muse">
            <div className="rail-label-row">
              <span className="rail-label">Muse ({muses.length})</span>
              <button
                type="button"
                className="rail-add-icon"
                onClick={handleAddMuse}
                title="Thêm Muse mới"
                aria-label="Thêm Muse mới"
              >
                <PlusIcon size={14} />
              </button>
            </div>

            <div className="rail-rooms">
              {filteredMuses.map((m) => {
                const isActive = active?.kind === "muse" && active.recipient === m.recipient;
                const summary = fleetSummary.get(m.recipient);
                const status = summary?.status ?? "idle";
                const activeCount = summary?.activeCount ?? 0;
                return (
                  <button
                    key={m.recipient}
                    type="button"
                    className={`room${isActive ? " active" : ""}`}
                    onClick={() => selectRoom({ kind: "muse", recipient: m.recipient })}
                  >
                    <span className={`dot dot-${status}`} />
                    <span className="nm">{m.name}</span>
                    {activeCount > 0 && (
                      <span className="rail-badge busy">{activeCount}</span>
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

          <nav className="rail-section" aria-label="Phòng nhóm">
            <div className="rail-label-row">
              <span className="rail-label">Nhóm ({groups.length})</span>
              <button
                type="button"
                className="rail-add-icon"
                onClick={handleAddGroup}
                title="Tạo nhóm mới"
                aria-label="Tạo nhóm mới"
              >
                <PlusIcon size={14} />
              </button>
            </div>

            <div className="rail-rooms">
              {filteredGroups.map((g) => {
                const isActive = active?.kind === "group" && active.id === g.id;
                const gms = groupMembers.get(g.id) ?? [];
                const namesTooltip = gms.map((m) => m.name).join(", ");
                return (
                  <button
                    key={g.id}
                    type="button"
                    className={`room${isActive ? " active" : ""}`}
                    title={namesTooltip || "Nhóm chưa có thành viên"}
                    onClick={() => selectRoom({ kind: "group", id: g.id })}
                  >
                    <UsersIcon size={14} className="room-group-icon" />
                    <span className="nm">{g.name}</span>
                    <span className="rail-badge">{gms.length}</span>
                  </button>
                );
              })}
              {filteredGroups.length === 0 && (
                <span className="rail-empty">
                  {groups.length === 0 ? "Chưa có nhóm nào" : "Không tìm thấy nhóm"}
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
