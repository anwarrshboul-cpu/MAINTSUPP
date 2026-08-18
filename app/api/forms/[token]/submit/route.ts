import { and, eq, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../../db/init";
import { getDb } from "../../../../../db";
import {
  activityLog,
  formConfigurations,
  maintenanceBoardCells,
  maintenanceGroups,
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

/** Matches the digest `/api/files` computes when it verifies an upload token. */
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
    /*
     * A File question is answered by an UPLOAD, which cannot be in this JSON —
     * the files are attached after the work order exists, because /api/files
     * files them against a request id. So the browser declares how many it is
     * about to send, and a required File question is satisfied by a non-zero
     * declaration rather than by a string.
     *
     * What that does and does not buy, stated plainly: it stops the ordinary
     * "I did not attach anything" case server-side, before a job is created,
     * which is the case the setting exists for. It is NOT proof that files
     * arrive — a hostile client could declare a count and upload nothing, and
     * the authenticated path through /api/maintenance has exactly the same
     * property. What binds the real files to this job is the single-use upload
     * token issued below, not the count.
     */
    const declaredFiles = Number((body as { fileCount?: unknown }).fileCount ?? 0);
    const fileCount = Number.isFinite(declaredFiles) ? Math.max(0, declaredFiles) : 0;

    const missing = asked.find((question) => {
      if (!question.required) return false;
      if (question.type === "File") return fileCount < 1;
      return !answerFor(question.id);
    });
    if (missing) {
      return failure(
        missing.type === "File"
          ? `${missing.title} is required — please attach at least one photograph or video.`
          : `${missing.title} is required.`,
      );
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

    /*
     * The single-use grant that lets an anonymous submitter attach the files
     * they were just told were mandatory.
     *
     * Only minted when the form actually asks for files, so a form with no File
     * question issues no upload capability at all. `/api/files` already knows
     * how to accept it — it hashes what it is given and compares against
     * `public_upload_token_hash` on the work order, with the expiry checked
     * alongside — so nothing new is trusted here; this is the missing half of a
     * handshake the file route was already written for.
     *
     * Thirty minutes: long enough to push a few phone videos over a shop's
     * wifi, short enough that a token captured from a browser history is dead
     * before it is useful. Only the HASH is stored, so a dump of the table
     * cannot be turned back into a working upload grant.
     */
    /*
     * WHERE THE ANSWER LANDS — the "Group for answers" setting, honoured.
     *
     * `stage` is what decides a job's group on this board, and this route used
     * to hard-code "Incoming" regardless of what the panel said. So an operator
     * could pick a group, see it saved, and every submission would still arrive
     * somewhere else.
     *
     * The configured group is resolved to its `stage_key`, scoped to the form's
     * own organisation so a stored id from another workspace resolves to
     * nothing rather than to that workspace's group. Anything unresolvable —
     * no setting, a deleted group, a group with no stage — falls back to
     * "Incoming", which is the board's top group and the safe default: a job in
     * the wrong group is recoverable, a job that failed to save is not.
     */
    let targetStage = "Incoming";
    const configuredGroupId = record.config.features.board?.itemGroupId;
    if (configuredGroupId) {
      const [group] = await db
        .select({ stageKey: maintenanceGroups.stageKey })
        .from(maintenanceGroups)
        .where(
          and(
            eq(maintenanceGroups.id, String(configuredGroupId)),
            eq(maintenanceGroups.organisationId, record.organisationId),
          ),
        )
        .limit(1);
      if (group?.stageKey) targetStage = group.stageKey;
    }

    const wantsFiles = asked.some((question) => question.type === "File");
    const uploadToken = wantsFiles ? crypto.randomUUID().replace(/-/g, "") : null;
    const uploadTokenHash = uploadToken ? await sha256(uploadToken) : null;
    const uploadTokenExpiresAt = uploadToken
      ? new Date(Date.now() + 30 * 60 * 1000).toISOString()
      : null;

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
        status: "Pending Approval",
        contractor: null,
        assignee: null,
        stage: targetStage,
        requestedAt,
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

    /*
     * The plaintext token is returned exactly once, here, and never stored or
     * logged. The browser uses it immediately for the uploads and then drops it.
     */
    return Response.json(
      { request: { id: created?.id ?? id }, uploadToken },
      { status: 201 },
    );
  } catch {
    return Response.json({ error: "Your request could not be submitted." }, { status: 503 });
  }
}
