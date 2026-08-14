"use client";

import type { CSSProperties, ReactNode } from "react";
import { Icon, type IconName } from "../../components";
import { meterTrendBuckets } from "./dashboard-meters";
import { stampWithinPeriod } from "./period-model";

export type AnalyticsTone =
  | "teal"
  | "blue"
  | "orange"
  | "red"
  | "green"
  | "purple"
  | "slate";

export type AnalyticsOption = { value: string; label: string };

/**
 * The fallback for a card that was given no series.
 *
 * It used to be `[3, 5, 4, 7, 5, 8, 6, 9, 7, 10, 8, 12]` — an invented rising
 * line. A card with no data drew a confident upward trend, which is the one
 * shape a reader is most likely to act on. Flat zeros draw a baseline, which
 * is what "nothing to plot" looks like.
 */
const emptySpark = new Array<number>(meterTrendBuckets).fill(0);

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
   * that number's history, and on this data it is not — see the trend note in
   * dashboard-meters.ts. Where a caller can say what the shape actually means,
   * the line stops being decoration and carries the sentence.
   */
  label?: string;
}) {
  const geometry = lineGeometry(values);
  return (
    <svg
      className={`analytics-spark analytics-spark--${tone}`}
      viewBox="0 0 320 92"
      preserveAspectRatio="none"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {label && <title>{label}</title>}
      <path className="analytics-spark__area" d={geometry.area} />
      <path className="analytics-spark__line" d={geometry.line} />
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
  onClick,
}: {
  label: string;
  value: string;
  detail?: string;
  icon: IconName;
  tone?: AnalyticsTone;
  trend?: number[];
  /** Passed straight to the sparkline — see `Sparkline`'s `label`. */
  trendLabel?: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="analytics-metric__icon"><Icon name={icon} size={20} /></span>
      <span className="analytics-metric__copy">
        <small>{label}</small>
        <strong>{value}</strong>
        {detail && <span>{detail}</span>}
      </span>
      <Sparkline values={trend} tone={tone} label={trendLabel} />
    </>
  );
  return onClick ? (
    <button className={`analytics-metric analytics-metric--${tone}`} type="button" onClick={onClick}>
      {content}
    </button>
  ) : (
    <article className={`analytics-metric analytics-metric--${tone}`}>{content}</article>
  );
}

export function AnalyticsToolbar({
  portfolio,
  portfolios,
  onPortfolioChange,
  period,
  periods,
  onPeriodChange,
  periodControl,
  onExport,
  exportLabel = "Export",
  children,
  slotRef,
}: {
  portfolio: string;
  portfolios: AnalyticsOption[];
  onPortfolioChange: (value: string) => void;
  period?: string;
  periods?: AnalyticsOption[];
  onPeriodChange?: (value: string) => void;
  /**
   * A richer period control, rendered where the plain `<select>` would be.
   *
   * The board and the compliance register ask for a period with four or five
   * fixed choices and a single `<select>` is the right control for that. The
   * Spend and reporting screen asks for a named month, a quarter, a date or a
   * range, which needs a second field beside the first. Rather than fork the
   * toolbar — two toolbars drift, and this one already carries the portfolio
   * filter and the export button every screen needs — the caller passes the
   * control it wants and the layout stays in one place.
   */
  periodControl?: ReactNode;
  onExport: () => void;
  exportLabel?: string;
  children?: ReactNode;
  slotRef?: (node: HTMLDivElement | null) => void;
}) {
  return (
    <div className="analytics-toolbar" aria-label="Dashboard filters">
      {children}
      <label>
        <Icon name="filter" size={17} />
        <select aria-label="Portfolio" value={portfolio} onChange={(event) => onPortfolioChange(event.target.value)}>
          {portfolios.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
        </select>
      </label>
      {periodControl ?? (periods && (
        <label>
          <Icon name="calendar" size={17} />
          <select aria-label="Date range" value={period} onChange={(event) => onPeriodChange?.(event.target.value)}>
            {periods.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select>
        </label>
      ))}
      {/*
        THE TRAILING SLOT, and why it sits BEFORE the export button.

        A screen can own a control that belongs in this row but is rendered by
        a component far away in the tree — Reports' "Edit layout" belongs to
        `DashboardWidgets`, which lives below the charts and holds the layout
        state. Lifting that state up to place the button here would mean two
        owners of one arrangement; portalling the button into a node this
        toolbar renders keeps one owner and still puts the control where the
        owner asked for it.

        It is rendered before the export button on purpose. Three rules in
        brand-overrides.css select `.analytics-toolbar > button:last-child` to
        give Export the full width of the two-column mobile grid, and a slot
        appended after it would silently take that rule away from it.

        `display: contents` on the slot (brand-overrides.css) means the
        portalled control is laid out as if it were a direct child, so it lines
        up with the pickers instead of forming a box of its own.
      */}
      {slotRef && <div className="analytics-toolbar__slot" ref={slotRef} />}
      <button type="button" onClick={onExport}>
        <Icon name="download" size={17} />
        {exportLabel}
      </button>
    </div>
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
  const stops = segments.some((segment) => segment.value > 0)
    ? calculated.stops
    : ["#29404d 0 100%"];
  return (
    <div
      className={`analytics-donut analytics-donut--${size}`}
      style={{ "--donut-fill": `conic-gradient(${stops.join(", ")})` } as CSSProperties}
      role="img"
      aria-label={`${label}: ${value}`}
    >
      <span><strong>{value}</strong><small>{label}</small></span>
    </div>
  );
}

export function DonutLegend({ segments }: { segments: DonutSegment[] }) {
  return (
    <div className="analytics-legend">
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
  onSelect,
}: {
  items: Array<{ label: string; value: number; color?: string; id?: string }>;
  valueFormatter?: (value: number) => string;
  onSelect?: (id: string) => void;
}) {
  const maximum = Math.max(...items.map((item) => item.value), 1);
  return (
    <div className="analytics-bars">
      {items.map((item, index) => {
        const row = (
          <>
            <span title={item.label}>{item.label}</span>
            <div><i style={{ width: `${Math.max((item.value / maximum) * 100, item.value ? 3 : 0)}%`, background: item.color ?? "#12b4a8" }} /></div>
            <strong>{valueFormatter(item.value)}</strong>
          </>
        );
        return onSelect && item.id ? (
          <button type="button" key={item.id} onClick={() => onSelect(item.id!)}>{row}</button>
        ) : (
          <div key={`${item.label}-${index}`}>{row}</div>
        );
      })}
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
    <div className="analytics-trend">
      <div className="analytics-trend__y">
        <span>{valueFormatter(max)}</span>
        <span>{valueFormatter(max / 2)}</span>
        <span>{valueFormatter(0)}</span>
      </div>
      <div className="analytics-trend__plot">
        <svg viewBox="0 0 640 190" preserveAspectRatio="none" role="img" aria-label="Trend over time">
          <path className="analytics-trend__area" d={geometry.area} />
          <path className="analytics-trend__line" d={geometry.line} />
          {/*
            Keyed by position, not by label. The period selector can hand this
            chart sixty-two daily buckets, and `periodBuckets` deliberately
            blanks the labels it would be illegible to draw — so labels repeat
            and are not identities. They never were: "Jul" appears twice in a
            thirteen-month series.
          */}
          {geometry.points.map((point, index) => (
            <circle key={index} cx={point.x} cy={point.y} r="4" />
          ))}
        </svg>
        {/*
          `minmax(0, 1fr)`, not `minmax(42px, 1fr)`. The floor was safe while
          this chart only ever drew six months; a period of "Last 90 days" draws
          thirteen weekly buckets and a month draws thirty-one daily ones, and
          31 × 42px is 1302px of grid inside a 350px panel on a phone. The
          columns now share what there is, and `periodBuckets` has already
          thinned the labels so the text does not collide.
        */}
        <div className="analytics-trend__x" style={{ gridTemplateColumns: `repeat(${Math.max(items.length, 1)}, minmax(0, 1fr))` }}>
          {items.map((item, index) => <span key={index}>{item.label}</span>)}
        </div>
      </div>
    </div>
  );
}

export const analyticsPeriodOptions: AnalyticsOption[] = [
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "This year" },
  { value: "all", label: "All records" },
];

/**
 * One definition of the period, shared with the meters.
 *
 * The window itself is resolved by `resolvePeriod` in period-model.ts, which
 * grew out of `analyticsWindow` in dashboard-meters.ts rather than alongside
 * it: every token that file understood — a number of days, "all" — resolves to
 * the identical pair of timestamps, grace day included, and the period tests
 * assert that equivalence against the original. What is new is everything the
 * owner asked for on top: a named month, a quarter, a single date, a range.
 *
 * Keeping this function's name and signature is deliberate. Three screens call
 * it and none of them had to change to gain the new vocabulary.
 */
export function withinAnalyticsPeriod(value: string, period: string, now: number) {
  return stampWithinPeriod(value, period, now);
}
