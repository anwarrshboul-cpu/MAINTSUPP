"use client";

/**
 * SECTION C — PERFORMANCE OVER TIME. §4 of the master prompt.
 *
 * ── §4.1 COMES FIRST: THE CARD USED TO SHOW ONLY A FAILURE ────────────────
 *
 * The card this replaces rendered "The dashboard is temporarily unavailable."
 * with a Retry, every time, on every range. §4.1 asks for the root cause before
 * the rebuild and then for a card that "degrades properly: a query failure
 * shows the error with Retry, an empty result shows a labelled empty state,
 * and the two never look alike".
 *
 * That is the rule this file is built around, and it is structural rather than
 * a habit: every chart on the card goes through `ChartFrame`, which owns three
 * visibly different appearances and cannot render two of them at once —
 *
 *   loading → a skeleton at the chart's finished height;
 *   error   → the server's OWN sentence, `role="alert"`, with a Retry that
 *             calls `state.reload()`. Never a zero, never an empty axis;
 *   empty   → a labelled sentence naming what is empty and why.
 *
 * A card that draws an empty chart when a query failed has told the reader that
 * the team completed no work. That is the failure mode §4.1 is about, and it is
 * worse than the crash it replaced.
 *
 * ── WHAT IS NEVER DRAWN HERE ──────────────────────────────────────────────
 *
 * · THE MEAN. §4.3: median and p90 only. One 200-day job distorts every mean
 *   bucket it lands in, and the mean of a long-tailed distribution is a number
 *   that describes no job anybody worked on.
 *
 * · A MEDIAN OF ONE OR TWO JOBS. §4.3 renders those buckets as a GAP with a
 *   dotted connector. `TimeSeries` takes `null` values and a `minSample` for
 *   exactly this; both are used, so a bucket under the floor is null on the way
 *   in AND undrawable on the way through.
 *
 * · A PERCENTAGE FOR AN UNMEASURED STAGE. §4.4: "A stage with no timestamp
 *   shows 'Not measured — no timestamp recorded', never 0% or 100%." A zero
 *   column and an unmeasured stage look identical once drawn, and one of them
 *   says the team missed every target it was ever set. Unmeasurable stages are
 *   filtered out of the chart entirely and named in a list beneath it, each
 *   carrying the server's own reason.
 *
 * · "WEEK 1". §4.2 — axis labels are the payload's real dates, and the
 *   bucketing is the payload's too. Neither is decided in the browser.
 */

import { useState } from "react";
import analysisCss from "./overview-analysis.css?url";
import { SkeletonRow, plural } from "./ops-primitives";
import { ChartFrame, CohortHeader, MetricTile, formatCount } from "./overview-shared";
import { GroupedColumns, TimeSeries } from "./overview-charts";
import type { PerformancePayload, SlaStage } from "./overview-contract";
import {
  NOT_RECORDED_INK,
  OVERVIEW_PRIORITY_COLOUR,
  coverageSentence,
  tealScale,
} from "../../../lib/overview-meters";

/** §4.3 — a median of fewer than three jobs is noise drawn as a trend. */
export const MIN_SAMPLE = 3;

const PERFORMANCE_SUBTITLE =
  "How long work takes and how often it meets its target. Completed jobs only — a job still open " +
  "has no time to close, and imputing one would invent the number.";

/**
 * §4.3's split, in the order priority is always drawn in, most severe first.
 *
 * The labels are local rather than imported from `job-metrics.ts` because that
 * module's `PRIORITY_BANDS` carries its own colours, and §1.3 retires those
 * from this page. Importing the bands to borrow four words would put the
 * retired palette one autocomplete away from the chart.
 */
const PRIORITY_ORDER = ["urgent", "medium", "low", "not_recorded"] as const;

const PRIORITY_LABEL: Record<string, string> = {
  urgent: "Urgent",
  medium: "Medium",
  low: "Low",
  not_recorded: "Not recorded",
};

/* ── Pure helpers, exported because they are the part worth testing ───────── */

/**
 * A target in minutes, as a person would say it — §4.4 prints the configured
 * targets so a reader can see what they are being measured against, and
 * "targetMinutes: 480" is not a thing anybody is measured against.
 */
export function targetWording(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "immediately";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  if (minutes < 1440) {
    const hours = minutes / 60;
    const text = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
    return `${text} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = minutes / 1440;
  const text = Number.isInteger(days) ? String(days) : days.toFixed(1);
  return `${text} ${days === 1 ? "day" : "days"}`;
}

/**
 * The change against the previous equal period, in POINTS.
 *
 * A percentage that moved from 40 to 45 went up five POINTS, not five percent,
 * and the two differ by an order of magnitude on a small base. `null` when
 * there is nothing to compare — §1.5, not a zero.
 */
export function pointsChange(current: number | null, previous: number | null): string | null {
  if (current === null || previous === null) return null;
  const change = Math.round(current - previous);
  if (change === 0) return `level with the previous period (${previous}%)`;
  const direction = change > 0 ? "up" : "down";
  return `${direction} ${Math.abs(change)} ${
    Math.abs(change) === 1 ? "point" : "points"
  } on the previous period (${previous}%)`;
}

/**
 * §4.3 — the value a bucket contributes to a line.
 *
 * Below the sample floor it is `null` and NOT the median that was computed
 * from one job. `TimeSeries` would also refuse to draw it, because `minSample`
 * is passed as well; both guards are here because the split-by-priority series
 * carry their own per-priority samples, which the bucket-level floor cannot
 * see.
 */
export function sampledValue(value: number | null, sample: number): number | null {
  return sample >= MIN_SAMPLE ? value : null;
}

/* ── The card ─────────────────────────────────────────────────────────────── */

export function PerformanceCard({
  state,
  measure: requestedMeasure,
  filterChips,
  onToggle,
  onDrill,
  onSelectWindow,
  splitByPriority: splitRequested,
  onToggleSplit,
}: {
  state: {
    data: PerformancePayload | null;
    loading: boolean;
    error: string | null;
    reload: () => void;
  };
  measure: "requested" | "completed";
  filterChips: Array<{ key: string; label: string; onRemove?: () => void }>;
  /** Cross-filters the whole page — used by the priority legend. */
  onToggle: (key: string, value: string) => void;
  /** Through to the Jobs list, carrying the page's own range and filters. */
  onDrill: (extra: Record<string, string>) => void;
  /** Narrows the page's date range to one bucket. */
  onSelectWindow: (from: string, toInclusive: string) => void;
  splitByPriority: boolean;
  onToggleSplit: () => void;
}) {
  /*
   * The tab is local state rather than URL state deliberately. Every aggregate
   * on this page is keyed by the query string, so a tab in the address bar
   * would refetch six endpoints to redraw a chart whose data is already here.
   * `splitByPriority` is a prop for the opposite reason: it changes what the
   * SERVER computes, so it belongs in the URL and the page owns it.
   */
  const [tab, setTab] = useState<"close" | "sla">("close");
  const data = state.data;
  const loading = !data && !state.error;

  /*
   * BOTH OF THESE STATE WHAT THE SERVER DID, NOT WHAT THE PAGE ASKED FOR.
   *
   * `/api/dashboard/performance` reads the cohort axis and the split out of the
   * QUERY STRING and nowhere else, while the page resolves each by layering a
   * stored per-user preference over the URL. They agree whenever the URL
   * carries the parameter and disagree whenever it does not — so a reader whose
   * saved axis is `completed`, opening a bare `/dashboard`, read "N jobs
   * completed in this period" above a cohort the server had cut on
   * `requested_at`, and a saved split of `on` lit this card's toggle over
   * buckets the server had never been asked to split.
   *
   * The payload states both facts about itself, so both come from it. The props
   * arrive RENAMED — `requestedMeasure`, `splitRequested` — and the canonical
   * names below are what was APPLIED; the intents are still read, for the single
   * render before a payload exists, which is a render in which this card states
   * neither — see the header below.
   */
  const measure = data?.measure ?? requestedMeasure;
  const splitByPriority = data?.timeToClose.splitByPriority ?? splitRequested;

  /*
   * §1.1 — the header states the cohort it is counting. `PerformancePayload`
   * carries no `cohortTotal` of its own, so it is read from the SLA coverage
   * denominator, which is the cohort by construction. See the report: a
   * `cohortTotal` on the wire would make this a field read rather than a
   * derivation.
   */
  const cohortTotal = data ? Math.max(0, ...data.sla.stages.map((stage) => stage.coverage.total)) : 0;

  const tabs = (
    <div className="ova-tabs" role="tablist" aria-label="Performance view">
      <button
        type="button"
        role="tab"
        id="ova-tab-close"
        className="ova-switch__button"
        aria-selected={tab === "close"}
        aria-controls="ova-panel-close"
        onClick={() => setTab("close")}
      >
        Time to close
      </button>
      <button
        type="button"
        role="tab"
        id="ova-tab-sla"
        className="ova-switch__button"
        aria-selected={tab === "sla"}
        aria-controls="ova-panel-sla"
        onClick={() => setTab("sla")}
      >
        SLA trend
      </button>
    </div>
  );

  /*
   * NO COHORT SENTENCE UNTIL THERE IS A COHORT.
   *
   * `CohortHeader` cannot draw a title without also drawing `cohortWording`,
   * and before the payload lands both of its arguments are unknown: the total
   * is a placeholder zero and the axis is the page's INTENT rather than
   * anything the server has confirmed. "0 jobs requested in this period" over a
   * request that is still in flight states two things nobody measured, and the
   * verb is the defect this card was corrected for. So the wait draws the title
   * and the tabs alone — the shape `JobBreakdownCard` and `SitesAttentionCard`
   * already take, and for the reason they give: a wait must not look like a
   * zero.
   *
   * `ovw-performance-title` is also the id the page's jump bar scrolls to, and
   * until now NO element carried it, so `getElementById` returned null and the
   * "Performance" button silently did nothing. It is on both shapes, because a
   * jump target that only exists once a payload lands is a control that works
   * intermittently.
   */
  const header = data ? (
    <CohortHeader
      id="ovw-performance-title"
      title="Performance over time"
      total={cohortTotal}
      measure={measure}
      filterChips={filterChips}
      subtitle={PERFORMANCE_SUBTITLE}
      action={tabs}
    />
  ) : (
    <header className="ovw-cohort" id="ovw-performance-title">
      <div className="ovw-cohort__titles">
        <h2 className="ovw-cohort__title">Performance over time</h2>
        <p className="ovw-cohort__subtitle">{PERFORMANCE_SUBTITLE}</p>
      </div>
      <div className="ovw-cohort__action">{tabs}</div>
    </header>
  );

  if (!data) {
    return (
      <section className="ops-card" id="ops-performance">
        <link rel="stylesheet" href={analysisCss} precedence="default" />
        {header}
        {/*
          §4.1 — the failure and the wait are two different pictures, and
          neither is an empty chart. `ChartFrame` draws whichever applies and
          reserves the finished height in both, so nothing shifts when the
          payload lands.
        */}
        <ChartFrame
          loading={loading}
          error={state.error}
          onRetry={state.reload}
          minHeight={260}
        >
          <SkeletonRow lines={4} height={260} />
        </ChartFrame>
      </section>
    );
  }

  const close = data.timeToClose;
  const buckets = close.buckets;

  /* ── Tab 1 — Time to close (§4.3) ─────────────────────────────────────── */

  /*
   * The payload decides whether a split is available: the server only computes
   * `byPriority` when it was asked to. When the toggle is on and the buckets
   * carry nothing, the blended lines stay and a sentence says why, rather than
   * an empty chart that reads as "no work was completed".
   */
  const splitAvailable = buckets.some((bucket) => bucket.byPriority !== null);
  const split = splitByPriority && splitAvailable;

  const priorityKeys = split
    ? PRIORITY_ORDER.filter((key) =>
        buckets.some((bucket) => bucket.byPriority?.[key] !== undefined),
      )
    : [];

  const closeLines = split
    ? priorityKeys.map((key) => ({
        key,
        label: PRIORITY_LABEL[key] ?? key,
        colour: OVERVIEW_PRIORITY_COLOUR[key] ?? NOT_RECORDED_INK,
        values: buckets.map((bucket) => {
          const row = bucket.byPriority?.[key];
          return row ? sampledValue(row.medianDays, row.sample) : null;
        }),
      }))
    : [
        {
          key: "median",
          label: "Median days to close",
          colour: tealScale(1),
          values: buckets.map((bucket) => sampledValue(bucket.medianDays, bucket.sample)),
        },
        {
          /* §4.3's second, lighter line, so the tail is visible. Never the mean. */
          key: "p90",
          label: "p90 days to close",
          colour: tealScale(5),
          dashed: true,
          values: buckets.map((bucket) => sampledValue(bucket.p90Days, bucket.sample)),
        },
      ];

  const closeEmpty = closeLines.every((line) => line.values.every((value) => value === null));

  /*
   * WHICH KIND OF NULL THE HEADLINE IS — §4.3's floor, said out loud.
   *
   * The aggregate applies the same "fewer than three completed jobs is noise
   * drawn as a trend" floor to the headline median and p90 that it applies to
   * every bucket, so both come back null on a window that closed one or two
   * jobs. An em dash on its own cannot distinguish that from a period in which
   * nothing closed at all, and the two are different facts about coverage: one
   * says the team completed no work, the other says the figure existed but was
   * computed from a sample too small to describe anything. `sample` is the
   * count the floor was applied to, so it is what tells the reader which.
   */
  const closeSampleNote =
    close.sample >= MIN_SAMPLE
      ? null
      : close.sample === 0
        ? "No job was completed in this period, so there is nothing to average."
        : `${plural(close.sample, "completed job")} — too few to average.`;

  /*
   * And the same question one period back. A tile whose trend arrow is missing
   * while its figure is present looks like a comparison that failed; it is
   * usually the floor again, applied to the previous window. `previousSample`
   * is the only thing on the wire that can say so.
   */
  const closeTrendNote =
    close.sample >= MIN_SAMPLE && close.previousSample < MIN_SAMPLE
      ? `The previous period closed ${plural(close.previousSample, "job")}, too few to compare against.`
      : null;

  const timeToClosePanel = (
    <div className="ova-section" role="tabpanel" id="ova-panel-close" aria-labelledby="ova-tab-close">
      <div className="ova-section__head">
        <h3 className="ova-section__title">Time to close</h3>
        <p className="ova-section__meta">
          {data.period.label} · {data.bucketing} buckets · median and p90, never the mean
        </p>
      </div>

      <div className="ova-actions">
        <button
          type="button"
          className="ova-switch__button"
          aria-pressed={splitByPriority}
          onClick={onToggleSplit}
        >
          Split by priority
        </button>
      </div>

      <ChartFrame
        empty={closeEmpty}
        emptyLabel={
          `No bucket in this range has ${MIN_SAMPLE} or more completed jobs, so no trend can be ` +
          "drawn. The figures beneath are computed across the whole range."
        }
        minHeight={260}
        table={{
          caption: `Time to close by ${data.bucketing} bucket — median and p90 days`,
          head: ["Period", "Completed", "Median days", "p90 days"],
          rows: buckets.map((bucket) => [
            bucket.label,
            bucket.sample,
            bucket.sample < MIN_SAMPLE
              ? "Insufficient data"
              : bucket.medianDays === null
                ? "Not measured"
                : bucket.medianDays,
            bucket.sample < MIN_SAMPLE
              ? "Insufficient data"
              : bucket.p90Days === null
                ? "Not measured"
                : bucket.p90Days,
          ]),
        }}
      >
        <TimeSeries
          label="Days from request to completion, by period"
          buckets={buckets.map((bucket) => ({
            label: bucket.label,
            start: bucket.start,
            endInclusive: bucket.endInclusive,
            sample: bucket.sample,
          }))}
          lines={closeLines}
          /*
            §4.3 — the floor is enforced twice on purpose. `sampledValue` nulls
            the point on the way in, and `minSample` stops `TimeSeries` joining
            across it with a solid line; what is left is a gap with a dotted
            connector and a tooltip reading "insufficient data".
          */
          minSample={MIN_SAMPLE}
          formatValue={(value) => `${value} days`}
          onSelectBucket={(bucket) => onSelectWindow(bucket.start, bucket.endInclusive)}
        />
      </ChartFrame>

      {split ? (
        <ul className="ova-actions">
          {priorityKeys.map((key) => (
            <li key={key}>
              <button
                type="button"
                className="ova-switch__button"
                onClick={() => onToggle("priority", key)}
              >
                Filter to {PRIORITY_LABEL[key] ?? key}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {splitByPriority && !splitAvailable ? (
        <p className="ova-note">
          No per-priority figures came back for this range, so the blended median and p90 are
          shown. Nothing has been estimated to fill the split.
        </p>
      ) : null}

      {/* ── Beneath: median, p90 and the change against the previous period ── */}
      <div className="ova-tiles">
        <MetricTile
          label="Median days to close"
          value={close.medianDays}
          accent={tealScale(1)}
          delta={
            close.medianDays === null || close.previousMedianDays === null
              ? null
              : close.medianDays - close.previousMedianDays
          }
          previous={close.previousMedianDays}
          footnote={
            closeSampleNote ??
            "A median, not a mean: one 200-day job would distort every bucket it landed in."
          }
        />
        <MetricTile
          label="p90 days to close"
          value={close.p90Days}
          accent={tealScale(5)}
          delta={
            close.p90Days === null || close.previousP90Days === null
              ? null
              : close.p90Days - close.previousP90Days
          }
          previous={close.previousP90Days}
          footnote={closeSampleNote ?? "Nine completed jobs in ten closed faster than this."}
        />
      </div>

      {/*
        §4.3 — "Completed jobs only; state the exclusion beneath." The number is
        not a footnote in the tooltip sense: on this estate it is usually larger
        than the measured population, and a reader who does not see it will
        read the median as a statement about all work.
      */}
      <p className="ova-note">
        {plural(close.openExcluded, "job")} still open and not included.{" "}
        {closeTrendNote ? `${closeTrendNote} ` : null}
        <button
          type="button"
          className="ops-link"
          /*
           * `open`, not `in_progress`. The status model is completed /
           * in_progress / attention, so a job needing attention is open too;
           * `openExcluded` counts both, and drilling on `in_progress` alone
           * would open a list shorter than the figure the reader just tapped.
           * `family=open` is the drill filter's word for that union.
           */
          onClick={() => onDrill({ family: "open" })}
        >
          View the open work →
        </button>
      </p>
    </div>
  );

  /* ── Tab 2 — SLA trend (§4.4) ─────────────────────────────────────────── */

  const measurable: SlaStage[] = data.sla.stages.filter((stage) => stage.measurable);
  const slaBuckets = measurable[0]?.buckets ?? [];

  const slaPanel = (
    <div className="ova-section" role="tabpanel" id="ova-panel-sla" aria-labelledby="ova-tab-sla">
      <div className="ova-section__head">
        <h3 className="ova-section__title">SLA trend</h3>
        <p className="ova-section__meta">
          {data.period.label} · {data.bucketing} buckets · percentage meeting target at each stage
        </p>
      </div>

      <ChartFrame
        empty={measurable.length === 0}
        emptyLabel={
          "No SLA stage can be measured in this period: none of the four stage timestamps is " +
          "recorded on any job in range. Each stage and its reason is listed beneath."
        }
        minHeight={240}
        table={{
          caption: `Percentage meeting target at each measurable stage, by ${data.bucketing} bucket`,
          head: ["Period", ...measurable.map((stage) => stage.label)],
          rows: slaBuckets.map((bucket, index) => [
            bucket.label,
            ...measurable.map((stage) => {
              const cell = stage.buckets[index];
              return cell === undefined || cell.percent === null
                ? "Not measured"
                : `${cell.percent}% of ${cell.sample}`;
            }),
          ]),
        }}
      >
        <GroupedColumns
          label="Percentage meeting target at each stage"
          suffix="%"
          buckets={slaBuckets.map((bucket) => ({
            label: bucket.label,
            start: bucket.start,
            endInclusive: bucket.endInclusive,
          }))}
          /*
            §4.4 — ONLY measurable stages become series. An unmeasurable stage
            has no column here at all, because a null column and a zero column
            are the same picture and one of them is a lie about the team.
          */
          series={measurable.map((stage, index) => ({
            key: stage.key,
            label: stage.label,
            colour: tealScale(index),
            values: stage.buckets.map((bucket) => bucket.percent),
            samples: stage.buckets.map((bucket) => bucket.sample),
          }))}
          onSelectBucket={(bucket) => onSelectWindow(bucket.start, bucket.endInclusive)}
        />
      </ChartFrame>

      {/*
        EVERY STAGE, MEASURABLE OR NOT — §4.4's "report which stages are
        measurable in this schema", rendered rather than written in a document
        nobody opens. The unmeasurable ones carry the server's own reason and
        no percentage of any kind.
      */}
      <ul className="ova-stages">
        {data.sla.stages.map((stage) => (
          <li
            key={stage.key}
            className={`ova-stage${stage.measurable ? " ova-stage--measurable" : ""}`}
          >
            <span className="ova-stage__name">{stage.label}</span>
            <span className="ova-stage__coverage">
              Coverage: {coverageSentence(
                `${stage.label} timestamps`,
                stage.coverage.measured,
                stage.coverage.total,
              )}
            </span>
            {stage.measurable ? (
              <span className="ova-stage__coverage">
                {stage.percent === null
                  ? "No job in this period could be compared with a target."
                  : `${stage.percent}% of the ${plural(
                      stage.coverage.measured,
                      "measured job",
                    )} met target${
                      pointsChange(stage.percent, stage.previousPercent)
                        ? `, ${pointsChange(stage.percent, stage.previousPercent)}`
                        : ", with no comparable previous period"
                    }.`}
              </span>
            ) : (
              /* §4.4 — the reason, never 0% and never 100%. */
              <span className="ova-stage__reason">
                {stage.reason ?? "Not measured — no timestamp recorded"}
              </span>
            )}
            {stage.measurable && stage.reason ? (
              <span className="ova-stage__reason">{stage.reason}</span>
            ) : null}
          </li>
        ))}
      </ul>

      {/* ── The configured targets — §4.4 ────────────────────────────────── */}
      <div className="ova-section__head">
        <h4 className="ova-section__title">Targets in force</h4>
        <p className="ova-section__meta">
          {plural(data.sla.targets.length, "target")} configured
        </p>
      </div>
      {data.sla.targets.length === 0 ? (
        <p className="ova-note">
          No target is configured, so each job is compared with its own recorded target date.
        </p>
      ) : (
        <ul className="ova-targets">
          {data.sla.targets.map((target) => (
            <li
              className="ova-target"
              key={`${target.stage}-${target.priorityKey}-${target.version}`}
            >
              <b>
                {data.sla.stages.find((stage) => stage.key === target.stage)?.label ?? target.stage}
                {" · "}
                {PRIORITY_LABEL[target.priorityKey] ?? target.priorityKey}
              </b>
              <span>within {targetWording(target.targetMinutes)}</span>
              <span>{target.basis === "business" ? "business hours" : `${target.basis} time`}</span>
              <span>version {target.version}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="ova-note">
        Targets are edited in Settings and are versioned, so changing one changes this chart with
        no deploy and does not rewrite what past jobs were measured against.
      </p>

      {/* ── Beneath: on-time for the range, and the change ───────────────── */}
      <div className="ova-summary">
        <div className="ova-summary__item">
          <span className="ova-summary__label">Met target across this range</span>
          {/*
            A written figure rather than `MetricTile`: the tile formats a delta
            with `deltaText`, which prints "Up 5" for a percentage — five what?
            Points and percent differ by an order of magnitude on a small base,
            so the change is spelled out in the sentence beneath instead.
          */}
          <span
            className={`ova-summary__value${
              data.sla.overallPercent === null ? " ova-summary__value--missing" : ""
            }`}
          >
            {data.sla.overallPercent === null ? "—" : `${data.sla.overallPercent}%`}
          </span>
        </div>
        <div className="ova-summary__item">
          <span className="ova-summary__label">Jobs compared with a target</span>
          <span className="ova-summary__value">
            {formatCount(
              measurable.reduce((sum, stage) => Math.max(sum, stage.coverage.measured), 0),
              false,
            )}
          </span>
        </div>
      </div>
      <p className="ova-note">
        {data.sla.overallPercent === null
          ? "No job in this period can be compared with a target, so there is no on-time percentage. That is missing data, not a score of zero."
          : `${data.sla.overallPercent}% of the jobs that could be compared met their target${
              pointsChange(data.sla.overallPercent, data.sla.previousOverallPercent)
                ? `, ${pointsChange(data.sla.overallPercent, data.sla.previousOverallPercent)}`
                : ", with no comparable previous period"
            }.`}
      </p>
    </div>
  );

  return (
    <section className="ops-card" id="ops-performance">
      <link rel="stylesheet" href={analysisCss} precedence="default" />
      {header}
      {tab === "close" ? timeToClosePanel : slaPanel}
    </section>
  );
}
