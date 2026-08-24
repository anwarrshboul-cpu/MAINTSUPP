"use client";

/**
 * Calendar views — the mode switcher, the range navigator and the three
 * surfaces (month, week, day).
 *
 * PRESENTATIONAL ONLY. Nothing here fetches, writes, decides a colour or
 * remembers a preference. Every date fact comes from `./calendar-model`, every
 * colour from the `chipStyle` callback the parent supplies, and every action is
 * a callback out. That is what lets the same three surfaces serve jobs and
 * compliance from one component.
 *
 * WHY THREE GENUINELY DIFFERENT SURFACES
 *
 * The temptation with a calendar is to build the month grid and then render
 * "one week of it" and "one day of it" from the same code. That produces a week
 * view that is seven month cards — five words per day and a "+3 more" on every
 * one of them — which is strictly worse than the month it came from. So the
 * three surfaces share the CHIP and the AGENDA ROW and nothing else:
 *
 *   month  a 6x7 grid, chips truncated to three per day
 *   week   seven tall columns, every event visible, the column scrolls
 *   day    a single agenda list, the strongest surface on a phone
 *
 * NO HOUR GRID IN THE WEEK VIEW
 *
 * `CalendarEvent.time` is `""` for the overwhelming majority of this data —
 * a job due date and a certificate expiry are date-only values. An hour grid
 * would have to invent a row to put them in, and whichever row it picked would
 * be a lie a coordinator could read off the screen and quote to a contractor.
 * The week columns therefore stack events in a list and print a time only where
 * one genuinely exists.
 *
 * ORDERING, STATED ONCE SO IT IS THE SAME EVERYWHERE
 *
 * Timed events sort first, ascending by their `time` string; untimed events
 * follow in the order the parent supplied them. `time` is compared as a string
 * because it is zero-padded "HH:MM" when present, so lexical order is clock
 * order. The same `orderEvents` runs for month cells, week columns and the day
 * agenda — a day must not reshuffle itself when you switch surface.
 *
 * RESPONSIVE, AND WHY IT IS CSS AND NOT `matchMedia`
 *
 * The month surface renders TWO subtrees per cell — a desktop one with chips
 * and a compact phone one with a tap target and shape markers — and each is
 * `display: none` at the other breakpoint. This follows the reasoning already
 * written down in `form-builder.tsx`: this is a server-rendered app, a
 * width-dependent render is a hydration mismatch, and `display: none` removes
 * an element from the accessibility tree as well as from the page, so a phone
 * screen reader never announces the desktop chips and vice versa.
 *
 * The one hard rule the surfaces are built to: NOTHING here may widen the page.
 * `.calendar-grid` in globals.css sets `min-width: 805px` with no scrolling
 * ancestor, which is exactly how the old calendar pushed a phone sideways. The
 * month table is `table-layout: fixed; width: 100%` so it physically cannot
 * exceed its container, and the week columns get their `min-width` back only
 * inside `.calendar-week__scroll`, which owns the `overflow-x`.
 *
 * COLOUR IS NEVER THE ONLY DISTINCTION
 *
 * `chipStyle` paints the ground and the parent owns what those colours mean, so
 * every distinction this component makes is ALSO carried by a shape or a word:
 * a job chip leads with the wrench glyph and a compliance chip with the shield,
 * an overdue chip adds the alert glyph and the word "overdue" to its accessible
 * name, and the phone month grid marks a day with a SQUARE for jobs and a CIRCLE
 * for compliance. Those markers are DOM elements rather than CSS on the chip
 * itself, deliberately: `chipStyle` arrives as an inline style and inline beats
 * a class, so a border or an outline this file set could be silently overwritten
 * by the colour owner. A child element cannot be.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { Icon } from "../../components";
import type { IconName } from "../../components";
import {
  type CalendarDay,
  type CalendarEvent,
  type CalendarViewMode,
  calendarDayLabel,
  calendarMonthGrid,
  calendarRangeLabel,
  calendarWeekDays,
  calendarWeekdayLabel,
  isSameCalendarMonth,
  shiftCalendarDay,
  shiftCalendarMonth,
} from "./calendar-model";
import "./calendar-views.css";

/* -------------------------------------------------------------------------
   Shared helpers
   ------------------------------------------------------------------------- */

/** How many chips a month cell shows before it offers "+N more". */
const MONTH_CHIP_LIMIT = 3;

const MODES: ReadonlyArray<{ mode: CalendarViewMode; label: string }> = [
  { mode: "month", label: "Month" },
  { mode: "week", label: "Week" },
  { mode: "day", label: "Day" },
];

/** The word the previous/next buttons name, so their labels say what they do. */
const UNIT: Record<CalendarViewMode, string> = {
  month: "month",
  week: "week",
  day: "day",
};

/** The glyph that separates a job from a compliance deadline without colour. */
const KIND_ICON: Record<CalendarEvent["kind"], IconName> = {
  job: "wrench",
  compliance: "shield",
};

const EMPTY_EVENTS: readonly CalendarEvent[] = [];

/**
 * The day of the month, without a leading zero.
 *
 * Read off the `YYYY-MM-DD` string rather than through a `Date`. Building a
 * `Date` from a date-only string is midnight UTC, which prints as the previous
 * day for anyone west of Greenwich — the trap `store-expiry-calendar.tsx`
 * documents at length. There is no clock involved in "which number goes in this
 * box", so there is no reason to consult one.
 */
function dayOfMonth(day: CalendarDay): string {
  const parsed = Number.parseInt(day.slice(8, 10), 10);
  return Number.isFinite(parsed) ? String(parsed) : day.slice(8, 10);
}

/** Timed events first, ascending; untimed events after, in the given order. */
function orderEvents(events: readonly CalendarEvent[]): CalendarEvent[] {
  const timed: CalendarEvent[] = [];
  const untimed: CalendarEvent[] = [];
  for (const event of events) (event.time ? timed : untimed).push(event);
  timed.sort((a, b) => a.time.localeCompare(b.time));
  return timed.concat(untimed);
}

function eventsFor(
  eventsByDay: Map<CalendarDay, CalendarEvent[]>,
  day: CalendarDay,
): readonly CalendarEvent[] {
  return eventsByDay.get(day) ?? EMPTY_EVENTS;
}

/**
 * The accessible name of a chip or an agenda row.
 *
 * The type word leads so a screen-reader user hears the distinction the colour
 * is carrying, and "overdue" is appended rather than left to the red — the
 * whole point of the rule that colour is never the only signal.
 */
function eventName(
  event: CalendarEvent,
  typeLabel: (event: CalendarEvent) => string,
): string {
  const base = `${typeLabel(event)}: ${event.title}, ${event.fieldLabel} ${calendarDayLabel(
    event.day,
  )}${event.time ? `, ${event.time}` : ""}`;
  return event.timing === "overdue" ? `${base}, overdue` : base;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/* -------------------------------------------------------------------------
   The mode switcher
   ------------------------------------------------------------------------- */

/**
 * Month / Week / Day.
 *
 * Built on `.view-switch .view-switch--text`, which the product already uses
 * for text tablists in the site editor and the options admin. Reusing it is
 * not laziness: that class carries the dark-theme override at
 * brand-overrides.css:417 and the `min-height: 44px` touch-target rule at
 * brand-overrides.css:7474, both of which a fresh class would have had to
 * restate and could then drift from.
 *
 * `role="tablist"` with `aria-selected` is the pattern the other three text
 * strips in this product use, so it is the one used here. Every tab stays in
 * the tab order — the APG's roving `tabindex` would be a keyboard contract
 * unlike the rest of the app's tablists — and arrow keys are added ON TOP of
 * that, so the control is operable both ways.
 */
export function CalendarViewSwitcher({
  value,
  onChange,
}: {
  value: CalendarViewMode;
  onChange: (next: CalendarViewMode) => void;
}): React.JSX.Element {
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = MODES.findIndex((entry) => entry.mode === value);
    let next = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = (current + 1) % MODES.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (current - 1 + MODES.length) % MODES.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = MODES.length - 1;
    }
    if (next < 0) return;
    event.preventDefault();
    onChange(MODES[next].mode);
    tabs.current[next]?.focus();
  }

  return (
    <div
      className="view-switch view-switch--text calendar-switcher"
      role="tablist"
      aria-label="Calendar view"
      onKeyDown={onKeyDown}
    >
      {MODES.map((entry, index) => (
        <button
          key={entry.mode}
          ref={(node) => {
            tabs.current[index] = node;
          }}
          type="button"
          role="tab"
          data-calendar-mode={entry.mode}
          aria-selected={value === entry.mode}
          className={value === entry.mode ? "is-active" : ""}
          onClick={() => onChange(entry.mode)}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------
   The range navigator
   ------------------------------------------------------------------------- */

/**
 * Previous / heading / next / Today.
 *
 * The step is the unit the current mode is showing, which is the only thing
 * that makes "previous" mean anything: a month back from a month, seven days
 * back from a week, one day back from a day.
 *
 * THIS COMPONENT DOES NOT TOUCH THE ANCHOR WHEN THE MODE CHANGES. Switching
 * from month to day on the 18th must land on the 18th, not on today and not on
 * the first of the month. The anchor belongs to the parent and it is the
 * parent's job to preserve it; there is deliberately no effect here that would
 * quietly reset it.
 */
export function CalendarNav({
  mode,
  anchor,
  today,
  onAnchorChange,
}: {
  mode: CalendarViewMode;
  anchor: CalendarDay;
  today: CalendarDay;
  onAnchorChange: (next: CalendarDay) => void;
}): React.JSX.Element {
  const unit = UNIT[mode];

  const step = useCallback(
    (direction: 1 | -1) => {
      if (mode === "month") return onAnchorChange(shiftCalendarMonth(anchor, direction));
      if (mode === "week") return onAnchorChange(shiftCalendarDay(anchor, direction * 7));
      return onAnchorChange(shiftCalendarDay(anchor, direction));
    },
    [anchor, mode, onAnchorChange],
  );

  return (
    <div className="calendar-nav">
      <button
        type="button"
        className="calendar-nav__step calendar-nav__step--back"
        data-calendar-prev=""
        aria-label={`Previous ${unit}`}
        onClick={() => step(-1)}
      >
        <Icon name="chevron" size={16} />
      </button>
      {/*
       * `aria-live` on the heading rather than on the buttons: pressing "next"
       * five times should announce where you ended up, not narrate the button
       * you are still standing on.
       */}
      <h2 className="calendar-nav__heading" aria-live="polite">
        {calendarRangeLabel(mode, anchor)}
      </h2>
      <button
        type="button"
        className="calendar-nav__step"
        data-calendar-next=""
        aria-label={`Next ${unit}`}
        onClick={() => step(1)}
      >
        <Icon name="chevron" size={16} />
      </button>
      <button
        type="button"
        className="calendar-nav__today"
        data-calendar-today-button=""
        onClick={() => onAnchorChange(today)}
      >
        Today
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------
   The surface
   ------------------------------------------------------------------------- */

export type CalendarSurfaceProps = {
  mode: CalendarViewMode;
  anchor: CalendarDay;
  today: CalendarDay;
  eventsByDay: Map<CalendarDay, CalendarEvent[]>;
  /** Inline style for an event chip of this kind — the parent owns the colours. */
  chipStyle: (event: CalendarEvent) => CSSProperties;
  /** Short type word rendered alongside the colour, e.g. "Job" / "Compliance". */
  typeLabel: (event: CalendarEvent) => string;
  onOpen: (event: CalendarEvent) => void;
  /** Null when the viewer may not edit; render no edit affordance in that case. */
  onEditDate: ((event: CalendarEvent) => void) | null;
  /** Month/Week: which day the mobile agenda is showing. */
  selectedDay: CalendarDay;
  onSelectDay: (day: CalendarDay) => void;
  /** Rendered when the whole surface has nothing to show. */
  emptyState: ReactNode;
};

export function CalendarSurface(props: CalendarSurfaceProps): React.JSX.Element {
  if (props.mode === "day") return <DayView {...props} />;
  if (props.mode === "week") return <WeekView {...props} />;
  return <MonthView {...props} />;
}

/* -------------------------------------------------------------------------
   Month
   ------------------------------------------------------------------------- */

/**
 * A `<table>` and not a grid of `<div>`s.
 *
 * A month is a table: seven named columns and six rows of dates. The table
 * elements give the weekday headers a real `scope="col"` relationship for free,
 * which a `role="grid"` on a stack of divs would only have IMITATED — and
 * imitating `grid` obliges you to implement two-dimensional arrow-key
 * navigation, which is a keyboard contract nothing else in this product
 * offers. `table-layout: fixed` is the other half of the reason: it sizes
 * columns from the table's own width and ignores its contents entirely, so a
 * hundred-character job title cannot push the month wider than the phone.
 */
function MonthView({
  anchor,
  today,
  eventsByDay,
  chipStyle,
  typeLabel,
  onOpen,
  onEditDate,
  selectedDay,
  onSelectDay,
  emptyState,
}: CalendarSurfaceProps): React.JSX.Element {
  const days = useMemo(() => calendarMonthGrid(anchor), [anchor]);
  const weeks = useMemo(() => {
    const rows: CalendarDay[][] = [];
    for (let index = 0; index < days.length; index += 7) rows.push(days.slice(index, index + 7));
    return rows;
  }, [days]);

  /*
   * "+N more" expands the cell in place rather than opening a popover: the
   * chips are already in the DOM in the right reading order, so revealing them
   * needs no portal, no layer in the z-index scale and no focus trap, and the
   * list becomes its own scroll container so one busy Tuesday cannot stretch
   * the whole week row.
   *
   * The anchor is stored alongside the day so that paging to another month
   * collapses the cell without an effect and without a stale-focus race — the
   * expansion is DERIVED, so it simply stops being true.
   */
  const [expanded, setExpanded] = useState<{ anchor: CalendarDay; day: CalendarDay } | null>(null);
  const expandedDay = expanded && expanded.anchor === anchor ? expanded.day : null;
  const moreButtons = useRef<Map<CalendarDay, HTMLButtonElement | null>>(new Map());
  const restoreFocus = useRef<CalendarDay | null>(null);

  useEffect(() => {
    if (expandedDay !== null) return;
    const day = restoreFocus.current;
    restoreFocus.current = null;
    if (day) moreButtons.current.get(day)?.focus();
  }, [expandedDay]);

  const collapse = useCallback((day: CalendarDay) => {
    restoreFocus.current = day;
    setExpanded(null);
  }, []);

  /*
   * Escape is handled on the grid, not on `document`. A document listener would
   * also swallow the Escape that closes whatever drawer or modal the parent has
   * open above this surface; scoping it here means the key only collapses a
   * cell when the focus is actually inside the month, and `stopPropagation` is
   * called only when something was in fact collapsed.
   */
  function onGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || expandedDay === null) return;
    event.stopPropagation();
    collapse(expandedDay);
  }

  const anythingToShow = days.some((day) => eventsFor(eventsByDay, day).length > 0);

  return (
    <div className="calendar-surface calendar-surface--month">
      <div className="calendar-month" onKeyDown={onGridKeyDown}>
        <table className="calendar-month__table">
          <caption className="visually-hidden">{calendarRangeLabel("month", anchor)}</caption>
          <thead>
            <tr>
              {days.slice(0, 7).map((day) => (
                <th key={day} scope="col" className="calendar-month__head">
                  {calendarWeekdayLabel(day)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => (
              <tr key={week[0]}>
                {week.map((day) => (
                  <MonthCell
                    key={day}
                    day={day}
                    anchor={anchor}
                    today={today}
                    events={eventsFor(eventsByDay, day)}
                    chipStyle={chipStyle}
                    typeLabel={typeLabel}
                    onOpen={onOpen}
                    selected={day === selectedDay}
                    onSelectDay={onSelectDay}
                    expanded={day === expandedDay}
                    onExpand={() => {
                      onSelectDay(day);
                      setExpanded({ anchor, day });
                    }}
                    onCollapse={() => collapse(day)}
                    registerMore={(node) => {
                      moreButtons.current.set(day, node);
                    }}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/*
       * The selected day, in full, at EVERY width.
       *
       * It began as the phone half of this surface, hidden above 767px because
       * the cells there carry their own chips. But the chips are read-only —
       * they open a record and nothing else — so hiding this on a laptop left
       * the month view, which is the view this screen opens on, with no way to
       * change a date at all. Somebody would have had to find the Day tab to
       * discover the feature existed.
       *
       * So it stays at every width, and the day number in each cell selects it.
       * The grid answers "what is this month"; this answers "what is that day,
       * and what can I do about it".
       */}
      <div className="calendar-month__agenda">
        <DayAgenda
          day={selectedDay}
          events={eventsFor(eventsByDay, selectedDay)}
          chipStyle={chipStyle}
          typeLabel={typeLabel}
          onOpen={onOpen}
          onEditDate={onEditDate}
          heading
        />
      </div>

      {anythingToShow ? null : <div className="calendar-surface__empty">{emptyState}</div>}
    </div>
  );
}

function MonthCell({
  day,
  anchor,
  today,
  events,
  chipStyle,
  typeLabel,
  onOpen,
  selected,
  onSelectDay,
  expanded,
  onExpand,
  onCollapse,
  registerMore,
}: {
  day: CalendarDay;
  anchor: CalendarDay;
  today: CalendarDay;
  events: readonly CalendarEvent[];
  chipStyle: (event: CalendarEvent) => CSSProperties;
  typeLabel: (event: CalendarEvent) => string;
  onOpen: (event: CalendarEvent) => void;
  selected: boolean;
  onSelectDay: (day: CalendarDay) => void;
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  registerMore: (node: HTMLButtonElement | null) => void;
}): React.JSX.Element {
  const ordered = useMemo(() => orderEvents(events), [events]);
  const outside = !isSameCalendarMonth(day, anchor);
  const isToday = day === today;
  const visible = expanded ? ordered : ordered.slice(0, MONTH_CHIP_LIMIT);
  const hidden = ordered.length - visible.length;

  const jobs = ordered.filter((event) => event.kind === "job");
  const compliance = ordered.filter((event) => event.kind === "compliance");
  const overdue = ordered.filter((event) => event.timing === "overdue");

  /*
   * The phone tally, spelled out. The markers below are shapes, so a tap target
   * that only offered them would be describing itself in shapes; this says the
   * same thing in words. `Job: 2` rather than `2 jobs` because `typeLabel` is
   * the parent's word and this component cannot know how to pluralise it.
   */
  const tally: string[] = [];
  if (jobs.length > 0) tally.push(`${typeLabel(jobs[0])}: ${jobs.length}`);
  if (compliance.length > 0) tally.push(`${typeLabel(compliance[0])}: ${compliance.length}`);
  if (overdue.length > 0) tally.push(`overdue: ${overdue.length}`);

  const className = [
    "calendar-month__cell",
    outside ? "is-outside" : "",
    isToday ? "is-today" : "",
    selected ? "is-selected" : "",
    expanded ? "is-expanded" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <td
      className={className}
      aria-current={isToday ? "date" : undefined}
      /* The day this cell IS, stated rather than inferred from its position in
         the table — see `eventData`. Comparing it against the chip's own
         `data-day` is the day-shift gate. */
      data-calendar-day=""
      data-day={day}
      {...(isToday ? { "data-calendar-today": "" } : {})}
      {...(outside ? { "data-outside": "" } : {})}
    >
      {/* ---- Desktop: the day number, the chips, the expander ---- */}
      <div className="calendar-month__desk">
        {/*
         * The day number is a BUTTON on desktop as well as on the phone.
         *
         * It selects the day for the agenda below the grid, and that agenda is
         * where "Change date" lives. A month chip is roughly ninety pixels of
         * usable width and an edit control inside one would either crowd the
         * title out or hide behind a hover, which is not a method a keyboard or
         * a touch user can find. Selecting a day and acting on it in a full-
         * width list is the same gesture the phone layout already uses, so
         * there is one mental model rather than two.
         */}
        <button
          type="button"
          className="calendar-month__num"
          aria-pressed={selected}
          aria-label={`${calendarDayLabel(day)}${isToday ? ", today" : ""}${
            tally.length > 0 ? `, ${tally.join(", ")}` : ", nothing scheduled"
          }`}
          onClick={() => onSelectDay(day)}
        >
          <span aria-hidden="true">{dayOfMonth(day)}</span>
        </button>
        {ordered.length > 0 ? (
          <div className={`calendar-month__list${expanded ? " is-expanded" : ""}`}>
            {visible.map((event) => (
              <EventChip
                key={event.key}
                event={event}
                chipStyle={chipStyle}
                typeLabel={typeLabel}
                onOpen={onOpen}
              />
            ))}
          </div>
        ) : null}
        {/*
         * ONE button for both directions, not a pair swapped in and out. React
         * reuses this DOM node across the toggle, so the focus a keyboard user
         * put on "+2 more" is still on "Show less" afterwards — two conditional
         * buttons would each be a fresh node and drop focus to the body.
         */}
        {hidden > 0 || expanded ? (
          <button
            ref={registerMore}
            type="button"
            className="calendar-month__more"
            data-calendar-overflow=""
            data-count={hidden}
            aria-expanded={expanded}
            aria-label={
              expanded
                ? `Show fewer entries for ${calendarDayLabel(day)}`
                : `Show all ${ordered.length} entries for ${calendarDayLabel(day)}`
            }
            onClick={expanded ? onCollapse : onExpand}
          >
            {expanded ? "Show less" : `+${hidden} more`}
          </button>
        ) : null}
      </div>

      {/* ---- Phone: one tap target per day, shape markers, no chip text ---- */}
      {/*
       * No `aria-current` here. The cell already carries it, and a container
       * and its own descendant both announcing "current date" is the same fact
       * twice — on the phone, where this button IS the cell, that is the only
       * place it would be heard. The word goes in the label instead.
       */}
      <button
        type="button"
        className="calendar-month__pick"
        aria-pressed={selected}
        aria-label={`${calendarDayLabel(day)}${isToday ? ", today" : ""}${
          tally.length > 0 ? `, ${tally.join(", ")}` : ", nothing scheduled"
        }`}
        onClick={() => onSelectDay(day)}
      >
        <span className="calendar-month__picknum" aria-hidden="true">
          {dayOfMonth(day)}
        </span>
        <span className="calendar-month__markers" aria-hidden="true">
          {/*
           * Square for a job, circle for a compliance date, an exclamation for
           * anything overdue. Three shapes fit inside a 38px column at 320px;
           * the counts behind them are in the label above.
           */}
          {jobs.length > 0 ? (
            <span
              className="calendar-month__marker calendar-month__marker--job"
              style={chipStyle(jobs[0])}
            />
          ) : null}
          {compliance.length > 0 ? (
            <span
              className="calendar-month__marker calendar-month__marker--compliance"
              style={chipStyle(compliance[0])}
            />
          ) : null}
          {overdue.length > 0 ? (
            <span className="calendar-month__marker calendar-month__marker--overdue">!</span>
          ) : null}
        </span>
      </button>
    </td>
  );
}

/* -------------------------------------------------------------------------
   Week
   ------------------------------------------------------------------------- */

/**
 * Seven columns, each of which is a real day.
 *
 * At and below 767px the seven columns keep their readable width and the
 * SURFACE scrolls sideways — `.calendar-week__scroll` owns the `overflow-x`,
 * so the page itself never gains a horizontal scrollbar. That scroller is a
 * focusable, labelled region because WCAG 2.1.1 asks a scrollable area to be
 * reachable from the keyboard, and because an empty column is otherwise
 * unreachable: there is nothing in it to tab to.
 *
 * `selectedDay` is honoured here by marking and scrolling to that column rather
 * than by rendering a second agenda underneath. The columns already carry every
 * event in full, so an agenda below them would be the same information twice on
 * the surface that has the least room for it.
 */
function WeekView({
  anchor,
  today,
  eventsByDay,
  chipStyle,
  typeLabel,
  onOpen,
  selectedDay,
  onSelectDay,
  emptyState,
}: CalendarSurfaceProps): React.JSX.Element {
  const days = useMemo(() => calendarWeekDays(anchor), [anchor]);
  const scroller = useRef<HTMLDivElement | null>(null);
  const columns = useRef<Map<CalendarDay, HTMLDivElement | null>>(new Map());

  /*
   * Centre the selected column, by writing `scrollLeft` rather than calling
   * `scrollIntoView`. `scrollIntoView` walks every scrollable ancestor and will
   * happily scroll the PAGE to bring the column into view, which is the exact
   * sideways jolt this surface exists to avoid. `offsetLeft` is measured
   * against the scroller because the stylesheet gives it `position: relative`.
   */
  useEffect(() => {
    const box = scroller.current;
    const column = columns.current.get(selectedDay);
    if (!box || !column) return;
    if (box.scrollWidth <= box.clientWidth) return;
    box.scrollTo({
      left: Math.max(0, column.offsetLeft - (box.clientWidth - column.clientWidth) / 2),
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [selectedDay]);

  const anythingToShow = days.some((day) => eventsFor(eventsByDay, day).length > 0);

  return (
    <div className="calendar-surface calendar-surface--week">
      <div
        className="calendar-week__scroll"
        ref={scroller}
        tabIndex={0}
        role="group"
        aria-label={`${calendarRangeLabel("week", anchor)} — scrolls sideways`}
      >
        <div className="calendar-week__grid">
          {days.map((day) => {
            const ordered = orderEvents(eventsFor(eventsByDay, day));
            const isToday = day === today;
            const className = [
              "calendar-week__col",
              isToday ? "is-today" : "",
              day === selectedDay ? "is-selected" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                key={day}
                className={className}
                ref={(node) => {
                  columns.current.set(day, node);
                }}
                aria-current={isToday ? "date" : undefined}
                data-calendar-day=""
                data-day={day}
                {...(isToday ? { "data-calendar-today": "" } : {})}
              >
                <button
                  type="button"
                  className="calendar-week__head"
                  aria-pressed={day === selectedDay}
                  aria-label={`${calendarDayLabel(day)}${
                    ordered.length > 0 ? `, ${ordered.length} scheduled` : ", nothing scheduled"
                  }`}
                  onClick={() => onSelectDay(day)}
                >
                  <span className="calendar-week__weekday" aria-hidden="true">
                    {calendarWeekdayLabel(day)}
                  </span>
                  <span className="calendar-week__date" aria-hidden="true">
                    {dayOfMonth(day)}
                  </span>
                </button>
                <div className="calendar-week__list">
                  {ordered.length > 0 ? (
                    ordered.map((event) => (
                      <EventChip
                        key={event.key}
                        event={event}
                        chipStyle={chipStyle}
                        typeLabel={typeLabel}
                        onOpen={onOpen}
                        stacked
                      />
                    ))
                  ) : (
                    <p className="calendar-week__none">Nothing scheduled</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {anythingToShow ? null : <div className="calendar-surface__empty">{emptyState}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------------
   Day
   ------------------------------------------------------------------------- */

function DayView({
  anchor,
  eventsByDay,
  chipStyle,
  typeLabel,
  onOpen,
  onEditDate,
  emptyState,
}: CalendarSurfaceProps): React.JSX.Element {
  const events = eventsFor(eventsByDay, anchor);
  return (
    <div className="calendar-surface calendar-surface--day">
      <DayAgenda
        day={anchor}
        events={events}
        chipStyle={chipStyle}
        typeLabel={typeLabel}
        onOpen={onOpen}
        onEditDate={onEditDate}
        heading
      />
      {events.length === 0 ? <div className="calendar-surface__empty">{emptyState}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------
   The two shared pieces: the chip and the agenda row
   ------------------------------------------------------------------------- */

/**
 * What every rendered event states about itself, in the DOM.
 *
 * ACCEPTANCE READS THIS, NOT THE TREE. Proving a date has not shifted means
 * comparing the day a chip claims against the day of the cell it is sitting in
 * and against the value on the source record — three numbers, from three
 * places. Inferring the first two by walking parent nodes makes every one of
 * those checks a hostage to the markup, so the two days are stated instead:
 * `data-day` here and `data-day` on the container.
 *
 * `data-key` rather than `data-record-id` alone, because one job legitimately
 * appears up to four times on the same grid — raised, due, updated, completed —
 * and the record id is not unique per chip. `data-source` is what makes the
 * date-source acceptance countable at all.
 *
 * Cheap, stable, and invisible to a reader. It is not a styling hook: nothing
 * in any stylesheet selects on these.
 */
function eventData(event: CalendarEvent) {
  return {
    "data-calendar-event": "",
    "data-key": event.key,
    "data-kind": event.kind,
    "data-record-id": event.recordId,
    "data-source": event.sourceId,
    "data-field": event.field,
    "data-day": event.day,
    "data-timing": event.timing,
  } as const;
}

function EventChip({
  event,
  chipStyle,
  typeLabel,
  onOpen,
  stacked = false,
}: {
  event: CalendarEvent;
  chipStyle: (event: CalendarEvent) => CSSProperties;
  typeLabel: (event: CalendarEvent) => string;
  onOpen: (event: CalendarEvent) => void;
  /** Week columns have the room for the subtitle; month cells do not. */
  stacked?: boolean;
}): React.JSX.Element {
  const overdue = event.timing === "overdue";
  return (
    <button
      type="button"
      className={`calendar-chip${stacked ? " calendar-chip--stacked" : ""}${
        overdue ? " is-overdue" : ""
      }`}
      style={chipStyle(event)}
      title={event.subtitle ? `${event.title} — ${event.subtitle}` : event.title}
      aria-label={eventName(event, typeLabel)}
      onClick={() => onOpen(event)}
      {...eventData(event)}
    >
      <span className="calendar-chip__lead" aria-hidden="true">
        <Icon name={KIND_ICON[event.kind]} size={12} className="calendar-chip__glyph" />
        {overdue ? <Icon name="alert" size={12} className="calendar-chip__glyph" /> : null}
      </span>
      <span className="calendar-chip__text">
        <span className="calendar-chip__title">
          {event.time ? <b className="calendar-chip__time">{event.time}</b> : null}
          {event.title}
        </span>
        {stacked && event.subtitle ? (
          <span className="calendar-chip__subtitle">{event.subtitle}</span>
        ) : null}
      </span>
    </button>
  );
}

function DayAgenda({
  day,
  events,
  chipStyle,
  typeLabel,
  onOpen,
  onEditDate,
  heading = false,
}: {
  day: CalendarDay;
  events: readonly CalendarEvent[];
  chipStyle: (event: CalendarEvent) => CSSProperties;
  typeLabel: (event: CalendarEvent) => string;
  onOpen: (event: CalendarEvent) => void;
  onEditDate: ((event: CalendarEvent) => void) | null;
  heading?: boolean;
}): React.JSX.Element {
  const ordered = useMemo(() => orderEvents(events), [events]);
  const label = calendarDayLabel(day);

  return (
    <section className="calendar-agenda" aria-label={label}>
      {heading ? <h3 className="calendar-agenda__head">{label}</h3> : null}
      {ordered.length === 0 ? (
        <p className="calendar-agenda__empty">Nothing is scheduled for {label}.</p>
      ) : (
        <ul className="calendar-agenda__list">
          {ordered.map((event) => {
            const overdue = event.timing === "overdue";
            /*
             * `editable` is the record's own answer and `onEditDate` is the
             * viewer's; the affordance needs both, so a read-only viewer sees
             * none of them and an unwritable record never offers one it cannot
             * honour.
             */
            const canEdit = onEditDate !== null && event.editable;
            return (
              <li key={event.key} className="calendar-agenda__row" {...eventData(event)}>
                <button
                  type="button"
                  className="calendar-agenda__open"
                  aria-label={eventName(event, typeLabel)}
                  onClick={() => onOpen(event)}
                >
                  <span
                    className={`calendar-agenda__ink calendar-agenda__ink--${event.kind}`}
                    style={chipStyle(event)}
                    aria-hidden="true"
                  >
                    <Icon name={KIND_ICON[event.kind]} size={14} />
                  </span>
                  <span className="calendar-agenda__text">
                    <span className="calendar-agenda__title">{event.title}</span>
                    {event.subtitle ? (
                      <span className="calendar-agenda__subtitle">{event.subtitle}</span>
                    ) : null}
                    <span className="calendar-agenda__meta" aria-hidden="true">
                      <span className="calendar-agenda__type">{typeLabel(event)}</span>
                      <span className="calendar-agenda__field">{event.fieldLabel}</span>
                      {event.time ? (
                        <span className="calendar-agenda__time">
                          <Icon name="clock" size={12} />
                          {event.time}
                        </span>
                      ) : null}
                      {overdue ? (
                        <span className="calendar-agenda__overdue">
                          <Icon name="alert" size={12} />
                          Overdue
                        </span>
                      ) : null}
                    </span>
                  </span>
                </button>
                {canEdit ? (
                  <button
                    type="button"
                    className="calendar-agenda__edit"
                    data-calendar-edit=""
                    aria-label={`Change ${event.fieldLabel} for ${event.title}`}
                    onClick={() => onEditDate?.(event)}
                  >
                    <Icon name="edit" size={16} />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
