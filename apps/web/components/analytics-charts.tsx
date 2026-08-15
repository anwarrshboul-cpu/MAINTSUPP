import type { CSSProperties } from "react";
import Link from "next/link";
import { Icon, type IconName } from "./icon";

/**
 * The legacy portal's chart primitives, ported.
 *
 * All five of these came out of one file — `app/(app)/portal/dashboard-analytics.tsx`
 * in the legacy app — and there is still no charting library behind them. A
 * sparkline is an inline `<svg>`, a donut is a `conic-gradient`, a bar is a div
 * with a width. That was a deliberate choice there and it is worth more here:
 * this product is read on a phone in a shop corridor, and a dashboard is the
 * last place to ship 90KB of JavaScript to draw seven rectangles.
 *
 * TWO THINGS CHANGED IN THE PORT, both for the same reason.
 *
 * 1. There is no `"use client"` directive. The originals carried one because
 *    they lived inside a single client-rendered SPA that fetched its own data;
 *    every one of them is nonetheless pure props-in/markup-out, so under the
 *    App Router they render on the SERVER and the browser is sent finished
 *    markup and no component code at all.
 *
 * 2. `onClick` / `onSelect` are gone, replaced by an optional `href`. A server
 *    component cannot pass a function across the boundary — doing so is a build
 *    error — and every place the legacy screen used a click handler it was
 *    navigating. A link is what that always was, and it works with the middle
 *    mouse button, which the handler never did.
 *
 * `AnalyticsToolbar` was deliberately NOT ported. It is a filter bar over
 * portfolio and period, and the Phase 2 analytics API takes no parameters at
 * all — its windows are hard-coded to six months. A control that cannot change
 * what is drawn is worse than no control.
 */

export type AnalyticsTone =
  | "teal"
  | "blue"
  | "orange"
  | "red"
  | "green"
  | "purple"
  | "slate";

/**
 * How many buckets a card's history is drawn in.
 *
 * Twelve, because the series that feed these tiles come from
 * `/jobs/summary/monthly`, which returns twelve months with the empty ones
 * present as zeroes. It is stated as a constant so the fallback below has the
 * same width as a real series and a card cannot change shape when its data
 * arrives.
 */
const TREND_BUCKETS = 12;

/**
 * The fallback for a card that was given no series.
 *
 * It used to be `[3, 5, 4, 7, 5, 8, 6, 9, 7, 10, 8, 12]` — an invented rising
 * line. A card with no data drew a confident upward trend, which is the one
 * shape a reader is most likely to act on. Flat zeros draw a baseline, which
 * is what "nothing to plot" looks like.
 *
 * Phase 2 goes one step further: see `AnalyticsMetricCard`, where a card given
 * no series draws no sparkline at all rather than this baseline.
 */
const emptySpark = new Array<number>(TREND_BUCKETS).fill(0);

function lineGeometry(values: number[], width = 320, height = 92) {
  const safe = values.length > 1 ? values : emptySpark;
  const min = Math.min(...safe);
  const max = Math.max(...safe);
  const spread = Math.max(max - min, 1);
  const points = safe.map((value, index) => ({
    x: (index / Math.max(safe.length - 1, 1)) * width,
    y: height - ((value - min) / spread) * (height - 18) - 8,
  }));
  const line = points
    .map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(" ");
  return {
    line,
    area: `${line} L${width},${height} L0,${height} Z`,
    points,
  };
}

export function Sparkline({
  values = emptySpark,
  tone = "teal",
  label,
}: {
  values?: number[];
  tone?: AnalyticsTone;
  /**
   * What the line plots, in words. A sparkline under a live number reads as
   * that number's history, and on this data it usually is not — the figure on
   * the tile is a count of everything open right now, the line under it is
   * twelve months of jobs raised. Where a caller can say what the shape
   * actually means, the line stops being decoration and carries the sentence.
   */
  label?: string;
}) {
  const geometry = lineGeometry(values);
  return (
    <svg
      className={`ms-spark ms-spark--${tone}`}
      viewBox="0 0 320 92"
      preserveAspectRatio="none"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {label && <title>{label}</title>}
      <path className="ms-spark__area" d={geometry.area} />
      <path className="ms-spark__line" d={geometry.line} />
    </svg>
  );
}

export function AnalyticsMetricCard({
  label,
  value,
  detail,
  icon,
  tone = "teal",
  trend,
  trendLabel,
  href,
}: {
  label: string;
  value: string;
  detail?: string;
  icon: IconName;
  tone?: AnalyticsTone;
  /**
   * Omitted, not zero-filled, when the figure has no history.
   *
   * The legacy screen always had a series to hand because its `periodTrend`
   * bucketed rows it already held in memory. Phase 2 reads aggregates from an
   * API, and some of them — the compliance score is the case in point — have no
   * time dimension at all: the score is recomputed from today's date on every
   * read and nothing anywhere records what it was last month. A flat baseline
   * under a live 0% would say "it has always been zero", which is a claim this
   * data cannot make, so the card draws no line instead.
   */
  trend?: number[];
  /** Passed straight to the sparkline — see `Sparkline`'s `label`. */
  trendLabel?: string;
  /** Where the tile goes when tapped. Absent for a figure with no screen behind it. */
  href?: string;
}) {
  const hasTrend = Boolean(trend && trend.length > 1);
  const className = `ms-metric ms-metric--${tone}${hasTrend ? "" : " ms-metric--flat"}`;
  const content = (
    <>
      <span className="ms-metric__icon"><Icon name={icon} size={20} /></span>
      <span className="ms-metric__copy">
        <small>{label}</small>
        <strong>{value}</strong>
        {detail && <span>{detail}</span>}
      </span>
      {hasTrend && <Sparkline values={trend} tone={tone} label={trendLabel} />}
    </>
  );
  return href ? (
    <Link className={className} href={href}>{content}</Link>
  ) : (
    <article className={className}>{content}</article>
  );
}

export type DonutSegment = { label: string; value: number; color: string };

export function DonutChart({
  segments,
  value,
  label,
  size = "large",
}: {
  segments: DonutSegment[];
  value: string;
  label: string;
  size?: "medium" | "large";
}) {
  const total = Math.max(segments.reduce((sum, item) => sum + item.value, 0), 1);
  const calculated = segments.reduce(
    (result, segment) => {
      const end = result.cursor + (segment.value / total) * 100;
      return {
        cursor: end,
        stops: [
          ...result.stops,
          `${segment.color} ${result.cursor}% ${end}%`,
        ],
      };
    },
    { cursor: 0, stops: [] as string[] },
  );
  /*
   * An all-zero donut draws one flat ring in the empty colour rather than
   * whatever a zero-width conic gradient happens to render. The token is
   * namespaced (see ms-tokens.css) because `--line-strong` already means
   * something else in this app's stylesheets.
   */
  const stops = segments.some((segment) => segment.value > 0)
    ? calculated.stops
    : ["var(--ms-donut-empty) 0 100%"];
  return (
    <div
      className={`ms-donut ms-donut--${size}`}
      style={{ "--ms-donut-fill": `conic-gradient(${stops.join(", ")})` } as CSSProperties}
      role="img"
      aria-label={`${label}: ${value}`}
    >
      <span><strong>{value}</strong><small>{label}</small></span>
    </div>
  );
}

export function DonutLegend({ segments }: { segments: DonutSegment[] }) {
  return (
    <div className="ms-legend">
      {segments.map((segment) => (
        <span key={segment.label}>
          <i style={{ background: segment.color }} />
          <small>{segment.label}</small>
          <strong>{segment.value}</strong>
        </span>
      ))}
    </div>
  );
}

export function HorizontalBars({
  items,
  valueFormatter = (value) => String(value),
}: {
  items: Array<{ label: string; value: number; color?: string }>;
  valueFormatter?: (value: number) => string;
}) {
  // Scaled to the largest bar, not to the total: at a 441/55 split the small
  // bar would otherwise be an invisible sliver.
  const maximum = Math.max(...items.map((item) => item.value), 1);
  return (
    <div className="ms-bars">
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`}>
          <span title={item.label}>{item.label}</span>
          {/*
            A 3% floor so a bar with a real but tiny count is still visible,
            and NO floor at all for a zero — a stub of colour on an empty row
            reads as "some", and the whole point of keeping empty categories in
            the series is that they say none.
          */}
          <div>
            <i
              style={{
                width: `${Math.max((item.value / maximum) * 100, item.value ? 3 : 0)}%`,
                background: item.color ?? "var(--ms-brand-bright)",
              }}
            />
          </div>
          <strong>{valueFormatter(item.value)}</strong>
        </div>
      ))}
    </div>
  );
}

export function TrendChart({
  items,
  valueFormatter = (value) => String(value),
}: {
  items: Array<{ label: string; value: number }>;
  valueFormatter?: (value: number) => string;
}) {
  const values = items.map((item) => item.value);
  const geometry = lineGeometry(values, 640, 190);
  const max = Math.max(...values, 1);
  return (
    <div className="ms-trend">
      <div className="ms-trend__y">
        <span>{valueFormatter(max)}</span>
        <span>{valueFormatter(max / 2)}</span>
        <span>{valueFormatter(0)}</span>
      </div>
      <div className="ms-trend__plot">
        <svg viewBox="0 0 640 190" preserveAspectRatio="none" role="img" aria-label="Trend over time">
          <path className="ms-trend__area" d={geometry.area} />
          <path className="ms-trend__line" d={geometry.line} />
          {/*
            Keyed by position, not by label. Labels repeat and are not
            identities — "Jul" appears twice in a thirteen-month series — and
            the legacy screen could hand this chart sixty-two daily buckets
            with most of the labels deliberately blanked.
          */}
          {geometry.points.map((point, index) => (
            <circle key={index} cx={point.x} cy={point.y} r="4" />
          ))}
        </svg>
        {/*
          `minmax(0, 1fr)`, not `minmax(42px, 1fr)`. The floor was safe while
          this chart only ever drew six months; thirty-one daily buckets at
          42px is 1302px of grid inside a 350px panel on a phone. The columns
          share what there is instead.
        */}
        <div
          className="ms-trend__x"
          style={{ gridTemplateColumns: `repeat(${Math.max(items.length, 1)}, minmax(0, 1fr))` }}
        >
          {items.map((item, index) => <span key={index}>{item.label}</span>)}
        </div>
      </div>
    </div>
  );
}
