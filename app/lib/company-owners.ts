/**
 * THE LAST-OWNER RULE: a client company is never left without an active Owner
 * by accident.
 *
 * Two writes can take an Owner away — removing their ownership, and switching
 * their account off — and both go through here. The rule is enforced INSIDE
 * the write, not by a count read beforehand:
 *
 *   1. the company row is touched first, in the same transaction. On Postgres
 *      that takes a row lock, so a second request removing a DIFFERENT Owner
 *      of the same company waits until the first has committed, and its own
 *      statement then sees the first removal (READ COMMITTED takes a fresh
 *      snapshot per statement). On D1/SQLite a batch is serialised anyway.
 *   2. the UPDATE carries the guard in its WHERE clause: it changes the row
 *      only if another active Owner — on an active account — remains.
 *
 * A check-then-write would let two administrators remove the last two Owners
 * at the same moment, each having seen the other still in place. This cannot.
 *
 * The outcome is read back rather than taken from `meta.changes`, so the answer
 * does not depend on which database shim reported what.
 *
 * Replacing an Owner is therefore always "appoint the new one, then remove the
 * old one", and appointing is a Platform Super Admin's invitation.
 */

import type { getD1 } from "../../db";

type D1DatabaseLike = Awaited<ReturnType<typeof getD1>>;

/** Another active Owner, on an active account, of the company in `companyColumn`. */
const ANOTHER_ACTIVE_OWNER = (companyColumn: string, userParam: string) => `EXISTS (
  SELECT 1
    FROM client_company_members other
    JOIN users other_user ON other_user.id = other.user_id
   WHERE other.client_company_id = ${companyColumn}
     AND other.user_id <> ${userParam}
     AND other.relationship = 'owner'
     AND other.status = 'active'
     AND other_user.active = 1
)`;

export type OwnerRemoval = "removed" | "last_owner" | "not_owner";

/** Removes `userId` as an Owner of `clientCompanyId`, unless they are its last one. */
export async function removeOwnerGuarded(
  d1: D1DatabaseLike,
  clientCompanyId: string,
  userId: string,
): Promise<OwnerRemoval> {
  const now = new Date().toISOString();
  const current = (await d1
    .prepare(
      `SELECT status FROM client_company_members
        WHERE client_company_id = ? AND user_id = ? AND relationship = 'owner'
        LIMIT 1`,
    )
    .bind(clientCompanyId, userId)
    .first()) as { status?: string } | null;
  if (current?.status !== "active") return "not_owner";

  await d1.batch([
    d1
      .prepare("UPDATE client_companies SET updated_at = ? WHERE id = ?")
      .bind(now, clientCompanyId),
    d1
      .prepare(
        `UPDATE client_company_members
            SET status = 'removed', updated_at = ?
          WHERE client_company_id = ?
            AND user_id = ?
            AND relationship = 'owner'
            AND status = 'active'
            AND ${ANOTHER_ACTIVE_OWNER("client_company_members.client_company_id", "?")}`,
      )
      .bind(now, clientCompanyId, userId, userId),
  ]);

  const after = (await d1
    .prepare(
      `SELECT status FROM client_company_members
        WHERE client_company_id = ? AND user_id = ? AND relationship = 'owner'
        LIMIT 1`,
    )
    .bind(clientCompanyId, userId)
    .first()) as { status?: string } | null;
  return after?.status === "active" ? "last_owner" : "removed";
}

/**
 * The active companies `userId` is the ONLY active Owner of — the companies
 * that switching their account off would leave without one.
 */
export async function companiesOnlyOwnedBy(
  d1: D1DatabaseLike,
  userId: string,
): Promise<Array<{ id: string; name: string }>> {
  const result = await d1
    .prepare(
      `SELECT c.id AS id, c.name AS name
         FROM client_company_members m
         JOIN client_companies c ON c.id = m.client_company_id
        WHERE m.user_id = ?
          AND m.relationship = 'owner'
          AND m.status = 'active'
          AND c.status = 'active'
          AND NOT ${ANOTHER_ACTIVE_OWNER("m.client_company_id", "?")}
        ORDER BY c.name`,
    )
    .bind(userId, userId)
    .all();
  return (result.results ?? []) as Array<{ id: string; name: string }>;
}

/**
 * Switches an account off, unless that would leave a company it owns with no
 * active Owner. Returns the companies that blocked it (empty when it went
 * through).
 */
export async function deactivateAccountGuarded(
  d1: D1DatabaseLike,
  userId: string,
): Promise<Array<{ id: string; name: string }>> {
  const now = new Date().toISOString();
  const owned = await d1
    .prepare(
      `SELECT client_company_id AS id FROM client_company_members
        WHERE user_id = ? AND relationship = 'owner' AND status = 'active'`,
    )
    .bind(userId)
    .all();
  const companyIds = ((owned.results ?? []) as Array<{ id: string }>).map((row) => row.id);

  await d1.batch([
    // Lock every company this account owns, in a stable order.
    ...[...companyIds].sort().map((id) =>
      d1.prepare("UPDATE client_companies SET updated_at = ? WHERE id = ?").bind(now, id),
    ),
    d1
      .prepare(
        `UPDATE users
            SET active = 0,
                status = 'deactivated',
                deactivated_at = ?,
                updated_at = ?
          WHERE id = ?
            AND NOT EXISTS (
              SELECT 1
                FROM client_company_members mine
                JOIN client_companies company ON company.id = mine.client_company_id
               WHERE mine.user_id = ?
                 AND mine.relationship = 'owner'
                 AND mine.status = 'active'
                 AND company.status = 'active'
                 AND NOT ${ANOTHER_ACTIVE_OWNER("mine.client_company_id", "?")}
            )`,
      )
      .bind(now, now, userId, userId, userId),
  ]);

  const after = (await d1
    .prepare("SELECT active FROM users WHERE id = ? LIMIT 1")
    .bind(userId)
    .first()) as { active?: number | boolean } | null;
  const stillActive = after?.active === true || after?.active === 1;
  return stillActive ? companiesOnlyOwnedBy(d1, userId) : [];
}
