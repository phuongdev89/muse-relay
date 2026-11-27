const TIME_OPTS: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};

/** Today → `14:05`; older → `27/11 14:05`. */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString("vi-VN", TIME_OPTS);
  return sameDay
    ? time
    : `${d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" })} ${time}`;
}

/** Wall-clock with seconds, for "last refreshed" indicators. */
export function fmtClock(d: Date): string {
  return d.toLocaleTimeString("vi-VN", { ...TIME_OPTS, second: "2-digit" });
}

// Derived message states beyond the DB's four: a pending row whose claim
// window already passed will never be claimed, and a processing row whose
// claim lease expired means the muse went silent — surface both honestly.
export type OwnerState =
  | "pending"
  | "processing"
  | "done"
  | "failed"
  | "expired";

export function ownerState(
  status: string,
  expiresAt: string | null,
  claimExpiresAt: string | null,
): OwnerState {
  if (status === "done") return "done";
  if (status === "failed") return "failed";
  if (status === "processing") {
    return claimExpiresAt && new Date(claimExpiresAt).getTime() < Date.now()
      ? "expired"
      : "processing";
  }
  return expiresAt && new Date(expiresAt).getTime() < Date.now()
    ? "expired"
    : "pending";
}

/** Short params summary shown under the owner bubble. */
export function paramsSummary(
  action: string,
  p: { thread_id?: string | null; aspect_ratio?: string; count?: number; duration_seconds?: number; resource_type?: string; output_format?: string },
): string {
  const parts: string[] = [];
  if (action === "image") parts.push(`${p.count ?? 1} ảnh`, p.aspect_ratio ?? "");
  if (action === "video") parts.push(`${p.duration_seconds ?? 8}s`, p.aspect_ratio ?? "");
  if (action === "chat") {
    if (p.resource_type && p.resource_type !== "auto") parts.push(p.resource_type);
    if (p.output_format && p.output_format !== "auto") parts.push(p.output_format);
  }
  if (p.thread_id) parts.push(`⌗${p.thread_id}`);
  return parts.filter(Boolean).join(" · ");
}
