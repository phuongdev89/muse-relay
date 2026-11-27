import { useMemo, useState } from "react";
import { createProject, syncProjectAgents, updateProject } from "../lib/api";
import { useLang } from "../lib/i18n";
import type { AgentKind, Muse, OpenAIAgent, Project, ProjectAgent } from "../types";
import { ErrorMsg, Modal, toast } from "./ui";

interface SelectedAgent {
  agent_kind: AgentKind;
  agent_ref: string;
  agent_name: string;
}

export function ProjectWizard(props: {
  project: Project | null;
  existingAgents: ProjectAgent[];
  muses: Muse[];
  openaiAgents: OpenAIAgent[];
  onClose: () => void;
  onSaved: (projectId: string, isNew: boolean) => void;
}) {
  const { t } = useLang();
  const isEdit = Boolean(props.project);
  const [name, setName] = useState(props.project?.name ?? "");
  const [description, setDescription] = useState(props.project?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [picked, setPicked] = useState<Map<string, SelectedAgent>>(() => {
    const map = new Map<string, SelectedAgent>();
    const museMap = new Map(props.muses.map((m) => [m.recipient, m.name]));
    const oaiMap = new Map(props.openaiAgents.map((a) => [a.id, a.name]));

    for (const pa of props.existingAgents) {
      const liveName =
        pa.agent_kind === "muse"
          ? museMap.get(pa.agent_ref) ?? pa.agent_name
          : oaiMap.get(pa.agent_ref) ?? pa.agent_name;
      map.set(`${pa.agent_kind}:${pa.agent_ref}`, {
        agent_kind: pa.agent_kind,
        agent_ref: pa.agent_ref,
        agent_name: liveName,
      });
    }
    return map;
  });

  const allOptions = useMemo(() => {
    const list: (SelectedAgent & { sub: string })[] = [];
    for (const m of props.muses) {
      list.push({
        agent_kind: "muse",
        agent_ref: m.recipient,
        agent_name: m.name,
        sub: m.dropbox_root || "Muse Relay",
      });
    }
    for (const a of props.openaiAgents) {
      list.push({
        agent_kind: "openai",
        agent_ref: a.id,
        agent_name: a.name,
        sub: a.model,
      });
    }
    return list;
  }, [props.muses, props.openaiAgents]);

  function toggle(item: SelectedAgent) {
    const key = `${item.agent_kind}:${item.agent_ref}`;
    setPicked((cur) => {
      const next = new Map(cur);
      if (next.has(key)) next.delete(key);
      else next.set(key, item);
      return next;
    });
  }

  async function submit() {
    if (saving) return;
    setError("");
    const trimmedName = name.trim();
    const trimmedDesc = description.trim();
    if (trimmedName.length < 1 || trimmedName.length > 64) {
      setError(t("pwiz.nameErr"));
      return;
    }

    setSaving(true);
    let projectId = props.project?.id;
    if (props.project) {
      const err = await updateProject(props.project.id, {
        name: trimmedName,
        description: trimmedDesc,
      });
      if (err) {
        setSaving(false);
        setError(t("pwiz.updateErr", { err }));
        return;
      }
    } else {
      const { data, error: err } = await createProject({
        name: trimmedName,
        description: trimmedDesc,
      });
      if (err || !data) {
        setSaving(false);
        setError(t("pwiz.createErr", { err: err ?? t("common.unknown") }));
        return;
      }
      projectId = data.id;
    }

    if (!projectId) {
      setSaving(false);
      setError(t("pwiz.noIdErr"));
      return;
    }

    const syncErr = await syncProjectAgents(projectId, [...picked.values()]);
    setSaving(false);
    if (syncErr) {
      setError(t("pwiz.syncErr", { err: syncErr }));
      return;
    }

    toast(isEdit ? t("pwiz.updatedToast") : t("pwiz.createdToast"));
    props.onSaved(projectId, !isEdit);
    props.onClose();
  }

  return (
    <Modal open onClose={props.onClose} labelledBy="pwiz-title">
      <h2 id="pwiz-title">
        {isEdit ? t("pwiz.editTitle", { name: props.project?.name ?? "" }) : t("pwiz.createTitle")}
      </h2>
      <p className="lead">{t("pwiz.lead")}</p>

      <label htmlFor="proj-name">{t("pwiz.nameLabel")}</label>
      <input
        id="proj-name"
        value={name}
        maxLength={64}
        placeholder={t("pwiz.namePlaceholder")}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
      />

      <label htmlFor="proj-desc">{t("pwiz.descLabel")}</label>
      <textarea
        id="proj-desc"
        rows={2}
        value={description}
        placeholder={t("pwiz.descPlaceholder")}
        onChange={(e) => setDescription(e.target.value)}
      />

      <label>{t("pwiz.agentsLabel", { count: picked.size })}</label>
      <div className="check-list">
        {allOptions.map((item) => {
          const key = `${item.agent_kind}:${item.agent_ref}`;
          return (
            <label key={key} className="check-item check-item-split">
              <span className="check-item-left">
                <input
                  type="checkbox"
                  checked={picked.has(key)}
                  onChange={() => toggle(item)}
                />
                <span className="check-item-name">{item.agent_name}</span>
              </span>
              <span className="check-item-right">
                <span className={`agent-kind-tag ${item.agent_kind}`}>
                  {item.agent_kind === "muse" ? "Muse" : "OpenAI"}
                </span>
                <span className="check-item-sub">{item.sub}</span>
              </span>
            </label>
          );
        })}
        {allOptions.length === 0 && (
          <span className="hint">
            {t("pwiz.noAgentsPrefix")} <strong>{t("sidebar.agents")}</strong> {t("pwiz.noAgentsSuffix")}
          </span>
        )}
      </div>

      <ErrorMsg text={error} />
      <div className="actions">
        <button
          type="button"
          className={`btn${saving ? " is-loading" : ""}`}
          disabled={saving}
          onClick={submit}
        >
          {saving ? t("common.saving") : isEdit ? t("common.saveChanges") : t("pwiz.createBtn")}
        </button>
        <button type="button" className="btn-ghost" onClick={props.onClose}>
          {t("common.cancel")}
        </button>
      </div>
    </Modal>
  );
}
