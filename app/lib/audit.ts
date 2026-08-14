/**
 * Who did what — the append-only system trail.
 *
 * Stage 20. `activity_log` already records what happened to a maintenance
 * request, for the people working it. This records what happened to the
 * *system*: sign-ins, invitations, role changes, deletions, imports — for
 * whoever has to answer a question about them months later. The two are
 * deliberately separate stores because they answer to different readers and
 * have different retention rules.
 *
 * Two contracts hold this file together, and neither is negotiable.
 *
 * 1. APPEND ONLY. This module exposes exactly one write, and that write is an
 *    INSERT. There is no update path and no delete path — not "none that we
 *    call", none that exists. A log that can be rewritten proves nothing about
 *    the past, so the safest place to enforce that is the only module allowed
 *    to touch the table: the capability is simply absent from the codebase.
 *    `tests/stage-twenty-teams-audit.test.mjs` asserts that absence.
 *
 * 2. IT MUST NOT BREAK THE CALLER. Auditing is a side effect of an action, not
 *    part of it. If the insert fails, the invitation was still sent and the
 *    items were still deleted; throwing here would turn a bookkeeping fault
 *    into a user-visible failure, and — worse — into a rollback of work that
 *    already happened. So every failure is swallowed. Swallowed is not the same
 *    as hidden: each one is logged with the event that was lost, because a
 *    silently non-recording audit log is the failure mode that matters most.
 */

import { getDb } from "../../db";
import { auditEvents } from "../../db/schema";

type Database = Awaited<ReturnType<typeof getDb>>;

/**
 * Dotted verbs, `subject.past_tense`.
 *
 * Typed as a union widened with `string` so the known actions autocomplete and
 * stay spelled consistently, while a route that needs a new verb is not blocked
 * on editing this file. The viewer groups by the part before the dot, so the
 * prefix is the meaningful half: keep `team.*` together, never `teams_updated`.
 */
export type AuditAction =
  // Accounts and access
  | "user.invited"
  | "user.invite_revoked"
  | "user.invite_accepted"
  | "user.deactivated"
  | "user.reactivated"
  | "role.changed"
  | "permission.changed"
  | "session.signed_in"
  | "session.sign_in_failed"
  | "session.signed_out"
  | "session.revoked"
  // Teams
  | "team.created"
  | "team.renamed"
  | "team.updated"
  | "team.archived"
  | "team.restored"
  | "team.member_added"
  | "team.member_removed"
  | "team.member_role_changed"
  // Data
  | "board.items_deleted"
  | "board.items_archived"
  | "data.imported"
  | "data.exported"
  | (string & {});

/** The person the event is recorded against. */
export type AuditActor = {
  /** `users.id` where the actor resolves to an account; null for a stranger. */
  userId?: string | null;
  email?: string | null;
  /** The workspace role at the time of the action, not the current one. */
  role?: string | null;
};

export type RecordAuditInput = {
  /**
   * The handle to write through. Optional: a caller already holding one from
   * `scopedDb` should pass it, but the sign-in and invitation routes work in
   * raw D1 and have no drizzle handle to hand. Resolving one here rather than
   * making them do it keeps adoption to a single call, which is the difference
   * between an action being audited and an action being meant to be.
   */
  db?: Database;
  /**
   * The workspace the action happened in. Null is legitimate and meaningful:
   * a failed sign-in has no workspace yet, and dropping the event because of
   * that would lose exactly the events worth keeping. Null-workspace rows are
   * only readable by a super admin — see `app/api/audit/route.ts`.
   */
  organisationId: string | null;
  actor: AuditActor;
  action: AuditAction;
  /** What was acted on: "team", "membership", "maintenance_request", … */
  entityType?: string | null;
  entityId?: string | null;
  /** One line, readable by a human with no context. Past tense. */
  summary: string;
  /**
   * Structured facts. Use `changeDetail()` for edits so the viewer can render
   * a before/after table instead of a blob.
   */
  detail?: unknown;
  /**
   * The originating request. IP and user agent are read from it, so passing it
   * is preferred over setting them by hand.
   */
  request?: Request | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/**
 * The actor, read off a `scopedDb` handle.
 *
 * `actorUserId` comes from the session and is therefore only present when the
 * caller actually proved who they are; `actorEmail` is the identity the request
 * was answered as either way. Recording both is the point: an event whose email
 * has no user id behind it was performed under the testing role switcher, and a
 * reader can tell that apart from a signed-in action without being told.
 */
export function auditActor(scope: {
  identityEmail: string;
  actor: { role: string };
  session?: { user: { id: string } } | null;
}): AuditActor {
  return {
    userId: scope.session?.user.id ?? null,
    email: scope.identityEmail,
    role: scope.actor.role,
  };
}

/** Longest a stored string may be, per column. Truncated, never rejected. */
const LIMITS = {
  action: 80,
  entityType: 60,
  entityId: 120,
  summary: 400,
  email: 200,
  role: 40,
  ip: 60,
  userAgent: 400,
  detail: 8000,
} as const;

function trim(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

/**
 * The caller's IP, best available.
 *
 * Cloudflare's own header first because it is the one the edge sets and a
 * client cannot forge; `x-forwarded-for` may be a chain, in which case the
 * left-most entry is the original client.
 */
export function requestIp(request: Request | null | undefined): string | null {
  if (!request) return null;
  const direct =
    request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip");
  if (direct) return trim(direct, LIMITS.ip);
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return null;
  return trim(forwarded.split(",")[0], LIMITS.ip);
}

export function requestUserAgent(request: Request | null | undefined): string | null {
  if (!request) return null;
  return trim(request.headers.get("user-agent"), LIMITS.userAgent);
}

/**
 * A before/after pair, reduced to the fields that actually moved.
 *
 * Storing whole rows would make every edit look like it touched everything, so
 * the viewer would show noise and the reader would stop reading it. Only keys
 * whose value changed survive, plus the list of their names so the UI can label
 * the row without re-deriving the diff.
 */
export function changeDetail(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
) {
  const keys = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};
  const changed: string[] = [];
  for (const key of keys) {
    const from = before?.[key];
    const to = after?.[key];
    // JSON comparison so nested option objects and arrays compare by value.
    if (JSON.stringify(from ?? null) === JSON.stringify(to ?? null)) continue;
    changed.push(key);
    changedBefore[key] = from ?? null;
    changedAfter[key] = to ?? null;
  }
  return { changed, before: changedBefore, after: changedAfter };
}

function serialiseDetail(detail: unknown): string | null {
  if (detail === undefined || detail === null) return null;
  try {
    const encoded = JSON.stringify(detail);
    if (!encoded) return null;
    // An oversized detail is recorded as a note rather than dropped, so the
    // event itself survives even when its payload cannot be stored whole.
    return encoded.length > LIMITS.detail
      ? JSON.stringify({ truncated: true, bytes: encoded.length })
      : encoded;
  } catch {
    return JSON.stringify({ unserialisable: true });
  }
}

/**
 * Append one event. The only write this module performs.
 *
 * Resolves to the new row's id, or `null` when the event could not be stored —
 * callers are free to ignore the result, and every current caller does. It
 * never rejects, so `await recordAudit(...)` cannot fail the action it is
 * describing and `void recordAudit(...)` cannot raise an unhandled rejection.
 */
export async function recordAudit(input: RecordAuditInput): Promise<string | null> {
  try {
    const action = trim(input.action, LIMITS.action);
    const summary = trim(input.summary, LIMITS.summary);
    // An event with no verb or no sentence is unreadable later, and a row
    // nobody can interpret is worse than an honest gap.
    if (!action || !summary) {
      console.error("[audit] refused an event with no action or summary", {
        action: input.action,
        summary: input.summary,
      });
      return null;
    }

    const id = crypto.randomUUID();
    const db = input.db ?? (await getDb());
    await db.insert(auditEvents).values({
      id,
      organisationId: input.organisationId ?? null,
      actorUserId: trim(input.actor?.userId, LIMITS.entityId),
      actorEmail: trim(input.actor?.email, LIMITS.email)?.toLowerCase() ?? null,
      actorRole: trim(input.actor?.role, LIMITS.role),
      action,
      entityType: trim(input.entityType, LIMITS.entityType),
      entityId: trim(input.entityId, LIMITS.entityId),
      summary,
      detail: serialiseDetail(input.detail),
      ipAddress: input.ipAddress ?? requestIp(input.request),
      userAgent: input.userAgent ?? requestUserAgent(input.request),
      createdAt: new Date().toISOString(),
    });
    return id;
  } catch (error) {
    // Loud, but only here. The action that triggered this has already happened
    // and must be allowed to report its own success.
    console.error("[audit] failed to record an event", {
      action: input.action,
      organisationId: input.organisationId,
      actor: input.actor?.email ?? null,
      error,
    });
    return null;
  }
}
