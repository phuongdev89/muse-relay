import type { FleetActivityItem, Muse } from "../types";

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
  if (p.thread_id) parts.push(`#${p.thread_id}`);
  return parts.filter(Boolean).join(" · ");
}

export type MuseFleetStatus = "processing" | "pending" | "error" | "idle";

export interface MuseFleetSummary {
  recipient: string;
  status: MuseFleetStatus;
  activeCount: number;
  processingCount: number;
  pendingCount: number;
  errorCount: number;
  latest: FleetActivityItem | null;
}

export function summarizeMuseFleet(
  muses: Muse[],
  fleetItems: FleetActivityItem[],
): Map<string, MuseFleetSummary> {
  const map = new Map<string, MuseFleetSummary>();
  for (const m of muses) {
    map.set(m.recipient, {
      recipient: m.recipient,
      status: "idle",
      activeCount: 0,
      processingCount: 0,
      pendingCount: 0,
      errorCount: 0,
      latest: null,
    });
  }

  for (const item of fleetItems) {
    const entry = map.get(item.recipient);
    if (!entry) continue;
    if (!entry.latest) entry.latest = item;

    const st = ownerState(
      item.message.status,
      item.message.expires_at,
      item.message.claim_expires_at,
    );
    if (st === "processing") {
      entry.processingCount++;
      entry.activeCount++;
    } else if (st === "pending") {
      entry.pendingCount++;
      entry.activeCount++;
    } else if (st === "failed" || st === "expired") {
      entry.errorCount++;
    }
  }

  for (const entry of map.values()) {
    if (entry.processingCount > 0) {
      entry.status = "processing";
    } else if (entry.pendingCount > 0) {
      entry.status = "pending";
    } else if (entry.latest) {
      const latestSt = ownerState(
        entry.latest.message.status,
        entry.latest.message.expires_at,
        entry.latest.message.claim_expires_at,
      );
      entry.status = latestSt === "failed" || latestSt === "expired" ? "error" : "idle";
    }
  }

  return map;
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "M";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const MEMBER_HUES = [75, 155, 240, 25, 320, 190, 280];

export function memberDotColor(index: number): string {
  const hue = index >= 0 ? MEMBER_HUES[index % MEMBER_HUES.length] : 200;
  return `oklch(70% 0.12 ${hue})`;
}
