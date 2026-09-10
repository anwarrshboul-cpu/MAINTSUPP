"use client";

/**
 * THE SHARED PIECES OF THE REBUILT OVERVIEW — §1.10.
 *
 * The master prompt's diagnosis of the old page is that every card grew its own
 * header, its own percentage and its own idea of what "not recorded" looks
 * like, "which is how this dashboard became inconsistent in the first place".
 * These eight exports are the answer: one header, one breakdown, one ageing
 * bar, one tile, one data-quality row, one chart frame, one coverage strip, and
 * one pair of number formatters.
 *
 * ── WHAT IS REUSED, AND WHAT COULD NOT BE ─────────────────────────────────
 *
 * `ops-primitives.tsx` already owns the shapes the four Operations pages share,
 * and this file leans on it rather than restating it:
 *
 *   SegmentedMeter   → SeverityBar, in its no-numbers form
 *   ProgressMeter    → CoverageStrip's bar
 *   SkeletonRow      → ChartFrame's loading state
 *   ErrorState       → ChartFrame's error state
 *   EmptyState       → ChartFrame's empty state
 *   HiddenDataTable  → ChartFrame's text alternative
 *   FilterChip       → CohortHeader's removable chips
 *   money, deltaText → formatMoneyPence, MetricTile's trend wording
 *
 * The one place the primitive genuinely does not fit is `SeverityBar` with
 * `showNumbers`: §6.3 requires the count to be drawn ON the segment, and
 * `SegmentedMeter` is a 10px track with no room for a glyph. Both code paths
 * keep the primitive's two rules — zero-value segments are dropped from the
 * paint and kept in the readout, and the readout names every segment.
 *
 * ── PERCENTAGES ARE NEVER COMPUTED HERE ───────────────────────────────────
 *
 * §1.4 has one implementation, `sharesOfRecorded` in `app/lib/overview-meters.ts`,
 * and this file calls it rather than dividing. `BreakdownSection` re-runs it
 * over the buckets it is actually drawing instead of trusting the `share` on
 * the wire, because the set being drawn changes — "Show all 16" expands it,
 * "Split by priority" restacks it — and a share of a set that is no longer on
 * screen is exactly what §1.4's last line forbids: "Never print a percentage
 * whose denominator is not visible on screen." Both sides run the same
 * function on the same numbers, so the two agree.
 *
 * "Not recorded" is the other half of that rule and it is enforced structurally:
 * the grey bucket is excluded from the denominator, carries `share === null`,
 * and every renderer prints a count where a percentage would go.
 */

import { useState, type ReactNode } from "react";
import {
  EmptyState,
  ErrorState,
  FilterChip,
  HiddenDataTable,
  ProgressMeter,
  SegmentedMeter,
  SkeletonRow,
  deltaText,
  money,
} from "./ops-primitives";
import { Donut, RankedBars, useMediaQuery, type RankedRow } from "./overview-charts";
import type { BreakdownDimension } from "./overview-contract";
import {
  NOT_RECORDED_INK,
  SEVERITY_COLOUR,
  SEVERITY_KEYS,
  SEVERITY_LABEL,
  SEVERITY_RANGE,
  coverageSentence,
  cohortWording,
  sharesOfRecorded,
  tealScale,
  type SeverityKey,
} from "../../../lib/overview-meters";

/* ── Numbers ──────────────────────────────────────────────────────────────── */

/**
 * ABBREVIATE AT SMALL WIDTHS — §1.8, and 767px because it is an agreed one.
 *
 * The breakpoint list this page may use is 640 / 767 / 768 / 1024 / 1280 and
 * nothing else; several stage tests fail on any other width. 767 is the last
 * pixel before the tablet layout, which is where a tile stops having room for
 * "£26,557" beside a label.
 */
export function useAbbreviatedNumbers(): boolean {
  return useMediaQuery("(max-width: 767px)");
}

/**
 * 1.2k, 26.6k, 1m — and the promotion that stops "1000.0k" being printed.
 *
 * A value of 999,999 divides to 999.999, and one decimal place rounds that to
 * 1000.0, which is a number nobody writes. The check after the loop moves it up
 * a unit instead.
 */
function abbreviateNumber(magnitude: number, decimals: number): string {
  const units = ["", "k", "m", "bn"];
  let value = magnitude;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  let text = unit === 0 ? String(Math.round(value)) : value.toFixed(decimals);
  if (unit > 0 && Number(text) >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
    text = value.toFixed(decimals);
  }
  if (unit > 0) text = text.replace(/\.0+$/, "");
  return `${text}${units[unit]}`;
}

/**
 * A count, abbreviated or not. The FULL value always survives in the accessible
 * label — §1.9: "Screen-reader labels state the full value, not the abbreviated
 * one" — which is why every component here takes both.
 *
 * A non-finite input is an em dash rather than "NaN". §1.5: null is not zero,
 * and it is not a broken glyph either.
 */
export function formatCount(value: number, abbreviate: boolean): string {
  if (!Number.isFinite(value)) return "—";
  if (!abbreviate) return value.toLocaleString("en-GB");
  const sign = value < 0 ? "-" : "";
  return `${sign}${abbreviateNumber(Math.abs(value), 1)}`;
}

/**
 * GBP from INTEGER PENCE — the unit every `…Pence` field on the wire carries.
 *
 * §3.7: "no decimals above £1,000, two below". Above the threshold the pounds
 * go through `money()` in `ops-primitives`, so the thousands separator is
 * decided in one place for the whole product rather than twice.
 */
export function formatMoneyPence(pence: number, abbreviate: boolean): string {
  if (!Number.isFinite(pence)) return "—";
  const pounds = pence / 100;
  const sign = pounds < 0 ? "-" : "";
  const magnitude = Math.abs(pounds);
  if (abbreviate && magnitude >= 1000) return `${sign}£${abbreviateNumber(magnitude, 1)}`;
  if (magnitude >= 1000) return `${sign}${money(magnitude)}`;
  return `${sign}£${magnitude.toFixed(2)}`;
}

/* ── 1. The cohort header ─────────────────────────────────────────────────── */

/** `Site = Aldgate` splits; anything without a separator is shown whole. */
function splitChip(text: string): { label: string; value: string } {
  const match = /^(.*?)\s*[=:]\s*(.*)$/.exec(text);
  if (!match) return { label: "", value: text };
  return { label: match[1], value: match[2] };
}

/**
 * EVERY CARD SAYS WHAT IT IS COUNTING — §1.1 and §1.2.
 *
 * The old page's headline complaint was a header reading "226 jobs in this
 * period" beside a sidebar reading 776, with nothing to explain the gap. So the
 * cohort total is not decoration here: it is drawn from `cohortWording`, which
 * changes the VERB with the Measure-by toggle, and the active filters follow it
 * as removable chips so the reader can see what narrowed the number and undo it
 * in the same glance.
 */
export function CohortHeader({
  title,
  total,
  measure,
  filterChips,
  action,
  id,
  subtitle,
}: {
  title: string;
  total: number;
  measure: "requested" | "completed";
  filterChips: Array<{ key: string; label: string; onRemove?: () => void }>;
  action?: ReactNode;
  id?: string;
  subtitle?: string;
}) {
  return (
    <header className="ovw-cohort" id={id}>
      <div className="ovw-cohort__titles">
        <h2 className="ovw-cohort__title">{title}</h2>
        <p className="ovw-cohort__count">{cohortWording(measure, total)}</p>
        {subtitle ? <p className="ovw-cohort__subtitle">{subtitle}</p> : null}
        {filterChips.length > 0 ? (
          <ul className="ovw-cohort__chips">
            {filterChips.map((chip) => {
              const parts = splitChip(chip.label);
              return (
                <li key={chip.key}>
                  {chip.onRemove ? (
                    <FilterChip label={parts.label} value={parts.value} onRemove={chip.onRemove} />
                  ) : (
                    <span className="ovw-cohort__chip">{chip.label}</span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
      {action ? <div className="ovw-cohort__action">{action}</div> : null}
    </header>
  );
}

/* ── 2. The severity bar ──────────────────────────────────────────────────── */

/**
 * FOUR BANDS, IN ORDER, WITH THE NUMBERS ON THEM — §6.3.
 *
 * This replaces the dot row the brief deletes: `●●●●●●●●● +16 17 urgent` has no
 * key, no scale and two numbers running together. Every segment here carries
 * its band name and its count, so the colour is a second signal rather than the
 * only one, and the day ranges are in the readout because "ageing" means
 * nothing without them.
 *
 * With `showNumbers` off this delegates to `SegmentedMeter`. With it on the
 * segments have to be tall enough to hold a glyph, which the 10px primitive is
 * not — see the header for why that is the one place it could not be reused.
 */
export function SeverityBar({
  counts,
  showNumbers,
  size = "default",
  onSelect,
  label = "Ageing of open work",
}: {
  counts: { fresh: number; ageing: number; overdue: number; critical: number };
  showNumbers?: boolean;
  size?: "small" | "default";
  onSelect?: (key: SeverityKey) => void;
  label?: string;
}) {
  const segments = SEVERITY_KEYS.map((key) => ({
    key,
    label: SEVERITY_LABEL[key],
    value: Math.max(0, counts[key] ?? 0),
    colour: SEVERITY_COLOUR[key],
  }));
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const readout = segments
    .map((segment) => `${segment.label} (${SEVERITY_RANGE[segment.key]}) ${segment.value}`)
    .join(", ");

  if (!showNumbers) {
    return (
      <SegmentedMeter
        segments={segments}
        total={total}
        height={size === "small" ? 6 : 10}
        label={label}
        onSelect={onSelect ? (segment) => onSelect(segment.key as SeverityKey) : undefined}
      />
    );
  }

  return (
    <div
      className={`ovw-severity${size === "small" ? " ovw-severity--small" : ""}`}
      /*
       * `role="img"` is the primitive's convention and the right one for a
       * static bar. It cannot be used when the segments are buttons: `img`
       * makes its subtree presentational, so every one of those buttons would
       * vanish from the accessibility tree and the drill-down would be
       * keyboard-unreachable. `group` keeps the same label and keeps the
       * children.
       */
      role={onSelect ? "group" : "img"}
      aria-label={`${label}: ${readout}`}
    >
      {total > 0 ? (
        segments
          .filter((segment) => segment.value > 0)
          .map((segment) =>
            onSelect ? (
              <button
                type="button"
                key={segment.key}
                className="ovw-severity__segment"
                style={{ width: `${(segment.value / total) * 100}%`, background: segment.colour }}
                onClick={() => onSelect(segment.key as SeverityKey)}
                aria-label={`${segment.label}, ${SEVERITY_RANGE[segment.key]}: ${segment.value}`}
              >
                <span className="ovw-severity__count">{segment.value}</span>
              </button>
            ) : (
              <span
                key={segment.key}
                className="ovw-severity__segment"
                style={{ width: `${(segment.value / total) * 100}%`, background: segment.colour }}
              >
                <span className="ovw-severity__count">{segment.value}</span>
              </span>
            ),
          )
      ) : (
        <span className="ovw-severity__empty">No open work</span>
      )}
    </div>
  );
}

/* ── 3. The metric tile ───────────────────────────────────────────────────── */

/**
 * A FIGURE THAT KNOWS WHERE IT CAME FROM — §2.3(b).
 *
 * Four things the old tiles did not do, all of them required:
 *
 *   · the 4px rule ties the tile to its segment in the bar above it, so the
 *     reconciliation is visible rather than asserted;
 *   · `null` is an em dash and a sentence, never a zero. §1.5: "£0 is a fact;
 *     no data is not";
 *   · the previous figure is ALWAYS drawn, not hidden behind a hover. §2.3 asks
 *     for "previous figure on hover or tap", and a tile that is itself a
 *     drill-down button cannot hold a second button for the tap — so it is
 *     simply shown, which no reader loses by;
 *   · the accessible name carries `accessibleValue`, the unabbreviated figure,
 *     because §1.9 forbids a screen reader being told "26.6k".
 */
export function MetricTile({
  label,
  value,
  accent,
  share,
  delta,
  previous,
  footnote,
  severity,
  onSelect,
  accessibleValue,
}: {
  label: string;
  value: number | string | null;
  accent?: string;
  share?: number | null;
  delta?: number | null;
  previous?: number | null;
  footnote?: string | null;
  severity?: { fresh: number; ageing: number; overdue: number; critical: number } | null;
  onSelect?: () => void;
  accessibleValue?: string;
}) {
  const missing = value === null;
  const shown = missing ? "—" : String(value);
  const spoken = accessibleValue ?? (missing ? "not recorded" : String(value));
  const numeric = typeof value === "number" ? value : null;
  const words =
    previous !== null && previous !== undefined && numeric !== null
      ? deltaText(numeric, previous)
      : delta !== null && delta !== undefined
        ? deltaText(delta, 0)
        : null;

  const body = (
    <>
      <span className="ovw-tile__head">
        {accent ? (
          <span className="ovw-tile__rule" style={{ background: accent }} aria-hidden="true" />
        ) : null}
        <span className="ovw-tile__label">{label}</span>
      </span>
      <span className={`ovw-tile__value${missing ? " ovw-tile__value--missing" : ""}`}>
        {shown}
      </span>
      {missing ? (
        <span className="ovw-tile__missing">Not recorded for this period</span>
      ) : share === null || share === undefined ? null : (
        <span className="ovw-tile__share">{share}% of the cohort</span>
      )}
      {words ? (
        <span
          className={`ovw-tile__delta${
            delta && delta > 0 ? " ovw-tile__delta--up" : delta && delta < 0 ? " ovw-tile__delta--down" : ""
          }`}
        >
          <span aria-hidden="true">{delta && delta > 0 ? "▲" : delta && delta < 0 ? "▼" : "•"}</span>
          {words}
          {previous === null || previous === undefined ? null : (
            <span className="ovw-tile__previous">was {previous}</span>
          )}
        </span>
      ) : null}
      {footnote ? <span className="ovw-tile__footnote">{footnote}</span> : null}
      {severity ? <SeverityBar counts={severity} size="small" label={`${label} ageing`} /> : null}
    </>
  );

  const name = `${label}: ${spoken}${words ? `. ${words}` : ""}`;
  return onSelect ? (
    <button type="button" className="ovw-tile ovw-tile--button" onClick={onSelect} aria-label={name}>
      {body}
    </button>
  ) : (
    <div className="ovw-tile" aria-label={name} role="group">
      {body}
    </div>
  );
}

/* ── 4. The chart frame ───────────────────────────────────────────────────── */

/**
 * LOADING, EMPTY AND ERROR ARE THREE DIFFERENT PICTURES — §1.5 and §9.10.
 *
 * "A failure must never look like a zero." A spinner that resolves to an empty
 * card and a query that threw are three states the old page drew as one, and a
 * client reading "0" cannot tell whether the number is the answer or the
 * symptom. So: a skeleton shaped like the chart, an `EmptyState` sentence that
 * names what is empty, and an `ErrorState` with `role="alert"` and a Retry.
 *
 * `minHeight` reserves the finished dimensions in all four states — §9.44, "no
 * layout shift when data arrives" — and is on the frame rather than on the
 * skeleton so the empty and error states hold the same space.
 *
 * ── ONE TABLE, NOT TWO ────────────────────────────────────────────────────
 *
 * §1.9 wants "a text alternative — a data table behind a toggle". Rendering the
 * visible table AND `HiddenDataTable` would put the same numbers into the
 * accessibility tree twice, which is worse than having none. So the toggle
 * swaps them: closed, the hidden table is the screen-reader alternative; open,
 * a real visible table takes its place for everybody.
 */
export function ChartFrame({
  title,
  loading,
  error,
  onRetry,
  empty,
  emptyLabel,
  table,
  minHeight,
  children,
}: {
  title?: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  empty?: boolean;
  emptyLabel?: string;
  table?: { caption: string; head: string[]; rows: Array<Array<string | number>> };
  minHeight?: number;
  children: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  const reserved = minHeight ?? 200;

  let state: ReactNode;
  if (loading) {
    state = (
      <div className="ovw-frame__state ovw-frame__state--loading">
        <SkeletonRow lines={4} height={reserved} />
      </div>
    );
  } else if (error) {
    state = (
      <div className="ovw-frame__state ovw-frame__state--error">
        {onRetry ? (
          <ErrorState what={error} onRetry={onRetry} />
        ) : (
          <p className="ops-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  } else if (empty) {
    state = (
      <div className="ovw-frame__state ovw-frame__state--empty">
        <EmptyState>{emptyLabel ?? "Nothing recorded in this period."}</EmptyState>
      </div>
    );
  } else {
    state = children;
  }

  const live = !loading && !error && !empty;
  return (
    <div className="ovw-frame">
      {title || (table && live) ? (
        <div className="ovw-frame__head">
          {title ? <h3 className="ovw-frame__title">{title}</h3> : <span />}
          {table && live ? (
            <button
              type="button"
              className="ovw-frame__toggle"
              aria-pressed={showTable}
              onClick={() => setShowTable((open) => !open)}
            >
              {showTable ? "Hide data table" : "Show data table"}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="ovw-frame__body" style={{ minHeight: reserved }}>
        {state}
      </div>
      {table && live ? (
        showTable ? (
          <div className="ovw-frame__table">
            <table>
              <caption>{table.caption}</caption>
              <thead>
                <tr>
                  {table.head.map((column) => (
                    <th scope="col" key={column}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, index) => (
                  <tr key={index}>
                    {row.map((cell, cellIndex) =>
                      cellIndex === 0 ? (
                        <th scope="row" key={cellIndex}>
                          {cell}
                        </th>
                      ) : (
                        <td key={cellIndex}>{cell}</td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <HiddenDataTable caption={table.caption} columns={table.head} rows={table.rows} />
        )
      ) : null}
    </div>
  );
}

/* ── 5. The breakdown ─────────────────────────────────────────────────────── */

/**
 * THE ONE BREAKDOWN EVERY DIMENSION ON THE PAGE GOES THROUGH — §1.10.
 *
 * Shape is decided by category count, not by taste: five or fewer is a ring,
 * more than five is a ranked list. Above five slices a donut stops being
 * readable, and the list can carry the row's own numbers anyway.
 *
 * The header is `coverageSentence`, so the denominator §1.4 requires to be
 * "visible on screen" is literally the line above the chart. The grey bucket
 * sits below with a count, no percentage and a Fix action — §1.5 — and it is
 * excluded from the shares by `sharesExcludingNotRecorded` inside the chart, so
 * the recorded slices still sum to 100.
 *
 * "Show all N →" expands IN PLACE, which §5.3 asks for by name: "+8 more" reads
 * as truncation, a control reads as a control.
 */
export function BreakdownSection({
  dimension,
  splitByPriority,
  onToggleSplit,
  onSelect,
  onDrill,
  onFix,
  forceShape,
  initialLimit,
}: {
  dimension: BreakdownDimension;
  splitByPriority: boolean;
  onToggleSplit?: () => void;
  onSelect?: (bucketKey: string) => void;
  onDrill?: (bucketKey: string) => void;
  onFix?: () => void;
  forceShape?: "donut" | "bars";
  initialLimit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const limit = initialLimit ?? 8;

  const recordedBuckets = dimension.buckets.filter((bucket) => !bucket.notRecorded);
  const greyBucket = dimension.buckets.find((bucket) => bucket.notRecorded);
  const notRecorded = greyBucket
    ? greyBucket.value
    : Math.max(0, dimension.total - dimension.recorded);

  const shape = forceShape ?? (recordedBuckets.length > 5 ? "bars" : "donut");
  const shares = sharesOfRecorded(recordedBuckets.map((bucket) => bucket.value));
  const visible = shape === "bars" && !expanded ? recordedBuckets.slice(0, limit) : recordedBuckets;
  const hidden = recordedBuckets.length - visible.length;

  const table = {
    caption: coverageSentence(dimension.label, dimension.recorded, dimension.total),
    head: ["Category", "Jobs", "Share of recorded"],
    rows: [
      ...recordedBuckets.map((bucket, index) => [
        bucket.label,
        bucket.value,
        `${shares[index]}%`,
      ]),
      ...(notRecorded > 0 ? [["Not recorded", notRecorded, "not a recorded value"]] : []),
    ] as Array<Array<string | number>>,
  };

  return (
    <section className="ovw-breakdown">
      <div className="ovw-breakdown__head">
        <h3 className="ovw-breakdown__title">
          {coverageSentence(dimension.label, dimension.recorded, dimension.total)}
        </h3>
        {onToggleSplit ? (
          <button
            type="button"
            className="ovw-breakdown__split"
            aria-pressed={splitByPriority}
            onClick={onToggleSplit}
          >
            Split by priority
          </button>
        ) : null}
      </div>

      <ChartFrame
        table={table}
        empty={dimension.total === 0}
        emptyLabel={`No ${dimension.label.toLowerCase()} to break down in this period.`}
        minHeight={shape === "donut" ? 220 : 180}
      >
        {shape === "donut" ? (
          <Donut
            label={dimension.label}
            centreValue={dimension.recorded}
            centreLabel="recorded"
            onSelect={onSelect}
            segments={[
              ...recordedBuckets.map((bucket, index) => ({
                key: bucket.key,
                label: bucket.label,
                value: bucket.value,
                colour: bucket.colour || tealScale(index),
              })),
              ...(notRecorded > 0
                ? [
                    {
                      key: greyBucket?.key ?? "not_recorded",
                      label: "Not recorded",
                      value: notRecorded,
                      colour: NOT_RECORDED_INK,
                      notRecorded: true,
                    },
                  ]
                : []),
            ]}
          />
        ) : (
          <RankedBars
            rows={visible.map((bucket, index): RankedRow => ({
              key: bucket.key,
              label: bucket.label,
              value: bucket.value,
              share: shares[index],
              colour: bucket.colour || tealScale(index),
              byPriority: bucket.byPriority,
            }))}
            splitByPriority={splitByPriority}
            onSelect={onSelect}
            onDrill={onDrill}
          />
        )}
      </ChartFrame>

      {shape === "bars" && hidden > 0 ? (
        <button
          type="button"
          className="ovw-breakdown__more"
          onClick={() => setExpanded(true)}
        >
          Show all {recordedBuckets.length} →
        </button>
      ) : null}
      {shape === "bars" && expanded && recordedBuckets.length > limit ? (
        <button
          type="button"
          className="ovw-breakdown__more"
          onClick={() => setExpanded(false)}
        >
          Show the top {limit} only
        </button>
      ) : null}

      {/*
        §1.5 — "'Not recorded' always appears as a grey, percentage-free count
        with a 'Fix these →' link to the filtered Jobs list." The count is here
        and not inside the chart because a reader has to be able to act on it,
        and an action inside a legend is a control nobody finds.
      */}
      {notRecorded > 0 ? (
        <p className="ovw-breakdown__not-recorded">
          <span className="ovw-breakdown__swatch" style={{ background: NOT_RECORDED_INK }} aria-hidden="true" />
          <span className="ovw-breakdown__grey-count">Not recorded — {notRecorded} jobs</span>
          {onFix ? (
            <button type="button" className="ovw-breakdown__fix" onClick={onFix}>
              Fix these →
            </button>
          ) : null}
        </p>
      ) : null}

      {dimension.note ? <p className="ovw-breakdown__note">{dimension.note}</p> : null}
      {dimension.warning ? (
        <p className="ovw-breakdown__warning" role="note">
          {dimension.warning}
        </p>
      ) : null}
    </section>
  );
}

/* ── 6. The data-quality row ──────────────────────────────────────────────── */

/**
 * ONLY THE THINGS THAT ARE ACTUALLY WRONG — §1.10 and §3.7.
 *
 * Zero-count items are not rendered at all. A row reading "0 jobs have no cost
 * recorded" is noise on a card whose whole job is to point at what needs
 * attention, and once a reader has learned to skip the zeros they skip the
 * ones. Each surviving item is a plain sentence and a real action, because
 * §1.5 requires every "Fix these →" to go somewhere.
 */
export function DataQualityRow({
  items,
}: {
  items: Array<{
    key: string;
    count: number;
    sentence: string;
    actionLabel: string;
    onAction: () => void;
  }>;
}) {
  const live = items.filter((item) => item.count > 0);
  if (live.length === 0) return <></>;
  return (
    <ul className="ovw-dq">
      {live.map((item) => (
        <li className="ovw-dq__item" key={item.key}>
          <span className="ovw-dq__count">{item.count}</span>
          <span className="ovw-dq__sentence">{item.sentence}</span>
          <button type="button" className="ovw-dq__action" onClick={item.onAction}>
            {item.actionLabel}
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ── 7. The coverage strip ────────────────────────────────────────────────── */

/**
 * COVERAGE IS READ FIRST — §3.2.
 *
 * The Cost card reported £26,557 across 46 jobs while the cohort held 776: a 6%
 * sample presented as a total. This strip is the fix, and it is deliberately
 * the first thing in the section rather than a footnote under it.
 *
 * The banner threshold is computed from the data on every render, never passed
 * as a boolean — a caller that got the comparison wrong once would print
 * "indicative" over a complete data set, or worse, hide the warning over an
 * empty one. Over 75% NOTHING is drawn even if a banner sentence was supplied,
 * which is §3.2's third row.
 *
 * Both numbers on screen come from the shared implementations — the sentence
 * from `coverageSentence`, the share from `sharesOfRecorded` — so there is no
 * second percentage formula in the codebase to drift.
 */
export function CoverageStrip({
  recorded,
  total,
  label,
  actionLabel,
  onAction,
  banner,
}: {
  recorded: number;
  total: number;
  label: string;
  actionLabel?: string;
  onAction?: () => void;
  banner?: string;
}) {
  const [share] = sharesOfRecorded([Math.max(0, recorded), Math.max(0, total - recorded)]);
  const tone = share < 40 ? "amber" : share <= 75 ? "quiet" : "none";
  return (
    <div className="ovw-coverage">
      <div className="ovw-coverage__line">
        <p className="ovw-coverage__sentence">{coverageSentence(label, recorded, total)}</p>
        {actionLabel && onAction ? (
          <button type="button" className="ovw-coverage__action" onClick={onAction}>
            {actionLabel}
          </button>
        ) : null}
      </div>
      <ProgressMeter
        value={Math.max(0, recorded)}
        max={Math.max(0, total)}
        tone="var(--ms-teal-500)"
        label={coverageSentence(label, recorded, total)}
        height={10}
      />
      {banner && tone === "amber" ? (
        <p className="ovw-coverage__banner" role="note">
          {banner}
        </p>
      ) : null}
      {banner && tone === "quiet" ? <p className="ovw-coverage__note">{banner}</p> : null}
    </div>
  );
}
