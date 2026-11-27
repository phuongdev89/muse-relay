import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { RefreshIcon, StarIcon } from "./components/common/Icons";
import { loadRuntimeConfig } from "./lib/config";
import { getStoredLang, translate } from "./lib/i18n";
import { initSupabase } from "./lib/supabase";
import { applyTheme, getStoredTheme } from "./lib/theme";
import "./styles/tokens.css";
import "./styles/app.css";

function BootErrorCard({ message }: { message: string }) {
  const lang = getStoredLang();
  const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) =>
    translate(lang, key, vars);

  return (
    <section id="login-view" className="fade" role="alert">
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

        <h2 style={{ fontSize: "var(--text-md)", margin: "0 0 var(--space-2xs)" }}>
          {t("boot.configErrTitle")}
        </h2>
        <p className="sub">{t("boot.configErrLead")}</p>
        <div className="msg err">{t("common.errorPrefix", { err: message })}</div>

        <button
          type="button"
          className="btn"
          onClick={() => window.location.reload()}
        >
          <RefreshIcon size={14} />
          <span>{t("common.retry")}</span>
        </button>
      </div>
    </section>
  );
}

async function boot() {
  applyTheme(getStoredTheme());
  document.documentElement.lang = getStoredLang();

  const root = createRoot(document.getElementById("root")!);
  try {
    await loadRuntimeConfig();
    initSupabase();
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    root.render(
      <StrictMode>
        <BootErrorCard message={message} />
      </StrictMode>,
    );
  }
}

void boot();
