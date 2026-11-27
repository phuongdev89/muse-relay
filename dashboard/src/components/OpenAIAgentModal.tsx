import { useState } from "react";
import { buildChatCompletionsUrl, createOpenAIAgent, deleteOpenAIAgent, updateOpenAIAgent } from "../lib/api";
import type { OpenAIAgent } from "../types";
import { EyeIcon, EyeOffIcon } from "./Icons";
import { ErrorMsg, Modal, toast } from "./ui";

function isValidHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function OpenAIAgentModal(props: {
  agent: OpenAIAgent | null;
  onClose: () => void;
  onSaved: (saved?: OpenAIAgent) => void;
}) {
  const isEdit = Boolean(props.agent);
  const [name, setName] = useState(props.agent?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(props.agent?.base_url ?? "https://api.openai.com/v1");
  const [model, setModel] = useState(props.agent?.model ?? "");
  const [apiKey, setApiKey] = useState(props.agent?.api_key ?? "");
  const [systemPrompt, setSystemPrompt] = useState(props.agent?.system_prompt ?? "");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (saving) return;
    setError("");
    const trimmedName = name.trim();
    const trimmedUrl = baseUrl.trim().replace(/\/+$/, "");
    const trimmedModel = model.trim();
    const trimmedKey = apiKey.trim();
    const trimmedPrompt = systemPrompt.trim();

    if (trimmedName.length < 1 || trimmedName.length > 64) {
      setError("Tên Agent phải từ 1–64 ký tự.");
      return;
    }
    if (!trimmedUrl || trimmedUrl.length > 512 || !isValidHttpUrl(trimmedUrl)) {
      setError("Base URL chưa hợp lệ (phải bắt đầu bằng http:// hoặc https://, tối đa 512 ký tự).");
      return;
    }
    if (trimmedModel.length < 1 || trimmedModel.length > 128) {
      setError("Model ID phải từ 1–128 ký tự.");
      return;
    }
    if (trimmedKey.length < 1 || trimmedKey.length > 512) {
      setError("API Key phải từ 1–512 ký tự.");
      return;
    }

    setSaving(true);
    if (props.agent) {
      const err = await updateOpenAIAgent(props.agent.id, {
        name: trimmedName,
        base_url: trimmedUrl,
        model: trimmedModel,
        api_key: trimmedKey,
        system_prompt: trimmedPrompt,
      });
      setSaving(false);
      if (err) {
        setError("Lỗi cập nhật: " + err);
        return;
      }
      toast("Đã cập nhật OpenAI Agent");
      props.onSaved();
      props.onClose();
      return;
    }

    const { data, error: err } = await createOpenAIAgent({
      name: trimmedName,
      base_url: trimmedUrl,
      model: trimmedModel,
      api_key: trimmedKey,
      system_prompt: trimmedPrompt,
    });
    setSaving(false);
    if (err || !data) {
      setError("Lỗi tạo Agent: " + (err ?? "không rõ"));
      return;
    }
    toast("Đã thêm OpenAI Agent");
    props.onSaved(data);
    props.onClose();
  }

  return (
    <Modal open onClose={props.onClose} labelledBy="oai-modal-title">
      <h2 id="oai-modal-title">
        {isEdit ? `Sửa OpenAI Agent — ${props.agent?.name}` : "Thêm OpenAI Compatible Agent"}
      </h2>
      <p className="lead">
        Kết nối trực tiếp với bất kỳ endpoint tương thích chuẩn OpenAI{" "}
        <code>/chat/completions</code> (OpenAI, OpenRouter, Groq, DeepSeek, Ollama, vLLM…).
      </p>

      <label htmlFor="oai-name">Tên Agent</label>
      <input
        id="oai-name"
        value={name}
        maxLength={64}
        placeholder="vd: GPT-4o Reviewer"
        onChange={(e) => setName(e.target.value)}
      />

      <label htmlFor="oai-url">Base URL</label>
      <input
        id="oai-url"
        value={baseUrl}
        maxLength={512}
        placeholder="https://api.openai.com/v1"
        onChange={(e) => setBaseUrl(e.target.value)}
      />
      <p className="hint" style={{ marginTop: "var(--space-3xs)" }}>
        Dashboard sẽ gọi{" "}
        <code>{baseUrl.trim() ? buildChatCompletionsUrl(baseUrl) : "…/chat/completions"}</code>.
      </p>

      <label htmlFor="oai-model">Model ID</label>
      <input
        id="oai-model"
        value={model}
        maxLength={128}
        placeholder="vd: gpt-4o-mini, deepseek-chat, claude-3-5-sonnet"
        onChange={(e) => setModel(e.target.value)}
      />

      <label htmlFor="oai-key">API Key</label>
      <div className="input-secret-wrap">
        <input
          id="oai-key"
          type={showKey ? "text" : "password"}
          value={apiKey}
          maxLength={512}
          placeholder="sk-..."
          autoComplete="off"
          onChange={(e) => setApiKey(e.target.value)}
        />
        <button
          type="button"
          className="btn-quiet input-secret-toggle"
          onClick={() => setShowKey((v) => !v)}
          aria-label={showKey ? "Ẩn API Key" : "Hiện API Key"}
          title={showKey ? "Ẩn API Key" : "Hiện API Key"}
        >
          {showKey ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}
        </button>
      </div>

      <label htmlFor="oai-sys">System prompt (tuỳ chọn)</label>
      <textarea
        id="oai-sys"
        rows={3}
        value={systemPrompt}
        placeholder="vd: Bạn là chuyên gia biên tập ngắn gọn, trả lời bằng tiếng Việt…"
        onChange={(e) => setSystemPrompt(e.target.value)}
      />

      <ErrorMsg text={error} />
      <div className="actions">
        <button
          type="button"
          className={`btn${saving ? " is-loading" : ""}`}
          disabled={saving}
          onClick={submit}
        >
          {saving ? "Đang lưu…" : isEdit ? "Lưu thay đổi" : "Thêm Agent"}
        </button>
        <button type="button" className="btn-ghost" onClick={props.onClose}>
          Huỷ
        </button>
      </div>
    </Modal>
  );
}

export function DeleteOpenAIDialog(props: {
  agent: OpenAIAgent;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  async function remove() {
    if (deleting) return;
    setDeleting(true);
    setError("");
    const err = await deleteOpenAIAgent(props.agent.id);
    setDeleting(false);
    if (err) {
      setError("Lỗi xoá: " + err);
      return;
    }
    toast("Đã xoá OpenAI Agent");
    props.onDeleted(props.agent.id);
    props.onClose();
  }

  return (
    <Modal open onClose={props.onClose} labelledBy="del-oai-title">
      <h2 id="del-oai-title">Xoá OpenAI Agent — {props.agent.name}</h2>
      <p className="lead">
        Agent này sẽ bị xoá khỏi danh sách quản trị và tự động gỡ khỏi mọi Project đang sử dụng nó.
        Lịch sử tin nhắn cũ trong các cuộc hội thoại vẫn được giữ lại.
      </p>
      <ErrorMsg text={error} />
      <div className="actions">
        <button
          type="button"
          className={`btn btn-danger${deleting ? " is-loading" : ""}`}
          disabled={deleting}
          onClick={remove}
        >
          {deleting ? "Đang xoá…" : "Xoá Agent"}
        </button>
        <button type="button" className="btn-ghost" onClick={props.onClose}>
          Giữ lại
        </button>
      </div>
    </Modal>
  );
}
