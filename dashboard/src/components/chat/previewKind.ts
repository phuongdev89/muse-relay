import { resourceKind } from "../../lib/dropbox";

// Synchronous, dependency-free classification shared by the resource cards,
// the gallery shell, and the (lazily loaded) preview renderers.

export type PreviewKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "md"
  | "json"
  | "text"
  | "binary";

export type FetchableKind = Exclude<PreviewKind, "image" | "video" | "audio">;

/** Print / open-in-new-tab hooks exposed by the PDF viewer to the gallery. */
export interface PdfActions {
  print: () => void;
  openInNewTab: () => void;
}

const CODEISH_EXTS = new Set([
  "txt", "csv", "tsv", "log",
  "js", "mjs", "cjs", "ts", "jsx", "tsx",
  "py", "css", "scss", "less", "html", "htm", "xml",
  "yml", "yaml", "sh", "bash", "zsh", "fish", "sql", "toml", "ini",
  "cfg", "conf", "env", "gitignore", "dockerfile", "makefile",
  "java", "c", "h", "cpp", "hpp", "cs", "go", "rs", "rb", "php",
  "swift", "kt", "scala", "pl", "lua", "r", "bat", "ps1",
  "diff", "patch", "srt", "vtt", "graphql", "gql", "proto",
  "hbs", "handlebars", "ejs", "vue",
]);

function extOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Modal body renderer for a resource path (image/video/audio stream directly;
 * pdf streams a blob; md/json/text-ish fetch text; unknown kinds sniff binary). */
export function previewKindOf(path: string): PreviewKind {
  const kind = resourceKind(path);
  if (kind === "image" || kind === "video" || kind === "audio") return kind;
  const ext = extOf(path);
  if (ext === "pdf") return "pdf";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "json") return "json";
  if (CODEISH_EXTS.has(ext)) return "text";
  return "binary";
}
