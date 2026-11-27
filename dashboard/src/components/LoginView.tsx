import { useState } from "react";
import { db } from "../lib/supabase";
import { useTheme } from "../lib/theme";
import { MoonIcon, StarIcon, SunIcon } from "./Icons";
import { ErrorMsg, setButtonBusy } from "./ui";

export function LoginView({ onSignedIn }: { onSignedIn: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const { theme, toggleTheme } = useTheme();

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
      <button
        type="button"
        className="login-theme-btn"
        onClick={toggleTheme}
        aria-label={theme === "dark" ? "Chuyển sang giao diện sáng" : "Chuyển sang giao diện tối"}
        title={theme === "dark" ? "Giao diện sáng" : "Giao diện tối"}
      >
        {theme === "dark" ? <SunIcon size={15} /> : <MoonIcon size={15} />}
        <span>{theme === "dark" ? "Sáng" : "Tối"}</span>
      </button>

      <div className="login-card">
        <div className="login-brand">
          <div className="login-emblem">
            <StarIcon size={20} />
          </div>
          <div className="login-brand-copy">
            <div className="wordmark">
              <span>Muse Relay</span>
              <span className="brand-pill">Command</span>
            </div>
            <span className="login-tag">Trung tâm điều phối đội Muse</span>
          </div>
        </div>

        <p className="sub">
          Đăng nhập bằng tài khoản owner của relay (đã tắt đăng ký công khai).
        </p>

        <label htmlFor="email">Email owner</label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          placeholder="owner@domain.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label htmlFor="password">Mật khẩu</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />

        <button id="login-btn" className="btn" onClick={submit}>
          Đăng nhập vào Command Center
        </button>
        <ErrorMsg text={error} />
      </div>
    </section>
  );
}
