/**
 * `/api/finance/invoices/[id]/flags` — read the §7 findings, waive or clear one.
 *
 * ── A WAIVER NEEDS A TYPED REASON, AND THERE IS NO PATH WITHOUT ONE ────────
 *
 * §7: flags "block Approved for payment until cleared or waived with a typed
 * reason". A waiver is the one action in this whole module that lets money past
 * a control the match engine raised — a possible duplicate payment, an invoice
 * over the price that was agreed. So it records WHO, WHEN and WHY, and the
 * reason is refused if it is missing, blank, or shorter than a sentence anybody
 * could act on. "ok" is not a reason.
 *
 * It is `settings.edit`, not `board.edit`, deliberately: the person who enters
 * an invoice should not also be the person who overrules the objection to it.
 * That is §13's maker/checker instinct, expressed as a capability.
 *
 * ── WAIVE AND CLEAR ARE DIFFERENT STATEMENTS ───────────────────────────────
 *
 *   CLEAR  — "the cause is gone." Usually the engine's own doing on a rematch;
 *            by hand it means the underlying data has been corrected.
 *   WAIVE  — "the cause is real and I accept it anyway."
 *
 * Conflating them would lose the second, which is the only one that needs a
 * person's name on it. Nothing here DELETES a flag row, ever.
 */

import { auditActor, recordAudit } from "../../../../../lib/audit";
import {
  financeBadRequest,
  financeConflict,
  financeNotFound,
  financeUnavailable,
  guardFinance,
} from "../../../../../lib/finance/access";
import { note, readBody, text } from "../../../../../lib/finance/input";
import { listFlags, setFlagStatus } from "../../../../../lib/finance/matching";
import { readInvoice } from "../../../../../lib/finance/repository";

export const dynamic = "force-dynamic";

/** Shortest reason that says anything. "ok" and "n/a" are not reasons. */
const MIN_REASON = 8;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const guarded = await guardFinance(request, "ledger.read");
    if (guarded.denied) return guarded.denied;
    const { db, orgId } = guarded.scope;
    const invoice = await readInvoice(db, orgId, id);
    if (!invoice) return financeNotFound("That invoice does not exist.");
    return Response.json({ flags: await listFlags(db, orgId, id) });
  } catch (error) {
    return financeUnavailable(error, "The flags could not be read.");
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await readBody(request);
    if (!body) return financeBadRequest("Send a JSON body.");
    const action = body.action === "waive" ? "waive" : body.action === "clear" ? "clear" : null;
    if (!action) return financeBadRequest('`action` must be "waive" or "clear".');

    const guarded = await guardFinance(request, "flag.waive");
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;

    const flagId = text(body.flagId, 120);
    if (!flagId) return financeBadRequest("Name the flag to act on.");

    const invoice = await readInvoice(scope.db, scope.orgId, id);
    if (!invoice) return financeNotFound("That invoice does not exist.");

    const flags = await listFlags(scope.db, scope.orgId, id);
    const flag = flags.find((row) => row.id === flagId);
    if (!flag) return financeNotFound("That flag is not on this invoice.");
    if (flag.status === "waived" && action === "waive") {
      return financeConflict(
        `That flag was already waived by ${flag.waivedBy ?? "somebody"}: ${flag.waiveReason ?? "no reason recorded"}.`,
      );
    }

    const reason = note(body.reason, 400);
    if (action === "waive" && (!reason || reason.length < MIN_REASON)) {
      return financeBadRequest(
        "Waiving a flag needs a typed reason of at least a few words. It is recorded against the "
          + "invoice with your name and the time, and it is what somebody reads when they ask why "
          + "this was paid.",
      );
    }

    const updated = await setFlagStatus(scope.db, scope.orgId, flagId, action, {
      reason,
      actorEmail: scope.identityEmail,
    });
    if (!updated) return financeConflict("That flag could not be updated.");

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: action === "waive" ? "finance.flag_waived" : "finance.flag_cleared",
      entityType: "invoice",
      entityId: id,
      summary:
        action === "waive"
          ? `Waived the ${flag.flagType} flag on ${invoice.internalRef ?? id}. Reason: ${reason}`
          : `Cleared the ${flag.flagType} flag on ${invoice.internalRef ?? id} by hand.`,
      detail: { flagId, flagType: flag.flagType, previousStatus: flag.status, reason },
      request,
    });

    return Response.json({ flag: updated, flags: await listFlags(scope.db, scope.orgId, id) });
  } catch (error) {
    return financeUnavailable(error, "The flag could not be updated.");
  }
}
