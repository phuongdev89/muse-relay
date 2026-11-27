import { useEffect, useRef, useState } from "react";
import {
  clearMuseThread,
  deleteMuse,
  randomHex,
  renameMuse,
  rotateMuseToken,
  sha256Hex,
} from "../lib/api";
import { useLang } from "../lib/i18n";
import type { Muse } from "../types";
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
  const { t } = useLang();

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
        <span>{t("mm.manage")}</span>
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
            <span>{t("mm.rename")}</span>
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
            <span>{t("mm.rotate")}</span>
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
            <span>{t("mm.deleteMuse")}</span>
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
  const { t } = useLang();

  async function save() {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 64) {
      setError(t("mm.nameErr"));
      return;
    }
    if (trimmed === props.muse.name) {
      props.onClose();
      return;
    }
    const err = await renameMuse(props.muse.recipient, trimmed);
    if (err) {
      setError(t("mm.saveErr", { err }));
      return;
    }
    props.onRenamed(props.muse.recipient, trimmed);
    props.onClose();
  }
  return (
    <Modal open onClose={props.onClose} labelledBy="rn-title">
      <h2 id="rn-title">{t("mm.renameTitle")}</h2>
      <p className="lead">{t("mm.renameLead")}</p>
      <label htmlFor="rn-name">{t("mm.renameLabel")}</label>
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
        <button className="btn" onClick={save}>{t("common.save")}</button>
        <button className="btn-ghost" onClick={props.onClose}>{t("common.cancel")}</button>
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
  const { t } = useLang();

  async function rotate() {
    const btn = document.getElementById("rotate-btn") as HTMLButtonElement | null;
    const undo = setButtonBusy(btn, t("mm.rotateBusy"));
    const newToken = randomHex(32);
    const err = await rotateMuseToken(props.muse.recipient, await sha256Hex(newToken));
    undo();
    if (err) {
      setError(t("mm.rotateErr", { err }));
      return;
    }
    setToken(newToken);
    setPhase("done");
    props.onRotated();
    toast(t("mm.rotateOk"));
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
          <h2 id="ro-title">{t("mm.rotateTitle", { name: props.muse.name })}</h2>
          <p className="lead">{t("mm.rotateLead")}</p>
          <ErrorMsg text={error} />
          <div className="actions">
            <button id="rotate-btn" className="btn" onClick={rotate}>{t("mm.rotateBtn")}</button>
            <button className="btn-ghost" onClick={props.onClose}>{t("mm.exit")}</button>
          </div>
        </>
      ) : (
        <>
          <h2 id="ro-title">{t("mm.rotateDoneTitle")}</h2>
          <p className="lead">{t("mm.rotateDoneLead", { name: props.muse.name })}</p>
          <TokenPanel token={token} />
          <div className="actions">
            <button className="btn" onClick={props.onClose}>{t("mm.rotateDoneBtn")}</button>
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
  const { t } = useLang();

  async function remove() {
    const btn = document.getElementById("delete-btn") as HTMLButtonElement | null;
    const undo = setButtonBusy(btn, t("common.deleting"));
    const err = await deleteMuse(props.muse.recipient);
    undo();
    if (err) {
      setError(t("mm.deleteErr", { err }));
      return;
    }
    props.onDeleted(props.muse.recipient);
  }
  return (
    <Modal open onClose={props.onClose} labelledBy="dl-title">
      <h2 id="dl-title">{t("mm.deleteTitle", { name: props.muse.name })}</h2>
      <p className="lead">{t("mm.deleteLead")}</p>
      <ul className="lead-list">
        <li>{t("mm.deleteItem1")}</li>
        <li>{t("mm.deleteItem2")}</li>
        <li>{t("mm.deleteItem3")}</li>
        <li>{t("mm.deleteItem4")}</li>
      </ul>
      <p className="lead">{t("mm.deleteHint")}</p>
      <ErrorMsg text={error} />
      <div className="actions">
        <button id="delete-btn" className="btn btn-danger" onClick={remove}>
          {t("mm.deleteConfirm")}
        </button>
        <button className="btn-ghost" onClick={props.onClose}>{t("common.keep")}</button>
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
  const { t } = useLang();

  async function clear() {
    if (busy) return;
    setBusy(true);
    setError("");
    const err = await clearMuseThread(props.muse.recipient);
    setBusy(false);
    if (err) {
      setError(t("mm.clearErr", { err }));
      return;
    }
    toast(t("mm.clearOk"));
    props.onCleared();
    props.onClose();
  }
  return (
    <Modal open onClose={props.onClose} labelledBy="cl-title">
      <h2 id="cl-title">{t("mm.clearTitle", { name: props.muse.name })}</h2>
      <p className="lead">{t("mm.clearLead", { name: props.muse.name })}</p>
      <ErrorMsg text={error} />
      <div className="actions">
        <button type="button" className="btn btn-danger" disabled={busy} onClick={clear}>
          {busy ? t("common.deleting") : t("mm.clearConfirm")}
        </button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={props.onClose}>
          {t("common.cancel")}
        </button>
      </div>
    </Modal>
  );
}
