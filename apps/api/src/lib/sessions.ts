import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../../../../packages/db/src/client.ts";
import type { Actor, Role } from "./access.ts";

export const SESSION_COOKIE = "ms_session";

/*
 * Two lifetimes, matching the "Keep me signed in" box.
 *
 * Ticked (the default) gives 30 days and a cookie that survives a browser
 * restart. Unticked gives 12 hours and a session cookie that dies with the
 * browser — which is what somebody on a shared machine in a shop back office
 * is asking for when they untick it.
 */
const PERSISTENT_DAYS = 30;
const TRANSIENT_HOURS = 12;

/** Hash, never store. The cookie holds the secret; the table holds sha-256. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  // Truncated: enough to rate-limit and spot a flood, not a log of who was where.
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

export type IssuedSession = { token: string; expiresAt: Date };

/**
 * Issues a session.
 *
 * 256 bits from the CSPRNG. The token is returned once, to be put in a cookie,
 * and never recoverable afterwards — a support request to "get me my session"
 * has no answer, which is correct.
 */
export async function createSession(
  db: Db,
  userId: string,
  options: { persistent?: boolean; userAgent?: string; ip?: string } = {},
): Promise<IssuedSession> {
  const persistent = options.persistent !== false;
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    Date.now() +
      (persistent
        ? PERSISTENT_DAYS * 24 * 60 * 60 * 1000
        : TRANSIENT_HOURS * 60 * 60 * 1000),
  );

  await db.query(
    `insert into sessions (user_id, token_hash, persistent, user_agent, ip_hash, expires_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      userId,
      hashToken(token),
      persistent,
      options.userAgent?.slice(0, 300) ?? null,
      hashIp(options.ip),
      expiresAt,
    ],
  );

  return { token, expiresAt };
}

type SessionRow = {
  session_id: string;
  user_id: string;
  profile_id: string | null;
  email: string;
  role: Role | null;
  status: Actor["status"] | null;
  organisation_id: string | null;
  contractor_id: string | null;
  site_ids: string[] | null;
};

/**
 * Resolves a cookie value to an actor, or null.
 *
 * One query. It joins the profile and aggregates the scoped site ids, because
 * `scopeFor()` needs all of it on every request and three round trips per
 * request is how an API becomes slow without anyone noticing a single slow
 * query.
 *
 * A user with no profile row resolves to null — not to a profile-less actor.
 * Every capability check would have to special-case that state, and one
 * forgotten check is an unprovisioned account with a live session reading data.
 */
export async function resolveSession(
  db: Db,
  token: string | undefined,
): Promise<{ actor: Actor; sessionId: string } | null> {
  if (!token) return null;

  const rows = await db.query<SessionRow>(
    `select s.id as session_id,
            s.user_id,
            p.id as profile_id,
            coalesce(p.email, u.email) as email,
            p.role,
            p.status,
            p.organisation_id,
            p.contractor_id,
            coalesce(
              array_agg(ps.site_id) filter (where ps.site_id is not null),
              '{}'
            ) as site_ids
       from sessions s
       join users u on u.id = s.user_id
       left join profiles p on p.id = s.user_id
       left join profile_sites ps on ps.profile_id = p.id
      where s.token_hash = $1
        and s.revoked_at is null
        and s.expires_at > now()
      group by s.id, s.user_id, p.id, u.email, p.email, p.role, p.status,
               p.organisation_id, p.contractor_id`,
    [hashToken(token)],
  );

  const row = rows[0];
  if (!row || !row.profile_id || !row.role || !row.status) return null;

  /*
   * Touch `last_used_at`, but not on every request.
   *
   * The write is what turns a cheap indexed read into a row lock on the
   * sessions table for every authenticated request in the system. A minute's
   * granularity is ample for "when was this session last active" and removes
   * almost all of the writes.
   */
  void db
    .query(
      `update sessions set last_used_at = now()
        where id = $1 and last_used_at < now() - interval '1 minute'`,
      [row.session_id],
    )
    .catch(() => {
      /* Never fail a request because a timestamp did not update. */
    });

  return {
    sessionId: row.session_id,
    actor: {
      profileId: row.profile_id,
      email: row.email,
      role: row.role,
      status: row.status,
      organisationId: row.organisation_id,
      contractorId: row.contractor_id,
      siteIds: row.site_ids ?? [],
    },
  };
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.query(
    "update sessions set revoked_at = now() where id = $1 and revoked_at is null",
    [sessionId],
  );
}

/** Sign out everywhere. Also what deactivating an account must call. */
export async function revokeAllSessions(
  db: Db,
  userId: string,
): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `update sessions set revoked_at = now()
      where user_id = $1 and revoked_at is null returning id`,
    [userId],
  );
  return rows.length;
}

/** Housekeeping: drop rows that can no longer authenticate anyone. */
export async function pruneSessions(db: Db): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `delete from sessions
      where expires_at < now() - interval '7 days'
         or (revoked_at is not null and revoked_at < now() - interval '7 days')
      returning id`,
  );
  return rows.length;
}

/**
 * Compares two secrets in constant time.
 * Used for one-time tokens (invitations, password resets) where the value is
 * looked up by hash but still compared before being accepted.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export { hashToken };
