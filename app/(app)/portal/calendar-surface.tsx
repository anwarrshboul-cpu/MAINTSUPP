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

import { useCallback, useEffect, useMemo, useState } from "react";
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
  type ManualCalendarItem,
} from "./calendar-model";
/*
 * W11 — manual items. The panel owns this feature end to end: it reads them,
 * writes them and draws them, and the HOST is not involved at all.
 *
 * That is deliberate rather than convenient. Jobs and certificates arrive as
 * props because the host already holds them for five other screens and a second
 * fetch would be a second answer; a manual item exists for this calendar and
 * nowhere else, so a prop for it would make every mounting of this panel
 * responsible for plumbing a feature it does not otherwise touch.
 */
import {
  createManualEvent,
  deleteManualEvent,
  fetchManualEvents,
  moveManualEvent,
  updateManualEvent,
  type ManualEventDraft,
} from "./manual-event-client";
import { ManualEventDialog } from "./manual-event-dialog";
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
import { parseStamp } from "./period-model";
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
  /**
   * W11 — the sites a manual item may be attached to. Optional, and an absent
   * list is a working feature rather than a broken one: an item need not be
   * about a site at all, so the picker simply offers "No site" and nothing else.
   */
  sites?: { id: string; name: string }[];
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
  sites = [],
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
   * W11 — the manual items, and the counter that reloads them.
   *
   * A COUNTER RATHER THAN A CALLABLE LOADER, which is the pattern
   * `use-loader.ts` and the rest of this dashboard use: the work is declared
   * inside the effect and state is only touched after the await resolves, so
   * there is no synchronous set in an effect body and no cascading render.
   * `active` guards a response that arrives after the screen has moved on.
   *
   * RE-READ AFTER EVERY WRITE, never patched locally. Every verb answers with
   * the row it changed and splicing that in would be cheaper — and would be a
   * second model of what an item is, which is exactly how a moved range and a
   * resized one came to disagree once already. One read after each write is the
   * version of this that cannot drift.
   */
  const [manualItems, setManualItems] = useState<ManualCalendarItem[]>([]);
  const [manualNonce, setManualNonce] = useState(0);
  const reloadManual = useCallback(() => setManualNonce((n) => n + 1), []);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const next = await fetchManualEvents();
        if (active) setManualItems(next);
      } catch {
        /*
         * SILENT, AND ONLY HERE. A workspace whose `calendar_events` table has
         * not been created yet — a deployment mid-migration — would otherwise
         * put a toast in front of every reader on every page load, about a
         * feature they may not use. The jobs and the certificates are still
         * drawn, which is the calendar doing its main job. Every WRITE reports
         * its own failure loudly, because a write that appears to have
         * succeeded is a different and much worse silence.
         */
        if (active) setManualItems([]);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [manualNonce]);

  /** The item being created or edited, or null. `"new"` is the create form. */
  const [manualEditing, setManualEditing] = useState<ManualCalendarItem | "new" | null>(
    null,
  );

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

  /*
   * `parseStamp`, not `Date.parse`.
   *
   * `periodWindow` is built by `resolvePeriod` out of LOCAL midnights, and a
   * job date arrives in the two forms this database stores. `Date.parse` reads
   * a bare `2026-09-01` as UTC midnight and a `2026-09-01 08:00:00` as local,
   * so west of Greenwich a job due on the first of a range's first day was
   * measured an hour or eight before that range began and dropped out of it.
   * The shared parser reads both forms as the wall-clock they were written as,
   * which is the same clock the bounds were built on.
   *
   * The null guard above is real, unlike its counterparts elsewhere: the host
   * passes `periodWindow` as null when no range is selected.
   */
  const withinPeriod = (value: string | null | undefined) => {
    if (!periodWindow) return true;
    if (!value) return false;
    const at = parseStamp(value);
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
        manualItems,
        sourceIds: EVERY_CALENDAR_SOURCE_ID,
        filters,
        today: todayDay,
      }),
    [filters, manualItems, periodCompliance, periodRequests, todayDay],
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
    /*
     * The same parser as above, and the same reason. A `CalendarDay` is a bare
     * `YYYY-MM-DD`, which `Date.parse` reads as UTC midnight — so west of
     * Greenwich it resolved to the evening BEFORE, and the first day of every
     * range fell outside the range that named it.
     */
    const at = parseStamp(day);
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
    /*
     * W11 — a manual chip opens the item that made it. It must never fall
     * through to `onOpenCompliance`, which would hand a `cal-…` id to the
     * compliance register and open an empty drawer for a record that is not
     * one — the class of confusion this whole feature is built to prevent.
     */
    if (event.kind === "manual") {
      if (event.manual) setManualEditing(event.manual);
      return;
    }
    onOpenCompliance(event.recordId ?? null);
  };

  /* ── W11: the manual item verbs, each ending in one re-read ──────────── */

  const saveManual = async (draft: ManualEventDraft) => {
    const editing = manualEditing;
    if (editing === "new") {
      await createManualEvent(draft);
      onNotify(`"${draft.title}" added to the calendar.`);
    } else if (editing) {
      await updateManualEvent(editing.id, draft);
      onNotify(`"${draft.title}" updated.`);
    }
    reloadManual();
    setManualEditing(null);
  };

  const archiveManual = async (archived: boolean) => {
    const editing = manualEditing;
    if (!editing || editing === "new") return;
    await updateManualEvent(editing.id, { archived });
    onNotify(
      archived
        ? `"${editing.title}" archived. It is off the calendar until you restore it.`
        : `"${editing.title}" is back on the calendar.`,
    );
    reloadManual();
    setManualEditing(null);
  };

  const removeManual = async () => {
    const editing = manualEditing;
    if (!editing || editing === "new") return;
    await deleteManualEvent(editing.id);
    /* The word is chosen: it is a SOFT delete and the row keeps its dates and
       its note, so promising it is gone for good would be untrue. */
    onNotify(`"${editing.title}" removed from the calendar.`);
    reloadManual();
    setManualEditing(null);
  };

  const commitDate = async (event: CalendarEvent, day: CalendarDay) => {
    /*
     * The DROP DAY is passed in, and only a manual item uses it. A job or a
     * certificate is one mark on one day, so its new date IS `day`; a
     * multi-day manual item is drawn on every day it covers, and the target has
     * to work out which START that drop implies from which day was picked up.
     * See `calendarWriteTarget`, where that arithmetic lives — once.
     */
    const target = calendarWriteTarget(event, day);
    if (target.path === "none") {
      onNotify(target.reason);
      return;
    }
    try {
      if (target.path === "job") {
        await onJobDateChange(target.id, target.field, day);
      } else if (target.path === "manual") {
        /* The start alone: the route moves the end with it, so a three-day
           item stays three days long. See `moveManualEvent`. */
        await moveManualEvent(target.id, target.startsOn);
        reloadManual();
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
        expiry. Nothing is shown here that is not on a record — except an item
        you add yourself.
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
            {/*
              W11 — ADD AN ITEM, on the calendar's own bar.

              Gated on `board.edit`, which is what the route enforces
              (`WRITE_CAPABILITY` in app/api/maintenance/calendar/route.ts), so a
              reader who may not write is not offered a form that would be
              refused. `useCapability` answers `false` only when the snapshot
              has landed and said no — undefined while it is loading — so the
              button is offered rather than flickering away and back.
            */}
            {mayEditBoard !== false && (
              <button
                type="button"
                className="secondary-button manual-event-add"
                onClick={() => setManualEditing("new")}
              >
                <Icon name="plus" size={15} />
                Add item
              </button>
            )}
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
          /* Three kinds, three words. Read out on every chip and every agenda
             row, so a manual item announces itself as one rather than being
             told apart by colour alone. */
          typeLabel={(event) =>
            event.kind === "compliance"
              ? "Compliance"
              : event.kind === "manual"
                ? "Manual"
                : "Job"
          }
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
          /*
           * DRAG AND THE DIALOG ARE ONE WRITE REACHED TWO WAYS.
           *
           * `commitDate` is the only place this panel changes a date, and both
           * paths end here: it routes through `calendarWriteTarget`, so a Due
           * Date chip changes `dueAt` and nothing else however many sources are
           * switched on; the host writes optimistically and rolls the record
           * back if the server refuses; and the refusal is reported through
           * `onNotify`. A drag that is rejected therefore returns to the day it
           * came from with no phantom state anywhere, because there is no state
           * for it to be in — nothing about a dragged date is held here.
           *
           * The permission test is the same two lines as the button's, on the
           * same `canEditAnything`, because a drag and a dialog must be offered
           * together or not at all. Neither is the enforcement: the server
           * decides, and this only decides what to draw.
           */
          onMoveDate={
            canEditAnything
              ? (event, day) => {
                  if (!mayEdit(event)) {
                    onNotify("You do not have permission to change this date.");
                    return;
                  }
                  void commitDate(event, day);
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

      {manualEditing && (
        <ManualEventDialog
          item={manualEditing === "new" ? null : manualEditing}
          /* A new item starts on the day the reader is looking at, which is
             almost always the day they meant. */
          defaultDay={selectedDay}
          sites={sites}
          onCancel={() => setManualEditing(null)}
          onSave={saveManual}
          onArchive={archiveManual}
          onDelete={removeManual}
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
 * grid behind it. Drag-to-move now exists as well — see `calendar-event-drag.ts`
 * — but drag is the convenience and this is the METHOD: somebody on a keyboard,
 * a screen reader or a small phone gets exactly the same ability as somebody
 * with a mouse, and it is the whole answer on the Day surface, which has no
 * second date to drop onto. It is not optional and it does not go away.
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
