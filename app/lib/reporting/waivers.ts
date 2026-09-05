/**
 * THE DATA-ISSUE GATE — what blocks Finalise, and the documented way through.
 *
 * ── WHY A WAIVER RATHER THAN A HARDER OR SOFTER BLOCK ──────────────────────
 *
 * The Reports section carries a badge reading "Review data issues ⚠ 48". §6 is
 * blunt about the problem with it: it has to gate something or it is decoration.
 * The two obvious designs both fail, and they fail in opposite directions:
 *
 *   · Block on all 48. Somebody eventually cannot ship a report they need, and
 *     the workaround they find is outside the system entirely — a spreadsheet,
 *     a hand-edited Word file — and every guarantee this module exists to give
 *     goes with it.
 *   · Warn only. Wrong numbers reach a client, over a warning nobody read,
 *     with nothing in the document to say a warning existed.
 *
 * So: only ERROR severity blocks, and an error may be waived one at a time by a
 * named approver with a typed reason. The block stays meaningful because the
 * way through is deliberate, attributable, and PRINTED. That last part is the
 * load-bearing one — see `waiverNotesForReport`.
 *
 * ── SEVERITY IS SPELLED TWO WAYS IN THIS PRODUCT, AND BOTH ARE REAL ────────
 *
 * §6's table says Error / Warning / Info. `contract.ts` already ships
 * `DataQualitySeverity = "blocking" | "warning" | "info"`, written before the
 * module 4 spec existed and used by `data-quality.ts` and every renderer
 * downstream of it. Renaming that would touch files this module has no business
 * touching, and leaving the two vocabularies to diverge would mean a finding
 * marked `blocking` sailing through a gate that only looks for `error`.
 *
 * `issueSeverity` therefore normalises: `blocking` IS `error`, and anything
 * unrecognised is `info`. Unrecognised falling to the weakest severity is
 * deliberate — a severity this code does not understand must not be able to
 * block a client's report by accident, and it is listed either way.
 *
 * ── A REVOKED WAIVER IS NOT A WAIVER ───────────────────────────────────────
 *
 * `report_issue_waivers` carries `revoked_at` rather than deleting the row,
 * because the fact that somebody waived an error and somebody else took it back
 * is exactly the audit trail the register exists to hold. Every function here
 * reads only LIVE waivers, and revocation immediately restores the block.
 *
 * Pure throughout: no database handle, no clock. `waivedAt` arrives on the row.
 */

/** §6's vocabulary. `blocking` from `contract.ts` normalises onto `error`. */
export type IssueSeverity = "error" | "warning" | "info";

/** One classified data-quality finding, in the shape the gate needs. */
export interface ReportIssue {
  /** The stable code — `job.completed_without_date`. Waivers key on this. */
  code: string;
  severity: IssueSeverity | string;
  /** The record the issue is about, where it is about one. */
  subjectId?: string | null;
  message?: string | null;
}

/** A row of `report_issue_waivers`. */
export interface IssueWaiver {
  id?: string | null;
  issueCode: string;
  /** Null waives every issue carrying this code — see `waiverCovers`. */
  subjectId?: string | null;
  reason: string;
  waivedByEmail?: string | null;
  waivedAt?: string | null;
  revokedAt?: string | null;
  revokedByEmail?: string | null;
}

/** The two spellings, resolved to one. Unknown is `info`. See the header. */
export function issueSeverity(value: string | null | undefined): IssueSeverity {
  const normalised = (value ?? "").trim().toLowerCase();
  if (normalised === "error" || normalised === "blocking") return "error";
  if (normalised === "warning" || normalised === "warn") return "warning";
  return "info";
}

/** Only an error blocks. Warning and info are shown and listed, and that is all. */
export function isBlockingSeverity(value: string | null | undefined): boolean {
  return issueSeverity(value) === "error";
}

/** A waiver counts only while it has not been revoked. */
export function isLiveWaiver(waiver: IssueWaiver): boolean {
  return !waiver.revokedAt;
}

/**
 * Whether a waiver covers an issue.
 *
 * The code must match. The subject is asymmetric on purpose: a waiver with NO
 * subject covers every issue carrying that code, and a waiver WITH one covers
 * only that record. Waiving "cost with no job" across a period is a real
 * decision an approver makes once; waiving it for job 4471 is a different and
 * narrower one, and the narrow form must not silently widen. So the blanket
 * waiver is the one that has to be typed deliberately, and it is the one whose
 * reason ends up on the document describing a period rather than a row.
 */
export function waiverCovers(waiver: IssueWaiver, issue: ReportIssue): boolean {
  if (!isLiveWaiver(waiver)) return false;
  if (waiver.issueCode !== issue.code) return false;
  if (waiver.subjectId === null || waiver.subjectId === undefined) return true;
  return waiver.subjectId === (issue.subjectId ?? null);
}

/**
 * The errors still standing — the number the badge should show.
 *
 * §6: "the badge shows the error count specifically, not the total". 48 findings
 * of which three are errors is a 3, and a reader who is shown 48 learns only
 * that something is wrong somewhere.
 */
export function unwaivedBlockingIssues(
  issues: readonly ReportIssue[],
  waivers: readonly IssueWaiver[],
): ReportIssue[] {
  return issues.filter(
    (issue) =>
      isBlockingSeverity(issue.severity) &&
      !waivers.some((waiver) => waiverCovers(waiver, issue)),
  );
}

/**
 * Whether Finalise is blocked.
 *
 * True only while an ERROR stands with no live waiver over it. A warning never
 * blocks however many there are, and a revoked waiver puts its error back.
 */
export function blocksFinalise(
  issues: readonly ReportIssue[],
  waivers: readonly IssueWaiver[],
): boolean {
  return unwaivedBlockingIssues(issues, waivers).length > 0;
}

export type WaiverValidation =
  | { ok: true; reason: string }
  | { ok: false; error: string };

/**
 * The typed reason, or a refusal.
 *
 * §6 requires "a mandatory typed reason" and §10 makes it an acceptance
 * criterion. Empty is refused, and so is whitespace — a space bar pressed to get
 * past a required field is the same act as leaving it blank, and it is the
 * likelier of the two once the field is known to be mandatory. The returned
 * reason is TRIMMED, so what is stored is what will be read on the document
 * rather than the same sentence with a newline in front of it.
 *
 * A minimum length is deliberately NOT imposed. "Confirmed by client" is three
 * words and a complete answer; a rule demanding twenty characters gets
 * "confirmed by client...." typed instead, which is worse and cannot be
 * detected. Requiring the field is enforceable; requiring it to be good is not.
 */
export function waiverRequiresReason(input: {
  reason?: string | null;
}): WaiverValidation {
  const reason = (input?.reason ?? "").trim();
  if (reason.length === 0) {
    return { ok: false, error: "A waiver needs a typed reason. It is printed in the report." };
  }
  return { ok: true, reason };
}

/**
 * The lines that go into section 7, Data quality notes.
 *
 * This is the part that makes the waiver worth having. §6 requires the waiver,
 * the reason, the user and the timestamp to be "logged and printed in the
 * report's data quality notes" — stored is not enough, because the person the
 * report is FOR is the one who needs to know an error was set aside, and they
 * never see the register. A waiver that only exists in a table is an override
 * with no audience, which is the state the gate was built to end.
 *
 * Live waivers only. A revoked one excused nothing in the end, and printing it
 * as though it had would misdescribe the document.
 *
 * Attribution degrades rather than disappears: an unrecorded approver prints as
 * "an unrecorded user" and an unrecorded date is simply omitted. A note that
 * silently drops itself because one column was null is how a reader ends up
 * with a clean-looking report over a waived error.
 */
export function waiverNotesForReport(waivers: readonly IssueWaiver[]): string[] {
  return waivers.filter(isLiveWaiver).map((waiver) => {
    const subject = waiver.subjectId ? ` on ${waiver.subjectId}` : "";
    const who = (waiver.waivedByEmail ?? "").trim() || "an unrecorded user";
    const when = (waiver.waivedAt ?? "").trim().slice(0, 10);
    const stamp = when ? ` on ${when}` : "";
    const reason = (waiver.reason ?? "").trim() || "no reason recorded";
    return `Waived: ${waiver.issueCode}${subject} — ${reason} (waived by ${who}${stamp}).`;
  });
}
