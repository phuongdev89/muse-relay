import type { Group, GroupMember, Muse } from "../types";
import { StarIcon } from "./LoginView";

export type ActiveRoom = { kind: "muse"; recipient: string } | { kind: "group"; id: string } | null;

export function Sidebar(props: {
  muses: Muse[];
  groups: Group[];
  groupMembers: Map<string, GroupMember[]>;
  active: ActiveRoom;
  ownerEmail: string;
  onSwitchRoom: (room: ActiveRoom) => void;
  onAddMuse: () => void;
  onAddGroup: () => void;
  onLogout: () => void;
}) {
  const { muses, groups, active, ownerEmail } = props;
  return (
    <aside className="rail">
      <div className="rail-head">
        <span className="wordmark">
          <StarIcon size={18} />
          Muse Relay
        </span>
      </div>

      <nav className="rail-section" aria-label="Phòng Muse">
        <span className="rail-label">Muse</span>
        <div className="rail-rooms">
          {muses.map((m) => {
            const isActive = active?.kind === "muse" && active.recipient === m.recipient;
            return (
              <button
                key={m.recipient}
                type="button"
                className={`room${isActive ? " active" : ""}`}
                onClick={() => props.onSwitchRoom({ kind: "muse", recipient: m.recipient })}
              >
                <span className="dot" />
                <span className="nm">{m.name}</span>
              </button>
            );
          })}
          {muses.length === 0 && <span className="rail-empty">Chưa có Muse nào</span>}
        </div>
        <button type="button" className="room room-add" onClick={props.onAddMuse}>＋ Thêm Muse</button>
      </nav>

      <nav className="rail-section" aria-label="Phòng nhóm">
        <span className="rail-label">Nhóm</span>
        <div className="rail-rooms">
          {groups.map((g) => {
            const isActive = active?.kind === "group" && active.id === g.id;
            return (
              <button
                key={g.id}
                type="button"
                className={`room${isActive ? " active" : ""}`}
                title={(props.groupMembers.get(g.id) ?? []).map((m) => m.name).join(", ")}
                onClick={() => props.onSwitchRoom({ kind: "group", id: g.id })}
              >
                <span className="dot" />
                <span className="nm">{g.name}</span>
              </button>
            );
          })}
          {groups.length === 0 && <span className="rail-empty">Chưa có nhóm nào</span>}
        </div>
        <button type="button" className="room room-add" onClick={props.onAddGroup}>＋ Tạo nhóm</button>
      </nav>

      <div className="rail-foot">
        <div className="owner-chip">
          <span className="em">{ownerEmail}</span>
          <button type="button" className="btn-quiet" onClick={props.onLogout}>Thoát</button>
        </div>
      </div>
    </aside>
  );
}
