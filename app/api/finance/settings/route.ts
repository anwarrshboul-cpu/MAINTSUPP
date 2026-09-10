/**
 * `/api/finance/settings` — §7's tolerances, §13's approval bands, §5's status
 * map, and the workspace's bank accounts.
 *
 * ── BANK DETAILS ARE THE SHARP EDGE HERE ──────────────────────────────────
 *
 * §16: "Bank details appear only in settings, never in code." This repository
 * is public, and `contractors` deliberately carries no account number at all
 * for that reason. These are the WORKSPACE's own accounts — the ones a payment
 * run debits — typed by an administrator into a form.
 *
 * A "bank account" here carries NO PAYMENT CREDENTIAL. It is a label somebody
 * recognises, the account name, and the reference that finds it in the
 * accounting system — enough to say which account a payment run is drawn on,
 * and nothing anybody could pay from.
 *
 * This route did hold a masked sort code, account number and IBAN for one
 * commit, behind `billing.manage`. The mask worked, and an independent review
 * proved it — but W06-09 is an owner-approved decision that predates Module 5:
 * "the owner-approved payment model is TERMS plus an EXTERNAL accounting
 * reference, and it is approved precisely because the alternative — a bank
 * account number, a sort code, an IBAN or a card detail on a maintenance
 * portal — is a breach waiting for its first misconfigured backup. The
 * accounting system that already holds those is built for them." This
 * repository is public. Not holding the digits beats masking them.
 *
 * §16 asks for bank details in settings and this is the safe reading of it,
 * recorded as a deliberate divergence rather than a gap. The payment-run export
 * already returns empty payee columns and says so in its own header; this is
 * the same decision, one table earlier.
 *
 * EDITING these rows is still `billing.manage`, which the built-in defaults
 * grant to `super_admin` alone. Everything else on this screen is
 * `settings.edit`.
 */

import { and, asc, eq } from "drizzle-orm";
import { auditActor, recordAudit } from "../../../lib/audit";
import { can } from "../../../lib/permissions";
import {
  financeBadRequest,
  financeUnavailable,
  guardFinance,
} from "../../../lib/finance/access";
import { readFinanceSettings } from "../../../lib/finance/settings";
import { approvalRules, paymentSources, invoiceStatusMap } from "../../../../db/schema";
import type { ScopedDatabase } from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";


async function payload(scope: ScopedDatabase, unmasked: boolean) {
  const { db, orgId } = scope;
  const [settings, rules, statuses, accounts] = await Promise.all([
    readFinanceSettings(db, orgId),
    db
      .select()
      .from(approvalRules)
      .where(eq(approvalRules.organisationId, orgId))
      .orderBy(asc(approvalRules.sortOrder), asc(approvalRules.minAmountPence)),
    db
      .select()
      .from(invoiceStatusMap)
      .where(eq(invoiceStatusMap.organisationId, orgId))
      .orderBy(asc(invoiceStatusMap.direction), asc(invoiceStatusMap.sortOrder)),
    db
      .select()
      .from(paymentSources)
      .where(eq(paymentSources.organisationId, orgId))
      .orderBy(asc(paymentSources.label)),
  ]);

  return {
    settings,
    approvalRules: rules,
    statusMap: statuses,
    /*
     * THERE IS NOTHING LEFT TO MASK, AND THAT IS THE POINT.
     *
     * This route used to return a masked sort code, account number and IBAN,
     * with `canSeeBankDetails` deciding who saw the digits. The masking worked
     * — an independent review proved it — but the safer answer is not to hold
     * the digits at all: W06-09 is an owner-approved decision that this product
     * stores TERMS and an EXTERNAL accounting reference and never a payment
     * credential, "precisely because the alternative … is a breach waiting for
     * its first misconfigured backup". This repository is public.
     *
     * `canSeeBankDetails` is kept because it still answers a real question —
     * whether this actor may EDIT the banking settings, which remains
     * `billing.manage` and therefore `super_admin` alone — and because the UI
     * uses it to explain a read-only form rather than drawing fields that will
     * refuse to save.
     */
    canSeeBankDetails: unmasked,
    paymentSources: accounts.map((account) => ({
      id: account.id,
      label: account.label,
      accountName: account.accountName,
      accountingReference: account.accountingReference,
      referencePrefix: account.referencePrefix,
      active: account.active,
    })),
  };
}

/**
 * Whether this actor may see and write real bank details.
 *
 * `capabilities: {}` because the per-role overrides are a workspace's own
 * `role_capabilities` rows and this route holds none: `can` then answers from
 * the built-in default, which grants `billing.manage` to `super_admin` alone.
 * That is the intended reading — §16 puts bank details behind the narrowest
 * door the product has.
 */
function mayManageBanking(scope: ScopedDatabase): boolean {
  return can({ role: scope.actor.role, capabilities: {} }, "billing.manage");
}

export async function GET(request: Request) {
  try {
    const guard = await guardFinance(request, "ledger.read");
    if (guard.denied) return guard.denied;
    return Response.json(await payload(guard.scope, mayManageBanking(guard.scope)));
  } catch (error) {
    return financeUnavailable(error, "Finance settings could not be read.");
  }
}

export async function PUT(request: Request) {
  try {
    const guard = await guardFinance(request, "invoice.approve");
    if (guard.denied) return guard.denied;
    const scope = guard.scope;
    const { db, orgId } = scope;

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return financeBadRequest("Send a JSON body.");

    const account = body.paymentSource as Record<string, unknown> | undefined;
    if (account && !mayManageBanking(scope)) {
      /*
       * 403 rather than a silent skip. A form that appears to save a sort code
       * and does not is worse than one that refuses: the reader walks away
       * believing the payment run will debit an account it will not.
       */
      return Response.json(
        { error: "Only a workspace owner may change bank details." },
        { status: 403 },
      );
    }

    if (account) {
      const label = String(account.label ?? "").trim().slice(0, 120);
      if (!label) return financeBadRequest("A bank account needs a label.");
      const id = typeof account.id === "string" && account.id ? account.id : `bank_${crypto.randomUUID()}`;
      const values = {
        label,
        accountName: text(account.accountName, 160),
        /*
         * NO CREDENTIAL IS ACCEPTED. `bankName`, `sortCode`, `accountNumber`
         * and `iban` were written here for one commit and are gone: W06-09 is
         * an owner-approved decision that this product stores terms and an
         * external accounting reference and never a payment credential. A
         * caller may still SEND those keys; they are ignored rather than
         * stored, which is the same shape as every other unknown field on this
         * body.
         */
        accountingReference: text(account.accountingReference, 120),
        referencePrefix: text(account.referencePrefix, 20),
        active: account.active !== false,
        updatedByEmail: scope.identityEmail,
      };
      const existing = await db
        .select({ id: paymentSources.id })
        .from(paymentSources)
        .where(and(eq(paymentSources.organisationId, orgId), eq(paymentSources.id, id)))
        .limit(1);
      if (existing[0]) {
        await db.update(paymentSources).set(values).where(eq(paymentSources.id, existing[0].id));
      } else {
        await db.insert(paymentSources).values({ id, organisationId: orgId, ...values });
      }
      await recordAudit({
        db,
        organisationId: orgId,
        actor: auditActor(scope),
        action: "finance.payment_source_saved",
        entityType: "payment_source",
        entityId: id,
        /* The LABEL, never the number. An audit trail that recorded the digits
           would be a second place they live. */
        summary: `Saved the bank account "${label}".`,
        detail: { label, active: values.active },
        request,
      });
    }

    const rules = Array.isArray(body.approvalRules) ? body.approvalRules : null;
    if (rules) {
      for (const raw of rules as Array<Record<string, unknown>>) {
        const id = String(raw.id ?? "").trim();
        if (!id) continue;
        const approvers = Number(raw.approversRequired);
        if (!Number.isInteger(approvers) || approvers < 0 || approvers > 5) {
          return financeBadRequest("A band needs between 0 and 5 approvers.");
        }
        await db
          .update(approvalRules)
          .set({
            approversRequired: approvers,
            requiresClient: raw.requiresClient === true,
            active: raw.active !== false,
            updatedByEmail: scope.identityEmail,
          })
          .where(and(eq(approvalRules.organisationId, orgId), eq(approvalRules.id, id)));
      }
      await recordAudit({
        db,
        organisationId: orgId,
        actor: auditActor(scope),
        action: "finance.approval_rules_saved",
        entityType: "approval_rules",
        entityId: orgId,
        summary: `Saved ${rules.length} approval band${rules.length === 1 ? "" : "s"}.`,
        detail: { bands: rules.length },
        request,
      });
    }

    const statuses = Array.isArray(body.statusMap) ? body.statusMap : null;
    if (statuses) {
      for (const raw of statuses as Array<Record<string, unknown>>) {
        const id = String(raw.id ?? "").trim();
        if (!id) continue;
        await db
          .update(invoiceStatusMap)
          .set({
            displayLabel: String(raw.displayLabel ?? "").trim().slice(0, 80) || "Untitled",
            colourHex: /^#[0-9a-fA-F]{6}$/.test(String(raw.colourHex ?? ""))
              ? String(raw.colourHex)
              : undefined,
            countsAsOpen: raw.countsAsOpen !== false,
            active: raw.active !== false,
            updatedByEmail: scope.identityEmail,
          })
          .where(and(eq(invoiceStatusMap.organisationId, orgId), eq(invoiceStatusMap.id, id)));
      }
    }

    return Response.json(await payload(scope, mayManageBanking(scope)));
  } catch (error) {
    return financeUnavailable(error, "Finance settings could not be saved.");
  }
}

function text(value: unknown, max: number): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed.slice(0, max) : null;
}
