/**
 * Active sessions for the signed-in person — the "My profile" security block.
 *
 * monday lists the devices an account is signed in on and offers "log out of
 * all other sessions". The `sessions` table is the real backing store: it holds
 * only the token's hash, and revocation stamps `revoked_at` rather than
 * deleting, so a sign-out stays visible in the trail.
 *
 * Sessions are empty until the sign-in route writes them, and this returns that
 * honestly (`authenticationActive: false`) instead of inventing a device list.
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { sessions, users } from "../../../../db/schema";
import { anonymousRefusal, scopedDb } from "../../../lib/tenant-db";

type Database = Awaited<ReturnType<typeof scopedDb>>["db"];

async function currentUserId(db: Database, email: string) {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * A user agent reduced to something a person recognises.
 *
 * Deliberately coarse: the stored string is the browser's own claim, and
 * printing it whole tells the reader nothing they can act on.
 */
function describeAgent(agent: string | null) {
  if (!agent) return "Unknown device";
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Chrome\//.test(agent) && !/Chromium/.test(agent)
      ? "Chrome"
      : /Firefox\//.test(agent)
        ? "Firefox"
        : /Safari\//.test(agent)
          ? "Safari"
          : "Browser";
  const platform = /iPhone|iPad/.test(agent)
    ? "iOS"
    : /Android/.test(agent)
      ? "Android"
      : /Macintosh/.test(agent)
        ? "macOS"
        : /Windows/.test(agent)
          ? "Windows"
          : /Linux/.test(agent)
            ? "Linux"
            : "Unknown platform";
  return `${browser} on ${platform}`;
}

export async function GET(request: Request) {
  await ensureDatabase();
  try {
    const context = await scopedDb(request);
    const userId = await currentUserId(context.db, context.identityEmail);
    if (!userId) {
      return Response.json({
        sessions: [],
        authenticationActive: false,
        note: "This identity has no account record, so it has no sessions.",
      });
    }

    const rows = await context.db
      .select({
        id: sessions.id,
        issuedAt: sessions.issuedAt,
        expiresAt: sessions.expiresAt,
        lastSeenAt: sessions.lastSeenAt,
        revokedAt: sessions.revokedAt,
        ipAddress: sessions.ipAddress,
        userAgent: sessions.userAgent,
        organisationId: sessions.organisationId,
      })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .orderBy(desc(sessions.issuedAt))
      .limit(50);

    const now = new Date().toISOString();
    return Response.json({
      sessions: rows.map((row) => ({
        id: row.id,
        issuedAt: row.issuedAt,
        expiresAt: row.expiresAt,
        lastSeenAt: row.lastSeenAt,
        ipAddress: row.ipAddress,
        organisationId: row.organisationId,
        device: describeAgent(row.userAgent),
        expired: row.expiresAt < now,
      })),
      /**
       * False means "the sign-in route has not written a session yet", which is
       * why the list is empty. Without it an empty list reads as a bug.
       */
      authenticationActive: rows.length > 0,
    });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Active sessions could not be loaded.",
      },
      { status: 503 },
    );
  }
}

/**
 * Sign out everywhere.
 *
 * Revokes every one of this person's sessions in place. The browser cookie is
 * cleared by `/api/auth/logout`, which owns the cookie; this owns the rows, so
 * the two together are what "sign out everywhere" means. Called on its own it
 * still does the load-bearing half: every stored token stops resolving.
 */
export async function POST(request: Request) {
  await ensureDatabase();
  try {
    const context = await scopedDb(request);
    const userId = await currentUserId(context.db, context.identityEmail);
    if (!userId) {
      return Response.json(
        { error: "This identity has no account record, so it has no sessions." },
        { status: 404 },
      );
    }

    const before = await context.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));

    if (before.length) {
      await context.db
        .update(sessions)
        .set({ revokedAt: sql`CURRENT_TIMESTAMP` })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    }

    return Response.json({ revoked: before.length });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "The sessions could not be revoked.",
      },
      { status: 503 },
    );
  }
}
