"use client";

/**
 * The month grid every date control in the product draws.
 *
 * WHY IT LEFT board-cells.tsx. That file reached its 1,300-line ceiling, and a
 * calendar was the part with the least to do with "the board's cell
 * components" — the same argument that split `board-compact`, `board-row-name`
 * and `board-view-writes` out of their parents. It also needed room: the desktop
 * date picker asks it for year navigation and for arrow-key movement, neither of
 * which existed while this was a phone-sheet grid.
 *
 * `MobileBoardCalendar` KEEPS ITS NAME. It is imported by `expiry-cell.tsx`, by
 * the mobile date and timeline sheets, and pinned by name in three tests; the
 * name is now a misnomer — it has been the desktop grid since the expiry cell
 * stopped opening the browser's own picker — but renaming it would be churn in
 * files this change has no other business in. `board-cells.tsx` re-exports it so
 * every existing import keeps working.
 *
 * ONE CALENDAR, NOT TWO. The whole point of putting it here is that the phone
 * sheet, the expiry cell and the board's date popover show the same grid, with
 * the same week start, the same "today" ring and the same selected day. A second
 * implementation is how those three come to disagree about which day is
 * highlighted.
 */

import { useEffect, useRef } from "react";
import { Icon } from "../../components";
import {
  boardCalendarDays,
  boardCalendarMonthLabel,
  formatFullBoardDate,
  shiftBoardCalendarMonth,
  todayBoardDate,
} from "./board-format";
/* The day arithmetic is a leaf so it can be CALLED by a test — board-day-math.ts. */
import {
  boardCalendarMonthOf,
  shiftBoardCalendarDay,
  shiftBoardCalendarDayByMonth,
  shiftBoardCalendarYear,
} from "./board-day-math";

export { shiftBoardCalendarDay, shiftBoardCalendarYear };

export function MobileBoardCalendar({
  month,
  onMonthChange,
  onSelect,
  selectedStart,
  selectedEnd,
  mode,
  weekStartsOn,
  yearFirst = false,
  hideHeader = false,
  showYearNav = false,
  autoFocusDay = false,
}: {
  month: string;
  onMonthChange: (value: string) => void;
  onSelect: (value: string) => void;
  selectedStart?: string;
  selectedEnd?: string;
  mode: "single" | "range";
  weekStartsOn: 0 | 1;
  yearFirst?: boolean;
  /** The caller draws its own month header — see the board's date popover. */
  hideHeader?: boolean;
  /** Adds « and » beside the month arrows, for moving a whole year at a time. */
  showYearNav?: boolean;
  /** Moves focus onto the selected (or today's) day when the grid appears. */
  autoFocusDay?: boolean;
}) {
  const weekdays =
    weekStartsOn === 1
      ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
      : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = boardCalendarDays(month, weekStartsOn);
  const today = todayBoardDate();
  const gridRef = useRef<HTMLDivElement>(null);

  /*
   * ONE DAY IN THE TAB ORDER, and the arrows move between the rest.
   *
   * A month is up to 42 buttons. Left as 42 tab stops, reaching the row below
   * the calendar means pressing Tab forty-two times, which is the standard
   * reason a date grid uses a roving tabindex: the grid is ONE stop, and the
   * arrow keys walk it. The day that holds it is the selected one, else today,
   * else the first of the month — the day a reader would expect to land on.
   */
  const focusable =
    (selectedStart && days.includes(selectedStart) && selectedStart) ||
    (days.includes(today) && today) ||
    days.find((day): day is string => Boolean(day)) ||
    "";

  const moveFocusTo = (date: string) => {
    const node = gridRef.current?.querySelector<HTMLButtonElement>(
      `[data-day="${date}"]`,
    );
    if (node) {
      node.focus();
      return true;
    }
    return false;
  };

  /*
   * Arrow keys that leave the month change the month, and the day they land on
   * is then focused — the movement has to survive the re-render or "ArrowLeft
   * on the 1st" would silently do nothing. A ref, not state, because this is a
   * request to move focus once rather than a value the grid renders.
   */
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    if (pendingFocus.current) {
      moveFocusTo(pendingFocus.current);
      pendingFocus.current = null;
      return;
    }
    if (autoFocusDay && focusable) moveFocusTo(focusable);
    // `focusable` and `month` together describe "the grid now shows this".
  }, [month, autoFocusDay, focusable]);

  const onDayKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, date: string) => {
    const steps: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    let next = "";
    if (event.key in steps) {
      next = shiftBoardCalendarDay(date, steps[event.key]);
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      /* A month, clamped — see `shiftBoardCalendarDayByMonth`. */
      next = shiftBoardCalendarDayByMonth(date, event.key === "PageUp" ? -1 : 1);
    } else if (event.key === "Home") {
      next = boardCalendarMonthOf(date);
    } else if (event.key === "End") {
      next = shiftBoardCalendarDay(
        shiftBoardCalendarMonth(boardCalendarMonthOf(date), 1),
        -1,
      );
    } else {
      return;
    }

    event.preventDefault();
    if (!moveFocusTo(next)) {
      // The day is in another month: show it, then focus it once it exists.
      pendingFocus.current = next;
      onMonthChange(boardCalendarMonthOf(next));
    }
  };

  return (
    <div
      className={`mobile-board-calendar mobile-board-calendar--${mode}`}
      aria-label={boardCalendarMonthLabel(month)}
    >
      {!hideHeader && (
        <div className="mobile-board-calendar__month">
          <strong>{boardCalendarMonthLabel(month, yearFirst)}</strong>
          <span>
            {showYearNav && (
              <button
                className="is-previous is-year"
                type="button"
                aria-label="Previous year"
                onClick={() => onMonthChange(shiftBoardCalendarYear(month, -1))}
              >
                <Icon name="chevron" size={22} />
              </button>
            )}
            <button
              className="is-previous"
              type="button"
              aria-label="Previous month"
              onClick={() => onMonthChange(shiftBoardCalendarMonth(month, -1))}
            >
              <Icon name="chevron" size={22} />
            </button>
            <button
              type="button"
              aria-label="Next month"
              onClick={() => onMonthChange(shiftBoardCalendarMonth(month, 1))}
            >
              <Icon name="chevron" size={22} />
            </button>
            {showYearNav && (
              <button
                className="is-year"
                type="button"
                aria-label="Next year"
                onClick={() => onMonthChange(shiftBoardCalendarYear(month, 1))}
              >
                <Icon name="chevron" size={22} />
              </button>
            )}
          </span>
        </div>
      )}
      <div className="mobile-board-calendar__weekdays" aria-hidden="true">
        {weekdays.map((weekday) => (
          <span key={weekday}>{weekday}</span>
        ))}
      </div>
      <div className="mobile-board-calendar__days" ref={gridRef}>
        {days.map((date, index) => {
          if (!date) {
            return <span key={`empty-${index}`} aria-hidden="true" />;
          }
          const isStart = date === selectedStart;
          const isEnd = mode === "range" && date === selectedEnd;
          const inRange = Boolean(
            mode === "range" &&
              selectedStart &&
              selectedEnd &&
              date >= selectedStart &&
              date <= selectedEnd,
          );
          const classNames = [
            isStart ? "is-range-start" : "",
            isEnd ? "is-range-end" : "",
            inRange ? "is-in-range" : "",
            mode === "single" && isStart ? "is-selected" : "",
            date === today ? "is-today" : "",
            index % 7 === 0 ? "is-week-start" : "",
            index % 7 === 6 ? "is-week-end" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={date}
              className={classNames}
              type="button"
              data-day={date}
              /* See `focusable`: the grid is one tab stop, the arrows do the rest. */
              tabIndex={date === focusable ? 0 : -1}
              aria-label={formatFullBoardDate(date)}
              aria-pressed={isStart || isEnd}
              aria-current={date === today ? "date" : undefined}
              onKeyDown={(event) => onDayKeyDown(event, date)}
              onClick={() => onSelect(date)}
            >
              <span>{Number(date.slice(8))}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
