"use client";

/**
 * Expiry cell — the board cell behind the nine certificate-expiry `date`
 * columns on Store Documentation UK (PLI, PAT, Electrical Wiring, Fire
 * Extinguisher, Fire Alarm, Emergency Lighting, Sprinkler, Water Hygiene and
 * Fire Door). The other three document slots on that board — RAMS, the Fire
 * Risk Assessment and the Drawing — carry no expiry at all and are marked
 * `expiryColumn: null` in `storeDocumentationUndated`; they never render this
 * cell, so an undated requirement is never shown as an empty date box.
 *
 * Why this exists rather than the plain `DateCell` in board-cells.tsx: a
 * maintenance date is a schedule, an expiry date is a legal position. Reading
 * "12 Mar 2026" tells you nothing about whether the store is currently
 * compliant, and a lapsed fire alarm certificate is the kind of thing that has
 * to be obvious from across the room. So the cell renders the RAG state, not
 * just the value.
 *
 * The editing affordance deliberately matches `DateCell`:
 *   - desktop clicks through to a native `<input type="date">`, saved on change;
 *   - mobile opens a `MobileCellSheet` around the shared `MobileBoardCalendar`;
 *   - saves go through `boardDateValue` / `serializeBoardDateMetadata`, the same
 *     pair every other date column on the board writes;
 *   - Enter commits (by blurring), Escape reverts, exactly as `ItemNameEditor`.
 * Date entry is not reinvented here — only the way the value is presented.
 *
 * `expiryStatus` is pure and re-exported from here so the Compliance Tracker and
 * the Calendar view can classify the same nine columns without rendering a
 * cell, and so it can be unit-tested with an injected `today`. It now *lives*
 * in app/lib/expiry-status.ts rather than in this file: a "use client"
 * component cannot be imported by `/api/workspace` or the compliance digest, so
 * keeping the only date-based verdict in the codebase here is what let the
 * server invent a second, dateless answer. Same function, same exports, one
 * definition — see the header of app/lib/expiry-status.ts.
 */
import { useContext, useState } from "react";
import { Icon, type IconName } from "../../../components";
import type { BoardDateMetadata } from "../board-model";
import {
  boardCalendarMonth,
  boardDateValue,
  dateInputValue,
  parseBoardDateMetadata,
  serializeBoardDateMetadata,
} from "../board-format";
import { MobileBoardCalendar } from "../board-cells";
import { MobileBoardContext, MobileCellSheet } from "../board-primitives";
import expiryCellCss from "./expiry-cell.css?url";

/* ── Policy and the pure classifier ──────────────────────────────────────── */

/*
 * Both moved to app/lib/expiry-status.ts and are re-exported unchanged, so
 * `import { expiryStatus } from "../cells/expiry-cell"` keeps working for the
 * Compliance Tracker and the Calendar while `/api/workspace` and the compliance
 * digest can import the same code without pulling a React component into a
 * request handler.
 */
export {
  EXPIRY_DUE_SOON_DAYS,
  expiryStatus,
  formatExpiryDate,
  type ExpiryState,
  type ExpiryStatus,
} from "../../../lib/expiry-status";

import {
  expiryStatus,
  formatExpiryDate,
  type ExpiryState,
} from "../../../lib/expiry-status";

/* ── Presentation ─────────────────────────────────────────────────────────── */

/**
 * Glyph per state. Colour is never the only signal on this cell: the glyph and
 * the state word carry the same message in greyscale, in print, and for anyone
 * who cannot separate the red from the green.
 *
 * `not-recorded` has no icon on purpose — a question mark reads as "unknown",
 * which is precisely the point, whereas any of the status icons would read as
 * some kind of verdict.
 */
const expiryGlyphs: Record<ExpiryState, IconName | null> = {
  expired: "alert",
  "due-soon": "clock",
  valid: "check",
  "not-recorded": null,
};

function ExpiryGlyph({ state, size = 15 }: { state: ExpiryState; size?: number }) {
  const icon = expiryGlyphs[state];
  return (
    <span className="expiry-cell__glyph" aria-hidden="true">
      {icon ? <Icon name={icon} size={size} /> : <b>?</b>}
    </span>
  );
}

export type ExpiryCellProps = {
  /** Column title, e.g. "Fire Alarm Expiry". Fronts the accessible name. */
  title: string;
  /** Whether the date may be removed. Defaults to true, as on `DateCell`. */
  clearable?: boolean;
  /** The stored column value. */
  value: string | null | undefined;
  /** The serialised date metadata, when the board keeps it separately. */
  metadataValue?: string | null;
  /** Same signature as `DateCell.onSave` — value first, metadata second. */
  onSave: (value: string | null, metadataValue: string) => void;
  /** Injectable clock, for tests and for pinning a whole board to one instant. */
  today?: Date;
};

/**
 * The cell. Shows the RAG state, the state word and the en-GB date; clicking it
 * opens the same date entry the rest of the board uses.
 */
export function ExpiryCell({
  title,
  clearable = true,
  value,
  metadataValue,
  onSave,
  today,
}: ExpiryCellProps) {
  const mobile = useContext(MobileBoardContext);
  const currentDate = dateInputValue(value);
  const currentMetadata = parseBoardDateMetadata(
    metadataValue ?? value,
    currentDate,
  );

  const [editing, setEditing] = useState(false);
  const [draftDate, setDraftDate] = useState(currentMetadata.date);
  const [calendarMonth, setCalendarMonth] = useState(
    boardCalendarMonth(currentMetadata.date),
  );

  const status = expiryStatus(currentMetadata.date, today ?? new Date());
  const accessibleName = `${title}: ${status.description}`;

  /**
   * Writes through `boardDateValue` / `serializeBoardDateMetadata` like every
   * other date column, and spreads the existing metadata so a time or icon set
   * elsewhere on the column survives an expiry edit.
   */
  const commit = (nextDate: string) => {
    if (!nextDate) {
      if (clearable) onSave(null, "");
      setEditing(false);
      return;
    }
    const metadata = {
      ...currentMetadata,
      date: nextDate,
    } satisfies BoardDateMetadata;
    onSave(boardDateValue(metadata), serializeBoardDateMetadata(metadata));
    setEditing(false);
  };

  /** Today as the `<input type="date">` value, honouring an injected clock. */
  const todayInputValue = (clock?: Date) => {
    const now = clock ?? new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${now.getFullYear()}-${month}-${day}`;
  };

  const openEditor = () => {
    setDraftDate(currentMetadata.date);
    setCalendarMonth(boardCalendarMonth(currentMetadata.date));
    setEditing(true);
  };

  const trigger = (
    <button
      className="expiry-cell__trigger"
      type="button"
      aria-label={accessibleName}
      title={accessibleName}
      onClick={openEditor}
    >
      <ExpiryGlyph state={status.state} />
      <span className="expiry-cell__body">
        <span className="expiry-cell__label">{status.label}</span>
        <span className="expiry-cell__date">
          {status.date ? formatExpiryDate(status.date, "short") : "No date on file"}
        </span>
      </span>
    </button>
  );

  return (
    <>
      {/* React 19 hoists and de-duplicates this, so the cell ships its own CSS
          without any existing stylesheet or layout having to change. */}
      <link rel="stylesheet" href={expiryCellCss} precedence="board" />

      <div className={`expiry-cell is-${status.state}`}>
        {editing && !mobile ? (
          /*
           * The desktop editor: the native picker, plus the two verbs a date
           * cell is always asked for. It was the bare input before, which
           * meant "make this today" was a trip through the calendar and
           * "remove this date" had no affordance at all outside the mobile
           * sheet — the keyboard could clear the field, nothing said so.
           *
           * `onBlur` closes the editor, so both buttons commit on
           * `onMouseDown` (which fires first) rather than on click, or the
           * blur would unmount them before the click landed.
           */
          <div
            className="expiry-cell__editor"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setDraftDate(currentMetadata.date);
                setEditing(false);
              }
            }}
          >
            <input
              className="expiry-cell__input"
              type="date"
              autoFocus
              value={draftDate}
              aria-label={`Set ${title}`}
              onChange={(event) => {
                setDraftDate(event.target.value);
                commit(event.target.value);
              }}
              onBlur={(event) => {
                /* Keep the editor open while focus moves to Today/Clear. */
                if (event.relatedTarget instanceof Node &&
                    event.currentTarget.parentElement?.contains(event.relatedTarget)) {
                  return;
                }
                setEditing(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
            <span className="expiry-cell__actions">
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  commit(todayInputValue(today));
                }}
              >
                Today
              </button>
              {clearable && currentMetadata.date && (
                <button
                  type="button"
                  className="is-clear"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    setDraftDate("");
                    commit("");
                  }}
                >
                  Clear
                </button>
              )}
            </span>
          </div>
        ) : (
          trigger
        )}
      </div>

      {editing && mobile && (
        <MobileCellSheet
          title={title}
          subtitle={status.description}
          onClose={() => setEditing(false)}
          className={`mobile-date-sheet expiry-cell-sheet is-${status.state}`}
          closeFirst
          headerAction={
            <button
              className="primary-button mobile-date-sheet__save"
              type="button"
              disabled={!draftDate && !clearable}
              onClick={() => commit(draftDate)}
            >
              Save
            </button>
          }
        >
          <div className="expiry-cell-sheet__status">
            <ExpiryGlyph state={status.state} size={20} />
            <span>
              <span className="expiry-cell-sheet__status-label">
                {status.label}
              </span>
              <br />
              <span className="expiry-cell-sheet__status-date">
                {status.date
                  ? formatExpiryDate(status.date, "long")
                  : "No expiry date recorded"}
              </span>
            </span>
          </div>

          <div className="mobile-date-sheet__options">
            <div className="mobile-date-sheet__chips">
              <div className="mobile-date-sheet__chip is-date">
                <button
                  type="button"
                  onClick={() => setCalendarMonth(boardCalendarMonth(draftDate))}
                >
                  <span>
                    {draftDate
                      ? `Expires ${formatExpiryDate(draftDate, "long")}`
                      : "Choose expiry date"}
                  </span>
                </button>
                {clearable && draftDate && (
                  <button
                    className="mobile-date-sheet__chip-clear"
                    type="button"
                    aria-label={`Clear ${title}`}
                    onClick={() => setDraftDate("")}
                  >
                    <Icon name="close" size={14} />
                  </button>
                )}
              </div>
            </div>

            <MobileBoardCalendar
              month={calendarMonth}
              mode="single"
              weekStartsOn={1}
              selectedStart={draftDate}
              onMonthChange={setCalendarMonth}
              onSelect={setDraftDate}
            />
          </div>
        </MobileCellSheet>
      )}
    </>
  );
}
