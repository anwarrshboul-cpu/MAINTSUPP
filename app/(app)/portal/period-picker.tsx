"use client";

/**
 * The reporting period control.
 *
 * WHAT IT IS
 *
 * One `<select>` naming every shape of period the owner asked for, plus a
 * second field when the chosen shape needs an argument — a month, a year, a
 * date, or the two ends of a custom range. The maths lives in period-model.ts
 * with no React in it; this file is the control and nothing else, so what the
 * period *means* stays assertable without rendering a page.
 *
 * WHY THE SECOND FIELD IS A NATIVE INPUT
 *
 * `<input type="month">` and `<input type="date">` bring the platform's own
 * picker, its keyboard handling and its locale. A hand-built calendar popover
 * would be several hundred lines that have to be re-tested against a screen
 * reader and a phone, to arrive at the control the phone already has.
 *
 * WHY AN UNFINISHED RANGE IS NOT AN EMPTY PERIOD
 *
 * Clear one end of a custom range and the token stops describing a window. The
 * screen must not answer that with "nothing in this period" — that is a claim
 * about the portfolio, and the truthful answer is a claim about the control.
 * `resolvePeriod` returns `recognised: false` with a reason, `PeriodCaption`
 * prints it, and the panels draw nothing until the reader finishes the range.
 */

import { useCallback, useSyncExternalStore } from "react";
import { Icon } from "../../components";
import {
  dateToken,
  monthToken,
  periodOptionGroups,
  periodRangeParts,
  periodArgument,
  periodSelectValue,
  periodShape,
  rangeToken,
  resolvePeriod,
  startOfDay,
  yearToken,
  type PeriodShape,
  type SortDirection,
} from "./period-model";

/* ── Local ISO helpers ───────────────────────────────────────────────────── */

/*
 * `toISOString()` is not usable here. It converts to UTC first, so a local
 * midnight in British Summer Time comes back as 23:00 on the day before, and
 * the date field would open one day behind the window the page is showing.
 * These build the string from the local parts the window was built from.
 */

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function isoDay(ms: number) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function isoMonth(ms: number) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

/**
 * What a newly chosen shape should start on.
 *
 * Choosing "A specific month…" and being shown an error until you also fill in
 * the month is a control arguing with its user. It opens on the current month,
 * which is both a real answer and the one most likely wanted; the reader then
 * changes it. A custom range opens on this month so far, for the same reason.
 */
function defaultToken(shape: PeriodShape, now: number) {
  switch (shape) {
    case "month":
      return monthToken(isoMonth(now));
    case "year":
      return `year:${new Date(now).getFullYear()}`;
    case "date":
      return dateToken(isoDay(now));
    case "range": {
      const first = new Date(now);
      first.setDate(1);
      return rangeToken(isoDay(startOfDay(first.getTime())), isoDay(now));
    }
    default:
      return "";
  }
}

/* ── The control ─────────────────────────────────────────────────────────── */

export function PeriodPicker({
  value,
  onChange,
  now,
}: {
  value: string;
  onChange: (next: string) => void;
  now: number;
}) {
  const shape = periodShape(value);
  const range = periodRangeParts(value);
  const argument = periodArgument(value);

  const choose = (next: string) => {
    const nextShape = periodShape(next);
    onChange(nextShape === "preset" ? next : defaultToken(nextShape, now));
  };

  return (
    <>
      <label className="analytics-period">
        <Icon name="calendar" size={17} />
        <select
          aria-label="Reporting period"
          value={periodSelectValue(value)}
          onChange={(event) => choose(event.target.value)}
        >
          {periodOptionGroups.map((group) => (
            <optgroup label={group.label} key={group.label}>
              {group.options.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      {shape === "month" && (
        <label className="analytics-period analytics-period--argument">
          <input
            type="month"
            aria-label="Month to report on"
            value={argument}
            onChange={(event) => onChange(monthToken(event.target.value))}
          />
        </label>
      )}

      {shape === "year" && (
        <label className="analytics-period analytics-period--argument">
          <input
            type="number"
            aria-label="Year to report on"
            min={2000}
            max={new Date(now).getFullYear() + 1}
            step={1}
            value={argument}
            onChange={(event) => onChange(yearToken(event.target.value))}
          />
        </label>
      )}

      {shape === "date" && (
        <label className="analytics-period analytics-period--argument">
          <input
            type="date"
            aria-label="Date to report on"
            value={argument}
            onChange={(event) => onChange(dateToken(event.target.value))}
          />
        </label>
      )}

      {shape === "range" && (
        <>
          <label className="analytics-period analytics-period--argument">
            <input
              type="date"
              aria-label="Range start date"
              value={range.from}
              onChange={(event) => onChange(rangeToken(event.target.value, range.to))}
            />
          </label>
          <label className="analytics-period analytics-period--argument">
            <input
              type="date"
              aria-label="Range end date"
              value={range.to}
              onChange={(event) => onChange(rangeToken(range.from, event.target.value))}
            />
          </label>
        </>
      )}
    </>
  );
}

/**
 * The window in words, under the heading.
 *
 * A period control that only shows "Last quarter" leaves the reader guessing
 * which three months that was, and every figure on the screen depends on the
 * answer. This prints the dates actually applied, and how many work orders fell
 * inside them — so an empty period reads as "nothing in this period" against a
 * named window, never as a £0 that looks like a result.
 */
export function PeriodCaption({
  period,
  now,
  matched,
  noun = "work orders",
  loading = false,
}: {
  period: string;
  now: number;
  matched: number;
  noun?: string;
  /**
   * Whether the rows counted above have actually arrived yet.
   *
   * Without this the caption read "Nothing in this period — no work orders
   * were raised" for the whole of the first load, because `matched` is 0
   * before the fetch resolves exactly as it is for a genuinely empty quarter.
   * One of those is a finding about the portfolio and the other is a statement
   * about the network, and a reporting screen must not present the second as
   * the first. Overview learned this for its workspace tiles in Stage 19 and
   * the wording of that lesson still stands: loading and empty are different
   * states.
   */
  loading?: boolean;
}) {
  const window = resolvePeriod(period, now);
  if (!window.recognised) {
    return (
      <p className="analytics-period-caption analytics-period-caption--unset">
        <Icon name="calendar" size={14} />
        {window.reason}
      </p>
    );
  }
  return (
    <p className="analytics-period-caption">
      <Icon name="calendar" size={14} />
      <strong>{window.label}</strong>
      <span aria-live={loading ? "polite" : undefined}>
        {loading
          ? `Counting ${noun}…`
          : matched
            ? `${matched.toLocaleString("en-GB")} ${noun}`
            : `Nothing in this period — no ${noun} were raised`}
      </span>
    </p>
  );
}

/* ── Sort direction ──────────────────────────────────────────────────────── */

/**
 * The sort choice, kept where this product already keeps view preferences.
 *
 * There is no server-side preference store for arbitrary settings — the only
 * one that exists, `/api/dashboard-layout`, records panel order and hidden-ness
 * and nothing else, and widening it means changing an API route this work does
 * not own. `localStorage` under a `maintsupp:` key is the mechanism the board
 * already uses for collapsed groups and the theme, so this follows it. That
 * makes the choice per person per browser, not per account: the same user on a
 * second device gets the default back. Said plainly rather than implied.
 *
 * Read in an effect rather than in `useState`, so the server-rendered markup
 * and the first client render agree.
 */
const sortListeners = new Set<() => void>();

/**
 * The choice for this session, whether or not storage accepted it.
 *
 * Private browsing and blocked storage both make `setItem` throw. Without this
 * the control would appear to do nothing at all in those browsers — the click
 * would write nowhere and the snapshot would keep reading the default back.
 */
const sortMemory = new Map<string, SortDirection>();

function subscribeToSort(onChange: () => void) {
  sortListeners.add(onChange);
  // `storage` fires only in OTHER tabs, so same-tab writes are announced
  // through the listener set. Both feed one subscribe/snapshot pair.
  window.addEventListener("storage", onChange);
  return () => {
    sortListeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useStoredSortDirection(
  key: string,
  fallback: SortDirection = "desc",
): [SortDirection, (next: SortDirection) => void] {
  /*
   * `localStorage` is an external store, so it is read through the hook meant
   * for one rather than copied into state by an effect — the same pattern
   * theme-toggle.tsx uses, and for the same two reasons: the server render and
   * the first client render agree, and there is no cascading re-render.
   */
  const read = useCallback((): SortDirection => {
    const remembered = sortMemory.get(key);
    if (remembered) return remembered;
    try {
      const saved = window.localStorage.getItem(key);
      if (saved === "asc" || saved === "desc") return saved;
    } catch {
      // Storage unavailable. The default still sorts, so nothing breaks.
    }
    return fallback;
  }, [fallback, key]);

  const readOnServer = useCallback(() => fallback, [fallback]);

  const direction = useSyncExternalStore(subscribeToSort, read, readOnServer);

  const choose = useCallback(
    (next: SortDirection) => {
      sortMemory.set(key, next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        // Kept in memory above, so the control still works for this session.
      }
      for (const listener of sortListeners) listener();
    },
    [key],
  );

  return [direction, choose];
}

export function SortDirectionSelect({
  value,
  onChange,
  label,
  highLabel = "Highest first",
  lowLabel = "Lowest first",
}: {
  value: SortDirection;
  onChange: (next: SortDirection) => void;
  label: string;
  highLabel?: string;
  lowLabel?: string;
}) {
  return (
    <label className="analytics-inline-select">
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value === "asc" ? "asc" : "desc")}
      >
        <option value="desc">{highLabel}</option>
        <option value="asc">{lowLabel}</option>
      </select>
    </label>
  );
}
