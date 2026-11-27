import { useState } from "react";
import { CheckIcon, CopyIcon, LockIcon } from "./Icons";
import { copyText } from "./ui";

/** One-time relay-token display. The plaintext token never leaves this panel. */
export function TokenPanel({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const ok = await copyText(token, "Đã copy token — dán vào Secure Vault");
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  }

  return (
    <div className="token-panel">
      <div className="tp-head">
        <LockIcon size={15} />
        <span>RELAY_TOKEN — dán vào Secure Vault của Muse</span>
      </div>
      <div className="token-row">
        <code className="token-value">{token}</code>
        <button type="button" className="btn-ghost btn-copy-token" onClick={handleCopy}>
          {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          <span>{copied ? "Đã copy" : "Copy token"}</span>
        </button>
      </div>
      <p className="token-note">
        Chỉ hiện lần này. Không gửi qua chat, không ghi vào file hay log — đúng quy trình vault của Muse.
      </p>
    </div>
  );
}
