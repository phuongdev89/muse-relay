import { getStoredLang, translate, type I18nKey, type Lang } from "./i18n";

// Dropbox conventions: every muse owns exactly one root folder — `/<email>/` —
// derived from the owner email the wizard collects. The server independently
// enforces that result paths stay under the muse's root (relay_muses.dropbox_root),
// so derivation here is a convenience, not the security boundary.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** `Tên@domain.com` → `/tên@domain.com/`; null when the email is invalid. */
export function emailToRoot(email: string): string | null {
  const e = email.trim().toLowerCase();
  return EMAIL_RE.test(e) ? `/${e}/` : null;
}

export type ResourceKind =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "spreadsheet"
  | "archive"
  | "other";

const EXT_KIND: Record<string, ResourceKind> = {
  png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image",
  avif: "image", heic: "image", svg: "image",
  mp4: "video", webm: "video", mov: "video", mkv: "video", avi: "video",
  mp3: "audio", wav: "audio", m4a: "audio", flac: "audio", ogg: "audio",
  md: "document", txt: "document", pdf: "document", docx: "document", doc: "document",
  csv: "spreadsheet", xlsx: "spreadsheet",
  zip: "archive", rar: "archive", "7z": "archive", tar: "archive", gz: "archive",
};

const KIND_KEY: Record<ResourceKind, I18nKey> = {
  image: "res.image",
  video: "res.video",
  audio: "res.audio",
  document: "res.document",
  spreadsheet: "res.spreadsheet",
  archive: "res.archive",
  other: "res.other",
};

const KIND_ICON: Record<ResourceKind, string> = {
  image: "🖼",
  video: "🎬",
  audio: "🎧",
  document: "📄",
  spreadsheet: "📊",
  archive: "🗃",
  other: "📎",
};

function extOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

export function resourceKind(path: string): ResourceKind {
  return EXT_KIND[extOf(path)] ?? "other";
}

export function resourceLabel(path: string, lang: Lang = getStoredLang()): string {
  return translate(lang, KIND_KEY[resourceKind(path)]);
}

export function resourceIcon(path: string): string {
  return KIND_ICON[resourceKind(path)];
}

/** Last path segment, for card titles. */
export function fileName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif"]);
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

/** Any http(s) URLs mentioned in a text — used to render inline previews. */
export function extractUrls(text: string): string[] {
  return text.match(URL_RE) ?? [];
}

export function isImageUrl(url: string): boolean {
  try {
    return IMAGE_EXT.has(extOf(new URL(url).pathname));
  } catch {
    return false;
  }
}
