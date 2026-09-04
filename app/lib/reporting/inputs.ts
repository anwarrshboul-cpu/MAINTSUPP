/**
 * WHAT THE ENGINE HANDS THE PURE MODULES.
 *
 * `contract.ts` describes the OUTPUT — the one shape every renderer sees.
 * This file describes the INPUT: the rows, already read, already scoped to one
 * organisation, already converted to integer pence and calendar dates.
 *
 * The separation is what keeps `invoice-compute.ts`, `maintenance-compute.ts`,
 * `sla.ts` and `data-quality.ts` callable from `node --test` with hand-written
 * fixtures. They compute the whole report from these values and nothing else —
 * no database handle reaches them, and none can, because none of them imports
 * one.
 *
 * Every field here is normalised at exactly one place, `engine.ts`. If a value
 * is wrong in the report it is wrong in one function, not in five.
 */

import type { IsoDate, Pence } from "./contract";

/**
 * A job, as the report sees it.
 *
 * `requestedOn` / `targetOn` / `completedOn` are calendar dates, not stamps —
 * `dateOnly` in `period.ts` explains why the stored text cannot be parsed as an
 * instant without inventing a timezone. Null means the stamp was missing or
 * unreadable, which the data-quality section reports rather than repairs.
 */
export interface ReportJob {
  id: string;
  reference: string | null;
  title: string;
  description: string;
  siteId: string | null;
  /** Snapshotted by the engine from the site register, or "" when unresolved. */
  siteName: string;
  /** The site name the row itself carries, for the inconsistency check. */
  recordedSiteName: string | null;
  status: string;
  stage: string;
  priority: string;
  tier: number;
  /**
   * The board's work category — "Plumbing", "Electrical". This is the field an
   * SLA rule is keyed on, because it is the only categorisation a job carries
   * that a contract is written against.
   */
  classification: string | null;
  jobType: string | null;
  /** The name typed onto the job — the historical record of who was named. */
  contractor: string | null;
  contractorId: string | null;
  /**
   * What the contractor register calls the same contractor, when the job
   * carries a reference to one. Only the inconsistency check reads it; every
   * figure uses `contractor`, so a rename can never move money.
   */
  contractorRegisterName: string | null;
  assignee: string | null;
  requester: string | null;
  requestedOn: IsoDate | null;
  targetOn: IsoDate | null;
  completedOn: IsoDate | null;
  /** Null when no cost is recorded. Zero is a recorded cost of zero. */
  costPence: Pence | null;
  /** The raw cost was present but not a usable number. Reported, never fixed. */
  costInvalid: boolean;
  /**
   * The most recently approved quotation against this job, in pence.
   *
   * Read from `quotations`, which is a real table with a real `approved_at`,
   * rather than left null and captioned "not available". It is what makes the
   * variance column on a special project a measurement instead of a dash. Null
   * when the job carries no approved quote, which is most of them.
   */
  approvedQuotePence: Pence | null;
  invoice: string | null;
  approvedBy: string | null;
  notes: string | null;
  /** `maintenance_requests.blocked_reason` — what the open-past-target table calls the blocker. */
  blockedReason: string | null;
  /** `next_update_at`, as a calendar date. The nearest thing the board has to a next action. */
  nextUpdateOn: IsoDate | null;
}

/** A site, as the billing selector sees it. */
export interface ReportSite {
  id: string;
  name: string;
  reference: string | null;
  /** The site's own status word, passed through rather than re-derived. */
  status: string;
  active: boolean;
  billable: boolean;
  billingActiveFrom: IsoDate | null;
  billingActiveTo: IsoDate | null;
}

/** A hold on a job. `approved` is the only thing that reduces measured time. */
export interface ReportHold {
  id: string;
  requestId: string;
  startAt: IsoDate | null;
  endAt: IsoDate | null;
  reason: string | null;
  category: string | null;
  approved: boolean;
  approvedBy: string | null;
  approvedAt: IsoDate | null;
  note: string | null;
}

/** A target, as configured. Nothing is seeded — see `sla.ts`. */
export interface ReportSlaRule {
  id: string;
  classification: string;
  targetWorkingDays: number;
  active: boolean;
  version: number;
  note: string | null;
}

/** One effective-dated fee row, from either level of the hierarchy. */
export interface FeeRecord {
  id: string;
  /** Null for a client-level fee; a site id for an override. */
  siteId: string | null;
  feePence: Pence;
  effectiveFrom: IsoDate | null;
  effectiveTo: IsoDate | null;
  note: string | null;
}

/** The organisation's billing configuration, as the computation needs it. */
export interface BillingConfiguration {
  currency: string;
  defaultSiteFeePence: Pence | null;
  vatEnabled: boolean;
  vatRateBasisPoints: number;
  vatNumber: string | null;
  paymentTermsDays: number;
  paymentTermsNote: string | null;
  billingAddress: string | null;
  invoiceNumberPrefix: string;
  proRataEnabled: boolean;
}

/**
 * A site already charged for an overlapping period on another live invoice.
 *
 * The partial unique index stops the same site appearing twice on ONE invoice.
 * Charging it twice across TWO invoices is not a database constraint and cannot
 * be — two invoices for two periods are legitimate — so it is a validation, and
 * this is what the validator is given to work with.
 *
 * ── WHY A DRAFT DOES NOT BLOCK ─────────────────────────────────────────────
 *
 * `committed` is the difference between "somebody decided to charge this site"
 * and "somebody is drafting something". Approved and Finalised are decisions;
 * Draft and Ready for Review are working documents, and two drafts for the same
 * month is an ordinary thing to have — one of them is a mistake, and the way you
 * find out which is by looking at both.
 *
 * This was measured, not assumed. Treating every non-voided document as a
 * charge made the SECOND draft for a month exclude all sixteen sites and
 * produce a £0.00 invoice with fourteen blockers on it, which is not a safety
 * property, it is a feature that cannot be used twice. An uncommitted overlap
 * is a WARNING on a line that stays included; a committed one excludes the line
 * and blocks finalisation, which is the point at which double-charging becomes
 * possible.
 */
export interface ExistingCharge {
  siteId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  status: string;
  /** Approved or Finalised — a decision to charge, not a document in progress. */
  committed: boolean;
  periodStart: IsoDate;
  periodEnd: IsoDate;
}

/** An operator's decision to leave a site off this invoice. */
export interface LineDecision {
  siteId: string;
  included: boolean;
  reason: string | null;
  byEmail: string | null;
  at: string | null;
}
