"use client";

/**
 * The operations calendar as a PANEL — everything from the control bar down to
 * the grid, with nothing above it.
 *
 * WHY THIS IS ITS OWN COMPONENT
 *
 * The calendar was built once, on the Planned page, and the owner went looking
 * for it on the board's Calendar view TAB — which is where a person who thinks
 * "I want to see this board as a calendar" actually goes. That tab was drawing
 * a different component entirely: a bare month grid with a month stepper, keyed
 * on Date Requested, with no view switcher, no date sources, no filters, no
 * colours and no way to change a date. Two calendars, and the one with the
 * features was not the one being opened.
 *
 * So the panel is a component rather than a page section, and both surfaces
 * mount it:
 *
 *   /dashboard/planned      the Operations calendar page, with its own date
 *                           range above and the planned register below
 *   board → Calendar tab    that board's items, as a calendar
 *
 * It owns every piece of calendar state — the mode, the anchor, the selected
 * day, the date sources, the filters and the colours — because all of them are
 * calendar state and none of them belongs to whatever is hosting it. What it
 * does NOT own is the records: those arrive as props, already scoped by the
 * host, so the board tab shows that board's items and the Planned page shows
 * the whole workspace.
 *
 * IT IS STILL A VIEW OVER SOURCE RECORDS. Every date drawn is read from
 * `maintenance_requests` or the compliance register, and every date changed is
 * written straight back through `calendarWriteTarget` to the field the board
 * and the drawer read. There is deliberately no `calendar_events` table.
 */

import { useMemo, useState } from "react";
import { Icon } from "../../components";
import { useCapability } from "../../lib/client-capabilities";
import type { MaintenanceRequest } from "../../lib/types";
import type { WorkspaceSnapshot } from "../../lib/workspace-data";
import {
  CALENDAR_DATE_SOURCES,
  buildCalendarEvents,
  calendarDayLabel,
  calendarEditCapability,
  calendarFilterCount,
  calendarFilterOptions,
  calendarJobDateValues,
  calendarWriteTarget,
  groupCalendarEventsByDay,
  todayCalendarDay,
  type CalendarDay,
  type CalendarEvent,
  type CalendarWriteTarget,
} from "./calendar-model";
import {
  CalendarNav,
  CalendarSurface,
  CalendarViewSwitcher,
} from "./calendar-views";
import {
  CalendarColourSettings,
  CalendarDateSourcePicker,
  CalendarFilterBar,
  CalendarLegend,
} from "./calendar-controls";
import {
  calendarChipStyle,
  useCalendarColours,
  useCalendarFilters,
  useCalendarSources,
  useCalendarViewMode,
} from "./calendar-preferences";
import "./calendar-page.css";

/**
 * Every date source, as a stable array.
 *
 * Module-level rather than mapped inside the component: a fresh array on every
 * render would change a `useMemo` dependency that never actually changes, and
 * rebuild the whole event set for nothing.
 */
const EVERY_CALENDAR_SOURCE_ID: readonly string[] = CALENDAR_DATE_SOURCES.map(
  (source) => source.id,
);

/** The host's date range, or null for a surface that shows everything. */
export type CalendarPeriodWindow = { start: number; end: number } | null;

export type OperationsCalendarPanelProps = {
  requests: MaintenanceRequest[];
  complianceRecords: WorkspaceSnapshot["compliance"];
  /**
   * The HOST's date range. The Planned page has a PeriodPicker above the panel
   * and passes its window here; the board's Calendar tab has no such control
   * and passes null, which shows every date the records carry.
   */
  periodWindow?: CalendarPeriodWindow;
  /** Clears the host's range. Only rendered when the host can clear one. */
  onShowAllDates?: () => void;
  onOpenRequest: (request: MaintenanceRequest) => void;
  /* A renewal on the grid opens the certificate behind it, the same way a job
     opens its work order — see `CalendarEvent.kind`. */
  onOpenCompliance: (id: string | null) => void;
  onNotify: (message: string) => void;
  /** Writes a job's own date field. Rejects with a readable message on refusal. */
  onJobDateChange: (
    id: string,
    field: "dueAt" | "requestedAt" | "completedAt" | "nextUpdateAt",
    day: string | null,
  ) => Promise<void>;
  /** Writes a certificate expiry back to whichever store actually holds it. */
  onComplianceDateChange: (
    target: CalendarWriteTarget,
    day: string,
  ) => Promise<void>;
};

export function OperationsCalendarPanel({
  requests,
  complianceRecords,
  periodWindow = null,
  onShowAllDates,
  onOpenRequest,
  onOpenCompliance,
  onNotify,
  onJobDateChange,
  onComplianceDateChange,
}: OperationsCalendarPanelProps) {
  const today = useMemo(() => new Date(), []);
  const todayDay = useMemo(() => todayCalendarDay(today), [today]);

  /* Remembered per person per browser — see calendar-preferences.ts, which
     says plainly why that is the storage and not an account setting. */
  const [mode, setMode] = useCalendarViewMode();
  const [sourceIds, setSourceIds] = useCalendarSources();
  const [filters, setFilters] = useCalendarFilters();
  const [colours, setColours] = useCalendarColours();

  /*
   * ONE ANCHOR FOR ALL THREE MODES.
   *
   * Month, Week and Day are three windows onto the same day, so switching must
   * not move the reader: anchored on 24 August, Week opens the week containing
   * the 24th and Day opens the 24th. A cursor per mode would lose the reader's
   * place on every switch, which is the one thing that makes a three-mode
   * calendar feel broken.
   */
  const [anchor, setAnchor] = useState<CalendarDay>(todayDay);
  const [selectedDay, setSelectedDay] = useState<CalendarDay>(todayDay);

  /*
   * A STABLE KEY FOR THE HOST'S RANGE.
   *
   * `periodWindow` is a fresh object on every render of the host, so using it
   * as a memo dependency would rebuild the whole event set continuously. The
   * two numbers inside it are what actually change.
   */
  const periodKey = periodWindow
    ? `${periodWindow.start}:${periodWindow.end}`
    : "all";

  const withinPeriod = (value: string | null | undefined) => {
    if (!periodWindow) return true;
    if (!value) return false;
    const at = Date.parse(value);
    return Number.isNaN(at) ? false : at >= periodWindow.start && at <= periodWindow.end;
  };

  /*
   * The range applied to the RECORDS, before any event is built.
   *
   * The Due Date pass comes first and on its own because it is the source this
   * page has always drawn and the one the range control was written for. The
   * second pass then admits a job kept only for another selected date: this
   * screen draws four job date fields, and a job whose Next Update falls in the
   * window belongs in it even when its due date does not.
   */
  const periodRequests = useMemo(() => {
    if (!periodWindow) return requests;
    const kept: MaintenanceRequest[] = [];
    for (const request of requests) {
      if (!withinPeriod(request.dueAt)) continue;
      kept.push(request);
    }
    const seen = new Set(kept.map((request) => request.id));
    for (const request of requests) {
      if (seen.has(request.id)) continue;
      if (calendarJobDateValues(request, sourceIds).some(withinPeriod)) {
        kept.push(request);
      }
    }
    return kept;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodKey, requests, sourceIds]);

  const periodCompliance = useMemo(() => {
    if (!periodWindow) return complianceRecords;
    const kept: WorkspaceSnapshot["compliance"] = [];
    for (const record of complianceRecords) {
      if (!withinPeriod(record.expiry)) continue;
      kept.push(record);
    }
    return kept;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [complianceRecords, periodKey]);

  /* Facet values are counted over EVERYTHING, not over what the range left, so
     a filter menu does not empty itself as the range narrows. */
  const filterOptions = useMemo(
    () => calendarFilterOptions({ requests, complianceRecords }),
    [complianceRecords, requests],
  );

  /*
   * ONE BUILD, THREE ANSWERS.
   *
   * The screen needs what is drawn, a tally per date source for the picker, and
   * a count of what the range removed. Each of those was its own
   * `buildCalendarEvents` call at first — three passes over every job on every
   * keystroke in a filter, which on a board of 753 jobs across five sources is
   * three thousand objects built to answer two questions that are subsets of
   * the first.
   */
  const allEvents = useMemo(
    () =>
      buildCalendarEvents({
        requests: periodRequests,
        complianceRecords: periodCompliance,
        sourceIds: EVERY_CALENDAR_SOURCE_ID,
        filters,
        today: todayDay,
      }),
    [filters, periodCompliance, periodRequests, todayDay],
  );

  /*
   * THE RANGE CONSTRAINS DAYS, NOT JUST RECORDS.
   *
   * The prefilter above keeps a record if ANY of its selected dates is in the
   * window, which is right — but on its own it would then draw ALL of that
   * record's dates, including the ones outside. A job raised in January and due
   * next week would put its January date on the grid under "Last 90 days" and
   * the count beside the range would not know about it.
   *
   * Whole days, deliberately: `event.day` is the calendar date, and a range on
   * a calendar is a range of days.
   */
  const withinPeriodDay = (day: CalendarDay) => {
    if (!periodWindow) return true;
    const at = Date.parse(day);
    return Number.isNaN(at) ? false : at >= periodWindow.start && at <= periodWindow.end;
  };

  const selectedEvents = useMemo(() => {
    const chosen = new Set(sourceIds);
    return allEvents.filter((event) => chosen.has(event.sourceId));
  }, [allEvents, sourceIds]);

  const events = useMemo(
    () => selectedEvents.filter((event) => withinPeriodDay(event.day)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [periodKey, selectedEvents],
  );

  /*
   * What the range removed, in two parts because the range removes in two
   * places: dates on a record that survived the prefilter, and every date on a
   * record that did not. Both are counted rather than estimated — the notice
   * puts this number in front of somebody asking where their job went, and a
   * number that is nearly right is worse there than no number at all.
   */
  const hiddenByPeriod = useMemo(() => {
    if (!periodWindow) return 0;
    const fromKept = selectedEvents.length - events.length;
    const kept = new Set(periodRequests.map((request) => request.id));
    const keptCompliance = new Set(periodCompliance.map((record) => record.id));
    const dropped = requests.filter((request) => !kept.has(request.id));
    const droppedCompliance = complianceRecords.filter(
      (record) => !keptCompliance.has(record.id),
    );
    if (!dropped.length && !droppedCompliance.length) return fromKept;
    return (
      fromKept +
      buildCalendarEvents({
        requests: dropped,
        complianceRecords: droppedCompliance,
        sourceIds,
        filters,
        today: todayDay,
      }).length
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    complianceRecords,
    events.length,
    filters,
    periodKey,
    periodCompliance,
    periodRequests,
    requests,
    selectedEvents.length,
    sourceIds,
    todayDay,
  ]);

  const eventsByDay = useMemo(() => groupCalendarEventsByDay(events), [events]);

  /* The per-source tallies the picker prints, so "Next Update — 0" is legible
     before somebody turns it on and wonders why nothing appeared. */
  const sourceCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const source of CALENDAR_DATE_SOURCES) counts[source.id] = 0;
    for (const event of allEvents) {
      if (withinPeriodDay(event.day)) counts[event.sourceId] += 1;
    }
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allEvents, periodKey]);

  /*
   * MAY THIS PERSON MOVE A DATE?
   *
   * Two capabilities, because these are two systems: a job's own date and a
   * Store Documentation board cell are `board.edit`; the compliance register is
   * `sites.edit`. Both are enforced on the server, on the request that does the
   * thing — this only decides whether to DRAW the control, so nobody is offered
   * a button that will refuse them.
   *
   * `null` from `useCapability` means "not answered yet", and an unanswered
   * question is not a denial: the affordance stays until the answer arrives.
   */
  const mayEditBoard = useCapability("board.edit");
  const mayEditSites = useCapability("sites.edit");
  const mayEdit = (event: CalendarEvent) => {
    const capability = calendarEditCapability(event);
    if (!capability) return false;
    return (capability === "board.edit" ? mayEditBoard : mayEditSites) !== false;
  };
  const canEditAnything = mayEditBoard !== false || mayEditSites !== false;

  const [editing, setEditing] = useState<CalendarEvent | null>(null);

  const openEvent = (event: CalendarEvent) => {
    if (event.kind === "job" && event.request) {
      onOpenRequest(event.request);
      return;
    }
    onOpenCompliance(event.recordId ?? null);
  };

  const commitDate = async (event: CalendarEvent, day: CalendarDay) => {
    const target = calendarWriteTarget(event);
    if (target.path === "none") {
      onNotify(target.reason);
      return;
    }
    try {
      if (target.path === "job") {
        await onJobDateChange(target.id, target.field, day);
      } else {
        await onComplianceDateChange(target, day);
      }
      onNotify(
        `${event.title} — ${event.fieldLabel} moved to ${calendarDayLabel(day)}.`,
      );
      setEditing(null);
    } catch (error) {
      /* The caller has already put the record back the way it was; all that is
         left is to say why, and to leave the picker open on the value the
         person chose so they can retry or cancel rather than start again. */
      onNotify(
        error instanceof Error ? error.message : "That date could not be saved.",
      );
    }
  };

  const activeFilters = calendarFilterCount(filters);

  /*
   * Four different silences, told apart.
   *
   * "Nothing here" and "nothing that matches what you asked for" and "you have
   * not chosen a date field" are three different problems with three different
   * fixes, and a single "No events" would hide which one the reader has.
   */
  const emptyState = !sourceIds.length ? (
    <div className="calendar-empty">
      <strong>No date field is selected.</strong>
      <p>
        Choose at least one date under <em>Dates</em> for anything to appear on
        this calendar.
      </p>
    </div>
  ) : activeFilters > 0 ? (
    <div className="calendar-empty">
      <strong>Nothing matches these filters.</strong>
      <p>
        {activeFilters} filter{activeFilters === 1 ? " is" : "s are"} applied.
        Clearing them will show the rest of this period.
      </p>
    </div>
  ) : (
    <div className="calendar-empty">
      <strong>Nothing is scheduled here.</strong>
      <p>
        Jobs appear on the dates their records carry and certificates on their
        expiry. Nothing is shown here that is not on a record.
      </p>
    </div>
  );

  return (
    <>
      <section className="panel calendar-panel">
        <div className="calendar-bar">
          <CalendarNav
            mode={mode}
            anchor={anchor}
            today={todayDay}
            onAnchorChange={(next) => {
              setAnchor(next);
              setSelectedDay(next);
            }}
          />
          <div className="calendar-bar__controls">
            <CalendarViewSwitcher value={mode} onChange={setMode} />
            <CalendarDateSourcePicker
              value={sourceIds}
              onChange={setSourceIds}
              counts={sourceCounts}
            />
            <CalendarColourSettings colours={colours} onChange={setColours} />
          </div>
        </div>

        <CalendarFilterBar
          filters={filters}
          options={filterOptions}
          onChange={setFilters}
        />

        {hiddenByPeriod > 0 && (
          <p className="calendar-period-notice" role="status">
            <Icon name="alert" size={14} />
            <span>
              {hiddenByPeriod} event{hiddenByPeriod === 1 ? " is" : "s are"}{" "}
              outside the selected date range, so they are not drawn.
            </span>
            {onShowAllDates && (
              <button type="button" onClick={onShowAllDates}>
                Show all dates
              </button>
            )}
          </p>
        )}

        <CalendarLegend colours={colours} />

        <CalendarSurface
          mode={mode}
          anchor={anchor}
          today={todayDay}
          eventsByDay={eventsByDay}
          chipStyle={(event) => calendarChipStyle(event, colours)}
          typeLabel={(event) => (event.kind === "compliance" ? "Compliance" : "Job")}
          onOpen={openEvent}
          onEditDate={
            canEditAnything
              ? (event) => {
                  if (!mayEdit(event)) {
                    onNotify("You do not have permission to change this date.");
                    return;
                  }
                  setEditing(event);
                }
              : null
          }
          selectedDay={selectedDay}
          /*
           * SELECTING A DAY MOVES THE ANCHOR TOO.
           *
           * They were separate at first and it broke the one promise the mode
           * switcher makes. Select the 18th of October in the month grid, then
           * press Week: you got the week of the 24th, because the anchor was
           * still wherever paging had left it and only the agenda below the
           * grid knew about the 18th. The reader had said which day they meant
           * and the calendar answered with a different one.
           */
          onSelectDay={(day) => {
            setSelectedDay(day);
            setAnchor(day);
          }}
          emptyState={emptyState}
        />
      </section>

      {editing && (
        <CalendarDateDialog
          event={editing}
          onCancel={() => setEditing(null)}
          onSave={(day) => commitDate(editing, day)}
        />
      )}
    </>
  );
}

/**
 * "Change date" — the calendar's accessible, non-drag way to move a date.
 *
 * A dialog rather than an inline popover because this is a WRITE to a customer
 * record: it names the record, names the field it is about to change, shows the
 * date the record holds now, and cannot be dismissed by a stray click on the
 * grid behind it. Drag-to-move may exist as well, but drag is the convenience
 * and this is the METHOD — somebody on a keyboard, a screen reader or a small
 * phone gets exactly the same ability as somebody with a mouse.
 */
function CalendarDateDialog({
  event,
  onCancel,
  onSave,
}: {
  event: CalendarEvent;
  onCancel: () => void;
  onSave: (day: CalendarDay) => Promise<void> | void;
}) {
  const [day, setDay] = useState<CalendarDay>(event.day);
  const [busy, setBusy] = useState(false);

  return (
    <div
      className="calendar-date-dialog__scrim"
      role="presentation"
      onKeyDown={(pressed) => {
        if (pressed.key === "Escape") onCancel();
      }}
    >
      <div
        className="calendar-date-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="calendar-date-dialog-title"
      >
        <h2 id="calendar-date-dialog-title">Change date</h2>
        <p className="calendar-date-dialog__record">
          <strong>{event.title}</strong>
          <span>
            {event.kind === "compliance" ? "Compliance" : "Job"} ·{" "}
            {event.fieldLabel}
          </span>
        </p>
        <label className="calendar-date-dialog__field">
          <span>{event.fieldLabel}</span>
          <input
            autoFocus
            type="date"
            value={day}
            onChange={(changed) => setDay(changed.target.value)}
          />
        </label>
        <p className="calendar-date-dialog__current">
          This record currently reads {calendarDayLabel(event.day)}.
        </p>
        <div className="calendar-date-dialog__actions">
          <button className="secondary-button" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={busy || !day || day === event.day}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(day);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Save date"}
          </button>
        </div>
      </div>
    </div>
  );
}
