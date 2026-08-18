import { and, eq, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../../db/init";
import { getDb } from "../../../../../db";
import {
  activityLog,
  formConfigurations,
  maintenanceBoardCells,
  maintenanceBoardColumns,
  maintenanceRequests,
  sites,
} from "../../../../../db/schema";
import {
  LOCATION_QUESTION_ID,
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

    /*
     * ANSWERS ARRIVE KEYED BY QUESTION ID, and the server decides what each one
     * means. The browser used to post a fixed seven-field object, which had two
     * consequences worth spelling out because both were silent:
     *
     *   · An answer to any of the other twelve questions was dropped on the
     *     floor. The Edit panel invites an operator to un-hide "Cost of Works"
     *     or "Approved by"; a submitter would then fill the field in and the
     *     value would never leave the browser.
     *   · `required` could only ever be checked for the four fields the shape
     *     happened to carry.
     *
     * Keying by question id means the set of questions is DATA, so un-hiding a
     * question makes its answer arrive without anybody editing this route.
     */
    const body = (await request.json()) as { answers?: Record<string, unknown> };
    const answers = (body.answers ?? {}) as Record<string, unknown>;
    const answerFor = (id: string, max = 400) => trimString(answers[id], max);

    /*
     * Which questions were actually ASKED. A hidden question is not asked, and
     * a conditional one is only asked when its trigger matched — validating
     * either would refuse a submission over a field the submitter never saw.
     * This mirrors the filter the public renderer applies.
     */
    const asked = record.config.questions.filter((question) => {
      if (!question.visible || question.type === "PAGE_BLOCK") return false;
      if (!question.showIf) return true;
      return question.showIf.equals.includes(answerFor(question.showIf.questionId));
    });

    /*
     * Required, enforced HERE and not only by the `required` attribute in the
     * markup. The submit is a plain JSON fetch, so the browser's validation is
     * advisory at best — anything that posts directly bypasses it entirely.
     * The first unanswered question is named, because "something is missing" on
     * a nine-question form is not an error message.
     */
    const missing = asked.find((question) => question.required && !answerFor(question.id));
    if (missing) {
      return failure(`${missing.title} is required.`);
    }

    /* The questions that map onto first-class columns of a work order. */
    const location = answerFor(LOCATION_QUESTION_ID, 120);
    const requester = answerFor("short_text64", 120);
    const contact = answerFor("numbertb4g1z46", 80);
    const description = answerFor("short_text", 800);
    const priority = answerFor("status", 80) || "Medium";
    const engineer = answerFor("single_select", 80);
    const requestedAnswer = answerFor("date", 32);

    /*
     * A floor on the description that `required` alone cannot express: a job
     * nobody can act on is worse than no job. Only applied when the question is
     * actually being asked.
     */
    if (asked.some((question) => question.id === "short_text") && description.length < 10) {
      return failure("Please describe the work needed in a little more detail.");
    }
    if (!location || !requester || !contact) {
      return failure("Location, manager and contact details are required.");
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

    const parsedDate = requestedAnswer ? new Date(requestedAnswer) : null;
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
     * ANSWERS THAT ARE NOT FIRST-CLASS COLUMNS OF A WORK ORDER.
     *
     * A question id here IS a monday column id — that is how the configuration
     * was captured — and `maintenance_board_cells` is keyed by (request,
     * column). So an answer to "Cost of Works" or "Approved by" has a proper
     * home, and un-hiding one of the ten hidden questions now produces a value
     * that lands in the right column instead of being discarded in the browser.
     *
     * Only columns the board actually has are written: `column_id` is a foreign
     * key, and a question whose column was deleted must not take the whole
     * submission down with it. Anything unmatched is skipped silently — the job
     * itself is already saved and is worth more than the extra field.
     */
    const handled = new Set([
      LOCATION_QUESTION_ID,
      "short_text64",
      "numbertb4g1z46",
      "short_text",
      "single_select",
      "status",
      "date",
    ]);
    const extras = asked.filter(
      (question) => !handled.has(question.id) && answerFor(question.id),
    );
    if (extras.length) {
      const columns = await db
        .select({ id: maintenanceBoardColumns.id })
        .from(maintenanceBoardColumns)
        .where(eq(maintenanceBoardColumns.organisationId, record.organisationId));
      const known = new Set(columns.map((column) => column.id));
      for (const question of extras) {
        if (!known.has(question.id)) continue;
        await db.insert(maintenanceBoardCells).values({
          id: crypto.randomUUID(),
          organisationId: record.organisationId,
          boardId: "maintenance",
          requestId: id,
          columnId: question.id,
          value: answerFor(question.id, 800),
        });
      }
    }

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
