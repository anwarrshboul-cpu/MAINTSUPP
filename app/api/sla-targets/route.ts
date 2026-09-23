/**
 * `GET|PUT /api/sla-targets` — the Overview's SLA compliance targets.
 *
 * Dashboard §4.4: targets "live in a config table, not in code … editable in
 * Settings by owner/admin and versioned, so changing a target does not silently
 * rewrite past performance"; §9 item 25: "changing an SLA target in Settings
 * changes the chart with no deploy and does not rewrite historical records".
 * The owner's decision of 2026-09-23 is which target: the percentage the live
 * gauge and the per-priority bars are held to. See
 * `app/lib/sla-compliance-targets.ts` for the model and the versioning.
 *
 *   GET  `board.view`    — the targets in effect, whether each is the shipped
 *                          default or this workspace's own, the version history,
 *                          and whether the caller may edit. Anyone who can see
 *                          the card may see what it is measured against.
 *   PUT  `settings.edit` — owner and admin, per §4.4. Each changed key becomes a
 *                          new version; nothing is overwritten. Audited.
 *
 * WORKSPACE-SCOPED through `scopedDbWithCapability`: the organisation is the
 * caller's own, and no id in the body can name another. Site restrictions do not
 * apply — a target is the workspace's promise, not a store's data.
 */

import { ensureDatabase } from "../../../db/init";
import { auditActor, recordAudit } from "../../lib/audit";
import { can, resolvePermissions } from "../../lib/permissions";
import {
  SLA_TARGET_DEFAULT_PERCENT,
  SLA_TARGET_KEYS,
  SLA_TARGET_MAX_PERCENT,
  SLA_TARGET_MIN_PERCENT,
  parseSlaTargetInput,
  readSlaComplianceTargets,
  saveSlaComplianceTargets,
  slaComplianceTargetHistory,
} from "../../lib/sla-compliance-targets";
import { anonymousRefusal, busyRefusal, scopedDbWithCapability } from "../../lib/tenant-db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guarded = await scopedDbWithCapability(request, "board.view");
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    const subject = await resolvePermissions(scope.db, scope.orgId, scope.actor.role, scope.siteScope);
    const [targets, history] = await Promise.all([
      readSlaComplianceTargets(scope.db, scope.orgId),
      slaComplianceTargetHistory(scope.db, scope.orgId),
    ]);
    return Response.json({
      targets,
      history,
      keys: SLA_TARGET_KEYS,
      defaultPercent: SLA_TARGET_DEFAULT_PERCENT,
      range: { min: SLA_TARGET_MIN_PERCENT, max: SLA_TARGET_MAX_PERCENT },
      canEdit: can(subject, "settings.edit"),
    });
  } catch (error) {
    return failure(error, "The SLA targets could not be read.");
  }
}

export async function PUT(request: Request) {
  try {
    await ensureDatabase();
    const guarded = await scopedDbWithCapability(request, "settings.edit");
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;

    const body = (await request.json().catch(() => null)) as { targets?: unknown; note?: unknown } | null;
    const parsed = parseSlaTargetInput(body?.targets);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    const note = typeof body?.note === "string" ? body.note.trim().slice(0, 300) || null : null;

    const actor = scope.identityEmail.toLowerCase();
    const at = new Date().toISOString();
    let saved;
    try {
      saved = await saveSlaComplianceTargets(scope.db, scope.orgId, parsed.values, actor, at, note);
    } catch (error) {
      /* `sla_targets_current_idx`: somebody else saved the same key between our
         read and our write, and the whole batch rolled back. Nothing changed. */
      if (/unique|duplicate key|sla_targets_current_idx/i.test(String((error as Error)?.message ?? ""))) {
        return Response.json(
          { error: "Somebody else changed these targets a moment ago. Reload to see theirs, then save again." },
          { status: 409 },
        );
      }
      throw error;
    }

    if (saved.changes.length > 0) {
      await recordAudit({
        db: scope.db,
        organisationId: scope.orgId,
        actor: auditActor(scope),
        action: "sla_targets.updated",
        entityType: "sla_targets",
        entityId: "compliance",
        summary: `Changed the SLA compliance targets: ${saved.changes
          .map((change) => `${change.key} ${change.from}% → ${change.to}% (v${change.version})`)
          .join(", ")}.`,
        detail: { changes: saved.changes, note },
        request,
      });
    }

    return Response.json({
      ok: true,
      changes: saved.changes,
      targets: saved.targets,
      history: await slaComplianceTargetHistory(scope.db, scope.orgId),
    });
  } catch (error) {
    return failure(error, "The SLA targets could not be saved.");
  }
}

function failure(error: unknown, consequence: string): Response {
  const anonymous = anonymousRefusal(error);
  if (anonymous) return anonymous;
  const busy = busyRefusal(error, consequence);
  if (busy) return busy;
  console.error("[/api/sla-targets]", error);
  if (error instanceof Error && error.cause) {
    console.error("[/api/sla-targets] cause:", error.cause);
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return Response.json(
    {
      error: process.env.NODE_ENV === "development" ? `${consequence} ${message}` : consequence,
    },
    { status: 503 },
  );
}
