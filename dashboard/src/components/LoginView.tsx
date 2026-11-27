import { useState } from "react";
import { db } from "../lib/supabase";
import { ErrorMsg, setButtonBusy } from "./ui";

export function LoginView({ onSignedIn }: { onSignedIn: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function submit() {
    setError("");
    const btn = document.getElementById("login-btn") as HTMLButtonElement | null;
    const undo = setButtonBusy(btn, "Đang đăng nhập…");
    const { data, error } = await db.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    undo();
    if (error) {
      setError("Lỗi: " + error.message);
      return;
    }
    onSignedIn(data.user.email ?? "");
  }

  return (
    <section id="login-view" className="fade">
      <div className="login-card">
        <div className="wordmark">
          <StarIcon size={22} />
          Muse Relay
        </div>
        <p className="sub">Đăng nhập bằng tài khoản owner của relay (đã tắt đăng ký công khai).</p>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <label htmlFor="password">Mật khẩu</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <button id="login-btn" className="btn" onClick={submit}>Đăng nhập</button>
        <ErrorMsg text={error} />
      </div>
    </section>
  );
}

export function StarIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2l2.4 6.2L21 9.4l-5 4.3 1.6 6.5L12 16.8 6.4 20.2 8 13.7 3 9.4l6.6-1.2L12 2z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
