import { useState } from "react";
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
  /** image/video modes are disabled in group rooms (server: chat only) */
  mediaModes?: boolean;
}) {
  const { mediaModes = true } = props;
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
    setMode(next);
    setError("");
    if (next === "image" || next === "video") {
      setOptsOpen(true);
    }
  }

  function buildParams(): MessageParams | string {
    const p = prompt.trim();
    if (p.length < 1 || p.length > MAX_PROMPT_LEN) {
      return `Nội dung phải từ 1–${MAX_PROMPT_LEN} ký tự.`;
    }
    const th = thread.trim();
    if (th && !THREAD_RE.test(th)) {
      return "Thread chỉ gồm chữ/số/-/_ (1–64 ký tự).";
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
      if (!(count >= 1 && count <= 4)) return "Số ảnh phải 1–4.";
      params.count = count;
    } else {
      if (!(dur >= 5 && dur <= 10)) return "Thời lượng phải 5–10 giây.";
      params.duration_seconds = dur;
    }
    return params;
  }

  async function submit() {
    if (sending) return;
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
      setError("Lỗi gửi: " + err);
      return;
    }
    setPrompt("");
  }

  const charCount = prompt.length;
  const charState =
    charCount > MAX_PROMPT_LEN ? "over" : charCount > 3600 ? "warn" : "";

  const modeTabs: { value: ActionMode; label: string; icon: JSX.Element }[] = [
    { value: "chat", label: "Chat", icon: <MessageIcon size={14} /> },
    { value: "image", label: "Ảnh", icon: <ImageIcon size={14} /> },
    { value: "video", label: "Video", icon: <VideoIcon size={14} /> },
  ];

  return (
    <div className="composer-block">
      {mediaModes && (
        <div className="composer-top">
          <div className="mode-tabs" role="tablist" aria-label="Chế độ gửi">
            {modeTabs.map((t) => (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={mode === t.value}
                className={`mode-tab${mode === t.value ? " on" : ""}`}
                onClick={() => switchMode(t.value)}
              >
                {t.icon}
                <span>{t.label}</span>
              </button>
            ))}
          </div>
          {thread.trim() && (
            <span className="composer-thread-pill" title="Thread đang gắn">
              #{thread.trim()}
            </span>
          )}
        </div>
      )}

      <div className="composer-shell">
        <textarea
          rows={2}
          value={prompt}
          placeholder={props.placeholder}
          aria-label={props.placeholder}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />

        {mediaModes && optsOpen && (
          <div className="composer-drawer">
            <div className="composer-opts">
              {mode === "chat" ? (
                <>
                  <label>
                    Loại tài nguyên
                    <select value={resType} onChange={(e) => setResType(e.target.value)}>
                      {["auto", "none", "image", "video", "document", "archive"].map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Định dạng đầu ra
                    <select value={outFmt} onChange={(e) => setOutFmt(e.target.value)}>
                      {["auto", "md", "txt", "csv", "docx", "xlsx", "zip"].map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Thread (tuỳ chọn)
                    <input
                      value={thread}
                      placeholder="vd: bao-cao-tuan"
                      onChange={(e) => setThread(e.target.value)}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label>
                    Tỉ lệ
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
                      Số ảnh (1–4)
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
                      Thời lượng (5–10s)
                      <input
                        type="number"
                        min={5}
                        max={10}
                        value={dur}
                        onChange={(e) => setDur(parseInt(e.target.value || "8", 10))}
                      />
                    </label>
                  )}
                  <label>
                    Thread (tuỳ chọn)
                    <input
                      value={thread}
                      placeholder="vd: cat-climbing-01"
                      onChange={(e) => setThread(e.target.value)}
                    />
                  </label>
                </>
              )}
            </div>
          </div>
        )}

        <div className="composer-bar">
          <div className="composer-bar-left">
            {mediaModes && (
              <button
                type="button"
                className={`composer-opt-btn${optsOpen ? " on" : ""}`}
                aria-expanded={optsOpen}
                onClick={() => setOptsOpen((v) => !v)}
              >
                <SlidersIcon size={14} />
                <span>Tuỳ chọn</span>
                <ChevronDownIcon
                  size={13}
                  className={`opt-chevron${optsOpen ? " open" : ""}`}
                />
              </button>
            )}
            <span className="composer-kbd-hint">Enter để gửi · Shift+Enter xuống dòng</span>
          </div>

          <div className="composer-bar-right">
            <span className={`char-counter${charState ? ` ${charState}` : ""}`}>
              {charCount} / {MAX_PROMPT_LEN}
            </span>
            <button
              id="composer-send"
              type="button"
              className={`btn btn-send${sending ? " is-loading" : ""}`}
              disabled={sending}
              onClick={submit}
            >
              <SendIcon size={14} />
              <span>{sending ? "Đang gửi…" : "Gửi"}</span>
            </button>
          </div>
        </div>
      </div>

      <ErrorMsg text={error} />
    </div>
  );
}
