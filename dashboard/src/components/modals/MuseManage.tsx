import { useEffect, useRef, useState } from "react";
import {
  clearMuseThread,
  deleteMuse,
  randomHex,
  rotateMuseToken,
  sha256Hex,
  updateMuse,
} from "../../lib/api";
import { isValidDropboxRoot, isValidMuseEmail } from "../../lib/dropbox";
import { useLang } from "../../lib/i18n";
import type { Muse } from "../../types";
import { CapsPicker, type MuseCaps } from "../common/CapsPicker";
import { ChevronDownIcon, EditIcon, KeyIcon, TrashIcon } from "../common/Icons";
import { TokenPanel } from "../common/TokenPanel";
import { ErrorMsg, Modal, setButtonBusy, toast } from "../common/ui";

// ---- the ▾ menu in a muse room header --------------------------------------

export function MuseManageMenu(props: {
  onEdit: () => void;
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
              props.onEdit();
            }}
          >
            <EditIcon size={14} />
            <span>{t("mm.edit")}</span>
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

// Replaces the old rename-only dialog: the same "edit" entry point now also
// updates email_owner, dropbox_root and the routing caps. All of them live on
// relay_muses and go through one updateMuse() call.
export function EditDialog(props: {
  muse: Muse;
  onClose: () => void;
  onUpdated: (
    recipient: string,
    patch: {
      name?: string;
      email_owner?: string | null;
      dropbox_root?: string;
      cap_chat?: boolean;
      cap_image?: boolean;
      cap_video?: boolean;
    },
  ) => void;
}) {
  const [name, setName] = useState(props.muse.name);
  const [email, setEmail] = useState(props.muse.email_owner ?? "");
  const [root, setRoot] = useState(props.muse.dropbox_root);
  const [caps, setCaps] = useState<MuseCaps>({
    cap_chat: props.muse.cap_chat,
    cap_image: props.muse.cap_image,
    cap_video: props.muse.cap_video,
  });
  const [error, setError] = useState("");
  const { t } = useLang();

  async function save() {
    const trimmedName = name.trim();
    if (trimmedName.length < 1 || trimmedName.length > 64) {
      setError(t("mm.nameErr"));
      return;
    }
    const trimmedEmail = email.trim().toLowerCase();
    if (trimmedEmail && !isValidMuseEmail(trimmedEmail)) {
      setError(t("mm.emailErr"));
      return;
    }
    const trimmedRoot = root.trim();
    if (!isValidDropboxRoot(trimmedRoot)) {
      setError(t("mm.rootErr"));
      return;
    }
    if (!caps.cap_chat && !caps.cap_image && !caps.cap_video) {
      setError(t("mm.capsErr"));
      return;
    }
    const patch: {
      name?: string;
      email_owner?: string | null;
      dropbox_root?: string;
      cap_chat?: boolean;
      cap_image?: boolean;
      cap_video?: boolean;
    } = {};
    if (trimmedName !== props.muse.name) patch.name = trimmedName;
    if (trimmedEmail !== (props.muse.email_owner ?? "")) {
      patch.email_owner = trimmedEmail || null;
    }
    if (trimmedRoot !== props.muse.dropbox_root) patch.dropbox_root = trimmedRoot;
    for (const key of ["cap_chat", "cap_image", "cap_video"] as const) {
      if (caps[key] !== props.muse[key]) patch[key] = caps[key];
    }
    if (Object.keys(patch).length === 0) {
      props.onClose();
      return;
    }
    const err = await updateMuse(props.muse.recipient, patch);
    if (err) {
      setError(t("mm.saveErr", { err }));
      return;
    }
    props.onUpdated(props.muse.recipient, patch);
    props.onClose();
  }

  return (
    <Modal open onClose={props.onClose} labelledBy="ed-title">
      <h2 id="ed-title">{t("mm.editTitle", { name: props.muse.name })}</h2>
      <p className="lead">{t("mm.editLead")}</p>
      <label htmlFor="ed-name">{t("mm.nameLabel")}</label>
      <input
        id="ed-name"
        value={name}
        maxLength={64}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
      />
      <label htmlFor="ed-email" style={{ marginTop: "var(--space-sm)" }}>
        {t("mm.emailLabel")}
      </label>
      <input
        id="ed-email"
        type="email"
        value={email}
        placeholder={t("wiz.emailPlaceholder")}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
      />
      <p className="hint" style={{ marginTop: "var(--space-3xs)" }}>
        {t("mm.emailHint")}
      </p>
      <label htmlFor="ed-root" style={{ marginTop: "var(--space-sm)" }}>
        {t("mm.dropboxLabel")}
      </label>
      <input
        id="ed-root"
        value={root}
        maxLength={256}
        onChange={(e) => setRoot(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
      />
      <p className="hint" style={{ marginTop: "var(--space-3xs)" }}>
        {t("mm.rootHint")}
      </p>
      <label style={{ marginTop: "var(--space-sm)" }}>{t("mm.capsLabel")}</label>
      <CapsPicker caps={caps} onChange={setCaps} />
      <p className="hint" style={{ marginTop: "var(--space-3xs)" }}>
        {t("mm.capsHint")}
      </p>
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
