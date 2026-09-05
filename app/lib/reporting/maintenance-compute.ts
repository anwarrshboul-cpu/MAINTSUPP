/**
 * THE MAINTENANCE REPORT — every figure, from one set of jobs.
 *
 * Pure, like the invoice half. `engine.ts` reads the rows; this turns them into
 * `MaintenanceSection` and nothing renders except from what it returns.
 *
 * ── WHICH JOBS ARE "IN" A PERIOD, DECIDED ONCE ─────────────────────────────
 *
 * A job is in the report when it was RAISED in the period. One rule, applied
 * before this function is called, and every column here describes that one set:
 * `jobsRaised` on a site row, `completed` and `open` are the states those
 * raised jobs are in now, and `completedCostPence` is what those jobs cost.
 *
 * The alternative — jobs "active during" the period — was rejected because it
 * makes `jobsRaised` and `completed` describe different populations, so a
 * reader cannot add a row up. The cost of the rule is real and worth stating:
 * a job raised in February and completed in March contributes its cost to
 * February's report, not March's. That is consistent, reproducible, and the
 * same answer however many times the report is re-run — which the alternative
 * is not, because a job's membership would change the day it completes.
 *
 * ── THE FIVE SPEND FIGURES ARE NEVER ADDED ─────────────────────────────────
 *
 * `SpendAnalysis` carries five, and the contract's own comment says
 * `serviceFeePence` is the invoice total and is never added to the others. The
 * narrative says the same sentence out loud, because a table of five numbers
 * invites a reader to total the column, and the total would be meaningless:
 * the project and routine figures are SUBSETS of the maintenance figures, not
 * additions to them.
 */

import { isActiveSiteStatus } from "../site-state";
import type {
  BillableSiteLine,
  DataQualityFinding,
  ExecutiveCounts,
  HoldRow,
  InvoiceTotals,
  IsoDate,
  JobLogGroup,
  JobLogRow,
  MaintenanceKpis,
  MaintenanceSection,
  OpenPastTargetRow,
  Pence,
  ReportPeriod,
  SiteSummaryRow,
  SlaOutcomeRow,
  SlaRuleRow,
  SpecialProjectRow,
  SpendAnalysis,
} from "./contract";
import { JOB_LOG_GROUPS } from "./contract";
import type { ReportHold, ReportJob, ReportSite, ReportSlaRule } from "./inputs";
import {
  isCancelledJob,
  isCompletedJob,
  isCriticalJob,
  isOpenJob,
  isProjectJob,
  isRoutineJob,
  jobLogGroup,
} from "./job-classification";
import { sumPence } from "./money";
import { buildExecutiveSummary } from "./narrative";
import {
  approvedHoldDays,
  computeSlaOutcome,
  openJobDaysPastTarget,
  slaPerformancePercent,
} from "./sla";

/** The name a job with no resolvable site is grouped under. Never invented. */
export const UNASSIGNED_SITE_NAME = "No site recorded";

/**
 * What an OPEN job has committed.
 *
 * The approved quote when there is one, otherwise whatever cost has been
 * recorded, otherwise nothing. Used by BOTH `SiteSummaryRow.openQuotedCostPence`
 * and `SpendAnalysis.openCommittedPence`, so the site rows sum to the portfolio
 * figure — which they did not when each computed its own idea of "committed".
 */
export function openCommitment(job: ReportJob): Pence {
  return job.approvedQuotePence ?? job.costPence ?? 0;
}

/** What a COMPLETED job actually cost. A missing cost is zero in a total. */
export function completedCost(job: ReportJob): Pence {
  return job.costPence ?? 0;
}

export interface MaintenanceComputeInput {
  period: ReportPeriod;
  previousPeriod: ReportPeriod | null;
  /** End of the period, or today when the period has not ended. See `sla.ts`. */
  asOf: IsoDate;
  jobs: readonly ReportJob[];
  /** The same read over the comparable period. Empty when there is none. */
  previousJobs: readonly ReportJob[];
  sites: readonly ReportSite[];
  holds: readonly ReportHold[];
  slaRules: readonly ReportSlaRule[];
  invoiceTotals: InvoiceTotals;
  invoiceLines: readonly BillableSiteLine[];
  dataQuality: readonly DataQualityFinding[];
  currency: string;
  /*
   * England & Wales bank holidays, as a set of `YYYY-MM-DD`.
   *
   * PASSED IN AS DATA rather than imported, and the distinction is not
   * stylistic. `tests/w9-report-engine.test.mjs` stages this module and a fixed
   * list of its neighbours into a temp directory and rewrites relative
   * specifiers; a value import of `./bank-holidays` here would resolve to a
   * file that suite does not stage, and the failure would look like a broken
   * report engine rather than a missing line in a test's module list. The set
   * arrives from the route, which reads the `bank_holidays` table.
   *
   * Optional, and omitting it counts weekdays only — which is exactly what this
   * engine did before the calendar was agreed, so an older caller keeps its
   * numbers instead of silently gaining a day.
   */
  bankHolidays?: ReadonlySet<IsoDate>;
}

function holdsFor(holds: readonly ReportHold[], requestId: string): ReportHold[] {
  return holds.filter((hold) => hold.requestId === requestId);
}

function jobSiteName(job: ReportJob): string {
  return job.siteName || job.recordedSiteName || UNASSIGNED_SITE_NAME;
}

export function computeMaintenanceSection(
  input: MaintenanceComputeInput,
): MaintenanceSection {
  const { jobs, holds, slaRules, period } = input;
  const holidays = input.bankHolidays;

  /* ── SLA, first, because five other sections quote it ─────────────────── */
  const sla: SlaOutcomeRow[] = jobs.map((job) =>
    computeSlaOutcome(job, holdsFor(holds, job.id), slaRules, holidays),
  );
  const slaById = new Map(sla.map((row) => [row.requestId, row]));

  const completed = jobs.filter(isCompletedJob);
  const open = jobs.filter(isOpenJob);
  const cancelled = jobs.filter(isCancelledJob);
  const critical = jobs.filter(isCriticalJob);
  const projects = jobs.filter(isProjectJob);
  const routine = jobs.filter(isRoutineJob);

  const pastTarget = open
    .map((job) => ({
      job,
      measure: openJobDaysPastTarget(job, holdsFor(holds, job.id), slaRules, input.asOf, holidays),
    }))
    .filter((entry) => (entry.measure.daysPastTarget ?? 0) > 0);
  const pastTargetIds = new Set(pastTarget.map((entry) => entry.job.id));

  /* ── KPIs ─────────────────────────────────────────────────────────────── */
  const kpis: MaintenanceKpis = {
    jobsRecorded: jobs.length,
    completedJobs: completed.length,
    openJobs: open.length,
    openJobsPastTarget: pastTarget.length,
    slaPerformancePercent: slaPerformancePercent(sla),
    /* On hold is the job-log group, not a separate predicate, so the KPI and
       the section of the log a reader scrolls to are the same jobs. */
    jobsOnHold: jobs.filter((job) => jobLogGroup(job) === "On Hold").length,
    criticalOpenJobs: critical.length,
    completedMaintenanceSpendPence: sumPence(completed.map(completedCost)),
  };

  /* ── Spend — five separately-labelled figures ─────────────────────────── */
  const spend: SpendAnalysis = {
    serviceFeePence: input.invoiceTotals.totalPence,
    completedMaintenancePence: kpis.completedMaintenanceSpendPence,
    openCommittedPence: sumPence(open.map(openCommitment)),
    projectPence: sumPence(projects.map((job) => (isCompletedJob(job) ? completedCost(job) : openCommitment(job)))),
    routinePence: sumPence(routine.map((job) => (isCompletedJob(job) ? completedCost(job) : openCommitment(job)))),
    previousCompletedMaintenancePence: input.previousPeriod
      ? sumPence(input.previousJobs.filter(isCompletedJob).map(completedCost))
      : null,
  };

  /* ── Site summary ─────────────────────────────────────────────────────── */
  const feeBySite = new Map<string, Pence>();
  for (const line of input.invoiceLines) {
    if (line.included && line.siteId) feeBySite.set(line.siteId, line.feePence);
  }
  const siteById = new Map(input.sites.map((site) => [site.id, site]));

  /* A row for every site that has a job in the period OR is charged on the
     invoice, plus one for jobs with no site. A row for every site in the
     estate would fill the table with zeroes; leaving charged sites out would
     stop the fee column summing to the invoice subtotal. */
  const summarySiteIds = new Set<string>();
  for (const job of jobs) if (job.siteId) summarySiteIds.add(job.siteId);
  for (const [siteId] of feeBySite) summarySiteIds.add(siteId);

  const siteSummary: SiteSummaryRow[] = [];
  const summariseJobs = (rows: readonly ReportJob[], siteId: string | null, name: string, billable: boolean) => {
    const rowCompleted = rows.filter(isCompletedJob);
    const rowOpen = rows.filter(isOpenJob);
    siteSummary.push({
      siteId,
      siteName: name,
      jobsRaised: rows.length,
      completed: rowCompleted.length,
      open: rowOpen.length,
      cancelled: rows.filter(isCancelledJob).length,
      onHold: rows.filter((job) => jobLogGroup(job) === "On Hold").length,
      pastTarget: rows.filter((job) => pastTargetIds.has(job.id)).length,
      critical: rows.filter(isCriticalJob).length,
      completedCostPence: sumPence(rowCompleted.map(completedCost)),
      openQuotedCostPence: sumPence(rowOpen.map(openCommitment)),
      fixedServiceFeePence: siteId ? feeBySite.get(siteId) ?? 0 : 0,
      billable,
    });
  };

  for (const siteId of [...summarySiteIds].sort()) {
    const site = siteById.get(siteId);
    const rows = jobs.filter((job) => job.siteId === siteId);
    summariseJobs(
      rows,
      siteId,
      site?.name ?? rows[0]?.recordedSiteName ?? UNASSIGNED_SITE_NAME,
      site?.billable ?? false,
    );
  }
  const unsited = jobs.filter((job) => !job.siteId);
  if (unsited.length > 0) summariseJobs(unsited, null, UNASSIGNED_SITE_NAME, false);

  siteSummary.sort((a, b) => a.siteName.localeCompare(b.siteName));

  const siteSummaryTotals: MaintenanceSection["siteSummaryTotals"] = {
    jobsRaised: siteSummary.reduce((total, row) => total + row.jobsRaised, 0),
    completed: siteSummary.reduce((total, row) => total + row.completed, 0),
    open: siteSummary.reduce((total, row) => total + row.open, 0),
    cancelled: siteSummary.reduce((total, row) => total + row.cancelled, 0),
    onHold: siteSummary.reduce((total, row) => total + row.onHold, 0),
    pastTarget: siteSummary.reduce((total, row) => total + row.pastTarget, 0),
    critical: siteSummary.reduce((total, row) => total + row.critical, 0),
    completedCostPence: sumPence(siteSummary.map((row) => row.completedCostPence)),
    openQuotedCostPence: sumPence(siteSummary.map((row) => row.openQuotedCostPence)),
    fixedServiceFeePence: sumPence(siteSummary.map((row) => row.fixedServiceFeePence)),
  };

  /* ── Holds ────────────────────────────────────────────────────────────── */
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const holdRows: HoldRow[] = holds
    .filter((hold) => jobById.has(hold.requestId))
    .map((hold) => {
      const job = jobById.get(hold.requestId) as ReportJob;
      const outcome = slaById.get(job.id);
      return {
        holdId: hold.id,
        requestId: job.id,
        reference: job.reference,
        siteName: jobSiteName(job),
        description: job.title || job.description,
        classification: job.classification,
        targetWorkingDays: outcome?.targetWorkingDays ?? null,
        elapsedWorkingDays: outcome?.elapsedWorkingDays ?? null,
        approvedHoldDays: outcome?.approvedHoldDays ?? 0,
        adjustedWorkingDays: outcome?.adjustedWorkingDays ?? null,
        slaResult: outcome?.result ?? "Excluded",
        reason: hold.reason,
        category: hold.category,
        startAt: hold.startAt,
        endAt: hold.endAt,
        approved: hold.approved,
        approvedBy: hold.approvedBy,
        approvalDate: hold.approvedAt,
        note: hold.note,
      };
    });

  /* ── Open past target, and the critical subset ────────────────────────── */
  const openRow = (job: ReportJob): OpenPastTargetRow => {
    const measure = openJobDaysPastTarget(job, holdsFor(holds, job.id), slaRules, input.asOf, holidays);
    return {
      requestId: job.id,
      reference: job.reference,
      siteName: jobSiteName(job),
      issue: job.title || job.description,
      priority: job.priority,
      classification: job.classification,
      raisedOn: job.requestedOn,
      targetOn: measure.targetOn,
      workingDaysOpen: measure.workingDaysOpen,
      daysPastTarget: measure.daysPastTarget,
      status: job.status,
      contractor: job.contractor,
      blocker: job.blockedReason,
      /* There is no "next action" field on a maintenance request. The nearest
         thing the board carries is the date somebody promised an update, so
         that is what is reported — captioned, never dressed up as a plan. */
      nextAction: job.nextUpdateOn ? `Next update due ${job.nextUpdateOn}` : null,
      responsibleUser: job.assignee,
    };
  };

  /* Critical first, then furthest past target, then oldest — the owner's
     stated order, and each tier is a total order so the list is stable. */
  const sortOpen = (rows: OpenPastTargetRow[], jobLookup: Map<string, ReportJob>) =>
    rows.sort((a, b) => {
      const aCritical = isCriticalJob(jobLookup.get(a.requestId) as ReportJob) ? 0 : 1;
      const bCritical = isCriticalJob(jobLookup.get(b.requestId) as ReportJob) ? 0 : 1;
      if (aCritical !== bCritical) return aCritical - bCritical;
      const aPast = a.daysPastTarget ?? -Infinity;
      const bPast = b.daysPastTarget ?? -Infinity;
      if (aPast !== bPast) return bPast - aPast;
      const aRaised = a.raisedOn ?? "9999-12-31";
      const bRaised = b.raisedOn ?? "9999-12-31";
      if (aRaised !== bRaised) return aRaised < bRaised ? -1 : 1;
      return a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0;
    });

  const openPastTarget = sortOpen(pastTarget.map((entry) => openRow(entry.job)), jobById);
  const criticalOpen = sortOpen(critical.map(openRow), jobById);

  /* ── Special projects. Empty means the section is omitted entirely. ───── */
  const specialProjects: SpecialProjectRow[] = projects.map((job) => {
    const finalCostPence = isCompletedJob(job) ? job.costPence : null;
    return {
      requestId: job.id,
      title: job.title || job.description,
      siteName: jobSiteName(job),
      scope: job.description || null,
      plannedStart: job.requestedOn,
      plannedEnd: job.targetOn,
      /* A maintenance request records when it was raised and when it was
         completed, and nothing in between. "Actual start" is therefore the
         raise date and is labelled as such rather than left blank; there is no
         separate on-site start date to report and inventing one would be a
         date on a client document that nothing supports. */
      actualStart: job.requestedOn,
      actualEnd: job.completedOn,
      status: job.status,
      contractor: job.contractor,
      requestedBy: job.requester,
      approvedQuotePence: job.approvedQuotePence,
      finalCostPence,
      variancePence:
        job.approvedQuotePence !== null && finalCostPence !== null
          ? finalCostPence - job.approvedQuotePence
          : null,
      /* No outcome field exists on a request. Null, rather than a sentence
         assembled from a status. */
      outcome: null,
      notes: job.notes,
    };
  });

  /* ── The full job log, grouped in the contract's order ────────────────── */
  const logRow = (job: ReportJob): JobLogRow => {
    const outcome = slaById.get(job.id);
    return {
      requestId: job.id,
      reference: job.reference,
      siteName: jobSiteName(job),
      issue: job.title || job.description,
      jobType: job.jobType,
      classification: job.classification,
      priority: job.priority,
      raisedOn: job.requestedOn,
      targetOn: job.targetOn,
      completedOn: job.completedOn,
      status: job.status,
      slaResult: outcome ? outcome.result : null,
      contractor: job.contractor,
      recordedCostPence: job.costPence,
      quotedCostPence: job.approvedQuotePence,
      holdDays:
        job.requestedOn && (job.completedOn ?? input.asOf)
          ? approvedHoldDays(holdsFor(holds, job.id), job.requestedOn, job.completedOn ?? input.asOf, holidays)
          : 0,
      notes: job.notes,
    };
  };

  const grouped = new Map<JobLogGroup, JobLogRow[]>();
  for (const group of JOB_LOG_GROUPS) grouped.set(group, []);
  for (const job of jobs) {
    (grouped.get(jobLogGroup(job)) as JobLogRow[]).push(logRow(job));
  }
  const jobLog = JOB_LOG_GROUPS.map((group) => ({
    group,
    rows: (grouped.get(group) as JobLogRow[]).sort((a, b) => {
      const aRaised = a.raisedOn ?? "9999-12-31";
      const bRaised = b.raisedOn ?? "9999-12-31";
      if (aRaised !== bRaised) return aRaised < bRaised ? -1 : 1;
      return a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0;
    }),
  }));

  /* ── The SLA rules appendix ───────────────────────────────────────────────
     Every ACTIVE rule, whether or not a job in this period was measured
     against it. A reader checking why a job was excluded needs to see that its
     classification is absent from the list, which an appendix filtered to the
     rules actually used cannot show. */
  const slaRuleRows: SlaRuleRow[] = slaRules
    .filter((rule) => rule.active)
    .map((rule) => ({
      classification: rule.classification,
      targetWorkingDays: rule.targetWorkingDays,
      version: rule.version,
      note: rule.note,
    }))
    .sort((a, b) => a.classification.localeCompare(b.classification));

  /* ── Executive counts and the narrative built from them ───────────────── */
  const measurable = sla.filter((row) => row.result !== "Excluded");
  const activeSites = input.sites.filter(
    (site) => isActiveSiteStatus(site.status) && site.active,
  ).length;
  const counts: ExecutiveCounts = {
    totalJobs: jobs.length,
    activeSites,
    sitesWithJobs: new Set(jobs.map((job) => job.siteId ?? UNASSIGNED_SITE_NAME)).size,
    completedJobs: completed.length,
    openJobs: open.length,
    cancelledJobs: cancelled.length,
    measurableJobs: measurable.length,
    withinSla: measurable.filter((row) => row.result === "Within").length,
    outsideSla: measurable.filter((row) => row.result === "Outside").length,
    slaPercent: kpis.slaPerformancePercent,
    jobsWithApprovedHolds: new Set(
      holds.filter((hold) => hold.approved && jobById.has(hold.requestId)).map((hold) => hold.requestId),
    ).size,
    openPastTarget: pastTarget.length,
    criticalOpen: critical.length,
    previousTotalJobs: input.previousPeriod ? input.previousJobs.length : null,
  };

  const executive = buildExecutiveSummary(counts, {
    period,
    previousPeriod: input.previousPeriod,
    spend,
    currency: input.currency,
    billableSites: input.invoiceTotals.includedSites,
    blockingFindings: input.dataQuality.filter((finding) => finding.severity === "blocking").length,
    warningFindings: input.dataQuality.filter((finding) => finding.severity === "warning").length,
  });

  return {
    kpis,
    executive,
    siteSummary,
    siteSummaryTotals,
    spend,
    sla,
    holds: holdRows,
    openPastTarget,
    criticalOpen,
    specialProjects,
    jobLog,
    dataQuality: [...input.dataQuality],
    slaRules: slaRuleRows,
  };
}
