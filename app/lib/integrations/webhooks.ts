/**
 * §35b — OUTBOUND WEBHOOKS: which events, how they are queued, signed, sent,
 * retried and given up on.
 *
 * THE EVENTS. `job.created` and `job.status_changed`, raised from ONE place —
 * `recordJobStatusChanges`, which every door that creates or moves a job already
 * calls (§23) — so a webhook cannot depend on which screen somebody used. An
 * import is not an event (a thousand rows at once is a migration, not news), and
 * rows that are not jobs on the Jobs board (register rows, subitems, binned
 * jobs) are never sent. `ping` is the test button.
 *
 * WHAT IS SENT is an allowlist: the job's id, reference, title, status, stage,
 * priority, category, site id, location and dates — never contacts, requester,
 * description, costs or anything a receiver could not already be trusted with.
 * A receiver that needs more reads `/api/v1` with a token.
 *
 * DELIVERY. A row per (event, endpoint) is written first — UNIQUE on the pair,
 * so one event is never queued twice for one receiver — then sent straight
 * away with a short timeout. What fails is retried after 1 min, 5 min, 30 min,
 * 2 h, 12 h and 24 h, and abandoned after eight attempts. Retries are driven by
 * the next event in the same workspace, by the daily run (`/api/cron/daily`),
 * and by the Retry button — there is no dedicated scheduler, and the screen says
 * so. A `410 Gone`, or fifteen failures in a row, switches the endpoint off.
 *
 * NOTHING SECRET IS LOGGED. The URL and signing secret live only as secret-box
 * envelopes; errors are fixed phrases; the console gets an error's NAME only.
 * Every function here swallows its own failures: a webhook must never fail the
 * job change that raised it.
 */

import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { getDb } from "../../../db";
import { maintenanceRequests, webhookDeliveries, webhookEndpoints } from "../../../db/schema";
import { jobsBoardCondition } from "../dashboard-filters";
import type { StatusChange } from "../job-status-history";
import { openSecret, SecretBoxUnavailableError } from "../secret-box";
import { defaultTransport, type Transport } from "./outbound-http";
import { slackMessage } from "./slack";
import { signWebhook } from "./webhook-signature";

type Database = Awaited<ReturnType<typeof getDb>>;

export const WEBHOOK_EVENTS = {
  "job.created": "A job is created",
  "job.status_changed": "A job's status changes",
} as const;

export type WebhookEvent = keyof typeof WEBHOOK_EVENTS;

export function isWebhookEvent(value: unknown): value is WebhookEvent {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(WEBHOOK_EVENTS, value);
}

export function readEvents(stored: string | null | undefined): WebhookEvent[] {
  try {
    const parsed = JSON.parse(stored ?? "[]") as unknown;
    return Array.isArray(parsed) ? [...new Set(parsed.filter(isWebhookEvent))] : [];
  } catch {
    return [];
  }
}

/** Delay before retry N (N = attempts already made), or null to give up. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000];
export const MAX_ATTEMPTS = 8;
export const DISABLE_AFTER_FAILURES = 15;
export const INLINE_TIMEOUT_MS = 3_000;
export const RETRY_TIMEOUT_MS = 8_000;
const INLINE_MAX = 3;
const DRAIN_ON_EVENT = 5;
const CLAIM_MS = 30_000;

/** What the screen says about retries — true of `retryDelay` and the drivers below. */
export const RETRY_POLICY =
  `A failed delivery is retried after 1 minute, 5 minutes, 30 minutes, 2 hours, 12 hours and 24 hours, ` +
  `and given up after ${MAX_ATTEMPTS} attempts. There is no separate scheduler: retries run when the ` +
  `next event in this workspace is sent, in the daily run at 05:40 UTC, or when you press Retry. ` +
  `A 410 Gone answer, or 15 failures in a row, switches the endpoint off.`;

export function retryDelay(attemptsMade: number): number | null {
  if (attemptsMade >= MAX_ATTEMPTS) return null;
  return RETRY_DELAYS_MS[Math.min(Math.max(attemptsMade - 1, 0), RETRY_DELAYS_MS.length - 1)];
}

export type JobEvent = {
  type: WebhookEvent;
  requestId: string;
  change?: { field: "status"; from: string | null; to: string | null };
};

const CREATING_SOURCES = new Set(["board.create", "board.duplicate"]);

/** The webhook events one recorded batch of transitions amounts to. */
export function classifyJobEvents(source: string, changes: readonly StatusChange[]): JobEvent[] {
  if (source === "import") return [];
  if (source.startsWith("created:") || CREATING_SOURCES.has(source)) {
    return [...new Set(changes.map((change) => change.requestId))].map((requestId) => ({ type: "job.created", requestId }));
  }
  return changes
    .filter((change) => change.field === "status" && change.from !== change.to)
    .map((change) => ({
      type: "job.status_changed",
      requestId: change.requestId,
      change: { field: "status", from: change.from, to: change.to },
    }));
}

type JobRow = Pick<
  typeof maintenanceRequests.$inferSelect,
  | "id"
  | "reference"
  | "title"
  | "status"
  | "stage"
  | "priority"
  | "category"
  | "siteId"
  | "location"
  | "requestedAt"
  | "dueAt"
  | "completedAt"
>;

/** The allowlisted job a payload carries. */
export function webhookJob(row: JobRow) {
  return {
    id: row.id,
    reference: row.reference ?? row.id,
    title: row.title,
    status: row.status ?? null,
    stage: row.stage ?? null,
    priority: row.priority ?? null,
    category: row.category ?? null,
    siteId: row.siteId ?? null,
    location: row.location ?? null,
    requestedAt: row.requestedAt ?? null,
    dueAt: row.dueAt ?? null,
    completedAt: row.completedAt ?? null,
  };
}

export function eventPayload(input: {
  eventId: string;
  type: WebhookEvent | "ping";
  organisationId: string;
  createdAt: string;
  job?: ReturnType<typeof webhookJob>;
  change?: JobEvent["change"];
}) {
  return JSON.stringify({
    id: input.eventId,
    type: input.type,
    createdAt: input.createdAt,
    workspace: { id: input.organisationId },
    data: {
      ...(input.job ? { job: input.job } : {}),
      ...(input.change ? { change: input.change } : {}),
      ...(input.type === "ping" ? { message: "A test event from MAINTSUPP." } : {}),
    },
  });
}

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
const errorName = (error: unknown) => (error instanceof Error ? error.name : "error");

/**
 * Queue and send the webhooks one batch of job transitions raises. Never throws.
 * With no subscribed endpoint this is one indexed read.
 */
export async function emitJobEvents(
  db: Database,
  input: { organisationId: string; source: string; changes: readonly StatusChange[] },
  transport: Transport = defaultTransport,
) {
  try {
    const events = classifyJobEvents(input.source, input.changes);
    if (!events.length) return;
    const endpoints = (
      await db
        .select({ id: webhookEndpoints.id, events: webhookEndpoints.events })
        .from(webhookEndpoints)
        .where(and(eq(webhookEndpoints.organisationId, input.organisationId), eq(webhookEndpoints.state, "on")))
    ).map((endpoint) => ({ id: endpoint.id, events: readEvents(endpoint.events) }));
    const wanted = endpoints.filter((endpoint) => events.some((event) => endpoint.events.includes(event.type)));
    if (!wanted.length) return;

    /* In chunks: D1 refuses a statement with more than ~100 bound values, and a
       bulk move can carry hundreds of jobs. */
    const ids = [...new Set(events.map((event) => event.requestId))].slice(0, 500);
    const rows: JobRow[] = [];
    for (let index = 0; index < ids.length; index += 80) {
      rows.push(
        ...(await db
          .select({
            id: maintenanceRequests.id,
            reference: maintenanceRequests.reference,
            title: maintenanceRequests.title,
            status: maintenanceRequests.status,
            stage: maintenanceRequests.stage,
            priority: maintenanceRequests.priority,
            category: maintenanceRequests.category,
            siteId: maintenanceRequests.siteId,
            location: maintenanceRequests.location,
            requestedAt: maintenanceRequests.requestedAt,
            dueAt: maintenanceRequests.dueAt,
            completedAt: maintenanceRequests.completedAt,
          })
          .from(maintenanceRequests)
          .where(
            and(
              eq(maintenanceRequests.organisationId, input.organisationId),
              inArray(maintenanceRequests.id, ids.slice(index, index + 80)),
              isNull(maintenanceRequests.deletedAt),
              isNull(maintenanceRequests.parentId),
              jobsBoardCondition(),
            ),
          )),
      );
    }
    const jobs = new Map(rows.map((row) => [row.id, webhookJob(row)]));

    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const queued: string[] = [];
    for (const event of events) {
      const job = jobs.get(event.requestId);
      if (!job) continue;
      const eventId = newId("evt");
      const payload = eventPayload({ eventId, type: event.type, organisationId: input.organisationId, createdAt, job, change: event.change });
      for (const endpoint of wanted.filter((item) => item.events.includes(event.type))) {
        const id = newId("whd");
        await db
          .insert(webhookDeliveries)
          .values({
            id,
            organisationId: input.organisationId,
            endpointId: endpoint.id,
            eventId,
            eventType: event.type,
            payload,
            status: "pending",
            attempts: 0,
            nextAttemptAt: now,
            claimedUntil: 0,
            createdAt,
            updatedAt: createdAt,
          })
          .onConflictDoNothing();
        queued.push(id);
      }
    }

    /* Straight away, but briefly: the job change is waiting on this. */
    await Promise.all(queued.slice(0, INLINE_MAX).map((id) => attemptDelivery(db, id, input.organisationId, transport, INLINE_TIMEOUT_MS)));
    /* And the backlog this workspace already had, a little at a time. */
    await retryWebhookDeliveries(db, { organisationId: input.organisationId, limit: DRAIN_ON_EVENT, budgetMs: INLINE_TIMEOUT_MS, transport });
  } catch (error) {
    console.error("[webhooks] events could not be queued:", errorName(error));
  }
}

type EndpointRow = typeof webhookEndpoints.$inferSelect;

async function endpointCredentials(endpoint: EndpointRow) {
  const url = await openSecret(endpoint.urlSealed, {
    purpose: "webhook.url",
    organisationId: endpoint.organisationId,
    recordId: endpoint.id,
  });
  const secret = endpoint.secretSealed
    ? await openSecret(endpoint.secretSealed, {
        purpose: "webhook.secret",
        organisationId: endpoint.organisationId,
        recordId: endpoint.id,
      })
    : null;
  return { url, secret };
}

/** The request one delivery becomes: signed JSON for a webhook, a message for Slack. */
export async function buildRequest(
  endpoint: Pick<EndpointRow, "kind">,
  credentials: { url: string; secret: string | null },
  delivery: { eventId: string; eventType: string; payload: string; attempts: number },
  origin: string | null,
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "MAINTSUPP-Webhooks/1",
  };
  if (endpoint.kind === "slack") {
    return { url: credentials.url, headers, body: JSON.stringify(slackMessage(JSON.parse(delivery.payload), origin)) };
  }
  headers["maintsupp-event-id"] = delivery.eventId;
  headers["maintsupp-event-type"] = delivery.eventType;
  headers["maintsupp-delivery-attempt"] = String(delivery.attempts);
  if (credentials.secret) headers["maintsupp-signature"] = await signWebhook(credentials.secret, delivery.payload);
  return { url: credentials.url, headers, body: delivery.payload };
}

function configuredOrigin() {
  const value = ((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)
    ?.env?.PUBLIC_APP_ORIGIN;
  try {
    return value ? new URL(value).origin : null;
  } catch {
    return null;
  }
}

export type DeliveryOutcome = "delivered" | "failed" | "abandoned" | "skipped";

/**
 * Claims one delivery and sends it. The claim is one conditional UPDATE, so two
 * runs racing for the same row cannot both send it.
 */
export async function attemptDelivery(
  db: Database,
  deliveryId: string,
  organisationId: string,
  transport: Transport = defaultTransport,
  timeoutMs = RETRY_TIMEOUT_MS,
): Promise<DeliveryOutcome> {
  try {
    const now = Date.now();
    const [pending] = await db
      .select({ endpointId: webhookDeliveries.endpointId })
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.organisationId, organisationId)))
      .limit(1);
    if (!pending) return "skipped";
    const [endpoint] = await db
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.id, pending.endpointId), eq(webhookEndpoints.organisationId, organisationId)))
      .limit(1);
    /* A paused endpoint's deliveries wait; a disabled or deleted one's never go. */
    if (!endpoint || endpoint.state !== "on") return "skipped";

    const stamp = new Date(now).toISOString();
    const [claimed] = await db
      .update(webhookDeliveries)
      .set({
        status: "delivering",
        claimedUntil: now + CLAIM_MS,
        attempts: sql`${webhookDeliveries.attempts} + 1`,
        lastAttemptAt: stamp,
        updatedAt: stamp,
      })
      .where(
        and(
          eq(webhookDeliveries.id, deliveryId),
          eq(webhookDeliveries.organisationId, organisationId),
          inArray(webhookDeliveries.status, ["pending", "failed"]),
          sql`${webhookDeliveries.claimedUntil} < ${now}`,
        ),
      )
      .returning();
    if (!claimed) return "skipped";

    let result: Awaited<ReturnType<Transport>>;
    try {
      const credentials = await endpointCredentials(endpoint);
      const request = await buildRequest(endpoint, credentials, claimed, configuredOrigin());
      result = await transport({ ...request, timeoutMs });
    } catch (error) {
      result = {
        error:
          error instanceof SecretBoxUnavailableError
            ? "Credential storage is not configured on this deployment, so the address cannot be read."
            : "The stored address could not be read.",
      };
    }

    const status = "status" in result ? result.status : null;
    const delivered = status !== null && status >= 200 && status < 300;
    const excerpt = "excerpt" in result ? result.excerpt.slice(0, 500) : null;
    const done = new Date().toISOString();
    if (delivered) {
      await db
        .update(webhookDeliveries)
        .set({ status: "delivered", responseStatus: status, responseExcerpt: excerpt, error: null, claimedUntil: 0, updatedAt: done })
        .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.organisationId, organisationId)));
      await db
        .update(webhookEndpoints)
        .set({ consecutiveFailures: 0, lastOutcome: "delivered", lastDeliveredAt: done, updatedAt: done })
        .where(and(eq(webhookEndpoints.id, endpoint.id), eq(webhookEndpoints.organisationId, organisationId)));
      return "delivered";
    }

    const reason =
      "error" in result
        ? result.error
        : status !== null && status >= 300 && status < 400
          ? `The receiver answered ${status} (a redirect); redirects are not followed.`
          : `The receiver answered ${status}.`;
    const gone = status === 410;
    const delay = retryDelay(claimed.attempts);
    const giveUp = gone || delay === null;
    await db
      .update(webhookDeliveries)
      .set({
        status: giveUp ? "abandoned" : "failed",
        nextAttemptAt: giveUp ? 0 : Date.now() + delay!,
        claimedUntil: 0,
        responseStatus: status,
        responseExcerpt: excerpt,
        error: reason,
        updatedAt: done,
      })
      .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.organisationId, organisationId)));
    const failures = endpoint.consecutiveFailures + 1;
    const disable = gone || failures >= DISABLE_AFTER_FAILURES;
    await db
      .update(webhookEndpoints)
      .set({
        consecutiveFailures: failures,
        lastOutcome: "failed",
        updatedAt: done,
        ...(disable
          ? {
              state: "disabled",
              stateReason: gone
                ? "The receiver answered 410 Gone, so this endpoint was switched off."
                : `Switched off after ${DISABLE_AFTER_FAILURES} failed deliveries in a row.`,
            }
          : {}),
      })
      .where(and(eq(webhookEndpoints.id, endpoint.id), eq(webhookEndpoints.organisationId, organisationId)));
    return giveUp ? "abandoned" : "failed";
  } catch (error) {
    console.error("[webhooks] a delivery could not be attempted:", errorName(error));
    return "skipped";
  }
}

/**
 * Sends what is due. Scoped to one workspace (after an event) or all of them
 * (the daily run), within a time budget. Also prunes delivered rows older than
 * 30 days, so the log is a working record rather than an archive.
 */
export async function retryWebhookDeliveries(
  db: Database,
  options: { organisationId?: string; limit?: number; budgetMs?: number; transport?: Transport; now?: number } = {},
) {
  const started = Date.now();
  const now = options.now ?? started;
  const summary = { attempted: 0, delivered: 0, failed: 0, abandoned: 0 };
  try {
    /* Only endpoints that are on: a paused one's deliveries wait, a disabled or
       deleted one's are never sent, and neither should be re-read every run. */
    const due = await db
      .select({ id: webhookDeliveries.id, organisationId: webhookDeliveries.organisationId })
      .from(webhookDeliveries)
      .innerJoin(
        webhookEndpoints,
        and(eq(webhookEndpoints.id, webhookDeliveries.endpointId), eq(webhookEndpoints.organisationId, webhookDeliveries.organisationId)),
      )
      .where(
        and(
          eq(webhookEndpoints.state, "on"),
          inArray(webhookDeliveries.status, ["pending", "failed"]),
          lte(webhookDeliveries.nextAttemptAt, now),
          ...(options.organisationId ? [eq(webhookDeliveries.organisationId, options.organisationId)] : []),
        ),
      )
      .orderBy(asc(webhookDeliveries.nextAttemptAt))
      .limit(options.limit ?? 100);
    for (const row of due) {
      if (Date.now() - started > (options.budgetMs ?? 20_000)) break;
      const outcome = await attemptDelivery(db, row.id, row.organisationId, options.transport ?? defaultTransport, RETRY_TIMEOUT_MS);
      if (outcome === "skipped") continue;
      summary.attempted += 1;
      summary[outcome] += 1;
    }
    if (!options.organisationId) {
      const cutoff = new Date(now - 30 * 86_400_000).toISOString();
      await db
        .delete(webhookDeliveries)
        .where(and(eq(webhookDeliveries.status, "delivered"), sql`${webhookDeliveries.lastAttemptAt} < ${cutoff}`));
    }
  } catch (error) {
    console.error("[webhooks] the retry run failed:", errorName(error));
  }
  return summary;
}

/** An endpoint as a screen sees it: never the sealed columns. */
export const ENDPOINT_COLUMNS = {
  id: webhookEndpoints.id,
  kind: webhookEndpoints.kind,
  name: webhookEndpoints.name,
  urlHost: webhookEndpoints.urlHost,
  urlHint: webhookEndpoints.urlHint,
  secretHint: webhookEndpoints.secretHint,
  events: webhookEndpoints.events,
  state: webhookEndpoints.state,
  stateReason: webhookEndpoints.stateReason,
  consecutiveFailures: webhookEndpoints.consecutiveFailures,
  createdByEmail: webhookEndpoints.createdByEmail,
  lastOutcome: webhookEndpoints.lastOutcome,
  lastDeliveredAt: webhookEndpoints.lastDeliveredAt,
  createdAt: webhookEndpoints.createdAt,
};

export async function listEndpoints(db: Database, organisationId: string) {
  const rows = await db
    .select(ENDPOINT_COLUMNS)
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.organisationId, organisationId), sql`${webhookEndpoints.state} <> 'deleted'`))
    .orderBy(desc(webhookEndpoints.createdAt));
  return rows.map((row) => ({ ...row, events: readEvents(row.events) }));
}

export async function listDeliveries(db: Database, organisationId: string, endpointId: string, limit = 50) {
  return db
    .select({
      id: webhookDeliveries.id,
      eventId: webhookDeliveries.eventId,
      eventType: webhookDeliveries.eventType,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      nextAttemptAt: webhookDeliveries.nextAttemptAt,
      lastAttemptAt: webhookDeliveries.lastAttemptAt,
      responseStatus: webhookDeliveries.responseStatus,
      error: webhookDeliveries.error,
      createdAt: webhookDeliveries.createdAt,
    })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.organisationId, organisationId), eq(webhookDeliveries.endpointId, endpointId)))
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(limit);
}

/** Queues and sends one `ping` to one endpoint — the Test button. */
export async function sendTestEvent(db: Database, organisationId: string, endpointId: string, transport: Transport = defaultTransport) {
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const eventId = newId("evt");
  const id = newId("whd");
  await db.insert(webhookDeliveries).values({
    id,
    organisationId,
    endpointId,
    eventId,
    eventType: "ping",
    payload: eventPayload({ eventId, type: "ping", organisationId, createdAt }),
    status: "pending",
    attempts: 0,
    nextAttemptAt: now,
    claimedUntil: 0,
    createdAt,
    updatedAt: createdAt,
  });
  const outcome = await attemptDelivery(db, id, organisationId, transport, RETRY_TIMEOUT_MS);
  const [row] = await db
    .select({ status: webhookDeliveries.status, responseStatus: webhookDeliveries.responseStatus, error: webhookDeliveries.error })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.organisationId, organisationId)))
    .limit(1);
  return { deliveryId: id, outcome, ...row };
}
