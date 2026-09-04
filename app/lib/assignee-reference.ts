/**
 * Who a job is assigned to: the display name, and the account behind it.
 *
 * The sibling of `contractor-reference.ts`, and deliberately its mirror image.
 * `maintenance_requests` carries two columns for one fact:
 *
 *   · `assignee`         — free text. What somebody was called when the job was
 *                          given to them, and what every monday-imported row,
 *                          every CSV export and every existing filter holds.
 *   · `assignee_user_id` — the stable `users.id`, added so the board can offer
 *                          the workspace's REAL roster.
 *
 * The two resolve in opposite directions, and that difference is the point. A
 * contractor is named as text and the register is asked which contractor that
 * text means — a guess, hedged by "unique match only". A person is CHOSEN from
 * the roster, so the id is what the caller sent and the NAME IS DERIVED FROM
 * IT. There is no guessing to hedge, no ambiguity to refuse, and the two
 * columns cannot drift: nothing but this function writes the pair.
 *
 * TENANCY. The membership predicate is the whole security of the feature. A
 * user id is a well-formed string a caller can invent, so "assign MN-1046 to
 * <another tenant's user>" is one request away unless the id is proved to name
 * an ACTIVE membership of the CALLER's organisation. It is proved here, on the
 * `orgId` the scoped database already resolved, and a failure is refused rather
 * than silently dropped — an assignment that appears to work and did not is the
 * one answer this must never give.
 */

import { and, eq } from "drizzle-orm";
import type { getDb } from "../../db";
import { memberships, users } from "../../db/schema";

type AssigneeDatabase = Awaited<ReturnType<typeof getDb>>;

export type AssigneeLink =
  /** The id named an active member; `name` is theirs, and authoritative. */
  | { ok: true; assigneeUserId: string; name: string }
  /** `null` was sent — the caller is unassigning. */
  | { ok: true; assigneeUserId: null; name: null }
  /** The id named nobody this organisation may assign work to. */
  | { ok: false; reason: string };

/**
 * The member an `assigneeUserId` names in one organisation, or a refusal.
 *
 * "Eligible" is an ACTIVE membership of this organisation held by an ACTIVE
 * user — the same three predicates `GET /api/board/members` uses to draw the
 * picker, so the list a person chooses from and the list the server will accept
 * cannot disagree. A deactivated colleague therefore stops being assignable
 * while every job already assigned to them keeps their name, which is the
 * behaviour a leaver needs.
 *
 * A user outside the organisation and a user id that exists nowhere are
 * answered identically, so this cannot be used to confirm that an account
 * exists.
 */
export async function resolveAssigneeLink(
  db: AssigneeDatabase,
  orgId: string,
  assigneeUserId: unknown,
): Promise<AssigneeLink> {
  const id = typeof assigneeUserId === "string" ? assigneeUserId.trim() : "";
  if (!id) return { ok: true, assigneeUserId: null, name: null };

  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.organisationId, orgId),
        eq(memberships.userId, id),
        eq(memberships.status, "active"),
        eq(users.active, true),
      ),
    )
    .limit(1);

  if (!row) {
    return {
      ok: false,
      reason: "That person is not an active member of this workspace.",
    };
  }

  /*
   * The name is the roster's, not the caller's.
   *
   * The picker sends the name it is showing so the optimistic cell has
   * something to draw, but a client-supplied display name beside a
   * server-verified id is a way to write "Finance Director" next to a
   * warehouse account. Deriving it here means the two columns are one fact.
   *
   * Falls back to the email for an account nobody has named — the same rule
   * `/api/board/members` renders by, so the cell reads as the picker did.
   */
  const name = (row.fullName?.trim() || row.email).slice(0, 120);
  return { ok: true, assigneeUserId: row.id, name };
}

/**
 * The `assignee` / `assignee_user_id` pair to write, or nothing.
 *
 * The guard is the same one `contractorLinkValues` applies and exists for the
 * same reason: the pair is only recomputed when `assigneeUserId` is PART OF
 * THIS WRITE. A PATCH that changes a priority must leave the assignment exactly
 * as it found it, and a caller spreading this into its `set({...})` gets that
 * for free — an absent key is not an update.
 *
 * When the key IS present this OVERRIDES whatever `requestFieldValues` derived
 * from a `assignee` string sent alongside it, which is why the caller must
 * apply this second. `requestFieldValues` clears `assignee_user_id` on any
 * name-only write; this puts the chosen person back.
 */
export async function assigneeLinkValues(
  db: AssigneeDatabase,
  orgId: string,
  fields: Record<string, unknown>,
): Promise<
  | { ok: true; values: { assignee?: string | null; assigneeUserId?: string | null } }
  | { ok: false; reason: string }
> {
  if (!Object.prototype.hasOwnProperty.call(fields, "assigneeUserId")) {
    return { ok: true, values: {} };
  }
  const link = await resolveAssigneeLink(db, orgId, fields.assigneeUserId);
  if (!link.ok) return link;
  return {
    ok: true,
    values: { assignee: link.name, assigneeUserId: link.assigneeUserId },
  };
}
