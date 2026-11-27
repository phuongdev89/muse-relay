import { useMemo, useState } from "react";
import { testOpenAIAgentConnection } from "../lib/api";
import {
  fmtRelativeAge,
  fmtTime,
  initialsOf,
  museConnectionInfo,
  type MuseFleetSummary,
} from "../lib/format";
import type { Muse, OpenAIAgent, ProjectAgent } from "../types";
import {
  BotIcon,
  CheckIcon,
  CopyIcon,
  EditIcon,
  FolderIcon,
  KeyIcon,
  MessageIcon,
  PanelRightIcon,
  PlugIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  StarIcon,
  TrashIcon,
  XIcon,
} from "./Icons";
import { DeleteDialog, RenameDialog, RotateDialog } from "./MuseManage";
import { DeleteOpenAIDialog, OpenAIAgentModal } from "./OpenAIAgentModal";
import { Chip, copyText } from "./ui";

type AgentFilter = "all" | "muse" | "openai";

interface ConnectionTestState {
  testing: boolean;
  ok?: boolean;
  latencyMs?: number;
  reply?: string;
  error?: string;
}

const FLEET_STATUS_LABEL: Record<string, string> = {
  processing: "đang xử lý",
  pending: "chờ nhận",
  error: "cần kiểm tra",
  idle: "sẵn sàng",
};

const FLEET_STATUS_CHIP: Record<string, string> = {
  processing: "processing",
  pending: "pending",
  error: "failed",
  idle: "idle",
};

function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "••••••••";
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
}

export function AgentsAdminView(props: {
  muses: Muse[];
  openaiAgents: OpenAIAgent[];
  projectAgents: ProjectAgent[];
  fleetSummary: Map<string, MuseFleetSummary>;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onRefresh: () => void;
  onAddMuse: () => void;
  onOpenMuseRoom: (recipient: string) => void;
  onMuseRenamed: (recipient: string, name: string) => void;
  onMuseRotated?: () => void;
  onMuseDeleted: (recipient: string) => void;
  onOpenAIChanged: () => void;
}) {
  const { muses, openaiAgents, projectAgents, fleetSummary } = props;
  const [filter, setFilter] = useState<AgentFilter>("all");
  const [query, setQuery] = useState("");

  // Muse dialogs
  const [museAction, setMuseAction] = useState<{
    muse: Muse;
    kind: "rename" | "rotate" | "delete";
  } | null>(null);

  // OpenAI dialogs
  const [oaiModal, setOaiModal] = useState<{ open: boolean; agent: OpenAIAgent | null }>({
    open: false,
    agent: null,
  });
  const [oaiDelete, setOaiDelete] = useState<OpenAIAgent | null>(null);

  // Per-agent connection test state
  const [testResults, setTestResults] = useState<Record<string, ConnectionTestState>>({});

  // Count how many projects each agent is assigned to
  const projectCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const pa of projectAgents) {
      const k = `${pa.agent_kind}:${pa.agent_ref}`;
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return map;
  }, [projectAgents]);

  const q = query.trim().toLowerCase();

  const filteredMuses = useMemo(() => {
    if (filter === "openai") return [];
    if (!q) return muses;
    return muses.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.recipient.toLowerCase().includes(q) ||
        m.dropbox_root.toLowerCase().includes(q) ||
        (m.email_owner ?? "").toLowerCase().includes(q),
    );
  }, [muses, filter, q]);

  const filteredOpenAI = useMemo(() => {
    if (filter === "muse") return [];
    if (!q) return openaiAgents;
    return openaiAgents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.model.toLowerCase().includes(q) ||
        a.base_url.toLowerCase().includes(q) ||
        a.system_prompt.toLowerCase().includes(q),
    );
  }, [openaiAgents, filter, q]);

  async function runConnectionTest(agent: OpenAIAgent) {
    setTestResults((cur) => ({ ...cur, [agent.id]: { testing: true } }));
    const res = await testOpenAIAgentConnection(agent);
    setTestResults((cur) => ({
      ...cur,
      [agent.id]: {
        testing: false,
        ok: res.ok,
        latencyMs: res.latencyMs,
        reply: res.reply,
        error: res.error,
      },
    }));
  }

  const totalCount = muses.length + openaiAgents.length;
  const visibleCount = filteredMuses.length + filteredOpenAI.length;

  return (
    <section className="admin-pane fade" aria-label="Quản trị Agent">
      <div className="pane-head">
        <div className="pane-title-group">
          <h2>Quản trị Agent</h2>
          <span className="sub">
            {muses.length} Muse Relay · {openaiAgents.length} OpenAI Compatible
          </span>
        </div>
        <span className="grow" />
        <div className="pane-actions">
          <button type="button" className="btn-ghost" onClick={props.onAddMuse}>
            <PlusIcon size={14} />
            <span>Thêm Muse</span>
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setOaiModal({ open: true, agent: null })}
          >
            <PlusIcon size={14} />
            <span>Thêm OpenAI Agent</span>
          </button>
          <button type="button" className="btn-ghost" onClick={props.onRefresh} title="Làm mới">
            <RefreshIcon size={14} />
            <span className="hide-xs">Làm mới</span>
          </button>
          <button
            type="button"
            className={`btn-ghost btn-inspector-toggle${props.inspectorOpen ? " active" : ""}`}
            onClick={props.onToggleInspector}
            aria-pressed={props.inspectorOpen}
            title="Đóng/mở bảng thông tin"
          >
            <PanelRightIcon size={15} />
            <span className="hide-xs">Chi tiết</span>
          </button>
        </div>
      </div>

      <div className="admin-toolbar">
        <div className="filter-pills" role="tablist" aria-label="Lọc loại Agent">
          <button
            type="button"
            role="tab"
            aria-selected={filter === "all"}
            className={`filter-pill${filter === "all" ? " on" : ""}`}
            onClick={() => setFilter("all")}
          >
            Tất cả ({totalCount})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === "muse"}
            className={`filter-pill${filter === "muse" ? " on" : ""}`}
            onClick={() => setFilter("muse")}
          >
            Muse Relay ({muses.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === "openai"}
            className={`filter-pill${filter === "openai" ? " on" : ""}`}
            onClick={() => setFilter("openai")}
          >
            OpenAI Compatible ({openaiAgents.length})
          </button>
        </div>

        <div className="admin-search">
          <SearchIcon size={14} className="admin-search-icon" />
          <input
            type="search"
            value={query}
            placeholder="Tìm theo tên, model, URL, UUID…"
            aria-label="Tìm kiếm Agent"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className="rail-search-clear"
              onClick={() => setQuery("")}
              aria-label="Xoá từ khoá tìm kiếm"
            >
              <XIcon size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="overview-scroll">
        {visibleCount === 0 ? (
          <div className="ov-empty-card">
            <p>
              {totalCount === 0
                ? "Chưa có Agent nào. Hãy thêm Muse Relay hoặc OpenAI Compatible Agent để dùng trong các Project."
                : "Không có Agent nào khớp bộ lọc hoặc từ khoá hiện tại."}
            </p>
            {totalCount === 0 && (
              <div className="empty-cta-row">
                <button type="button" className="btn-ghost" onClick={props.onAddMuse}>
                  <PlusIcon size={14} />
                  <span>Thêm Muse Relay</span>
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setOaiModal({ open: true, agent: null })}
                >
                  <PlusIcon size={14} />
                  <span>Thêm OpenAI Agent</span>
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            {filteredMuses.length > 0 && (
              <section className="ov-section" aria-label="Danh sách Muse Relay">
                <div className="ov-section-head">
                  <div className="ov-section-title">
                    <StarIcon size={15} style={{ color: "var(--color-accent)" }} />
                    <h3>Muse Relay ({filteredMuses.length})</h3>
                  </div>
                </div>

                <div className="agent-admin-grid">
                  {filteredMuses.map((m) => {
                    const summary = fleetSummary.get(m.recipient);
                    const status = summary?.status ?? "idle";
                    const pCount = projectCounts.get(`muse:${m.recipient}`) ?? 0;
                    const conn = museConnectionInfo(m);

                    const setupText = conn.setupDone ? "Đã setup" : "Chưa setup";
                    const connectText = conn.connected
                      ? m.first_connected_at
                        ? `Đã kết nối · ${fmtTime(m.first_connected_at)}`
                        : "Đã kết nối"
                      : conn.state === "reconnecting"
                        ? "Chờ kết nối lại"
                        : conn.state === "offline" && (m.first_connected_at || m.last_claim_at)
                          ? "Mất kết nối"
                          : "Chưa kết nối";
                    const liveText =
                      conn.state === "live"
                        ? `Đang live · ${fmtRelativeAge(m.last_claim_at)}`
                        : conn.state === "standby"
                          ? `Chờ nhịp · ${fmtRelativeAge(m.last_claim_at)}`
                          : conn.state === "reconnecting"
                            ? "Đợi claim token mới"
                            : conn.state === "offline"
                              ? `Offline · ${m.last_claim_at ? fmtRelativeAge(m.last_claim_at) : "quá hạn"}`
                              : "Chưa có nhịp poll";

                    const setupTone = conn.setupDone ? "ok" : "pending";
                    const connectTone = conn.connected
                      ? "ok"
                      : conn.state === "reconnecting"
                        ? "pending"
                        : "bad";
                    const liveTone =
                      conn.state === "live"
                        ? "ok"
                        : conn.state === "standby"
                          ? "busy"
                          : conn.state === "offline"
                            ? "bad"
                            : "pending";

                    return (
                      <article key={m.recipient} className="agent-card">
                        <div className="agent-card-head">
                          <div className="fleet-identity">
                            <span className={`avatar-monogram status-${status}`}>
                              {initialsOf(m.name)}
                            </span>
                            <div className="fleet-name-wrap">
                              <strong className="fleet-name">{m.name}</strong>
                              <span className="agent-kind-tag muse">Muse Relay</span>
                            </div>
                          </div>
                          <Chip
                            state={FLEET_STATUS_CHIP[status]}
                            label={FLEET_STATUS_LABEL[status]}
                          />
                        </div>

                        <div className="muse-telemetry-grid" role="group" aria-label={`Telemetry ${m.name}`}>
                          <div className={`muse-telemetry-cell tone-${setupTone}`}>
                            <span className="muse-telemetry-k">Setup</span>
                            <strong className="muse-telemetry-v">{setupText}</strong>
                          </div>
                          <div className={`muse-telemetry-cell tone-${connectTone}`}>
                            <span className="muse-telemetry-k">Kết nối</span>
                            <strong className="muse-telemetry-v">{connectText}</strong>
                          </div>
                          <div className={`muse-telemetry-cell tone-${liveTone}`}>
                            <span className="muse-telemetry-k">Live</span>
                            <strong className="muse-telemetry-v">{liveText}</strong>
                          </div>
                        </div>

                        <div className="agent-meta-rows">
                          <div className="agent-meta-row">
                            <FolderIcon size={12} />
                            <code title={m.dropbox_root || "/"}>{m.dropbox_root || "/"}</code>
                          </div>
                          {m.email_owner && (
                            <div className="agent-meta-row">
                              <span className="agent-meta-k">Email</span>
                              <span className="agent-meta-val" title={m.email_owner}>
                                {m.email_owner}
                              </span>
                            </div>
                          )}
                          <div className="agent-meta-row">
                            <span className="agent-meta-k">UUID</span>
                            <code title={m.recipient}>{m.recipient}</code>
                            <button
                              type="button"
                              className="btn-quiet btn-icon-copy"
                              aria-label={`Copy UUID của ${m.name}`}
                              title="Copy UUID"
                              onClick={() => copyText(m.recipient, "Đã copy recipient UUID")}
                            >
                              <CopyIcon size={12} />
                            </button>
                          </div>
                          {m.last_result_at && (
                            <div className="agent-meta-row">
                              <span className="agent-meta-k">Kết quả</span>
                              <span className="agent-meta-val">
                                {fmtRelativeAge(m.last_result_at)} ({fmtTime(m.last_result_at)})
                              </span>
                            </div>
                          )}
                          <div className="agent-meta-sub">
                            <span>Tạo {fmtTime(m.created_at)}</span>
                            <span>·</span>
                            <span>{pCount} Project</span>
                          </div>
                        </div>

                        <div className="agent-card-actions">
                          <button
                            type="button"
                            className="btn-ghost btn-sm"
                            onClick={() => props.onOpenMuseRoom(m.recipient)}
                          >
                            <MessageIcon size={13} />
                            <span>Phòng 1:1</span>
                          </button>
                          <button
                            type="button"
                            className="btn-ghost btn-sm"
                            onClick={() => setMuseAction({ muse: m, kind: "rename" })}
                          >
                            <EditIcon size={13} />
                            <span>Đổi tên</span>
                          </button>
                          <button
                            type="button"
                            className="btn-ghost btn-sm"
                            onClick={() => setMuseAction({ muse: m, kind: "rotate" })}
                          >
                            <KeyIcon size={13} />
                            <span>Rotate</span>
                          </button>
                          <button
                            type="button"
                            className="btn-ghost btn-sm danger-text"
                            onClick={() => setMuseAction({ muse: m, kind: "delete" })}
                          >
                            <TrashIcon size={13} />
                            <span>Xoá</span>
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}

            {filteredOpenAI.length > 0 && (
              <section className="ov-section" aria-label="Danh sách OpenAI Compatible">
                <div className="ov-section-head">
                  <div className="ov-section-title">
                    <BotIcon size={16} style={{ color: "var(--color-busy)" }} />
                    <h3>OpenAI Compatible ({filteredOpenAI.length})</h3>
                  </div>
                </div>

                <div className="agent-admin-grid">
                  {filteredOpenAI.map((a) => {
                    const testState = testResults[a.id];
                    const pCount = projectCounts.get(`openai:${a.id}`) ?? 0;

                    return (
                      <article key={a.id} className="agent-card">
                        <div className="agent-card-head">
                          <div className="fleet-identity">
                            <span className="avatar-monogram openai">
                              <BotIcon size={16} />
                            </span>
                            <div className="fleet-name-wrap">
                              <strong className="fleet-name">{a.name}</strong>
                              <span className="agent-kind-tag openai">OpenAI Compatible</span>
                            </div>
                          </div>
                          <span className="model-pill" title={a.model}>
                            {a.model}
                          </span>
                        </div>

                        <div className="agent-meta-rows">
                          <div className="agent-meta-row">
                            <span className="agent-meta-k">URL</span>
                            <code title={a.base_url}>{a.base_url}</code>
                          </div>
                          <div className="agent-meta-row">
                            <span className="agent-meta-k">Key</span>
                            <code>{maskApiKey(a.api_key)}</code>
                          </div>
                          {a.system_prompt && (
                            <p className="agent-sys-snippet" title={a.system_prompt}>
                              Prompt: {a.system_prompt}
                            </p>
                          )}
                          <div className="agent-meta-sub">
                            <span>Tạo {fmtTime(a.created_at)}</span>
                            <span>·</span>
                            <span>{pCount} Project</span>
                          </div>
                        </div>

                        {testState && !testState.testing && (
                          <div
                            className={`conn-status ${testState.ok ? "ok" : "err"}`}
                            role="status"
                          >
                            {testState.ok ? (
                              <>
                                <CheckIcon size={13} />
                                <span>
                                  Kết nối OK ({testState.latencyMs}ms)
                                  {testState.reply ? ` · "${testState.reply.slice(0, 36)}"` : ""}
                                </span>
                              </>
                            ) : (
                              <span>Lỗi: {testState.error}</span>
                            )}
                          </div>
                        )}

                        <div className="agent-card-actions">
                          <button
                            type="button"
                            className={`btn-ghost btn-sm${testState?.testing ? " is-loading" : ""}`}
                            disabled={testState?.testing}
                            onClick={() => void runConnectionTest(a)}
                          >
                            <PlugIcon size={13} />
                            <span>
                              {testState?.testing ? "Đang kiểm tra…" : "Kiểm tra kết nối"}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="btn-ghost btn-sm"
                            onClick={() => setOaiModal({ open: true, agent: a })}
                          >
                            <EditIcon size={13} />
                            <span>Sửa</span>
                          </button>
                          <button
                            type="button"
                            className="btn-ghost btn-sm danger-text"
                            onClick={() => setOaiDelete(a)}
                          >
                            <TrashIcon size={13} />
                            <span>Xoá</span>
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      {museAction?.kind === "rename" && (
        <RenameDialog
          muse={museAction.muse}
          onClose={() => setMuseAction(null)}
          onRenamed={(recipient, name) => {
            props.onMuseRenamed(recipient, name);
            setMuseAction(null);
          }}
        />
      )}
      {museAction?.kind === "rotate" && (
        <RotateDialog
          muse={museAction.muse}
          onClose={() => setMuseAction(null)}
          onRotated={() => props.onMuseRotated?.()}
        />
      )}
      {museAction?.kind === "delete" && (
        <DeleteDialog
          muse={museAction.muse}
          onClose={() => setMuseAction(null)}
          onDeleted={(recipient) => {
            props.onMuseDeleted(recipient);
            setMuseAction(null);
          }}
        />
      )}

      {oaiModal.open && (
        <OpenAIAgentModal
          agent={oaiModal.agent}
          onClose={() => setOaiModal({ open: false, agent: null })}
          onSaved={() => props.onOpenAIChanged()}
        />
      )}

      {oaiDelete && (
        <DeleteOpenAIDialog
          agent={oaiDelete}
          onClose={() => setOaiDelete(null)}
          onDeleted={() => props.onOpenAIChanged()}
        />
      )}
    </section>
  );
}
