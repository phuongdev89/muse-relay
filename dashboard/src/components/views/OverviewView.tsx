import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchFleetActivity, FLEET_ACTIVITY_PAGE_SIZE } from "../../lib/api";
import {
  fmtClock,
  fmtRelativeAge,
  fmtTime,
  initialsOf,
  museConnectionInfo,
  ownerState,
  summarizeMuseFleet,
  type MuseFleetStatus,
} from "../../lib/format";
import { useLang, type I18nKey } from "../../lib/i18n";
import type { Conversation, FleetActivityItem, Muse } from "../../types";
import {
  ActivityIcon,
  ChevronRightIcon,
  FolderIcon,
  ImageIcon,
  MessageIcon,
  PanelRightIcon,
  PlusIcon,
  RefreshIcon,
  VideoIcon,
} from "../common/Icons";
import { Chip } from "../common/ui";

type ActivityFilter = "all" | "processing" | "pending" | "done" | "error";

const FILTER_TABS: { key: ActivityFilter; labelKey: I18nKey }[] = [
  { key: "all", labelKey: "ov.filterAll" },
  { key: "processing", labelKey: "ov.filterProcessing" },
  { key: "pending", labelKey: "ov.filterPending" },
  { key: "done", labelKey: "ov.filterDone" },
  { key: "error", labelKey: "ov.filterError" },
];

const FLEET_STATUS_KEY: Record<MuseFleetStatus, I18nKey> = {
  processing: "fleetStatus.processing",
  pending: "fleetStatus.pending",
  error: "fleetStatus.error",
  idle: "fleetStatus.idle",
};

const FLEET_STATUS_CHIP: Record<MuseFleetStatus, string> = {
  processing: "processing",
  pending: "pending",
  error: "failed",
  idle: "idle",
};

function ActionIcon({ action }: { action: string }) {
  if (action === "image") return <ImageIcon size={14} />;
  if (action === "video") return <VideoIcon size={14} />;
  return <MessageIcon size={14} />;
}

export function OverviewView(props: {
  muses: Muse[];
  projectsCount: number;
  openaiCount: number;
  fleetItems: FleetActivityItem[];
  /** all project conversations — used to resolve an activity's thread_id back
   * to the exact conversation room (group posts carry group_id in thread_id). */
  conversations: Conversation[];
  loading: boolean;
  error: string;
  updatedAt: Date | null;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onRefresh: () => void;
  onOpenMuse: (recipient: string) => void;
  onOpenConversation: (projectId: string, conversationId: string) => void;
  onAddMuse: () => void;
}) {
  const {
    muses,
    projectsCount,
    openaiCount,
    fleetItems,
    conversations,
    loading,
    error,
    updatedAt,
  } = props;
  const { lang, t } = useLang();
  const [filter, setFilter] = useState<ActivityFilter>("all");

  // ---- infinite scroll accumulation ----------------------------------------
  // props.fleetItems is the live-polled first page (App refreshes it every
  // 10s); extraItems holds pages fetched beyond it via the sentinel observer.
  const [extraItems, setExtraItems] = useState<FleetActivityItem[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const accumulatedItems = useMemo(() => {
    const seen = new Set<string>();
    const merged: FleetActivityItem[] = [];
    for (const it of [...fleetItems, ...extraItems]) {
      if (seen.has(it.message.id)) continue;
      seen.add(it.message.id);
      merged.push(it);
    }
    merged.sort((a, b) => b.message.created_at.localeCompare(a.message.created_at));
    return merged;
  }, [fleetItems, extraItems]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || loading) return;
    setLoadingMore(true);
    try {
      const { items } = await fetchFleetActivity(
        FLEET_ACTIVITY_PAGE_SIZE,
        accumulatedItems.length,
      );
      if (items.length === 0) {
        setHasMore(false);
        return;
      }
      setExtraItems((cur) => [...cur, ...items]);
      if (items.length < FLEET_ACTIVITY_PAGE_SIZE) setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, loading, accumulatedItems.length]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { rootMargin: "240px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore, hasMore]);

  const museByRecipient = useMemo(
    () => new Map(muses.map((m) => [m.recipient, m])),
    [muses],
  );

  const fleetSummary = useMemo(
    () => summarizeMuseFleet(muses, accumulatedItems),
    [muses, accumulatedItems],
  );

  const kpis = useMemo(() => {
    let processing = 0;
    let pending = 0;
    let errorOrExpired = 0;
    let done = 0;

    for (const item of accumulatedItems) {
      const st = ownerState(
        item.message.status,
        item.message.expires_at,
        item.message.claim_expires_at,
      );
      if (st === "processing") processing++;
      else if (st === "pending") pending++;
      else if (st === "done") done++;
      else errorOrExpired++;
    }

    return { processing, pending, errorOrExpired, done };
  }, [accumulatedItems]);

  const filteredActivity = useMemo(() => {
    if (filter === "all") return accumulatedItems;
    return accumulatedItems.filter((item) => {
      const st = ownerState(
        item.message.status,
        item.message.expires_at,
        item.message.claim_expires_at,
      );
      if (filter === "error") return st === "failed" || st === "expired";
      return st === filter;
    });
  }, [accumulatedItems, filter]);

  /** Group/conversation posts carry thread_id — route them to the exact room;
   * plain direct-channel activity falls back to the muse's direct channel. */
  function openActivity(item: FleetActivityItem) {
    if (item.threadId) {
      const conv =
        conversations.find((c) => c.id === item.threadId) ??
        conversations.find((c) => c.group_id === item.threadId);
      if (conv) {
        props.onOpenConversation(conv.project_id, conv.id);
        return;
      }
    }
    props.onOpenMuse(item.recipient);
  }

  const showSkeleton = loading && fleetItems.length === 0 && !error;

  return (
    <section className="overview-pane fade" aria-label={t("ov.aria")}>
      <div className="pane-head">
        <div className="pane-title-group">
          <h2>{t("ov.title")}</h2>
          <span className="sub">
            {updatedAt
              ? t("ov.updated", { time: fmtClock(updatedAt, lang) })
              : t("ov.loading")}{" "}
            · {t("ov.autoRefresh")}
          </span>
        </div>
        <span className="grow" />
        <div className="pane-actions">
          <button type="button" className="btn-ghost" onClick={props.onRefresh}>
            <RefreshIcon size={14} />
            <span>{t("common.refresh")}</span>
          </button>
          <button
            type="button"
            className={`btn-ghost btn-inspector-toggle${props.inspectorOpen ? " active" : ""}`}
            onClick={props.onToggleInspector}
            aria-pressed={props.inspectorOpen}
            title={t("common.toggleInspector")}
            aria-label={t("common.toggleInspector")}
          >
            <PanelRightIcon size={15} />
            <span className="hide-xs">{t("common.details")}</span>
          </button>
        </div>
      </div>

      <div className="overview-scroll">
        {error && (
          <div className="banner-error" role="alert">
            <span>{t("ov.loadErr", { err: error })}</span>
            <button type="button" className="btn-ghost btn-sm" onClick={props.onRefresh}>
              {t("common.retry")}
            </button>
          </div>
        )}

        {/* Fleet KPI Strip */}
        <div className="kpi-grid">
          <div className="kpi-card">
            <span className="kpi-label">{t("ov.kpiSystem")}</span>
            <strong className="kpi-value">
              {muses.length + openaiCount} <span className="kpi-unit">{t("ov.unitAgent")}</span> ·{" "}
              {projectsCount} <span className="kpi-unit">{t("ov.unitProject")}</span>
            </strong>
          </div>
          <div className="kpi-card kpi-busy">
            <span className="kpi-label">{t("ov.kpiProcessing")}</span>
            <strong className="kpi-value">{showSkeleton ? "—" : kpis.processing}</strong>
          </div>
          <div className="kpi-card kpi-wait">
            <span className="kpi-label">{t("ov.kpiPending")}</span>
            <strong className="kpi-value">{showSkeleton ? "—" : kpis.pending}</strong>
          </div>
          <div className="kpi-card kpi-bad">
            <span className="kpi-label">{t("ov.kpiErrors")}</span>
            <strong className="kpi-value">{showSkeleton ? "—" : kpis.errorOrExpired}</strong>
          </div>
        </div>

        {/* Muse Fleet Status Cards */}
        <section className="ov-section" aria-label={t("ov.fleetAria")}>
          <div className="ov-section-head">
            <h3>{t("ov.fleetTitle", { count: muses.length })}</h3>
            <button type="button" className="btn-ghost btn-sm" onClick={props.onAddMuse}>
              <PlusIcon size={14} />
              <span>{t("ov.addMuse")}</span>
            </button>
          </div>

          {muses.length === 0 ? (
            <div className="ov-empty-card">
              <p>{t("ov.emptyFleet")}</p>
              <button type="button" className="btn" onClick={props.onAddMuse}>
                <PlusIcon size={15} />
                <span>{t("ov.addFirstMuse")}</span>
              </button>
            </div>
          ) : (
            <div className="fleet-grid">
              {muses.map((m) => {
                const summary = fleetSummary.get(m.recipient);
                const status = summary?.status ?? "idle";
                const conn = museConnectionInfo(m, lang);
                const latest = summary?.latest ?? null;
                const latestPreview =
                  latest?.result?.error ||
                  latest?.result?.output?.text ||
                  latest?.message.params.prompt ||
                  t("ov.noRequests");
                return (
                  <button
                    key={m.recipient}
                    type="button"
                    className={`fleet-card status-${status}`}
                    onClick={() => props.onOpenMuse(m.recipient)}
                  >
                    <div className="fleet-card-top">
                      <div className="fleet-identity">
                        <span className={`avatar-monogram status-${status}`}>
                          {initialsOf(m.name)}
                        </span>
                        <div className="fleet-name-wrap">
                          <span className="fleet-name">{m.name}</span>
                          <span className="fleet-root">
                            <FolderIcon size={12} />
                            <code>{m.dropbox_root || "/"}</code>
                          </span>
                        </div>
                      </div>
                      <Chip state={FLEET_STATUS_CHIP[status]} label={t(FLEET_STATUS_KEY[status])} />
                    </div>

                    <div className="fleet-conn-row">
                      <Chip state={conn.chipClass} label={conn.shortLabel} />
                      <span className="fleet-conn-age">
                        {conn.state === "reconnecting"
                          ? t("ov.awaitingToken")
                          : m.last_claim_at
                            ? t("conn.pollDetail", { age: fmtRelativeAge(m.last_claim_at, lang) })
                            : t("ov.notPolled")}
                      </span>
                    </div>

                    <p className="fleet-preview">{latestPreview}</p>

                    <div className="fleet-card-foot">
                      <span className="fleet-time">
                        {latest
                          ? t("ov.activeAt", { time: fmtTime(latest.message.created_at, lang) })
                          : t("ov.createdAt", { time: fmtTime(m.created_at, lang) })}
                      </span>
                      <span className="fleet-cta">
                        {summary && summary.activeCount > 0 ? (
                          <span className="fleet-active-pill">
                            {t("ov.runningJobs", { count: summary.activeCount })}
                          </span>
                        ) : (
                          <span className="fleet-jump">
                            {t("ov.openRoom")} <ChevronRightIcon size={13} />
                          </span>
                        )}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* Filterable Recent Activity Feed */}
        <section className="ov-section" aria-label={t("ov.recentAria")}>
          <div className="ov-section-head">
            <div className="ov-section-title">
              <ActivityIcon size={16} />
              <h3>{t("ov.recentTitle")}</h3>
            </div>
            <div className="filter-pills" role="tablist" aria-label={t("ov.filterAria")}>
              {FILTER_TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={filter === tab.key}
                  className={`filter-pill${filter === tab.key ? " on" : ""}`}
                  onClick={() => setFilter(tab.key)}
                >
                  {t(tab.labelKey)}
                </button>
              ))}
            </div>
          </div>

          {showSkeleton ? (
            <div className="activity-skeletons">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="skeleton-row">
                  <div className="skeleton-line w-30" />
                  <div className="skeleton-line w-70" />
                </div>
              ))}
            </div>
          ) : filteredActivity.length === 0 ? (
            <div className="ov-empty-feed">
              {accumulatedItems.length === 0 ? t("ov.emptyFeed") : t("ov.emptyFeedFiltered")}
            </div>
          ) : (
            <div className="activity-list">
              {filteredActivity.map((item) => {
                const muse = museByRecipient.get(item.recipient);
                const st = ownerState(
                  item.message.status,
                  item.message.expires_at,
                  item.message.claim_expires_at,
                );
                const promptText = item.message.params.prompt ?? t("ov.noContent");
                const replySnippet =
                  st === "failed"
                    ? item.result?.error
                    : item.result?.output?.text ||
                      (item.result?.output?.dropbox_paths?.length
                        ? t("ov.dropboxFilesCount", {
                            count: item.result.output.dropbox_paths.length,
                          })
                        : null);
                return (
                  <button
                    key={item.message.id}
                    type="button"
                    className="activity-row"
                    onClick={() => openActivity(item)}
                  >
                    <span className={`activity-action-icon action-${item.message.action}`}>
                      <ActionIcon action={item.message.action} />
                    </span>
                    <span className="activity-body">
                      <span className="activity-top">
                        <span className="activity-muse">{muse?.name ?? item.recipient.slice(0, 8)}</span>
                        <span className="activity-mode">{item.message.action}</span>
                        <span className="activity-time">{fmtTime(item.message.created_at, lang)}</span>
                      </span>
                      <span className="activity-prompt">{promptText}</span>
                      {replySnippet && (
                        <span className={`activity-reply${st === "failed" ? " err" : ""}`}>
                          {replySnippet}
                        </span>
                      )}
                    </span>
                    <span className="activity-right">
                      <Chip state={st} />
                      <ChevronRightIcon size={14} className="activity-arrow" />
                    </span>
                  </button>
                );
              })}

              {/* infinite-scroll sentinel: fetch the next page when it scrolls
               * into view; hidden once the feed is exhausted */}
              {hasMore && (
                <div className="activity-sentinel" ref={sentinelRef}>
                  {loadingMore ? t("ov.loadingMore") : ""}
                </div>
              )}
              {!hasMore && accumulatedItems.length > 0 && (
                <div className="activity-sentinel is-end">{t("ov.feedEnd")}</div>
              )}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
