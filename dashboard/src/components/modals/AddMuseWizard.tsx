import { useState } from "react";
import { createMuse, randomHex, sha256Hex } from "../../lib/api";
import { emailToRoot } from "../../lib/dropbox";
import { useLang } from "../../lib/i18n";
import { buildInstructions } from "../../lib/instructions";
import { db } from "../../lib/supabase";
import type { Muse } from "../../types";
import { CapsPicker, type MuseCaps } from "../common/CapsPicker";
import { TokenPanel } from "../common/TokenPanel";
import { copyText, ErrorMsg, Modal, setButtonBusy } from "../common/ui";

// Step 1 collects only what a human knows naturally — a display name and the
// muse's own email. The Dropbox root (which must look like /email/) is derived,
// never typed: no manual slashes to get wrong.
// Step 2 shows the one-time token + the canonical onboarding instructions.
export function AddMuseWizard(props: {
  onClose: () => void;
  onCreated: (muse: Muse) => void;
}) {
  const { t } = useLang();
  const [step, setStep] = useState<"form" | "done">("form");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [caps, setCaps] = useState<MuseCaps>({
    cap_chat: true,
    cap_image: true,
    cap_video: true,
  });
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ recipient: string; token: string; instructions: string } | null>(null);

  const root = emailToRoot(email);
  const rootPreview = root ?? (email.trim() ? t("wiz.rootInvalid") : t("wiz.rootPending"));

  async function submit() {
    setError("");
    const trimmedName = name.trim();
    if (trimmedName.length < 1 || trimmedName.length > 64) {
      setError(t("wiz.nameErr"));
      return;
    }
    const derivedRoot = emailToRoot(email);
    if (!derivedRoot || derivedRoot.length > 256) {
      setError(t("wiz.emailErr"));
      return;
    }
    if (!caps.cap_chat && !caps.cap_image && !caps.cap_video) {
      setError(t("wiz.capsErr"));
      return;
    }
    const btn = document.getElementById("wiz-create") as HTMLButtonElement | null;
    const undo = setButtonBusy(btn, t("wiz.creating"));

    const recipient = crypto.randomUUID();
    const token = randomHex(32);
    const tokenHash = await sha256Hex(token);
    const { data: { user } } = await db.auth.getUser();
    if (!user) {
      undo();
      setError(t("wiz.sessionExpired"));
      return;
    }
    const trimmedEmail = email.trim().toLowerCase();
    const err = await createMuse({
      owner_id: user.id,
      recipient,
      name: trimmedName,
      token_hash: tokenHash,
      dropbox_root: derivedRoot,
      email_owner: trimmedEmail,
      ...caps,
    });
    undo();
    if (err) {
      setError(t("wiz.createErr", { err }));
      return;
    }
    setResult({
      recipient,
      token,
      instructions: buildInstructions({
        name: trimmedName,
        recipient,
        root: derivedRoot,
      }),
    });
    setStep("done");
    props.onCreated({
      recipient,
      name: trimmedName,
      dropbox_root: derivedRoot,
      email_owner: trimmedEmail,
      ...caps,
      setup_done: false,
      first_connected_at: null,
      last_claim_at: null,
      last_result_at: null,
      token_rotated_at: null,
      created_at: new Date().toISOString(),
    });
  }

  return (
    <Modal
      open
      onClose={props.onClose}
      // step 2 holds a one-time token: Escape must not be able to lose it
      dismissable={step === "form"}
      labelledBy="wiz-title"
      wide
    >
      <h2 id="wiz-title">{t("wiz.title")}</h2>
      {step === "form" ? (
        <>
          <div className="steps"><span className="on" /><span /></div>
          <p className="lead">{t("wiz.lead1")}</p>
          <label htmlFor="w-name">{t("wiz.nameLabel")}</label>
          <input
            id="w-name"
            value={name}
            maxLength={64}
            placeholder={t("wiz.namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          <label htmlFor="w-email">{t("wiz.emailLabel")}</label>
          <input
            id="w-email"
            type="email"
            value={email}
            placeholder={t("wiz.emailPlaceholder")}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          <p className="hint" style={{ marginTop: "var(--space-3xs)" }}>
            {t("wiz.rootHintPrefix")} <code className="path">{rootPreview}</code>{" "}
            {t("wiz.rootHintSuffix")}
          </p>
          <label style={{ marginTop: "var(--space-sm)" }}>{t("wiz.capsLabel")}</label>
          <CapsPicker caps={caps} onChange={setCaps} />
          <p className="hint" style={{ marginTop: "var(--space-3xs)" }}>
            {t("wiz.capsHint")}
          </p>
          <ErrorMsg text={error} />
          <div className="actions">
            <button id="wiz-create" className="btn" onClick={submit}>{t("wiz.createBtn")}</button>
            <button className="btn-ghost" onClick={props.onClose}>{t("common.cancel")}</button>
          </div>
        </>
      ) : (
        <>
          <div className="steps"><span /><span className="on" /></div>
          <p className="lead">{t("wiz.lead2")}</p>
          <TokenPanel token={result?.token ?? ""} />
          <label htmlFor="w-contract" style={{ marginTop: "var(--space-md)" }}>
            {t("wiz.contractLabel")}
          </label>
          <textarea id="w-contract" className="contract" readOnly rows={24} value={result?.instructions ?? ""} />
          <div className="actions">
            <button className="btn" onClick={() => copyText(result?.instructions ?? "", t("wiz.copiedContract"))}>
              {t("wiz.copyContract")}
            </button>
            <button className="btn-ghost" onClick={props.onClose}>{t("wiz.doneClose")}</button>
          </div>
        </>
      )}
    </Modal>
  );
}
