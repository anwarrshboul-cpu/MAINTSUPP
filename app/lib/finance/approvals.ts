/**
 * WHO MAY APPROVE THIS INVOICE, AND HOW MANY OF THEM. §13.
 *
 * "Value-banded thresholds in settings, e.g. under £250 auto-approve on match,
 * £250–£1,000 one approver, above £1,000 two approvers, above £5,000 requires
 * client sign-off recorded against the quote." Those four are seeded as ROWS by
 * `db/init.ts`, not written here as constants — a workspace that pays a
 * different way edits its ladder, and nothing in this file has to change.
 *
 * ── MAKER / CHECKER ────────────────────────────────────────────────────────
 *
 * §13's small control: "An approver cannot approve an invoice against a quote
 * they themselves approved above a configurable value." The value is
 * `approval_rules.maker_checker_from_pence`, per band. The decision itself is
 * `approvalDecision` in `./rules.ts` — pure, and tested by being called.
 *
 * ── THE BASIS IS RECORDED, NOT INFERRED ────────────────────────────────────
 *
 * §13: "Approvals show who, when and on what basis." So the sentence that
 * justified the approval is WRITTEN onto `invoice_approval_records.basis` at the
 * moment of the decision, rather than recomputed when somebody opens the screen
 * six months later. If the ladder is edited in between, the recomputed sentence
 * would describe a rule that did not exist when the approval was given — which
 * is exactly the kind of quiet restatement `report_snapshots` exists to prevent
 * on the Module 4 side.
 */

import { and, asc, eq } from "drizzle-orm";
import type { getDb } from "../../../db";
import { approvalRules, invoiceApprovalRecords, invoices, quotations } from "../../../db/schema";
import type { InvoiceDirection } from "./model";
import {
  approvalDecision,
  resolveApprovalBand,
  type ApprovalDecision,
  type ApprovalRuleLike,
} from "./rules";

type Database = Awaited<ReturnType<typeof getDb>>;

/* Pure, re-exported — see the header of `./rules.ts`. */
export {
  approvalBasis,
  approvalDecision,
  resolveApprovalBand,
  type ApprovalDecision,
  type ApprovalRuleLike,
} from "./rules";

export interface ApprovalRuleRow extends ApprovalRuleLike {
  updatedByEmail: string | null;
}

export interface ApprovalRecordRow {
  id: string;
  invoiceId: string;
  approverEmail: string;
  approverUserId: string | null;
  decision: string;
  basis: string | null;
  ruleId: string | null;
  createdAt: string;
}

/** Every band for a workspace, in ladder order. */
export async function listApprovalRules(
  db: Database,
  organisationId: string,
): Promise<ApprovalRuleRow[]> {
  const rows = await db
    .select()
    .from(approvalRules)
    .where(eq(approvalRules.organisationId, organisationId))
    .orderBy(asc(approvalRules.sortOrder), asc(approvalRules.minAmountPence));
  return rows.map((row) => ({
    id: row.id,
    direction: row.direction,
    minAmountPence: row.minAmountPence,
    maxAmountPence: row.maxAmountPence ?? null,
    approversRequired: row.approversRequired,
    requiresClient: Boolean(row.requiresClient),
    makerCheckerFromPence: row.makerCheckerFromPence ?? null,
    active: Boolean(row.active),
    sortOrder: row.sortOrder,
    updatedByEmail: row.updatedByEmail ?? null,
  }));
}

/** Every decision already recorded against one invoice, oldest first. */
export async function listApprovals(
  db: Database,
  organisationId: string,
  invoiceId: string,
): Promise<ApprovalRecordRow[]> {
  const rows = await db
    .select()
    .from(invoiceApprovalRecords)
    .where(
      and(
        eq(invoiceApprovalRecords.organisationId, organisationId),
        eq(invoiceApprovalRecords.invoiceId, invoiceId),
      ),
    )
    .orderBy(asc(invoiceApprovalRecords.createdAt));
  return rows.map((row) => ({
    id: row.id,
    invoiceId: row.invoiceId,
    approverEmail: row.approverEmail,
    approverUserId: row.approverUserId ?? null,
    decision: row.decision,
    basis: row.basis ?? null,
    ruleId: row.ruleId ?? null,
    createdAt: row.createdAt,
  }));
}

export type ApprovalAssessment =
  | { ok: false; error: string; band: ApprovalRuleRow | null; decision: ApprovalDecision | null }
  | { ok: true; band: ApprovalRuleRow; decision: ApprovalDecision };

/**
 * Whether this actor may approve this invoice, right now.
 *
 * THE AMOUNT THE BAND IS RESOLVED AGAINST IS THE GROSS, falling back to the net
 * — because a band is a spending authority and what leaves the bank is the
 * gross. Comparing net would let a £4,900 net invoice with VAT on top settle
 * under a £5,000 threshold that £5,880 plainly clears.
 *
 * Reads the quote's approver, so that maker/checker has something to compare
 * against; an invoice with no quote simply cannot trip that control, which is
 * correct — there is no quote approval to have been the same person's.
 */
export async function canApprove(
  db: Database,
  organisationId: string,
  invoiceId: string,
  actorEmail: string,
): Promise<ApprovalAssessment> {
  const [invoice] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.id, invoiceId)))
    .limit(1);
  if (!invoice) {
    return { ok: false, error: "That invoice does not exist.", band: null, decision: null };
  }

  const direction: InvoiceDirection = invoice.direction === "receivable" ? "receivable" : "payable";
  const amount = authorisedAmount(invoice.grossPence, invoice.netPence);
  const rules = await listApprovalRules(db, organisationId);
  const band = resolveApprovalBand(rules, direction, amount);
  if (!band) {
    return {
      ok: false,
      error:
        "No approval band covers this amount. Somebody has edited the approval ladder into a gap — "
        + "fix the bands in settings rather than approving around them.",
      band: null,
      decision: null,
    };
  }

  const quote = invoice.quoteId ? await readQuote(db, organisationId, invoice.quoteId) : null;
  const approvals = await listApprovals(db, organisationId, invoiceId);
  const decision = approvalDecision({
    band,
    amountPence: amount,
    approvedBy: approvals.filter((row) => row.decision === "approved").map((row) => row.approverEmail),
    actorEmail,
    quoteApprovedBy: quote?.approvedBy ?? null,
    clientSignedOff: Boolean(quote?.clientApprovedBy && quote?.clientApprovedAt),
  });

  if (!decision.allowed) {
    return { ok: false, error: decision.refusal ?? "This approval is not permitted.", band, decision };
  }
  return { ok: true, band, decision };
}

/**
 * Write one approver's decision.
 *
 * The UNIQUE index on `(invoice_id, approver_email)` is the backstop; `canApprove`
 * is what turns a second attempt by the same person into a sentence rather than
 * a 503. Both exist on purpose — the index is what proves the rule held, the
 * check is what makes it readable.
 */
export async function recordApproval(
  db: Database,
  organisationId: string,
  input: {
    invoiceId: string;
    approverEmail: string;
    approverUserId: string | null;
    decision: "approved" | "rejected" | "client_signed_off";
    basis: string;
    ruleId: string | null;
    now?: Date;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(invoiceApprovalRecords).values({
    id,
    organisationId,
    invoiceId: input.invoiceId,
    approverEmail: input.approverEmail.trim().toLowerCase(),
    approverUserId: input.approverUserId,
    decision: input.decision,
    basis: input.basis.slice(0, 400),
    ruleId: input.ruleId,
    createdAt: (input.now ?? new Date()).toISOString(),
  });
  return id;
}

/**
 * How many more approvers this invoice still needs, and whether it is satisfied.
 *
 * Read from the rows rather than from a counter on the invoice: a counter is a
 * stored aggregate and drifts for the same reason a stored balance does.
 */
export async function approvalProgress(
  db: Database,
  organisationId: string,
  invoiceId: string,
): Promise<{ required: number; held: number; satisfied: boolean; band: ApprovalRuleRow | null }> {
  const [invoice] = await db
    .select({
      direction: invoices.direction,
      grossPence: invoices.grossPence,
      netPence: invoices.netPence,
    })
    .from(invoices)
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.id, invoiceId)))
    .limit(1);
  if (!invoice) return { required: 0, held: 0, satisfied: false, band: null };

  const direction: InvoiceDirection = invoice.direction === "receivable" ? "receivable" : "payable";
  const amount = authorisedAmount(invoice.grossPence, invoice.netPence);
  const band = resolveApprovalBand(await listApprovalRules(db, organisationId), direction, amount);
  const approvals = await listApprovals(db, organisationId, invoiceId);
  const held = approvals.filter((row) => row.decision === "approved").length;
  const required = band ? Math.max(0, band.approversRequired) : 1;
  return { required, held, satisfied: held >= required, band };
}

/**
 * THE FIGURE A BAND IS RESOLVED AGAINST — the gross, falling back to the net.
 *
 * A band is a spending authority and what leaves the bank is the gross.
 * Resolving on the net would let a £4,900 net invoice settle under a £5,000
 * threshold that £5,880 plainly clears, which is the one direction this must
 * not be wrong in.
 *
 * Deliberately NOT `comparableAmount` from `./rules.ts`: that one prefers the
 * NET, because it exists to compare an invoice against a quote where VAT is a
 * pass-through neither side chose. Two questions, two answers, and conflating
 * them would silently move every VAT-bearing invoice down a band.
 */
function authorisedAmount(grossPence: number | null, netPence: number | null): number {
  if (typeof grossPence === "number" && Number.isFinite(grossPence)) return Math.trunc(grossPence);
  if (typeof netPence === "number" && Number.isFinite(netPence)) return Math.trunc(netPence);
  return 0;
}

async function readQuote(db: Database, organisationId: string, quoteId: string) {
  const rows = await db
    .select({
      id: quotations.id,
      approvedBy: quotations.approvedBy,
      clientApprovedBy: quotations.clientApprovedBy,
      clientApprovedAt: quotations.clientApprovedAt,
    })
    .from(quotations)
    .where(and(eq(quotations.organisationId, organisationId), eq(quotations.id, quoteId)))
    .limit(1);
  return rows[0] ?? null;
}
