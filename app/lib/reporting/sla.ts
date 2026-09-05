/**
 * SLA — measured, or honestly excluded. Never estimated.
 *
 * ── RECONCILING WITH THE SLA THAT ALREADY EXISTS ───────────────────────────
 *
 * The board carries a meter labelled "Avg SLA target 68.3 hrs". Its maths is
 * `slaTargetHours()` in `app/(app)/portal/dashboard-meters.ts`: the HOURS
 * between when a job was raised and the due date ON THE ROW, averaged over the
 * rows the board is drawing. That meter answers "how quickly is the work on
 * this board being promised", it reads a per-row due date, and its own header
 * records that only 1 of 745 imported rows carries one — which is why the card
 * prints its sample size next to the number.
 *
 * This module answers a different question, and the difference is the whole
 * reason it exists: "did we meet the term the client agreed". That is measured
 * in WORKING DAYS against a TARGET FROM `sla_rules`, keyed on the job's
 * classification, to the completion date, with approved holds subtracted.
 *
 * The two are not in conflict and neither redefines the other:
 *
 *   · the meter's target comes from the ROW (`due_at`); this one comes from the
 *     AGREEMENT (`sla_rules`);
 *   · the meter measures a promise; this measures an outcome;
 *   · the meter is in hours and includes weekends, because a due date does;
 *     this is in working days, because a contractual term is.
 *
 * A job can therefore be inside its row's due date and outside its contractual
 * term, or the reverse, and both statements are true. The SLA rules appendix in
 * the payload carries this distinction so a reader who has seen both numbers is
 * told why they differ rather than left to assume one of them is broken.
 *
 * ── NOTHING IS SEEDED, AND A JOB WITH NO RULE IS EXCLUDED ──────────────────
 *
 * `sla_rules` ships empty on purpose. A seeded target is indistinguishable on
 * screen from an agreed contractual term, and a client shown "94% within SLA"
 * against numbers nobody agreed is being told something false with a chart
 * behind it. So a job whose classification has no rule is EXCLUDED, with the
 * reason recorded on its row, and the absence is raised as a data-quality
 * finding. `slaPerformancePercent` is null — not zero, not 100 — when nothing
 * in the period was measurable.
 *
 * ── ONLY APPROVED HOLDS COUNT ──────────────────────────────────────────────
 *
 * `adjusted = elapsed − approved hold days`. `job_holds.approved` defaults to
 * false, and an unapproved hold is reported as a data-quality finding rather
 * than applied. That asymmetry is the point: a hold is a discount on a number
 * a client is judged by, so it has to be somebody's decision, recorded with
 * their name against it, and not merely something typed into a box.
 *
 * ── THE BANK-HOLIDAY CALENDAR IS PASSED IN, NEVER FETCHED ──────────────────
 *
 * Module 4 §4.2 requires working days to exclude England & Wales bank holidays,
 * and the owner agreed that calendar on 5 September 2026. Every function below
 * takes it as a trailing OPTIONAL argument and hands it straight to
 * `workingDaysInclusive`; none of them reads the `bank_holidays` table, because
 * this module is pure and the whole engine's testability depends on it staying
 * so.
 *
 * Optional, and not defaulted to a calendar of this module's own, for one
 * reason: elapsed, held and adjusted have to be measured against the SAME set
 * of days. A caller that passes the calendar to `computeSlaOutcome` gets it
 * applied to the elapsed count and to the hold subtraction together, because
 * this file threads the one it was given down to both. A caller that passes
 * nothing gets weekdays for both. What must never happen is a job whose elapsed
 * time knows about Christmas and whose holds do not — the adjusted figure would
 * be arithmetic between two different calendars, and it would look fine.
 */

import type { BankHolidayCalendar } from "./bank-holidays";
import type { IsoDate, SlaOutcomeRow, SlaResult } from "./contract";
import type { ReportHold, ReportJob, ReportSlaRule } from "./inputs";
import { isCompletedJob, isProjectJob } from "./job-classification";
import { workingDaysAfterRequest, workingDaysInclusive } from "./period";

/**
 * The reasons a job is left out of the measurement.
 *
 * Named constants rather than inline strings so the same sentence appears on
 * the SLA table, in the data-quality finding and in the Excel export — three
 * renderers of one payload, which is only true if the payload carries one
 * wording.
 */
export const SLA_EXCLUSION = {
  noRequestDate: "No request date recorded — the clock has no start.",
  noCompletionDate: "Not completed — there is no completion date to measure to.",
  completedWithoutDate: "Filed as completed with no completion date recorded.",
  invalidSequence: "The completion date is before the request date.",
  noClassification: "The job carries no classification, so no target applies.",
  noRule: "No SLA rule is configured for this classification.",
  project: "Special project measured to an agreed programme, not to an SLA.",
  authorised: "Authorised exclusion recorded against the job.",
} as const;

/**
 * The hold category that takes a job out of the measurement entirely.
 *
 * Distinct from a hold that merely pauses the clock: this one says the parties
 * agreed the job is not to be judged against the term at all. It must be
 * APPROVED, like every other hold that changes a number.
 */
export const AUTHORISED_EXCLUSION_CATEGORY = "Authorised exclusion";

function normalise(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** An approved hold whose category takes the job out of the measurement. */
export function isAuthorisedExclusion(hold: ReportHold): boolean {
  return hold.approved && normalise(hold.category) === normalise(AUTHORISED_EXCLUSION_CATEGORY);
}

/**
 * Working days a hold removes from a job's elapsed time.
 *
 * CLAMPED to the job's own duration. A hold recorded from before the job was
 * raised, or running past its completion, would otherwise subtract days the job
 * was not open for and could drive the adjusted figure negative — an SLA
 * measurement that says a job took minus two days is not a measurement. The
 * clamping is silent here and LOUD in `data-quality.ts`, which reports the hold
 * as sitting outside the job's duration; correcting it is the operator's job,
 * not this function's.
 *
 * An open-ended hold (no end date) on a completed job runs to completion. On an
 * open job it runs to `asOf`.
 */
export function holdWorkingDays(
  hold: ReportHold,
  jobStart: IsoDate,
  jobEnd: IsoDate,
  holidays?: BankHolidayCalendar | null,
): number {
  if (!hold.approved) return 0;
  const start = hold.startAt && hold.startAt > jobStart ? hold.startAt : jobStart;
  const end = hold.endAt && hold.endAt < jobEnd ? hold.endAt : jobEnd;
  if (!start || !end || start > end) return 0;
  return workingDaysInclusive(start, end, holidays);
}

/**
 * Total approved hold days on one job, with overlapping holds counted ONCE.
 *
 * Two holds covering the same Tuesday remove one Tuesday, not two. Summing the
 * holds independently is the obvious implementation and it is wrong in exactly
 * the case that matters — a job parked for parts and for access at the same
 * time — where it would hand the job a discount larger than the time it was
 * open. Merging the windows first is what makes the arithmetic survive a
 * reader with a calendar.
 */
export function approvedHoldDays(
  holds: readonly ReportHold[],
  jobStart: IsoDate,
  jobEnd: IsoDate,
  holidays?: BankHolidayCalendar | null,
): number {
  const windows = holds
    .filter((hold) => hold.approved && !isAuthorisedExclusion(hold))
    .map((hold) => ({
      start: hold.startAt && hold.startAt > jobStart ? hold.startAt : jobStart,
      end: hold.endAt && hold.endAt < jobEnd ? hold.endAt : jobEnd,
    }))
    .filter((window) => window.start && window.end && window.start <= window.end)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  let total = 0;
  let openStart: IsoDate | null = null;
  let openEnd: IsoDate | null = null;
  for (const window of windows) {
    if (openStart === null || openEnd === null) {
      openStart = window.start;
      openEnd = window.end;
      continue;
    }
    if (window.start <= openEnd) {
      if (window.end > openEnd) openEnd = window.end;
      continue;
    }
    total += workingDaysInclusive(openStart, openEnd, holidays);
    openStart = window.start;
    openEnd = window.end;
  }
  if (openStart !== null && openEnd !== null) {
    total += workingDaysInclusive(openStart, openEnd, holidays);
  }
  return total;
}

/** The active rule for a classification, or null. Inactive rules do not apply. */
export function ruleFor(
  rules: readonly ReportSlaRule[],
  classification: string | null,
): ReportSlaRule | null {
  if (!classification) return null;
  const wanted = normalise(classification);
  return (
    rules.find((rule) => rule.active && normalise(rule.classification) === wanted) ?? null
  );
}

/**
 * One job's SLA outcome.
 *
 * It takes no "as at" date, and that is deliberate rather than an omission. An
 * SLA outcome is only ever computed for a COMPLETED job — an open one is
 * Excluded with `noCompletionDate` — and a completed job is measured from its
 * request date to its completion date. So the answer is the same however many
 * months after the fact the report is re-run, which is exactly the property a
 * finalised document needs. How long an OPEN job has been running is a
 * different question with a different answer, and `openJobDaysPastTarget` below
 * is where an `asOf` belongs.
 */
export function computeSlaOutcome(
  job: ReportJob,
  holds: readonly ReportHold[],
  rules: readonly ReportSlaRule[],
  holidays?: BankHolidayCalendar | null,
): SlaOutcomeRow {
  const rule = ruleFor(rules, job.classification);
  const base: SlaOutcomeRow = {
    requestId: job.id,
    reference: job.reference,
    siteName: job.siteName,
    description: job.title || job.description,
    classification: job.classification,
    targetWorkingDays: rule ? rule.targetWorkingDays : null,
    elapsedWorkingDays: null,
    approvedHoldDays: 0,
    adjustedWorkingDays: null,
    result: "Excluded",
    exclusionReason: null,
  };

  const excluded = (reason: string): SlaOutcomeRow => ({ ...base, exclusionReason: reason });

  if (holds.some(isAuthorisedExclusion)) return excluded(SLA_EXCLUSION.authorised);
  if (isProjectJob(job)) return excluded(SLA_EXCLUSION.project);
  if (!job.requestedOn) return excluded(SLA_EXCLUSION.noRequestDate);
  if (!job.classification) return excluded(SLA_EXCLUSION.noClassification);
  if (!rule) return excluded(SLA_EXCLUSION.noRule);

  const completed = isCompletedJob(job);
  if (!completed) return excluded(SLA_EXCLUSION.noCompletionDate);
  if (!job.completedOn) return excluded(SLA_EXCLUSION.completedWithoutDate);
  if (job.completedOn < job.requestedOn) return excluded(SLA_EXCLUSION.invalidSequence);

  /*
   * One calendar for both halves of the subtraction — see the header — and the
   * ELAPSED half starts the day AFTER the request (Module 4 §4.2). The HELD
   * half stays inclusive of its own ends, because every day a hold covers is a
   * day the clock was stopped. The two rules are different on purpose;
   * `workingDaysAfterRequest` in `period.ts` explains why.
   */
  const elapsed = workingDaysAfterRequest(job.requestedOn, job.completedOn, holidays);
  const held = approvedHoldDays(holds, job.requestedOn, job.completedOn, holidays);
  // Never below zero. A hold cannot make a job take negative time, and a
  // clamped hold that still overshoots is a data-quality finding, not a
  // measurement to be published.
  const adjusted = Math.max(0, elapsed - held);
  const result: SlaResult = adjusted <= rule.targetWorkingDays ? "Within" : "Outside";

  return {
    ...base,
    elapsedWorkingDays: elapsed,
    approvedHoldDays: held,
    adjustedWorkingDays: adjusted,
    result,
  };
}

/**
 * The headline percentage, or null.
 *
 * Null when nothing was measurable, which the contract's own comment insists on
 * and which is the difference between "we have no measurement" and "we met none
 * of them". Rounded to a whole percent, because a client-facing SLA figure
 * quoted to two decimal places implies a precision the sample does not have.
 */
export function slaPerformancePercent(outcomes: readonly SlaOutcomeRow[]): number | null {
  const measured = outcomes.filter((row) => row.result !== "Excluded");
  if (measured.length === 0) return null;
  const within = measured.filter((row) => row.result === "Within").length;
  return Math.round((within / measured.length) * 100);
}

/**
 * How many working days past its target an OPEN job is, as at `asOf`.
 *
 * Uses the same working-day arithmetic and the same approved-hold subtraction
 * as a completed job's measurement, so "3 days past target" on the open list
 * and "outside SLA by 3 days" once it closes are the same three days.
 * Returns null when the job has no target — an untargeted job cannot be past
 * one, and printing a number there would invent the target.
 */
export function openJobDaysPastTarget(
  job: ReportJob,
  holds: readonly ReportHold[],
  rules: readonly ReportSlaRule[],
  asOf: IsoDate,
  holidays?: BankHolidayCalendar | null,
): { workingDaysOpen: number | null; daysPastTarget: number | null; targetOn: IsoDate | null } {
  if (!job.requestedOn) return { workingDaysOpen: null, daysPastTarget: null, targetOn: job.targetOn };
  const end = asOf > job.requestedOn ? asOf : job.requestedOn;
  /* Same rule as a completed job, so "3 days past target" on the open list and
     "outside SLA by 3 days" once it closes remain the same three days. */
  const elapsed = workingDaysAfterRequest(job.requestedOn, end, holidays);
  const held = approvedHoldDays(holds, job.requestedOn, end, holidays);
  const open = Math.max(0, elapsed - held);
  const rule = ruleFor(rules, job.classification);
  if (!rule) return { workingDaysOpen: open, daysPastTarget: null, targetOn: job.targetOn };
  return {
    workingDaysOpen: open,
    daysPastTarget: open - rule.targetWorkingDays,
    targetOn: job.targetOn,
  };
}
