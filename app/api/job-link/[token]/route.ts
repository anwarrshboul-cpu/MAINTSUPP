import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { getDb } from "../../../../db";
import {
  activityLog,
  attachments,
  itemUpdates,
  maintenanceBoardColumns,
  maintenanceRequests,
  sites,
} from "../../../../db/schema";
import { boardKeyForRequest } from "../../../lib/board-registry";
import { recordContractorComment } from "../../../lib/contractor-comments";
import {
  contractorSafeJob,
  recordTokenUse,
  resolveJobToken,
  storageKindFor,
  type EvidenceKind,
  type TokenScope,
} from "../../../lib/job-tokens";
import {
  contractorEventTemplate,
  notificationTargets,
  sendNotification,
} from "../../../lib/notifications";

export const dynamic = "force-dynamic";

type Database = Awaited<ReturnType<typeof getDb>>;

/**
 * The board's file columns for the job this token opens.
 *
 * The 2,915 photographs already in this workspace came from the Monday export,
 * which files a photo by *column* — `board_column_id` — and leaves
 * `attachments.kind` at its `'general'` default. `/api/board` draws the photo
 * cells from `board_column_id` for exactly that reason. So the column ids are
 * what this route has to work in: reading the issue photos, and filing the
 * contractor's completion photos back where the board will draw them.
 *
 * Resolved from the board the work order is actually placed on, never from the
 * literal "maintenance" — see `boardKeyForRequest`.
 */
async function fileColumns(db: Database, scope: TokenScope) {
  const boardId = await boardKeyForRequest(db, scope.organisationId, scope.requestId);
  const rows = await db
    .select({ id: maintenanceBoardColumns.id, key: maintenanceBoardColumns.key })
    .from(maintenanceBoardColumns)
    .where(
      and(
        eq(maintenanceBoardColumns.organisationId, scope.organisationId),
        eq(maintenanceBoardColumns.boardId, boardId),
        eq(maintenanceBoardColumns.type, "files"),
      ),
    );
  const byKey = new Map(rows.map((row) => [row.key, row.id]));
  return {
    issue: byKey.get("issuePictures") ?? null,
    completion: byKey.get("completedPictures") ?? null,
    general: byKey.get("files") ?? null,
  };
}

/**
 * Where the shared page should send each kind of evidence.
 *
 * The page cannot work this out for itself: `attachments.kind` and the board's
 * file columns are both server-side vocabulary, and the page is a public HTML
 * document that must not carry a copy of either. It is told, and it posts what
 * it is told.
 */
function uploadSlots(
  scope: TokenScope,
  columns: Awaited<ReturnType<typeof fileColumns>>,
) {
  return scope.evidenceSlots.map((kind: EvidenceKind) => {
    const storageKind = storageKindFor(kind);
    return {
      kind,
      storageKind,
      /*
       * Only the *completion* slot withholds its column.
       *
       * A file posted with `columnId` is stored as `kind = 'general'` by
       * `/api/files`, which would leave `completed_attachment_count` at zero
       * and hide the photo from the drawer's completion tab. So completion
       * evidence is uploaded as `kind = 'completion'` and filed into the
       * board column by `fileEvidenceOntoBoard` when the contractor submits —
       * which is the moment it becomes something the coordinator should see.
       */
      columnId: storageKind === "completion" ? null : columns[storageKind],
    };
  });
}

/**
 * Files the contractor's evidence into the board column that draws it.
 *
 * `/api/files` stores completion evidence with `board_column_id` null, so the
 * "Picture of completed works" cell on the board — which counts by column —
 * stays empty however many photographs were uploaded. Stamping the column on
 * submission puts the photo where the coordinator looks, and keeps
 * `kind = 'completion'` so the drawer's completion tab and
 * `completed_attachment_count` stay right too.
 *
 * Scoped to this token's job, to rows that have no column yet, so it can never
 * move a photo a coordinator has already filed somewhere.
 */
async function fileEvidenceOntoBoard(
  db: Database,
  scope: TokenScope,
  completionColumnId: string | null,
) {
  if (!completionColumnId) return;
  await db
    .update(attachments)
    .set({ boardColumnId: completionColumnId })
    .where(
      and(
        eq(attachments.organisationId, scope.organisationId),
        eq(attachments.requestId, scope.requestId),
        eq(attachments.kind, "completion"),
        isNull(attachments.boardColumnId),
      ),
    );
}

/**
 * Records a contractor's comment where the app already reads comments from.
 *
 * FOUR writes, because the app reads a comment from four places and a comment
 * that lands in only one of them is a comment nobody sees:
 *
 *  · `item_updates` is the comment table, and the durable record.
 *  · `activity_log` with `request.note_added` is what the job drawer's
 *    Updates tab actually renders — it reads activity, not `item_updates`.
 *  · `maintenance_requests.comment_count` is the bubble on the board row.
 *  · the Main Table's "Contractor Comments" column — owner Part 7. The three
 *    above are all things a coordinator has to OPEN something to read; the
 *    board itself showed a number and no words. See
 *    `app/lib/contractor-comments.ts` for why that column is a board cell
 *    rather than a field, and for why appending cannot lose an earlier
 *    comment.
 *
 * Written here rather than by calling `/api/maintenance` because that route
 * needs a session and this caller has none by design.
 */
async function recordComment(
  db: Database,
  scope: TokenScope,
  body: string,
  by: string,
) {
  if (!body.trim()) return;
  const author = by || "Contractor";
  await db.insert(itemUpdates).values({
    id: `iu_${crypto.randomUUID().replace(/-/g, "")}`,
    organisationId: scope.organisationId,
    boardId: await boardKeyForRequest(db, scope.organisationId, scope.requestId),
    requestId: scope.requestId,
    authorName: author,
    authorEmail: null,
    body,
  });

  await db.insert(activityLog).values({
    id: crypto.randomUUID(),
    organisationId: scope.organisationId,
    entityType: "maintenance_request",
    entityId: scope.requestId,
    action: "request.note_added",
    // Not an email. `activityActor` splits on the local part and title-cases
    // it, so a contractor's name reads as their name in the timeline.
    actorEmail: author,
    detail: JSON.stringify({ note: body, via: "contractor-link" }),
  });

  await db
    .update(maintenanceRequests)
    .set({
      commentCount: sql`${maintenanceRequests.commentCount} + 1`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(maintenanceRequests.id, scope.requestId),
        eq(maintenanceRequests.organisationId, scope.organisationId),
      ),
    );

  /*
   * And onto the board, where a coordinator will actually see it.
   *
   * Scoped to the token's own job and organisation, like every other statement
   * in this function — this route never reads a job id from a request body, and
   * that is what the counters test asserts by enumerating the WHEREs in it.
   *
   * It appends, so a contractor who comments twice has two comments; and it is
   * best-effort, because the three writes above have already saved the words.
   */
  await recordContractorComment(db, scope.organisationId, scope.requestId, {
    body,
    author,
  });
}

/**
 * The date the contractor says the work was finished.
 *
 * Accepts `YYYY-MM-DD`, which is what a phone's date input sends, and refuses
 * anything it cannot parse rather than storing a silent `Invalid Date`.
 */
/**
 * The comment body, with the date the contractor gave folded into it.
 *
 * The Updates tab renders a body and an author and nothing else, so a date
 * recorded only in a column is a date nobody reading the conversation sees.
 * Written in the same `en-GB` form the rest of the product uses.
 */
function completionUpdate(note: string, finishedOn: string | null) {
  const parts: string[] = [];
  if (note) parts.push(note);
  if (finishedOn) {
    parts.push(
      `Work completed on ${new Intl.DateTimeFormat("en-GB", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(finishedOn))}.`,
    );
  }
  return parts.join("\n\n");
}

function completionDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  const parsed = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00.000Z` : trimmed,
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Public contractor endpoint. No authentication — the token IS the credential.
 *
 * Every response is deliberately narrow: a WhatsApp link is forwardable,
 * screenshot-able and lives in phone backups forever, so it must never carry
 * cost, invoices, other jobs or other clients.
 */

function unauthorised() {
  // Deliberately identical for unknown, expired and revoked tokens, so a stale
  // link cannot be used to probe whether a job exists.
  return Response.json(
    { error: "This link is no longer valid. Ask your coordinator for a new one." },
    { status: 403 },
  );
}

function bad(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

/**
 * Sends a coordinator alert. Failure is swallowed on purpose: the contractor's
 * submission is already recorded, and a mail outage must not make him think it
 * did not go through.
 */
async function notifyCoordinator(
  db: Awaited<ReturnType<typeof getDb>>,
  scope: { organisationId: string; requestId: string },
  kind: "opened" | "uploaded" | "completion" | "blocked",
  by: string | null,
  note: string | null,
  reason: string | null,
) {
  try {
    const [job] = await db
      .select({ reference: maintenanceRequests.reference, location: maintenanceRequests.location })
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.id, scope.requestId),
          eq(maintenanceRequests.organisationId, scope.organisationId),
        ),
      );
    const template = contractorEventTemplate({
      kind,
      reference: job?.reference ?? null,
      site: job?.location ?? null,
      by,
      note,
      reason,
    });
    const { opsInbox } = notificationTargets();
    await sendNotification(db, {
      organisationId: scope.organisationId,
      channel: "email",
      event: `contractor.${kind}`,
      subjectType: "job",
      subjectId: scope.requestId,
      to: opsInbox,
      subject: template.subject,
      body: template.body,
    });
  } catch {
    // Recorded in notification_log by sendNotification; nothing more to do.
  }
}

/** GET /api/job-link/[token] — what the contractor sees. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    await ensureDatabase();
    const db = await getDb();
    const { token } = await params;

    const scope = await resolveJobToken(db, token);
    if (!scope) return unauthorised();

    /*
     * A binned job's share link stops working.
     *
     * The row survives a delete so it can be restored, and without this filter
     * the contractor's public view would keep serving a job the workspace has
     * deleted — photos, address, contact and all — with no way for anyone
     * inside to see that it was still reachable. `unauthorised()` rather than
     * a 404 that explains: the same answer this route gives every other dead
     * token, so the link discloses nothing about why it stopped.
     */
    const [job] = await db
      .select()
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.id, scope.requestId),
          eq(maintenanceRequests.organisationId, scope.organisationId),
          isNull(maintenanceRequests.deletedAt),
        ),
      );
    if (!job) return unauthorised();

    /*
     * L — the arrival pack.
     *
     * An engineer standing outside a shopping centre at 8am needs to know how
     * to get in, who to ask for, where to park and when the unit opens. All of
     * it already had columns; none of it was ever served to the one person who
     * needs it, so it was read off a WhatsApp message or not at all.
     *
     * Served to a JOB LINK, which is scoped to one job at one site — so this
     * is that site's arrival detail and nothing else. Deliberately NOT the
     * lease, the rent review, the service charge or the budget: a contractor
     * has no business with any of it and it lives one column away.
     */
    const [site] = job.siteId
      ? await db
          .select({
            name: sites.name,
            address: sites.address,
            addressLine1: sites.addressLine1,
            addressLine2: sites.addressLine2,
            city: sites.city,
            postcode: sites.postcode,
            manager: sites.manager,
            managerName: sites.managerName,
            managerPhone: sites.managerPhone,
            outOfHoursContact: sites.outOfHoursContact,
            accessMethod: sites.accessMethod,
            accessContact: sites.accessContact,
            accessUrl: sites.accessUrl,
            accessNotes: sites.accessNotes,
            openingHours: sites.openingHours,
            deliveryRestrictions: sites.deliveryRestrictions,
            parkingNotes: sites.parkingNotes,
            keyAlarmNotes: sites.keyAlarmNotes,
          })
          .from(sites)
          .where(
            and(eq(sites.id, job.siteId), eq(sites.organisationId, scope.organisationId)),
          )
      : [];

    /*
     * Access problems this site has had before, counted from its own history.
     *
     * Not a field anybody maintains — a field nobody maintains is empty, and
     * these 744 jobs already record the answer. A job that was blocked, and
     * whose reason or note mentions getting in, is precisely "we have had
     * trouble at this address before", and it is worth knowing at 8am rather
     * than at 8:40.
     */
    const accessTrouble = job.siteId
      ? await db
          .select({
            reference: maintenanceRequests.id,
            reason: maintenanceRequests.blockedReason,
            note: maintenanceRequests.completionNote,
            when: maintenanceRequests.requestedAt,
          })
          .from(maintenanceRequests)
          .where(
            and(
              eq(maintenanceRequests.siteId, job.siteId),
              eq(maintenanceRequests.organisationId, scope.organisationId),
              isNull(maintenanceRequests.deletedAt),
              or(
                sql`lower(coalesce(${maintenanceRequests.blockedReason}, '')) LIKE '%access%'`,
                sql`lower(coalesce(${maintenanceRequests.blockedReason}, '')) LIKE '%locked%'`,
                sql`lower(coalesce(${maintenanceRequests.blockedReason}, '')) LIKE '%no entry%'`,
                sql`lower(coalesce(${maintenanceRequests.blockedReason}, '')) LIKE '%key%'`,
                sql`lower(coalesce(${maintenanceRequests.completionNote}, '')) LIKE '%could not access%'`,
                sql`lower(coalesce(${maintenanceRequests.completionNote}, '')) LIKE '%no access%'`,
              ),
            ),
          )
          .orderBy(desc(maintenanceRequests.requestedAt))
          .limit(4)
      : [];

    const columns = await fileColumns(db, scope);

    /*
     * Only the reporter's fault photos. Completion evidence from other
     * contractors is not shared.
     *
     * Matched on the board column as well as on `kind`, because the imported
     * photographs are the ones that matter here and they carry the column, not
     * the kind. Filtering on `kind = 'issue'` alone returned an empty list for
     * every one of the 1,149 "Pictures of Maintenance Issue" in this
     * workspace — verified against the running server: a link issued for a job
     * with three issue photos answered `"issuePhotos": []`.
     */
    const issuePhotos = await db
      .select({
        id: attachments.id,
        name: attachments.originalName,
        /*
         * The register's display name, carried so the public viewer can obey
         * the one rule about what a document is called — `documentName()`:
         * the title somebody set, the stored filename otherwise. Without it
         * the in-page viewer would caption a renamed photograph with the name
         * the phone gave it while the portal calls it something else.
         */
        title: attachments.title,
        kind: attachments.kind,
        contentType: attachments.contentType,
        /*
         * Size and date are the viewer's caption line. They are facts about a
         * file whose bytes this token already serves, so they disclose nothing
         * the holder cannot already read off the download.
         */
        byteSize: attachments.byteSize,
        createdAt: attachments.createdAt,
      })
      .from(attachments)
      .where(
        and(
          eq(attachments.organisationId, scope.organisationId),
          eq(attachments.requestId, scope.requestId),
          or(
            eq(attachments.kind, "issue"),
            columns.issue
              ? eq(attachments.boardColumnId, columns.issue)
              : undefined,
          ),
        ),
      );

    /*
     * The contractor's own completion evidence, so the page shows what has
     * already been sent rather than asking him to remember. Still no other
     * contractor's work: everything here was uploaded against this job, and
     * the link is bound to this job.
     */
    const completionPhotos = await db
      .select({
        id: attachments.id,
        name: attachments.originalName,
        title: attachments.title,
        kind: attachments.kind,
        contentType: attachments.contentType,
        byteSize: attachments.byteSize,
        createdAt: attachments.createdAt,
      })
      .from(attachments)
      .where(
        and(
          eq(attachments.organisationId, scope.organisationId),
          eq(attachments.requestId, scope.requestId),
          or(
            eq(attachments.kind, "completion"),
            columns.completion
              ? eq(attachments.boardColumnId, columns.completion)
              : undefined,
          ),
        ),
      );

    /*
     * Bytes are fetched from `/api/files/[id]`, which resolves a tenant from
     * the session. The token is carried alongside so that route can accept the
     * same credential the page was opened with — see the note on `?token=` in
     * `app/api/files/[id]/route.ts`. It is the credential already in this
     * page's own URL, so it discloses nothing the holder does not have.
     */
    const carried = encodeURIComponent(token);
    const withUrls = (rows: typeof issuePhotos) =>
      rows.map((photo) => ({
        ...photo,
        url: `/api/files/${photo.id}?token=${carried}`,
        thumbUrl: `/api/files/${photo.id}?thumb=1&token=${carried}`,
        /*
         * The same bytes with `Content-Disposition: attachment`.
         *
         * The viewer's Save button needs a URL that downloads rather than one
         * that renders, and `?download=1` is the flag `/api/files/[id]` already
         * reads for exactly that. Serving it here rather than composing it on
         * the client keeps the token-carrying convention in one place — this
         * function — instead of spreading `?token=` through the page.
         */
        downloadUrl: `/api/files/${photo.id}?download=1&token=${carried}`,
      }));

    // Z13 — tell the coordinator the first time a link is opened, so an
    // ignored link is visible without anyone checking. Viewer links are
    // excluded: "contractor opened the job" is not a thing a read-only ticket
    // view means, and a shared status link would spam the ops inbox.
    const firstOpen = !job.completionRequestedAt && scope.audience !== "viewer";
    await recordTokenUse(db, scope.id);
    if (firstOpen) {
      const template = contractorEventTemplate({
        kind: "opened",
        reference: job.reference,
        site: site?.name ?? null,
        by: scope.label,
      });
      const { opsInbox } = notificationTargets();
      await sendNotification(db, {
        organisationId: scope.organisationId,
        channel: "email",
        event: "contractor.opened",
        subjectType: "job",
        subjectId: scope.requestId,
        to: opsInbox,
        subject: template.subject,
        body: template.body,
      });
    }

    return Response.json({
      /*
       * The job id, so the page can upload.
       *
       * `/api/files` requires `requestId` and answers 400 without it, and the
       * page had no way of knowing one — so every contractor upload returned
       * "A file and work order ID are required." Verified against the running
       * server before this line existed. It is not a secret: the token already
       * grants this job and nothing else.
       */
      requestId: scope.requestId,
      job: contractorSafeJob(job),
      site: site
        ? {
            name: site.name,
            address: site.address,
            contact: site.manager,
            /*
             * L — the arrival pack. Every field is nullable and the page draws
             * only what is there: a site nobody has filled in shows an honest
             * "not recorded" rather than a row of blanks that reads like the
             * information exists and is empty.
             */
            arrival: {
              addressLines: [
                site.addressLine1,
                site.addressLine2,
                site.city,
                site.postcode,
              ].filter((line): line is string => !!line && !!line.trim()),
              postcode: site.postcode ?? null,
              managerName: site.managerName ?? site.manager ?? null,
              managerPhone: site.managerPhone ?? null,
              outOfHours: site.outOfHoursContact ?? null,
              accessMethod: site.accessMethod ?? null,
              accessContact: site.accessContact ?? null,
              accessUrl: site.accessUrl ?? null,
              accessNotes: site.accessNotes ?? null,
              openingHours: site.openingHours ?? null,
              parking: site.parkingNotes ?? null,
              keysAndAlarm: site.keyAlarmNotes ?? null,
              deliveries: site.deliveryRestrictions ?? null,
              /*
               * Counted from this site's own history rather than typed by
               * anybody — a field nobody maintains is an empty field.
               */
              pastAccessProblems: accessTrouble.map((row) => ({
                when: row.when ?? null,
                what: (row.reason || row.note || "").slice(0, 180),
              })),
            },
          }
        : null,
      issuePhotos: withUrls(issuePhotos),
      completionPhotos: withUrls(completionPhotos),
      uploadSlots: uploadSlots(scope, columns),
      permissions: {
        allowedKinds: scope.evidenceSlots,
        canComment: scope.canComment,
        canRequestCompletion: scope.canRequestCompletion,
      },
      /* "viewer" renders the read-only ticket page — no action sections. */
      audience: scope.audience,
      expiresAt: scope.expiresAt,
    });
  } catch {
    return Response.json(
      { error: "This is temporarily unavailable. Please try again shortly." },
      { status: 503 },
    );
  }
}

/**
 * POST /api/job-link/[token] — submit notes, request completion, or report a
 * blocker. File upload goes through /api/files with the same token.
 */
/**
 * A signature, or nothing.
 *
 * Accepts only a PNG data URL, because that is the one thing the signature pad
 * produces and anything else arriving here is either a mistake or somebody
 * trying their luck. Bounded at 96 KB: a signature drawn on a phone is three
 * to fifteen, and without a ceiling this column is an unauthenticated way to
 * put an arbitrary image in the database.
 *
 * Silence rather than an error on a bad value — the signature is optional, and
 * refusing the whole completion because a canvas produced something odd would
 * strand a contractor who has done the work and photographed it.
 */
const SIGNATURE_LIMIT = 96 * 1024;

function readSignature(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("data:image/png;base64,")) return null;
  if (trimmed.length > SIGNATURE_LIMIT) return null;
  // A blank pad still produces a valid PNG; a few hundred bytes of it is an
  // empty canvas, not a signature.
  if (trimmed.length < 800) return null;
  return trimmed;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    await ensureDatabase();
    const db = await getDb();
    const { token } = await params;

    const scope = await resolveJobToken(db, token);
    if (!scope) return unauthorised();

    /*
     * A viewer link is read-only in FULL: no note, no completion request, no
     * blocked report. Refused here as well as rendered without the controls,
     * because a public page's buttons are advisory and its API is the rule.
     */
    if (scope.audience === "viewer") {
      return bad("This link is view-only.", 403);
    }

    const body = await request.json().catch(() => ({}));
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 2000) : "";
    const by = typeof body.by === "string" ? body.by.trim().slice(0, 120) : "";
    const finishedOn = completionDate(body.completedOn);
    const signature = readSignature(body.signature);

    /*
     * Every submission files whatever has been uploaded onto the board first.
     *
     * Uploading and submitting are two requests, and the contractor may make
     * several of the first before one of the second. Doing this once, here,
     * means the coordinator sees the photographs in the column they look at
     * whichever button was pressed — and there is no path where evidence is
     * recorded but invisible.
     */
    const columns = await fileColumns(db, scope);
    await fileEvidenceOntoBoard(db, scope, columns.completion);

    if (body.intent === "blocked") {
      const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 120) : "";
      if (!reason) return bad("Please say why the job could not be completed.");
      await db
        .update(maintenanceRequests)
        .set({
          blockedReason: reason,
          /*
           * ONLY WHAT WAS SENT — see the note on the completion branch below.
           * A contractor reporting a second obstruction should not silently
           * erase what they wrote about the first.
           */
          ...(note ? { completionNote: note } : {}),
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(
          and(
            eq(maintenanceRequests.id, scope.requestId),
            eq(maintenanceRequests.organisationId, scope.organisationId),
          ),
        );
      if (note && scope.canComment) {
        await recordComment(db, scope, `Could not complete — ${reason}. ${note}`, by);
      }
      await recordTokenUse(db, scope.id);
      await notifyCoordinator(db, scope, "blocked", by || null, note || null, reason);
      return Response.json({ ok: true, recorded: "blocked" });
    }

    if (body.intent === "complete") {
      if (!scope.canRequestCompletion) {
        return bad("This link cannot mark work complete.", 403);
      }

      // Z10 — the contractor REQUESTS completion. A coordinator accepts it.
      // The board's own status is never set from a public link, because the
      // product's promise is that a job closes on verified evidence.
      //
      // Counted by kind OR by column: `fileEvidenceOntoBoard` above has just
      // stamped the column onto this job's completion photos, and the imported
      // photographs carry the column and no kind at all. Counting one way only
      // would refuse a contractor who had just uploaded three photographs.
      const [uploaded] = await db
        .select({ total: sql<number>`COUNT(*)` })
        .from(attachments)
        .where(
          and(
            eq(attachments.organisationId, scope.organisationId),
            eq(attachments.requestId, scope.requestId),
            or(
              eq(attachments.kind, "completion"),
              columns.completion
                ? eq(attachments.boardColumnId, columns.completion)
                : undefined,
            ),
          ),
        );

      if (Number(uploaded?.total ?? 0) === 0) {
        return bad(
          "Please upload a photo of the completed work before marking this done.",
        );
      }

      /*
       * The date the contractor gives is the date recorded.
       *
       * `completion_requested_at` and not `completed_at`. The drawer already
       * renders this as "Completion requested by <name> on <date>", so the
       * date the engineer typed is what the coordinator reads — while
       * `completed_at` stays the coordinator's to set, because every meter,
       * insight and "closed" count in the dashboard is keyed off it and a
       * public link must not be able to close a job by writing a date.
       */
      await db
        .update(maintenanceRequests)
        .set({
          completionRequestedAt: finishedOn ?? sql`CURRENT_TIMESTAMP`,
          completionRequestedBy: by || "Contractor",
          /*
           * ONLY WHAT WAS SENT. This was `note || null`, which is a WRITE of
           * null whenever the box is empty — so a contractor who submitted with
           * a note, then submitted again to attach one more photograph, silently
           * destroyed the note they had already written. Nothing on the page
           * warns them, and the coordinator sees the second, emptier version.
           *
           * The same discipline `supplied()` enforces on the workspace API: an
           * absent field means "unchanged", not "cleared". There is deliberately
           * no way to clear a note from here — the public page offers no such
           * intent, and inventing one out of an empty textarea is how the
           * information got lost in the first place.
           */
          ...(note ? { completionNote: note } : {}),
          /*
           * The signature, the moment it was given, and the name typed beside
           * it. Written together or not at all: a signature with no name and no
           * time is a squiggle, and the three are only worth anything as a set.
           *
           * The TIME is the server's, not the browser's — a signing time a
           * device could set is not a record of anything. The DATE the work was
           * finished stays the contractor's to state, because they were there
           * and we were not; the two answer different questions and are stored
           * separately.
           */
          ...(signature
            ? {
                completionSignature: signature,
                completionSignedAt: new Date().toISOString(),
                completionSignedBy: by || "Contractor",
              }
            : {}),
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(
          and(
            eq(maintenanceRequests.id, scope.requestId),
            eq(maintenanceRequests.organisationId, scope.organisationId),
          ),
        );

      if (scope.canComment) {
        await recordComment(
          db,
          scope,
          completionUpdate(note, finishedOn),
          by,
        );
      }

      await recordTokenUse(db, scope.id);
      await notifyCoordinator(db, scope, "completion", by || null, note || null, null);
      return Response.json({
        ok: true,
        recorded: "completion-requested",
        completionRequestedAt: finishedOn,
        message: "Thanks. Your coordinator will review the evidence and close the job.",
      });
    }

    if (!scope.canComment) return bad("This link cannot add notes.", 403);
    if (!note && !finishedOn) return bad("Please write a note before sending.");

    await db
      .update(maintenanceRequests)
      .set({
        /*
         * ONLY WHAT WAS SENT — see the completion branch. The guard above
         * already refuses a submission carrying neither a note nor a date, so
         * reaching here with no note means the contractor sent a DATE, and
         * their earlier note must survive it.
         */
        ...(note ? { completionNote: note } : {}),
        ...(finishedOn ? { completionRequestedAt: finishedOn } : {}),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          eq(maintenanceRequests.id, scope.requestId),
          eq(maintenanceRequests.organisationId, scope.organisationId),
        ),
      );

    await recordComment(db, scope, completionUpdate(note, finishedOn), by);
    await recordTokenUse(db, scope.id);
    return Response.json({ ok: true, recorded: "note" });
  } catch {
    return Response.json(
      { error: "This is temporarily unavailable. Please try again shortly." },
      { status: 503 },
    );
  }
}
