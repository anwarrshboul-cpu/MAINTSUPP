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
 * They are MASKED for anyone without `billing.manage`. Not omitted: a reader
 * who may plan a payment run needs to see which account it will come from, and
 * a list of blank rows would make that impossible. What they see is the label,
 * the bank and the last four digits, which identifies the account without
 * carrying enough to move money.
 *
 * The unmasked values are returned only to `billing.manage`, and only that
 * capability may write them. Everything else on this screen is `settings.edit`.
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
import { approvalRules, bankAccounts, invoiceStatusMap } from "../../../../db/schema";
import type { ScopedDatabase } from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

/**
 * Last four digits only, and only where there are more than four to hide.
 *
 * A three-digit account number is not a real one, and masking it to `••••` and
 * then showing nothing would leave a reader unable to tell a typo from a
 * redaction.
 */
function mask(value: string | null): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  if (text.length <= 4) return "••••";
  return `••••${text.slice(-4)}`;
}

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
      .from(bankAccounts)
      .where(eq(bankAccounts.organisationId, orgId))
      .orderBy(asc(bankAccounts.label)),
  ]);

  return {
    settings,
    approvalRules: rules,
    statusMap: statuses,
    /** `canSeeBankDetails` is stated so the UI can explain a mask rather than
        drawing an empty field somebody will try to fill in. */
    canSeeBankDetails: unmasked,
    bankAccounts: accounts.map((account) => ({
      id: account.id,
      label: account.label,
      accountName: account.accountName,
      bankName: account.bankName,
      referencePrefix: account.referencePrefix,
      active: account.active,
      sortCode: unmasked ? account.sortCode : mask(account.sortCode),
      accountNumber: unmasked ? account.accountNumber : mask(account.accountNumber),
      iban: unmasked ? account.iban : mask(account.iban),
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

    const account = body.bankAccount as Record<string, unknown> | undefined;
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
        bankName: text(account.bankName, 160),
        sortCode: text(account.sortCode, 20),
        accountNumber: text(account.accountNumber, 40),
        iban: text(account.iban, 60),
        referencePrefix: text(account.referencePrefix, 20),
        active: account.active !== false,
        updatedByEmail: scope.identityEmail,
      };
      const existing = await db
        .select({ id: bankAccounts.id })
        .from(bankAccounts)
        .where(and(eq(bankAccounts.organisationId, orgId), eq(bankAccounts.id, id)))
        .limit(1);
      if (existing[0]) {
        await db.update(bankAccounts).set(values).where(eq(bankAccounts.id, existing[0].id));
      } else {
        await db.insert(bankAccounts).values({ id, organisationId: orgId, ...values });
      }
      await recordAudit({
        db,
        organisationId: orgId,
        actor: auditActor(scope),
        action: "finance.bank_account_saved",
        entityType: "bank_account",
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
