/**
 * WHO GETS A PHONE NOTIFICATION, AND WHAT IT SAYS.
 *
 * Four moments, chosen with the owner (2026-10-04) — the ones somebody away
 * from a desk would want to be told about:
 *
 *   · a NEW JOB is raised            → the workspace's coordinators;
 *   · a job's STATUS changes         → everybody who can see the job, and the
 *                                      contractor phones following its link;
 *   · an UPDATE is posted on a job   → the same, except whoever posted it;
 *   · a CONTRACTOR reports back      → the workspace's coordinators.
 *
 * Every recipient is re-checked here at send time, not trusted from when they
 * subscribed: a person must still hold an active membership (or be the owner
 * or platform staff) and, if their access is limited to some sites, the job
 * must be at one of them; a contractor link must still be unrevoked and
 * unexpired. Nothing here can fail the write that triggered it — every path
 * swallows its own errors — and nothing is sent when VAPID keys are absent.
 *
 * Notifications never carry a job link's token. A contractor's notification
 * opens `/app?ref=<job>`, and the app finds the job among the links already
 * saved on that phone (see app/lib/saved-jobs.ts).
 */

import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { getDb } from "../../db";
import {
  contractors,
  jobAccessTokens,
  maintenanceRequests,
  memberships,
  pushSubscriptions,
  users,
} from "../../db/schema";
import { parseSiteScope } from "./tenant-grants";
import { pushConfigured, sendPush, type PushMessage } from "./web-push";
import type { AutomationContext, AutomationEvent } from "./automations/types";
import { tellContractorAboutJob } from "./contractor-messaging";

type Database = Awaited<ReturnType<typeof getDb>>;
type SubscriptionRow = typeof pushSubscriptions.$inferSelect;

/** Roles that coordinate work and so hear about new jobs and contractor reports. */
const COORDINATOR_ROLES = new Set(["owner", "admin", "manager", "super_admin"]);

const MAX_PER_EVENT = 200;

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** One row per device and subject: subscribing twice is the same row. */
export async function subscriptionRowId(endpoint: string, subject: string) {
  return `push_${(await sha256Hex(`${endpoint}\n${subject}`)).slice(0, 40)}`;
}

/* ── Delivery ────────────────────────────────────────────────────────────── */

async function deliver(db: Database, rows: SubscriptionRow[], message: PushMessage, limit = MAX_PER_EVENT) {
  /* One phone subscribed twice (as a person AND to a job link) gets it once. */
  const seen = new Set<string>();
  const unique = rows.filter((row) => {
    if (seen.has(row.endpoint)) return false;
    seen.add(row.endpoint);
    return true;
  });
  let sent = 0;
  await Promise.allSettled(
    unique.slice(0, limit).map(async (row) => {
      const result = await sendPush(
        { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth },
        message,
      );
      if (result.ok) sent += 1;
      try {
        if (result.gone) {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, row.endpoint));
        } else if (result.ok) {
          await db
            .update(pushSubscriptions)
            .set({ lastSentAt: new Date().toISOString(), failures: 0 })
            .where(eq(pushSubscriptions.endpoint, row.endpoint));
        } else if (result.status) {
          await db
            .update(pushSubscriptions)
            .set({ failures: row.failures + 1 })
            .where(eq(pushSubscriptions.id, row.id));
        }
      } catch {
        /* Bookkeeping only. */
      }
    }),
  );
  return { sent, devices: Math.min(unique.length, limit) };
}

/* ── Recipients ──────────────────────────────────────────────────────────── */

type Job = {
  id: string;
  siteId: string | null;
  location: string;
  description: string;
  status: string;
  parentId: string | null;
  contractorId: string | null;
};

async function loadJob(db: Database, orgId: string, requestId: string): Promise<Job | null> {
  const [job] = await db
    .select({
      id: maintenanceRequests.id,
      siteId: maintenanceRequests.siteId,
      location: maintenanceRequests.location,
      description: maintenanceRequests.description,
      status: maintenanceRequests.status,
      parentId: maintenanceRequests.parentId,
      contractorId: maintenanceRequests.contractorId,
    })
    .from(maintenanceRequests)
    .where(
      and(
        eq(maintenanceRequests.id, requestId),
        eq(maintenanceRequests.organisationId, orgId),
        isNull(maintenanceRequests.deletedAt),
      ),
    )
    .limit(1);
  return job ?? null;
}

/**
 * The people in this workspace with notifications on who may see `job`.
 *
 * A subscriber with no membership row here is only kept when they are the
 * workspace's owner or platform staff — the two kinds of access that do not
 * come from a membership — which is decided by `users.role`.
 */
async function userRecipients(
  db: Database,
  orgId: string,
  job: Job | null,
  options: { coordinatorsOnly: boolean; excludeUserId?: string | null },
): Promise<SubscriptionRow[]> {
  const rows = await db
    .select()
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.organisationId, orgId), isNotNull(pushSubscriptions.userId)));
  if (!rows.length) return [];
  const userIds = [...new Set(rows.map((row) => row.userId as string))];
  const [memberRows, userRows] = await Promise.all([
    db
      .select({
        userId: memberships.userId,
        role: memberships.role,
        siteScope: memberships.siteScope,
        status: memberships.status,
      })
      .from(memberships)
      .where(and(eq(memberships.organisationId, orgId), inArray(memberships.userId, userIds))),
    db
      .select({ id: users.id, role: users.role, active: users.active })
      .from(users)
      .where(inArray(users.id, userIds)),
  ]);
  const membership = new Map(memberRows.map((row) => [row.userId, row]));
  const account = new Map(userRows.map((row) => [row.id, row]));

  return rows.filter((row) => {
    const userId = row.userId as string;
    if (options.excludeUserId && userId === options.excludeUserId) return false;
    const person = account.get(userId);
    if (!person || !person.active) return false;
    const member = membership.get(userId);
    let role: string;
    let scope: string[] | null = null;
    if (member) {
      if (member.status !== "active") return false;
      role = member.role;
      scope = parseSiteScope(member.siteScope);
    } else if (person.role === "owner" || person.role === "super_admin") {
      role = person.role;
    } else {
      return false;
    }
    if (options.coordinatorsOnly && !COORDINATOR_ROLES.has(role)) return false;
    if (scope && job && !(job.siteId && scope.includes(job.siteId))) return false;
    return true;
  });
}

/** Phones signed in to the contractor app as the contractor on this job. */
async function contractorAppRecipients(db: Database, job: Job) {
  if (!job.contractorId) return [];
  return db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.contractorId, job.contractorId));
}

/** Contractor phones following a still-valid link to this job. */
async function jobLinkRecipients(db: Database, orgId: string, requestId: string) {
  const rows = await db
    .select()
    .from(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.organisationId, orgId),
        eq(pushSubscriptions.requestId, requestId),
        isNotNull(pushSubscriptions.jobTokenId),
      ),
    );
  if (!rows.length) return [];
  const tokens = await db
    .select({
      id: jobAccessTokens.id,
      expiresAt: jobAccessTokens.expiresAt,
      revokedAt: jobAccessTokens.revokedAt,
    })
    .from(jobAccessTokens)
    .where(inArray(jobAccessTokens.id, rows.map((row) => row.jobTokenId as string)));
  const now = Date.now();
  const live = new Set(
    tokens
      .filter((token) => !token.revokedAt && new Date(token.expiresAt).getTime() >= now)
      .map((token) => token.id),
  );
  return rows.filter((row) => live.has(row.jobTokenId as string));
}

/* ── Messages ────────────────────────────────────────────────────────────── */

function shorten(text: string, max: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const STAFF_URL = "/dashboard/maintenance";
const contractorUrl = (job: Job) => `/app?ref=${encodeURIComponent(job.id)}`;
const CONTRACTOR_APP_URL = (job: Job) => `/contractor?job=${encodeURIComponent(job.id)}`;

function appOrigin() {
  const configured = process.env.PUBLIC_APP_ORIGIN?.trim();
  return configured && /^https?:\/\//.test(configured) ? configured.replace(/\/+$/, "") : "https://maintsupp.com";
}

/* ── The four moments ────────────────────────────────────────────────────── */

export async function notifyNewJob(db: Database, orgId: string, requestId: string) {
  if (!pushConfigured()) return;
  try {
    const job = await loadJob(db, orgId, requestId);
    if (!job || job.parentId) return;
    const people = await userRecipients(db, orgId, job, { coordinatorsOnly: true });
    await deliver(db, people, {
      title: `New job ${job.id} · ${shorten(job.location, 40)}`,
      body: shorten(job.description, 140),
      url: STAFF_URL,
      tag: `job-${job.id}`,
    });
  } catch (cause) {
    console.error("[push] new job", cause);
  }
}

export async function notifyStatusChange(
  db: Database,
  orgId: string,
  requestId: string,
  status: string,
  excludeUserId?: string | null,
) {
  if (!pushConfigured()) return;
  try {
    const job = await loadJob(db, orgId, requestId);
    if (!job) return;
    const title = `${job.id} · ${shorten(job.location, 40)}`;
    const body = `Status: ${status}`;
    const [people, phones, app] = await Promise.all([
      userRecipients(db, orgId, job, { coordinatorsOnly: false, excludeUserId }),
      jobLinkRecipients(db, orgId, job.id),
      contractorAppRecipients(db, job),
    ]);
    await Promise.all([
      deliver(db, people, { title, body, url: STAFF_URL, tag: `status-${job.id}` }),
      deliver(db, phones, { title, body, url: contractorUrl(job), tag: `status-${job.id}` }),
      deliver(db, app, { title, body, url: CONTRACTOR_APP_URL(job), tag: `status-${job.id}` }),
    ]);
  } catch (cause) {
    console.error("[push] status", cause);
  }
}

export async function notifyUpdate(
  db: Database,
  orgId: string,
  requestId: string,
  excludeUserId?: string | null,
) {
  if (!pushConfigured()) return;
  try {
    const job = await loadJob(db, orgId, requestId);
    if (!job) return;
    const title = `New update on ${job.id}`;
    const body = shorten(`${job.location}: ${job.description}`, 140);
    const [people, phones, app] = await Promise.all([
      userRecipients(db, orgId, job, { coordinatorsOnly: false, excludeUserId }),
      jobLinkRecipients(db, orgId, job.id),
      contractorAppRecipients(db, job),
    ]);
    await Promise.all([
      deliver(db, people, { title, body, url: STAFF_URL, tag: `update-${job.id}` }),
      deliver(db, phones, { title, body, url: contractorUrl(job), tag: `update-${job.id}` }),
      deliver(db, app, { title, body, url: CONTRACTOR_APP_URL(job), tag: `update-${job.id}` }),
    ]);
  } catch (cause) {
    console.error("[push] update", cause);
  }
}

export async function notifyContractorReport(
  db: Database,
  orgId: string,
  requestId: string,
  what: string,
) {
  if (!pushConfigured()) return;
  try {
    const job = await loadJob(db, orgId, requestId);
    if (!job) return;
    const people = await userRecipients(db, orgId, job, { coordinatorsOnly: true });
    await deliver(db, people, {
      title: `Contractor update · ${job.id}`,
      body: shorten(`${what} — ${job.location}`, 140),
      url: STAFF_URL,
      tag: `contractor-${job.id}`,
    });
  } catch (cause) {
    console.error("[push] contractor report", cause);
  }
}

/**
 * A CONTRACTOR SUBMITS THE JOB AS COMPLETE — its own notification, distinct
 * from "new job" and from ordinary updates (owner, 2026-10-04): the office is
 * told the work is done and ready to review, and the contractor's own phones
 * get a confirmation that the completion was received.
 */
export async function notifyContractorCompleted(db: Database, orgId: string, requestId: string) {
  if (!pushConfigured()) return;
  try {
    const job = await loadJob(db, orgId, requestId);
    if (!job) return;
    const [people, phones, app] = await Promise.all([
      userRecipients(db, orgId, job, { coordinatorsOnly: true }),
      jobLinkRecipients(db, orgId, job.id),
      contractorAppRecipients(db, job),
    ]);
    const place = shorten(job.location, 40);
    await Promise.all([
      deliver(db, people, {
        title: `✅ Job completed · ${job.id}`,
        body: `${place} — the contractor has submitted it as complete. Ready to review.`,
        url: STAFF_URL,
        tag: `completed-${job.id}`,
      }),
      deliver(db, phones, {
        title: `✅ Completion sent · ${job.id}`,
        body: `${place} — thank you. MAINTSUPP has received your completion.`,
        url: contractorUrl(job),
        tag: `completed-${job.id}`,
      }),
      deliver(db, app, {
        title: `✅ Completion sent · ${job.id}`,
        body: `${place} — thank you. MAINTSUPP has received your completion.`,
        url: CONTRACTOR_APP_URL(job),
        tag: `completed-${job.id}`,
      }),
    ]);
  } catch (cause) {
    console.error("[push] contractor completed", cause);
  }
}

/**
 * A JOB GIVEN TO A CONTRACTOR — the fifth moment (2026-10-04). Their app
 * alert, plus email, text or WhatsApp — whichever is connected and on their
 * record (app/lib/contractor-messaging.ts). Runs whether or not push is set
 * up, because email and text do not need it.
 */
export async function notifyContractorAssigned(db: Database, orgId: string, requestId: string) {
  try {
    const job = await loadJob(db, orgId, requestId);
    if (!job || !job.contractorId) return;
    const [contractor] = await db
      .select()
      .from(contractors)
      .where(and(eq(contractors.id, job.contractorId), eq(contractors.organisationId, orgId), eq(contractors.active, true)))
      .limit(1);
    if (!contractor) return;
    if (pushConfigured()) {
      await deliver(db, await contractorAppRecipients(db, job), {
        title: `New job ${job.id} · ${shorten(job.location, 40)}`,
        body: shorten(job.description, 140),
        url: CONTRACTOR_APP_URL(job),
        tag: `assigned-${job.id}`,
      });
    }
    await tellContractorAboutJob(db, contractor, job, `${appOrigin()}/contractor?job=${encodeURIComponent(job.id)}`);
  } catch (cause) {
    console.error("[push] contractor assigned", cause);
  }
}

/**
 * The automation dispatcher's events, turned into the moments above.
 *
 * Called once per originating write (depth 0). One job gets at most one
 * notification of each kind per write, however many events the write raised.
 */
export async function pushForEvents(ctx: AutomationContext, events: AutomationEvent[]) {
  if (!events.length) return;
  const done = new Set<string>();
  const exclude = ctx.actor.userId ?? null;
  for (const event of events) {
    if (!event.requestId) continue;
    const key = `${event.type}:${event.column ?? ""}:${event.requestId}`;
    if (done.has(key)) continue;
    /* A contractor named on a job hears about it — email and text need no push. */
    if (event.type === "column_changed" && event.column === "contractor" && event.to) {
      done.add(key);
      await notifyContractorAssigned(ctx.db, ctx.orgId, event.requestId);
      continue;
    }
    if (!pushConfigured()) continue;
    if (event.type === "item_created" && !event.parentId) {
      done.add(key);
      await notifyNewJob(ctx.db, ctx.orgId, event.requestId);
    } else if (event.type === "column_changed" && event.column === "status" && event.to) {
      done.add(key);
      await notifyStatusChange(ctx.db, ctx.orgId, event.requestId, event.to, exclude);
    } else if (event.type === "update_created") {
      done.add(key);
      await notifyUpdate(ctx.db, ctx.orgId, event.requestId, exclude);
    }
  }
}

/* ── Announcements ───────────────────────────────────────────────────────── */

export type AnnouncementAudience = "clients" | "contractors" | "both";

/** Phones signed in to the contractor app as an ACTIVE contractor of this workspace. */
async function workspaceContractorRecipients(db: Database, orgId: string) {
  const active = await db
    .select({ id: contractors.id })
    .from(contractors)
    .where(and(eq(contractors.organisationId, orgId), eq(contractors.active, true)));
  if (!active.length) return [];
  return db
    .select()
    .from(pushSubscriptions)
    .where(inArray(pushSubscriptions.contractorId, active.map((row) => row.id)));
}

/** Contractor phones following any still-valid job link in this workspace. */
async function workspaceJobLinkRecipients(db: Database, orgId: string) {
  const rows = await db
    .select()
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.organisationId, orgId), isNotNull(pushSubscriptions.jobTokenId)));
  if (!rows.length) return [];
  const tokens = await db
    .select({ id: jobAccessTokens.id, expiresAt: jobAccessTokens.expiresAt, revokedAt: jobAccessTokens.revokedAt })
    .from(jobAccessTokens)
    .where(inArray(jobAccessTokens.id, rows.map((row) => row.jobTokenId as string)));
  const now = Date.now();
  const live = new Set(
    tokens.filter((token) => !token.revokedAt && new Date(token.expiresAt).getTime() >= now).map((token) => token.id),
  );
  return rows.filter((row) => live.has(row.jobTokenId as string));
}

/**
 * Who an announcement reaches, per phone. "Clients" is everybody signed in to
 * this workspace's portal with alerts on (re-checked exactly as job alerts
 * are); "Contractors" is the contractor app plus contractor job-link phones.
 */
export async function announcementRecipients(db: Database, orgId: string, audience: AnnouncementAudience) {
  const rows: SubscriptionRow[] = [];
  if (audience !== "contractors") rows.push(...(await userRecipients(db, orgId, null, { coordinatorsOnly: false })));
  if (audience !== "clients") {
    rows.push(...(await workspaceContractorRecipients(db, orgId)));
    rows.push(...(await workspaceJobLinkRecipients(db, orgId)));
  }
  return rows;
}

export async function countAnnouncementReach(db: Database, orgId: string) {
  const unique = (rows: SubscriptionRow[]) => new Set(rows.map((row) => row.endpoint)).size;
  const [clients, contractorRows] = await Promise.all([
    announcementRecipients(db, orgId, "clients"),
    announcementRecipients(db, orgId, "contractors"),
  ]);
  return {
    clients: unique(clients),
    contractors: unique(contractorRows),
    both: unique([...clients, ...contractorRows]),
  };
}

/** Sends one announcement. Contractors open their jobs; everybody else the dashboard. */
export async function sendAnnouncement(
  db: Database,
  orgId: string,
  input: { audience: AnnouncementAudience; title: string; body: string },
) {
  const message = (url: string): PushMessage => ({
    title: shorten(input.title, 80),
    body: shorten(input.body, 240),
    url,
    tag: `announcement-${Date.now()}`,
  });
  let sent = 0;
  let devices = 0;
  if (input.audience !== "contractors") {
    const people = await announcementRecipients(db, orgId, "clients");
    const result = await deliver(db, people, message("/dashboard"), 2000);
    sent += result.sent;
    devices += result.devices;
  }
  if (input.audience !== "clients") {
    const already = new Set<string>();
    if (input.audience === "both") {
      for (const row of await announcementRecipients(db, orgId, "clients")) already.add(row.endpoint);
    }
    const phones = (await announcementRecipients(db, orgId, "contractors")).filter((row) => !already.has(row.endpoint));
    const appPhones = phones.filter((row) => row.contractorId);
    const linkPhones = phones.filter((row) => !row.contractorId);
    const a = await deliver(db, appPhones, message("/contractor"), 2000);
    const b = await deliver(db, linkPhones, message("/app"), 2000);
    sent += a.sent + b.sent;
    devices += a.devices + b.devices;
  }
  return { sent, devices };
}
