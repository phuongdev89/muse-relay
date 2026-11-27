import { useEffect } from "react";
import { fileName, resourceLabel } from "../lib/dropbox";
import {
  fmtRelativeAge,
  fmtTime,
  initialsOf,
  memberDotColor,
  museConnectionInfo,
  type MuseFleetSummary,
} from "../lib/format";
import type {
  ActiveRoom,
  Conversation,
  ConversationMode,
  Group,
  GroupMember,
  Muse,
  OpenAIAgent,
  Project,
  ProjectAgent,
} from "../types";
import {
  BotIcon,
  CopyIcon,
  EditIcon,
  FolderIcon,
  KeyIcon,
  LayersIcon,
  MessageIcon,
  PlusIcon,
  ResourceKindIcon,
  SettingsIcon,
  TrashIcon,
  UsersIcon,
  XIcon,
} from "./Icons";
import { Chip, copyText } from "./ui";

const STATUS_LABEL: Record<string, string> = {
  processing: "đang xử lý",
  pending: "chờ nhận",
  error: "lỗi / hết hạn",
  idle: "sẵn sàng",
};

const STATUS_CHIP: Record<string, string> = {
  processing: "processing",
  pending: "pending",
  error: "failed",
  idle: "idle",
};

const MODE_LABEL: Record<ConversationMode, string> = {
  muse_single: "1:1 Muse (Thread riêng)",
  muse_group: "Nhóm Muse (Relay Group)",
  openai: "OpenAI Compatible",
  mixed: "Hỗn hợp Muse + OpenAI",
};

const MODE_DESC: Record<ConversationMode, string> = {
  muse_single:
    "Tin nhắn gửi kèm thread_id của cuộc hội thoại này. Hỗ trợ đầy đủ Chat, Ảnh và Video.",
  muse_group:
    "Owner là người khởi xướng duy nhất. Các Muse tự luân phiên phản hồi tối đa 12 lượt tự động rồi dừng chờ chỉ đạo tiếp theo.",
  openai:
    "Mỗi tin nhắn của Owner được gửi trực tiếp tới endpoint /chat/completions của các OpenAI Agent đã chọn và lưu vào Supabase.",
  mixed:
    "Mỗi tin nhắn của Owner được điều phối đồng thời tới cả Muse Relay và OpenAI Compatible Agent, hợp nhất theo thứ tự thời gian.",
};

export function InspectorPanel(props: {
  desktopOpen: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  active: ActiveRoom;
  muse: Muse | null;
  museSummary: MuseFleetSummary | null;
  group: Group | null;
  groupMembers: GroupMember[];
  musesCount: number;
  openaiCount: number;
  project: Project | null;
  projectAgents: ProjectAgent[];
  projectConversationsCount: number;
  conversation: Conversation | null;
  muses: Muse[];
  openaiAgents: OpenAIAgent[];
  threadPaths: string[];
  onMuseAction: (action: "rename" | "rotate" | "delete" | "clear") => void;
  onDeleteGroup?: () => void;
  onEditProject?: () => void;
  onNewConversation?: () => void;
}) {
  const {
    desktopOpen,
    mobileOpen,
    onCloseMobile,
    active,
    muse,
    museSummary,
    group,
    groupMembers,
    project,
    projectAgents,
    projectConversationsCount,
    conversation,
    muses,
    openaiAgents,
    threadPaths,
  } = props;

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseMobile();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileOpen, onCloseMobile]);

  const panelClass = `inspector${desktopOpen ? " desktop-open" : " desktop-closed"}${mobileOpen ? " mobile-open" : ""}`;

  const title =
    active?.kind === "agents"
      ? "Hướng dẫn Agent"
      : conversation
        ? "Chi tiết Hội thoại"
        : project && active?.kind === "project"
          ? "Chi tiết Project"
          : muse
            ? "Hồ sơ Muse"
            : group
              ? "Chi tiết Nhóm"
              : "Hướng dẫn Relay";

  return (
    <>
      {mobileOpen && (
        <div
          className="drawer-scrim inspector-scrim"
          aria-hidden="true"
          onClick={onCloseMobile}
        />
      )}
      <aside className={panelClass} aria-label="Bảng thông tin chi tiết">
        <div className="inspector-head">
          <span className="inspector-title">{title}</span>
          <button
            type="button"
            className="btn-quiet inspector-close"
            onClick={onCloseMobile}
            aria-label="Đóng bảng chi tiết"
          >
            <XIcon size={16} />
          </button>
        </div>

        <div className="inspector-body">
          {active?.kind === "agents" ? (
            <AgentsInspector musesCount={props.musesCount} openaiCount={props.openaiCount} />
          ) : conversation && project ? (
            <ConversationInspector
              project={project}
              conversation={conversation}
              muses={muses}
              openaiAgents={openaiAgents}
              paths={threadPaths}
            />
          ) : project && active?.kind === "project" ? (
            <ProjectInspector
              project={project}
              projectAgents={projectAgents}
              conversationsCount={projectConversationsCount}
              muses={muses}
              openaiAgents={openaiAgents}
              onEditProject={() => {
                onCloseMobile();
                props.onEditProject?.();
              }}
              onNewConversation={() => {
                onCloseMobile();
                props.onNewConversation?.();
              }}
            />
          ) : muse ? (
            <MuseInspector
              muse={muse}
              summary={museSummary}
              paths={threadPaths}
              onAction={props.onMuseAction}
            />
          ) : group ? (
            <GroupInspector
              group={group}
              members={groupMembers}
              paths={threadPaths}
              onDeleteGroup={() => {
                onCloseMobile();
                props.onDeleteGroup?.();
              }}
            />
          ) : (
            <OverviewInspector />
          )}
        </div>
      </aside>
    </>
  );
}

function AgentsInspector({
  musesCount,
  openaiCount,
}: {
  musesCount: number;
  openaiCount: number;
}) {
  return (
    <>
      <div className="insp-card insp-identity">
        <span className="avatar-monogram lg group">
          <BotIcon size={18} />
        </span>
        <div className="insp-identity-info">
          <strong className="insp-name">Kho Agent Hợp Nhất</strong>
          <span className="insp-sub">
            {musesCount} Muse Relay · {openaiCount} OpenAI Compatible
          </span>
        </div>
      </div>

      <div className="insp-section">
        <span className="insp-label">Muse Relay (Async Daemon)</span>
        <div className="insp-note-box">
          Mỗi Muse dùng <code>recipient</code> UUID và <code>RELAY_TOKEN</code> lưu trong Secure
          Vault. Phù hợp tác vụ dài hạn, tạo Ảnh / Video và xuất tệp lên Dropbox.
        </div>
      </div>

      <div className="insp-section">
        <span className="insp-label">OpenAI Compatible (Direct API)</span>
        <div className="insp-note-box">
          Gọi trực tiếp từ trình duyệt tới <code>{"{base_url}/chat/completions"}</code> bằng Bearer
          API key. Endpoint cần bật CORS cho domain dashboard nếu chạy trên trình duyệt.
        </div>
      </div>

      <div className="insp-section">
        <span className="insp-label">Lưu ý khi xoá Agent</span>
        <div className="insp-note-box">
          Khi xoá Muse hoặc OpenAI Agent, hệ thống tự động gỡ liên kết khỏi các{" "}
          <strong>Project</strong> đang tham chiếu để tránh thành viên treo.
        </div>
      </div>
    </>
  );
}

function ProjectInspector(props: {
  project: Project;
  projectAgents: ProjectAgent[];
  conversationsCount: number;
  muses: Muse[];
  openaiAgents: OpenAIAgent[];
  onEditProject: () => void;
  onNewConversation: () => void;
}) {
  const { project, projectAgents, conversationsCount, muses, openaiAgents } = props;
  const museMap = new Map(muses.map((m) => [m.recipient, m]));
  const oaiMap = new Map(openaiAgents.map((a) => [a.id, a]));

  return (
    <>
      <div className="insp-card insp-identity">
        <span className="avatar-monogram lg group">
          <LayersIcon size={18} />
        </span>
        <div className="insp-identity-info">
          <strong className="insp-name">{project.name}</strong>
          <span className="insp-sub">
            {projectAgents.length} Agent · {conversationsCount} hội thoại
          </span>
        </div>
      </div>

      {project.description && (
        <div className="insp-section">
          <span className="insp-label">Mô tả Project</span>
          <div className="insp-note-box">{project.description}</div>
        </div>
      )}

      <div className="insp-section">
        <span className="insp-label">Thông tin</span>
        <div className="insp-kv">
          <span className="insp-k">Project ID</span>
          <div className="insp-copy-row">
            <code className="insp-code">{project.id}</code>
            <button
              type="button"
              className="btn-quiet btn-icon-copy"
              title="Copy Project ID"
              aria-label="Copy Project ID"
              onClick={() => copyText(project.id, "Đã copy Project ID")}
            >
              <CopyIcon size={13} />
            </button>
          </div>
        </div>
        <div className="insp-kv">
          <span className="insp-k">Ngày tạo</span>
          <span className="insp-v">{fmtTime(project.created_at)}</span>
        </div>
      </div>

      <div className="insp-section">
        <span className="insp-label">Agent đã gán ({projectAgents.length})</span>
        {projectAgents.length === 0 ? (
          <p className="insp-empty">Chưa có Agent nào trong Project này.</p>
        ) : (
          <div className="insp-member-list">
            {projectAgents.map((pa, i) => {
              const liveName =
                pa.agent_kind === "muse"
                  ? museMap.get(pa.agent_ref)?.name ?? pa.agent_name
                  : oaiMap.get(pa.agent_ref)?.name ?? pa.agent_name;
              return (
                <div key={pa.id} className="insp-member-row">
                  <span className="insp-member-dot" style={{ background: memberDotColor(i) }} />
                  <div className="insp-member-meta">
                    <span className="insp-member-name">{liveName}</span>
                    <code className="insp-member-id">
                      {pa.agent_kind === "muse" ? "Muse Relay" : "OpenAI"} · {pa.agent_ref}
                    </code>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="insp-section">
        <span className="insp-label">Thao tác nhanh</span>
        <div className="insp-actions">
          <button type="button" className="btn-ghost insp-action-btn" onClick={props.onNewConversation}>
            <PlusIcon size={14} />
            <span>Cuộc hội thoại mới</span>
          </button>
          <button type="button" className="btn-ghost insp-action-btn" onClick={props.onEditProject}>
            <SettingsIcon size={14} />
            <span>Cài đặt Project</span>
          </button>
        </div>
      </div>
    </>
  );
}

function ConversationInspector(props: {
  project: Project;
  conversation: Conversation;
  muses: Muse[];
  openaiAgents: OpenAIAgent[];
  paths: string[];
}) {
  const { project, conversation, muses, openaiAgents, paths } = props;
  const museMap = new Map(muses.map((m) => [m.recipient, m]));
  const oaiMap = new Map(openaiAgents.map((a) => [a.id, a]));

  return (
    <>
      <div className="insp-card insp-identity">
        <span className="avatar-monogram lg group">
          <MessageIcon size={18} />
        </span>
        <div className="insp-identity-info">
          <strong className="insp-name">{conversation.title}</strong>
          <span className="insp-sub">
            {project.name} · {fmtTime(conversation.created_at)}
          </span>
        </div>
      </div>

      <div className="insp-section">
        <span className="insp-label">Chế độ vận hành</span>
        <div className="insp-note-box">
          <strong>{MODE_LABEL[conversation.mode]}</strong>
          <p>{MODE_DESC[conversation.mode]}</p>
        </div>
      </div>

      <div className="insp-section">
        <span className="insp-label">Thành viên tham gia ({conversation.participants.length})</span>
        <div className="insp-member-list">
          {conversation.participants.map((p, i) => {
            const liveMuse = p.kind === "muse" ? museMap.get(p.ref) : undefined;
            const liveOai = p.kind === "openai" ? oaiMap.get(p.ref) : undefined;
            const displayName = liveMuse?.name ?? liveOai?.name ?? p.name;
            const deleted = !liveMuse && !liveOai;
            return (
              <div key={`${p.kind}:${p.ref}`} className="insp-member-row">
                <span className="insp-member-dot" style={{ background: memberDotColor(i) }} />
                <div className="insp-member-meta">
                  <span className="insp-member-name">
                    {displayName}
                    {deleted && <span className="deleted-note"> (đã xoá)</span>}
                  </span>
                  <code className="insp-member-id">
                    {p.kind === "muse"
                      ? `Muse · ${liveMuse?.dropbox_root || p.ref}`
                      : `OpenAI · ${liveOai?.model || p.ref}`}
                  </code>
                </div>
                <button
                  type="button"
                  className="btn-quiet btn-icon-copy"
                  title="Copy ID"
                  aria-label={`Copy ID của ${displayName}`}
                  onClick={() => copyText(p.ref, `Đã copy ID của ${displayName}`)}
                >
                  <CopyIcon size={13} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {conversation.mode !== "openai" && (
        <div className="insp-section">
          <span className="insp-label">Tệp Dropbox trong luồng ({paths.length})</span>
          <InspectorFileList paths={paths} emptyText="Chưa có tệp nào trong cuộc hội thoại." />
        </div>
      )}
    </>
  );
}

function MuseInspector(props: {
  muse: Muse;
  summary: MuseFleetSummary | null;
  paths: string[];
  onAction: (action: "rename" | "rotate" | "delete" | "clear") => void;
}) {
  const { muse, summary, paths } = props;
  const status = summary?.status ?? "idle";
  const conn = museConnectionInfo(muse);

  return (
    <>
      <div className="insp-card insp-identity">
        <span className={`avatar-monogram lg status-${status}`}>
          {initialsOf(muse.name)}
        </span>
        <div className="insp-identity-info">
          <strong className="insp-name">{muse.name}</strong>
          <div className="insp-chip-row">
            <Chip state={conn.chipClass} label={conn.label} />
            <Chip state={STATUS_CHIP[status]} label={STATUS_LABEL[status]} />
          </div>
        </div>
      </div>

      <div className="insp-section">
        <span className="insp-label">Kết nối &amp; Telemetry</span>
        <div className="insp-telemetry-list">
          <div className="insp-kv">
            <span className="insp-k">Trạng thái Setup</span>
            <span className="insp-v">
              {conn.setupDone ? "Đã setup (setup_done = true)" : "Chưa setup (chưa từng claim)"}
            </span>
          </div>
          <div className="insp-kv">
            <span className="insp-k">Kết nối đầu tiên</span>
            <span className="insp-v">
              {muse.first_connected_at
                ? `${fmtTime(muse.first_connected_at)} · ${fmtRelativeAge(muse.first_connected_at)}`
                : "Chưa kết nối"}
            </span>
          </div>
          <div className="insp-kv">
            <span className="insp-k">Nhịp poll gần nhất (last_claim_at)</span>
            <span className="insp-v">
              {muse.last_claim_at
                ? `${fmtTime(muse.last_claim_at)} · ${fmtRelativeAge(muse.last_claim_at)}`
                : "Chưa có"}
            </span>
          </div>
          <div className="insp-kv">
            <span className="insp-k">Trả kết quả gần nhất (last_result_at)</span>
            <span className="insp-v">
              {muse.last_result_at
                ? `${fmtTime(muse.last_result_at)} · ${fmtRelativeAge(muse.last_result_at)}`
                : "Chưa có"}
            </span>
          </div>
          <div className="insp-kv">
            <span className="insp-k">Đổi token gần nhất (token_rotated_at)</span>
            <span className="insp-v">
              {muse.token_rotated_at
                ? `${fmtTime(muse.token_rotated_at)} · ${fmtRelativeAge(muse.token_rotated_at)}`
                : "Chưa từng đổi"}
            </span>
          </div>
        </div>
      </div>

      <div className="insp-section">
        <span className="insp-label">Định danh &amp; Thư mục</span>
        <div className="insp-kv">
          <span className="insp-k">Recipient UUID</span>
          <div className="insp-copy-row">
            <code className="insp-code">{muse.recipient}</code>
            <button
              type="button"
              className="btn-quiet btn-icon-copy"
              title="Copy recipient UUID"
              aria-label="Copy recipient UUID"
              onClick={() => copyText(muse.recipient, "Đã copy recipient UUID")}
            >
              <CopyIcon size={13} />
            </button>
          </div>
        </div>

        <div className="insp-kv">
          <span className="insp-k">Dropbox root</span>
          <div className="insp-copy-row">
            <code className="insp-code">{muse.dropbox_root || "/"}</code>
            {muse.dropbox_root && (
              <button
                type="button"
                className="btn-quiet btn-icon-copy"
                title="Copy Dropbox root"
                aria-label="Copy Dropbox root"
                onClick={() => copyText(muse.dropbox_root, "Đã copy Dropbox root")}
              >
                <CopyIcon size={13} />
              </button>
            )}
          </div>
        </div>

        {muse.email_owner && (
          <div className="insp-kv">
            <span className="insp-k">Email sở hữu Muse</span>
            <span className="insp-v">{muse.email_owner}</span>
          </div>
        )}

        <div className="insp-kv">
          <span className="insp-k">Ngày tạo</span>
          <span className="insp-v">{fmtTime(muse.created_at)}</span>
        </div>
      </div>

      <div className="insp-section">
        <span className="insp-label">Tệp Dropbox trong luồng ({paths.length})</span>
        <InspectorFileList paths={paths} emptyText="Chưa có tệp nào trong 50 tin gần nhất." />
      </div>

      <div className="insp-section">
        <span className="insp-label">Thao tác nhanh</span>
        <div className="insp-actions">
          <button type="button" className="btn-ghost insp-action-btn" onClick={() => props.onAction("rename")}>
            <EditIcon size={14} />
            <span>Đổi tên Muse</span>
          </button>
          <button type="button" className="btn-ghost insp-action-btn" onClick={() => props.onAction("rotate")}>
            <KeyIcon size={14} />
            <span>Rotate token</span>
          </button>
          <button
            type="button"
            className="btn-ghost insp-action-btn danger"
            onClick={() => props.onAction("clear")}
          >
            <TrashIcon size={14} />
            <span>Xoá lịch sử kênh</span>
          </button>
          <button
            type="button"
            className="btn-ghost insp-action-btn danger"
            onClick={() => props.onAction("delete")}
          >
            <TrashIcon size={14} />
            <span>Xoá Muse</span>
          </button>
        </div>
      </div>
    </>
  );
}

function GroupInspector(props: {
  group: Group;
  members: GroupMember[];
  paths: string[];
  onDeleteGroup?: () => void;
}) {
  const { group, members, paths, onDeleteGroup } = props;
  return (
    <>
      <div className="insp-card insp-identity">
        <span className="avatar-monogram lg group">
          <UsersIcon size={18} />
        </span>
        <div className="insp-identity-info">
          <strong className="insp-name">{group.name}</strong>
          <span className="insp-sub">{members.length} thành viên · tạo {fmtTime(group.created_at)}</span>
        </div>
      </div>

      <div className="insp-section">
        <span className="insp-label">Quy tắc điều phối</span>
        <div className="insp-note-box">
          Owner là người khởi xướng duy nhất. Các Muse tự luân phiên phản hồi tối đa{" "}
          <strong>12 lượt tự động</strong> rồi dừng chờ chỉ đạo tiếp theo của owner.
        </div>
      </div>

      <div className="insp-section">
        <span className="insp-label">Thành viên ({members.length})</span>
        {members.length === 0 ? (
          <p className="insp-empty">Nhóm chưa có thành viên nào.</p>
        ) : (
          <div className="insp-member-list">
            {members.map((m, i) => (
              <div key={`${m.group_id}:${m.muse_recipient}`} className="insp-member-row">
                <span
                  className="insp-member-dot"
                  style={{ background: memberDotColor(i) }}
                />
                <div className="insp-member-meta">
                  <span className="insp-member-name">{m.name}</span>
                  <code className="insp-member-id">{m.muse_recipient}</code>
                </div>
                <button
                  type="button"
                  className="btn-quiet btn-icon-copy"
                  title="Copy muse_recipient"
                  aria-label={`Copy UUID của ${m.name}`}
                  onClick={() => copyText(m.muse_recipient, `Đã copy UUID của ${m.name}`)}
                >
                  <CopyIcon size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="insp-section">
        <span className="insp-label">Tệp Dropbox trong nhóm ({paths.length})</span>
        <InspectorFileList paths={paths} emptyText="Chưa có tệp nào trong luồng nhóm." />
      </div>

      {onDeleteGroup && (
        <div className="insp-section">
          <span className="insp-label">Quản lý nhóm</span>
          <div className="insp-actions">
            <button
              type="button"
              className="btn-ghost insp-action-btn danger"
              onClick={onDeleteGroup}
            >
              <TrashIcon size={14} />
              <span>Xoá nhóm cũ</span>
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function OverviewInspector() {
  return (
    <>
      <div className="insp-section">
        <span className="insp-label">Quy trình Project &amp; Agent</span>
        <ol className="insp-guide-list">
          <li>
            <strong>Quản trị Agent:</strong> Thêm <em>Muse Relay</em> (tạo <code>recipient</code>{" "}
            UUID &amp; <code>RELAY_TOKEN</code>) hoặc <em>OpenAI Compatible</em>.
          </li>
          <li>
            <strong>Tạo Project:</strong> Gom nhóm các Agent (Muse và/hoặc OpenAI) phục vụ cùng
            một mục tiêu.
          </li>
          <li>
            <strong>Cuộc hội thoại:</strong> Chọn đúng các Agent trong Project — hệ thống tự chạy
            1:1, Nhóm Muse, OpenAI hoặc Hỗn hợp đa mô hình.
          </li>
        </ol>
      </div>

      <div className="insp-section">
        <span className="insp-label">Quy ước Dropbox &amp; Lưu trữ</span>
        <div className="insp-note-box">
          <div className="insp-note-line">
            <FolderIcon size={14} />
            <span>Mỗi Muse có một thư mục gốc riêng dạng <code>/&lt;email&gt;/</code>.</span>
          </div>
          <p>
            Tên file tài nguyên bắt đầu bằng <code>yyyy-mm-dd_hh-mm-ss_&lt;slug&gt;</code> (giờ
            Asia/Bangkok). Bản local và bản Dropbox được dọn sau <strong>24 giờ</strong>.
          </p>
        </div>
      </div>
    </>
  );
}

function InspectorFileList({ paths, emptyText }: { paths: string[]; emptyText: string }) {
  if (paths.length === 0) {
    return <p className="insp-empty">{emptyText}</p>;
  }
  return (
    <div className="insp-files">
      {paths.map((p) => (
        <div key={p} className="insp-file-item">
          <span className="insp-file-icon">
            <ResourceKindIcon path={p} size={15} />
          </span>
          <div className="insp-file-info">
            <span className="insp-file-name" title={fileName(p)}>{fileName(p)}</span>
            <span className="insp-file-kind">{resourceLabel(p)}</span>
            <code className="insp-file-path">{p}</code>
          </div>
          <button
            type="button"
            className="btn-quiet btn-icon-copy"
            title="Copy đường dẫn Dropbox"
            aria-label={`Copy đường dẫn ${fileName(p)}`}
            onClick={() => copyText(p, "Đã copy đường dẫn")}
          >
            <CopyIcon size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
