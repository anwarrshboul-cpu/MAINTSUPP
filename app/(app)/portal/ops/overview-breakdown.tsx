"use client";

/**
 * SECTION D — Job breakdown. §5 of the dashboard master prompt.
 *
 * Four dimensions of one cohort — Tier level, Engineer required, Priority,
 * Label — and one deletion. §5.2 removes the Status block outright: "the At a
 * glance meters now own status with a mapping the user controls, and two
 * different groupings of one field on one page is a contradiction a client will
 * notice". The per-status detail did not vanish with it; it moved to a place
 * where the reader also controls the grouping, and the "View all statuses →"
 * action in this card's header is the door to it.
 *
 * ── THREE DEFECTS THIS CARD IS THE FIX FOR ────────────────────────────────
 *
 * 1. §5.1 — the header read "226 jobs in this period" while the sidebar read
 *    776, with nothing to explain the gap. `CohortHeader` now names the cohort,
 *    changes its VERB with the Measure-by axis, and carries the active filters
 *    as removable chips, so the number and the reason for the number are one
 *    glance apart.
 *
 * 2. §7 defect 3 — the Engineer donut printed the COHORT total in its centre
 *    (226) while its own caption said "193 of 226 recorded". The centre is now
 *    `dimension.recorded`, decided once inside `BreakdownSection`, so no card
 *    can get it wrong again and this one could not get it wrong if it tried.
 *
 * 3. §5.3 — "+8 more" read as truncation rather than as a control. It is
 *    "Show all 16 →", expanding in place, and that too lives in
 *    `BreakdownSection` rather than here.
 *
 * ── WHAT THIS FILE ACTUALLY OWNS ──────────────────────────────────────────
 *
 * Almost nothing about how a chart is drawn — a donut, a ranked list, a
 * segmented bar and a coverage sentence are all shared code, and duplicating
 * any of them per card is the diagnosis the master prompt opens with. What is
 * genuinely this card's are the four derivations §5.3 asks for and no aggregate
 * can be relied on to have computed:
 *
 *   · the full 1–4 TIER SCALE, including tiers with no jobs. An absent tier is
 *     a finding — "nobody is setting Tier 4" — and a chart that only draws the
 *     values it received cannot show it;
 *   · the tier UNDERUSE notice at ≥90% in one tier;
 *   · the label TAXONOMY warning above 25% unclassified, with the link to the
 *     Other jobs that makes it actionable;
 *   · the priority sentence.
 *
 * Every one of them prefers the payload's own sentence when it carries one
 * (`dimension.warning`, `dimension.note`) and derives it only when it does not.
 * Numbers are never hard-coded on either path — §5.3's worked examples are
 * examples, and the day the estate changes is the day a hard-coded "195 of 195"
 * becomes a lie on screen.
 *
 * ── THE STYLESHEET IS LINKED BY THE PAGE ──────────────────────────────────
 *
 * `overview-portfolio.css` carries this card's rules and the Sites card's.
 * Like `overview-glance.css`, it is linked once by `overview-page.tsx` rather
 * than by each card, so the page's stylesheet order stays decided in one place:
 * tokens, then the shared operations sheet, then the page's own.
 */

import {
  BreakdownSection,
  ChartFrame,
  CohortHeader,
} from "./overview-shared";
import { SegmentedBar, sharesExcludingNotRecorded, type ChartSegment } from "./overview-charts";
import { EmptyState, SkeletonRow } from "./ops-primitives";
import {
  NOT_RECORDED_INK,
  OVERVIEW_PRIORITY_COLOUR,
  coverageSentence,
  excludedWording,
  sharesOfRecorded,
  tealScale,
} from "../../../lib/overview-meters";
import type {
  BreakdownBucket,
  BreakdownDimension,
  BreakdownPayload,
  CohortMeasure,
} from "./overview-contract";

type QueryState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
};

type FilterChip = { key: string; label: string; onRemove?: () => void };

const TITLE_ID = "ovw-breakdown-title";

/* ── The derivations §5.3 asks for ────────────────────────────────────────── */

/**
 * THE FULL 1–4 SCALE, INCLUDING THE TIERS NOBODY USES — §5.3.
 *
 * "Build for the full 1–4 scale, not the single value in use today … tiers with
 * zero jobs still appear in the legend at zero so the absence is visible."
 *
 * An aggregate returns the values it found, which is correct behaviour for an
 * aggregate and useless here: a client whose whole estate sits on Tier 2 needs
 * to SEE that Tiers 1, 3 and 4 are empty, and a legend that silently omits them
 * says instead that they do not exist. So the scale is completed on the client,
 * where the scale is known.
 *
 * Matching is on the bucket KEY — the tier id — and never on the label, per
 * §1.5: "All joins on ids, never on display text." A bucket whose key is not
 * one of the four is kept exactly as it arrived rather than being dropped,
 * because §9.9 requires a tier added later to appear with no code change.
 *
 * A synthesised tier takes the palest UNUSED step of the teal scale. Its value
 * is zero so it is never painted — `Donut` drops zero-sweep wedges — but it does
 * take a swatch in the legend, and a swatch already spent on a tier holding 63
 * jobs would read as that tier repeated.
 */
const TIER_SCALE = ["1", "2", "3", "4"] as const;

export function withFullTierScale(dimension: BreakdownDimension): BreakdownDimension {
  const byKey = new Map(dimension.buckets.map((bucket) => [bucket.key, bucket]));
  const used = new Set(dimension.buckets.map((bucket) => bucket.colour));
  const scale: BreakdownBucket[] = [];
  for (const key of TIER_SCALE) {
    const found = byKey.get(key);
    if (found) {
      scale.push(found);
      continue;
    }
    let colour = tealScale(6);
    for (let step = 6; step >= 0; step -= 1) {
      if (!used.has(tealScale(step))) {
        colour = tealScale(step);
        break;
      }
    }
    used.add(colour);
    scale.push({
      key,
      label: `Tier ${key}`,
      value: 0,
      share: 0,
      colour,
      notRecorded: false,
    });
  }
  const unknown = dimension.buckets.filter(
    (bucket) =>
      !bucket.notRecorded && !(TIER_SCALE as readonly string[]).includes(bucket.key),
  );
  const missing = dimension.buckets.filter((bucket) => bucket.notRecorded);
  return { ...dimension, buckets: [...scale, ...unknown, ...missing] };
}

/**
 * "195 of 195 recorded jobs are Tier 2." — §5.3's underuse notice, at ≥90%.
 *
 * The payload's own sentence wins when it has one; this is the fallback, and it
 * computes both numbers rather than carrying them. The threshold is on the
 * RECORDED denominator, not the cohort, for the same reason every other
 * percentage on this page is (§1.4): a field that is 40% blank would otherwise
 * never trip the notice however concentrated the values it does hold.
 */
export function tierUnderuseWarning(dimension: BreakdownDimension): string | null {
  if (dimension.warning) return dimension.warning;
  const recorded = dimension.buckets.filter((bucket) => !bucket.notRecorded);
  if (dimension.recorded <= 0 || recorded.length === 0) return null;
  let largest = recorded[0];
  for (const bucket of recorded) {
    if (bucket.value > largest.value) largest = bucket;
  }
  if (largest.value <= 0 || largest.value / dimension.recorded < 0.9) return null;
  return (
    `${largest.value} of ${dimension.recorded} recorded jobs are ${largest.label}. ` +
    "Tier is not currently differentiating work — set tiers on new jobs to make this breakdown useful."
  );
}

/**
 * THE MOST IMPORTANT SENTENCE ON THE CARD — §5.3's taxonomy warning.
 *
 * It fires when Other plus Not recorded is more than a quarter of the cohort,
 * and the brief is blunt about why it outranks the chart it sits under: "'Other'
 * is currently the largest bar on the page, which means the chart's headline
 * finding is that the taxonomy is not working."
 *
 * The denominator here is the COHORT, not recorded — unlike the tier notice —
 * because the unlabelled jobs are half of what the sentence is counting, and a
 * share of recorded would exclude exactly the thing being reported.
 *
 * "Other" is found by key. In this schema a label's id IS its text, so that is
 * the same string either way; the id is used because it is the id, and if the
 * schema grows a real label table tomorrow this keeps working.
 */
export function taxonomyWarning(dimension: BreakdownDimension): string | null {
  if (dimension.warning) return dimension.warning;
  if (dimension.total <= 0) return null;
  const other = dimension.buckets.find(
    (bucket) => !bucket.notRecorded && bucket.key.trim().toLowerCase() === "other",
  );
  const labelledOther = other?.value ?? 0;
  const unlabelled = Math.max(0, dimension.total - dimension.recorded);
  const share = Math.round(((labelledOther + unlabelled) / dimension.total) * 100);
  if (share <= 25) return null;
  const opening =
    labelledOther > 0
      ? `${labelledOther} jobs are labelled Other and ${unlabelled} have no label`
      : `${unlabelled} jobs have no label`;
  return (
    `${opening} — ${share}% of this period's work is not classified. ` +
    "Consider adding labels for the recurring faults inside Other."
  );
}

/**
 * "Urgent is 38% of recorded work this period — 12 points above the previous
 * period." — §5.3's one derived line under the priority bar.
 *
 * The comparison half is only printed when the payload supplies it. Nothing on
 * `BreakdownPayload` carries the previous period's priority mix, so this cannot
 * derive it, and §1.5 forbids the alternative: "Never impute, estimate or
 * extrapolate a missing value anywhere." A sentence that stops after the share
 * is a smaller loss than one that invents the delta.
 */
export function priorityLine(dimension: BreakdownDimension): string {
  if (dimension.note) return dimension.note;
  if (dimension.recorded <= 0) return "No priority is recorded on any job in this period.";
  const recorded = dimension.buckets.filter((bucket) => !bucket.notRecorded);
  const shares = sharesOfRecorded(recorded.map((bucket) => bucket.value));
  const at = recorded.findIndex((bucket) => bucket.key === "urgent");
  if (at < 0) return `${dimension.recorded} of ${dimension.total} jobs carry a priority.`;
  return `Urgent is ${shares[at]}% of recorded work this period.`;
}

/**
 * The key the aggregate used for its grey bucket, or null when it did not send
 * one. It is read off the payload rather than written here so the sentinel
 * lives in exactly one place — importing `NOT_RECORDED_KEY` from
 * `dashboard-filters.ts` would drag drizzle into the browser bundle, which is
 * the reason `overview-contract.ts` carries no runtime code either.
 */
function notRecordedKey(dimension: BreakdownDimension): string | null {
  return dimension.buckets.find((bucket) => bucket.notRecorded)?.key ?? null;
}

/* ── Priority, which is a bar rather than a ring ──────────────────────────── */

/**
 * §5.3 NAMES A SEGMENTED BAR FOR PRIORITY, AND `BreakdownSection` CANNOT DRAW ONE.
 *
 * Its `forceShape` is `donut | bars`, so this is the one dimension that cannot
 * go through it whole. What it does NOT do is re-implement anything: the
 * header sentence is `coverageSentence`, the three states and the text
 * alternative are `ChartFrame`, the bar is `SegmentedBar`, the shares are
 * `sharesExcludingNotRecorded`, and the markup carries the same `.ovw-breakdown`
 * classes so it is the same object on screen. If `BreakdownSection` ever grows
 * a `forceShape: "segmented"`, this wrapper deletes and the props move across
 * unchanged.
 *
 * The colours are the SEVERITY ramp, not the teal one — §5.3, and §1.3's rule
 * that the severity ramp is "used only where a value is being judged good or
 * bad". An urgent job is a judgement; a label is not.
 */
function PrioritySection({
  dimension,
  splitByPriority,
  onToggleSplit,
  onSelect,
  onFix,
}: {
  dimension: BreakdownDimension;
  splitByPriority: boolean;
  onToggleSplit: () => void;
  onSelect: (bucketKey: string) => void;
  onFix?: () => void;
}) {
  const segments: ChartSegment[] = dimension.buckets.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    value: bucket.value,
    colour: bucket.notRecorded
      ? NOT_RECORDED_INK
      : (OVERVIEW_PRIORITY_COLOUR[bucket.key] ?? bucket.colour),
    notRecorded: bucket.notRecorded,
  }));
  const shares = sharesExcludingNotRecorded(
    dimension.buckets.map((bucket) => bucket.value),
    dimension.buckets.map((bucket) => bucket.notRecorded),
  );
  const missing = Math.max(0, dimension.total - dimension.recorded);
  const greyKey = notRecordedKey(dimension);

  return (
    <section className="ovw-breakdown ovp-priority">
      <div className="ovw-breakdown__head">
        <h3 className="ovw-breakdown__title">
          {coverageSentence(dimension.label, dimension.recorded, dimension.total)}
        </h3>
        <button
          type="button"
          className="ovw-breakdown__split ovp-touch"
          aria-pressed={splitByPriority}
          onClick={onToggleSplit}
        >
          Split by priority
        </button>
      </div>

      <ChartFrame
        table={{
          caption: coverageSentence(dimension.label, dimension.recorded, dimension.total),
          head: ["Priority", "Jobs", "Share of recorded"],
          rows: dimension.buckets.map((bucket, index) => [
            bucket.label,
            bucket.value,
            shares[index] === null ? "not a recorded value" : `${shares[index]}%`,
          ]),
        }}
        empty={dimension.total === 0}
        emptyLabel="No priority to break down in this period."
        minHeight={140}
      >
        <SegmentedBar
          segments={segments}
          total={dimension.total}
          label="Jobs by priority"
          onSelect={onSelect}
        />
      </ChartFrame>

      {/*
        The grey count, with no percentage beside it and a way to act on it —
        §1.5, and the same shape `BreakdownSection` draws for the other three so
        the reader meets one pattern rather than two.
      */}
      {missing > 0 ? (
        <p className="ovw-breakdown__not-recorded">
          <span
            className="ovw-breakdown__swatch"
            style={{ background: NOT_RECORDED_INK }}
            aria-hidden="true"
          />
          <span className="ovw-breakdown__grey-count">Not recorded — {missing} jobs</span>
          {onFix && greyKey ? (
            <button type="button" className="ovw-breakdown__fix ovp-touch" onClick={onFix}>
              Fix these →
            </button>
          ) : null}
        </p>
      ) : null}

      <p className="ovw-breakdown__note">{priorityLine(dimension)}</p>
      {splitByPriority ? (
        <p className="ovw-breakdown__note">
          This breakdown is priority, so splitting it by priority leaves it unchanged.
        </p>
      ) : null}
    </section>
  );
}

/* ── The card ─────────────────────────────────────────────────────────────── */

export function JobBreakdownCard({
  state,
  measure,
  filterChips,
  splitByPriority,
  onToggleSplit,
  onToggle,
  onDrill,
  onOpenRecords,
}: {
  state: QueryState<BreakdownPayload>;
  measure: CohortMeasure;
  filterChips: FilterChip[];
  splitByPriority: boolean;
  onToggleSplit: () => void;
  onToggle: (key: string, value: string) => void;
  onDrill: (extra: Record<string, string>) => void;
  onOpenRecords: (query: string) => void;
}) {
  const data = state.data;

  /*
   * LOADING, ERROR AND EMPTY ARE THREE PICTURES — §1.5 and §9.10.
   *
   * The title is drawn in all three so the reader knows which card is speaking,
   * but the COHORT LINE is not: `CohortHeader` would print "0 jobs requested in
   * this period" beside a failure, and "a failure must never look like a zero"
   * is the one rule this page exists to keep.
   */
  if (state.error) {
    return (
      <section className="ops-card ovp-card" id="ops-jobs" aria-labelledby={TITLE_ID}>
        <h2 className="ovw-cohort__title" id={TITLE_ID}>
          Job breakdown
        </h2>
        <p className="ops-error" role="alert">
          {state.error}{" "}
          <button type="button" className="ops-link ovp-touch" onClick={state.reload}>
            Retry
          </button>
        </p>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="ops-card ovp-card" id="ops-jobs" aria-labelledby={TITLE_ID}>
        <h2 className="ovw-cohort__title" id={TITLE_ID}>
          Job breakdown
        </h2>
        {state.loading ? (
          <SkeletonRow lines={6} height={280} />
        ) : (
          <EmptyState>No job breakdown has been loaded for this period.</EmptyState>
        )}
      </section>
    );
  }

  const dimensions = data.dimensions;
  const tier = withFullTierScale(dimensions.tier);
  const engineer = dimensions.engineer;
  const priority = dimensions.priority;
  const label = dimensions.label;
  const otherKey = label.buckets.find(
    (bucket) => !bucket.notRecorded && bucket.key.trim().toLowerCase() === "other",
  )?.key;
  const taxonomy = taxonomyWarning(label);

  /*
   * "Fix these →" only exists where there is a grey bucket to fix. The key is
   * the aggregate's own sentinel, so the drill lands on the same rows the count
   * came from — §1.5's requirement that every Fix link actually works.
   */
  const fixTier = notRecordedKey(tier);
  const fixEngineer = notRecordedKey(engineer);
  const fixPriority = notRecordedKey(priority);
  const fixLabel = notRecordedKey(label);

  /*
   * A DONUT CANNOT STACK, SO SPLIT-BY-PRIORITY CHANGES THE SHAPE.
   *
   * §5.3 asks for the toggle on all four dimensions and gate 30 asks that "the
   * stacks reconcile with unsplit totals". Tier and Engineer are rings by
   * default (§1.10: five categories or fewer), and there is no honest way to
   * draw a second dimension inside a ring. Ranked bars carry the stacks and the
   * same numbers, and `byPriority` sums to each bucket's own `value` on the
   * wire, so the reconciliation is arithmetic rather than a redraw.
   */
  const shape = splitByPriority ? ("bars" as const) : ("donut" as const);

  return (
    <section className="ops-card ovp-card" id="ops-jobs" aria-labelledby={TITLE_ID}>
      <CohortHeader
        id={TITLE_ID}
        title="Job breakdown"
        total={data.total}
        measure={measure}
        filterChips={filterChips}
        action={
          /*
           * §5.2 deleted the Status block; this is where its detail went. The
           * Jobs list grouped by status is the same grouping At a glance's
           * "View all statuses →" opens, and it is deliberately the same
           * parameter so the two cannot drift apart.
           */
          <button
            type="button"
            className="ops-link ovp-touch"
            onClick={() => onDrill({ group: "status" })}
          >
            View all statuses →
          </button>
        }
      />

      {/* §1.1's footnote — the rows the cohort axis cannot see. Never imputed. */}
      {data.excluded > 0 ? (
        <p className="ovp-excluded" role="note">
          {excludedWording(measure, data.excluded)}{" "}
          <button
            type="button"
            className="ops-link ovp-touch"
            onClick={() => onOpenRecords("missing_measure_date")}
          >
            View these records →
          </button>
        </p>
      ) : null}

      {data.total === 0 ? (
        <EmptyState>
          No jobs {measure === "completed" ? "completed" : "requested"} in this period. Widen the
          period or clear a filter to see more.
        </EmptyState>
      ) : (
        <div className="ovp-dimensions">
          <BreakdownSection
            dimension={{ ...tier, warning: tierUnderuseWarning(tier) }}
            splitByPriority={splitByPriority}
            onToggleSplit={onToggleSplit}
            onSelect={(key) => onToggle("tier", key)}
            onDrill={(key) => onDrill({ tier: key })}
            onFix={fixTier ? () => onDrill({ tier: fixTier }) : undefined}
            forceShape={shape}
          />

          {/*
            §7 defect 3 lives or dies here. The centre figure is
            `dimension.recorded` inside `BreakdownSection` — 193, beside a
            caption reading "193 of 226 recorded" — and this card cannot
            override it, which is the point of putting it there.
          */}
          <BreakdownSection
            dimension={engineer}
            splitByPriority={splitByPriority}
            onToggleSplit={onToggleSplit}
            onSelect={(key) => onToggle("engineer", key)}
            onDrill={(key) => onDrill({ engineer: key })}
            onFix={fixEngineer ? () => onDrill({ engineer: fixEngineer }) : undefined}
            forceShape={shape}
          />

          <PrioritySection
            dimension={priority}
            splitByPriority={splitByPriority}
            onToggleSplit={onToggleSplit}
            onSelect={(key) => onToggle("priority", key)}
            onFix={fixPriority ? () => onDrill({ priority: fixPriority }) : undefined}
          />

          {/*
            The warning is lifted OUT of the dimension and drawn here so it can
            carry the link §5.3 asks for — "linking to the Other jobs so new
            labels can be created from the pattern". `BreakdownSection` renders
            `dimension.warning` as prose; a sentence nobody can act on is the
            state this whole card is trying to leave.
          */}
          <BreakdownSection
            dimension={{ ...label, warning: null }}
            splitByPriority={splitByPriority}
            onToggleSplit={onToggleSplit}
            onSelect={(key) => onToggle("label", key)}
            onDrill={(key) => onDrill({ label: key })}
            onFix={fixLabel ? () => onDrill({ label: fixLabel }) : undefined}
            forceShape="bars"
            initialLimit={8}
          />
          {taxonomy ? (
            <p className="ovw-breakdown__warning ovp-notice" role="note">
              {taxonomy}
              {otherKey ? (
                <button
                  type="button"
                  className="ops-link ovp-touch"
                  onClick={() => onDrill({ label: otherKey })}
                >
                  View the Other jobs →
                </button>
              ) : null}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
