import { useEffect, useRef, useState, type ReactNode } from "react";
import { tNow, useLang, type I18nKey } from "../lib/i18n";

// ---- toast -----------------------------------------------------------------

let pushToast: ((text: string) => void) | null = null;

/** Fire-and-forget notification; rendered by <ToastHost/> at the app root. */
export function toast(text: string): void {
  pushToast?.(text);
}

export function ToastHost() {
  const [items, setItems] = useState<{ id: number; text: string }[]>([]);
  useEffect(() => {
    let next = 0;
    pushToast = (text) => {
      const id = next++;
      setItems((cur) => [...cur, { id, text }]);
      setTimeout(() => setItems((cur) => cur.filter((t) => t.id !== id)), 2200);
    };
    return () => {
      pushToast = null;
    };
  }, []);
  return (
    <div id="toast" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="toast-item">{t.text}</div>
      ))}
    </div>
  );
}

// ---- language toggle -------------------------------------------------------

export function LangToggle({ compact = false }: { compact?: boolean }) {
  const { lang, setLang, t } = useLang();
  return (
    <div
      className={`lang-toggle${compact ? " compact" : ""}`}
      role="radiogroup"
      aria-label={t("lang.groupAria")}
    >
      <button
        type="button"
        role="radio"
        aria-checked={lang === "vi"}
        className={`lang-opt${lang === "vi" ? " on" : ""}`}
        onClick={() => setLang("vi")}
      >
        VI
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={lang === "en"}
        className={`lang-opt${lang === "en" ? " on" : ""}`}
        onClick={() => setLang("en")}
      >
        EN
      </button>
    </div>
  );
}

// ---- chips -----------------------------------------------------------------

const CHIP_KEY: Record<string, I18nKey> = {
  pending: "chip.pending",
  processing: "chip.processing",
  done: "chip.done",
  failed: "chip.failed",
  expired: "chip.expired",
  idle: "chip.idle",
};

export function Chip({ state, label }: { state: string; label?: string }) {
  const { t } = useLang();
  const key = CHIP_KEY[state];
  return <span className={`chip ${state}`}>{label ?? (key ? t(key) : state)}</span>;
}

// ---- modal -----------------------------------------------------------------

export function Modal(props: {
  open: boolean;
  /** Escape-to-close is disabled while false (e.g. one-time token screens). */
  dismissable?: boolean;
  onClose: () => void;
  labelledBy: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const { open, dismissable = true, onClose, labelledBy, children, wide } = props;
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      prevFocus?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open || !dismissable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, dismissable, onClose]);
  if (!open) return null;
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={`dialog fade${wide ? " dialog-wide" : ""}`}
      >
        {children}
      </div>
    </div>
  );
}

// ---- form bits -------------------------------------------------------------

export function ErrorMsg({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="msg err" role="status">{text}</div>
  );
}

/** Temporarily flips a button into its busy state during async work. */
export function setButtonBusy(
  btn: HTMLButtonElement | null,
  busyText: string,
): () => void {
  if (!btn) return () => undefined;
  const original = btn.textContent;
  btn.dataset.label = original ?? "";
  btn.textContent = busyText;
  btn.classList.add("is-loading");
  btn.disabled = true;
  return () => {
    btn.classList.remove("is-loading");
    btn.disabled = false;
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
    void original;
  };
}

export async function copyText(text: string, note?: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast(note ?? tNow("common.copied"));
    return true;
  } catch {
    toast(tNow("common.copyFailed"));
    return false;
  }
}
