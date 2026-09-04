/**
 * `/api/reports/fees` — the client fee schedule and the per-site overrides.
 *
 * ── A FEE IS APPENDED, NEVER EDITED ────────────────────────────────────────
 *
 * There is no PUT here and no way to change `fee_pence` on an existing row.
 * A fee row records what a site cost between two dates; editing one in place
 * would restate every invoice priced from it, including ones already sent.
 *
 * A change is therefore two calls: PATCH to close the current row on a date,
 * POST to open the new one. The UI can make that one button; the API keeps them
 * separate so that the audit trail records both halves and so that a partial
 * failure leaves a closed row rather than a silently rewritten one.
 */

import {
  addClientFee,
  addSiteOverride,
  closeFee,
  listClientFees,
  listSiteOverrides,
} from "../../../lib/billing/repository";
import { auditActor, recordAudit } from "../../../lib/audit";
import { REPORT_CAPABILITIES } from "../../../lib/reporting/access";
import { dateOnly } from "../../../lib/reporting/period";
import {
  badRequest,
  guard,
  pence,
  reportUnavailable,
  text,
} from "../../../lib/reporting/route-helpers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const guarded = await guard(request, REPORT_CAPABILITIES["fees.read"]);
    if (guarded.denied) return guarded.denied;
    const { db, orgId } = guarded.scope;
    const [clientFees, siteOverrides] = await Promise.all([
      listClientFees(db, orgId),
      listSiteOverrides(db, orgId),
    ]);
    return Response.json({ clientFees, siteOverrides });
  } catch (error) {
    return reportUnavailable(error);
  }
}

export async function POST(request: Request) {
  try {
    const guarded = await guard(request, REPORT_CAPABILITIES["fees.write"]);
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return badRequest("Send a JSON body.");

    const amount = pence(body.feePence);
    if (amount === null || amount < 0) return badRequest("A fee must be a whole number of pence, zero or more.");

    /* Open-ended in either direction is legitimate and is how a current fee is
       stored. An unreadable date is not — it would silently become open-ended,
       and an open-ended fee prices every period. */
    const effectiveFrom = body.effectiveFrom === null || body.effectiveFrom === undefined
      ? null
      : dateOnly(String(body.effectiveFrom));
    const effectiveTo = body.effectiveTo === null || body.effectiveTo === undefined
      ? null
      : dateOnly(String(body.effectiveTo));
    if (body.effectiveFrom && !effectiveFrom) return badRequest("The effective-from date must be YYYY-MM-DD.");
    if (body.effectiveTo && !effectiveTo) return badRequest("The effective-to date must be YYYY-MM-DD.");
    if (effectiveFrom && effectiveTo && effectiveFrom > effectiveTo) {
      return badRequest("The effective-from date is after the effective-to date.");
    }

    const note = text(body.note, 400);
    const siteId = text(body.siteId, 120);
    const fee = { feePence: amount, effectiveFrom, effectiveTo, note };

    const id = siteId
      ? await addSiteOverride(scope.db, scope.orgId, siteId, fee, scope.identityEmail)
      : await addClientFee(scope.db, scope.orgId, fee, scope.identityEmail);

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "billing.fee_added",
      entityType: siteId ? "site_fee_override" : "client_site_fee",
      entityId: id,
      summary: siteId
        ? `Added a site fee override of ${amount}p for site ${siteId}.`
        : `Added a client site fee of ${amount}p.`,
      detail: { siteId, ...fee },
      request,
    });

    return Response.json({ id, kind: siteId ? "site" : "client" }, { status: 201 });
  } catch (error) {
    return reportUnavailable(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const guarded = await guard(request, REPORT_CAPABILITIES["fees.write"]);
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return badRequest("Send a JSON body.");

    const id = text(body.id, 120);
    if (!id) return badRequest("Name the fee row to close.");
    const kind = body.kind === "site" ? "site" : body.kind === "client" ? "client" : null;
    if (!kind) return badRequest('`kind` must be "client" or "site".');

    const effectiveTo = body.effectiveTo === null ? null : dateOnly(String(body.effectiveTo ?? ""));
    if (body.effectiveTo !== null && !effectiveTo) {
      return badRequest("The effective-to date must be YYYY-MM-DD, or null to reopen the row.");
    }

    const closed = await closeFee(scope.db, scope.orgId, kind, id, effectiveTo);
    if (!closed) return badRequest("That fee row does not belong to this workspace.");

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "billing.fee_closed",
      entityType: kind === "site" ? "site_fee_override" : "client_site_fee",
      entityId: id,
      summary: effectiveTo
        ? `Closed a ${kind} fee row on ${effectiveTo}.`
        : `Reopened a ${kind} fee row.`,
      detail: { id, kind, effectiveTo },
      request,
    });

    return Response.json({ id, effectiveTo });
  } catch (error) {
    return reportUnavailable(error);
  }
}
