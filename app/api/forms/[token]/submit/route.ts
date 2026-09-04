import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../../db/init";
import {
  CANONICAL_REGISTER,
  registerScopeFilter,
} from "../../../../lib/register-scope";
import { getDb } from "../../../../../db";
import {
  activityLog,
  formConfigurations,
  maintenanceBoardCells,
  maintenanceGroupItems,
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
import { canonicalOptionValue, priorityRule } from "../../../../lib/priority-rules";
import { listOptionValues } from "../../../../lib/options-repository";
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
 *
 * There is now a THIRD: app/api/report-job/route.ts, the website's own form.
 * It is public like this one but its questions are fixed in the page rather
 * than editable in the builder, so it pins its tenant instead of reading one
 * from a form record. Three routes create a job; changing the shape of one is
 * a reason to look at the other two.
 */

function failure(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

/**
 * A ceiling on the JSON body, because this endpoint is UNAUTHENTICATED.
 *
 * There is no per-IP rate limit in front of it and this does not pretend to be
 * one — see the note on the POST handler for what is and is not defended here.
 * What this does buy is that a single request cannot make the worker parse an
 * arbitrarily large document before any of the four availability gates have
 * run: every answer is a bounded string and the form has at most a few dozen
 * questions, so a body past this is not a submission, it is a payload.
 */
const MAX_SUBMISSION_BYTES = 64 * 1024;

/** More attachments than any real report, and the count is only a claim. */
const MAX_DECLARED_FILES = 40;

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
    const rawBody = await request.text();
    if (rawBody.length > MAX_SUBMISSION_BYTES) {
      return failure("That submission is too large.", 413);
    }
    let body: { answers?: Record<string, unknown> };
    try {
      body = JSON.parse(rawBody) as { answers?: Record<string, unknown> };
    } catch {
      return failure("That submission could not be read.");
    }
    const answers = (body.answers ?? {}) as Record<string, unknown>;

    /*
     * Which questions were actually ASKED. A hidden question is not asked, and
     * a conditional one is only asked when its trigger matched — validating
     * either would refuse a submission over a field the submitter never saw.
     * This mirrors the filter the public renderer applies.
     */
    const visible = record.config.questions.filter(
      (question) => question.visible && question.type !== "PAGE_BLOCK",
    );
    const visibleIds = new Set(visible.map((question) => question.id));
    /*
     * A conditional question's TRIGGER is read from the visible set only, which
     * is what `askedQuestions` in form-projection.ts does with the projected
     * questions. Reading it from the raw body would let a caller reveal a
     * conditional question by answering a trigger the form never showed.
     */
    const triggerAnswer = (id: string) =>
      visibleIds.has(id) ? trimString(answers[id], 400) : "";
    const asked = visible.filter(
      (question) =>
        !question.showIf || question.showIf.equals.includes(triggerAnswer(question.showIf.questionId)),
    );
    const askedIds = new Set(asked.map((question) => question.id));

    /*
     * AN ANSWER TO A QUESTION THE FORM DID NOT ASK IS NOT AN ANSWER — mass
     * assignment, closed at the one place every value is read.
     *
     * This was `trimString(answers[id], max)`, unfiltered, and the seven reads
     * below take their ids from constants rather than from `asked`. So a caller
     * posting straight to this endpoint could set the job's Priority — and
     * therefore its SLA tier and its due date, which `priorityRule` computes
     * from it — on a form whose Priority question the operator had HIDDEN.
     * The same held for the requested date, the engineer, and the description
     * that becomes the job's title. The form is the contract; anything outside
     * it is discarded here rather than validated later.
     */
    const answerFor = (id: string, max = 400) =>
      askedIds.has(id) ? trimString(answers[id], max) : "";

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
    const fileCount = Number.isFinite(declaredFiles)
      ? Math.min(MAX_DECLARED_FILES, Math.max(0, declaredFiles))
      : 0;

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
    const requestedAnswer = answerFor("date", 32);

    /*
     * Priority and Engineer are CANONICALISED against the option registry
     * before anything is stored or computed from them.
     *
     * The registry separates `value` (the stable key stored jobs carry, which
     * renaming never touches) from `label` (the display text an admin may
     * edit). The form shows labels, so the answer arriving here is normally
     * the current label; a form opened before a rename posts the old one,
     * which for seeded rows equals the value — both resolve. Storing the VALUE
     * is what lets an admin rename "Urgent" without splitting every dashboard
     * grouping in two, and the SLA below reads the value, so a rename changes
     * what people see and nothing about what the system does.
     */
    const priorityOptions = await listOptionValues(db, record.organisationId, "priority");
    const priority = canonicalOptionValue(priorityOptions, answerFor("status", 80), "Medium");
    const engineerOptions = await listOptionValues(
      db,
      record.organisationId,
      "engineer_required",
    );
    /*
     * `engineer` is NOT NULL on the board. An unanswered question falls back
     * to "Other", which is a real label in the Engineer Required option set
     * rather than an empty chip the board cannot draw.
     */
    const engineer = canonicalOptionValue(engineerOptions, answerFor("single_select", 80), "Other");

    /*
     * A floor on the description that `required` alone cannot express: a job
     * nobody can act on is worse than no job. Only applied when the question is
     * actually being asked.
     */
    if (askedIds.has("short_text") && description.length < 10) {
      return failure("Please describe the work needed in a little more detail.");
    }
    /*
     * REQUIRED WHEN ASKED, WHICH IS NOT THE SAME AS ALWAYS REQUIRED.
     *
     * These three were demanded unconditionally, which is right for the job
     * board's form — it asks all three — and impossible for any other. A
     * register generated from the generic template has no Location column, so
     * its form has no Location question, so `location` was necessarily blank
     * and every submission was refused with "Location, manager and contact
     * details are required", naming fields the form had never shown. The gate
     * on the job board's form is bit for bit what it was; a form that does not
     * ask is no longer answered for.
     */
    const missingCore = [
      askedIds.has(LOCATION_QUESTION_ID) && !location,
      askedIds.has("short_text64") && !requester,
      askedIds.has("numbertb4g1z46") && !contact,
    ].some(Boolean);
    if (missingCore) {
      return failure("Location, manager and contact details are required.");
    }

    /*
     * The site must belong to the FORM's organisation. Without this a submitter
     * could name any site string and have it matched against another tenant's
     * estate — the token authorises writing to one workspace, not to whichever
     * one happens to have a site by that name.
     *
     * Only looked up when a location was actually asked for. `site_id` is
     * nullable precisely because a job whose site is not yet known has no site,
     * and a register that does not ask where the work is has none to record.
     */
    let matchedSiteId: string | null = null;
    if (location) {
      const [matchedSite] = await db
        .select({ id: sites.id })
        .from(sites)
        .where(
          and(
            eq(sites.name, location),
            eq(sites.organisationId, record.organisationId),
            /* CANONICAL ONLY. This endpoint is PUBLIC — a share link, no
               session, no instance context — and the form offers the
               workspace's own locations. Unscoped, a submitted name matching a
               site inside somebody's custom Sites register attached the job to
               it. An unmatched name is already refused below, which is the
               state a person can see and correct. */
            registerScopeFilter(sites.boardId, CANONICAL_REGISTER),
          ),
        )
        .limit(1);
      if (!matchedSite) return failure("Choose a location from the list.");
      matchedSiteId = matchedSite.id;
    }

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

    /*
     * The SLA clock and the tier come from `priorityRule`, keyed on the
     * canonical VALUE — see app/lib/priority-rules.ts for why label-string
     * comparisons had to go before labels became editable.
     */
    const rule = priorityRule(priority);
    const dueAt = new Date(Date.now() + rule.dueHours * 60 * 60 * 1000).toISOString();

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
    /*
     * WHICH BOARD, AND WHICH OF ITS GROUPS. Both read from the form's own row.
     *
     * Nothing in the request decides either. There is no `?board=`, no header
     * and no host to read: `record.boardId` and `record.organisationId` come
     * from the `form_configurations` row the token resolved to, and that row is
     * the only authority this endpoint has. A token is authorisation to write
     * to ONE register in ONE workspace.
     */
    const boardKey = record.boardId;
    const boardGroups = (
      await db
        .select({
          id: maintenanceGroups.id,
          stageKey: maintenanceGroups.stageKey,
          archived: maintenanceGroups.archived,
        })
        .from(maintenanceGroups)
        .where(
          and(
            eq(maintenanceGroups.organisationId, record.organisationId),
            eq(maintenanceGroups.boardId, boardKey),
            isNull(maintenanceGroups.deletedAt),
          ),
        )
        .orderBy(asc(maintenanceGroups.position))
    ).filter((group) => !group.archived);

    /*
     * The configured group had to belong to this ORGANISATION and to nothing
     * else — so a group id stored while the setting pointed at another board
     * resolved, and its `stage_key` decided where a submission on THIS board
     * landed. Scoped to the board as well, a stale id resolves to nothing and
     * the fallback below applies, which is the whole point of having one.
     */
    const configuredGroupId = record.config.features.board?.itemGroupId;
    const configured = configuredGroupId
      ? boardGroups.find((group) => group.id === String(configuredGroupId))
      : undefined;
    /* The board's own first lane, not the literal "Incoming": a generic
       register has no group by that name and would have had nowhere to file. */
    const targetGroup = configured ?? boardGroups[0] ?? null;
    const targetStage = targetGroup?.stageKey ?? "Incoming";

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
        siteId: matchedSiteId,
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
        engineer,
        tier: rule.tier,
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

    /*
     * THE PLACEMENT — what actually puts the answer on this register.
     *
     * `maintenance_requests` carries no `board_id`; a row's board is decided by
     * its `maintenance_group_items` placement (see `boardKeyForRequest` in
     * app/lib/board-registry.ts). This route wrote no placement at all, and the
     * consequence was not that the row went nowhere: `ensureBoardState` in
     * /api/board files every UNPLACED work order in the organisation onto
     * whichever board is being loaded, into `groups[0]`. So a submission
     * through a section's form landed on whichever register somebody opened
     * first — usually the job board, where 39 groups are named after real
     * stores. Placing it here is what makes "submissions scoped to that
     * instance" true, and it is also what makes it deterministic.
     *
     * `onConflictDoNothing` because `request_id` is the primary key of that
     * table: one work order holds one placement across the whole workspace, and
     * a retry must not move a row that is already filed.
     */
    if (targetGroup) {
      const [tail] = await db
        .select({ maxPosition: sql<number>`COALESCE(MAX(${maintenanceGroupItems.position}), -1)` })
        .from(maintenanceGroupItems)
        .where(
          and(
            eq(maintenanceGroupItems.organisationId, record.organisationId),
            eq(maintenanceGroupItems.boardId, boardKey),
            eq(maintenanceGroupItems.groupId, targetGroup.id),
          ),
        );
      await db
        .insert(maintenanceGroupItems)
        .values({
          requestId: id,
          organisationId: record.organisationId,
          boardId: boardKey,
          groupId: targetGroup.id,
          position: Number(tail?.maxPosition ?? -1) + 1,
        })
        .onConflictDoNothing();
    }

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
      /*
       * THE FORM'S OWN BOARD'S COLUMNS, and only those.
       *
       * This query was scoped to the ORGANISATION alone, so a question id that
       * matched a column on any other register was accepted — and the cell was
       * then written with `board_id: "maintenance"` as a literal, filing an
       * answer given on one board into a cell on another. Both halves are the
       * same mistake: a cell belongs to (board, request, column) and every one
       * of the three has to come from the form.
       *
       * Matched on `column_key` as well as on the row id. A canonical question
       * carries monday's id, a derived one carries its column's row id, and
       * `deriveFormQuestions` uses the row id precisely so this lookup needs no
       * second mapping — the key is accepted too so a form written against an
       * imported board still files.
       *
       * SYSTEM COLUMNS ARE EXCLUDED. Their value is a field on
       * `maintenance_requests`, so a cell for one is a row nothing ever reads:
       * the seven fields above are what write them, by hand.
       */
      const columns = await db
        .select({
          id: maintenanceBoardColumns.id,
          key: maintenanceBoardColumns.key,
          system: maintenanceBoardColumns.system,
        })
        .from(maintenanceBoardColumns)
        .where(
          and(
            eq(maintenanceBoardColumns.organisationId, record.organisationId),
            eq(maintenanceBoardColumns.boardId, boardKey),
            isNull(maintenanceBoardColumns.deletedAt),
          ),
        );
      const columnFor = new Map<string, string>();
      for (const column of columns) {
        if (column.system) continue;
        columnFor.set(column.id, column.id);
        if (!columnFor.has(column.key)) columnFor.set(column.key, column.id);
      }
      for (const question of extras) {
        const columnId = columnFor.get(question.id);
        if (!columnId) continue;
        await db.insert(maintenanceBoardCells).values({
          id: crypto.randomUUID(),
          organisationId: record.organisationId,
          boardId: boardKey,
          requestId: id,
          columnId,
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
