import { useState } from "react";
import { buildChatCompletionsUrl, createOpenAIAgent, deleteOpenAIAgent, updateOpenAIAgent } from "../../lib/api";
import { useLang } from "../../lib/i18n";
import type { OpenAIAgent } from "../../types";
import { EyeIcon, EyeOffIcon } from "../common/Icons";
import { ErrorMsg, Modal, toast } from "../common/ui";

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
  const { t } = useLang();
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
      setError(t("oai.nameErr"));
      return;
    }
    if (!trimmedUrl || trimmedUrl.length > 512 || !isValidHttpUrl(trimmedUrl)) {
      setError(t("oai.urlErr"));
      return;
    }
    if (trimmedModel.length < 1 || trimmedModel.length > 128) {
      setError(t("oai.modelErr"));
      return;
    }
    if (trimmedKey.length < 1 || trimmedKey.length > 512) {
      setError(t("oai.keyErr"));
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
        setError(t("oai.updateErr", { err }));
        return;
      }
      toast(t("oai.updatedToast"));
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
      setError(t("oai.createErr", { err: err ?? t("common.unknown") }));
      return;
    }
    toast(t("oai.createdToast"));
    props.onSaved(data);
    props.onClose();
  }

  return (
    <Modal open onClose={props.onClose} labelledBy="oai-modal-title">
      <h2 id="oai-modal-title">
        {isEdit ? t("oai.editTitle", { name: props.agent?.name ?? "" }) : t("oai.createTitle")}
      </h2>
      <p className="lead">{t("oai.lead")}</p>

      <label htmlFor="oai-name">{t("oai.nameLabel")}</label>
      <input
        id="oai-name"
        value={name}
        maxLength={64}
        placeholder={t("oai.namePlaceholder")}
        onChange={(e) => setName(e.target.value)}
      />

      <label htmlFor="oai-url">{t("oai.urlLabel")}</label>
      <input
        id="oai-url"
        value={baseUrl}
        maxLength={512}
        placeholder="https://api.openai.com/v1"
        onChange={(e) => setBaseUrl(e.target.value)}
      />
      <p className="hint" style={{ marginTop: "var(--space-3xs)" }}>
        {t("oai.urlHint")}{" "}
        <code>{baseUrl.trim() ? buildChatCompletionsUrl(baseUrl) : "…/chat/completions"}</code>.
      </p>

      <label htmlFor="oai-model">{t("oai.modelLabel")}</label>
      <input
        id="oai-model"
        value={model}
        maxLength={128}
        placeholder={t("oai.modelPlaceholder")}
        onChange={(e) => setModel(e.target.value)}
      />

      <label htmlFor="oai-key">{t("oai.keyLabel")}</label>
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
          aria-label={showKey ? t("oai.hideKey") : t("oai.showKey")}
          title={showKey ? t("oai.hideKey") : t("oai.showKey")}
        >
          {showKey ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}
        </button>
      </div>

      <label htmlFor="oai-sys">{t("oai.sysLabel")}</label>
      <textarea
        id="oai-sys"
        rows={3}
        value={systemPrompt}
        placeholder={t("oai.sysPlaceholder")}
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
          {saving ? t("common.saving") : isEdit ? t("common.saveChanges") : t("oai.addBtn")}
        </button>
        <button type="button" className="btn-ghost" onClick={props.onClose}>
          {t("common.cancel")}
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
  const { t } = useLang();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  async function remove() {
    if (deleting) return;
    setDeleting(true);
    setError("");
    const err = await deleteOpenAIAgent(props.agent.id);
    setDeleting(false);
    if (err) {
      setError(t("oai.delErr", { err }));
      return;
    }
    toast(t("oai.delOk"));
    props.onDeleted(props.agent.id);
    props.onClose();
  }

  return (
    <Modal open onClose={props.onClose} labelledBy="del-oai-title">
      <h2 id="del-oai-title">{t("oai.delTitle", { name: props.agent.name })}</h2>
      <p className="lead">{t("oai.delLead")}</p>
      <ErrorMsg text={error} />
      <div className="actions">
        <button
          type="button"
          className={`btn btn-danger${deleting ? " is-loading" : ""}`}
          disabled={deleting}
          onClick={remove}
        >
          {deleting ? t("common.deleting") : t("oai.delBtn")}
        </button>
        <button type="button" className="btn-ghost" onClick={props.onClose}>
          {t("common.keep")}
        </button>
      </div>
    </Modal>
  );
}
