import { eq } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import { getDb } from "../../../db";
import { pushSubscriptions } from "../../../db/schema";
import { resolveJobToken } from "../../lib/job-tokens";
import { subscriptionRowId } from "../../lib/push-notify";
import { scopedDb } from "../../lib/tenant-db";
import { pushConfigured, sendPush, vapidPublicKey } from "../../lib/web-push";

export const dynamic = "force-dynamic";

/**
 * /api/push — the installed app switching phone notifications on and off.
 *
 *   GET     whether notifications are available, and the public key a browser
 *           subscribes with;
 *   POST    { subscription, jobTokens? } — this device, for the signed-in
 *           person (if any) in the workspace they are looking at, and for each
 *           contractor job link saved on the phone that still opens;
 *           `?test=1` instead sends this device a test notification;
 *   DELETE  { endpoint } — this device, everywhere.
 *
 * A contractor has no account, so a job link IS their authority: a token that
 * does not resolve (wrong, revoked, expired) subscribes to nothing. A person's
 * subscription is only ever for the workspace their own session resolved, and
 * who actually receives what is re-checked at send time (app/lib/push-notify.ts).
 */

function bad(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

type Subscription = { endpoint: string; p256dh: string; auth: string };

function readSubscription(value: unknown): Subscription | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof raw.endpoint === "string" ? raw.endpoint.trim() : "";
  const p256dh = typeof raw.keys?.p256dh === "string" ? raw.keys.p256dh.trim() : "";
  const auth = typeof raw.keys?.auth === "string" ? raw.keys.auth.trim() : "";
  if (!endpoint || endpoint.length > 1000 || !p256dh || p256dh.length > 200 || !auth || auth.length > 100) {
    return null;
  }
  try {
    if (new URL(endpoint).protocol !== "https:") return null;
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(p256dh) || !/^[A-Za-z0-9_-]+$/.test(auth)) return null;
  return { endpoint, p256dh, auth };
}

export async function GET() {
  return Response.json({ configured: pushConfigured(), publicKey: vapidPublicKey() });
}

export async function POST(request: Request) {
  if (!pushConfigured()) return bad("Notifications are not set up on this server yet.", 503);
  try {
    await ensureDatabase();
    const body = (await request.json().catch(() => ({}))) as {
      subscription?: unknown;
      jobTokens?: unknown;
    };
    const subscription = readSubscription(body.subscription);
    if (!subscription) return bad("That is not a valid notification subscription.");
    const db = await getDb();

    /* A test: only for a device that is already subscribed to something. */
    if (new URL(request.url).searchParams.get("test")) {
      const rows = await db
        .select({ id: pushSubscriptions.id })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, subscription.endpoint))
        .limit(1);
      if (!rows.length) return bad("Turn notifications on first.", 404);
      const result = await sendPush(subscription, {
        title: "MAINTSUPP notifications are on",
        body: "You'll be told about new jobs, status changes and updates here.",
        url: "/app?source=installed",
        tag: "maintsupp-test",
      });
      return Response.json({ sent: result.ok, status: result.status });
    }

    const userAgent = request.headers.get("user-agent")?.slice(0, 300) ?? null;
    const rows: Array<typeof pushSubscriptions.$inferInsert> = [];

    /* The signed-in person, in the workspace their session is looking at. */
    try {
      const scope = await scopedDb(request);
      const userId = scope.session?.user.id;
      if (scope.authenticated && userId) {
        rows.push({
          id: await subscriptionRowId(subscription.endpoint, `user:${userId}:${scope.orgId}`),
          organisationId: scope.orgId,
          userId,
          jobTokenId: null,
          requestId: null,
          ...subscription,
          userAgent,
        });
      }
    } catch {
      /* Not signed in: a contractor phone, subscribed through its job links. */
    }

    /* Each saved job link that still opens. */
    const tokens = Array.isArray(body.jobTokens)
      ? [...new Set(body.jobTokens.filter((value): value is string => typeof value === "string"))].slice(0, 50)
      : [];
    for (const token of tokens) {
      const scope = await resolveJobToken(db, token);
      if (!scope) continue;
      rows.push({
        id: await subscriptionRowId(subscription.endpoint, `job:${scope.id}`),
        organisationId: scope.organisationId,
        userId: null,
        jobTokenId: scope.id,
        requestId: scope.requestId,
        ...subscription,
        userAgent,
      });
    }

    if (!rows.length) {
      return bad("Sign in, or open one of your job links first, so we know what to notify you about.", 409);
    }
    for (const row of rows) {
      await db
        .insert(pushSubscriptions)
        .values(row)
        .onConflictDoUpdate({
          target: pushSubscriptions.id,
          set: { p256dh: row.p256dh, auth: row.auth, userAgent: row.userAgent, failures: 0 },
        });
    }
    return Response.json({
      ok: true,
      account: rows.some((row) => row.userId),
      jobs: rows.filter((row) => row.jobTokenId).length,
    });
  } catch (error) {
    console.error("[push] subscribe failed", error);
    return bad("Notifications could not be switched on right now. Try again in a minute.", 503);
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const body = (await request.json().catch(() => ({}))) as { endpoint?: unknown };
    const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
    if (!endpoint) return bad("Which device?");
    const db = await getDb();
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
    return Response.json({ ok: true });
  } catch {
    return bad("Notifications could not be switched off right now.", 503);
  }
}
