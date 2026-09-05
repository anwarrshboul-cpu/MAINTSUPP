/**
 * WHAT STOPS A DOCUMENT BEING FINALISED.
 *
 * Warnings never appear here. That is the whole distinction the owner asked
 * for: a Draft may carry every warning in the data-quality section and still be
 * saved, reviewed and approved, because a draft is a working document. A
 * FINALISED document has an invoice number, is locked, and is the thing a
 * client is sent — so the list below is short, is about money, and is
 * deliberately unforgiving.
 *
 * ── ONE SOURCE, NOT TWO ────────────────────────────────────────────────────
 *
 * Everything here is derived from the `CombinedReportPayload` that is about to
 * be written to `report_snapshots`, plus two facts the payload cannot carry:
 * whether a human confirmed a partial period, and whether the workflow has
 * reached Approved. Deriving the blockers from anything else — a second query,
 * a re-read of the settings — would let a document pass a check against data
 * that is not the data being frozen.
 *
 * The blocking DATA-QUALITY findings are forwarded verbatim rather than
 * re-derived, so `data-quality.ts` stays the single place that decides what
 * "blocking" means. Widening a severity there widens this list, in one edit,
 * which is the property that stops the two drifting.
 */

import type {
  CombinedReportPayload,
  DataQualityFinding,
  FinalisationBlocker,
} from "./contract";

export const BLOCKER = {
  noClient: "client.missing",
  invalidPeriod: "period.invalid",
  partialPeriodUnconfirmed: "period.partial_unconfirmed",
  noBillableSites: "sites.none_billable",
  billingIncomplete: "billing.incomplete",
  vatIncomplete: "vat.incomplete",
  notApproved: "status.not_approved",
  alreadyFinalised: "status.already_finalised",
  voided: "status.voided",
  invoiceNumberUnavailable: "invoice.number_unavailable",
  negativeTotal: "totals.negative",
  dataQualityErrors: "data.quality_errors",
} as const;

export interface BlockerInput {
  payload: CombinedReportPayload;
  /**
   * A person has seen the partial-period warning and said to charge anyway.
   * Carried on the finalise request, not stored on the draft: confirming once
   * and then changing the period must not carry the confirmation across.
   */
  confirmedPartialPeriod: boolean;
  /** Whether the workflow requires an Approved status before finalising. */
  requireApproval: boolean;
  /**
   * `${code}:${entityId ?? ""}` for every data-quality error an approver has
   * waived, and for which the waiver has not been revoked.
   *
   * PASSED IN AS DATA rather than computed here, for the same reason the
   * bank-holiday calendar is: `tests/w9-report-engine.test.mjs` stages this
   * module and a fixed list of its neighbours into a temp directory, and a
   * value import of `./waivers` would resolve to a file that suite does not
   * stage. The matching rules live in `app/lib/reporting/waivers.ts`; the
   * caller applies them and hands the result down.
   *
   * Omitted means nothing is waived, which is the safe direction: an absent set
   * blocks more, never less.
   */
  waivedIssueKeys?: ReadonlySet<string>;
}

export function finalisationBlockers(input: BlockerInput): FinalisationBlocker[] {
  const { payload } = input;
  const blockers: FinalisationBlocker[] = [];
  const add = (code: string, message: string) => blockers.push({ code, message });

  /*
   * DATA-QUALITY ERRORS BLOCK, AND A WAIVER IS THE ONLY WAY THROUGH.
   *
   * Module 4 §6 is explicit about why it is neither of the two obvious
   * designs. Blocking on all 48 findings means somebody eventually bypasses
   * the whole system; warning on all 48 means wrong numbers reach a client.
   * So only `blocking` severity stops a finalisation, and an approver can
   * waive one at a time with a typed reason that is then PRINTED in the
   * report's data-quality notes rather than merely stored.
   *
   * `waivedIssueKeys` is supplied by the caller — see the field's own note.
   */
  const waived = input.waivedIssueKeys ?? new Set<string>();
  const unwaived = payload.maintenance.dataQuality.filter(
    (finding: DataQualityFinding) =>
      finding.severity === "blocking" &&
      !waived.has(`${finding.code}:${finding.entityId ?? ""}`),
  );
  if (unwaived.length > 0) {
    add(
      BLOCKER.dataQualityErrors,
      unwaived.length === 1
        ? `One data issue must be fixed or waived before finalising: ${unwaived[0].message}`
        : `${unwaived.length} data issues must be fixed or waived before finalising. The first is: ${unwaived[0].message}`,
    );
  }

  if (!payload.organisationId || !payload.invoice.clientName) {
    add(BLOCKER.noClient, "The document has no client. Choose one before finalising.");
  }

  const { start, end } = payload.period;
  if (!start || !end || start > end) {
    add(BLOCKER.invalidPeriod, "The service period start and end dates are not a valid range.");
  }

  if (payload.invoice.status === "Finalised") {
    add(BLOCKER.alreadyFinalised, "This document is already finalised. Void it and raise a new one to change it.");
  }
  if (payload.invoice.status === "Voided") {
    add(BLOCKER.voided, "This document has been voided and cannot be finalised.");
  }
  if (input.requireApproval && payload.invoice.status !== "Approved") {
    add(BLOCKER.notApproved, "The document must be approved before it can be finalised.");
  }

  if (payload.invoice.totals.includedSites === 0) {
    add(BLOCKER.noBillableSites, "No site is charged on this invoice, so there is nothing to issue.");
  }

  /* Partial period. The flag is set whenever the range is not exactly one
     calendar month, and a monthly fee charged against a range that is not a
     month is a commercial decision, not an arithmetic one. */
  if (payload.period.partialMonth && !input.confirmedPartialPeriod) {
    const affected = payload.invoice.lines.filter(
      (line) => line.included && line.validation.some((entry) => entry.code === "site.partial_billing_window"),
    );
    add(
      BLOCKER.partialPeriodUnconfirmed,
      affected.length > 0
        ? `This period is not a whole calendar month and ${affected.length} charged ${affected.length === 1 ? "site is" : "sites are"} only partly inside their billing window (${affected.map((line) => line.siteName).join(", ")}). Confirm the charge before finalising.`
        : "This period is not a whole calendar month. Confirm that the full monthly fee is being charged before finalising.",
    );
  }

  if (!payload.invoice.currency) {
    add(BLOCKER.billingIncomplete, "No currency is configured for this organisation's billing.");
  }
  if (!payload.invoice.billingAddress) {
    add(BLOCKER.billingIncomplete, "No billing address is set. Add one in the billing settings before finalising.");
  }
  if (!payload.invoice.invoiceDate) {
    add(BLOCKER.billingIncomplete, "The invoice has no date.");
  }

  if (payload.invoice.vatEnabled) {
    if (!payload.invoice.vatNumber) {
      add(BLOCKER.vatIncomplete, "VAT is enabled but no VAT number is configured.");
    }
    if (payload.invoice.vatRateBasisPoints <= 0) {
      add(BLOCKER.vatIncomplete, "VAT is enabled but the VAT rate is zero.");
    }
  }

  if (payload.invoice.totals.totalPence < 0) {
    add(BLOCKER.negativeTotal, "The invoice total is negative. Check the adjustments and credits.");
  }

  /* The blocking data-quality findings, forwarded. See the header. */
  for (const finding of payload.maintenance.dataQuality) {
    if (finding.severity !== "blocking") continue;
    add(finding.code, finding.message);
  }

  /* De-duplicate on code AND message: two sites with no fee are two separate
     things to fix and both must be listed, while one condition reported by two
     paths is one blocker. */
  const seen = new Set<string>();
  return blockers.filter((blocker) => {
    const key = `${blocker.code}::${blocker.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The warnings that accompany a draft — everything the data-quality section
 * raised that is not blocking. Returned separately so a caller never has to
 * filter by severity itself and accidentally treat one as the other.
 */
export function draftWarnings(payload: CombinedReportPayload) {
  return payload.maintenance.dataQuality.filter((finding) => finding.severity === "warning");
}
