/**
 * PLANNED VISITS — THE HYBRID MODEL, AND WHY IT IS NOT A COMPROMISE.
 *
 * Two specifications point in opposite directions and both are right.
 *
 * Module 1 §4 describes a Planned visit as a rich calendar record with its own
 * assignees, contractor, priority, status and SLA deadline. Module 2 §2 opens
 * with the flat instruction that jobs must NOT be copied into calendar rows,
 * because "two copies of the same job will drift apart within a week and every
 * later bug will trace back to this decision."
 *
 * Taken literally together they ask for a record that carries a job's fields
 * without being a copy of a job, which is not a thing. The owner resolved it,
 * and the resolution is the rule this module encodes:
 *
 *   A. A planned visit that belongs to an existing maintenance job is NOT a
 *      record. It is a VIEW of that job. The job stays the single source of
 *      truth, the schedule is written to the job's own scheduling fields, and
 *      the calendar draws it through the job feed it already has.
 *
 *   B. A planned visit with no maintenance job — a survey, an inspection, a
 *      general attendance — IS a calendar-native record, because there is no
 *      job for it to be a view of and inventing one would create the very
 *      duplicate Module 2 forbids, only in the other direction.
 *
 *   C. When a standalone visit turns out to be maintenance work, "Create job
 *      from this visit" makes ONE job and LINKS the visit to it. The visit does
 *      not become a second copy; it becomes case A.
 *
 * ── THE INVARIANT ──────────────────────────────────────────────────────────
 *
 * `calendar_events.request_id` is the hinge, and exactly one thing must always
 * be true of it:
 *
 *   a linked visit NEVER stores its own schedule.
 *
 * Not "should not" — never. The moment a linked row carries both a
 * `request_id` AND its own `starts_on`, there are two answers to "when is this
 * visit" and no rule for which wins. That is the drift Module 2 predicts,
 * arriving through the back door of a field nobody thought of as a copy.
 * `visitScheduleTarget` below is the single place that decides where a write
 * goes, and `plannedVisitIntegrityIssue` is the assertion that catches a row
 * which got into the forbidden shape anyway.
 *
 * ── WHY NOT JUST MAKE EVERY VISIT A JOB ────────────────────────────────────
 *
 * It was the obvious simplification and it is wrong for a reason worth
 * recording: a job carries an SLA, a requester, a cost and a place in the
 * performance percentage. A survey booked for next Tuesday has none of those,
 * and filing it as a job would put it in the denominator of the client's
 * on-time figure — quietly changing a number on an invoice because somebody
 * booked a site visit. Standalone visits exist so that cannot happen.
 */

/** Which of the two shapes a planned visit is in. */
export type PlannedVisitMode = "job-backed" | "standalone";

/**
 * The fields this module needs from a calendar row. Structural rather than the
 * full `ManualCalendarItem` so the rules can be tested against a literal.
 */
export type PlannedVisitRow = {
  id: string;
  requestId: string | null;
  startsOn: string | null;
  endsOn?: string | null;
  startsAtTime?: string | null;
  title?: string | null;
  siteId?: string | null;
  visitType?: string | null;
  priority?: string | null;
  status?: string | null;
  assignedTo?: string | null;
  contractorId?: string | null;
  accessNotes?: string | null;
  responseDeadlineAt?: string | null;
  notes?: string | null;
};

/** The job fields a visit reads through, when it is a view of one. */
export type PlannedVisitJob = {
  id: string;
  reference?: string | null;
  title?: string | null;
  siteId?: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  dueAt?: string | null;
  status?: string | null;
  priority?: string | null;
  assignee?: string | null;
  contractorId?: string | null;
};

export function plannedVisitMode(row: Pick<PlannedVisitRow, "requestId">): PlannedVisitMode {
  return row.requestId ? "job-backed" : "standalone";
}

/**
 * Where a schedule edit on this visit must be written.
 *
 * The entire no-duplication rule reduces to this one function, which is why it
 * exists rather than each caller checking `requestId` for itself. A drag on the
 * calendar, a date change in the dialog and a drop out of the unscheduled tray
 * are three code paths that must agree, and they agree by all asking here.
 */
export type VisitScheduleTarget =
  | { kind: "job"; requestId: string; field: "scheduled_date" }
  | { kind: "calendar-event"; eventId: string; field: "starts_on" };

export function visitScheduleTarget(row: PlannedVisitRow): VisitScheduleTarget {
  if (row.requestId) {
    return { kind: "job", requestId: row.requestId, field: "scheduled_date" };
  }
  return { kind: "calendar-event", eventId: row.id, field: "starts_on" };
}

/**
 * The scheduled day a visit actually shows on.
 *
 * A linked visit reads the JOB's scheduled date and ignores anything stored on
 * the calendar row — deliberately, and even when the row has one. A row that
 * was linked to a job after it was created may still carry the date it was
 * booked with, and preferring it would resurrect the stale copy on the first
 * render after somebody reschedules the job. The job wins, always, and
 * `plannedVisitIntegrityIssue` reports the leftover so it can be cleared.
 */
export function plannedVisitDay(
  row: PlannedVisitRow,
  job: PlannedVisitJob | null,
): string | null {
  if (row.requestId) return job?.scheduledDate ?? null;
  return row.startsOn ?? null;
}

export function plannedVisitTime(
  row: PlannedVisitRow,
  job: PlannedVisitJob | null,
): string | null {
  if (row.requestId) return job?.scheduledTime ?? null;
  return row.startsAtTime ?? null;
}

/**
 * A linked row that is still carrying its own schedule.
 *
 * Not thrown. A visit in this state is readable — `plannedVisitDay` already
 * prefers the job — so raising an exception would take a calendar down over a
 * stale field. It is reported instead, the same way an unmapped job status is:
 * visible, named, and fixable, rather than fatal or hidden.
 */
export function plannedVisitIntegrityIssue(row: PlannedVisitRow): string | null {
  if (!row.requestId) return null;
  if (!row.startsOn) return null;
  return (
    `Visit ${row.id} is linked to job ${row.requestId} but still stores its own ` +
    `start date (${row.startsOn}). The job's scheduled date is authoritative; ` +
    `the stored date is ignored and should be cleared.`
  );
}

/**
 * Whether "Create job from this visit" should be offered.
 *
 * Only for a standalone visit, and only once. Offering it on a linked visit is
 * how you get the second job — which is precisely the outcome the whole model
 * exists to prevent, arriving via a button.
 */
export function canCreateJobFromVisit(row: PlannedVisitRow): boolean {
  return plannedVisitMode(row) === "standalone";
}

/** Why the action is unavailable, for the tooltip on the disabled control. */
export function createJobUnavailableReason(row: PlannedVisitRow): string | null {
  if (canCreateJobFromVisit(row)) return null;
  return `This visit is already linked to job ${row.requestId}. Open the job to change it.`;
}

/**
 * The job a standalone visit becomes.
 *
 * Carries the visit's own fields across rather than inventing any. Note what is
 * absent: no SLA deadline is fabricated. `responseDeadlineAt` moves over only
 * when the visit actually had one, because a created job that arrives with a
 * made-up deadline would be measured against it in the client's on-time
 * percentage — a number changed by an invention.
 */
export type CreatedJobDraft = {
  title: string;
  siteId: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  dueAt: string | null;
  priority: string | null;
  status: string;
  assignee: string | null;
  contractorId: string | null;
  description: string | null;
  sourceVisitId: string;
};

export function jobDraftFromVisit(row: PlannedVisitRow): CreatedJobDraft {
  const title = (row.title ?? "").trim();
  return {
    /*
     * A job must be findable by name. An untitled visit becomes a job named
     * after what it is rather than an empty string, which would show as a blank
     * row on the board and be unsearchable.
     */
    title: title || `Planned visit ${row.visitType ? `— ${row.visitType}` : ""}`.trim(),
    siteId: row.siteId ?? null,
    scheduledDate: row.startsOn ?? null,
    scheduledTime: row.startsAtTime ?? null,
    dueAt: row.responseDeadlineAt ?? null,
    priority: row.priority ?? null,
    /*
     * A visit that already has a date becomes a SCHEDULED job, not a new one.
     * Filing it as "New" would put it back in the unscheduled tray it was never
     * in and ask somebody to book a visit that is already booked.
     */
    status: row.startsOn ? "Scheduled" : "New",
    assignee: row.assignedTo ?? null,
    contractorId: row.contractorId ?? null,
    description: row.notes ?? null,
    sourceVisitId: row.id,
  };
}

/**
 * What must be written to the calendar row once the job exists.
 *
 * Two edits, not one: the link is added AND the row's own schedule is cleared.
 * Clearing it is what makes the conversion satisfy the invariant instead of
 * creating exactly the two-copies row this module refuses to allow. Leaving the
 * date behind "just in case" is the tempting version and it is the bug.
 */
export function visitLinkPatchAfterJobCreated(requestId: string): {
  requestId: string;
  startsOn: null;
  startsAtTime: null;
} {
  return { requestId, startsOn: null, startsAtTime: null };
}
