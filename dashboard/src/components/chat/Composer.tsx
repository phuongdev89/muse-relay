import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { MAX_ATTACH_FILES, mergeAttachmentFiles } from "../../lib/dropbox";
import { fmtFileSize } from "../../lib/format";
import { useLang } from "../../lib/i18n";
import type { ActionMode, MessageParams } from "../../types";
import {
  ChevronDownIcon,
  ImageIcon,
  MessageIcon,
  PaperclipIcon,
  SendIcon,
  SlidersIcon,
  VideoIcon,
  XIcon,
} from "../common/Icons";
import { ErrorMsg } from "../common/ui";

const MAX_PROMPT_LEN = 4000;
const THREAD_RE = /^[A-Za-z0-9_-]{1,64}$/;

// One composer, three modes (default chat). Builds the exact params payload
// the submit_message contract validates server-side.
export function Composer(props: {
  placeholder: string;
  onSend: (action: ActionMode, params: MessageParams, files: File[]) => void | Promise<unknown>;
  /** image/video modes are disabled in group / openai / mixed rooms */
  mediaModes?: boolean;
  /** which action tabs to show (muse caps gate this in the direct channel) */
  allowedModes?: ActionMode[];
  /** hides the manual thread_id field when a conversation locks thread_id */
  hideThreadInput?: boolean;
  /** allows attaching up to 4 files (<= 50 MB) to upload to Muse's Dropbox */
  allowAttachments?: boolean;
  /** optional controlled attachment list (used for room-wide drag & drop) */
  files?: File[];
  onFilesChange?: (files: File[]) => void;
  /** disables composing & sending (e.g. direct Muse channel not yet set up) */
  disabled?: boolean;
  /** banner rendered right above the composer shell while disabled */
  disabledBanner?: ReactNode;
  /** relay-group member names offered as @mention chips (@all always included) */
  mentionNames?: string[];
}) {
  const {
    mediaModes = true,
    hideThreadInput = false,
    allowAttachments = false,
    disabled = false,
    disabledBanner,
  } = props;
  const { lang, t } = useLang();

  const [mode, setMode] = useState<ActionMode>("chat");
  const [prompt, setPrompt] = useState("");
  const [internalFiles, setInternalFiles] = useState<File[]>([]);
  const [ar, setAr] = useState("9:16");
  const [count, setCount] = useState(1);
  const [dur, setDur] = useState(8);
  const [thread, setThread] = useState("");
  const [resType, setResType] = useState("auto");
  const [outFmt, setOutFmt] = useState("auto");
  const [optsOpen, setOptsOpen] = useState(false);
  const [error, setError] = useState("");

  // If the allowed set changes under an open composer (caps edited elsewhere),
  // fall back to the first allowed tab instead of sending a gated action.
  const allowedModes = props.allowedModes;
  useEffect(() => {
    if (!allowedModes || allowedModes.length === 0) return;
    if (!allowedModes.includes(mode)) {
      setMode(allowedModes[0]);
      setError("");
    }
  }, [allowedModes, mode]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const attachedFiles = props.files ?? internalFiles;
  const setAttachedFiles = (next: File[]) => {
    if (props.onFilesChange) props.onFilesChange(next);
    else setInternalFiles(next);
  };

  // Create & revoke thumbnail object URLs cleanly inside useEffect (StrictMode-safe)
  const [thumbUrls, setThumbUrls] = useState<Map<File, string>>(() => new Map());

  useEffect(() => {
    const next = new Map<File, string>();
    for (const file of attachedFiles) {
      if (file.type.startsWith("image/")) {
        next.set(file, URL.createObjectURL(file));
      }
    }
    setThumbUrls(next);
    return () => {
      for (const url of next.values()) {
        URL.revokeObjectURL(url);
      }
    };
  }, [attachedFiles]);

  function switchMode(next: ActionMode) {
    if (disabled) return;
    setMode(next);
    setError("");
    if (next === "image" || next === "video") {
      setOptsOpen(true);
    }
  }

  // Group mention chips append `@Name`/`@all` to the prompt — the server fans
  // the utterance out to exactly the mentioned members (no mention = nobody).
  function insertMention(token: string) {
    if (disabled) return;
    setPrompt((cur) => {
      const needsSpace = cur.length > 0 && !/\s$/.test(cur);
      return `${cur}${needsSpace ? " " : ""}${token}`;
    });
    setError("");
  }

  function handlePickFiles(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (picked.length === 0) return;
    setError("");
    const maxForMode = mode === "video" ? 2 : MAX_ATTACH_FILES;
    const { files, rejectedLarge, overflowCount } = mergeAttachmentFiles(
      attachedFiles,
      picked,
      maxForMode,
    );
    setAttachedFiles(files);
    if (rejectedLarge.length > 0) {
      setError(t("composer.fileSizeErr", { name: rejectedLarge[0].name }));
    } else if (overflowCount > 0) {
      setError(
        mode === "video"
          ? t("composer.videoMaxFilesErr")
          : t("composer.maxFilesErr", { max: MAX_ATTACH_FILES }),
      );
    }
  }

  function removeFile(idx: number) {
    setAttachedFiles(attachedFiles.filter((_, i) => i !== idx));
    setError("");
  }

  function buildParams(): MessageParams | string {
    const rawTrimmed = prompt.trim();
    if (rawTrimmed.length === 0 && attachedFiles.length === 0) {
      return t("composer.lenErr", { max: MAX_PROMPT_LEN });
    }
    if (rawTrimmed.length > MAX_PROMPT_LEN) {
      return t("composer.lenErr", { max: MAX_PROMPT_LEN });
    }
    if (mode === "video" && attachedFiles.length > 2) {
      return t("composer.videoMaxFilesErr");
    }

    const effectivePrompt =
      rawTrimmed.length > 0
        ? rawTrimmed
        : t("composer.attachedFallback", {
            names: attachedFiles.map((f) => f.name).join(", "),
          })
            .slice(0, MAX_PROMPT_LEN)
            .trim();

    const th = hideThreadInput ? "" : thread.trim();
    if (th && !THREAD_RE.test(th)) {
      return t("composer.threadErr");
    }
    const params: MessageParams = { prompt: effectivePrompt };
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

  function submit() {
    if (disabled) return;
    setError("");
    const built = buildParams();
    if (typeof built === "string") {
      setError(built);
      return;
    }
    const filesSnapshot = [...attachedFiles];
    const modeSnapshot = mode;

    // Clear composer synchronously so user can immediately type the next message
    setPrompt("");
    setAttachedFiles([]);
    setError("");

    void props.onSend(modeSnapshot, built, filesSnapshot);
  }

  const charCount = prompt.length;
  const charState =
    charCount > MAX_PROMPT_LEN ? "over" : charCount > 3600 ? "warn" : "";

  const allModeTabs: { value: ActionMode; label: string; icon: JSX.Element }[] = [
    { value: "chat", label: t("composer.tabChat"), icon: <MessageIcon size={13} /> },
    { value: "image", label: t("composer.tabImage"), icon: <ImageIcon size={13} /> },
    { value: "video", label: t("composer.tabVideo"), icon: <VideoIcon size={13} /> },
  ];
  const modeTabs = allModeTabs.filter(
    (tab) => !allowedModes || allowedModes.includes(tab.value),
  );

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
              submit();
            }
          }}
        />

        {props.mentionNames && props.mentionNames.length > 0 && !disabled && (
          <div className="mention-chips" aria-label={t("composer.mentionAria")}>
            <button
              type="button"
              className="mention-chip is-all"
              onClick={() => insertMention("@all ")}
              title={t("composer.mentionAllTitle")}
            >
              @all
            </button>
            {props.mentionNames.map((name) => (
              <button
                key={name}
                type="button"
                className="mention-chip"
                onClick={() => insertMention(`@${name} `)}
                title={t("composer.mentionTitle", { name })}
              >
                @{name}
              </button>
            ))}
          </div>
        )}

        {allowAttachments && !disabled && attachedFiles.length > 0 && (
          <div className="composer-attachments">
            {attachedFiles.map((file, idx) => {
              const url = thumbUrls.get(file) ?? null;
              return (
              <div
                key={`${file.name}-${file.size}-${file.lastModified}-${idx}`}
                className="attach-chip"
              >
                {url ? (
                  <img src={url} alt={file.name} className="attach-thumb" />
                ) : (
                  <span className="attach-icon" aria-hidden="true">
                    <PaperclipIcon size={13} />
                  </span>
                )}
                <span className="attach-meta">
                  <span className="attach-name" title={file.name}>{file.name}</span>
                  <span className="attach-size">{fmtFileSize(file.size, lang)}</span>
                </span>
                <button
                  type="button"
                  className="attach-remove"
                  onClick={() => removeFile(idx)}
                  aria-label={t("composer.removeFileAria", { name: file.name })}
                  title={t("composer.removeFileAria", { name: file.name })}
                >
                  <XIcon size={12} />
                </button>
              </div>
              );
            })}
          </div>
        )}

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
          {allowAttachments && !disabled && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={handlePickFiles}
              />
              <button
                type="button"
                className="composer-attach-btn"
                onClick={() => fileInputRef.current?.click()}
                title={t("composer.attachTitle")}
                aria-label={t("composer.attachAria")}
              >
                <PaperclipIcon size={14} />
                <span className="hide-xs">{t("composer.attach")}</span>
              </button>
            </>
          )}

          {mediaModes && activeThread && (
            <span className="composer-thread-pill" title={t("composer.threadAttachedTitle")}>
              #{activeThread}
            </span>
          )}

          <span className="grow" />

          <span className={`char-counter${charState ? ` ${charState}` : ""}`}>
            {charCount} / {MAX_PROMPT_LEN}
          </span>

          {mediaModes && modeTabs.length > 0 && (
            <div className="mode-tabs" role="tablist" aria-label={t("composer.modeAria")}>
              {modeTabs.map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  role="tab"
                  disabled={disabled}
                  aria-selected={mode === tab.value}
                  aria-label={tab.label}
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
              aria-label={t("composer.options")}
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
            className="btn btn-send"
            aria-label={t("composer.send")}
            disabled={disabled}
            onClick={submit}
          >
            <SendIcon size={14} />
            <span>{t("composer.send")}</span>
          </button>
        </div>
      </div>

      <ErrorMsg text={error} />
    </div>
  );
}
