import { useEffect, useRef, useState } from "react";
import {
  clearMuseThread,
  deleteGroup,
  deleteMuse,
  randomHex,
  renameMuse,
  rotateMuseToken,
  sha256Hex,
} from "../lib/api";
import type { Group, Muse } from "../types";
import { ChevronDownIcon, EditIcon, KeyIcon, TrashIcon } from "./Icons";
import { TokenPanel } from "./TokenPanel";
import { ErrorMsg, Modal, setButtonBusy, toast } from "./ui";

// ---- the ▾ menu in a muse room header --------------------------------------

export function MuseManageMenu(props: {
  onRename: () => void;
  onRotate: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="menu-anchor" ref={ref}>
      <button
        type="button"
        className="btn-ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>Quản lý</span>
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              props.onRename();
            }}
          >
            <EditIcon size={14} />
            <span>Đổi tên</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              props.onRotate();
            }}
          >
            <KeyIcon size={14} />
            <span>Rotate token</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              setOpen(false);
              props.onDelete();
            }}
          >
            <TrashIcon size={14} />
            <span>Xoá Muse</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ---- dialogs ----------------------------------------------------------------

export function RenameDialog(props: {
  muse: Muse;
  onClose: () => void;
  onRenamed: (recipient: string, name: string) => void;
}) {
  const [name, setName] = useState(props.muse.name);
  const [error, setError] = useState("");
  async function save() {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 64) {
      setError("Tên phải từ 1–64 ký tự.");
      return;
    }
    if (trimmed === props.muse.name) {
      props.onClose();
      return;
    }
    const err = await renameMuse(props.muse.recipient, trimmed);
    if (err) {
      setError("Lỗi lưu: " + err);
      return;
    }
    props.onRenamed(props.muse.recipient, trimmed);
    props.onClose();
  }
  return (
    <Modal open onClose={props.onClose} labelledBy="rn-title">
      <h2 id="rn-title">Đổi tên Muse</h2>
      <p className="lead">Tên hiển thị trong dashboard và trong các nhóm mà Muse này tham gia.</p>
      <label htmlFor="rn-name">Tên mới</label>
      <input
        id="rn-name"
        value={name}
        maxLength={64}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
      />
      <ErrorMsg text={error} />
      <div className="actions">
        <button className="btn" onClick={save}>Lưu</button>
        <button className="btn-ghost" onClick={props.onClose}>Huỷ</button>
      </div>
    </Modal>
  );
}

export function RotateDialog(props: {
  muse: Muse;
  onClose: () => void;
  onRotated: () => void;
}) {
  const [phase, setPhase] = useState<"confirm" | "done">("confirm");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");

  async function rotate() {
    const btn = document.getElementById("rotate-btn") as HTMLButtonElement | null;
    const undo = setButtonBusy(btn, "Đang sinh token mới…");
    const newToken = randomHex(32);
    const err = await rotateMuseToken(props.muse.recipient, await sha256Hex(newToken));
    undo();
    if (err) {
      setError("Lỗi rotate: " + err);
      return;
    }
    setToken(newToken);
    setPhase("done");
    props.onRotated();
    toast("Đã rotate token");
  }

  return (
    <Modal
      open
      onClose={props.onClose}
      dismissable={phase === "confirm"}
      labelledBy="ro-title"
    >
      {phase === "confirm" ? (
        <>
          <h2 id="ro-title">Rotate token — {props.muse.name}</h2>
          <p className="lead">
            Sinh relay token mới cho Muse này. <b>Token cũ vô hiệu ngay lập tức</b> — nếu Muse
            đang chạy daemon với token cũ, nó sẽ mất quyền claim cho tới khi anh dán token mới
            vào Secure Vault của nó.
          </p>
          <ErrorMsg text={error} />
          <div className="actions">
            <button id="rotate-btn" className="btn" onClick={rotate}>Sinh token mới</button>
            <button className="btn-ghost" onClick={props.onClose}>Thoát</button>
          </div>
        </>
      ) : (
        <>
          <h2 id="ro-title">Token mới đã có hiệu lực</h2>
          <p className="lead">
            Copy ngay — chỉ hiện <b>một lần</b>. Dán vào Secure Vault của {props.muse.name}, rồi
            nhắc nó claim lại (claim trả 401 trước khi cập nhật vault là bình thường).
          </p>
          <TokenPanel token={token} />
          <div className="actions">
            <button className="btn" onClick={props.onClose}>Xong — tôi đã dán vào vault</button>
          </div>
        </>
      )}
    </Modal>
  );
}

export function DeleteDialog(props: {
  muse: Muse;
  onClose: () => void;
  onDeleted: (recipient: string) => void;
}) {
  const [error, setError] = useState("");
  async function remove() {
    const btn = document.getElementById("delete-btn") as HTMLButtonElement | null;
    const undo = setButtonBusy(btn, "Đang xoá…");
    const err = await deleteMuse(props.muse.recipient);
    undo();
    if (err) {
      setError("Lỗi xoá: " + err);
      return;
    }
    props.onDeleted(props.muse.recipient);
  }
  return (
    <Modal open onClose={props.onClose} labelledBy="dl-title">
      <h2 id="dl-title">Xoá Muse — {props.muse.name}</h2>
      <p className="lead">Không thể hoàn tác. Xoá hàng registry sẽ:</p>
      <ul className="lead-list">
        <li>Thu hồi quyền claim <b>ngay lập tức</b> — token của nó trở nên vô nghĩa;</li>
        <li>Gỡ Muse này khỏi mọi nhóm nó đang tham gia;</li>
        <li>Các tin đang chờ trong hàng đợi của nó sẽ không bao giờ được nhận;</li>
        <li>Lịch sử chat của phòng này mất điểm truy cập (dòng tin vẫn nằm trong DB).</li>
      </ul>
      <p className="lead">
        Nếu chỉ muốn chặn tạm thời, hãy dùng <b>Rotate token</b> thay vì xoá.
      </p>
      <ErrorMsg text={error} />
      <div className="actions">
        <button id="delete-btn" className="btn btn-danger" onClick={remove}>Xoá hẳn Muse này</button>
        <button className="btn-ghost" onClick={props.onClose}>Giữ lại</button>
      </div>
    </Modal>
  );
}

export function ClearMuseHistoryDialog(props: {
  muse: Muse;
  onClose: () => void;
  onCleared: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function clear() {
    if (busy) return;
    setBusy(true);
    setError("");
    const err = await clearMuseThread(props.muse.recipient);
    setBusy(false);
    if (err) {
      setError("Lỗi xoá lịch sử: " + err);
      return;
    }
    toast("Đã làm mới lịch sử kênh trực tiếp");
    props.onCleared();
    props.onClose();
  }
  return (
    <Modal open onClose={props.onClose} labelledBy="cl-title">
      <h2 id="cl-title">Xoá lịch sử kênh trực tiếp — {props.muse.name}</h2>
      <p className="lead">
        Xoá toàn bộ tin nhắn và kết quả cũ của <strong>{props.muse.name}</strong> để làm mới dữ liệu.
        Bản thân Muse, token trong Secure Vault và Dropbox root vẫn được giữ nguyên.
      </p>
      <ErrorMsg text={error} />
      <div className="actions">
        <button type="button" className="btn btn-danger" disabled={busy} onClick={clear}>
          {busy ? "Đang xoá…" : "Xoá sạch lịch sử"}
        </button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={props.onClose}>
          Huỷ
        </button>
      </div>
    </Modal>
  );
}

export function DeleteGroupDialog(props: {
  group: Group;
  onClose: () => void;
  onDeleted: (groupId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    if (busy) return;
    setBusy(true);
    setError("");
    const err = await deleteGroup(props.group.id);
    setBusy(false);
    if (err) {
      setError("Lỗi xoá nhóm: " + err);
      return;
    }
    toast("Đã xoá nhóm cũ");
    props.onDeleted(props.group.id);
    props.onClose();
  }
  return (
    <Modal open onClose={props.onClose} labelledBy="dg-title">
      <h2 id="dg-title">Xoá nhóm cũ — {props.group.name}</h2>
      <p className="lead">
        Xoá vĩnh viễn nhóm <strong>{props.group.name}</strong> cùng danh sách thành viên và lịch sử
        hội thoại của nhóm này (không ảnh hưởng tới các Muse hay Project khác).
      </p>
      <ErrorMsg text={error} />
      <div className="actions">
        <button type="button" className="btn btn-danger" disabled={busy} onClick={remove}>
          {busy ? "Đang xoá…" : "Xoá nhóm"}
        </button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={props.onClose}>
          Giữ lại
        </button>
      </div>
    </Modal>
  );
}
