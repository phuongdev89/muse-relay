import type { CSSProperties } from "react";
import { resourceKind, type ResourceKind } from "../../lib/dropbox";

export interface IconProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

const baseProps = (size = 16, className?: string, style?: CSSProperties) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className,
  style,
  "aria-hidden": true as const,
});

export function StarIcon({ size = 18, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M12 2l2.4 6.2L21 9.4l-5 4.3 1.6 6.5L12 16.8 6.4 20.2 8 13.7 3 9.4l6.6-1.2L12 2z" />
    </svg>
  );
}

export function OverviewIcon({ size = 16, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <rect x="3" y="3" width="7" height="9" rx="2" />
      <rect x="14" y="3" width="7" height="5" rx="2" />
      <rect x="14" y="12" width="7" height="9" rx="2" />
      <rect x="3" y="16" width="7" height="5" rx="2" />
    </svg>
  );
}

export function PlusIcon({ size = 15, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function SearchIcon({ size = 15, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  );
}

export function XIcon({ size = 15, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

export function MessageIcon({ size = 15, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function ImageIcon({ size = 15, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}

export function VideoIcon({ size = 15, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M23 7l-7 5 7 5V7z" />
      <rect x="1" y="5" width="15" height="14" rx="2.5" />
    </svg>
  );
}

function AudioIcon({ size = 16, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
      <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
    </svg>
  );
}

function FileTextIcon({ size = 16, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
    </svg>
  );
}

function TableIcon({ size = 16, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M3 15h18M9 3v18" />
    </svg>
  );
}

function ArchiveIcon({ size = 16, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4" />
    </svg>
  );
}

export function PaperclipIcon({ size = 16, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

export function LinkIcon({ size = 14, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

export function EditIcon({ size = 15, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

export function KeyIcon({ size = 15, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="M21 2l-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" />
    </svg>
  );
}

export function TrashIcon({ size = 15, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

export function CopyIcon({ size = 14, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function CheckIcon({ size = 14, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

export function RefreshIcon({ size = 15, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M23 4v6h-6M1 20v-6h6" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

export function SlidersIcon({ size = 14, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
    </svg>
  );
}

export function ChevronDownIcon({ size = 14, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function ChevronRightIcon({ size = 14, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

export function SendIcon({ size = 15, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}

export function ArrowDownIcon({ size = 14, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M12 5v14M19 12l-7 7-7-7" />
    </svg>
  );
}

export function SunIcon({ size = 14, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

export function MoonIcon({ size = 14, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

export function MenuIcon({ size = 18, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M3 12h18M3 6h18M3 18h18" />
    </svg>
  );
}

export function PanelRightIcon({ size = 16, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M15 3v18" />
    </svg>
  );
}

export function LogOutIcon({ size = 15, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
    </svg>
  );
}

export function UsersIcon({ size = 15, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

export function LockIcon({ size = 15, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

export function ActivityIcon({ size = 15, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

export function FolderIcon({ size = 15, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function BotIcon({ size = 15, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M12 8V4H8" />
      <rect x="4" y="8" width="16" height="12" rx="2.5" />
      <path d="M2 14h2M20 14h2M9 13v2M15 13v2" />
    </svg>
  );
}

export function LayersIcon({ size = 15, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5M2 12l10 5 10-5" />
    </svg>
  );
}

export function SettingsIcon({ size = 14, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function EyeIcon({ size = 15, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function EyeOffIcon({ size = 15, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <path d="M1 1l22 22" />
    </svg>
  );
}

export function PlugIcon({ size = 14, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M12 22v-5" />
      <path d="M9 8V2M15 8V2" />
      <path d="M18 8v5a6 6 0 0 1-12 0V8z" />
    </svg>
  );
}

export function DownloadIcon({ size = 14, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5M12 15V3" />
    </svg>
  );
}

export function ExternalLinkIcon({ size = 13, className, style }: IconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6M10 14L21 3" />
    </svg>
  );
}

export function ResourceKindIcon({ path, size = 18, className, style }: { path: string } & IconProps) {
  const kind: ResourceKind = resourceKind(path);
  switch (kind) {
    case "image":
      return <ImageIcon size={size} className={className} style={style} />;
    case "video":
      return <VideoIcon size={size} className={className} style={style} />;
    case "audio":
      return <AudioIcon size={size} className={className} style={style} />;
    case "document":
      return <FileTextIcon size={size} className={className} style={style} />;
    case "spreadsheet":
      return <TableIcon size={size} className={className} style={style} />;
    case "archive":
      return <ArchiveIcon size={size} className={className} style={style} />;
    default:
      return <PaperclipIcon size={size} className={className} style={style} />;
  }
}
