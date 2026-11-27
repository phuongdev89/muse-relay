import { copyText } from "./ui";

/** One-time relay-token display. The plaintext token never leaves this panel. */
export function TokenPanel({ token }: { token: string }) {
  return (
    <div className="token-panel">
      <div className="tp-head">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="4" y="10" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="1.8" />
          <path d="M8 10V7a4 4 0 018 0v3" stroke="currentColor" strokeWidth="1.8" />
        </svg>
        RELAY_TOKEN — dán vào Secure Vault của Muse
      </div>
      <div className="token-row">
        <code className="token-value">{token}</code>
        <button type="button" className="btn-ghost" onClick={() => copyText(token, "Đã copy token — dán vào Secure Vault")}>
          Copy token
        </button>
      </div>
      <p className="token-note">
        Chỉ hiện lần này. Không gửi qua chat, không ghi vào file hay log — đúng quy trình vault của Muse.
      </p>
    </div>
  );
}
