/**
 * The portal module registry, read and write — Master Specification §19.
 *
 * WHO MAY READ THIS, AND WHY IT IS NARROWER THAN `/api/theme`
 *
 * Both are per-organisation presentation configuration, and the theme route
 * deliberately serves its GET to any member: the answer is what the page they
 * are already looking at is painted with, so withholding it would hide nothing.
 *
 * That argument does not carry over. Every member already learns their OWN
 * answer from `/api/context`, which lists the modules they may reach and nothing
 * else. This route answers a different question — the whole catalogue, including
 * which modules were switched off and which exist but are out of this reader's
 * reach — and the only thing that asks it is the Super Admin panel. So it is
 * `navigation.edit` on both verbs, which is where owner decision D1 put the
 * control, and the narrower answer stays the one every member gets.
 *
 * WHAT THIS ROUTE CANNOT DO
 *
 * It cannot switch off Overview or Settings. `isDisableableModule` decides that,
 * in `app/lib/portal-modules.ts` beside the catalogue rather than here, and
 * `writeModuleEnabled` checks it again — a workspace that switched off its own
 * Settings screen would have no way back to the switch, and a support call
 * nobody can resolve from inside the product is not a feature.
 *
 * It also cannot change which capability a module answers to. That is a code
 * constant, not a column an administrator may set, and the reason is in
 * `portal-modules.ts`: naming a capability a role may NEVER hold makes the
 * module permanently unreachable for that role, and `can()` consults the ceiling
 * before it reads any override, so no Super Admin could give it back. A settings
 * screen that can produce an irrecoverable state is worse than one switch fewer.
 */

import { ensureDatabase } from "../../../db/init";
import { auditActor, recordAudit } from "../../lib/audit";
import {
  effectiveCapabilities,
  requireCapability,
  resolvePermissions,
} from "../../lib/permissions";
import { anonymousRefusal, scopedDb } from "../../lib/tenant-db";
import {
  readModuleOverrides,
  writeModuleEnabled,
} from "../../lib/portal-module-repository.ts";
import {
  PORTAL_MODULES,
  portalModule,
  resolveModuleAccess,
  type ModuleOverrides,
} from "../../lib/portal-modules.ts";
import type { WorkspaceRole } from "../../lib/roles";
import {
  modulesRestoreSwitches,
  modulesSnapshot,
  restoreVersionFrom,
  summariseChange,
  type ModulesSnapshot,
} from "../../lib/config-versions-model.ts";
import {
  ensureConfigBaseline,
  latestSnapshot,
  loadRestoreSnapshot,
  recordConfigVersion,
  type VersionTarget,
} from "../../lib/config-versions.ts";

export const dynamic = "force-dynamic";

function unavailable(error?: unknown) {
  // A session that has ended is not an outage — the same helper `/api/theme`
  // and `/api/audit` use makes the distinction.
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  return Response.json(
    { error: "The module settings are temporarily unavailable." },
    { status: 503 },
  );
}

/**
 * The catalogue, with this workspace's answer folded in.
 *
 * `enabled` is the switch; `permitted` is whether the ACTOR reading this panel
 * clears the module's capability. They are reported separately on purpose: a
 * Super Admin needs to see that Reconcile is switched on even though the
 * environment or a capability is what is keeping somebody out of it, rather than
 * one merged flag that cannot say which.
 */
function describe(
  overrides: ModuleOverrides,
  capabilities: Readonly<Record<string, boolean>>,
  role: WorkspaceRole,
) {
  return PORTAL_MODULES.map((definition) => {
    const access = resolveModuleAccess(definition.key, overrides, capabilities, role);
    return {
      key: definition.key,
      label: definition.label,
      enabled: access.enabled,
      permitted: access.permitted,
      /* Whether the switch itself may be moved, and the sentence to show beside
         it when it may not. The UI does not invent that sentence. */
      disableable: definition.disableable,
      permanentReason: definition.permanentReason ?? null,
      /* Null where no single capability is faithful — three of the nineteen:
         `team`, `invoice-tracker` and `recycle-bin`. The panel says "the existing
         rule decides" rather than leaving a blank. */
      requiredCapability: definition.requiredCapability,
      /* Whether this workspace has an opinion at all, which is what makes
         "switched off" distinguishable from "shipped on". */
      isDefault: overrides[definition.key] === undefined,
    };
  });
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const scope = await scopedDb(request);
    const subject = await resolvePermissions(scope.db, scope.orgId, scope.actor.role);
    const refusal = requireCapability(subject, "navigation.edit");
    if (refusal) return refusal;

    const overrides = await readModuleOverrides(scope.db, scope.orgId);
    return Response.json({
      canEdit: true,
      modules: describe(
        overrides,
        effectiveCapabilities(scope.actor.role, subject.capabilities),
        scope.actor.role,
      ),
      organisation: { id: scope.orgId, name: scope.organisation?.name ?? null },
    });
  } catch (error) {
    return unavailable(error);
  }
}

export async function PUT(request: Request) {
  try {
    await ensureDatabase();
    const scope = await scopedDb(request);
    const subject = await resolvePermissions(scope.db, scope.orgId, scope.actor.role);
    const refusal = requireCapability(subject, "navigation.edit");
    if (refusal) return refusal;

    /* `scopedDbWithCapability` makes this check for its callers; this route
       resolves permissions by hand because GET needs the subject too, so the
       check is restated rather than skipped. Same shape as `/api/theme`. */
    if (!scope.authenticated) {
      return Response.json({ error: "Sign in to make this change." }, { status: 401 });
    }

    const payload = (await request.json().catch(() => null)) as {
      modules?: Record<string, unknown>;
      restoreVersion?: unknown;
    } | null;

    /*
     * §38 — RESTORE: a version's switches, sent back through this route so the
     * checks below still apply (a module that can no longer be switched off
     * refuses the whole restore with its own reason) and recorded as a new
     * version. Loaded from THIS workspace's history; the request carries only
     * the number. Every module today's catalogue has is set: on, unless the
     * version had it off.
     */
    const versionTarget: VersionTarget = { organisationId: scope.orgId, subject: "portal_modules", key: "switches" };
    const restoring = restoreVersionFrom(payload);
    if (payload && restoring) {
      const loaded = await loadRestoreSnapshot(scope.db, versionTarget, restoring);
      if (!loaded.ok) return Response.json({ error: loaded.error }, { status: loaded.status });
      payload.modules = modulesRestoreSwitches(loaded.snapshot as ModulesSnapshot, PORTAL_MODULES.map((entry) => entry.key));
    }

    if (!payload || typeof payload.modules !== "object" || payload.modules === null) {
      return Response.json(
        { error: 'Send { modules: { "reports": false } }.' },
        { status: 400 },
      );
    }

    /* Validate everything before writing anything, for the reason `/api/theme`
       gives: a partial save leaves an administrator looking at a set of switches
       that is neither what they had nor what they asked for. */
    const writes: Array<{ key: string; enabled: boolean }> = [];
    for (const [key, raw] of Object.entries(payload.modules)) {
      /* `definition`, never `module`: `@next/next/no-assign-module-variable`
         refuses that binding name, and shadowing CommonJS's `module` is worth
         refusing. Same rename in `app/lib/portal-modules.ts` and `page-guard.ts`. */
      const definition = portalModule(key);
      if (!definition) {
        return Response.json({ error: `Unknown portal module: ${key}` }, { status: 400 });
      }
      if (typeof raw !== "boolean") {
        return Response.json(
          { error: `${definition.label} must be true or false.` },
          { status: 400 },
        );
      }
      if (!raw && !definition.disableable) {
        return Response.json(
          {
            error:
              definition.permanentReason ?? `${definition.label} cannot be switched off.`,
          },
          { status: 400 },
        );
      }
      writes.push({ key, enabled: raw });
    }

    if (writes.length === 0) {
      return Response.json({ error: "No modules were sent." }, { status: 400 });
    }

    const before = await readModuleOverrides(scope.db, scope.orgId);
    const actorEmail = scope.identityEmail.toLowerCase();
    const versionActor = { email: actorEmail, userId: scope.session?.user.id ?? null };
    const changes = writes.some((write) => (before[write.key] !== false) !== write.enabled);
    /* §38 — the switches as they were, as version 1, before history's first write. */
    if (changes) await ensureConfigBaseline(scope.db, versionTarget, modulesSnapshot(before), versionActor);

    for (const write of writes) {
      /* An unchanged switch is not a decision. Skipping keeps the audit log a
         history of what somebody chose rather than of every time the panel was
         saved — the same rule `/api/theme` applies to a colour. */
      const current = before[write.key] !== false;
      if (current === write.enabled) continue;

      const result = await writeModuleEnabled(
        scope.db,
        scope.orgId,
        write.key,
        write.enabled,
        actorEmail,
      );
      if (!result.ok) {
        return Response.json({ error: result.reason }, { status: 400 });
      }

      const definition = portalModule(write.key);
      await recordAudit({
        db: scope.db,
        organisationId: scope.orgId,
        actor: auditActor(scope),
        action: write.enabled ? "module.enabled" : "module.disabled",
        entityType: "portal_module",
        entityId: write.key,
        summary: write.enabled
          ? `Switched the ${definition?.label ?? write.key} module on.`
          : `Switched the ${definition?.label ?? write.key} module off.`,
        detail: { module: write.key, from: current, to: write.enabled },
        request,
      });
    }

    const after = await readModuleOverrides(scope.db, scope.orgId);
    /* §38 — every change is a version; a restore is one even when it changed nothing. */
    if (changes || restoring) {
      const previous = await latestSnapshot(scope.db, versionTarget);
      const summary = summariseChange("portal_modules", previous, modulesSnapshot(after));
      const recorded = await recordConfigVersion(scope.db, versionTarget, {
        snapshot: modulesSnapshot(after),
        summary: restoring ? `Restored from version ${restoring} — ${summary}` : summary,
        restoredFrom: restoring,
        actor: versionActor,
      });
      if (restoring) {
        await recordAudit({
          db: scope.db,
          organisationId: scope.orgId,
          actor: auditActor(scope),
          action: "config.version_restored",
          entityType: "config_version",
          entityId: "portal_modules/switches",
          summary: `Restored the portal modules from version ${restoring}.`,
          detail: { subject: "portal_modules", key: "switches", from: restoring, version: recorded },
          request,
        });
      }
    }
    return Response.json({
      canEdit: true,
      modules: describe(
        after,
        effectiveCapabilities(scope.actor.role, subject.capabilities),
        scope.actor.role,
      ),
      organisation: { id: scope.orgId, name: scope.organisation?.name ?? null },
    });
  } catch (error) {
    return unavailable(error);
  }
}
