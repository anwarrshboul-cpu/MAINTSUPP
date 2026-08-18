import { and, eq, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../../db/init";
import { getDb } from "../../../../../db";
import {
  activityLog,
  formConfigurations,
  maintenanceRequests,
  sites,
} from "../../../../../db/schema";
import {
  formAvailability,
  isUnlocked,
  loadFormByToken,
  unavailableMessage,
} from "../../../../lib/form-config";
import { getSession } from "../../../../lib/auth-session";

export const dynamic = "force-dynamic";

/**
 * A submission from a shared form link.
 *
 * WHY THIS DOES NOT CALL `/api/maintenance`
 *
 * That route requires the `board.edit` capability, which is right for it — it
 * is the authenticated "raise a job" endpoint used from inside the product. A
 * share link has no session at all, so it cannot go through it, and loosening
 * that route to accept anonymous writes would make every board in every tenant
 * writable by anyone who could guess a payload.
 *
 * The two therefore run in parallel and the overlap is deliberate. What differs
 * is not cosmetic:
 *
 *   · the tenant comes from the FORM, not from a session;
 *   · the four availability gates are checked before anything is written;
 *   · `response_count` is incremented, because a response limit depends on it;
 *   · there is no actor, so the audit entry records the form rather than a
 *     person, and `created_by_email` is left null rather than attributed to
 *     somebody who was not there.
 *
 * Six test files pattern-match `/api/maintenance/route.ts`, so extracting the
 * shared middle into a helper would mean editing a heavily asserted file to
 * serve a new caller. The duplication is the cheaper and safer trade, and this
 * comment is the marker for whoever changes one and needs to change the other.
 */

function failure(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function trimString(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * The job title, from the first line of the description.
 *
 * Mirrors `requestTitle` in /api/maintenance. Monday names every form
 * submission "Incoming form answer", which is why matching imported jobs by
 * title folded 713 of them together — so this deliberately does NOT reproduce
 * that behaviour and gives each job a title from its own description.
 */
function requestTitle(description: string) {
  const firstLine = description.split("\n")[0]?.trim() ?? "";
  const title = firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
  return title || "Maintenance request";
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    await ensureDatabase();
    const { token } = await context.params;
    const db = await getDb();

    const record = await loadFormByToken(db, token);
    if (!record) return Response.json({ error: "This form could not be found." }, { status: 404 });

    /* ---- The gates, before a single row is written ---------------------- */
    const availability = formAvailability(record);
    if (!availability.open) {
      return failure(unavailableMessage(availability.reason), 410);
    }
    if (record.requireLogin) {
      const session = await getSession(request).catch(() => null);
      if (!session) return failure("Please sign in to submit this form.", 401);
    }
    if (!(await isUnlocked(db, record, request))) {
      return failure("This form is password protected.", 401);
    }

    const payload = (await request.json()) as Record<string, unknown>;
    const location = trimString(payload.location, 120);
    const requester = trimString(payload.requester, 120);
    const contact = trimString(payload.contact, 80);
    const description = trimString(payload.description, 800);
    const priority = trimString(payload.priority, 80) || "Medium";
    const engineer = trimString(payload.engineer, 80);

    if (!location || !requester || !contact || description.length < 10) {
      return failure(
        "Location, manager, contact details and a clear description are required.",
      );
    }

    /*
     * The site must belong to the FORM's organisation. Without this a submitter
     * could name any site string and have it matched against another tenant's
     * estate — the token authorises writing to one workspace, not to whichever
     * one happens to have a site by that name.
     */
    const [matchedSite] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.name, location), eq(sites.organisationId, record.organisationId)))
      .limit(1);
    if (!matchedSite) return failure("Choose a location from the list.");

    const [latest] = await db
      .select({
        maxNumber: sql<number>`coalesce(max(cast(substr(${maintenanceRequests.id}, 4) as integer)), 1048)`,
      })
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.organisationId, record.organisationId),
          sql`${maintenanceRequests.id} like 'MN-%'`,
        ),
      );
    const id = `MN-${Number(latest.maxNumber ?? 1048) + 1}`;

    const submittedDate = trimString(payload.requestedAt, 32);
    const parsedDate = submittedDate ? new Date(submittedDate) : null;
    const requestedAt =
      parsedDate && !Number.isNaN(parsedDate.getTime())
        ? parsedDate.toISOString()
        : new Date().toISOString();

    const dueHours = priority === "Urgent" ? 4 : priority === "Medium" ? 72 : 120;
    const dueAt = new Date(Date.now() + dueHours * 60 * 60 * 1000).toISOString();

    const [created] = await db
      .insert(maintenanceRequests)
      .values({
        id,
        organisationId: record.organisationId,
        siteId: matchedSite.id,
        /*
         * Named so the board can tell a link submission from one raised inside
         * the product. Both are form answers; only one came from outside.
         */
        source: "Shared form",
        title: requestTitle(description),
        description,
        location,
        requester,
        contact,
        category: "Other",
        /*
         * `engineer` is NOT NULL on the board. An unanswered question falls
         * back to "Other", which is a real label in the Engineer Required
         * option set rather than an empty chip the board cannot draw.
         */
        engineer: engineer || "Other",
        tier: priority === "Urgent" ? 1 : priority === "Medium" ? 2 : 3,
        priority,
        stage: "Incoming",
        status: "Pending Approval",
        contractor: null,
        assignee: null,
        requestedAt,
        dueAt,
        completedAt: null,
        nextUpdateAt: dueAt,
        cost: null,
        attachmentCount: 0,
        issueAttachmentCount: 0,
        completedAttachmentCount: 0,
        generalAttachmentCount: 0,
        publicUploadTokenHash: null,
        publicUploadTokenExpiresAt: null,
        commentCount: 0,
        /* Nobody signed in, so nobody is credited. */
        createdByEmail: null,
      })
      .returning();

    await db.insert(activityLog).values({
      id: crypto.randomUUID(),
      organisationId: record.organisationId,
      entityType: "maintenance_request",
      entityId: id,
      action: "request.created",
      actorEmail: null,
      detail: JSON.stringify({ source: "Shared form", form: record.id, priority, location }),
    });

    /*
     * Counted only after the row exists. Incrementing first would let a
     * rejected submission consume somebody else's place under a response limit.
     */
    await db
      .update(formConfigurations)
      .set({ responseCount: sql`${formConfigurations.responseCount} + 1` })
      .where(eq(formConfigurations.id, record.id));

    return Response.json({ request: { id: created?.id ?? id } }, { status: 201 });
  } catch {
    return Response.json({ error: "Your request could not be submitted." }, { status: 503 });
  }
}
