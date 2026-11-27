import { useState } from "react";
import type { ActionMode, MessageParams } from "../types";
import { ErrorMsg, setButtonBusy } from "./ui";

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
  const [advOpen, setAdvOpen] = useState(false);
  const [error, setError] = useState("");

  const THREAD_RE = /^[A-Za-z0-9_-]{1,64}$/;

  function buildParams(): MessageParams | string {
    const p = prompt.trim();
    if (p.length < 1 || p.length > 4000) return "Nội dung phải từ 1–4000 ký tự.";
    const th = thread.trim();
    if (th && !THREAD_RE.test(th)) return "Thread chỉ gồm chữ/số/-/_ (1–64 ký tự).";
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
    setError("");
    const built = buildParams();
    if (typeof built === "string") {
      setError(built);
      return;
    }
    const btn = document.getElementById("composer-send") as HTMLButtonElement | null;
    const undo = setButtonBusy(btn, "Đang gửi…");
    const err = await props.onSend(mode, built);
    undo();
    if (err) {
      setError("Lỗi gửi: " + err);
      return;
    }
    setPrompt("");
  }

  return (
    <div className="composer-block">
      {mediaModes && (
        <div className="mode-tabs" role="tablist" aria-label="Chế độ gửi">
          {(
            [
              ["chat", "💬 Chat"],
              ["image", "🖼 Ảnh"],
              ["video", "🎬 Video"],
            ] as [ActionMode, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              className={`mode-tab${mode === value ? " on" : ""}`}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="composer">
        <textarea
          rows={2}
          value={prompt}
          placeholder={props.placeholder}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
          }}
        />
        <button id="composer-send" className="btn" onClick={submit}>Gửi</button>
      </div>

      {mediaModes && mode !== "chat" && (
        <div className="composer-opts">
          <label>
            Tỉ lệ
            <select value={ar} onChange={(e) => setAr(e.target.value)}>
              {(mode === "video" ? ["9:16", "16:9"] : ["9:16", "16:9", "1:1", "4:5", "3:4"]).map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </label>
          {mode === "image" ? (
            <label>
              Số ảnh (1–4)
              <input type="number" min={1} max={4} value={count}
                onChange={(e) => setCount(parseInt(e.target.value || "1", 10))} />
            </label>
          ) : (
            <label>
              Thời lượng (5–10s)
              <input type="number" min={5} max={10} value={dur}
                onChange={(e) => setDur(parseInt(e.target.value || "8", 10))} />
            </label>
          )}
          <label>
            Thread (tùy chọn)
            <input value={thread} placeholder="vd: cat-climbing-01"
              onChange={(e) => setThread(e.target.value)} />
          </label>
        </div>
      )}

      {mediaModes && mode === "chat" && (
        <div className="composer-adv">
          <button type="button" className="btn-quiet" onClick={() => setAdvOpen(!advOpen)}>
            {advOpen ? "▾" : "▸"} Tuỳ chọn nâng cao
          </button>
          {advOpen && (
            <div className="composer-opts">
              <label>
                Loại tài nguyên
                <select value={resType} onChange={(e) => setResType(e.target.value)}>
                  {["auto", "none", "image", "video", "document", "archive"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                Định dạng đầu ra
                <select value={outFmt} onChange={(e) => setOutFmt(e.target.value)}>
                  {["auto", "md", "txt", "csv", "docx", "xlsx", "zip"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                Thread (tùy chọn)
                <input value={thread} placeholder="vd: bao-cao-tuan"
                  onChange={(e) => setThread(e.target.value)} />
              </label>
            </div>
          )}
        </div>
      )}
      <ErrorMsg text={error} />
    </div>
  );
}
