import { useState } from "react";
import { useLang } from "../lib/i18n";
import { db } from "../lib/supabase";
import { useTheme } from "../lib/theme";
import { MoonIcon, StarIcon, SunIcon } from "./Icons";
import { ErrorMsg, LangToggle, setButtonBusy } from "./ui";

export function LoginView({ onSignedIn }: { onSignedIn: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const { theme, toggleTheme } = useTheme();
  const { t } = useLang();

  async function submit() {
    setError("");
    const btn = document.getElementById("login-btn") as HTMLButtonElement | null;
    const undo = setButtonBusy(btn, t("login.signingIn"));
    const { data, error } = await db.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    undo();
    if (error) {
      setError(t("common.errorPrefix", { err: error.message }));
      return;
    }
    onSignedIn(data.user.email ?? "");
  }

  return (
    <section id="login-view" className="fade">
      <div className="login-corner-controls">
        <LangToggle compact />
        <button
          type="button"
          className="login-theme-btn"
          onClick={toggleTheme}
          aria-label={theme === "dark" ? t("login.toLightAria") : t("login.toDarkAria")}
          title={theme === "dark" ? t("login.lightTitle") : t("login.darkTitle")}
        >
          {theme === "dark" ? <SunIcon size={15} /> : <MoonIcon size={15} />}
          <span>{theme === "dark" ? t("login.light") : t("login.dark")}</span>
        </button>
      </div>

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
            <span className="login-tag">{t("login.tagline")}</span>
          </div>
        </div>

        <p className="sub">{t("login.sub")}</p>

        <label htmlFor="email">{t("login.emailLabel")}</label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          placeholder="owner@domain.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label htmlFor="password">{t("login.passwordLabel")}</label>
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
          {t("login.submit")}
        </button>
        <ErrorMsg text={error} />
      </div>
    </section>
  );
}
