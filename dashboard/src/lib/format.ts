import type { FleetActivityItem, Muse } from "../types";
import { getStoredLang, translate, type Lang } from "./i18n";

const TIME_OPTS: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};

function intlLocale(lang: Lang): string {
  return lang === "en" ? "en-US" : "vi-VN";
}

const RTF_CACHE: Record<Lang, Intl.RelativeTimeFormat> = {
  vi: new Intl.RelativeTimeFormat("vi-VN", { numeric: "always" }),
  en: new Intl.RelativeTimeFormat("en-US", { numeric: "always" }),
};

/** Today → `14:05`; older → `27/11 14:05` (vi) or `11/27 14:05` (en). */
export function fmtTime(iso: string, lang: Lang = getStoredLang()): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return translate(lang, "common.unknown");
  const locale = intlLocale(lang);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString(locale, TIME_OPTS);
  return sameDay
    ? time
    : `${d.toLocaleDateString(locale, { day: "2-digit", month: "2-digit" })} ${time}`;
}

/** Wall-clock with seconds, for "last refreshed" indicators. */
export function fmtClock(d: Date, lang: Lang = getStoredLang()): string {
  return d.toLocaleTimeString(intlLocale(lang), { ...TIME_OPTS, second: "2-digit" });
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
  p: {
    thread_id?: string | null;
    aspect_ratio?: string;
    count?: number;
    duration_seconds?: number;
    resource_type?: string;
    output_format?: string;
  },
  lang: Lang = getStoredLang(),
): string {
  const parts: string[] = [];
  if (action === "image") {
    parts.push(
      translate(lang, "fmt.imageCount", { count: p.count ?? 1 }),
      p.aspect_ratio ?? "",
    );
  }
  if (action === "video") {
    parts.push(`${p.duration_seconds ?? 8}s`, p.aspect_ratio ?? "");
  }
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

/** Locale-aware relative age using Intl.RelativeTimeFormat. */
export function fmtRelativeAge(
  iso: string | null,
  lang: Lang = getStoredLang(),
  nowMs = Date.now(),
): string {
  if (!iso) return translate(lang, "common.none");
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return translate(lang, "common.unknown");
  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (diffSec < 5) return translate(lang, "fmt.justNow");
  const rtf = RTF_CACHE[lang];
  if (diffSec < 60) return rtf.format(-diffSec, "second");
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return rtf.format(-diffMin, "minute");
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return rtf.format(-diffHour, "hour");
  const diffDay = Math.floor(diffHour / 24);
  return rtf.format(-diffDay, "day");
}

export type MuseConnectionState =
  | "not_setup"
  | "reconnecting"
  | "live"
  | "standby"
  | "offline";

export interface MuseConnectionInfo {
  setupDone: boolean;
  connected: boolean;
  state: MuseConnectionState;
  shortLabel: string;
  label: string;
  detail: string;
  chipClass: "pending" | "idle" | "processing" | "failed";
  dotClass: "dot-pending" | "dot-live" | "dot-standby" | "dot-error";
}

/** Derives setup, connection, and live heartbeat telemetry for a Muse. */
export function museConnectionInfo(
  muse: Muse,
  lang: Lang = getStoredLang(),
  nowMs = Date.now(),
): MuseConnectionInfo {
  if (!muse.setup_done && !muse.last_claim_at) {
    return {
      setupDone: false,
      connected: false,
      state: "not_setup",
      shortLabel: translate(lang, "conn.notSetupShort"),
      label: translate(lang, "conn.notSetupLabel"),
      detail: translate(lang, "conn.notSetupDetail"),
      chipClass: "pending",
      dotClass: "dot-pending",
    };
  }

  const rotatedMs = muse.token_rotated_at ? new Date(muse.token_rotated_at).getTime() : NaN;
  const claimMs = muse.last_claim_at ? new Date(muse.last_claim_at).getTime() : NaN;

  if (
    muse.token_rotated_at &&
    Number.isFinite(rotatedMs) &&
    (!muse.last_claim_at || !Number.isFinite(claimMs) || rotatedMs > claimMs)
  ) {
    return {
      setupDone: true,
      connected: false,
      state: "reconnecting",
      shortLabel: translate(lang, "conn.reconnectingShort"),
      label: translate(lang, "conn.reconnectingLabel"),
      detail: translate(lang, "conn.reconnectingDetail", {
        age: fmtRelativeAge(muse.token_rotated_at, lang, nowMs),
      }),
      chipClass: "pending",
      dotClass: "dot-pending",
    };
  }

  const age = Number.isFinite(claimMs) ? Math.max(0, nowMs - claimMs) : Infinity;

  if (age <= 3 * 60_000) {
    return {
      setupDone: true,
      connected: true,
      state: "live",
      shortLabel: translate(lang, "conn.liveShort"),
      label: translate(lang, "conn.liveLabel"),
      detail: translate(lang, "conn.pollDetail", {
        age: fmtRelativeAge(muse.last_claim_at, lang, nowMs),
      }),
      chipClass: "idle",
      dotClass: "dot-live",
    };
  }

  if (age <= 15 * 60_000) {
    return {
      setupDone: true,
      connected: true,
      state: "standby",
      shortLabel: translate(lang, "conn.standbyShort"),
      label: translate(lang, "conn.standbyLabel"),
      detail: translate(lang, "conn.pollDetail", {
        age: fmtRelativeAge(muse.last_claim_at, lang, nowMs),
      }),
      chipClass: "processing",
      dotClass: "dot-standby",
    };
  }

  return {
    setupDone: true,
    connected: false,
    state: "offline",
    shortLabel: translate(lang, "conn.offlineShort"),
    label: translate(lang, "conn.offlineLabel"),
    detail: muse.last_claim_at
      ? translate(lang, "conn.offlineDetailLast", {
          age: fmtRelativeAge(muse.last_claim_at, lang, nowMs),
        })
      : translate(lang, "conn.offlineDetailNone"),
    chipClass: "failed",
    dotClass: "dot-error",
  };
}
