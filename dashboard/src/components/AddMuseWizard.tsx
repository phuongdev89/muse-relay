import { useState } from "react";
import { createMuse, randomHex, sha256Hex } from "../lib/api";
import { emailToRoot } from "../lib/dropbox";
import { buildInstructions } from "../lib/instructions";
import { db } from "../lib/supabase";
import type { Muse } from "../types";
import { TokenPanel } from "./TokenPanel";
import { copyText, ErrorMsg, Modal, setButtonBusy } from "./ui";

// Step 1 collects only what a human knows naturally — a display name and the
// muse's own email. The Dropbox root (which must look like /email/) is derived,
// never typed: no manual slashes to get wrong.
// Step 2 shows the one-time token + the canonical onboarding instructions.
export function AddMuseWizard(props: {
  onClose: () => void;
  onCreated: (muse: Muse) => void;
}) {
  const [step, setStep] = useState<"form" | "done">("form");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ recipient: string; token: string; instructions: string } | null>(null);

  const root = emailToRoot(email);
  const rootPreview = root ?? (email.trim() ? "email chưa hợp lệ" : "sẽ tự sinh theo email");

  async function submit() {
    setError("");
    const trimmedName = name.trim();
    if (trimmedName.length < 1 || trimmedName.length > 64) {
      setError("Tên Muse phải từ 1–64 ký tự.");
      return;
    }
    const derivedRoot = emailToRoot(email);
    if (!derivedRoot || derivedRoot.length > 256) {
      setError("Email sở hữu Muse chưa hợp lệ (vd: muse2@domain.com).");
      return;
    }
    const btn = document.getElementById("wiz-create") as HTMLButtonElement | null;
    const undo = setButtonBusy(btn, "Đang tạo…");

    const recipient = crypto.randomUUID();
    const token = randomHex(32);
    const tokenHash = await sha256Hex(token);
    const { data: { user } } = await db.auth.getUser();
    if (!user) {
      undo();
      setError("Phiên đăng nhập hết hạn — đăng nhập lại rồi thử lần nữa.");
      return;
    }
    const err = await createMuse({
      owner_id: user.id,
      recipient,
      name: trimmedName,
      token_hash: tokenHash,
      dropbox_root: derivedRoot,
    });
    undo();
    if (err) {
      setError("Lỗi tạo Muse: " + err);
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
      <h2 id="wiz-title">Thêm Muse mới</h2>
      {step === "form" ? (
        <>
          <div className="steps"><span className="on" /><span /></div>
          <p className="lead">
            Đăng ký một Muse vào relay: sinh recipient UUID và relay token mới.
            Token chỉ hiện <b>một lần duy nhất</b> ở bước sau.
          </p>
          <label htmlFor="w-name">Tên Muse (hiển thị trong dashboard)</label>
          <input
            id="w-name"
            value={name}
            maxLength={64}
            placeholder="vd: Muse 2"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          <label htmlFor="w-email">Email sở hữu Muse</label>
          <input
            id="w-email"
            type="email"
            value={email}
            placeholder="vd: muse2@domain.com"
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          <p className="hint" style={{ marginTop: "var(--space-3xs)" }}>
            Dropbox root tự sinh theo email — <code className="path">{rootPreview}</code>{" "}
            (mỗi Muse một thư mục gốc riêng; không cần gõ dấu /).
          </p>
          <ErrorMsg text={error} />
          <div className="actions">
            <button id="wiz-create" className="btn" onClick={submit}>Tạo Muse + sinh token</button>
            <button className="btn-ghost" onClick={props.onClose}>Huỷ</button>
          </div>
        </>
      ) : (
        <>
          <div className="steps"><span /><span className="on" /></div>
          <p className="lead">
            Đã đăng ký. Làm theo đúng thứ tự: <b>(1)</b> copy token ở khung trên, dán vào{" "}
            <b>Secure Vault</b> của Muse — token không bao giờ gửi qua chat; <b>(2)</b> copy khung
            hướng dẫn bên dưới và gửi cho Muse qua chat của nó. Token chỉ hiện lần này; nếu cần đổi
            token sau khi đóng, dùng <b>Quản lý ▾ → Rotate token</b>.
          </p>
          <TokenPanel token={result?.token ?? ""} />
          <label htmlFor="w-contract" style={{ marginTop: "var(--space-md)" }}>
            Hướng dẫn kết nối — gửi cho Muse qua chat (không chứa token)
          </label>
          <textarea id="w-contract" className="contract" readOnly rows={24} value={result?.instructions ?? ""} />
          <div className="actions">
            <button className="btn" onClick={() => copyText(result?.instructions ?? "", "Đã copy hướng dẫn")}>
              Copy hướng dẫn
            </button>
            <button className="btn-ghost" onClick={props.onClose}>Xong — đóng</button>
          </div>
        </>
      )}
    </Modal>
  );
}
