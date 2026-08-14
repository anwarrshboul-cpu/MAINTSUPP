/**
 * The capability matrix for one workspace.
 *
 * GET returns three layers, not one, because collapsing them would lose the
 * only thing that makes the table safe to edit:
 *
 *   `defaults`  — what the role gets when `role_capabilities` says nothing.
 *   `overrides` — the rows this workspace has actually written. Sparse.
 *   `effective` — `can()` applied to every pair, which is what is enforced.
 *
 * The editor shows `effective` and marks the cells that differ from `defaults`,
 * so "we changed this" and "this is how it ships" stay distinguishable. Reset a
 * cell and the row is deleted rather than written as `allowed = 1`, which keeps
 * the table a diff: a future change to the shipped default then reaches every
 * workspace that never disagreed with it.
 *
 * PUT applies a batch of changes and refuses the whole batch if any single cell
 * is refused. Partial application would leave the caller looking at a matrix
 * that half-saved, with no indication of which half.
 */

import { and, eq } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { roleCapabilities } from "../../../../db/schema";
import {
  CAPABILITIES,
  CAPABILITY_CATALOGUE,
  IMMUTABLE_ROLE,
  ROLE_LABELS,
  ROLES,
  can,
  defaultAllows,
  effectiveCapabilities,
  isCapability,
  isWorkspaceRole,
  loadRoleOverrides,
  requireCapability,
  roleCapabilityWriteRefusal,
  type Capability,
  type RoleOverrides,
} from "../../../lib/permissions";
import type { WorkspaceRole } from "../../../lib/workspace-actor";
import {
  adminContext,
  adminError,
  isRefusal,
  readJson,
  recordAudit,
  type AdminContext,
} from "../admin-context";

function matrixPayload(context: AdminContext, overrides: RoleOverrides) {
  const organisation =
    context.activeOrganisations.find(
      (item) => item.id === context.targetOrganisationId,
    ) ?? context.organisation;

  return {
    organisation: {
      id: organisation.id,
      name: organisation.name,
      slug: organisation.slug,
      planTier: organisation.planTier,
    },
    organisations: context.activeOrganisations
      .filter((item) => context.organisationIds.includes(item.id))
      .map((item) => ({ id: item.id, name: item.name, slug: item.slug })),
    actor: {
      email: context.identityEmail,
      role: context.actor.role,
      roleLabel: ROLE_LABELS[context.actor.role],
    },
    capabilities: CAPABILITY_CATALOGUE,
    roles: ROLES.map((role) => ({
      key: role,
      label: ROLE_LABELS[role],
      /*
       * Why a role may not be edited, in the same words the server would use if
       * the write were attempted anyway. The checkbox is disabled *because* the
       * server refuses, not instead of it.
       */
      editable: role !== IMMUTABLE_ROLE,
      lockedReason:
        role === IMMUTABLE_ROLE
          ? "Super Admin always holds every permission. Locking it is what guarantees a workspace can never lose access to its own permission editor."
          : null,
    })),
    defaults: Object.fromEntries(
      ROLES.map((role) => [
        role,
        Object.fromEntries(
          CAPABILITIES.map((capability) => [capability, defaultAllows(role, capability)]),
        ),
      ]),
    ),
    overrides,
    effective: Object.fromEntries(
      ROLES.map((role) => [role, effectiveCapabilities(role, overrides[role])]),
    ),
    /*
     * The individual cells this actor may not write, with the reason. Computed
     * from the very function PUT calls, so the disabled state in the UI and the
     * refusal on the server cannot drift apart.
     */
    lockedCells: ROLES.flatMap((role) =>
      CAPABILITIES.map((capability) => ({
        role,
        capability,
        reason: roleCapabilityWriteRefusal(context.actor.role, role, capability, false),
      })).filter((cell) => cell.reason),
    ),
  };
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const url = new URL(request.url);
    const context = await adminContext(request, url.searchParams.get("organisationId"));
    if (isRefusal(context)) return context;

    // Reading the matrix is reading the workspace's security posture, so it is
    // gated on the same capability as changing it.
    const denied = requireCapability(context.subject, "roles.edit");
    if (denied) return denied;

    const overrides = await loadRoleOverrides(context.db, context.targetOrganisationId);
    return Response.json(matrixPayload(context, overrides));
  } catch (error) {
    return adminError(error, "The permission matrix is temporarily unavailable.");
  }
}

type ChangeRequest = {
  role?: string;
  capability?: string;
  /** `null` reverts the cell to its built-in default by deleting the row. */
  allowed?: boolean | null;
};

export async function PUT(request: Request) {
  try {
    await ensureDatabase();
    const body = await readJson<{
      organisationId?: string;
      changes?: ChangeRequest[];
    }>(request);

    const context = await adminContext(request, body.organisationId ?? null);
    if (isRefusal(context)) return context;

    const denied = requireCapability(context.subject, "roles.edit");
    if (denied) return denied;

    const raw = Array.isArray(body.changes) ? body.changes : [];
    if (!raw.length) {
      return Response.json({ error: "No changes were supplied." }, { status: 400 });
    }
    if (raw.length > CAPABILITIES.length * ROLES.length) {
      return Response.json({ error: "Too many changes in one request." }, { status: 400 });
    }

    // Validate every change before writing any of them, so a refusal in the
    // middle of a batch cannot leave the matrix half-applied.
    const changes: Array<{
      role: WorkspaceRole;
      capability: Capability;
      allowed: boolean | null;
    }> = [];
    for (const change of raw) {
      if (!isWorkspaceRole(change.role)) {
        return Response.json(
          { error: `"${String(change.role)}" is not a role this workspace has.` },
          { status: 400 },
        );
      }
      if (!isCapability(change.capability)) {
        return Response.json(
          { error: `"${String(change.capability)}" is not a permission this product enforces.` },
          { status: 400 },
        );
      }
      const allowed =
        change.allowed === null || change.allowed === undefined
          ? null
          : Boolean(change.allowed);

      const refusal = roleCapabilityWriteRefusal(
        context.actor.role,
        change.role,
        change.capability,
        allowed,
      );
      if (refusal) {
        return Response.json(
          {
            error: refusal,
            denied: true,
            guardRail:
              change.role === IMMUTABLE_ROLE ? "immutable_role" : "self_lockout",
            role: change.role,
            capability: change.capability,
          },
          { status: 403 },
        );
      }

      changes.push({ role: change.role, capability: change.capability, allowed });
    }

    const stamp = new Date().toISOString();
    for (const change of changes) {
      if (change.allowed === null) {
        // Reverting means removing the row, not storing the default's value.
        // See the header: the table is a diff against the defaults.
        await context.db
          .delete(roleCapabilities)
          .where(
            and(
              eq(roleCapabilities.organisationId, context.targetOrganisationId),
              eq(roleCapabilities.role, change.role),
              eq(roleCapabilities.capability, change.capability),
            ),
          );
        continue;
      }

      await context.db
        .insert(roleCapabilities)
        .values({
          id: crypto.randomUUID(),
          organisationId: context.targetOrganisationId,
          role: change.role,
          capability: change.capability,
          allowed: change.allowed,
          updatedBy: context.identityEmail,
          updatedAt: stamp,
        })
        .onConflictDoUpdate({
          target: [
            roleCapabilities.organisationId,
            roleCapabilities.role,
            roleCapabilities.capability,
          ],
          set: {
            allowed: change.allowed,
            updatedBy: context.identityEmail,
            updatedAt: stamp,
          },
        });
    }

    const overrides = await loadRoleOverrides(context.db, context.targetOrganisationId);

    /*
     * A last look at the result rather than at the request. Each individual
     * change passed its guard-rail, but a batch could in principle combine into
     * something none of them caught, so the invariant is re-checked against
     * what is now actually stored: the acting role must still be able to edit
     * roles here.
     */
    if (!can({ role: context.actor.role, capabilities: overrides[context.actor.role] }, "roles.edit")) {
      return Response.json(
        {
          error:
            "That change would have removed your own ability to edit permissions, so it was not kept.",
          denied: true,
          guardRail: "self_lockout",
        },
        { status: 409 },
      );
    }

    await recordAudit(context, {
      action: "role.capabilities_changed",
      summary: `Updated ${changes.length} permission${changes.length === 1 ? "" : "s"} in ${
        context.activeOrganisations.find((item) => item.id === context.targetOrganisationId)
          ?.name ?? context.targetOrganisationId
      }`,
      entityType: "role_capabilities",
      entityId: context.targetOrganisationId,
      detail: { changes },
    });

    return Response.json({ ok: true, ...matrixPayload(context, overrides) });
  } catch (error) {
    return adminError(error, "The permission change could not be saved.");
  }
}
