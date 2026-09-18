"use client";

/**
 * The board's date picker — a MAINTSUPP calendar, not Chromium's.
 *
 * WHAT THIS REPLACES. Date Requested, Date Completed, Next Update and Due Date
 * were a bare `<input type="date">`, so picking a day meant whatever popup the
 * browser happens to ship. On Chromium that is a white panel with a blue
 * selected day, drawn by the browser rather than by the page: it sat on the
 * navy board looking like a different application, and the owner asked for the
 * calendar itself to carry the brand.
 *
 * WHY CSS COULD NOT DO IT. That popup is not in the document. It has no DOM
 * node, no shadow root a page can reach, and no stylesheet applies to it — the
 * only hook a page gets is `accent-color`, which tints the selected day on some
 * platforms and, measured here, does not reach the popup at all on Windows
 * Chromium: the screenshot that prompted this shows the day still highlighted
 * in the default blue with `accent-color: var(--brand-fill)` already shipped.
 * There is no amount of CSS that brands it, so the popup has to go.
 *
 * WHAT REPLACES IT. The same `MobileBoardCalendar` the phone sheet and the
 * expiry cell already draw — one grid in the product, not three — inside the
 * board's own `AnchoredPopover`, which already solves flipping, edge
 * avoidance, Escape, outside-press and focus return for every other menu on
 * this board.
 *
 * TYPING SURVIVES. A date field that can only be clicked to is slower for
 * anyone who knows the date, so the panel keeps a real date input above the
 * grid. Its native picker button is hidden in the stylesheet — that indicator
 * is the only way the browser's popup can still be summoned by pointer, and
 * leaving it would put the grey panel back on the screen this change exists to
 * clear.
 */

import { useRef, useState } from "react";
import { MobileBoardCalendar, shiftBoardCalendarYear } from "../board-calendar";
import {
  boardCalendarMonth,
  boardCalendarMonthLabel,
  shiftBoardCalendarMonth,
  todayBoardDate,
} from "../board-format";
import { AnchoredPopover } from "../overlay/anchored";
import { formatDate } from "../../../lib/format-date";
import { Icon } from "../../../components";
import boardDatePickerCss from "./board-date-picker.css?url";

/**
 * A labelled date field that opens the picker above — the Timeline editor's
 * Start date and End date.
 *
 * Here rather than in `board-cells.tsx` because that file is at its 1,300-line
 * ceiling, and because "the control that opens this panel" belongs beside the
 * panel: the two share the trigger's wording, its empty state and its
 * accessible name, and a copy of them in another file is how the two fields
 * come to disagree with the date columns they are meant to match.
 *
 * It owns the DRAFT only. The Timeline editor still commits on "Save dates",
 * so the end-before-start rule stays exactly where it was.
 */
export function TimelineDateField({
  label,
  value,
  open,
  onOpenChange,
  onPick,
}: {
  label: string;
  value: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (value: string) => void;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <span className="sheet-timeline-popover__field">
      {label}
      <button
        ref={anchorRef}
        type="button"
        className={`sheet-timeline-popover__date${value ? "" : " is-empty"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${value ? formatDate(value) : "no date"}`}
        onClick={() => onOpenChange(!open)}
      >
        {value ? formatDate(value) : "—"}
      </button>
      <BoardDatePicker
        open={open}
        anchorRef={anchorRef}
        onClose={() => onOpenChange(false)}
        title={label}
        value={value}
        clearable
        onPick={(next) => onPick(next ?? "")}
      />
    </span>
  );
}

export function BoardDatePicker({
  open,
  anchorRef,
  onClose,
  title,
  value,
  clearable,
  onPick,
}: {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  /** The column's name, so the dialog and its controls say which date this is. */
  title: string;
  /** The saved day, `YYYY-MM-DD`, or "" when the cell is empty. */
  value: string;
  /** Whether this column allows removing the date. Date Requested does not. */
  clearable: boolean;
  /** `null` clears. The caller owns what saving means. */
  onPick: (value: string | null) => void;
}) {
  /*
   * The month on show. Seeded from the saved day so opening a filled cell lands
   * on that month with the day selected, and from today when the cell is empty.
   * Re-seeded on every open by the key below rather than by an effect.
   */
  const [month, setMonth] = useState(() => boardCalendarMonth(value));

  /*
   * THE STYLESHEET SHIPS WHETHER OR NOT THE PANEL IS OPEN.
   *
   * It also carries `.sheet-date__trigger` — the cell's own button — and this
   * component used to return `null` before reaching the `<link>`. So on first
   * paint every date cell on the board was UNSTYLED, and only snapped into
   * shape once a reader happened to open a picker: measured at
   * `display: block` before, `display: flex` after. `expiry-cell.tsx` renders
   * its link unconditionally for exactly this reason; this now does too.
   *
   * React 19 hoists and de-duplicates by href, so one `<link>` per date cell
   * costs nothing.
   */
  const stylesheet = (
    <link rel="stylesheet" href={boardDatePickerCss} precedence="board" />
  );

  /* Closed: the styles, and nothing else. Mounting the panel only while it is
     open is what re-seeds the month above on every open. */
  if (!open) return stylesheet;

  const step = (amount: number, unit: "month" | "year") =>
    setMonth((current) =>
      unit === "month"
        ? shiftBoardCalendarMonth(current, amount)
        : shiftBoardCalendarYear(current, amount),
    );

  return (
    <>
      {stylesheet}
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        /* IDEMPOTENT, never a toggle — the board runs its own dismissal
           alongside this one and a toggle reads the two as two presses. */
        onClose={onClose}
        placement="bottom-start"
        layer="popover-raised"
        role="dialog"
        label={`Choose ${title}`}
        className="board-date-popover"
        initialFocus="none"
      >
        <div className="board-date-popover__head">
          <button
            type="button"
            aria-label="Previous year"
            className="board-date-popover__step is-back is-year"
            onClick={() => step(-1, "year")}
          >
            <Icon name="chevron" size={16} />
            <Icon name="chevron" size={16} />
          </button>
          <button
            type="button"
            aria-label="Previous month"
            className="board-date-popover__step is-back"
            onClick={() => step(-1, "month")}
          >
            <Icon name="chevron" size={16} />
          </button>
          {/* aria-live: the month is what changes when the arrows are pressed,
              and a reader who cannot see the grid needs to be told. */}
          <strong aria-live="polite">{boardCalendarMonthLabel(month)}</strong>
          <button
            type="button"
            aria-label="Next month"
            className="board-date-popover__step"
            onClick={() => step(1, "month")}
          >
            <Icon name="chevron" size={16} />
          </button>
          <button
            type="button"
            aria-label="Next year"
            className="board-date-popover__step is-year"
            onClick={() => step(1, "year")}
          >
            <Icon name="chevron" size={16} />
            <Icon name="chevron" size={16} />
          </button>
        </div>

        <MobileBoardCalendar
          month={month}
          mode="single"
          weekStartsOn={1}
          hideHeader
          selectedStart={value}
          onMonthChange={setMonth}
          onSelect={(next) => {
            onPick(next);
            onClose();
          }}
        />

        <div className="board-date-popover__foot">
          <label className="board-date-popover__type">
            <span>Or type it</span>
            <input
              className="sheet-date-input"
              type="date"
              value={value}
              aria-label={`${title} as a date`}
              onChange={(event) => {
                const next = event.target.value;
                if (!next) {
                  if (clearable) onPick(null);
                  return;
                }
                setMonth(boardCalendarMonth(next));
                onPick(next);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onClose();
                }
              }}
            />
          </label>
          <span className="board-date-popover__actions">
            <button
              type="button"
              onClick={() => {
                /* The same "today" the grid rings, so the two cannot disagree. */
                const day = todayBoardDate();
                setMonth(boardCalendarMonth(day));
                onPick(day);
                onClose();
              }}
            >
              Today
            </button>
            {/*
              Clear is offered only where the column allows it. Date Requested
              passes `clearable={false}` because it is the timeline's start;
              that rule is the cell's, and this panel does not soften it.
            */}
            {clearable && value && (
              <button
                type="button"
                className="is-clear"
                onClick={() => {
                  onPick(null);
                  onClose();
                }}
              >
                Clear
              </button>
            )}
          </span>
        </div>
      </AnchoredPopover>
    </>
  );
}
