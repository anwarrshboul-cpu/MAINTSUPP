/**
 * `/api/finance/calendar` — §10's third source for the calendar feed.
 *
 * "No duplication — the invoice record stays the single source of truth." So
 * this endpoint derives chips from `invoices` and `quotations` on every read
 * rather than materialising calendar rows that would then have to be kept in
 * step with a due date somebody changed.
 *
 * EVERY CHIP CARRIES `draggable: false`, and it is a field rather than an
 * assumption the calendar makes about the source. §10: "Dragging is disabled
 * for invoice chips — a due date is contractual, not something to move by
 * accident." Rescheduling a PAYMENT is allowed and is a different act on a
 * different record, done from the finance panel.
 *
 * The overdue flag is an OVERLAY, not a status: §10 layers it over the status
 * colour rather than replacing it, so a chip that is late still says what it
 * is as well as that it is late.
 */

import { financeBadRequest, financeUnavailable, guardFinance } from "../../../lib/finance/access";
import { loadFinanceChips } from "../../../lib/finance/analytics";
import { financeDay, shiftDay } from "../../../lib/finance/model";

export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  try {
    const guard = await guardFinance(request, "ledger.read");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;

    const params = new URL(request.url).searchParams;
    const now = new Date();
    const today = financeDay(now);
    const from = params.get("from") ?? shiftDay(today, -31);
    const to = params.get("to") ?? shiftDay(today, 62);
    if (!DAY.test(from) || !DAY.test(to)) {
      return financeBadRequest("Send `from` and `to` as YYYY-MM-DD.");
    }
    if (from > to) return financeBadRequest("`from` must not be after `to`.");

    const chips = await loadFinanceChips(db, orgId, from, to, now);
    return Response.json({
      from,
      to,
      today,
      chips,
      /*
       * The layer defaults §10's table specifies. Sent with the payload rather
       * than hard-coded in the calendar, so a workspace that turns quote expiry
       * on keeps it on without this endpoint caring.
       */
      defaultLayers: {
        payable_due: true,
        receivable_due: true,
        quote_expiry: false,
        payment_scheduled: false,
      },
    });
  } catch (error) {
    return financeUnavailable(error, "Finance dates could not be read.");
  }
}
