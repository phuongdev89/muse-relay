import { useEffect } from "react";
import { fileName, resourceLabel } from "../lib/dropbox";
import { fmtTime, initialsOf, memberDotColor, type MuseFleetSummary } from "../lib/format";
import type { ActiveRoom, Group, GroupMember, Muse } from "../types";
import {
  CopyIcon,
  EditIcon,
  FolderIcon,
  KeyIcon,
  ResourceKindIcon,
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

export function InspectorPanel(props: {
  desktopOpen: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  active: ActiveRoom;
  muse: Muse | null;
  museSummary: MuseFleetSummary | null;
  group: Group | null;
  groupMembers: GroupMember[];
  threadPaths: string[];
  onMuseAction: (action: "rename" | "rotate" | "delete") => void;
}) {
  const { desktopOpen, mobileOpen, onCloseMobile, muse, museSummary, group, groupMembers, threadPaths } = props;

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseMobile();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileOpen, onCloseMobile]);

  const panelClass = `inspector${desktopOpen ? " desktop-open" : " desktop-closed"}${mobileOpen ? " mobile-open" : ""}`;

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
          <span className="inspector-title">
            {muse ? "Hồ sơ Muse" : group ? "Chi tiết Nhóm" : "Hướng dẫn Relay"}
          </span>
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
          {muse ? (
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
            />
          ) : (
            <OverviewInspector />
          )}
        </div>
      </aside>
    </>
  );
}

function MuseInspector(props: {
  muse: Muse;
  summary: MuseFleetSummary | null;
  paths: string[];
  onAction: (action: "rename" | "rotate" | "delete") => void;
}) {
  const { muse, summary, paths } = props;
  const status = summary?.status ?? "idle";

  return (
    <>
      <div className="insp-card insp-identity">
        <span className={`avatar-monogram lg status-${status}`}>
          {initialsOf(muse.name)}
        </span>
        <div className="insp-identity-info">
          <strong className="insp-name">{muse.name}</strong>
          <Chip state={STATUS_CHIP[status]} label={STATUS_LABEL[status]} />
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
}) {
  const { group, members, paths } = props;
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
    </>
  );
}

function OverviewInspector() {
  return (
    <>
      <div className="insp-section">
        <span className="insp-label">Quy trình kết nối Relay</span>
        <ol className="insp-guide-list">
          <li>
            <strong>Đăng ký Muse:</strong> Nhấn <em>Thêm Muse</em> để tạo <code>recipient</code> UUID và{" "}
            <code>RELAY_TOKEN</code> dùng một lần.
          </li>
          <li>
            <strong>Nạp Secure Vault:</strong> Dán token vào Secure Vault của Muse, rồi gửi bản hướng dẫn
            canonical qua chat riêng của Muse.
          </li>
          <li>
            <strong>Giao việc &amp; Theo dõi:</strong> Gửi yêu cầu Chat / Ảnh / Video trong phòng 1:1 hoặc
            tạo Nhóm để các Muse phối hợp tự động.
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
