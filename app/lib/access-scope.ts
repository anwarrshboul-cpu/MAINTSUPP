/**
 * Per-workspace questions about an access the tenancy resolver has already
 * resolved — which role applies in THIS workspace, which client company it
 * belongs to, and whether the caller administers that company.
 *
 * Pure on purpose: no database, no request, no session. `tenant-access.ts`
 * re-exports these, and the routes call them with the `scopedDb` result they
 * already hold, so the answer never needs a second query and never disagrees
 * with the resolver that built the access.
 */

import type { MembershipRole, WorkspaceRole } from "./roles";

/** The parts of a resolved access these questions read. */
export type AccessShape = {
  platformAdmin: boolean;
  organisationIds: string[];
  activeOrganisations: Array<{ id: string; clientCompanyId?: string | null }>;
  ownedCompanyIds: string[];
  grants: Array<{ organisationId: string; role: MembershipRole }>;
  unaffiliated: boolean;
  orgId: string;
  actor: { role: WorkspaceRole };
};

/**
 * The role this access acts with in one named workspace, or `null` for none.
 *
 * Platform Super Admin everywhere; Owner in the workspaces of a company they
 * own; otherwise whatever their membership in THAT workspace says. `null` —
 * not the weakest role — when they have no access there, because a weakest
 * role can still carry a capability a Super Admin granted to Clients in that
 * workspace, and a stranger must not inherit it.
 */
export function roleInOrganisation(access: AccessShape, organisationId: string): WorkspaceRole | null {
  if (access.platformAdmin) return "super_admin";
  if (!access.organisationIds.includes(organisationId)) return null;
  const organisation = access.activeOrganisations.find((item) => item.id === organisationId);
  if (
    organisation?.clientCompanyId &&
    access.ownedCompanyIds.includes(organisation.clientCompanyId)
  ) {
    return "owner";
  }
  const grant = access.grants.find((item) => item.organisationId === organisationId);
  if (grant) return grant.role;
  if (access.unaffiliated && organisationId === access.orgId) return access.actor.role;
  return null;
}

/** The client company a workspace belongs to, if the access can see it. */
export function companyOfOrganisation(
  access: Pick<AccessShape, "activeOrganisations">,
  organisationId: string,
): string | null {
  return (
    access.activeOrganisations.find((item) => item.id === organisationId)?.clientCompanyId ??
    null
  );
}

/** Whether this access may administer a whole client company. */
export function administersCompany(
  access: Pick<AccessShape, "platformAdmin" | "ownedCompanyIds">,
  clientCompanyId: string,
) {
  return access.platformAdmin || access.ownedCompanyIds.includes(clientCompanyId);
}
