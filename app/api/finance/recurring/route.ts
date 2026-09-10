/**
 * `/api/finance/recurring` — §15.13. "The monthly retainer generates on a
 * schedule rather than being remembered."
 *
 * A rule, not a generator. This route owns the SCHEDULE; the invoice it
 * eventually produces goes through the same `createInvoice` path every other
 * receivable does, because §12's "no re-entry, ever" and §15's "do not
 * duplicate invoice logic" are the same requirement seen from two sides.
 *
 * ── THE NEXT RUN IS STORED, NOT DERIVED ON READ ───────────────────────────
 *
 * `next_run_date` is a column so a cron can select on it with an index rather
 * than loading every rule and computing. The arithmetic that advances it is
 * `nextRunAfter` below, which is pure and tested across a month boundary — the
 * case that breaks naive date maths, because 31 January plus one month is not a
 * date and a rule set for the 31st must still fire in February.
 */

import { and, eq } from "drizzle-orm";
import { auditActor, recordAudit } from "../../../lib/audit";
import {
  financeBadRequest,
  financeNotFound,
  financeUnavailable,
  guardFinance,
} from "../../../lib/finance/access";
import { financeDay, penceFromInput } from "../../../lib/finance/model";
import { recurringInvoiceRules } from "../../../../db/schema";

export const dynamic = "force-dynamic";

const FREQUENCIES = ["monthly", "quarterly", "annually"] as const;
type Frequency = (typeof FREQUENCIES)[number];

const isFrequency = (value: unknown): value is Frequency =>
  typeof value === "string" && (FREQUENCIES as readonly string[]).includes(value);

/**
 * The next occurrence on or after `from`, clamped into the month.
 *
 * A rule set for the 31st fires on the 28th of February and on the 30th of
 * April — clamping to the month's last day rather than rolling into the next
 * month, which would move a January retainer into March.
 */
export function nextRunAfter(from: string, dayOfMonth: number, frequency: Frequency): string {
  const [year, month, day] = from.split("-").map(Number);
  const step = frequency === "monthly" ? 1 : frequency === "quarterly" ? 3 : 12;
  const wanted = Math.min(Math.max(1, Math.trunc(dayOfMonth) || 1), 31);

  const clamp = (y: number, m: number) => {
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const chosen = Math.min(wanted, lastDay);
    return `${y}-${String(m + 1).padStart(2, "0")}-${String(chosen).padStart(2, "0")}`;
  };

  /* This month's occurrence, if it has not already passed. */
  const thisMonth = clamp(year, month - 1);
  if (thisMonth >= `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`) {
    return thisMonth;
  }
  const next = new Date(Date.UTC(year, month - 1 + step, 1));
  return clamp(next.getUTCFullYear(), next.getUTCMonth());
}

export async function GET(request: Request) {
  try {
    const guard = await guardFinance(request, "ledger.read");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const rules = await db
      .select()
      .from(recurringInvoiceRules)
      .where(eq(recurringInvoiceRules.organisationId, orgId));
    return Response.json({
      frequencies: FREQUENCIES,
      today: financeDay(new Date()),
      rules: rules.sort((a, b) => (a.nextRunDate ?? "").localeCompare(b.nextRunDate ?? "")),
    });
  } catch (error) {
    return financeUnavailable(error, "Recurring rules could not be read.");
  }
}

export async function POST(request: Request) {
  try {
    const guard = await guardFinance(request, "ledger.write");
    if (guard.denied) return guard.denied;
    const scope = guard.scope;
    const { db, orgId } = scope;

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return financeBadRequest("Send a JSON body.");

    const frequency = isFrequency(body.frequency) ? body.frequency : "monthly";
    const dayOfMonth = Number(body.dayOfMonth ?? 1);
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
      return financeBadRequest("The day of the month must be between 1 and 31.");
    }
    const netPence = penceFromInput(body.netPence ?? body.net);
    if (netPence === null || netPence <= 0) {
      return financeBadRequest("A recurring rule needs an amount above zero.");
    }

    const today = financeDay(new Date());
    const id = `rec_${crypto.randomUUID()}`;
    const nextRunDate = nextRunAfter(today, dayOfMonth, frequency);

    await db.insert(recurringInvoiceRules).values({
      id,
      organisationId: orgId,
      direction: body.direction === "payable" ? "payable" : "receivable",
      counterpartyId: typeof body.counterpartyId === "string" ? body.counterpartyId : null,
      description: String(body.description ?? "").trim().slice(0, 300) || null,
      netPence,
      category: String(body.category ?? "").trim().slice(0, 60) || null,
      frequency,
      dayOfMonth,
      paymentTermsDays: Number.isInteger(body.paymentTermsDays)
        ? (body.paymentTermsDays as number)
        : null,
      nextRunDate,
      active: body.active !== false,
      createdBy: scope.identityEmail,
    });

    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor(scope),
      action: "finance.recurring_rule_created",
      entityType: "recurring_invoice_rule",
      entityId: id,
      summary: `Created a ${frequency} recurring invoice, next due ${nextRunDate}.`,
      detail: { frequency, dayOfMonth, netPence, nextRunDate },
      request,
    });

    return Response.json({ id, frequency, dayOfMonth, netPence, nextRunDate }, { status: 201 });
  } catch (error) {
    return financeUnavailable(error, "The recurring rule could not be saved.");
  }
}

export async function PATCH(request: Request) {
  try {
    const guard = await guardFinance(request, "ledger.write");
    if (guard.denied) return guard.denied;
    const scope = guard.scope;
    const { db, orgId } = scope;

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const id = String(body?.id ?? "").trim();
    if (!id) return financeBadRequest("Which rule?");

    const found = await db
      .select({ id: recurringInvoiceRules.id })
      .from(recurringInvoiceRules)
      .where(
        and(eq(recurringInvoiceRules.organisationId, orgId), eq(recurringInvoiceRules.id, id)),
      )
      .limit(1);
    if (!found[0]) return financeNotFound("That recurring rule does not exist.");

    await db
      .update(recurringInvoiceRules)
      .set({ active: body?.active !== false })
      .where(eq(recurringInvoiceRules.id, id));

    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor(scope),
      action: "finance.recurring_rule_updated",
      entityType: "recurring_invoice_rule",
      entityId: id,
      summary: `${body?.active !== false ? "Resumed" : "Paused"} a recurring invoice rule.`,
      detail: { active: body?.active !== false },
      request,
    });

    return Response.json({ id, active: body?.active !== false });
  } catch (error) {
    return financeUnavailable(error, "The recurring rule could not be updated.");
  }
}
