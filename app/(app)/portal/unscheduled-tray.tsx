"use client";

/**
 * THE UNSCHEDULED TRAY — THE JOBS A CALENDAR CANNOT SHOW YOU.
 *
 * Module 2 §7 is three sentences long and ends with a claim the rest of the
 * module does not make about itself: "this one feature will do more for
 * operations than anything else in this module." It is right, and the reason is
 * in the first sentence: "jobs with no scheduled date are invisible on a
 * calendar, which is exactly where they get forgotten."
 *
 * A calendar is a function of dates. A job with no date has no cell to be drawn
 * in, so the more the operation runs on the calendar, the more completely an
 * unbooked job disappears — and it disappears from the screen where somebody
 * would otherwise have noticed. Every other feature in this module makes the
 * booked work easier to see. This one is the only thing that makes the UNBOOKED
 * work visible at all, and unbooked work is where the SLA breaches come from.
 *
 * ── WHAT DECIDES A JOB BELONGS HERE ────────────────────────────────────────
 *
 * Open, and no scheduled date. "Open" is not a status list in this file — it is
 * `countsAsOpen` off `job_status_map`, so an admin who marks "Awaiting client
 * PO" as closed removes those jobs from the tray without a deploy, and an
 * UNMAPPED status counts as open and appears here. That last part is
 * deliberate: `job-status-map.ts` explains at length why an unmapped status is
 * shown and never hidden, and a tray that quietly dropped them would be exactly
 * the silent disagreement that module exists to prevent.
 *
 * ── WHY THE COUNT TURNS RED ────────────────────────────────────────────────
 *
 * A number alone is furniture; people stop reading it by the second week. The
 * count turns red when at least one job in the tray is inside the last quarter
 * of its response window — the same 25% §8 fires the escalation reminder on, so
 * the tray goes red at the moment the emails start rather than at some second
 * threshold invented here. Red means "there is now a job that will breach if
 * nobody books it today", which is a sentence somebody can act on.
 *
 * ── DRAGGING OUT OF THE TRAY ───────────────────────────────────────────────
 *
 * A drop asks `visitScheduleTarget` where the write goes, exactly as the
 * calendar's own drag does. That is not ceremony. `planned-visit.ts` says it
 * plainly: a drag, a dialog and a drop out of this tray are three code paths
 * that must agree about whether a schedule belongs on the job or on a calendar
 * row, "and they agree by all asking here."
 *
 * The gesture itself reads the DOM contract the calendar grid already
 * publishes — a day cell is `[data-calendar-day]` carrying `data-day`, and the
 * cell under the pointer wears `is-calendar-drop` while it is the destination.
 * Both come from `calendar-event-drag.ts`, which is the existing drag; matching
 * them means a drop out of the tray looks and behaves like a drop of a chip
 * rather than like a second, slightly different gesture on the same grid.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { Icon } from "../../components";
import { formatShortDate } from "../../lib/format-date";
import {
  jobChipAppearance,
  type JobStatusMapping,
} from "./job-status-map";
import {
  jobChipCss,
  jobDeadlineDay,
  jobScheduledDay,
  slaCountdown,
  slaWindowRemaining,
  type CalendarJob,
} from "./job-side-panel";
import { visitScheduleTarget, type VisitScheduleTarget } from "./planned-visit";
import "./unscheduled-tray.css";

/* ── The DOM contract the grid publishes ─────────────────────────────────── */

/**
 * A day cell, as `calendar-views.tsx` marks one.
 *
 * Pinned here as a named constant rather than inlined, so that when somebody
 * renames the attribute the failure is one obvious constant in one file instead
 * of a drag that silently stops finding anywhere to drop.
 */
export const CALENDAR_DAY_SELECTOR = "[data-calendar-day]";

/** The class the existing calendar drag puts on its destination cell. */
export const CALENDAR_DROP_CLASS = "is-calendar-drop";

/** Below this a press is a click, not a drag — the calendar's own threshold. */
const DRAG_THRESHOLD = 4;

/* ── Which jobs are in the tray, and in what order ───────────────────────── */

/**
 * The open, unbooked jobs, in the order §7 asks for: SLA deadline, then
 * priority.
 *
 * A job with NO deadline sorts last rather than first. Both orders are
 * defensible in the abstract and only one of them is right here: this list is
 * read from the top, and putting the jobs with no commitment above the ones
 * with a commitment running out would bury the urgent work under the work
 * nobody has promised anything about.
 *
 * `tier` is the priority key, not the label. This estate's priorities are
 * "Urgent", "Medium" and "Low" rather than §7's P1..P4, and `app/lib/
 * priority-rules.ts` records why sorting on the label is wrong: labels are
 * admin-editable, so renaming "Urgent" would silently reorder this tray. The
 * tier is the number the SLA rules already resolve a priority to, and 1 is the
 * most severe.
 */
export function unscheduledJobs(
  jobs: readonly CalendarJob[],
  statusIndex: ReadonlyMap<string, JobStatusMapping>,
): CalendarJob[] {
  const open = jobs.filter((job) => {
    if (job.archived) return false;
    if (jobScheduledDay(job)) return false;
    return jobChipAppearance(job.status, statusIndex).countsAsOpen;
  });
  return open.sort((a, b) => {
    const dayA = jobDeadlineDay(a);
    const dayB = jobDeadlineDay(b);
    if (dayA !== dayB) {
      if (!dayA) return 1;
      if (!dayB) return -1;
      return dayA < dayB ? -1 : 1;
    }
    const tierA = Number.isFinite(a.tier) ? a.tier : Number.MAX_SAFE_INTEGER;
    const tierB = Number.isFinite(b.tier) ? b.tier : Number.MAX_SAFE_INTEGER;
    if (tierA !== tierB) return tierA - tierB;
    /* A total order, so the list does not shuffle between renders on two jobs
       that are equal on both keys. */
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The fraction of the response window at which the header goes red. §8's. */
export const SLA_ALERT_FRACTION = 0.25;

/**
 * How many tray jobs are inside their SLA window.
 *
 * "Inside the window" means breached, or with a quarter or less of the agreed
 * response time left. A job with no deadline is not counted — it has no window
 * to be inside, and counting it would paint the header red on a tray of work
 * nobody has committed to a date for.
 */
export function jobsInsideSlaWindow(
  jobs: readonly CalendarJob[],
  now: number,
): number {
  let count = 0;
  for (const job of jobs) {
    const deadline = jobDeadlineDay(job);
    if (!deadline) continue;
    if (slaCountdown({ deadline, now }).breached) {
      count += 1;
      continue;
    }
    const remaining = slaWindowRemaining({
      raisedAt: job.requestedAt,
      deadline,
      now,
    });
    if (remaining !== null && remaining <= SLA_ALERT_FRACTION) count += 1;
  }
  return count;
}

/**
 * Where scheduling this job writes.
 *
 * The job IS the visit here — there is no calendar row to be a view of — so the
 * shape handed to `visitScheduleTarget` names the job on both sides and carries
 * no date of its own, which is the linked shape `planned-visit.ts` calls legal.
 * Asking rather than assuming is the point: this is the same question the
 * calendar's chip drag asks, answered by the same function, so the two cannot
 * come to different conclusions about where a schedule lives.
 */
export function jobScheduleTarget(job: CalendarJob): VisitScheduleTarget {
  return visitScheduleTarget({ id: job.id, requestId: job.id, startsOn: null });
}

/* ── The collapsed state, remembered ─────────────────────────────────────── */

export const UNSCHEDULED_TRAY_KEY = "maintsupp:calendar:tray-collapsed";

/*
 * The same mechanism `calendar-preferences.ts` uses, and the same tradeoff:
 * `localStorage` under a `maintsupp:` key read through `useSyncExternalStore`,
 * which makes this PER PERSON PER BROWSER rather than per account. There is no
 * server store for arbitrary view preferences, and widening one for a single
 * boolean would be an API route, a migration and a serialiser for a choice
 * about whether a drawer is open.
 *
 * It is written here rather than added to `calendar-preferences.ts` only
 * because the tray owns it; if a third caller ever needs it, that module is
 * where it belongs and this is the code to move.
 */
const listeners = new Set<() => void>();
let chosen: boolean | undefined;

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Anything that is not the literal `true` is open — the honest default. */
function readCollapsed(): boolean {
  if (chosen !== undefined) return chosen;
  try {
    return window.localStorage.getItem(UNSCHEDULED_TRAY_KEY) === "true";
  } catch {
    /* Private browsing, or a storage policy. An open tray still works, which is
       the only thing this has to guarantee. */
    return false;
  }
}

export function useTrayCollapsed(): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(
    subscribe,
    readCollapsed,
    /* The server has no storage, so it renders the tray open and the first
       client render agrees with it. Nothing to hydrate around. */
    () => false,
  );
  const set = useCallback((next: boolean) => {
    chosen = next;
    try {
      window.localStorage.setItem(UNSCHEDULED_TRAY_KEY, String(next));
    } catch {
      /* Held in `chosen` above, so the control still works this session. */
    }
    for (const listener of listeners) listener();
  }, []);
  return [value, set];
}

/* ── The tray ────────────────────────────────────────────────────────────── */

export type UnscheduledTrayProps = {
  jobs: readonly CalendarJob[];
  statusIndex: ReadonlyMap<string, JobStatusMapping>;
  siteName: (siteId: string) => string | null;
  /** False hides the drag affordance; the server decides, this only draws. */
  canSchedule: boolean;
  /**
   * Books the job on `day`. Rejecting is expected — the caller reports it — and
   * the tray does not remove the row itself: the job leaves the tray when the
   * record comes back carrying a scheduled date, which is the one version of
   * this that cannot show a booked job as still unbooked.
   */
  onSchedule: (job: CalendarJob, day: string) => Promise<void>;
  onOpenJob: (job: CalendarJob) => void;
};

export function UnscheduledTray({
  jobs,
  statusIndex,
  siteName,
  canSchedule,
  onSchedule,
  onOpenJob,
}: UnscheduledTrayProps) {
  const [collapsed, setCollapsed] = useTrayCollapsed();

  /* One tick a minute, for the same reason the panel does it: the SLA labels
     are rounded to hours and days, so anything faster repaints for nothing. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const waiting = useMemo(
    () => unscheduledJobs(jobs, statusIndex),
    [jobs, statusIndex],
  );
  const urgent = useMemo(() => jobsInsideSlaWindow(waiting, now), [waiting, now]);

  /* The drop the reader has to confirm, because it lands past the deadline. */
  const [confirming, setConfirming] = useState<{
    job: CalendarJob;
    day: string;
    deadline: string;
  } | null>(null);

  const commit = useCallback(
    (job: CalendarJob, day: string) => {
      const deadline = jobDeadlineDay(job);
      /*
       * §5's confirmation. Asked BEFORE the write, not after it, and only when
       * the drop actually lands past the deadline — a dialog that appears on
       * every drop is a dialog people learn to dismiss without reading, which
       * would make the one that matters invisible.
       */
      if (deadline && day > deadline) {
        setConfirming({ job, day, deadline });
        return;
      }
      void onSchedule(job, day);
    },
    [onSchedule],
  );

  /*
   * ── THE GESTURE ──────────────────────────────────────────────────────────
   *
   * Pointer events rather than HTML5 drag-and-drop, which is what the
   * calendar's own drag already uses: the HTML5 API has no touch story, and
   * this tray is a bottom sheet on a phone where the only pointer is a finger.
   *
   * Bookkeeping lives in a ref and only the ghost's position is state. The
   * alternative — state for the whole gesture — re-renders the entire list on
   * every pointermove, which on a tray of a hundred jobs is a frame budget
   * spent redrawing rows that did not move.
   */
  const gesture = useRef<{
    pointerId: number;
    job: CalendarJob;
    startX: number;
    startY: number;
    moved: boolean;
    cell: HTMLElement | null;
  } | null>(null);
  const [ghost, setGhost] = useState<{ title: string; x: number; y: number } | null>(
    null,
  );

  const clearCell = () => {
    const held = gesture.current?.cell;
    if (held) held.classList.remove(CALENDAR_DROP_CLASS);
    if (gesture.current) gesture.current.cell = null;
  };

  /*
   * A last sweep on unmount. A tray that is closed mid-drag — a filter change,
   * a route change — would otherwise leave a highlighted cell on the grid with
   * nothing left to take the class off again.
   */
  useEffect(
    () => () => {
      for (const stray of document.querySelectorAll(`.${CALENDAR_DROP_CLASS}`)) {
        stray.classList.remove(CALENDAR_DROP_CLASS);
      }
    },
    [],
  );

  const onPointerDown = (job: CalendarJob) => (pressed: ReactPointerEvent) => {
    if (!canSchedule) return;
    if (pressed.button !== 0 && pressed.pointerType === "mouse") return;
    gesture.current = {
      pointerId: pressed.pointerId,
      job,
      startX: pressed.clientX,
      startY: pressed.clientY,
      moved: false,
      cell: null,
    };
    (pressed.currentTarget as HTMLElement).setPointerCapture(pressed.pointerId);
  };

  const onPointerMove = (moved: ReactPointerEvent) => {
    const active = gesture.current;
    if (!active || active.pointerId !== moved.pointerId) return;
    const dx = moved.clientX - active.startX;
    const dy = moved.clientY - active.startY;
    if (!active.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    active.moved = true;
    /* Now that this is a drag rather than a scroll, the browser must stop
       treating it as one. */
    moved.preventDefault();
    setGhost({ title: active.job.title, x: moved.clientX, y: moved.clientY });

    const under = document.elementFromPoint(moved.clientX, moved.clientY);
    const cell = under?.closest<HTMLElement>(CALENDAR_DAY_SELECTOR) ?? null;
    if (cell !== active.cell) {
      if (active.cell) active.cell.classList.remove(CALENDAR_DROP_CLASS);
      if (cell) cell.classList.add(CALENDAR_DROP_CLASS);
      active.cell = cell;
    }
  };

  const onPointerUp = (released: ReactPointerEvent) => {
    const active = gesture.current;
    if (!active || active.pointerId !== released.pointerId) return;
    const cell = active.cell;
    const day = cell?.dataset.day ?? "";
    const wasDrag = active.moved;
    clearCell();
    gesture.current = null;
    setGhost(null);
    if (!wasDrag) {
      /* Under the threshold it was never a drag, so the press opens the job —
         which is also the whole keyboard and screen-reader path into it. */
      onOpenJob(active.job);
      return;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) commit(active.job, day);
  };

  const onPointerCancel = () => {
    clearCell();
    gesture.current = null;
    setGhost(null);
  };

  return (
    <section
      className={`unscheduled-tray${collapsed ? " is-collapsed" : ""}`}
      aria-label="Unscheduled jobs"
    >
      <header className="unscheduled-tray__head">
        <button
          type="button"
          className="unscheduled-tray__toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          <Icon name="chevron" size={16} className="unscheduled-tray__caret" />
          <span className="unscheduled-tray__label">Unscheduled</span>
          {/*
            The count is a live number and an announcement, not decoration.
            `aria-live` because it changes underneath a reader as jobs are
            booked and raised, and the change is the information.
          */}
          <span
            className={`unscheduled-tray__count${urgent > 0 ? " is-urgent" : ""}`}
            aria-live="polite"
          >
            {waiting.length}
          </span>
        </button>
      </header>

      {urgent > 0 && !collapsed && (
        <p className="unscheduled-tray__alert" role="status">
          <Icon name="alert" size={14} />
          <span>
            {urgent === 1
              ? "1 unscheduled job is inside its response window."
              : `${urgent} unscheduled jobs are inside their response window.`}
          </span>
        </p>
      )}

      {!collapsed && (
        <div className="unscheduled-tray__body">
          {waiting.length === 0 ? (
            <p className="unscheduled-tray__empty">
              <strong>Everything open is booked.</strong>
              <span>
                A job appears here the moment it is raised without a date, or
                when its date is cleared.
              </span>
            </p>
          ) : (
            /*
             * EVERY ONE OF THEM, uncapped. §11 asks for "every open dateless
             * job" and a "+N more" affordance would be the tray hiding a job,
             * which is the single thing it exists to stop — and it would hide
             * them at the bottom, where the least urgent are, right up until an
             * estate grew and the boundary moved. The body scrolls instead. On
             * this estate that is a few dozen rows; on the imported board it
             * would be a few hundred, which is a list, not a problem.
             */
            <ul className="unscheduled-tray__list">
              {waiting.map((job) => {
                const appearance = jobChipAppearance(job.status, statusIndex);
                const deadline = jobDeadlineDay(job);
                const sla = slaCountdown({ deadline, now });
                const site = job.siteId ? siteName(job.siteId) : null;
                return (
                  <li key={job.id}>
                    <div
                      className="unscheduled-tray__row"
                      role="button"
                      tabIndex={0}
                      aria-label={`${job.reference ?? job.id}: ${job.title}${
                        sla.label ? `, ${sla.label}` : ", no response deadline"
                      }`}
                      onPointerDown={onPointerDown(job)}
                      onPointerMove={onPointerMove}
                      onPointerUp={onPointerUp}
                      onPointerCancel={onPointerCancel}
                      /* The keyboard route in. A drag is a convenience; the
                         panel's date field is the method, and it is reachable
                         without a pointer at all. */
                      onKeyDown={(pressed) => {
                        if (pressed.key === "Enter" || pressed.key === " ") {
                          pressed.preventDefault();
                          onOpenJob(job);
                        }
                      }}
                      {...(canSchedule ? { "data-tray-draggable": "" } : {})}
                    >
                      {canSchedule && (
                        <span className="unscheduled-tray__grip" aria-hidden="true">
                          <Icon name="grid" size={12} />
                        </span>
                      )}
                      <span
                        className="unscheduled-tray__status"
                        style={jobChipCss({
                          appearance,
                          /* Never the overdue overlay in here. Every row in this
                             tray is undated by definition, and `jobIsOverdue`
                             is explicit that an undated job cannot be late —
                             painting the tray red would be the exact false
                             accusation it refuses to make. */
                          overdue: false,
                          urgent: job.tier === 1,
                        })}
                      >
                        {appearance.label}
                      </span>
                      <span className="unscheduled-tray__text">
                        <span className="unscheduled-tray__title">
                          <b>{job.reference ?? job.id}</b> {job.title}
                        </span>
                        <span className="unscheduled-tray__meta">
                          {/* `||` rather than `??`: an imported row carries an
                              empty `location` far more often than a null one,
                              and `??` would print the blank. */}
                          {site || job.location || "No store"}
                          {deadline ? ` · due ${formatShortDate(deadline)}` : ""}
                        </span>
                      </span>
                      {sla.label && (
                        <span
                          className={`unscheduled-tray__sla${
                            sla.breached ? " is-breached" : ""
                          }`}
                        >
                          {sla.label}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {ghost && (
        <div
          className="unscheduled-tray__ghost"
          style={{ left: ghost.x, top: ghost.y }}
          aria-hidden="true"
        >
          {ghost.title}
        </div>
      )}

      {confirming && (
        <ScheduleConfirm
          day={confirming.day}
          deadline={confirming.deadline}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const held = confirming;
            setConfirming(null);
            void onSchedule(held.job, held.day);
          }}
        />
      )}
    </section>
  );
}

/**
 * §5's confirmation, word for word: "This moves the visit past the response
 * deadline of {date}. Continue?"
 *
 * A dialog rather than `window.confirm`, and not for looks: `confirm` is
 * suppressed outright in a cross-origin iframe and in several embedded
 * browsers, and a suppressed `confirm` returns FALSE — so the booking would
 * silently not happen on exactly the drops that most needed a decision.
 */
export function ScheduleConfirm({
  day,
  deadline,
  onCancel,
  onConfirm,
}: {
  day: string;
  deadline: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="tray-confirm__scrim"
      role="presentation"
      onKeyDown={(pressed) => {
        if (pressed.key === "Escape") onCancel();
      }}
    >
      <div
        className="tray-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tray-confirm-title"
      >
        <h2 id="tray-confirm-title">Past the response deadline</h2>
        <p>
          This moves the visit past the response deadline of{" "}
          {formatShortDate(deadline)}. Continue?
        </p>
        <p className="tray-confirm__target">
          The visit would be booked for {formatShortDate(day)}.
        </p>
        <div className="tray-confirm__actions">
          <button type="button" className="secondary-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary-button" autoFocus onClick={onConfirm}>
            Book it anyway
          </button>
        </div>
      </div>
    </div>
  );
}

/** §5's eight seconds, as a named constant so the test and the timer agree. */
export const SCHEDULE_UNDO_MS = 8000;

/**
 * The undo offer after a job is rescheduled.
 *
 * Eight seconds is short. That is the point of putting the undo in the toast
 * rather than in a menu: a drag is a gesture that goes wrong by a cell, the
 * reader knows within a second that it did, and the fix has to be in the same
 * place their eyes already are. A permanent undo would be a different feature
 * — the job's activity log — and the record already has one.
 *
 * The timer restarts whenever the message changes, so a second drag replaces
 * the offer rather than inheriting the remains of the first one's countdown.
 */
export function ScheduleUndoToast({
  message,
  onUndo,
  onDismiss,
}: {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  /*
   * The handler is held in a ref rather than listed as a dependency, and the
   * ref is written in an EFFECT rather than during render — writing one during
   * render is a side effect, which this codebase has already had to go back and
   * fix once.
   *
   * The dependency is what matters here. A parent that re-renders hands down a
   * new closure each time, and this parent re-renders on a clock tick; with
   * `onDismiss` in the dependency list the eight seconds restarted on every
   * render, so the offer outlived its own deadline for as long as anything else
   * on the page was moving.
   */
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    const timer = setTimeout(() => dismiss.current(), SCHEDULE_UNDO_MS);
    return () => clearTimeout(timer);
  }, [message]);

  return (
    <div className="schedule-undo" role="status">
      <span>{message}</span>
      <button type="button" onClick={onUndo}>
        Undo
      </button>
      <button
        type="button"
        className="schedule-undo__close"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
