import { useState } from "react";
import { createGroup } from "../lib/api";
import type { Muse } from "../types";
import { ErrorMsg, Modal, setButtonBusy } from "./ui";

export function GroupWizard(props: {
  muses: Muse[];
  onClose: () => void;
  onCreated: (groupId: string) => void;
}) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState("");

  function toggle(recipient: string, museName: string) {
    setPicked((cur) => {
      const next = new Map(cur);
      if (next.has(recipient)) next.delete(recipient);
      else next.set(recipient, museName);
      return next;
    });
  }

  async function submit() {
    setError("");
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 64) {
      setError("Thiếu tên nhóm (1–64 ký tự).");
      return;
    }
    if (picked.size < 1) {
      setError("Chọn ít nhất 1 Muse.");
      return;
    }
    const btn = document.getElementById("gw-create") as HTMLButtonElement | null;
    const undo = setButtonBusy(btn, "Đang tạo…");
    const { id, error: err } = await createGroup(
      trimmed,
      [...picked.entries()].map(([muse_recipient, museName]) => ({
        muse_recipient,
        name: museName,
      })),
    );
    undo();
    if (err || !id) {
      setError("Lỗi tạo nhóm: " + (err ?? "không rõ"));
      return;
    }
    props.onCreated(id);
  }

  return (
    <Modal open onClose={props.onClose} labelledBy="gwiz-title">
      <h2 id="gwiz-title">Tạo nhóm</h2>
      <p className="lead">
        Anh là người khởi xướng duy nhất: tin đầu tiên của nhóm luôn từ anh. Các Muse trả lời
        nhau qua cơ chế nhận việc hiện có, tối đa 12 lượt tự động rồi dừng chờ anh.
      </p>
      <label htmlFor="g-name">Tên nhóm</label>
      <input
        id="g-name"
        value={name}
        maxLength={64}
        placeholder="vd: Ban nội dung"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      <label>Thành viên (chọn ít nhất 1 Muse)</label>
      <div className="check-list">
        {props.muses.map((m) => (
          <label key={m.recipient} className="check-item">
            <input
              type="checkbox"
              checked={picked.has(m.recipient)}
              onChange={() => toggle(m.recipient, m.name)}
            />
            {m.name}
          </label>
        ))}
        {props.muses.length === 0 && <span className="hint">Chưa có Muse nào để thêm vào nhóm.</span>}
      </div>
      <ErrorMsg text={error} />
      <div className="actions">
        <button id="gw-create" className="btn" onClick={submit}>Tạo nhóm</button>
        <button className="btn-ghost" onClick={props.onClose}>Huỷ</button>
      </div>
    </Modal>
  );
}
