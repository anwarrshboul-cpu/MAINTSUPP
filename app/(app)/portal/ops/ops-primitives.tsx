"use client";

/**
 * THE SIX PIECES THE FOUR OPERATIONS PAGES ARE DRAWN FROM.
 *
 * Overview, Compliance, Sites and Contractors were built at different times and
 * each grew its own meter, its own chip and its own row. That is why the same
 * store could be amber on one page and green on the next, and why "9 SHOWN, 22
 * HIDDEN" was shouting on one screen while every other label was sentence case.
 *
 * These are deliberately small and deliberately few. It is not a design system;
 * it is the shortest list of shapes that lets four pages agree.
 *
 * ── TOKENS, NOT HEX ────────────────────────────────────────────────────────
 *
 * The briefs specify a dark palette by hex — `--surface-page #0B1620`,
 * `--surface-card #16232E`, and so on. This product already has that palette,
 * under its own names, defined per theme in `app/globals.css`:
 *
 *     brief                app                dark value
 *     --surface-page       --canvas           #0b1218
 *     --surface-card       --surface-card     #182830
 *     --surface-raised     --surface-hover    #203740
 *     --border-subtle      --line             #2a3943
 *     --text-primary       --ink              #e7eef3
 *     --text-muted         --muted            #9baeb9
 *     --accent             --accent-fg        #5fd6cd
 *
 * The values agree to within a shade. Writing the brief's literals instead
 * would have pinned these four pages to dark and left them unreadable for the
 * people using the light theme, which is a real setting with a real toggle. So
 * the tokens are used and the mapping is recorded here.
 *
 * SEMANTIC colours — priority, family, ageing, compliance — ARE literals, and
 * they come from `job-metrics.ts` and `compliance-status.ts` rather than from
 * CSS, because they must be identical in both themes and because the same
 * values are needed by the API payloads.
 *
 * ── COLOUR IS NEVER THE ONLY CARRIER ──────────────────────────────────────
 *
 * Every meter here takes a `readout` — the numbers in words — and renders it
 * into a visually hidden element as well as onto the `aria-label`. A segmented
 * bar with no text is a picture of a number, and a screen reader gets nothing
 * from a picture.
 */

import { useId, type ReactNode } from "react";
import { Icon } from "../../../components";

/* ── Meters ───────────────────────────────────────────────────────────────── */

export type Segment = {
  key: string;
  label: string;
  value: number;
  colour: string;
  /** Optional, for the hatched treatment on a period still in progress. */
  hatched?: boolean;
};

/**
 * A proportional bar split into named segments.
 *
 * Zero-value segments are KEPT in the accessible readout and dropped from the
 * drawing, which is the only way round that works: a 0px-wide div still takes a
 * border and a gap, so a five-segment bar with three zeros renders three
 * hairlines that look like data. The numbers stay reachable; only the paint
 * goes away.
 */
export function SegmentedMeter({
  segments,
  total,
  height = 10,
  label,
  onSelect,
}: {
  segments: Segment[];
  /** Explicit, so a bar can be scaled against something bigger than its parts. */
  total?: number;
  height?: number;
  label: string;
  onSelect?: (segment: Segment) => void;
}) {
  const sum = total ?? segments.reduce((count, segment) => count + segment.value, 0);
  const readout = segments
    .map((segment) => `${segment.label} ${segment.value}`)
    .join(", ");
  return (
    <div className="ops-meter" role="img" aria-label={`${label}: ${readout}`}>
      <div className="ops-meter__track" style={{ height }}>
        {sum > 0 ? (
          segments
            .filter((segment) => segment.value > 0)
            .map((segment) => {
              const width = `${(segment.value / sum) * 100}%`;
              const style = {
                width,
                background: segment.colour,
              } as const;
              return onSelect ? (
                <button
                  key={segment.key}
                  type="button"
                  className={`ops-meter__fill${segment.hatched ? " is-hatched" : ""}`}
                  style={style}
                  title={`${segment.label}: ${segment.value}`}
                  onClick={() => onSelect(segment)}
                >
                  <span className="visually-hidden">
                    {segment.label}: {segment.value}
                  </span>
                </button>
              ) : (
                <span
                  key={segment.key}
                  className={`ops-meter__fill${segment.hatched ? " is-hatched" : ""}`}
                  style={style}
                  title={`${segment.label}: ${segment.value}`}
                />
              );
            })
        ) : (
          <span className="ops-meter__empty" />
        )}
      </div>
    </div>
  );
}

/**
 * A single-value bar against a maximum.
 *
 * `tone` paints the fill and is always accompanied by `value` in words. The
 * track stays visible at zero so "no jobs here" reads as a measured zero rather
 * than as a missing component.
 */
export function ProgressMeter({
  value,
  max,
  tone,
  label,
  height = 8,
}: {
  value: number;
  max: number;
  tone: string;
  label: string;
  height?: number;
}) {
  const share = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="ops-meter" role="img" aria-label={label}>
      <div className="ops-meter__track" style={{ height }}>
        <span className="ops-meter__fill" style={{ width: `${share}%`, background: tone }} />
      </div>
    </div>
  );
}

/**
 * A radial gauge for a share, with the value in the middle.
 *
 * Inline SVG rather than a chart library. The whole shape is one circle, one
 * arc and a number; pulling in a charting dependency to draw it would add a
 * bundle for something `stroke-dasharray` already does, and this product has no
 * chart library to reuse (see the audit in the final report).
 */
export function RadialMeter({
  value,
  max,
  tone,
  centre,
  caption,
  label,
  size = 92,
}: {
  value: number;
  max: number;
  tone: string;
  centre: string;
  caption?: string;
  label: string;
  size?: number;
}) {
  const stroke = 9;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const share = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div className="ops-radial" role="img" aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--line)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={tone}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * share} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="ops-radial__centre">
        <strong>{centre}</strong>
        {caption ? <small>{caption}</small> : null}
      </span>
    </div>
  );
}

/* ── Chips ────────────────────────────────────────────────────────────────── */

/**
 * A status word with its colour, never a colour on its own.
 *
 * `tone` is a hex from one of the two shared status modules. The dot carries
 * the colour and the text carries the meaning, so the chip survives a
 * greyscale print, a colour-blind reader and a screenshot.
 */
export function StatusChip({
  tone,
  children,
  title,
  size = "regular",
}: {
  tone: string;
  children: ReactNode;
  title?: string;
  size?: "regular" | "small";
}) {
  return (
    <span
      className={`ops-chip${size === "small" ? " ops-chip--small" : ""}`}
      title={title}
    >
      <span className="ops-chip__dot" style={{ background: tone }} aria-hidden="true" />
      {children}
    </span>
  );
}

/** A removable filter chip. The `×` is a real button with a real name. */
export function FilterChip({
  label,
  value,
  onRemove,
}: {
  label: string;
  value: string;
  onRemove: () => void;
}) {
  return (
    <span className="ops-filter-chip">
      <span className="ops-filter-chip__label">{label}</span>
      <span className="ops-filter-chip__value">{value}</span>
      <button type="button" onClick={onRemove} aria-label={`Remove filter ${label} ${value}`}>
        <Icon name="close" size={13} />
      </button>
    </span>
  );
}

/* ── Rows ─────────────────────────────────────────────────────────────────── */

/**
 * One job, one line, on every page that lists jobs.
 *
 * The Overview's attention card, a site's detail page and a contractor's job
 * list all draw this, which is what stops "days open" being computed three ways.
 * The days are handed in already computed by the server — see the header of
 * `dashboard-aggregates.ts` for why the browser is not allowed to work them out.
 */
export function CompactJobRow({
  title,
  reference,
  priorityLabel,
  priorityColour,
  status,
  statusColour,
  daysOpen,
  bandColour,
  onOpen,
}: {
  title: string;
  reference?: string | null;
  priorityLabel: string;
  priorityColour: string;
  status: string;
  statusColour: string;
  daysOpen: number;
  bandColour: string;
  onOpen?: () => void;
}) {
  const body = (
    <>
      <span className="ops-job-row__priority">
        <span
          className="ops-chip__dot"
          style={{ background: priorityColour }}
          aria-hidden="true"
        />
        <span className="visually-hidden">{priorityLabel} priority. </span>
      </span>
      <span className="ops-job-row__title">
        {title}
        {reference ? <small>{reference}</small> : null}
      </span>
      <StatusChip tone={statusColour} size="small">
        {status}
      </StatusChip>
      <span className="ops-job-row__age" style={{ color: bandColour, borderColor: bandColour }}>
        {daysOpen}d<span className="visually-hidden"> open</span>
      </span>
    </>
  );
  return onOpen ? (
    <button type="button" className="ops-job-row" onClick={onOpen}>
      {body}
    </button>
  ) : (
    <div className="ops-job-row">{body}</div>
  );
}

/* ── States ───────────────────────────────────────────────────────────────── */

/**
 * A skeleton shaped like the thing it is standing in for.
 *
 * Not a spinner. A spinner says "something is happening"; a skeleton says "this
 * is the shape of what is coming", and it stops the page reflowing when the
 * answer lands — which on a phone is the difference between reading a card and
 * chasing it up the screen.
 */
export function SkeletonRow({ lines = 3, height = 72 }: { lines?: number; height?: number }) {
  return (
    <div className="ops-skeleton" style={{ minHeight: height }} aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} className="ops-skeleton__line" />
      ))}
    </div>
  );
}

/**
 * What failed, and one button that tries again.
 *
 * No apology and no "something went wrong". The reader can act on "the site
 * list did not load"; they cannot act on a shrug.
 */
export function ErrorState({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div className="ops-error" role="alert">
      <p>{what}</p>
      <button type="button" className="secondary-button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="ops-empty">{children}</p>;
}

/* ── Accessible data tables ───────────────────────────────────────────────── */

/**
 * The same numbers as the chart beside it, as a real table, for a screen reader.
 *
 * Every meter and chart on these four pages has one. It is the only honest way
 * to make a bar chart accessible: an `aria-label` summarising a nine-segment
 * meter is a sentence nobody can navigate, while a table can be read cell by
 * cell in the reader's own order.
 */
export function HiddenDataTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: Array<Array<string | number>>;
}) {
  const id = useId();
  /*
   * The CLIP IS ON A WRAPPER, not on the table.
   *
   * `.visually-hidden` pins width to 1px with `overflow: hidden`, and that
   * works on a block box. A `display: table` box ignores it: the table lays
   * itself out to fit its widest row and `overflow` does not clip it, so the
   * hidden data table for eight contractors made the whole PAGE 494px wide at a
   * 390px viewport — a horizontal scrollbar caused by a thing added for screen
   * readers. Measured, not theorised. A `div` in front of it clips as intended
   * and the table inside is left to size itself.
   */
  return (
    <div className="visually-hidden">
    <table id={id}>
      <caption>{caption}</caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <th scope="col" key={column}>
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
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
  );
}

/* ── Card ─────────────────────────────────────────────────────────────────── */

/** The one card shell, so vertical rhythm is decided once. */
export function OpsCard({
  title,
  subtitle,
  action,
  children,
  id,
  className,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <section className={`ops-card${className ? ` ${className}` : ""}`} id={id}>
      <header className="ops-card__head">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p className="ops-card__subtitle">{subtitle}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

/* ── Money and words ──────────────────────────────────────────────────────── */

/**
 * Pounds. `maintenance_requests.cost` is a `real` holding POUNDS, never pence —
 * the one place in this product where money is not an integer of pence, because
 * it is monday's "Cost of Works" column exported as a number. A screen that
 * divided it by 100 once printed £425 for £42,540.
 */
export function money(pounds: number): string {
  return `£${Math.round(pounds).toLocaleString("en-GB")}`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** `4` / `2`, in words as well as in the arrow, or null when there is nothing to compare. */
export function deltaText(current: number, previous: number | null): string | null {
  if (previous === null) return null;
  const change = current - previous;
  if (change === 0) return "No change";
  return change > 0 ? `Up ${change}` : `Down ${Math.abs(change)}`;
}

/* ── Export ───────────────────────────────────────────────────────────────── */

/**
 * Download a table as CSV, from what is currently on screen.
 *
 * Client-side and deliberately so: the rows have already been fetched, filtered
 * and ordered by the server, and asking for them again through an export
 * endpoint would risk exporting a different set from the one the reader is
 * looking at — which is the one failure an export must not have.
 *
 * Every cell is quoted and internal quotes are doubled. A requirement name
 * containing a comma is ordinary in this data ("Fire Alarm, annual"), and an
 * unquoted export of it silently shifts every column after it.
 */
export function downloadCsv(
  filename: string,
  columns: string[],
  rows: Array<Array<string | number | null>>,
) {
  const cell = (value: string | number | null) =>
    `"${String(value ?? "").replace(/"/g, '""')}"`;
  const body = [
    columns.map(cell).join(","),
    ...rows.map((row) => row.map(cell).join(",")),
  ].join("\r\n");
  /*
   * The BOM is not decoration. Excel on Windows reads a bare UTF-8 CSV as the
   * system codepage, which turns every pound sign and every en dash in a site
   * name into mojibake on the client's own machine.
   */
  const blob = new Blob([`﻿${body}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${filename}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
