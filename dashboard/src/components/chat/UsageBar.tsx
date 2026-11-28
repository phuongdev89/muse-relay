import type { UsageReport } from "../../lib/api";
import { fmtRelativeAge, fmtTime } from "../../lib/format";
import { useLang } from "../../lib/i18n";

// v9 AI usage quota ("hạn mức") display. The muse reports weekly AI-account
// usage in output.notes of a params.command="usage" request (parsed in
// fetchUsageReports). Full variant renders in the Agent Registry muse cards;
// compact variant renders in room headers (MuseRoom / muse_single convo).

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** The backend's additional_tokens_remaining is free-form ("31B", "1B tokens
 * left", "500K remaining"…). Strip the trailing wording so the i18n template
 * owns it once and we never render "...tokens left left". */
function normalizeTokensRemaining(raw: string): string {
  const v = raw.trim();
  if (!v) return v;
  const stripped = v.replace(/\s*(?:tokens?\s+)?(?:left|remaining)$/i, "").trim();
  return stripped || v;
}

/** <70 ok, 70–90 warn, >90 bad (thresholds from the v9 quota spec). */
export function usageTone(usedPercent: number): "ok" | "warn" | "bad" {
  if (usedPercent > 90) return "bad";
  if (usedPercent >= 70) return "warn";
  return "ok";
}

function Track(props: { used: number; tone: "ok" | "warn" | "bad" }) {
  return (
    <span className="usage-bar-track" aria-hidden="true">
      <span
        className={`usage-bar-fill tone-${props.tone}`}
        style={{ width: `${props.used}%` }}
      />
    </span>
  );
}

export function UsageBar(props: {
  report: UsageReport | null | undefined;
  compact?: boolean;
}) {
  const { lang, t } = useLang();
  const { report, compact = false } = props;

  if (!report) {
    if (compact) return null;
    return (
      <div className="usage-bar usage-no-data" role="status">
        {t("usage.noData")}
      </div>
    );
  }

  const used = clampPercent(report.weeklyUsedPercent);
  const remaining = clampPercent(report.weeklyRemainingPercent);
  const tone = usageTone(report.weeklyUsedPercent);

  if (compact) {
    const tooltip = [
      t("usage.title"),
      report.plan || null,
      t("usage.weeklyValue", { used, remaining }),
      report.weeklyResetAt
        ? t("usage.resetAt", { time: fmtTime(report.weeklyResetAt, lang) })
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <span className="usage-bar compact" title={tooltip}>
        <Track used={used} tone={tone} />
        <span className="usage-bar-compact-label">{used}%</span>
      </span>
    );
  }

  return (
    <div className="usage-bar" role="group" aria-label={t("usage.title")}>
      {/* Row 1 — plan badge gets its own row so any badge length can never
          squeeze or wrap the numbers below. */}
      <div className="usage-bar-plan">
        <span className="usage-plan-chip">{report.plan || "—"}</span>
        <span className="usage-bar-label">{t("usage.weeklyLabel")}</span>
      </div>
      {/* Row 2 — meter: fixed % figure, flexing track, fixed "% left" slot. */}
      <div className="usage-meter">
        <span className={`usage-meter-pct tone-${tone}`}>{used}%</span>
        <Track used={used} tone={tone} />
        <span className="usage-meter-remaining">
          {t("usage.remainingValue", { remaining })}
        </span>
      </div>
      {/* Row 3 — detail slots: reset time · additional tokens · checked age. */}
      <div className="usage-meta">
        {report.weeklyResetAt && (
          <span>{t("usage.resetAt", { time: fmtTime(report.weeklyResetAt, lang) })}</span>
        )}
        {report.additionalTokensRemaining.trim() !== "" && (
          <span>
            {t("usage.additional", {
              remaining: normalizeTokensRemaining(report.additionalTokensRemaining),
              used: report.additionalTokensUsedPercent,
            })}
          </span>
        )}
        {report.checkedAt && (
          <span>{t("usage.checkedAgo", { age: fmtRelativeAge(report.checkedAt, lang) })}</span>
        )}
      </div>
    </div>
  );
}
