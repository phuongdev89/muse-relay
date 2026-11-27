import { useState, type ReactNode } from "react";
import { useLang } from "../lib/i18n";
import type { ActionMode, MessageParams } from "../types";
import {
  ChevronDownIcon,
  ImageIcon,
  MessageIcon,
  SendIcon,
  SlidersIcon,
  VideoIcon,
} from "./Icons";
import { ErrorMsg } from "./ui";

const MAX_PROMPT_LEN = 4000;

// One composer, three modes (default chat). Builds the exact params payload
// the submit_message contract validates server-side.
export function Composer(props: {
  placeholder: string;
  onSend: (action: ActionMode, params: MessageParams) => Promise<string | null>;
  /** image/video modes are disabled in group / openai / mixed rooms */
  mediaModes?: boolean;
  /** hides the manual thread_id field when a conversation locks thread_id */
  hideThreadInput?: boolean;
  /** disables composing & sending (e.g. direct Muse channel not yet set up) */
  disabled?: boolean;
  /** banner rendered right above the composer shell while disabled */
  disabledBanner?: ReactNode;
}) {
  const { mediaModes = true, hideThreadInput = false, disabled = false, disabledBanner } = props;
  const { t } = useLang();

  const [mode, setMode] = useState<ActionMode>("chat");
  const [prompt, setPrompt] = useState("");
  const [ar, setAr] = useState("9:16");
  const [count, setCount] = useState(1);
  const [dur, setDur] = useState(8);
  const [thread, setThread] = useState("");
  const [resType, setResType] = useState("auto");
  const [outFmt, setOutFmt] = useState("auto");
  const [optsOpen, setOptsOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const THREAD_RE = /^[A-Za-z0-9_-]{1,64}$/;

  function switchMode(next: ActionMode) {
    if (disabled) return;
    setMode(next);
    setError("");
    if (next === "image" || next === "video") {
      setOptsOpen(true);
    }
  }

  function buildParams(): MessageParams | string {
    const p = prompt.trim();
    if (p.length < 1 || p.length > MAX_PROMPT_LEN) {
      return t("composer.lenErr", { max: MAX_PROMPT_LEN });
    }
    const th = hideThreadInput ? "" : thread.trim();
    if (th && !THREAD_RE.test(th)) {
      return t("composer.threadErr");
    }
    const params: MessageParams = { prompt: p };
    if (th) params.thread_id = th;
    if (mode === "chat") {
      params.resource_type = resType;
      params.output_format = outFmt;
      return params;
    }
    params.reference_storage_paths = [];
    params.aspect_ratio = ar;
    if (mode === "image") {
      if (!(count >= 1 && count <= 4)) return t("composer.countErr");
      params.count = count;
    } else {
      if (!(dur >= 5 && dur <= 10)) return t("composer.durErr");
      params.duration_seconds = dur;
    }
    return params;
  }

  async function submit() {
    if (disabled || sending) return;
    setError("");
    const built = buildParams();
    if (typeof built === "string") {
      setError(built);
      return;
    }
    setSending(true);
    const err = await props.onSend(mode, built);
    setSending(false);
    if (err) {
      setError(t("composer.sendErr", { err }));
      return;
    }
    setPrompt("");
  }

  const charCount = prompt.length;
  const charState =
    charCount > MAX_PROMPT_LEN ? "over" : charCount > 3600 ? "warn" : "";

  const modeTabs: { value: ActionMode; label: string; icon: JSX.Element }[] = [
    { value: "chat", label: t("composer.tabChat"), icon: <MessageIcon size={13} /> },
    { value: "image", label: t("composer.tabImage"), icon: <ImageIcon size={13} /> },
    { value: "video", label: t("composer.tabVideo"), icon: <VideoIcon size={13} /> },
  ];

  const activeThread = !hideThreadInput ? thread.trim() : "";

  return (
    <div className="composer-block">
      {disabled && disabledBanner}

      <div className={`composer-shell${disabled ? " is-disabled" : ""}`}>
        <textarea
          rows={2}
          value={prompt}
          disabled={disabled}
          placeholder={props.placeholder}
          aria-label={props.placeholder}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (disabled) return;
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />

        {mediaModes && optsOpen && !disabled && (
          <div className="composer-drawer">
            <div className="composer-opts">
              {mode === "chat" ? (
                <>
                  <label>
                    {t("composer.resourceType")}
                    <select value={resType} onChange={(e) => setResType(e.target.value)}>
                      {["auto", "none", "image", "video", "document", "archive"].map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t("composer.outputFormat")}
                    <select value={outFmt} onChange={(e) => setOutFmt(e.target.value)}>
                      {["auto", "md", "txt", "csv", "docx", "xlsx", "zip"].map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                  {!hideThreadInput && (
                    <label>
                      {t("composer.threadOpt")}
                      <input
                        value={thread}
                        placeholder={t("composer.threadPlaceholder")}
                        onChange={(e) => setThread(e.target.value)}
                      />
                    </label>
                  )}
                </>
              ) : (
                <>
                  <label>
                    {t("composer.aspectRatio")}
                    <select value={ar} onChange={(e) => setAr(e.target.value)}>
                      {(mode === "video"
                        ? ["9:16", "16:9"]
                        : ["9:16", "16:9", "1:1", "4:5", "3:4"]
                      ).map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                  {mode === "image" ? (
                    <label>
                      {t("composer.imageCount")}
                      <input
                        type="number"
                        min={1}
                        max={4}
                        value={count}
                        onChange={(e) => setCount(parseInt(e.target.value || "1", 10))}
                      />
                    </label>
                  ) : (
                    <label>
                      {t("composer.duration")}
                      <input
                        type="number"
                        min={5}
                        max={10}
                        value={dur}
                        onChange={(e) => setDur(parseInt(e.target.value || "8", 10))}
                      />
                    </label>
                  )}
                  {!hideThreadInput && (
                    <label>
                      {t("composer.threadOpt")}
                      <input
                        value={thread}
                        placeholder={t("composer.threadMediaPlaceholder")}
                        onChange={(e) => setThread(e.target.value)}
                      />
                    </label>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        <div className="composer-bar">
          {mediaModes && activeThread && (
            <span className="composer-thread-pill" title={t("composer.threadAttachedTitle")}>
              #{activeThread}
            </span>
          )}

          <span className={`char-counter${charState ? ` ${charState}` : ""}`}>
            {charCount} / {MAX_PROMPT_LEN}
          </span>

          {mediaModes && (
            <div className="mode-tabs" role="tablist" aria-label={t("composer.modeAria")}>
              {modeTabs.map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  role="tab"
                  disabled={disabled}
                  aria-selected={mode === tab.value}
                  className={`mode-tab${mode === tab.value ? " on" : ""}`}
                  onClick={() => switchMode(tab.value)}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                </button>
              ))}
            </div>
          )}

          {mediaModes && (
            <button
              type="button"
              disabled={disabled}
              className={`composer-opt-btn${optsOpen && !disabled ? " on" : ""}`}
              aria-expanded={optsOpen && !disabled}
              onClick={() => {
                if (!disabled) setOptsOpen((v) => !v);
              }}
            >
              <SlidersIcon size={14} />
              <span>{t("composer.options")}</span>
              <ChevronDownIcon
                size={13}
                className={`opt-chevron${optsOpen && !disabled ? " open" : ""}`}
              />
            </button>
          )}

          <button
            id="composer-send"
            type="button"
            className={`btn btn-send${sending ? " is-loading" : ""}`}
            disabled={disabled || sending}
            onClick={submit}
          >
            <SendIcon size={14} />
            <span>{sending ? t("composer.sending") : t("composer.send")}</span>
          </button>
        </div>
      </div>

      <ErrorMsg text={error} />
    </div>
  );
}
