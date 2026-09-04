/**
 * `/api/reports/sla-rules` — the target working days per classification.
 *
 * ── NOTHING IS SEEDED, AND THAT IS THE FEATURE ─────────────────────────────
 *
 * A workspace starts with no rules at all. A seeded target is indistinguishable
 * on screen from an agreed contractual term, and a client shown "94% within
 * SLA" against numbers nobody agreed is being told something false with a chart
 * behind it. Until an Administrator enters the terms, every job is EXCLUDED
 * from the measurement with the reason recorded, and the report says so.
 *
 * ── A CHANGED TARGET IS A NEW VERSION ──────────────────────────────────────
 *
 * `upsertSlaRule` bumps `version` whenever the number moves, and the version
 * fingerprint travels into `report_snapshots.sla_rules_version` at
 * finalisation. A report finalised in March can therefore say which targets it
 * was measured against, months after they were changed.
 */

import { auditActor, changeDetail, recordAudit } from "../../../lib/audit";
import { listSlaRules, upsertSlaRule } from "../../../lib/billing/repository";
import { REPORT_CAPABILITIES } from "../../../lib/reporting/access";
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
    const guarded = await guard(request, REPORT_CAPABILITIES["sla.read"]);
    if (guarded.denied) return guarded.denied;
    const rules = await listSlaRules(guarded.scope.db, guarded.scope.orgId);
    return Response.json({
      rules,
      /* Said out loud in the response, not only in the UI: a caller that gets an
         empty list must be able to tell "none configured" from "none returned". */
      seeded: false,
      note:
        rules.length === 0
          ? "No SLA rules are configured. Until they are, every job is excluded from the SLA measurement and no performance figure is stated."
          : null,
    });
  } catch (error) {
    return reportUnavailable(error);
  }
}

export async function POST(request: Request) {
  try {
    const guarded = await guard(request, REPORT_CAPABILITIES["sla.write"]);
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return badRequest("Send a JSON body.");

    const classification = text(body.classification, 120);
    if (!classification) return badRequest("A classification is required.");
    const target = pence(body.targetWorkingDays);
    if (target === null || target < 0 || target > 365) {
      return badRequest("The target must be a whole number of working days between 0 and 365.");
    }

    const result = await upsertSlaRule(
      scope.db,
      scope.orgId,
      {
        classification,
        targetWorkingDays: target,
        note: text(body.note, 400),
        active: body.active === undefined ? true : Boolean(body.active),
      },
      scope.identityEmail,
    );

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "billing.sla_rule_changed",
      entityType: "sla_rule",
      entityId: result.id,
      summary: `Set the SLA target for "${classification}" to ${target} working days (version ${result.version}).`,
      detail: changeDetail(
        result.previous as unknown as Record<string, unknown> | null,
        { classification, targetWorkingDays: target, version: result.version },
      ),
      request,
    });

    const rules = await listSlaRules(scope.db, scope.orgId);
    return Response.json({ rules, id: result.id, version: result.version }, { status: 201 });
  } catch (error) {
    return reportUnavailable(error);
  }
}

/** Deactivating is the only "delete" — a retired rule still explains old reports. */
export async function PATCH(request: Request) {
  try {
    const guarded = await guard(request, REPORT_CAPABILITIES["sla.write"]);
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return badRequest("Send a JSON body.");

    const classification = text(body.classification, 120);
    if (!classification) return badRequest("Name the classification to change.");
    const rules = await listSlaRules(scope.db, scope.orgId);
    const existing = rules.find((rule) => rule.classification === classification);
    if (!existing) return badRequest("There is no rule for that classification.");

    const active = body.active === undefined ? existing.active : Boolean(body.active);
    const result = await upsertSlaRule(
      scope.db,
      scope.orgId,
      {
        classification,
        targetWorkingDays: pence(body.targetWorkingDays) ?? existing.targetWorkingDays,
        note: body.note === undefined ? existing.note : text(body.note, 400),
        active,
      },
      scope.identityEmail,
    );

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "billing.sla_rule_changed",
      entityType: "sla_rule",
      entityId: result.id,
      summary: `${active ? "Updated" : "Deactivated"} the SLA rule for "${classification}".`,
      detail: changeDetail(existing as unknown as Record<string, unknown>, { active, version: result.version }),
      request,
    });

    return Response.json({ rules: await listSlaRules(scope.db, scope.orgId) });
  } catch (error) {
    return reportUnavailable(error);
  }
}
