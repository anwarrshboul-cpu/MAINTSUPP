import { createHash } from "node:crypto";
import type { Db } from "../../../../packages/db/src/client.ts";
import type { Role } from "./access.ts";

/**
 * Decides what a newly created user becomes.
 *
 * Three sources, in strict order — and the order is the security property:
 *
 *   1. `role_bootstrap` — an address pre-declared by a migration. This is how
 *      the owner account is founded without a seeded password.
 *   2. An open invitation for that address, with the role and scope an
 *      administrator already chose.
 *   3. Otherwise `pending_approval`, holding no role that grants anything.
 *
 * Nothing here reads the request body. A caller cannot ask to be an admin,
 * because their input never reaches this decision — the only way to a
 * privileged role is a row an existing administrator wrote first.
 *
 * Runs inside the caller's transaction so a user is never created without the
 * profile that decides what they may do.
 */
export type Provisioned = {
  role: Role;
  status: "active" | "pending_approval";
  organisationId: string | null;
  contractorId: string | null;
  source: "bootstrap" | "invitation" | "pending";
};

export async function provisionProfile(
  db: Db,
  userId: string,
  emailAddress: string,
): Promise<Provisioned> {
  const address = emailAddress.trim().toLowerCase();

  const [bootstrap] = await db.query<{
    role: Role;
    organisation_id: string | null;
    contractor_id: string | null;
  }>(
    `select role, organisation_id::text, contractor_id::text
       from role_bootstrap
      where lower(email) = $1 and consumed_at is null`,
    [address],
  );

  let result: Provisioned;

  if (bootstrap) {
    await db.query(
      "update role_bootstrap set consumed_at = now() where lower(email) = $1",
      [address],
    );
    result = {
      role: bootstrap.role,
      status: "active",
      organisationId: bootstrap.organisation_id,
      contractorId: bootstrap.contractor_id,
      source: "bootstrap",
    };
  } else {
    const [invitation] = await db.query<{
      id: string;
      role: Role;
      organisation_id: string | null;
      contractor_id: string | null;
    }>(
      `select id::text, role, organisation_id::text, contractor_id::text
         from invitations
        where lower(email) = $1 and status = 'pending' and expires_at > now()
        order by created_at desc limit 1`,
      [address],
    );

    if (invitation) {
      result = {
        role: invitation.role,
        status: "active",
        organisationId: invitation.organisation_id,
        contractorId: invitation.contractor_id,
        source: "invitation",
      };
    } else {
      /*
       * The fallback holds `client_user`, which is the least privileged role,
       * paired with `pending_approval`, which grants nothing at all —
       * `scopeFor()` denies any non-active status before it looks at the role.
       * Two independent reasons this account can read nothing.
       */
      result = {
        role: "client_user",
        status: "pending_approval",
        organisationId: null,
        contractorId: null,
        source: "pending",
      };
    }
  }

  await db.query(
    `insert into profiles (id, email, role, status, organisation_id, contractor_id)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (id) do nothing`,
    [
      userId,
      address,
      result.role,
      result.status,
      result.organisationId,
      result.contractorId,
    ],
  );

  if (result.source === "invitation") {
    await db.query(
      `update invitations set status = 'accepted', accepted_by = $1, accepted_at = now()
        where lower(email) = $2 and status = 'pending'`,
      [userId, address],
    );
  }

  return result;
}

/** One-time tokens are stored hashed, so a leaked table yields no live links. */
export function hashOneTimeToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
