import { useState } from "react";
import { useLang } from "../lib/i18n";
import { CheckIcon, CopyIcon, LockIcon } from "./Icons";
import { copyText } from "./ui";

/** One-time relay-token display. The plaintext token never leaves this panel. */
export function TokenPanel({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);
  const { t } = useLang();

  async function handleCopy() {
    const ok = await copyText(token, t("tp.copiedToast"));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  }

  return (
    <div className="token-panel">
      <div className="tp-head">
        <LockIcon size={15} />
        <span>{t("tp.head")}</span>
      </div>
      <div className="token-row">
        <code className="token-value">{token}</code>
        <button type="button" className="btn-ghost btn-copy-token" onClick={handleCopy}>
          {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          <span>{copied ? t("tp.copied") : t("tp.copyToken")}</span>
        </button>
      </div>
      <p className="token-note">{t("tp.note")}</p>
    </div>
  );
}
