import { and, eq, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import { activityLog, maintenanceRequests, sites } from "../../../db/schema";
import { exposeRequest } from "../../lib/request-payload";
import {
  jobAlertTemplate,
  notificationTargets,
  sendNotification,
} from "../../lib/notifications";
import { configuredValue } from "../../lib/options-repository";
import { priorityRule } from "../../lib/priority-rules";
import { PRIMARY_ORGANISATION_ID, scopedDb } from "../../lib/tenant-db";

export const dynamic = "force-dynamic";

/**
 * The website's own "Report a job" form.
 *
 * WHY THIS IS NOT `/api/maintenance`
 *
 * That route requires `board.edit`, and it is right to: it is the authenticated
 * "raise a job" endpoint used from inside the product, and loosening it would
 * make every board in every tenant writable by anyone who could guess a
 * payload. The marketing form posted to it anyway, so a logged-out visitor —
 * which is every visitor — got `401 Your session has ended`. The form could
 * never submit.
 *
 * WHY NOT `/api/forms/[token]/submit` EITHER
 *
 * That is the other public path, and it is the right one for a SHARED LINK: the
 * tenant comes from the form, and the questions are data an operator edits in
 * the builder. This form is neither — its fields are fixed in the page, and
 * routing it through a builder form would mean the home page silently breaking
 * the day somebody hid a question.
 *
 * So this is a third, deliberately narrow surface, and the narrowness is the
 * security argument:
 *
 *   · the tenant is PINNED. It is never read from the payload and never from a
 *     cookie, so no request can steer a job into another workspace;
 *   · every field is length-capped and validated here, not only in the browser;
 *   · `priority` and `engineer` are canonicalised through the organisation's
 *     own option registry, so an arbitrary string cannot invent a board value
 *     or buy itself a shorter SLA;
 *   · `source` is "Website form", which is what tells a coordinator this came
 *     from outside and nobody has vetted it.
 *
 * It writes one work order and nothing else. See the matching note in
 * app/api/forms/[token]/submit/route.ts — three routes now create a job, and
 * whoever changes the shape of one should look at the other two.
 */

function trimString(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Matches the digest `/api/files` computes when it verifies an upload token. */
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function requestTitle(description: string) {
  const firstLine = description.split(/[.!?\n]/)[0]?.trim() || "Maintenance request";
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}…` : firstLine;
}

type PublicDatabase = Awaited<ReturnType<typeof scopedDb>>["db"];

/**
 * The site a public report belongs to.
 *
 * The form asks for a site by NAME in a free-text box, because the alternative
 * — a picker — would publish the list of every site under contract to anyone
 * who loaded the home page.
 *
 * A typed name will therefore sometimes match nothing, and `site_id` is NOT
 * NULL, so the choice is between refusing the report and filing it somewhere a
 * coordinator can find it. Refusing is the wrong answer: a shop with water
 * coming through the ceiling, typing "Oxford St" where the row says "Sunnamusk
 * Oxford Street", would be turned away. An unmatched name therefore lands on a
 * single standing intake site, with what they actually typed preserved in
 * `location` so the job can be reassigned in one edit.
 */
async function resolveSite(db: PublicDatabase, orgId: string, location: string) {
  const [exact] = await db
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.name, location), eq(sites.organisationId, orgId)))
    .limit(1);
  if (exact) return exact.id;

  const [loose] = await db
    .select({ id: sites.id })
    .from(sites)
    .where(
      and(eq(sites.organisationId, orgId), sql`lower(${sites.name}) = lower(${location})`),
    )
    .limit(1);
  if (loose) return loose.id;

  const intakeId = `site-website-intake-${orgId}`;
  const [existing] = await db
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.id, intakeId), eq(sites.organisationId, orgId)))
    .limit(1);
  if (existing) return existing.id;

  await db.insert(sites).values({
    id: intakeId,
    organisationId: orgId,
    name: "Unmatched website reports",
    type: "Intake",
    address: "Reported from the website — reassign to the correct site",
    lifecycle: "Current",
    status: "active",
    position: 9999,
  });
  return intakeId;
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const payload = (await request.json()) as Record<string, unknown>;

    const location = trimString(payload.location, 120);
    const requester = trimString(payload.requester, 120);
    const contact = trimString(payload.contact, 80);
    const description = trimString(payload.description, 2000);
    const category = trimString(payload.category, 80) || "Other";

    if (!location || !requester || !contact || description.length < 10) {
      return Response.json(
        { error: "Site, your name, a contact number and a description are all required." },
        { status: 400 },
      );
    }

    // The website form has no account behind it by definition — the same
    // exemption the public lead form takes, and for the same reason.
    const { db, orgId: resolvedOrg } = await scopedDb(request, { allowAnonymous: true });
    // PINNED. An anonymous caller resolves to the primary tenant anyway; this
    // makes it true regardless of what any cookie on the request claims.
    const orgId = PRIMARY_ORGANISATION_ID || resolvedOrg;

    const priority = await configuredValue(db, orgId, "priority", payload.priority);
    const engineer = await configuredValue(db, orgId, "engineer_required", payload.engineer);
    const siteId = await resolveSite(db, orgId, location);

    const [latest] = await db
      .select({
        maxNumber: sql<number>`coalesce(max(cast(substr(${maintenanceRequests.id}, 4) as integer)), 1048)`,
      })
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.organisationId, orgId),
          sql`${maintenanceRequests.id} like 'MN-%'`,
        ),
      );
    const id = `MN-${Number(latest.maxNumber ?? 1048) + 1}`;

    const slaRule = priorityRule(priority);
    const dueAt = new Date(Date.now() + slaRule.dueHours * 60 * 60 * 1000).toISOString();

    /*
     * The single-use grant that lets the reporter attach the photographs they
     * were just told were mandatory. Only the HASH is stored, and it expires in
     * thirty minutes — long enough for a few phone videos over a shop's wifi,
     * dead long before it is worth anything out of a browser history.
     * `/api/files` already knows how to accept it.
     */
    const uploadToken = crypto.randomUUID().replace(/-/g, "");
    const uploadTokenHash = await sha256(uploadToken);
    const uploadTokenExpiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    const [created] = await db
      .insert(maintenanceRequests)
      .values({
        id,
        organisationId: orgId,
        siteId,
        source: "Website form",
        title: requestTitle(description),
        description,
        location,
        requester,
        contact,
        category,
        engineer,
        tier: slaRule.tier,
        priority,
        stage: "Incoming",
        status: "Pending Approval",
        contractor: null,
        assignee: null,
        requestedAt: new Date().toISOString(),
        dueAt,
        completedAt: null,
        nextUpdateAt: dueAt,
        cost: null,
        attachmentCount: 0,
        issueAttachmentCount: 0,
        completedAttachmentCount: 0,
        generalAttachmentCount: 0,
        publicUploadTokenHash: uploadTokenHash,
        publicUploadTokenExpiresAt: uploadTokenExpiresAt,
        commentCount: 0,
        // Nobody signed in, so nobody is credited. Attributing this to an
        // account that was not there would be worse than leaving it null.
        createdByEmail: null,
      })
      .returning();

    await db.insert(activityLog).values({
      id: crypto.randomUUID(),
      organisationId: orgId,
      entityType: "maintenance_request",
      entityId: id,
      action: "request.created",
      actorEmail: null,
      detail: JSON.stringify({ source: "Website form", priority, location }),
    });

    // Delivery failure never fails the request: the job is saved, and losing it
    // because a mail provider was down would be worse than a missed alert.
    const { opsInbox } = notificationTargets();
    const alert = jobAlertTemplate({
      reference: created.reference,
      title: created.title,
      site: location,
      priority,
      requester: created.requester,
      contact: created.contact,
      description: created.description,
    });
    const alertResult = await sendNotification(db, {
      organisationId: orgId,
      channel: "email",
      event: (priority ?? "").toLowerCase() === "urgent" ? "job.urgent" : "job.created",
      subjectType: "job",
      subjectId: id,
      to: opsInbox,
      subject: alert.subject,
      body: alert.body,
    });

    await db
      .update(maintenanceRequests)
      .set({
        notifiedAt: alertResult.ok ? sql`CURRENT_TIMESTAMP` : null,
        notifyAttempts: 1,
      })
      .where(eq(maintenanceRequests.id, id));

    return Response.json(
      { request: exposeRequest(created), notified: alertResult.ok, uploadToken },
      { status: 201 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    console.error("report-job submission failed", message);
    return Response.json(
      { error: "Your report could not be submitted. Please try again in a moment." },
      { status: 503 },
    );
  }
}
