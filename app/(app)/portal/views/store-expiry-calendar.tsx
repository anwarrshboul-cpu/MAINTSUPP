"use client";

/**
 * Store Expiry Calendar — the Calendar tab of the Store Documentation UK board.
 *
 * monday's Calendar tab on this board is not a diary of work done, it is a
 * forward view of when certificates lapse: nine of the twelve document slots
 * carry an expiry date, and the point of plotting them is to see what is coming
 * and book a contractor before it runs out. RAMS, the Fire Risk Assessment and
 * the store Drawing have no expiry on monday, so they have no renewal to book
 * and never appear here — `storeDocumentationUndated` is the authority for that
 * rather than a list retyped in this file.
 *
 * WHY NOT `CalendarView` FROM `board-views.tsx`
 *
 * There is already a calendar in this app — `CalendarView`, the P4 tab on the
 * maintenance board. Its conventions are followed here deliberately: Monday
 * first, month cursor in state, prev/next around a month label, en-GB
 * formatting, entries as buttons that call back with the row, and a "+N more"
 * rather than an overflowing cell. What is not reused is the component itself,
 * because three of this board's requirements have no expression in it — an
 * overdue renewal must stay visible after its month has gone, the grid must be
 * keyboard navigable, and every entry has to name a store and a document rather
 * than a single title. Bending `CalendarView` to carry all three would have
 * changed the maintenance calendar for a reason that has nothing to do with it.
 *
 * OVERDUE
 *
 * A lapsed certificate is a live liability, and the month cursor is a
 * navigation state — navigating away from March must not make March's breaches
 * disappear. So overdue renewals are shown twice: on their real day in the
 * grid, and in a persistent rail above it that ignores the cursor entirely and
 * lists every renewal dated before today, oldest first, with who chases it. The
 * rail was chosen over the alternatives (rolling overdue items onto today, or
 * tinting the "previous month" button) because both of those lie about the
 * date, and the date is the thing an operator quotes to a contractor.
 *
 * TIMEZONE
 *
 * These are date-only values — `2026-04-06` means the sixth of April wherever
 * you are standing. The classic bug is `new Date("2026-04-06")`, which is
 * midnight UTC, printed through a local formatter as the fifth of April for
 * anyone west of Greenwich. Nothing here ever builds a `Date` from a board
 * string: dates are parsed by regex into an integer `YYYYMMDD`, all arithmetic
 * goes through `Date.UTC` and is read back with `getUTC*` only, and every
 * `Intl.DateTimeFormat` is pinned to `timeZone: "UTC"`. The one place the local
 * clock is read is deciding which day *today* is, which is a question about the
 * user's wall calendar and not about UTC.
 *
 * MULTI-TENANCY
 *
 * This component fetches nothing. Rows arrive from the board's own load, which
 * is `/api/board/items` behind `scopedDb`, so there is no second path into the
 * data and no way for this view to reach across organisations.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Icon, type IconName } from "../../../components";
import {
  storeDocumentationCertificates,
  storeDocumentationResponsibility,
  storeDocumentationUndated,
} from "../../../../db/monday-board-spec";
import {
  EXPIRY_DUE_SOON_DAYS,
  expiryStatus,
} from "../../../lib/expiry-status";
import type { BoardItem } from "./view-model";
import "./store-expiry-calendar.css";

/* ── Dates ───────────────────────────────────────────────────────────────── */

/**
 * A calendar day as the integer `YYYYMMDD`.
 *
 * A plain number, so days compare and sort without a `Date` anywhere near them.
 * Every conversion in this file goes through the four helpers below.
 */
type DayNumber = number;

/** A month as `year * 12 + monthIndex`, so stepping months is addition. */
type MonthCursor = number;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

function dayNumber(year: number, monthIndex: number, day: number): DayNumber {
  return year * 10_000 + (monthIndex + 1) * 100 + day;
}

function monthOf(day: DayNumber): MonthCursor {
  return Math.trunc(day / 10_000) * 12 + (Math.trunc(day / 100) % 100) - 1;
}

/** Midnight UTC for a day. Used for arithmetic and formatting, never for input. */
function utcOf(day: DayNumber): Date {
  return new Date(
    Date.UTC(
      Math.trunc(day / 10_000),
      (Math.trunc(day / 100) % 100) - 1,
      day % 100,
    ),
  );
}

function addDays(day: DayNumber, offset: number): DayNumber {
  const moved = utcOf(day);
  moved.setUTCDate(moved.getUTCDate() + offset);
  return dayNumber(moved.getUTCFullYear(), moved.getUTCMonth(), moved.getUTCDate());
}

/** Whole days from `from` to `to`. Both are midnight UTC, so this is exact. */
function daysBetween(from: DayNumber, to: DayNumber): number {
  return Math.round((utcOf(to).getTime() - utcOf(from).getTime()) / 86_400_000);
}

/**
 * Parses a board date cell.
 *
 * Only the date part is read, so a value that has grown a time or an offset
 * still lands on the day it names. The round-trip through `Date.UTC` rejects
 * impossible dates — `2026-02-31` normalises to March and so fails the check
 * rather than silently appearing on the wrong day.
 */
function parseIsoDay(value: string | null | undefined): DayNumber | null {
  if (typeof value !== "string") return null;
  const match = ISO_DATE.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, monthIndex, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== monthIndex ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return dayNumber(year, monthIndex, day);
}

/**
 * Which day it is for the person reading the screen.
 *
 * Read from the local clock on purpose: "is this certificate overdue?" is asked
 * against the user's own calendar. The fields are then carried as a
 * `DayNumber`, so nothing downstream can re-interpret them in another zone.
 */
function todayNumber(now: Date): DayNumber {
  return dayNumber(now.getFullYear(), now.getMonth(), now.getDate());
}

const MONTH_LABEL = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const LONG_DATE = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const SHORT_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});

function monthLabel(cursor: MonthCursor) {
  return MONTH_LABEL.format(
    new Date(Date.UTC(Math.floor(cursor / 12), cursor % 12, 1)),
  );
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/** "overdue by 12 days" / "due today" / "due in 5 days", from a day offset. */
function describeOffset(offset: number) {
  if (offset === 0) return "due today";
  if (offset < 0) return `overdue by ${plural(-offset, "day", "days")}`;
  return `due in ${plural(offset, "day", "days")}`;
}

/* ── Status ──────────────────────────────────────────────────────────────── */

/** What this view draws. Every value is an `ExpiryState` the classifier returns. */
type DrawnTone = "expired" | "due-soon" | "valid";

/*
 * THE WINDOW IS PRINTED FROM THE CONSTANT THAT DECIDES IT.
 *
 * This hint used to read `within ${DUE_SOON_DAYS} days` against a local
 * `const DUE_SOON_DAYS = 30`, while the classifier that actually put rows in
 * this bucket uses `EXPIRY_DUE_SOON_DAYS`, which is 60. So the rail labelled
 * its amber column "within 30 days" and filled it with certificates up to 60
 * days out — a reader checking a 45-day renewal against that hint would
 * conclude the calendar had put it in the wrong bucket.
 *
 * The old constant's docblock defended the 30 as `reminderDays: 30` from
 * planned maintenance. That is a maintenance REMINDER cadence, not a
 * certificate renewal window; the justification was about a different number
 * for a different thing. `EXPIRY_DUE_SOON_DAYS` carries the reasoning for this
 * one — the multi-week round trip of quoting, raising a PO and getting a
 * contractor on site — and it is the only number allowed to name this window.
 */
const TONES: Record<DrawnTone, { word: string; icon: IconName; hint: string }> = {
  expired: { word: "Overdue", icon: "alert", hint: "lapsed — book a contractor" },
  "due-soon": {
    word: "Due soon",
    icon: "clock",
    hint: `within ${EXPIRY_DUE_SOON_DAYS} days`,
  },
  valid: { word: "Renewal", icon: "calendar", hint: "in date, scheduled ahead" },
};

/**
 * The tone drawn for one renewal.
 *
 * `.state` OFF THE TYPED UNION, not a string sniffed out of the return value.
 *
 * This used to take `expiryStatus`'s answer as `unknown`, probe seven possible
 * field names for something string-shaped, then regex the result — and it had
 * to test /expired/ before /expiring/ because the two share a prefix, a hazard
 * that only exists because the value was being read as prose. `ExpiryState` is
 * a four-member union exported from `app/lib/expiry-status.ts` and has been all
 * along; reading it means the compiler checks this agreement instead of a
 * regular expression guessing at it, and a new state would be a type error here
 * rather than a silent fall-through to green.
 *
 * The date still overrules for anything already past: `not-recorded` cannot
 * reach this function (`buildEntries` skips a row with no readable date), and a
 * day in the past is overdue whatever else is said about it.
 */
function toneFor(day: DayNumber, today: DayNumber, iso: string): DrawnTone {
  if (day < today) return "expired";
  const state = expiryStatus(iso, utcOf(today)).state;
  return state === "expired" || state === "due-soon" ? state : "valid";
}

/* ── Model ───────────────────────────────────────────────────────────────── */

/** A board column, as `/api/board/columns` returns it. Only two fields are used. */
export type StoreExpiryColumn = { id: string; key: string };

/** One certificate renewal: a store, a document and the day it runs out. */
export type StoreExpiryEntry = {
  /** `${item.id}::${slot.key}` — stable for a React key. */
  id: string;
  /** The board row this came from, handed back untouched to `onOpenItem`. */
  item: BoardItem;
  /** The store name, which on this board is the row's title. */
  store: string;
  /** The document, in the register's vocabulary — `slot.label`. */
  document: string;
  /** Who chases this certificate, from the board capture. */
  responsibility: string;
  /** The date exactly as the board holds it. */
  iso: string;
  day: DayNumber;
  /** Signed day offset from today. Negative is overdue. */
  offset: number;
  tone: DrawnTone;
};

/** The nine slots that carry a date. The other three have nothing to plot. */
const DATED_SLOTS = storeDocumentationCertificates.filter(
  (slot) => slot.expiryColumn !== null,
);

const TONE_ORDER: Record<DrawnTone, number> = { expired: 0, "due-soon": 1, valid: 2 };

/**
 * Reads every dated document off every store row.
 *
 * `item.cells` is keyed by column *id*, not by column key — `view-model.ts`
 * records the bug where a view read it by key and silently found nothing. The
 * ids are per-organisation, so they arrive with the `columns` prop; the lookup
 * by key is kept as a fallback for callers that have already resolved them, and
 * a row whose date is absent or unreadable is skipped rather than guessed at.
 */
function buildEntries(
  items: BoardItem[],
  columns: StoreExpiryColumn[],
  today: DayNumber,
): StoreExpiryEntry[] {
  const idByKey = new Map(columns.map((column) => [column.key, column.id]));
  const entries: StoreExpiryEntry[] = [];

  for (const item of items) {
    if (item.archived) continue;
    for (const slot of DATED_SLOTS) {
      const key = slot.expiryColumn;
      if (!key) continue;
      const columnId = idByKey.get(key);
      const raw =
        (columnId ? item.cells?.[columnId] : undefined) ?? item.cells?.[key] ?? null;
      const day = parseIsoDay(raw);
      if (day === null) continue;

      const iso = `${Math.trunc(day / 10_000)}-${String(Math.trunc(day / 100) % 100).padStart(2, "0")}-${String(day % 100).padStart(2, "0")}`;
      entries.push({
        id: `${item.id}::${slot.key}`,
        item,
        store: item.title?.trim() || item.reference || "Untitled store",
        document: slot.label,
        responsibility:
          storeDocumentationResponsibility.get(slot.label) ?? slot.responsibility,
        iso,
        day,
        offset: daysBetween(today, day),
        tone: toneFor(day, today, iso),
      });
    }
  }

  entries.sort(
    (left, right) =>
      left.day - right.day ||
      TONE_ORDER[left.tone] - TONE_ORDER[right.tone] ||
      left.store.localeCompare(right.store, "en-GB") ||
      left.document.localeCompare(right.document, "en-GB"),
  );
  return entries;
}

/** The accessible name of an entry: store, document and date, in that order. */
function entryLabel(entry: StoreExpiryEntry) {
  return `${entry.store}, ${entry.document} renewal, ${LONG_DATE.format(utcOf(entry.day))} — ${describeOffset(entry.offset)}`;
}

const WEEKDAYS: Array<{ short: string; long: string }> = [
  { short: "Mon", long: "Monday" },
  { short: "Tue", long: "Tuesday" },
  { short: "Wed", long: "Wednesday" },
  { short: "Thu", long: "Thursday" },
  { short: "Fri", long: "Friday" },
  { short: "Sat", long: "Saturday" },
  { short: "Sun", long: "Sunday" },
];

const MAX_VISIBLE_ENTRIES = 3;
const MAX_OVERDUE_ROWS = 5;

/** A shared default, so an omitted `columns` prop is not a new array per render. */
const NO_COLUMNS: StoreExpiryColumn[] = [];

/* ── View ────────────────────────────────────────────────────────────────── */

export type StoreExpiryCalendarProps = {
  /** Store Documentation rows, already loaded and scoped by the board. */
  items: BoardItem[];
  /**
   * The board's columns, so `item.cells` (keyed by column id) resolves to the
   * spec's expiry column keys. Omit only if the cells are already keyed by key.
   */
  columns?: StoreExpiryColumn[];
  /** Overrides the local clock. For tests and for pinned screenshots. */
  today?: Date;
  /** Opens the store's row, the way the other board views do. */
  onOpenItem?: (item: BoardItem) => void;
};

export function StoreExpiryCalendar({
  items,
  columns = NO_COLUMNS,
  today,
  onOpenItem,
}: StoreExpiryCalendarProps) {
  const ids = useId();

  // The wall clock is read once, in a state initialiser, so a re-render never
  // moves "today" underneath the person reading the screen. The prop still
  // wins when it is given, which is how a test pins the date. This is the only
  // clock read in the file; everything downstream is a `DayNumber`.
  const [clockDay] = useState<DayNumber>(() => todayNumber(new Date()));
  const todayDay = today ? todayNumber(today) : clockDay;

  // Null means "wherever today is". Both stay null until the user navigates, so
  // the view follows the clock correction above without a second effect.
  const [cursor, setCursor] = useState<MonthCursor | null>(null);
  const [focusedDay, setFocusedDay] = useState<DayNumber | null>(null);
  const [expandedDay, setExpandedDay] = useState<DayNumber | null>(null);
  const [showAllOverdue, setShowAllOverdue] = useState(false);

  const gridRef = useRef<HTMLDivElement | null>(null);
  // Set only by keyboard moves, so clicking a month arrow never yanks focus.
  const wantsFocus = useRef(false);

  const month = cursor ?? monthOf(todayDay);

  const entries = useMemo(
    () => buildEntries(items, columns, todayDay),
    [items, columns, todayDay],
  );

  const byDay = useMemo(() => {
    const map = new Map<DayNumber, StoreExpiryEntry[]>();
    for (const entry of entries) {
      const bucket = map.get(entry.day);
      if (bucket) bucket.push(entry);
      else map.set(entry.day, [entry]);
    }
    return map;
  }, [entries]);

  const overdue = useMemo(
    () => entries.filter((entry) => entry.day < todayDay),
    [entries, todayDay],
  );

  /** The weeks on screen: whole Monday-to-Sunday rows, so the grid stays square. */
  const weeks = useMemo(() => {
    const year = Math.floor(month / 12);
    const monthIndex = month % 12;
    const first = new Date(Date.UTC(year, monthIndex, 1));
    const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    // Monday-first, as the UK working week runs.
    const leading = (first.getUTCDay() + 6) % 7;
    const total = Math.ceil((leading + daysInMonth) / 7) * 7;

    const start = addDays(dayNumber(year, monthIndex, 1), -leading);
    const rows: DayNumber[][] = [];
    for (let index = 0; index < total; index += 1) {
      if (index % 7 === 0) rows.push([]);
      rows[rows.length - 1].push(addDays(start, index));
    }
    return rows;
  }, [month]);

  const inMonth = useMemo(
    () => entries.filter((entry) => monthOf(entry.day) === month),
    [entries, month],
  );

  /** The first renewal on or after today, for the "nothing this month" nudge. */
  const nextRenewal = useMemo(
    () => entries.find((entry) => entry.day >= todayDay) ?? null,
    [entries, todayDay],
  );

  // The focused day must always be a cell that exists, or nothing is tabbable.
  const firstVisible = weeks[0]?.[0] ?? todayDay;
  const lastVisible = weeks[weeks.length - 1]?.[6] ?? todayDay;
  const activeDay =
    focusedDay !== null && focusedDay >= firstVisible && focusedDay <= lastVisible
      ? focusedDay
      : monthOf(todayDay) === month
        ? todayDay
        : dayNumber(Math.floor(month / 12), month % 12, 1);

  useEffect(() => {
    if (!wantsFocus.current) return;
    wantsFocus.current = false;
    gridRef.current
      ?.querySelector<HTMLElement>(`[data-day="${activeDay}"]`)
      ?.focus();
  }, [activeDay, month]);

  const goToDay = useCallback((day: DayNumber, moveFocus: boolean) => {
    setCursor(monthOf(day));
    setFocusedDay(day);
    setExpandedDay(null);
    wantsFocus.current = moveFocus;
  }, []);

  const stepMonth = useCallback(
    (delta: number) => {
      setCursor(month + delta);
      setFocusedDay(null);
      setExpandedDay(null);
    },
    [month],
  );

  const goToToday = useCallback(() => {
    setCursor(null);
    setFocusedDay(null);
    setExpandedDay(null);
  }, []);

  /**
   * One handler for the whole grid, so nothing leaks between the two layers.
   *
   * The grid is navigated the way a date picker is — arrows by day and week,
   * Home and End across the week, Page for months. Entries are a second layer
   * inside the focused day: Enter steps into them, arrows move between them and
   * Escape steps back out. That keeps a month of two hundred renewals to seven
   * tab stops instead of two hundred, and still reaches every one of them.
   */
  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const cellElement = target.closest<HTMLElement>("[data-day]");
    if (!cellElement) return;
    const day = Number(cellElement.dataset.day);
    if (!Number.isFinite(day)) return;

    const entryElement = target.closest<HTMLElement>("[data-entry]");
    if (entryElement) {
      const siblings = [...cellElement.querySelectorAll<HTMLElement>("[data-entry]")];
      const index = siblings.indexOf(entryElement);
      const focusAt = (next: number) => {
        event.preventDefault();
        siblings[Math.max(0, Math.min(siblings.length - 1, next))]?.focus();
      };
      switch (event.key) {
        case "ArrowDown":
          focusAt(index + 1);
          return;
        case "ArrowUp":
          if (index === 0) {
            event.preventDefault();
            cellElement.focus();
            return;
          }
          focusAt(index - 1);
          return;
        case "Home":
          focusAt(0);
          return;
        case "End":
          focusAt(siblings.length - 1);
          return;
        case "Escape":
          event.preventDefault();
          cellElement.focus();
          return;
        default:
          // Enter and Space belong to the button; arrows left and right are not
          // an entry gesture and must not fall through and move the day.
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
          }
          return;
      }
    }

    const move = (next: DayNumber) => {
      event.preventDefault();
      goToDay(next, true);
    };

    switch (event.key) {
      case "ArrowLeft":
        move(addDays(day, -1));
        return;
      case "ArrowRight":
        move(addDays(day, 1));
        return;
      case "ArrowUp":
        move(addDays(day, -7));
        return;
      case "ArrowDown":
        move(addDays(day, 7));
        return;
      case "Home":
        move(addDays(day, -((utcOf(day).getUTCDay() + 6) % 7)));
        return;
      case "End":
        move(addDays(day, 6 - ((utcOf(day).getUTCDay() + 6) % 7)));
        return;
      case "PageUp":
      case "PageDown": {
        const step = event.key === "PageUp" ? -1 : 1;
        const jump = event.shiftKey ? step * 12 : step;
        const targetMonth = monthOf(day) + jump;
        const year = Math.floor(targetMonth / 12);
        const monthIndex = ((targetMonth % 12) + 12) % 12;
        const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
        move(dayNumber(year, monthIndex, Math.min(day % 100, lastDay)));
        return;
      }
      case "Enter":
      case " ": {
        const first = cellElement.querySelector<HTMLElement>("[data-entry]");
        if (first) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      default:
        return;
    }
  };

  const visibleOverdue = showAllOverdue ? overdue : overdue.slice(0, MAX_OVERDUE_ROWS);
  const undated = [...storeDocumentationUndated];

  return (
    <section className="store-expiry" aria-labelledby={`${ids}-title`}>
      <header className="store-expiry__head">
        <div className="store-expiry__title">
          <h3 id={`${ids}-title`}>Certificate renewals</h3>
          <p>
            Every dated document on this board, plotted on the day it runs out, so a
            contractor can be booked before it does.
          </p>
        </div>

        <div className="store-expiry__nav">
          <button
            type="button"
            className="store-expiry__step store-expiry__step--back"
            aria-label={`Previous month, ${monthLabel(month - 1)}`}
            onClick={() => stepMonth(-1)}
          >
            <Icon name="chevron" size={16} />
          </button>
          <strong className="store-expiry__month">{monthLabel(month)}</strong>
          <button
            type="button"
            className="store-expiry__step"
            aria-label={`Next month, ${monthLabel(month + 1)}`}
            onClick={() => stepMonth(1)}
          >
            <Icon name="chevron" size={16} />
          </button>
          <button
            type="button"
            className="store-expiry__today"
            aria-label={`Go to today, ${LONG_DATE.format(utcOf(todayDay))}`}
            onClick={goToToday}
          >
            Today
          </button>
        </div>
      </header>

      {/* The month heading is not announced when it changes, so this is. */}
      <p className="visually-hidden" role="status">
        {monthLabel(month)}, {plural(inMonth.length, "renewal", "renewals")}.
        {overdue.length > 0
          ? ` ${plural(overdue.length, "renewal is", "renewals are")} overdue.`
          : ""}
      </p>

      <ul className="store-expiry__legend">
        {(Object.keys(TONES) as DrawnTone[]).map((tone) => (
          <li key={tone}>
            <span className={`store-expiry__swatch store-expiry__swatch--${tone}`}>
              <Icon name={TONES[tone].icon} size={11} />
              {TONES[tone].word}
            </span>
            {TONES[tone].hint}
          </li>
        ))}
      </ul>

      {overdue.length > 0 && (
        <section className="store-expiry__overdue" aria-labelledby={`${ids}-overdue`}>
          <h4 id={`${ids}-overdue`}>
            <Icon name="alert" size={15} />
            Overdue renewals ({overdue.length})
          </h4>
          <p>
            These lapsed before today. They stay listed here whichever month is on
            screen, and are also drawn on their own day in the grid.
          </p>
          <ul>
            {visibleOverdue.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className="store-expiry__overdue-row"
                  aria-label={entryLabel(entry)}
                  onClick={() => onOpenItem?.(entry.item)}
                >
                  <span className="store-expiry__overdue-late">
                    <Icon name="alert" size={11} />
                    {plural(-entry.offset, "day", "days")} overdue
                  </span>
                  <strong>{entry.store}</strong>
                  <span>{entry.document}</span>
                  <span>expired {SHORT_DATE.format(utcOf(entry.day))}</span>
                  <span className="store-expiry__overdue-who">
                    Chase: {entry.responsibility}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {overdue.length > MAX_OVERDUE_ROWS && (
            <button
              type="button"
              className="store-expiry__overdue-toggle"
              aria-expanded={showAllOverdue}
              onClick={() => setShowAllOverdue((open) => !open)}
            >
              {showAllOverdue
                ? "Show fewer"
                : `Show all ${overdue.length} overdue renewals`}
            </button>
          )}
        </section>
      )}

      {entries.length === 0 ? (
        <div className="store-expiry__blank">
          <h4>
            <Icon name="calendar" size={16} />
            No renewal dates recorded yet
          </h4>
          <p>
            This calendar fills itself from the expiry columns on the Store
            Documentation board. Once a store row carries a date, its renewal
            appears on that day, and anything already past shows in an overdue list
            above the month. Dates arrive with the monday export, or by typing one
            into a store&rsquo;s expiry cell.
          </p>
          <p>The {DATED_SLOTS.length} documents that carry a renewal date:</p>
          <ul>
            {DATED_SLOTS.map((slot) => (
              <li key={slot.key}>{slot.label}</li>
            ))}
          </ul>
        </div>
      ) : (
        inMonth.length === 0 && (
          <p className="store-expiry__quiet">
            <span>
              <Icon name="check" size={14} /> Nothing to renew in {monthLabel(month)}.
            </span>
            {nextRenewal && (
              <button
                type="button"
                className="store-expiry__jump"
                onClick={() => goToDay(nextRenewal.day, true)}
              >
                Go to the next renewal, {SHORT_DATE.format(utcOf(nextRenewal.day))}
              </button>
            )}
          </p>
        )
      )}

      <div
        ref={gridRef}
        role="grid"
        className="store-expiry__grid"
        aria-labelledby={`${ids}-title`}
        onKeyDown={onGridKeyDown}
      >
        <div role="row" className="store-expiry__row">
          {WEEKDAYS.map((weekday) => (
            <span key={weekday.long} role="columnheader" className="store-expiry__weekday">
              <span aria-hidden="true">{weekday.short}</span>
              <span className="visually-hidden">{weekday.long}</span>
            </span>
          ))}
        </div>

        {weeks.map((week) => (
          <div role="row" className="store-expiry__row" key={week[0]}>
            {week.map((day) => {
              const dayEntries = byDay.get(day) ?? [];
              const outside = monthOf(day) !== month;
              const isToday = day === todayDay;
              const expanded = expandedDay === day;
              const shown = expanded
                ? dayEntries
                : dayEntries.slice(0, MAX_VISIBLE_ENTRIES);
              const hiddenCount = dayEntries.length - shown.length;

              return (
                <div
                  key={day}
                  role="gridcell"
                  data-day={day}
                  tabIndex={day === activeDay ? 0 : -1}
                  aria-current={isToday ? "date" : undefined}
                  aria-label={`${LONG_DATE.format(utcOf(day))}${
                    isToday ? ", today" : ""
                  }, ${
                    dayEntries.length === 0
                      ? "no renewals"
                      : plural(dayEntries.length, "renewal", "renewals")
                  }`}
                  className={`store-expiry__cell${outside ? " is-outside" : ""}${
                    isToday ? " is-today" : ""
                  }`}
                  onFocus={() => setFocusedDay(day)}
                >
                  <span className="store-expiry__daynum" aria-hidden="true">
                    <b>{day % 100}</b>
                    {isToday && <em className="store-expiry__todaytag">Today</em>}
                  </span>

                  <div
                    id={`${ids}-day-${day}`}
                    className={`store-expiry__entries${expanded ? " is-expanded" : ""}`}
                  >
                    {shown.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        data-entry=""
                        tabIndex={-1}
                        className={`store-expiry__entry store-expiry__entry--${entry.tone}`}
                        aria-label={entryLabel(entry)}
                        onClick={() => onOpenItem?.(entry.item)}
                      >
                        <Icon name={TONES[entry.tone].icon} size={12} />
                        <span className="store-expiry__entry-text">
                          <span className="store-expiry__entry-store">{entry.store}</span>
                          <span className="store-expiry__entry-meta">
                            <span className="store-expiry__entry-doc">
                              {entry.document}
                            </span>
                            <span className="store-expiry__entry-tone">
                              {TONES[entry.tone].word}
                            </span>
                          </span>
                        </span>
                      </button>
                    ))}

                    {dayEntries.length > MAX_VISIBLE_ENTRIES && (
                      <button
                        type="button"
                        data-entry=""
                        tabIndex={-1}
                        className="store-expiry__more"
                        aria-expanded={expanded}
                        aria-controls={`${ids}-day-${day}`}
                        aria-label={
                          expanded
                            ? `Show fewer renewals on ${LONG_DATE.format(utcOf(day))}`
                            : `Show all ${dayEntries.length} renewals on ${LONG_DATE.format(utcOf(day))}`
                        }
                        onClick={() => setExpandedDay(expanded ? null : day)}
                      >
                        {expanded ? "Show fewer" : `+${hiddenCount} more`}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <p className="store-expiry__notes">
        <strong>Not plotted:</strong> {undated.join(", ")}. monday records no expiry
        date for {undated.length === 1 ? "it" : "these"}, so there is no renewal to
        book — they are tracked on the board itself rather than on a calendar. Use the
        arrow keys to move day by day, Page Up and Page Down to change month, Enter to
        step into a day&rsquo;s renewals and Escape to step back out.
      </p>
    </section>
  );
}
