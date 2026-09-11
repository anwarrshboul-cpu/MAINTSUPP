"use client";

/**
 * THE DASHBOARD BLOCKS' HEADER ROW — title left; portfolio, date range and
 * Export right. One component for the three blocks (Overview, Compliance,
 * Reports), because the three briefs specify the same row in the same words:
 *
 *   "Right: `All portfolios ▾` filter, date range picker (`12 May – 11 Jun
 *    2026` format, en-GB), `Export` button. Controls: transparent background,
 *    1px `--ov-card-border`, radius 8px, 12px text."
 *
 * The Overview drew this row inline, and measured against its reference it
 * drifted three ways: the portfolio select sat inside a bordered label AND drew
 * its own border (two boxes, one inside the other); the date range was a bare
 * `<details>` whose disclosure triangle printed beside the calendar and pushed
 * the dates onto a second line; and the funnel, chevron and export glyphs the
 * reference shows were missing. Drawn once here, the three blocks match the
 * reference and each other.
 *
 * WHAT IT DOES NOT DO: compute. The range LABEL is the server's — each block's
 * endpoint echoes the window it actually counted, in the brief's format — so
 * this row never does date arithmetic in the reader's timezone.
 */

import { type ReactNode } from "react";

export type DashRange = { from: string; to: string; label: string };

export function DashHeader({
  title,
  portfolio,
  portfolios,
  onPortfolio,
  range,
  onRange,
  resetLabel,
  rangeCaption,
  onExport,
  exportHref,
  exportDisabled,
  error,
  onRetry,
  extra,
}: {
  title: string;
  /** The chosen portfolio id, "" for all. */
  portfolio: string;
  portfolios: { id: string; name: string }[];
  onPortfolio: (id: string) => void;
  /** The window on screen: the two bounds the picker holds, and the server's label for it. */
  range: DashRange;
  onRange: (from: string, to: string) => void;
  /** The reset button's words — "Reset to the last 30 days", "Any due date". */
  resetLabel: string;
  /** A sentence inside the picker saying what the range filters, when that is not obvious. */
  rangeCaption?: string;
  /** A client-built export (the Overview's). */
  onExport?: () => void;
  /** A server-built export: a real link, so the browser's own download handles it. */
  exportHref?: string;
  exportDisabled?: boolean;
  /** A refetch that failed while figures are still on screen. */
  error?: string | null;
  onRetry?: () => void;
  extra?: ReactNode;
}) {
  return (
    <div className="ov-dash__head">
      <h2 className="ov-dash__title">{title}</h2>
      <div className="ov-dash__controls">
        <label className="ov-dash__control ov-dash__control--select">
          <FunnelIcon />
          <span className="visually-hidden">Portfolio</span>
          <select value={portfolio} onChange={(event) => onPortfolio(event.target.value)}>
            <option value="">All portfolios</option>
            {portfolios.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>

        <details className="ov-dash__control ov-dash__range">
          <summary aria-label={`Date range: ${range.label}`}>
            <CalendarIcon />
            <span className="ov-dash__range-label">{range.label}</span>
            <ChevronIcon />
          </summary>
          <div className="ov-dash__range-panel">
            {rangeCaption ? <p className="ov-dash__range-caption">{rangeCaption}</p> : null}
            <label>
              <span>From</span>
              <input
                type="date"
                value={range.from}
                onChange={(event) => onRange(event.target.value, range.to)}
              />
            </label>
            <label>
              <span>To</span>
              <input
                type="date"
                value={range.to}
                onChange={(event) => onRange(range.from, event.target.value)}
              />
            </label>
            <button type="button" className="ov-dash__range-reset" onClick={() => onRange("", "")}>
              {resetLabel}
            </button>
          </div>
        </details>

        {exportHref && !exportDisabled ? (
          <a className="ov-dash__control ov-dash__export" href={exportHref} download>
            <ExportIcon />
            <span>Export</span>
          </a>
        ) : (
          <button
            type="button"
            className="ov-dash__control ov-dash__export"
            onClick={onExport}
            disabled={exportDisabled || (!onExport && !exportHref)}
          >
            <ExportIcon />
            <span>Export</span>
          </button>
        )}

        {extra}

        {error && onRetry ? (
          <button type="button" className="ov-dash__control" onClick={onRetry} title={error}>
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}

const ICON = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: "false" as const,
};

function FunnelIcon() {
  return (
    <svg {...ICON} className="ov-dash__icon">
      <path d="M4 5h16l-6.2 7.4V19l-3.6-1.8v-4.8L4 5Z" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg {...ICON} className="ov-dash__icon">
      <rect x="3.5" y="5" width="17" height="16" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg {...ICON} width={12} height={12} className="ov-dash__icon ov-dash__icon--chevron">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg {...ICON} className="ov-dash__icon">
      <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14" />
    </svg>
  );
}
