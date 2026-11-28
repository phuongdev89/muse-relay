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

export function isValidMuseEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim().toLowerCase());
}

/** Mirror of the CHECK constraint on relay_muses.dropbox_root. */
export function isValidDropboxRoot(root: string): boolean {
  return (
    root.startsWith("/") &&
    root.endsWith("/") &&
    root.length > 1 &&
    root.length <= 256 &&
    !root.includes("..")
  );
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

/** Last path segment, for card titles. */
export function fileName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** `https://www.dropbox.com/home/<segment>/<segment>` with each segment URL-encoded. */
export function dropboxWebUrl(path: string): string {
  const segments = path.split("/").filter(Boolean).map(encodeURIComponent);
  return `https://www.dropbox.com/home/${segments.join("/")}`;
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif"]);
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

/** Any http(s) URLs mentioned in a text — used to render inline previews. */
export function extractUrls(text: string): string[] {
  return text.match(URL_RE) ?? [];
}

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_ATTACH_FILES = 4;

/** Validates and merges newly picked/dropped files against attachment limits. */
export function mergeAttachmentFiles(
  existing: File[],
  incoming: File[],
  maxFiles = MAX_ATTACH_FILES,
): { files: File[]; rejectedLarge: File[]; overflowCount: number } {
  const valid: File[] = [];
  const rejectedLarge: File[] = [];
  for (const file of incoming) {
    if (file.size < 1 || file.size > MAX_UPLOAD_BYTES) {
      rejectedLarge.push(file);
    } else {
      valid.push(file);
    }
  }
  const combined = [...existing];
  let overflowCount = 0;
  for (const file of valid) {
    const dup = combined.some(
      (f) => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified,
    );
    if (dup) continue;
    if (combined.length < maxFiles) {
      combined.push(file);
    } else {
      overflowCount++;
    }
  }
  return { files: combined, rejectedLarge, overflowCount };
}

export function isImageUrl(url: string): boolean {
  try {
    return IMAGE_EXT.has(extOf(new URL(url).pathname));
  } catch {
    return false;
  }
}

const DROPBOX_INPUT_NOTE_RE = /\s*\[Dropbox input: [^\]]*\]/g;

/** Legacy owner bubbles (and any hand-typed marker) still carry a
 * `[Dropbox input: ...]` line; the attachment cards render the paths from
 * params.reference_dropbox_paths, so bubbles display the text without it. */
export function stripDropboxInputNote(text: string): string {
  return text.replace(DROPBOX_INPUT_NOTE_RE, "").trimEnd();
}

const REPLY_PREFIX_RE = /^\[Replying to [^\n]+\](?::\s*(?:"[^\n]*")?)?[ \t]*\r?\n+/;

/** Strips a leading `[Replying to ...]: "..."\n` or `[Replying to ...]\n`
 * header prepended when forwarding reply context to models/muses. */
export function stripReplyPrefix(text: string): string {
  return text.replace(REPLY_PREFIX_RE, "");
}

/** Builds a compact single-line ReplyToMeta payload from a message. */
export function buildReplyToMeta(
  sender: string,
  rawText: string,
  opts?: { messageId?: string; fallbackText?: string },
): { message_id?: string; sender: string; excerpt: string } {
  const cleanText = rawText.replace(/\s+/g, " ").trim();
  const base = cleanText || opts?.fallbackText || "";
  const excerpt = base.length > 140 ? `${base.slice(0, 137)}…` : base;
  return opts?.messageId
    ? { message_id: opts.messageId, sender, excerpt }
    : { sender, excerpt };
}
