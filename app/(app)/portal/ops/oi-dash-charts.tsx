"use client";

/**
 * THE OVERVIEW'S NEW SHAPES — the semicircle gauge, the bar list, the target
 * bars, the weekly sparkline, the KPI tile and the card chrome.
 *
 * Everything else the Overview draws — every donut, every ring, the spend trend
 * — is the shared chart from `ov-dash-charts.tsx`, reused as it shipped, with
 * the neon palette passed in as `var(--accent-…)`. These are new SHAPES, not new
 * mechanisms: they sweep with `useOvSweep`, so they grow in, re-ease on a
 * refetch and honour reduced motion exactly as the rings beside them do.
 *
 * ── THE GLOW IS ONE FILTER, DEFINED ONCE ──────────────────────────────────
 *
 * `OiGlowDefs` puts a single `#oi-glow` filter (a 2.5px Gaussian blur merged
 * under the source) in the section, and `oi-dash.css` applies it to every
 * coloured stroke — the shared donuts' and rings' arcs included, which is why
 * the glow needs no prop on any shared chart. Its region is the brief's
 * `-30% / 160%` of the element's bounding box, and every element it is applied
 * to is an arc whose GEOMETRY is a whole circle or a whole semicircle (the
 * dash array only hides part of it), so the region is never a sliver that
 * would clip the blur. HTML bars take a `box-shadow` instead.
 *
 * ── COLOUR IS A TOKEN NAME, NEVER A HEX ───────────────────────────────────
 *
 * Every colour this file hands out is `var(--accent-…)`; the values live in
 * `oi-dash.css`, scoped to `.ov-dash.oi-dash`. No number is printed in its own
 * slice's colour except where the colour carries the meaning (a KPI caption, a
 * delta line), and every accent measures above 4.5:1 on `--ov-card` (#0D1526)
 * — the lowest, `--accent-critical`, at about 5.7:1.
 */

import { useState, type CSSProperties, type JSX, type ReactNode } from "react";
import { ovFraction, ovPercent, useOvHoverCapable, useOvSweep } from "./ov-dash-charts";

/* ── The palette, by name ─────────────────────────────────────────────────── */

/** The brief's neon tokens, as the CSS custom properties `oi-dash.css` declares. */
export const OI_COLOUR = {
  primary: "var(--accent-primary)",
  secondary: "var(--accent-secondary)",
  amber: "var(--accent-amber)",
  critical: "var(--accent-critical)",
  blue: "var(--accent-blue)",
  tealLight: "var(--accent-teal-light)",
  muted: "var(--muted)",
  /** "Missing" on the compliance donut: the critical hue, dimmed. */
  missing: "var(--oi-missing)",
} as const;

export type OiTone = keyof typeof OI_COLOUR;

/**
 * THE ORDER A BREAKDOWN WITH NO MEANING OF ITS OWN IS COLOURED IN.
 *
 * Status, label, engineer and repeat-issue slices are ranked, not graded, so
 * they take the series in turn — teal, violet, amber, blue, light teal, and
 * critical last, where it lands on the smallest slice rather than the largest.
 * A rolled-up bucket (`__…__`) is always `--muted`: "Other" and "Not recorded"
 * are not a category a reader should look for by colour.
 */
const OI_SERIES: readonly string[] = [
  OI_COLOUR.primary,
  OI_COLOUR.secondary,
  OI_COLOUR.amber,
  OI_COLOUR.blue,
  OI_COLOUR.tealLight,
  OI_COLOUR.critical,
];

/** A rolled-up bucket's key — `__other__`, `__not_recorded__`, `__unassigned__`. */
export function oiIsRollup(key: string): boolean {
  return /^__.+__$/.test(key);
}

/** One colour per slice, in rank order; rolled-up buckets are muted and skip a turn. */
export function oiSeriesColours(keys: readonly string[]): string[] {
  const colours: string[] = [];
  for (let index = 0, turn = 0; index < keys.length; index += 1) {
    if (oiIsRollup(keys[index])) {
      colours.push(OI_COLOUR.muted);
    } else {
      colours.push(OI_SERIES[turn % OI_SERIES.length]);
      turn += 1;
    }
  }
  return colours;
}

/** A shared-policy tone (`qualityTone` / `rateTone`) as the neon colour that means it. */
export function oiToneColour(tone: "good" | "warn" | "poor"): string {
  if (tone === "good") return OI_COLOUR.primary;
  if (tone === "warn") return OI_COLOUR.amber;
  return OI_COLOUR.critical;
}

/** A whole count, en-GB grouped, never `NaN`. */
export function oiCount(value: number): string {
  return (Number.isFinite(value) ? value : 0).toLocaleString("en-GB");
}

/* ── The link every drill is ──────────────────────────────────────────────── */

/**
 * A REAL ANCHOR THAT NAVIGATES THROUGH THE SHELL — `OvLink`, as the three
 * blocks already draw it.
 *
 * An `<a href>` so the address shows on hover, copies, opens in a new tab and
 * answers Enter with no key handler of its own. A plain left click is handed to
 * the shell's client-side navigation; a modifier or a middle click falls
 * through to the browser.
 */
export function OiLink({
  href,
  className,
  label,
  onActivate,
  style,
  children,
}: {
  href: string;
  className: string;
  label: string;
  onActivate: () => void;
  style?: CSSProperties;
  children: ReactNode;
}): JSX.Element {
  return (
    <a
      className={className}
      href={href}
      aria-label={label}
      style={style}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (event.button !== 0) return;
        event.preventDefault();
        onActivate();
      }}
    >
      {children}
    </a>
  );
}

/* ── The glow ─────────────────────────────────────────────────────────────── */

/**
 * The one glow filter the section's strokes reference, as `url(#oi-glow)`.
 *
 * A zero-size SVG rather than `display: none`: a filter inside an undisplayed
 * subtree is not rendered in every engine, and a reference to it then paints
 * the stroke it was meant to decorate as nothing at all.
 */
export function OiGlowDefs(): JSX.Element {
  return (
    <svg className="oi-glow-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <filter id="oi-glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.5" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
    </svg>
  );
}

/* ── The card ─────────────────────────────────────────────────────────────── */

/**
 * A chart card — title left, the data-source pill right — as the reference
 * draws every card on the page. `wide` spans the whole grid row.
 */
export function OiCard({
  title,
  pill,
  pillTone = "primary",
  wide = false,
  className,
  children,
}: {
  title: string;
  pill?: string;
  pillTone?: OiTone;
  wide?: boolean;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className={`oi-card${wide ? " oi-card--wide" : ""}${className ? ` ${className}` : ""}`}>
      <div className="oi-card__head">
        <h3 className="oi-card__title">{title}</h3>
        {pill ? <span className={`oi-pill oi-pill--${pillTone}`}>{pill}</span> : null}
      </div>
      {children}
    </section>
  );
}

/* ── 1. The KPI tile ──────────────────────────────────────────────────────── */

/**
 * ONE FIGURE: a small-caps label, the number, and a caption in the tile's
 * accent — with the soft glow in the top-right corner the reference draws.
 *
 * The whole tile is the link when the figure has a list behind it, so there is
 * nothing interactive inside it; a figure with no single list (a completion
 * RATE) is a plain tile whose text is its own accessible content.
 */
export function OiKpiTile({
  label,
  value,
  caption,
  tone,
  href,
  onActivate,
  ariaLabel,
  title,
}: {
  label: string;
  value: string;
  caption: string;
  tone: OiTone;
  href?: string;
  onActivate?: () => void;
  /** The link's accessible name — the figure, and what opening it shows. */
  ariaLabel: string;
  /** A hover title, for a figure whose exact value is longer than its print. */
  title?: string;
}): JSX.Element {
  const style = { "--oi-accent": OI_COLOUR[tone] } as CSSProperties;
  const body = (
    <>
      <span className="oi-kpi__label">{label}</span>
      <span className="oi-kpi__value" title={title}>
        {value}
      </span>
      <span className="oi-kpi__caption">{caption}</span>
    </>
  );
  if (href && onActivate) {
    return (
      <OiLink className="oi-kpi oi-kpi--link" href={href} label={ariaLabel} onActivate={onActivate} style={style}>
        {body}
      </OiLink>
    );
  }
  return (
    <div className="oi-kpi" style={style}>
      {body}
    </div>
  );
}

/* ── 2. The semicircle gauge ──────────────────────────────────────────────── */

const GAUGE_RADIUS = 88;
const GAUGE_STROKE = 14;
const GAUGE_PAD = 4;
const GAUGE_WIDTH = 2 * GAUGE_RADIUS + GAUGE_STROKE + 2 * GAUGE_PAD;
const GAUGE_CX = GAUGE_WIDTH / 2;
const GAUGE_CY = GAUGE_RADIUS + GAUGE_STROKE / 2 + GAUGE_PAD;
/* The round cap at nine and three o'clock hangs half a stroke below the pivot. */
const GAUGE_HEIGHT = GAUGE_CY + GAUGE_STROKE / 2 + GAUGE_PAD;
/** Nine o'clock, over the top, to three o'clock — one path, drawn clockwise. */
const GAUGE_ARC = `M ${GAUGE_CX - GAUGE_RADIUS} ${GAUGE_CY} A ${GAUGE_RADIUS} ${GAUGE_RADIUS} 0 0 1 ${GAUGE_CX + GAUGE_RADIUS} ${GAUGE_CY}`;
const GAUGE_LENGTH = Math.PI * GAUGE_RADIUS;

/**
 * A 180° GAUGE — the brief's "arc from 9 o'clock over the top to 3 o'clock,
 * round caps, full-arc muted track".
 *
 * The value sits INSIDE the arc, where the reference puts it: unlike the
 * shared speedometer there is no needle sweeping through the middle, so the
 * middle is free. `fraction` is the share the arc fills and `value` what it
 * prints — they differ on purpose: "9 jobs" over an arc filled to the 13% of
 * the backlog those nine are.
 *
 * An arc of nothing draws only its track. A zero-length dash with a round cap
 * is painted as a dot, and a dot on a gauge reads as a value.
 */
export function OiGauge({
  fraction,
  value,
  unit,
  caption,
  sub,
  colour,
  ariaLabel,
  onSelect,
}: {
  /** 0–1, or null when there is nothing to measure. */
  fraction: number | null;
  value: string;
  /** A unit printed smaller after the value — "jobs" — so a count fits the arc. */
  unit?: string;
  caption: string;
  sub?: string;
  colour: string;
  /** Names the gauge; the printed value, caption and sub are appended. */
  ariaLabel: string;
  onSelect?: () => void;
}): JSX.Element {
  const safe = fraction === null || !Number.isFinite(fraction) ? 0 : Math.max(0, Math.min(1, fraction));
  const [eased = 0] = useOvSweep([safe]);
  const drawn = eased * GAUGE_LENGTH;

  const body = (
    <span className="oi-gauge__body">
      <span className="oi-gauge__dial">
        <svg
          className="oi-gauge__svg"
          viewBox={`0 0 ${GAUGE_WIDTH} ${GAUGE_HEIGHT}`}
          width={GAUGE_WIDTH}
          height={GAUGE_HEIGHT}
          aria-hidden="true"
          focusable="false"
        >
          <path
            className="oi-gauge__track"
            d={GAUGE_ARC}
            fill="none"
            stroke="var(--ov-track)"
            strokeWidth={GAUGE_STROKE}
            strokeLinecap="round"
          />
          {drawn > 0.5 ? (
            <path
              className="oi-gauge__arc"
              d={GAUGE_ARC}
              fill="none"
              stroke={colour}
              strokeWidth={GAUGE_STROKE}
              strokeLinecap="round"
              strokeDasharray={`${drawn} ${GAUGE_LENGTH + GAUGE_STROKE}`}
            />
          ) : null}
        </svg>
        <span className="oi-gauge__readout" aria-hidden="true">
          <strong className="oi-gauge__value">
            {value}
            {unit ? <span className="oi-gauge__unit"> {unit}</span> : null}
          </strong>
          <span className="oi-gauge__caption">{caption}</span>
        </span>
      </span>
      {sub ? (
        <span className="oi-gauge__sub" aria-hidden="true">
          {sub}
        </span>
      ) : null}
    </span>
  );

  const label = `${ariaLabel}: ${value}${unit ? ` ${unit}` : ""}, ${caption}${sub ? `. ${sub}` : ""}`;
  return onSelect ? (
    <button type="button" className="oi-gauge oi-gauge--button" aria-label={label} onClick={onSelect}>
      {body}
    </button>
  ) : (
    <span className="oi-gauge" role="img" aria-label={label}>
      {body}
    </span>
  );
}

/* ── 3. The bar list, with "View all" ─────────────────────────────────────── */

export type OiBarRow = {
  key: string;
  label: string;
  value: number;
  /** How the value prints — a count, or pounds. */
  valueText: string;
  colour: string;
  /** Both, or neither: a row with a list behind it is a link. */
  href?: string;
  onActivate?: () => void;
  /** The row's accessible name. */
  ariaLabel: string;
};

/**
 * A HORIZONTAL BAR PER ROW — label and value on one line, the bar under both —
 * with the first `visible` rows shown and a "View all (N)" toggle for the rest.
 *
 * The leader fills its track and every other bar is drawn against it, so the
 * picture uses its full width whether the leader counts four or four hundred.
 * Each row's accessible name carries its share of the WHOLE list, so nothing
 * is read as a share of the leader.
 *
 * The toggle is component state, not the address bar: it changes no figure,
 * and a key this page wrote into the query string would ride every drill.
 */
export function OiBarList({
  rows,
  visible,
  ariaLabel,
  emptyText,
  noun,
}: {
  rows: readonly OiBarRow[];
  visible: number;
  ariaLabel: string;
  emptyText: string;
  /** What a row is, for the toggle's name — "engineer types", "sites". */
  noun: string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const values = rows.map((row) => Math.max(0, Number.isFinite(row.value) ? row.value : 0));
  const leader = values.length > 0 ? Math.max(...values) : 0;
  const eased = useOvSweep(values.map((value) => ovFraction(value, leader)));

  if (rows.length === 0) {
    return (
      <div className="oi-bars oi-bars--empty" role="img" aria-label={`${ariaLabel}: ${emptyText}`}>
        <p className="oi-note" aria-hidden="true">
          {emptyText}
        </p>
      </div>
    );
  }

  const shown = expanded ? rows : rows.slice(0, visible);
  return (
    <div className="oi-bars" role="group" aria-label={ariaLabel}>
      {shown.map((row, index) => {
        const style = {
          "--oi-bar": row.colour,
          width: `${(eased[index] ?? 0) * 100}%`,
        } as CSSProperties;
        const inner = (
          <>
            <span className="oi-bars__label">{row.label}</span>
            <span className="oi-bars__value">{row.valueText}</span>
            <span className="oi-bars__track" aria-hidden="true">
              {/* No fill at all for a zero: its glow would sit on the track as a pip. */}
              {values[index] > 0 ? <span className="oi-bars__fill" style={style} /> : null}
            </span>
          </>
        );
        return row.href && row.onActivate ? (
          <OiLink
            key={row.key}
            className="oi-bars__row"
            href={row.href}
            label={row.ariaLabel}
            onActivate={row.onActivate}
          >
            {inner}
          </OiLink>
        ) : (
          <div key={row.key} className="oi-bars__row" role="img" aria-label={row.ariaLabel}>
            {inner}
          </div>
        );
      })}
      {rows.length > visible ? (
        <button
          type="button"
          className="oi-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? `Show the top ${visible}` : `View all (${oiCount(rows.length)})`}
          <span className="visually-hidden"> {noun}</span>
        </button>
      ) : null}
    </div>
  );
}

/* ── 4. Target bars ───────────────────────────────────────────────────────── */

export type OiTargetRow = {
  key: string;
  label: string;
  jobs: number;
  /** Whole percent, or null when the row has nothing to measure. */
  percent: number | null;
  colour: string;
  href?: string;
  onActivate?: () => void;
  ariaLabel: string;
};

/**
 * ONE BAR PER ROW, WITH A MARKER AT THE TARGET — "High · 42 jobs" on the
 * left, the percentage on the right, the bar filled to the percentage and a
 * thin line standing through the track at `target`.
 *
 * A row with no jobs prints "—" and draws an empty track: an empty bar at 0%
 * would read as a failing priority when there is simply nothing in it.
 */
export function OiTargetBars({
  rows,
  target,
  ariaLabel,
}: {
  rows: readonly OiTargetRow[];
  target: number;
  ariaLabel: string;
}): JSX.Element {
  const eased = useOvSweep(rows.map((row) => (row.percent === null ? 0 : ovFraction(row.percent, 100))));
  const marker = Math.max(0, Math.min(100, Number.isFinite(target) ? target : 0));
  return (
    <div className="oi-targets" role="group" aria-label={ariaLabel}>
      {rows.map((row, index) => {
        const inner = (
          <>
            <span className="oi-targets__head">
              <span className="oi-targets__label">
                {row.label}
                <span className="oi-targets__jobs"> · {`${oiCount(row.jobs)} ${row.jobs === 1 ? "job" : "jobs"}`}</span>
              </span>
              <span className="oi-targets__value">{row.percent === null ? "—" : `${row.percent}%`}</span>
            </span>
            <span className="oi-targets__track" aria-hidden="true">
              {row.percent !== null && row.percent > 0 ? (
                <span
                  className="oi-targets__fill"
                  style={{ "--oi-bar": row.colour, width: `${(eased[index] ?? 0) * 100}%` } as CSSProperties}
                />
              ) : null}
              <span className="oi-targets__marker" style={{ left: `${marker}%` }} />
            </span>
          </>
        );
        return row.href && row.onActivate ? (
          <OiLink
            key={row.key}
            className="oi-targets__row"
            href={row.href}
            label={row.ariaLabel}
            onActivate={row.onActivate}
          >
            {inner}
          </OiLink>
        ) : (
          <div key={row.key} className="oi-targets__row" role="img" aria-label={row.ariaLabel}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}

/* ── 5. The weekly sparkline ──────────────────────────────────────────────── */

export type OiWeekBar = {
  key: string;
  label: string;
  /** The week's figure, or null for a week with nothing in it. */
  value: number | null;
  jobs: number;
};

/**
 * SEVEN BARS, ONE A WEEK, oldest first — the average for each week against
 * the tallest of them.
 *
 * A week with nothing closed is a flat stub on the floor, not a missing bar:
 * the gap is a fact about the week, and a row of six bars would read as a
 * chart that lost one. The latest week with a figure is drawn in the accent,
 * the rest in the muted tone. Each bar carries a `title` naming its week, its
 * figure and its jobs; the whole row is one picture with every value in its
 * accessible name.
 */
export function OiWeekBars({
  weeks,
  format,
  ariaLabel,
  onSelect: onSelectProp,
}: {
  weeks: readonly OiWeekBar[];
  format: (value: number) => string;
  ariaLabel: string;
  /**
   * Opens the jobs closed in a week. When given, every week that closed
   * anything is a button over its whole column — a bar a few pixels high is
   * still a full-height target — and the row is a group of named controls
   * rather than one picture.
   */
  onSelect?: (index: number) => void;
}): JSX.Element {
  /*
   * A precise pointer only. Seven weeks share a card a phone draws 250px wide,
   * so a week is ~30px — under the 44px a finger needs. On touch the row is a
   * labelled picture, and the card's own figure above it opens every job the
   * range closed.
   */
  const precise = useOvHoverCapable();
  const onSelect = precise ? onSelectProp : undefined;
  const values = weeks.map((week) =>
    week.value === null || !Number.isFinite(week.value) ? 0 : Math.max(0, week.value),
  );
  const tallest = values.length > 0 ? Math.max(...values) : 0;
  const eased = useOvSweep(values.map((value) => ovFraction(value, tallest)));
  let latest = -1;
  for (let index = weeks.length - 1; index >= 0; index -= 1) {
    if (weeks[index].value !== null) {
      latest = index;
      break;
    }
  }
  const readout = weeks
    .map((week) =>
      week.value === null
        ? `${week.label}: nothing closed`
        : `${week.label}: ${format(week.value)} over ${oiCount(week.jobs)} ${week.jobs === 1 ? "job" : "jobs"}`,
    )
    .join("; ");

  const bar = (week: OiWeekBar, index: number, title: string) => (
    <span
      className={`oi-weeks__bar${week.value === null ? " oi-weeks__bar--empty" : ""}${index === latest ? " oi-weeks__bar--latest" : ""}`}
      style={week.value === null ? undefined : { height: `${Math.max(12, (eased[index] ?? 0) * 100)}%` }}
      title={onSelect ? undefined : title}
      aria-hidden={onSelect ? true : undefined}
    />
  );

  return (
    <div
      className={`oi-weeks${onSelect ? " oi-weeks--interactive" : ""}`}
      role={onSelect ? "group" : "img"}
      aria-label={`${ariaLabel}. ${readout}`}
    >
      {weeks.map((week, index) => {
        const empty = week.value === null;
        const title = empty
          ? `${week.label} · nothing closed`
          : `${week.label} · ${format(week.value ?? 0)} · ${oiCount(week.jobs)} ${week.jobs === 1 ? "job" : "jobs"}`;
        if (onSelect && !empty) {
          return (
            <button
              key={week.key}
              type="button"
              className="oi-weeks__col"
              title={title}
              aria-label={`${title}. Opens the jobs closed that week.`}
              onClick={() => onSelect(index)}
            >
              {bar(week, index, title)}
            </button>
          );
        }
        return onSelect ? (
          <span key={week.key} className="oi-weeks__col" title={title}>
            {bar(week, index, title)}
          </span>
        ) : (
          <span key={week.key} className="oi-weeks__cell">
            {bar(week, index, title)}
          </span>
        );
      })}
    </div>
  );
}

/* ── 6. The legend ────────────────────────────────────────────────────────── */

export type OiLegendRow = {
  key: string;
  label: string;
  valueText: string;
  colour: string;
  href?: string;
  onActivate?: () => void;
  ariaLabel: string;
};

/**
 * A donut's legend: dot, name, value — each row a link to the list behind its
 * segment where there is one, so every segment is reachable without a pointer.
 */
export function OiLegend({ rows, className }: { rows: readonly OiLegendRow[]; className?: string }): JSX.Element {
  return (
    <div className={`oi-legend${className ? ` ${className}` : ""}`}>
      {rows.map((row) => {
        const inner = (
          <>
            <span
              className="oi-legend__dot"
              style={{ "--oi-dot": row.colour } as CSSProperties}
              aria-hidden="true"
            />
            <span className="oi-legend__label">{row.label}</span>
            <span className="oi-legend__value">{row.valueText}</span>
          </>
        );
        return row.href && row.onActivate ? (
          <OiLink
            key={row.key}
            className="oi-legend__row"
            href={row.href}
            label={row.ariaLabel}
            onActivate={row.onActivate}
          >
            {inner}
          </OiLink>
        ) : (
          <div key={row.key} className="oi-legend__row" role="img" aria-label={row.ariaLabel}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}

/** "12 of 87, 14%" — the share a legend row or a ring states in its accessible name. */
export function oiShare(value: number, total: number): string {
  return `${oiCount(value)} of ${oiCount(total)}, ${ovPercent(value, total)}%`;
}
