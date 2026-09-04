/**
 * THE INVOICE — which sites are charged, at what, and what that adds up to.
 *
 * Pure. Given sites, fee rows, settings and a period it returns the whole
 * `InvoiceSection` of the payload. No database handle reaches it and none can:
 * `engine.ts` reads the rows, this decides the money, and the preview, the Word
 * document, the PDF and the workbook all render the one answer. That is what
 * makes "ALL FORMAT TOTALS MUST MATCH" a property of the design rather than
 * something to test for and hope.
 *
 * ── WHEN A SITE IS BILLABLE — ALL SIX MUST HOLD ────────────────────────────
 *
 *   1. it belongs to the selected organisation   (the engine's query; not here)
 *   2. its status is ACTIVE                      (`isActiveSiteStatus`)
 *   3. its billing window overlaps the period
 *   4. `sites.billable` is true
 *   5. a valid fee resolves                      (`resolveSiteFee`)
 *   6. it is not already charged for an overlapping period on another
 *      non-voided invoice
 *
 * ── WHY AN EXCLUDED SITE IS STILL A LINE ───────────────────────────────────
 *
 * A site that fails 2, 3, 4 or 6 appears with `included: false` and a stated
 * `exclusionReason`, not as an absence. An operator cannot check a count they
 * cannot see: "31 sites, 28 charged" with the three named and the reason
 * beside each is auditable, while a list of 28 is a number they have to take on
 * trust. `InvoiceTotals` carries `totalSites`, `includedSites` and
 * `excludedSites` for exactly this reason.
 *
 * Archived and deleted sites are the exception and never reach this function —
 * they are not part of the estate, so counting them as "excluded" would inflate
 * the total the operator is reconciling against.
 *
 * ── WHY A SITE WITH NO FEE IS INCLUDED AND BLOCKING ────────────────────────
 *
 * Rule 5 is not applied by dropping the site. A site with no resolvable fee is
 * charged at nothing, marked `feeSource: null`, and carries a BLOCKING
 * validation — so it is impossible to miss on the preview and impossible to
 * finalise. Dropping it would quietly produce a correct-looking invoice that is
 * short by one site's fee, which is the failure the owner would find out about
 * from a client. Charging it at zero and refusing to issue the document is
 * loud, and the total is never wrong on a document that exists.
 *
 * ── PRO RATA IS OFF UNLESS THE CLIENT ACTUALLY HAS THE RULE ────────────────
 *
 * A site activated on the 14th is charged the WHOLE fee unless
 * `billing_settings.pro_rata_enabled` is set. Apportioning by default would
 * invent a commercial term; the partial coverage is flagged instead, and the
 * document cannot be finalised until somebody confirms it.
 */

import { isActiveSiteStatus } from "../site-state";
import {
  feeCoversPeriod,
  feeTouchesPeriod,
  resolveSiteFee,
} from "../billing/fee-resolution";
import type {
  BillableSiteLine,
  InvoiceAdjustmentEntry,
  InvoiceSection,
  InvoiceStatus,
  InvoiceTotals,
  LineValidation,
  Pence,
  ReportPeriod,
} from "./contract";
import type {
  BillingConfiguration,
  ExistingCharge,
  FeeRecord,
  LineDecision,
  ReportSite,
} from "./inputs";
import { averagePence, roundPence, singleValue, sumPence, vatOnPence } from "./money";
import { daysInclusive, rangeCovers, rangesOverlap } from "./period";

/**
 * Validation codes. Stable strings, because the preview groups on them and an
 * export prints the message beside them.
 */
export const LINE_VALIDATION = {
  feeMissing: "fee.missing",
  feeChangedMidPeriod: "fee.changed_mid_period",
  siteInactive: "site.inactive",
  siteNotBillable: "site.not_billable",
  siteOutsideWindow: "site.outside_billing_window",
  sitePartialWindow: "site.partial_billing_window",
  siteAlreadyCharged: "site.already_charged",
  siteOnAnotherDraft: "site.on_another_draft",
  excludedByOperator: "line.excluded_by_operator",
  proRated: "line.pro_rated",
} as const;

export interface InvoiceComputeInput {
  period: ReportPeriod;
  clientName: string;
  config: BillingConfiguration;
  sites: readonly ReportSite[];
  clientFees: readonly FeeRecord[];
  /** Every override row for the organisation; narrowed per site here. */
  siteOverrides: readonly FeeRecord[];
  existingCharges: readonly ExistingCharge[];
  decisions: readonly LineDecision[];
  adjustments: readonly InvoiceAdjustmentEntry[];
  header: {
    invoiceId: string | null;
    invoiceNumber: string | null;
    status: InvoiceStatus;
    invoiceDate: string | null;
    dueAt: string | null;
    billingAddress: string | null;
    clientReference: string | null;
    purchaseOrder: string | null;
    internalReference: string | null;
    paymentTerms: string | null;
    clientNote: string | null;
    internalNote: string | null;
  };
}

function blocking(code: string, message: string): LineValidation {
  return { severity: "blocking", code, message };
}

function warning(code: string, message: string): LineValidation {
  return { severity: "warning", code, message };
}

function info(code: string, message: string): LineValidation {
  return { severity: "info", code, message };
}

/**
 * How much of the period a site's billing window actually covers, in days.
 *
 * Only consulted when pro rata is enabled. The apportioned fee is
 * `round(fee × coveredDays ÷ periodDays)`, rounded once by the one rounding
 * rule in `money.ts`, so the apportioned lines still sum to the printed total.
 */
export function coveredDays(site: ReportSite, period: ReportPeriod): number {
  const start = site.billingActiveFrom && site.billingActiveFrom > period.start
    ? site.billingActiveFrom
    : period.start;
  const end = site.billingActiveTo && site.billingActiveTo < period.end
    ? site.billingActiveTo
    : period.end;
  if (start > end) return 0;
  return daysInclusive(start, end);
}

/**
 * Charges on other documents covering any of the same days for this site.
 *
 * Voided invoices are not charges. The engine filters them out before they get
 * here, and this function does not re-check, because "which statuses are live"
 * is a question about the document workflow and belongs with the workflow.
 *
 * Returns the committed one first, because a committed overlap excludes the
 * line and an uncommitted one only warns — see `ExistingCharge`.
 */
function overlappingCharges(
  siteId: string,
  charges: readonly ExistingCharge[],
  period: ReportPeriod,
): { committed: ExistingCharge | null; drafts: ExistingCharge[] } {
  const overlapping = charges.filter(
    (charge) =>
      charge.siteId === siteId &&
      rangesOverlap(charge.periodStart, charge.periodEnd, period.start, period.end),
  );
  return {
    committed: overlapping.find((charge) => charge.committed) ?? null,
    drafts: overlapping.filter((charge) => !charge.committed),
  };
}

export function computeInvoiceSection(input: InvoiceComputeInput): InvoiceSection {
  const { period, config } = input;
  const vatRate = config.vatEnabled ? config.vatRateBasisPoints : 0;
  const periodDays = daysInclusive(period.start, period.end);
  const decisions = new Map(input.decisions.map((decision) => [decision.siteId, decision]));

  const lines: BillableSiteLine[] = input.sites.map((site, index) => {
    const validation: LineValidation[] = [];
    const overrides = input.siteOverrides.filter((record) => record.siteId === site.id);
    const { resolved, partialCover } = resolveSiteFee({
      overrides,
      clientFees: input.clientFees,
      defaultFeePence: config.defaultSiteFeePence,
      period: { start: period.start, end: period.end },
    });

    let included = true;
    let exclusionReason: string | null = null;

    /* Rule 2 — the site is trading. `isActiveSiteStatus` is the product's one
       answer to that question; the Dashboard's tile and the Sites register read
       the same function, and its own header names this engine as a caller. */
    if (!isActiveSiteStatus(site.status) || !site.active) {
      included = false;
      exclusionReason = `The site is not active (status: ${site.status || "unknown"}).`;
      validation.push(info(LINE_VALIDATION.siteInactive, exclusionReason));
    } else if (!site.billable) {
      /* Rule 4 — trading, and deliberately outside the agreement.
         `sites.billable` is separate from `sites.active` precisely so that
         operations staff toggling one cannot move money. */
      included = false;
      exclusionReason = "The site is marked as not billable.";
      validation.push(info(LINE_VALIDATION.siteNotBillable, exclusionReason));
    } else if (
      !rangesOverlap(site.billingActiveFrom, site.billingActiveTo, period.start, period.end)
    ) {
      /* Rule 3 — the billing window does not touch the period at all. */
      included = false;
      exclusionReason = "The site's billing window does not cover any of this period.";
      validation.push(info(LINE_VALIDATION.siteOutsideWindow, exclusionReason));
    }

    /* Rule 6 — the same site, the same days, on another document.
       A COMMITTED charge (Approved or Finalised) excludes the line and blocks:
       two invoices charging one site for one month is a refund conversation,
       and the operator has to see it. An overlap with a DRAFT only warns — see
       `ExistingCharge` for why blocking on a draft made the feature unusable a
       second time. */
    const overlaps = included
      ? overlappingCharges(site.id, input.existingCharges, period)
      : { committed: null, drafts: [] };
    if (overlaps.committed) {
      const duplicate = overlaps.committed;
      included = false;
      exclusionReason = `Already charged on ${duplicate.invoiceNumber ?? "another document"} for ${duplicate.periodStart} to ${duplicate.periodEnd}.`;
      validation.push(blocking(LINE_VALIDATION.siteAlreadyCharged, exclusionReason));
    } else if (overlaps.drafts.length > 0) {
      validation.push(
        warning(
          LINE_VALIDATION.siteOnAnotherDraft,
          `This site also appears on ${overlaps.drafts.length} other working ${overlaps.drafts.length === 1 ? "document" : "documents"} covering some of the same days. Only one of them can be finalised.`,
        ),
      );
    }

    let feePence: Pence = 0;
    if (included) {
      if (!resolved) {
        /* Rule 5 — see the header. Charged at nothing, blocking, and visible. */
        validation.push(
          blocking(
            LINE_VALIDATION.feeMissing,
            "No fee applies to this site for this period. Configure a site override, a client fee or an organisation default before finalising.",
          ),
        );
      } else {
        feePence = resolved.feePence;
      }
      if (partialCover.length > 0) {
        validation.push(
          blocking(
            LINE_VALIDATION.feeChangedMidPeriod,
            "A fee for this site starts or ends inside this period. Decide which fee the period is charged at, or split the period.",
          ),
        );
      }

      /* Partial coverage — activated or deactivated inside the period. */
      const covers = rangeCovers(
        site.billingActiveFrom,
        site.billingActiveTo,
        period.start,
        period.end,
      );
      if (!covers) {
        const days = coveredDays(site, period);
        if (config.proRataEnabled && periodDays > 0) {
          const full = feePence;
          feePence = roundPence((full * days) / periodDays);
          validation.push(
            info(
              LINE_VALIDATION.proRated,
              `Charged for ${days} of ${periodDays} days, pro rata, as this organisation's billing settings allow.`,
            ),
          );
        } else {
          validation.push(
            warning(
              LINE_VALIDATION.sitePartialWindow,
              `The site is only inside its billing window for ${days} of the ${periodDays} days in this period. The full fee is charged because pro rata is not enabled.`,
            ),
          );
        }
      }
    }

    /* An operator's own decision comes last and overrides inclusion in either
       direction — but never the blocking validations above, which stay on the
       line so that re-including a duplicate cannot smuggle it past the
       finaliser. */
    const decision = decisions.get(site.id);
    if (decision && decision.included === false) {
      included = false;
      exclusionReason = decision.reason || "Excluded by an operator.";
      validation.push(info(LINE_VALIDATION.excludedByOperator, exclusionReason));
    }

    const lineSubtotalPence = included ? feePence : 0;
    const lineVatPence = included ? vatOnPence(lineSubtotalPence, vatRate) : 0;

    return {
      lineNo: index + 1,
      siteId: site.id,
      siteName: site.name,
      siteReference: site.reference,
      activeStatus: site.status,
      activeFrom: site.billingActiveFrom,
      activeTo: site.billingActiveTo,
      billable: site.billable,
      feePence: lineSubtotalPence,
      feeSource: included && resolved ? resolved.source : null,
      feeRecordId: included && resolved ? resolved.recordId : null,
      vatRateBasisPoints: vatRate,
      lineSubtotalPence,
      lineVatPence,
      lineTotalPence: lineSubtotalPence + lineVatPence,
      included,
      exclusionReason,
      excludedByEmail: decision?.byEmail ?? null,
      excludedAt: decision?.at ?? null,
      validation,
    };
  });

  return {
    invoiceId: input.header.invoiceId,
    invoiceNumber: input.header.invoiceNumber,
    status: input.header.status,
    invoiceDate: input.header.invoiceDate,
    dueAt: input.header.dueAt,
    servicePeriod: period,
    clientName: input.clientName,
    billingAddress: input.header.billingAddress ?? config.billingAddress,
    clientReference: input.header.clientReference,
    purchaseOrder: input.header.purchaseOrder,
    internalReference: input.header.internalReference,
    currency: config.currency,
    paymentTerms: input.header.paymentTerms ?? config.paymentTermsNote,
    vatEnabled: config.vatEnabled,
    vatRateBasisPoints: vatRate,
    vatNumber: config.vatNumber,
    clientNote: input.header.clientNote,
    internalNote: input.header.internalNote,
    lines,
    adjustments: [...input.adjustments],
    totals: computeInvoiceTotals(lines, input.adjustments),
  };
}

/**
 * The totals, from the lines and nothing else.
 *
 * VAT is the SUM OF THE LINE VAT figures, each rounded as it was computed —
 * never the rate applied to the subtotal. Both are defensible; only one of them
 * lets a reader add up the Excel column and get the number on the PDF, and that
 * is the requirement.
 *
 * A credit is stored as a positive magnitude and SUBTRACTED here, so a credit
 * and the charge it reverses are the same number with one sign between them.
 */
export function computeInvoiceTotals(
  lines: readonly BillableSiteLine[],
  adjustments: readonly InvoiceAdjustmentEntry[],
): InvoiceTotals {
  const included = lines.filter((line) => line.included);
  const subtotalPence = sumPence(included.map((line) => line.lineSubtotalPence));
  const vatPence = sumPence(included.map((line) => line.lineVatPence));
  const adjustmentPence = sumPence(
    adjustments.filter((entry) => entry.kind === "adjustment").map((entry) => entry.amountPence),
  );
  const creditPence = sumPence(
    adjustments.filter((entry) => entry.kind === "credit").map((entry) => Math.abs(entry.amountPence)),
  );

  /* "Fixed Fee per Site" is only honest when every charged site carries the
     same fee AND every one of them actually has a fee. Without the second half
     an invoice whose sites are all unpriced would report a fixed fee of £0.00,
     which is a confident statement about a document that cannot be issued. */
  const everyLinePriced = included.every((line) => line.feeSource !== null);
  const singleFeePence = everyLinePriced
    ? singleValue(included.map((line) => line.feePence))
    : null;

  return {
    totalSites: lines.length,
    includedSites: included.length,
    excludedSites: lines.length - included.length,
    subtotalPence,
    vatPence,
    adjustmentPence,
    creditPence,
    totalPence: subtotalPence + vatPence + adjustmentPence - creditPence,
    singleFeePence,
    averageFeePence: averagePence(subtotalPence, included.length),
  };
}

/** Re-exported so `data-quality.ts` can name the same two window predicates. */
export { feeCoversPeriod, feeTouchesPeriod };
