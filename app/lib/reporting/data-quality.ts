/**
 * DATA QUALITY — everything wrong with the data, reported and never repaired.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 * Nothing in this module changes a value. Not a defaulted cost, not an inferred
 * completion date, not a guessed site. A report that quietly fixes its inputs
 * is a report whose numbers cannot be checked against the system they came
 * from, and the owner's instruction was the opposite: surface it, name the
 * record, and let a person decide.
 *
 * ── THE THREE SEVERITIES MEAN DIFFERENT THINGS ─────────────────────────────
 *
 *   BLOCKING — the document cannot be finalised. Reserved for things that make
 *              the MONEY wrong: a site with no fee, a site charged twice.
 *   WARNING  — the document can be a Draft and can be approved, but a person
 *              should look. Mostly dates and holds: they move the SLA figure,
 *              not the invoice.
 *   INFO     — worth knowing, changes nothing. Missing contractors, sites
 *              deliberately left out, names spelled two ways.
 *
 * The split is not cosmetic. `blockers.ts` reads the BLOCKING findings and
 * nothing else, so widening a severity here widens what stops an invoice — and
 * that has to be a deliberate edit in a file that says so.
 *
 * ── LINKS ──────────────────────────────────────────────────────────────────
 *
 * `href` points at the SECTION that holds the record — `/dashboard/maintenance`,
 * `/dashboard/stores` — because this product has no per-record deep link: the
 * only query parameter `portal-app.tsx` reads is `?manage=import`, and the
 * record drawer is opened by `openWorkspaceManager(tab, recordId)`, which has
 * no URL. Pointing at the section is a link that works; inventing
 * `?job=<id>` would be a link that silently does nothing.
 */

import { priorityRule } from "../priority-rules";
import { isActiveSiteStatus } from "../site-state";
import type { BillableSiteLine, DataQualityFinding, ReportPeriod } from "./contract";
import type { ExistingCharge, ReportHold, ReportJob, ReportSite, ReportSlaRule } from "./inputs";
import { isCompletedJob, isKnownStatus, isOpenJob } from "./job-classification";
import { LINE_VALIDATION } from "./invoice-compute";
import { ruleFor } from "./sla";

export const DQ = {
  jobMissingRequestDate: "job.missing_request_date",
  jobCompletedWithoutDate: "job.completed_without_completion_date",
  jobOpenWithCompletionDate: "job.open_with_completion_date",
  jobInvalidDateSequence: "job.invalid_date_sequence",
  jobDueBeforeRaised: "job.due_before_raised",
  jobMissingSite: "job.missing_site",
  jobMissingContractor: "job.missing_contractor",
  jobMissingCost: "job.missing_cost",
  jobInvalidCost: "job.invalid_cost",
  jobNegativeCost: "job.negative_cost",
  jobDuplicateReference: "job.duplicate_reference",
  jobPossibleDuplicate: "job.possible_duplicate",
  jobSiteNameMismatch: "job.site_name_mismatch",
  jobContractorNameMismatch: "job.contractor_name_mismatch",
  jobRequesterNameVariants: "job.requester_name_variants",
  jobNoClassification: "job.no_classification",
  jobNoSlaRule: "job.no_sla_rule",
  jobUnknownStatus: "job.unknown_status",
  jobPriorityTierMismatch: "job.priority_tier_mismatch",
  holdUnapproved: "hold.unapproved",
  holdOutsideJob: "hold.outside_job_duration",
  holdNoDates: "hold.missing_dates",
  siteNoFee: "site.no_valid_fee",
  siteDuplicateCharge: "site.duplicate_charge",
  siteExcluded: "site.excluded_from_billing",
  settingsNoDefaultFee: "settings.no_default_fee",
  settingsVatIncomplete: "settings.vat_incomplete",
  settingsNoSlaRules: "settings.no_sla_rules",
} as const;

const JOB_HREF = "/dashboard/maintenance";
const SITE_HREF = "/dashboard/stores";
const REPORTS_HREF = "/dashboard/reports";

function normalise(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function jobLabel(job: ReportJob): string {
  return job.reference ? `${job.reference} (${job.title || job.description})` : job.title || job.description || job.id;
}

export interface DataQualityInput {
  period: ReportPeriod;
  jobs: readonly ReportJob[];
  sites: readonly ReportSite[];
  holds: readonly ReportHold[];
  slaRules: readonly ReportSlaRule[];
  invoiceLines: readonly BillableSiteLine[];
  existingCharges: readonly ExistingCharge[];
  vatEnabled: boolean;
  vatNumber: string | null;
  vatRateBasisPoints: number;
  defaultSiteFeePence: number | null;
}

export function computeDataQuality(input: DataQualityInput): DataQualityFinding[] {
  const findings: DataQualityFinding[] = [];
  const add = (
    severity: DataQualityFinding["severity"],
    code: string,
    message: string,
    entityType: DataQualityFinding["entityType"],
    entityId: string | null,
    href: string | null,
  ) => findings.push({ severity, code, message, entityType, entityId, href });

  /* ── Jobs ─────────────────────────────────────────────────────────────── */
  const byReference = new Map<string, ReportJob[]>();
  const requesterSpellings = new Map<string, Set<string>>();

  for (const job of input.jobs) {
    if (!job.requestedOn) {
      add("warning", DQ.jobMissingRequestDate, `${jobLabel(job)} has no readable request date, so it cannot be measured against an SLA target.`, "job", job.id, JOB_HREF);
    }
    if (isCompletedJob(job) && !job.completedOn) {
      add("warning", DQ.jobCompletedWithoutDate, `${jobLabel(job)} is filed as completed but carries no completion date.`, "job", job.id, JOB_HREF);
    }
    if (isOpenJob(job) && job.completedOn) {
      add("warning", DQ.jobOpenWithCompletionDate, `${jobLabel(job)} carries a completion date of ${job.completedOn} but is not filed as completed.`, "job", job.id, JOB_HREF);
    }
    if (job.requestedOn && job.completedOn && job.completedOn < job.requestedOn) {
      add("warning", DQ.jobInvalidDateSequence, `${jobLabel(job)} was completed on ${job.completedOn}, before it was raised on ${job.requestedOn}.`, "job", job.id, JOB_HREF);
    }
    if (job.requestedOn && job.targetOn && job.targetOn < job.requestedOn) {
      add("warning", DQ.jobDueBeforeRaised, `${jobLabel(job)} has a target date of ${job.targetOn}, before it was raised on ${job.requestedOn}.`, "job", job.id, JOB_HREF);
    }
    if (!job.siteId) {
      add("warning", DQ.jobMissingSite, `${jobLabel(job)} is not linked to a site, so it cannot appear in the site summary.`, "job", job.id, JOB_HREF);
    } else if (job.siteName && job.recordedSiteName && normalise(job.siteName) !== normalise(job.recordedSiteName)) {
      add("info", DQ.jobSiteNameMismatch, `${jobLabel(job)} records the location as "${job.recordedSiteName}" while the site register calls it "${job.siteName}".`, "job", job.id, JOB_HREF);
    }
    if (!job.contractor && !job.contractorId) {
      add("info", DQ.jobMissingContractor, `${jobLabel(job)} names no contractor.`, "job", job.id, JOB_HREF);
    }
    if (job.costInvalid) {
      add("warning", DQ.jobInvalidCost, `${jobLabel(job)} carries a cost that is not a usable number.`, "job", job.id, JOB_HREF);
    } else if (job.costPence === null && isCompletedJob(job)) {
      add("info", DQ.jobMissingCost, `${jobLabel(job)} is completed with no cost recorded, so it contributes nothing to the spend figures.`, "job", job.id, JOB_HREF);
    } else if (job.costPence !== null && job.costPence < 0) {
      add("warning", DQ.jobNegativeCost, `${jobLabel(job)} carries a negative cost.`, "job", job.id, JOB_HREF);
    }
    if (!job.classification) {
      add("info", DQ.jobNoClassification, `${jobLabel(job)} carries no classification, so no SLA target applies to it.`, "job", job.id, JOB_HREF);
    } else if (!ruleFor(input.slaRules, job.classification)) {
      add("info", DQ.jobNoSlaRule, `No SLA rule is configured for "${job.classification}", so ${jobLabel(job)} is excluded from the SLA measurement.`, "job", job.id, JOB_HREF);
    }
    if (!isKnownStatus(job.status)) {
      add("info", DQ.jobUnknownStatus, `${jobLabel(job)} carries the status "${job.status}", which this report does not recognise; it has been grouped by its lifecycle stage instead.`, "job", job.id, JOB_HREF);
    }
    if (priorityRule(job.priority).tier !== job.tier) {
      add("info", DQ.jobPriorityTierMismatch, `${jobLabel(job)} is priority "${job.priority}" but tier ${job.tier}; the configured rule for that priority is tier ${priorityRule(job.priority).tier}.`, "job", job.id, JOB_HREF);
    }

    if (job.reference) {
      const list = byReference.get(job.reference) ?? [];
      list.push(job);
      byReference.set(job.reference, list);
    }
    if (job.requester) {
      const key = normalise(job.requester);
      const set = requesterSpellings.get(key) ?? new Set<string>();
      set.add(job.requester.trim());
      requesterSpellings.set(key, set);
    }
  }

  for (const [reference, jobs] of byReference) {
    if (jobs.length > 1) {
      add("warning", DQ.jobDuplicateReference, `${jobs.length} jobs share the reference ${reference}.`, "job", jobs[0].id, JOB_HREF);
    }
  }

  for (const [, spellings] of requesterSpellings) {
    if (spellings.size > 1) {
      add("info", DQ.jobRequesterNameVariants, `The same requester is recorded under ${spellings.size} spellings: ${[...spellings].join(", ")}.`, "job", null, JOB_HREF);
    }
  }

  /* Possible duplicates — the same site, the same issue in words, raised within
     a week. Deliberately conservative: this reports a suspicion for a person to
     confirm, and a looser rule would bury it in false positives. */
  const seen = new Set<string>();
  for (const a of input.jobs) {
    for (const b of input.jobs) {
      if (a.id >= b.id) continue;
      if (!a.siteId || a.siteId !== b.siteId) continue;
      if (normalise(a.title) !== normalise(b.title) || !normalise(a.title)) continue;
      if (!a.requestedOn || !b.requestedOn) continue;
      const gap = Math.abs(Date.parse(`${a.requestedOn}T00:00:00Z`) - Date.parse(`${b.requestedOn}T00:00:00Z`));
      if (gap > 7 * 86_400_000) continue;
      const key = `${a.id}:${b.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      add("info", DQ.jobPossibleDuplicate, `${jobLabel(a)} and ${jobLabel(b)} describe the same issue at the same site within a week of each other.`, "job", a.id, JOB_HREF);
    }
  }

  /* Contractor naming — the free-text name against the register's. */
  for (const job of input.jobs) {
    if (job.contractorId && job.contractor && job.contractorRegisterName) {
      if (normalise(job.contractor) !== normalise(job.contractorRegisterName)) {
        add("info", DQ.jobContractorNameMismatch, `${jobLabel(job)} names the contractor as "${job.contractor}" while the register calls them "${job.contractorRegisterName}".`, "contractor", job.contractorId, "/dashboard/contractors");
      }
    }
  }

  /* ── Holds ────────────────────────────────────────────────────────────── */
  const jobById = new Map(input.jobs.map((job) => [job.id, job]));
  for (const hold of input.holds) {
    const job = jobById.get(hold.requestId);
    if (!job) continue;
    if (!hold.approved) {
      add("warning", DQ.holdUnapproved, `A hold on ${jobLabel(job)} has not been approved, so its days are NOT removed from the measured duration.`, "job", job.id, JOB_HREF);
    }
    if (!hold.startAt) {
      add("warning", DQ.holdNoDates, `A hold on ${jobLabel(job)} has no start date and cannot be applied.`, "job", job.id, JOB_HREF);
      continue;
    }
    const jobEnd = job.completedOn ?? input.period.end;
    if (job.requestedOn && (hold.startAt < job.requestedOn || (hold.endAt !== null && hold.endAt > jobEnd))) {
      add("warning", DQ.holdOutsideJob, `A hold on ${jobLabel(job)} runs from ${hold.startAt} to ${hold.endAt ?? "an open end"}, outside the job's own duration; it has been clamped to the job.`, "job", job.id, JOB_HREF);
    }
  }

  /* ── Billing ──────────────────────────────────────────────────────────── */
  for (const line of input.invoiceLines) {
    for (const validation of line.validation) {
      if (validation.code === LINE_VALIDATION.feeMissing) {
        add("blocking", DQ.siteNoFee, `${line.siteName} is an active, billable site with no fee for this period.`, "site", line.siteId, SITE_HREF);
      } else if (validation.code === LINE_VALIDATION.feeChangedMidPeriod) {
        add("blocking", DQ.siteNoFee, `A fee for ${line.siteName} starts or ends inside this period, so no single fee covers it.`, "site", line.siteId, REPORTS_HREF);
      } else if (validation.code === LINE_VALIDATION.siteAlreadyCharged) {
        add("blocking", DQ.siteDuplicateCharge, `${line.siteName} is already charged for an overlapping period: ${validation.message}`, "site", line.siteId, REPORTS_HREF);
      } else if (!line.included) {
        add("info", DQ.siteExcluded, `${line.siteName} is not charged on this invoice: ${line.exclusionReason ?? validation.message}`, "site", line.siteId, SITE_HREF);
      }
    }
  }

  /* An active, billable site that produced no line at all — the engine's site
     read and the invoice's line list disagreeing is itself worth reporting,
     because it is the only way a site could go silently unbilled. */
  const lineSiteIds = new Set(input.invoiceLines.map((line) => line.siteId));
  for (const site of input.sites) {
    if (!isActiveSiteStatus(site.status) || !site.active || !site.billable) continue;
    if (!lineSiteIds.has(site.id)) {
      add("blocking", DQ.siteNoFee, `${site.name} is an active, billable site but produced no invoice line.`, "site", site.id, SITE_HREF);
    }
  }

  /* ── Settings ─────────────────────────────────────────────────────────── */
  if (input.defaultSiteFeePence === null) {
    add("info", DQ.settingsNoDefaultFee, "No organisation default site fee is configured, so every site needs its own fee or a client fee.", "settings", null, REPORTS_HREF);
  }
  if (input.vatEnabled && (!input.vatNumber || input.vatRateBasisPoints <= 0)) {
    add("blocking", DQ.settingsVatIncomplete, "VAT is enabled but the VAT number or rate is missing, so a VAT invoice cannot be issued.", "settings", null, REPORTS_HREF);
  }
  if (input.slaRules.filter((rule) => rule.active).length === 0) {
    add("info", DQ.settingsNoSlaRules, "No SLA rules are configured, so no job in this period can be measured and no performance figure is stated.", "settings", null, REPORTS_HREF);
  }

  return findings;
}
