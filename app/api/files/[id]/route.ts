import { and, eq, inArray, or } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import {
  activityLog,
  attachments,
  maintenanceRequests,
} from "../../../../db/schema";
import type { MaintenanceRequest } from "../../../lib/types";
import { resolveJobToken } from "../../../lib/job-tokens";
import {
  anonymousRefusal,
  scopedDb,
  scopedDbWithCapability,
} from "../../../lib/tenant-db";
import { auditActor, changeDetail, recordAudit } from "../../../lib/audit";
import { reconcileAttachmentCounts } from "../../../lib/attachment-counts";
import { chunkIds } from "../../../lib/sql-batching";
import {
  FIELD_LIMITS,
  anchorRefusal,
  anchorReferencesRefusal,
  attachmentPayload,
  documentFieldSnapshot,
  documentFieldUpdates,
  releaseComplianceLinks,
  type Anchors,
} from "../documents";

/**
 * The only types rendered inline in the browser.
 *
 * Deliberately much smaller than the upload allowlist: a Word document or a zip
 * is legitimate to STORE and has no business being rendered by a browser on
 * this origin. SVG is absent on purpose — it is a script container.
 *
 * Anything not listed is served as `application/octet-stream` with an
 * attachment disposition, which downloads rather than executes.
 */
const INLINE_SAFE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "application/pdf",
]);

/**
 * The bucket, resolved once for both handlers in this file.
 *
 * Each `await import("cloudflare:workers")` and each `R2Bucket` annotation is
 * its own unresolved-type error while the Workers types are absent, so a
 * second copy of this pair silently moved the project's 20-error baseline to
 * 22 — and that baseline is what tells the next person whether they broke
 * something. One accessor, two callers, no drift.
 */
async function bucket() {
  const { env } = await import("cloudflare:workers");
  return (env as unknown as { BUCKET?: R2Bucket }).BUCKET;
}


/**
 * WHAT A DOWNLOAD IS CALLED. This is a policy, not a formatting detail.
 *
 * THE DEFECT. This route served `record.originalName` — the name the uploading
 * phone or scanner chose. So a photograph filed as `IMG_7560.jpeg` and then
 * retitled "Highcross completion photo" in Documents still arrived on disk as
 * `IMG_7560.jpeg`. Every screen in the product called it by its title and the
 * one artefact that LEAVES the product called it something else — which is the
 * worst place for the two to disagree, because the file on a surveyor’s disk is
 * the copy that gets emailed, filed and argued about months later.
 *
 * THE RULE, and it is deliberately the SAME rule the client already applies.
 * `documentName` in app/(app)/portal/views/document-register.ts is the canonical
 * display name — "the stored `title` when somebody has set one, and the filename
 * otherwise […] never a title that is only whitespace". `servedFileName` is that
 * rule plus the two things a NAME ON A DISK needs and a name on a screen does
 * not: a real extension, and characters an operating system and an HTTP header
 * will both accept. A second, disagreeing naming rule is not introduced here. If
 * the register calls it X, the download is called X.
 *
 * THE EXTENSION IS PRESERVED, which is the half a naive rename gets wrong. A
 * title is prose; it has no extension and must not be given a false one. So the
 * extension comes from `original_name` — the byte-truth — and is appended to the
 * title unless the title already ends in it. `IMG_7560.jpeg` retitled "Highcross
 * completion photo" downloads as "Highcross completion photo.jpeg"; a title that
 * already reads "…photo.jpeg" keeps a single `.jpeg`.
 *
 * `original_name` IS NOT REWRITTEN, and neither is `object_key`. PATCH’s own
 * contract below says so — "`original_name` in particular stays the byte-truth" —
 * and it is the provenance that a version history, an audit event and a forensic
 * question are answered from. `object_key` embeds the attachment id, is unique,
 * and is served `immutable`; renaming an R2 object so a header reads better would
 * invalidate that for a cosmetic gain.
 */

/**
 * A filename an operating system and an HTTP header will both accept.
 *
 * A title is free text an operator typed, and it now reaches a RESPONSE HEADER —
 * so CR and LF are a header-injection vector and are removed HERE rather than
 * relied upon to be escaped downstream. Path separators go because `a/b.jpeg` is
 * a traversal in a save dialog, and the rest of the set (`: * ? " < > |`) is what
 * Windows refuses outright, so a title containing one would otherwise produce a
 * file the reader cannot save at all.
 *
 * Replaced with a visible `-` rather than deleted: a name with a character
 * silently removed can read as a different, plausible name.
 */
function sanitiseFileName(raw: string) {
  return (
    raw
      // CR, LF, NUL, tab and every other control character. The header defence.
      .replace(/[\u0000-\u001F\u007F]+/g, " ")
      // Path separators, quotes, and the characters Windows will not store.
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      // A leading dot hides the file on Unix. A trailing dot or space is dropped
      // silently by Windows, which would eat the extension just preserved.
      .replace(/^[.\s]+/, "")
      .replace(/[.\s]+$/, "")
  );
}

/**
 * The real extension of a stored filename, dot included, or "" when it has none.
 *
 * Deliberately strict. "Site report v1.2 final" contains a dot and has no
 * extension; appending ".2 final" to a title would be worse than appending
 * nothing. `dot <= 0` stops a dotfile (`.gitignore`) being read as all extension
 * and no name. Case is preserved — `.JPEG` is what the row actually says.
 */
function fileExtension(storedName: string) {
  const base = storedName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  const extension = base.slice(dot);
  return /^\.[A-Za-z0-9]{1,12}$/.test(extension) ? extension : "";
}

/** Long enough for any real title, short enough for every filesystem. */
const MAX_FILE_NAME = 120;

function capLength(name: string) {
  if (name.length <= MAX_FILE_NAME) return name;
  const extension = fileExtension(name);
  const stem = name.slice(0, name.length - extension.length);
  return `${stem.slice(0, MAX_FILE_NAME - extension.length).trimEnd()}${extension}`;
}

/**
 * HISTORICAL VERSIONS — the decided policy, written down because it is a choice.
 *
 * A superseded version is its own row with its own `title` and its own
 * `original_name`, and this route reads ONE row by id, so a historical download
 * is named from THAT row: its own title if it has one, its own stored filename
 * otherwise. Naming version 1 from version 3’s title would be a lie about a file
 * whose bytes are not version 3’s.
 *
 * WITH ONE ADDITION: a non-current row carries " (vN)" before the extension.
 * `planVersion` CARRIES THE TITLE FORWARD — "a new version of a document is the
 * SAME document" — so every row in a lineage normally shares one title, and
 * without the marker downloading three versions of one certificate drops
 * `cert.pdf`, `cert (1).pdf` and `cert (2).pdf` into a folder, numbered by the
 * order they were CLICKED rather than by version. The entire reason to download a
 * superseded version is to hold the historical one, and a name that cannot say
 * which one it is defeats that. The current version is never marked, so the
 * ordinary download is untouched.
 */
function servedFileName(record: {
  title: string | null;
  originalName: string;
  isCurrent: boolean;
  versionNo: number;
}) {
  const stored = sanitiseFileName(record.originalName) || "document";
  const title = sanitiseFileName(record.title ?? "");

  let name = stored;
  if (title) {
    const extension = fileExtension(record.originalName);
    name =
      !extension || title.toLowerCase().endsWith(extension.toLowerCase())
        ? title
        : `${title}${extension}`;
  }

  if (!record.isCurrent) {
    const extension = fileExtension(name);
    const stem = name.slice(0, name.length - extension.length);
    name = `${stem} (v${record.versionNo})${extension}`;
  }

  return capLength(name);
}

/**
 * The header itself, and the last line of defence.
 *
 * Both forms, always. `filename*=UTF-8''` is what carries a non-ASCII title
 * intact — every current browser prefers it — and the plain `filename="…"` is the
 * fallback for anything that does not, which is why it is folded to ASCII rather
 * than dropped.
 *
 * The two replacements below are NOT redundant with `sanitiseFileName`. That
 * function decides what the file is CALLED; these decide what may appear inside a
 * quoted header value, and they run for every caller of this helper whether or
 * not the name reached it through the sanitiser. Belt and braces is the correct
 * amount of belt and braces on a response header.
 */
function contentDisposition(name: string, download: boolean) {
  const ascii = name.replace(/[^\x20-\x7E]+/g, "-").replace(/["\\]/g, "-");
  const mode = download ? "attachment" : "inline";
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function parseRange(value: string | null, size: number) {
  const match = value?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const requestedStart = match[1] ? Number(match[1]) : null;
  const requestedEnd = match[2] ? Number(match[2]) : null;
  if (requestedStart === null && requestedEnd === null) return null;

  const start =
    requestedStart === null
      ? Math.max(size - Math.min(requestedEnd ?? 0, size), 0)
      : requestedStart;
  const end = Math.min(
    requestedStart === null ? size - 1 : (requestedEnd ?? size - 1),
    size - 1,
  );
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return null;
  }
  return { start, end, length: end - start + 1 };
}

function requestPayload(
  row: typeof maintenanceRequests.$inferSelect,
): MaintenanceRequest {
  const payload = { ...row } as Record<string, unknown>;
  delete payload.publicUploadTokenHash;
  delete payload.publicUploadTokenExpiresAt;
  delete payload.createdByEmail;
  delete payload.organisationId;
  delete payload.legacyClientId;
  delete payload.createdAt;
  delete payload.updatedAt;
  return payload as unknown as MaintenanceRequest;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  await ensureDatabase();
  /*
   * A contractor's job link may fetch that job's photographs, and nothing else.
   *
   * Without this the share link is a 500 in production: the page shows the
   * fault photos, and every one of them resolves here, where an anonymous
   * caller has no session and `scopedDb` throws. It appears to work in
   * development only because the demo identity answers as a super admin.
   *
   * The token does two jobs. It permits the read at all, and it decides which
   * tenant and which job the read is confined to — so a link for job B cannot
   * fetch job A's evidence even though attachment ids are unguessable. The
   * organisation comes from the token rather than from the ambient request,
   * because an anonymous request resolves to the primary organisation whatever
   * the token says.
   *
   * A signed-in caller ignores all of this and reads their own workspace as
   * before; the token path is only consulted when there is no session.
   */
  const shareToken = new URL(request.url).searchParams.get("token")?.trim() ?? "";
  /*
   * A SESSION THAT HAS ENDED IS NOT AN OUTAGE — and on this route it was a 500.
   *
   * Without a token `allowAnonymous` is false, so `scopedDb` refuses a caller
   * with no session by throwing. This handler had no catch, so the throw
   * escaped and the framework answered 500 WITH AN EMPTY BODY. Measured against
   * the deployed preview: a real id, a nonexistent id and a malformed id all
   * gave the identical empty 500 — the throw happens before the row lookup —
   * while the same request with any `?token=` value returned a clean 404,
   * which isolates the refusal as the only cause.
   *
   * The sibling index route already carries this fix and names the symptom in
   * the same words (app/api/files/route.ts, `unavailable`): "an outage where
   * every sibling route says 'sign in', and a stack trace in the log for a
   * request that was correctly refused". It was applied there and not here, and
   * this is the busier route of the two — every thumbnail on a board resolves
   * through it, so one expired session produced a burst of false 500s in error
   * monitoring instead of a single sign-in prompt.
   *
   * Wrapped at the call rather than around the whole handler, which is the
   * idiom PUT below already uses: `anonymousRefusal` answers the refusal and
   * anything else is re-thrown, so a genuine fault is still a fault.
   */
  let scope: Awaited<ReturnType<typeof scopedDb>>;
  try {
    scope = await scopedDb(request, { allowAnonymous: Boolean(shareToken) });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    throw error;
  }
  const { db, orgId, authenticated } = scope;

  const linkScope =
    !authenticated && shareToken ? await resolveJobToken(db, shareToken) : null;
  if (!authenticated && shareToken && !linkScope) {
    // Unknown, expired and revoked are one answer, so a dead link cannot be
    // used to probe whether a file exists.
    return Response.json({ error: "File not found." }, { status: 404 });
  }

  const readableOrgId = linkScope ? linkScope.organisationId : orgId;
  const [record] = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.organisationId, readableOrgId)))
    .limit(1);
  if (!record) {
    return Response.json({ error: "File not found." }, { status: 404 });
  }

  // The link reaches its own job's evidence only. Same 404 as a missing file:
  // a token holder learns nothing about what exists outside their job.
  if (linkScope && record.requestId !== linkScope.requestId) {
    return Response.json({ error: "File not found." }, { status: 404 });
  }

  const storage = await bucket();
  if (!storage) {
    return Response.json({ error: "File storage is unavailable." }, { status: 503 });
  }

  const search = new URL(request.url).searchParams;
  const download = search.get("download") === "1";

  /*
   * `?thumb=1` serves a derivative if one exists, and the original if not.
   *
   * The board draws up to three 22px tiles per photo cell. Serving the
   * originals into them means a 4.5 MB, 4284x5712 photograph decoded into a
   * thumbnail — measured, not guessed — and with two photo columns across 744
   * rows that is tens of megabytes for a screenful. On a phone it is the
   * difference between a board that loads and one that does not.
   *
   * The derivative is written by `db/monday-export/generate-thumbnails.mjs`,
   * which resizes with sharp outside the Worker — workerd has no image
   * pipeline, so this cannot happen on the request path.
   *
   * Falling back rather than 404ing is the important part: a file uploaded
   * through the app has no derivative until that script runs again, and a
   * missing thumbnail must degrade to a heavy image, never to a broken one.
   */
  const wantsThumbnail = search.get("thumb") === "1";
  const thumbnailKey = `${record.objectKey}.thumb`;
  const thumbnailHead = wantsThumbnail
    ? await storage.head(thumbnailKey)
    : null;
  const servingThumbnail = Boolean(thumbnailHead);
  const key = servingThumbnail ? thumbnailKey : record.objectKey;

  const head = servingThumbnail ? thumbnailHead : await storage.head(record.objectKey);
  if (!head) {
    return Response.json({ error: "File bytes are unavailable." }, { status: 404 });
  }

  // A thumbnail is a few kilobytes and never ranged; only video seeking needs it.
  const range = !download && !servingThumbnail && record.contentType.startsWith("video/")
    ? parseRange(request.headers.get("range"), head.size)
    : null;
  const object = await storage.get(
    key,
    range ? { range: { offset: range.start, length: range.length } } : undefined,
  );
  if (!object) {
    return Response.json({ error: "File bytes are unavailable." }, { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);

  /*
   * What the browser is allowed to do with these bytes.
   *
   * The stored `content_type` came from the uploader and used to be echoed
   * straight back with `Content-Disposition: inline`, so a file named
   * `poc.png` declaring `text/html` was served as HTML on this origin and ran.
   * The upload path now refuses that combination, but bytes stored BEFORE that
   * fix are still in the bucket — so the decision is made here as well, where
   * it does not depend on the upload path having been right.
   *
   * Only a small set is rendered inline. Everything else is served as an opaque
   * download whatever it claims to be: a spreadsheet the browser downloads is
   * the correct experience; one the browser executes is not.
   */
  const stored = (record.contentType || "").toLowerCase();
  const inlineSafe = servingThumbnail || INLINE_SAFE_TYPES.has(stored);
  const servedType = servingThumbnail
    ? "image/webp"
    : inlineSafe
      ? stored
      : "application/octet-stream";
  const forceAttachment = download || !inlineSafe;

  headers.set("Content-Type", servedType);
  headers.set(
    "Content-Disposition",
    contentDisposition(servedFileName(record), forceAttachment),
  );
  /*
   * Without this a browser may sniff past the type above and run whatever it
   * decides the bytes are, which would undo the whole paragraph.
   */
  headers.set("X-Content-Type-Options", "nosniff");
  // Even if something is rendered, it may not fetch, script, or be framed.
  // `sandbox` drops same-origin privileges for the document itself.
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
  );
  /*
   * Both objects are immutable by construction, so both may say so. An
   * attachment id is minted per upload and no route ever rewrites bytes under
   * an existing id — "replacing" a file is delete-and-reupload, which is a
   * NEW id and therefore a new URL. The original used to carry max-age=300,
   * which made the hover preview refetch a multi-megabyte photograph every
   * five minutes for a card that had already shown it.
   */
  headers.set("Cache-Control", "private, max-age=86400, immutable");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(range?.length ?? object.size));
  if (range) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${head.size}`);
  }

  return new Response(object.body, {
    status: range ? 206 : 200,
    headers,
  });
}

/**
 * The capability refusal, with the reversible alternative named on it.
 *
 * `capabilityDenied` answers "your role does not have data.delete", which is
 * true and useless: the person reading it pressed Delete on a certificate and
 * needs to be told that Archive is right there and is theirs. The shape is not
 * changed — `capability`, `role` and `denied` all survive, so anything
 * branching on this 403 branches on it exactly as it branches on every other
 * route's; only the sentence grows and one flag is added.
 *
 * The denial is cloned before it is read, so a body this cannot parse is still
 * returned intact rather than returned consumed.
 */
async function archiveInstead(denied: Response) {
  const body = (await denied
    .clone()
    .json()
    .catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.error !== "string") return denied;
  return Response.json(
    {
      ...body,
      error: `${body.error} Deleting a document permanently destroys its file and every earlier version of it. Archive it instead to take it off the register without losing it.`,
      archiveInstead: true,
    },
    { status: denied.status },
  );
}

/**
 * DELETE /api/files/[id] — destroy a document for good.
 *
 * W07-06, and two decisions that used to be left to whoever pressed the button.
 *
 * 1. `data.delete`, NOT `board.edit`.
 *
 *    This handler used to require `board.edit` — the capability that renames a
 *    row — and its own comment said so approvingly. Measured against the
 *    running server with a real invited `admin` (holds `board.edit`, does not
 *    hold `data.delete`, role confirmed from `/api/context`): the request was
 *    answered 200 and the document, its bytes and its history were gone.
 *    `/api/trash` had already settled the rule for the identical act on a
 *    different table — "DELETE `data.delete` — permanent. `data.delete` is
 *    withheld from `admin` by default precisely so the irreversible verb has to
 *    be granted deliberately" — and a compliance certificate is not a lesser
 *    thing than a board row. Archiving and restoring stay on `board.edit` for
 *    that route's stated reason and for the same one here: demanding the
 *    destructive capability to undo a mistake pushes people towards leaving the
 *    mistake in place.
 *
 *    An editor is not left with nothing. `PATCH { archived: true }` two
 *    handlers down is `board.edit`, is reversible, and takes a document off the
 *    live register, out of the board's photo strips and out of every counter —
 *    `liveAttachmentRows()` excludes an archived row exactly as it excludes a
 *    deleted one. Taking a document off the register is an editor's act;
 *    destroying the evidence is not.
 *
 * 2. DELETING THE HEAD DELETES THE LINEAGE.
 *
 *    A document is a lineage; a version is not a document. Before this,
 *    deleting the current version destroyed one row and left the rest behind —
 *    measured: a three-version certificate deleted at v3 left v1 and v2 in the
 *    table with `is_current = false` and their bytes in the bucket. Every
 *    register, counter and photo strip filters on `is_current`, so the lineage
 *    vanished from the product while remaining in storage for ever, reachable
 *    by no screen and deletable by no route. The confirmation the browser shows
 *    already promises "its N versions go with it"; this is the handler keeping
 *    that promise rather than the dialog telling a lie.
 *
 *    Deleting a SUPERSEDED version destroys only that version, which is the
 *    other half of the same rule: pruning one old copy is not destroying the
 *    document, and the head — the row every register reads — is untouched. The
 *    audit event says which of the two happened.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  await ensureDatabase();

  /*
   * Wrapped because `scopedDbWithCapability` THROWS for an anonymous caller
   * rather than returning a refusal — the same reason PATCH and PUT below wrap
   * it. Unwrapped, a request from a session that had ended left this handler as
   * an empty 500 instead of the 401 every sibling route answers.
   */
  let guard: Awaited<ReturnType<typeof scopedDbWithCapability>>;
  try {
    guard = await scopedDbWithCapability(request, "data.delete");
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    throw error;
  }
  if (guard.denied) return archiveInstead(guard.denied);
  const { actor, db, orgId } = guard.scope;
  const [record] = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.organisationId, orgId)))
    .limit(1);
  /*
   * CROSS-TENANT IS ANSWERED HERE, BEFORE ANYTHING IS DESTROYED.
   *
   * The lookup is scoped by `organisation_id`, so another workspace's document
   * reads as "not found" — the same answer as an id that never existed, so this
   * route cannot be used to discover what another tenant holds. It matters that
   * the refusal is here rather than later: every mutation below reads `record`,
   * so a row in another tenant reaches neither the compliance release, nor the
   * bucket, nor the delete.
   */
  if (!record) {
    return Response.json({ error: "File not found." }, { status: 404 });
  }

  const storage = await bucket();
  if (!storage) {
    return Response.json({ error: "File storage is unavailable." }, { status: 503 });
  }

  /*
   * WHAT IS ABOUT TO BE DESTROYED — the lineage, or the one superseded copy.
   *
   * `coalesce(root_document_id, id)` is how a lineage is identified everywhere
   * else in this codebase (see `planVersion`), because version 1 is self-rooted
   * and stores NULL. Both halves of the OR are needed for that reason, and the
   * organisation predicate is on the outside, so nothing here can reach past
   * the tenant even if a `root_document_id` were somehow shared.
   *
   * A head always matches its own lineage, so the fallback can only fire if
   * that read came back empty — in which case destroying the row already in
   * hand is still correct, and reporting success having destroyed nothing
   * would not be.
   */
  const rootDocumentId = record.rootDocumentId ?? record.id;
  const found = record.isCurrent
    ? await db
        .select()
        .from(attachments)
        .where(
          and(
            eq(attachments.organisationId, orgId),
            or(
              eq(attachments.rootDocumentId, rootDocumentId),
              eq(attachments.id, rootDocumentId),
            ),
          ),
        )
    : [record];
  const doomed = found.length ? found : [record];
  const doomedIds = doomed.map((row) => row.id);

  /*
   * A COMPLIANCE SLOT MUST NOT BE LEFT POINTING AT NOTHING.
   *
   * `compliance_documents.attachment_id` is declared with `.references()` in
   * `db/schema.ts` and HAS NO FOREIGN KEY in the deployed Postgres DDL, so
   * nothing cascades and nothing refuses — deleting a document simply leaves the
   * compliance row naming an id that no longer resolves, and the register offers
   * a certificate link that 404s. Nulled, not deleted: the store still needs a
   * PAT certificate, it just no longer holds one, and removing the row would
   * discard the obligation along with the evidence.
   *
   * Every id in the lineage, not only the one named: a slot filled from version
   * 2 still names version 2 after version 3 supersedes it.
   *
   * Before the rows go, so a failure here stops the delete rather than
   * stranding the pointer.
   */
  await releaseComplianceLinks(db, orgId, doomedIds);

  /*
   * The thumbnail goes with it. Without this every deleted photograph leaves
   * its 96px derivative in the bucket permanently, with nothing left to
   * reference it — and a superseded version's derivative is no different.
   *
   * Chunked at 1000, R2's own ceiling for a batched delete, the way
   * `purgeColumn` in the trash route does it.
   */
  const objectKeys = doomed.flatMap((row) => [
    row.objectKey,
    `${row.objectKey}.thumb`,
  ]);
  for (const keys of chunkIds(objectKeys, 1000)) {
    await storage.delete(keys);
  }
  for (const chunk of chunkIds(doomedIds)) {
    await db.delete(attachments).where(
      and(eq(attachments.organisationId, orgId), inArray(attachments.id, chunk)),
    );
  }

  let updatedRequest: typeof maintenanceRequests.$inferSelect | undefined;
  if (record.requestId) {
    /*
     * RECOUNTED, NOT DECREMENTED.
     *
     * `max(x - 1, 0)` cannot repair a counter that was never right: a job
     * whose issue counter had been inflated to 3 by the boot back-fill in
     * `db/init.ts` still reads 2 after its only real fault photograph is
     * deleted, and the coordinator is still promised two photographs that do
     * not exist. Counting the rows that remain converges from any starting
     * value and makes a repeat of this request a no-op. See
     * `app/lib/attachment-counts.ts`.
     */
    updatedRequest = await reconcileAttachmentCounts(db, orgId, record.requestId);
  }

  /*
   * EVERY OTHER JOB THE LINEAGE TOUCHED.
   *
   * A version inherits its predecessor's anchors, but the uploader may override
   * them, so two rows of one lineage can name two different jobs. Reconciling
   * only the head's job would leave the other job's four counters promising
   * photographs that no longer exist — precisely the drift
   * `reconcileAttachmentCounts` was written to end.
   */
  const jobIds = [
    ...new Set(
      doomed
        .map((row) => row.requestId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  for (const jobId of jobIds) {
    if (jobId === record.requestId) continue;
    await reconcileAttachmentCounts(db, orgId, jobId);
  }

  /*
   * The job's own timeline, one line per destroyed row.
   *
   * `activity_log` answers the people working the job; `audit_events` answers
   * whoever has to account for the deletion months later. The two are separate
   * stores on purpose, and this is the same write it has always been — repeated
   * for each row that actually went, because a job that held three versions of
   * a certificate lost three files and its timeline should say so.
   */
  for (const row of doomed) {
    if (!row.requestId) continue;
    await db.insert(activityLog).values({
      id: crypto.randomUUID(),
      organisationId: orgId,
      entityType: "maintenance_request",
      entityId: row.requestId,
      action: "request.file_deleted",
      actorEmail: actor.email,
      detail: JSON.stringify({
        fileId: row.id,
        fileName: row.originalName,
        kind: row.kind,
      }),
    });
  }

  /*
   * W07-12 — WRITTEN OUTSIDE `if (record.requestId)`, and that is the fix.
   *
   * The `activity_log` writes above belong to a JOB's timeline, and a document
   * with no job has no timeline to write to. The consequence was that an
   * attachment with no `request_id` was permanently destroyed leaving NO trace
   * in either stream — no timeline entry, and no audit event, because documents
   * never wrote audit events at all. W07-07 makes jobless documents ordinary
   * rather than exceptional (a contractor's insurance certificate has no work
   * order), so that silent hole was about to become the common case for exactly
   * the documents most worth accounting for.
   *
   * Written AFTER the destruction, deliberately. The rule `DELETE /api/trash`
   * states: the rows and their bytes have just been destroyed, so this event is
   * the only surviving record that they existed — and an event claiming a
   * deletion that then failed would be worse than no event at all.
   *
   * ONE event for the whole act rather than one per row: a lineage destroyed is
   * a single decision by a single person, and `versions` in the detail is what
   * makes the size of it readable. Object keys are deliberately absent — the
   * audit viewer is read by administrators, and a bucket path is not something
   * a deletion record needs to hand them.
   */
  const wholeLineage = record.isCurrent && doomed.length > 1;
  await recordAudit({
    db,
    organisationId: orgId,
    actor: auditActor(guard.scope),
    action: "document.deleted",
    entityType: "document",
    entityId: record.id,
    summary: wholeLineage
      ? `Permanently deleted ${record.originalName} and its ${doomed.length - 1} earlier version${doomed.length === 2 ? "" : "s"}.`
      : `Permanently deleted ${record.originalName}.`,
    detail: {
      permanent: true,
      /*
       * Which of the two deletions this was, in one word, because a reader of
       * the audit trail needs to know whether the document is gone or whether
       * one of its old copies is.
       */
      lineage: record.isCurrent ? "whole" : "one superseded version",
      versions: doomed.length,
      versionIds: doomedIds,
      fileId: record.id,
      fileName: record.originalName,
      title: record.title,
      documentType: record.documentType,
      expiryDate: record.expiryDate,
      kind: record.kind,
      byteSize: record.byteSize,
      contentType: record.contentType,
      requestId: record.requestId,
      siteId: record.siteId,
      unitId: record.unitId,
      contractorId: record.contractorId,
      boardColumnId: record.boardColumnId,
      versionNo: record.versionNo,
      rootDocumentId,
    },
    request,
  });

  return Response.json({
    deleted: true,
    /*
     * How many rows actually went, so a caller that deleted a versioned
     * document can say so rather than inferring it from `versionNo`.
     */
    versionsDeleted: doomed.length,
    request: updatedRequest ? requestPayload(updatedRequest) : null,
  });
}


/**
 * PATCH /api/files/[id] — the document's own fields.
 *
 * W07-02 and W07-05. There was no PATCH on either file route at all: the only
 * other verb that writes here is `PUT`, and that stores a WebP thumbnail. So a
 * document's title, type, description and expiry could be set at upload and
 * never corrected, and "archive" did not exist — the only way to remove
 * something was to destroy it.
 *
 * WHAT THIS MAY NOT TOUCH, and the list is the point. Not the bytes, not
 * `object_key`, not `original_name`, not the organisation, not the uploader, not
 * the job, the site or the version lineage. Editing a document's description
 * must not be able to move it to another tenant's site or re-point it at another
 * job. `original_name` in particular stays the byte-truth: the file a person
 * downloaded must keep matching the copy on their disk, which is why `title` is
 * a separate column rather than a rename.
 *
 * THE ONE EXCEPTION, AND WHY IT IS ONE — W05-09 / W06-10. `contractorId` may be
 * set and cleared here, named explicitly and audited as its own action. Filing a
 * public liability certificate against the contractor it belongs to was
 * reachable only at the instant of upload: `POST /api/files` has accepted a
 * `contractorId` anchor since W07-07 and no screen ever sent one, so every
 * document already in the workspace was permanently unfilable and the
 * contractor-documents leg of W06-10 was a column nobody could write.
 *
 * It is still an ANCHOR CHANGE and is held to every anchor rule: the id is
 * checked against this organisation before the write, so another tenant's
 * contractor is 404 rather than accepted; and clearing it is refused when it is
 * the document's only anchor, because "a document must be filed against
 * something" is not suspended by editing. The job, site and unit anchors stay
 * write-once — a document's job is what every count, photo strip and compliance
 * slot in this product is keyed by, and nothing here has business moving it.
 *
 * PATCH semantics throughout: an absent key is unchanged, an explicit value is
 * set, an explicit null clears. That is why `documentFieldUpdates` returns a
 * SPARSE object — spreading a complete one into `.set()` would rewrite every
 * field on every edit, so renaming a certificate would silently erase its expiry
 * date and the register would read it as permanently compliant.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  await ensureDatabase();

  /*
   * `board.edit`, like DELETE two handlers up and like the thumbnail PUT below.
   * Editing a document's expiry date changes what the compliance register says
   * about a store, so it is an editor's action, not a reader's.
   *
   * Wrapped because `scopedDbWithCapability` THROWS for an anonymous caller
   * rather than returning a refusal — the same reason PUT wraps it.
   */
  let guard: Awaited<ReturnType<typeof scopedDbWithCapability>>;
  try {
    guard = await scopedDbWithCapability(request, "board.edit");
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    throw error;
  }
  if (guard.denied) return guard.denied;
  const { db, orgId, actor } = guard.scope;

  const body = (await request.json().catch(() => null)) as unknown;
  // A body of literal `null` PARSES, so the catch never fires and every
  // `body.x` below would throw straight into a 503. An array is not a record
  // either. Same guard `/api/board` and the multipart route both use.
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json(
      { error: "The request body must be a JSON object." },
      { status: 400 },
    );
  }
  const payload = body as Record<string, unknown>;

  const [record] = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.organisationId, orgId)))
    .limit(1);
  if (!record) {
    return Response.json({ error: "File not found." }, { status: 404 });
  }

  const fields = documentFieldUpdates(payload);
  // A malformed expiry is answered here. The Postgres CHECK on `expiry_date`
  // would otherwise make it a database error, and the route's catch-all would
  // report an outage for what is really a typo.
  if (!fields.ok) {
    return Response.json({ error: fields.error }, { status: 400 });
  }
  const values: Partial<typeof attachments.$inferSelect> = { ...fields.values };

  /*
   * W07-05 — ARCHIVE, the half of "archive or remove" that did not exist.
   *
   * Soft and reversible, which is the whole difference from DELETE: the bytes
   * stay, the row stays, and the document simply stops being live. `listFiles`
   * filters archived rows out by default, so an archived certificate leaves the
   * register exactly as a deleted one would — without being unrecoverable.
   *
   * `archived: true` on an already-archived document keeps the original
   * timestamp rather than refreshing it: when it was archived is a fact, and an
   * idempotent request must not rewrite history.
   */
  let archiveAction: "archived" | "restored" | null = null;
  if ("archived" in payload) {
    const wantArchived = payload.archived === true;
    const isArchived = Boolean(record.archivedAt);
    if (wantArchived && !isArchived) {
      values.archivedAt = new Date().toISOString();
      values.archivedBy = actor.email;
      archiveAction = "archived";
    } else if (!wantArchived && isArchived) {
      values.archivedAt = null;
      values.archivedBy = null;
      archiveAction = "restored";
    }
  }

  /*
   * W05-09 / W06-10 — THE CONTRACTOR ANCHOR, AFTER THE FACT.
   *
   * Same PATCH semantics as every field above: an absent key is unchanged, a
   * string files the document against that contractor, and an explicit `null`
   * unfiles it. A value equal to the one already stored is a no-op and writes
   * nothing, so re-saving an unchanged form does not produce an audit line
   * claiming the anchor moved.
   *
   * Two refusals, both BEFORE the update:
   *
   *   `anchorRefusal` — the rule that a document belongs to something. Clearing
   *   the contractor on a certificate with no job, no site and no unit would
   *   leave a row filed against nothing, which is the state W07-07's
   *   mandatory-anchor rule exists to prevent. Unfiling is allowed; unfiling
   *   into thin air is not.
   *
   *   `anchorReferencesRefusal` — the id names a contractor IN THIS TENANT.
   *   `contractor_id` does carry a real composite foreign key, so a bad id would
   *   otherwise be caught by the database and surfaced as a 503; going through
   *   the shared checker answers 404 in the words the rest of the product uses,
   *   and makes another organisation's id indistinguishable from one that never
   *   existed.
   */
  let contractorChange: { from: string | null; to: string | null } | null = null;
  if ("contractorId" in payload) {
    if (payload.contractorId !== null && typeof payload.contractorId !== "string") {
      return Response.json(
        { error: "A contractor id must be text, or null to unfile the document." },
        { status: 400 },
      );
    }
    const next =
      typeof payload.contractorId === "string"
        ? payload.contractorId.trim().slice(0, FIELD_LIMITS.anchorId)
        : "";
    const current = record.contractorId ?? "";
    if (next !== current) {
      const anchors: Anchors = {
        requestId: record.requestId ?? "",
        siteId: record.siteId ?? "",
        unitId: record.unitId ?? "",
        contractorId: next,
      };
      const unanchored = anchorRefusal(anchors);
      if (unanchored) return unanchored;
      const badAnchor = await anchorReferencesRefusal(db, orgId, anchors);
      if (badAnchor) return badAnchor;
      values.contractorId = next || null;
      contractorChange = { from: record.contractorId ?? null, to: next || null };
    }
  }

  if (!Object.keys(values).length) {
    // Nothing was asked for. A no-op is not an error, and answering 400 would
    // make a form that submits unchanged fields look broken.
    return Response.json({ file: attachmentPayload(record), unchanged: true });
  }

  values.metadataUpdatedAt = new Date().toISOString();
  values.metadataUpdatedBy = actor.email;

  const [updated] = await db
    .update(attachments)
    .set(values)
    .where(and(eq(attachments.id, id), eq(attachments.organisationId, orgId)))
    .returning();

  /*
   * W07-12. `changeDetail` reduces the edit to the fields that actually moved,
   * so the Audit viewer renders a before/after table rather than a blob — and so
   * an edit that touched one field does not read as having touched everything.
   */
  await recordAudit({
    db,
    organisationId: orgId,
    actor: auditActor(guard.scope),
    /*
     * The anchor move gets its own verb rather than hiding inside
     * "metadata_updated". "Who filed this certificate against this contractor,
     * and when" is a different question from "who corrected its expiry date",
     * and a log that answers both with one word can be searched for neither.
     * The archive verbs still win where both happened in one request:
     * withdrawing a document from the register is the larger fact about it.
     */
    action:
      archiveAction === "archived"
        ? "document.archived"
        : archiveAction === "restored"
          ? "document.restored"
          : contractorChange
            ? contractorChange.to
              ? "document.contractor_linked"
              : "document.contractor_unlinked"
            : "document.metadata_updated",
    entityType: "document",
    entityId: id,
    summary:
      archiveAction === "archived"
        ? `Archived ${updated.title || updated.originalName}.`
        : archiveAction === "restored"
          ? `Restored ${updated.title || updated.originalName} from the archive.`
          : contractorChange
            ? contractorChange.to
              ? `Filed ${updated.title || updated.originalName} against a contractor.`
              : `Unfiled ${updated.title || updated.originalName} from its contractor.`
            : `Updated the details of ${updated.title || updated.originalName}.`,
    detail: changeDetail(
      documentFieldSnapshot(record),
      documentFieldSnapshot(updated),
    ),
    request,
  });

  return Response.json({ file: attachmentPayload(updated) });
}

/** A thumbnail is a few kilobytes. Anything larger is not a thumbnail. */
const MAX_THUMBNAIL_BYTES = 512 * 1024;

/**
 * Stores a pre-rendered thumbnail beside its original.
 *
 * The Workers runtime has no image pipeline, so a derivative cannot be made on
 * the request path. `db/monday-export/generate-thumbnails.mjs` resizes with
 * sharp outside the Worker and PUTs the result here; `GET /api/files/[id]?thumb=1`
 * then serves it, falling back to the original when it is absent.
 *
 * Why an endpoint rather than writing R2 directly: the bucket the dev server
 * reads is Miniflare's, whose on-disk layout is an internal detail and differs
 * from the one `wrangler r2 object put` writes. Going through the app is the
 * only way to be sure the bytes land where the app will look for them — the
 * same reason the asset import uploads through `/api/files` rather than
 * writing rows and objects separately.
 *
 * Guarded by `board.edit`. Writing a derivative changes what every viewer of
 * that board sees, so it is an editor's action, not a reader's.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  await ensureDatabase();

  /*
   * A missing derivative is a nicety; an anonymous caller asking for one is not
   * an outage. The public form uploads a photograph with no session behind it,
   * and the browser then offers a thumbnail here — where
   * `scopedDbWithCapability` THROWS for an anonymous request instead of
   * returning a refusal, which surfaced as a 500 on an ordinary submission.
   * Refused the way every other route refuses, so the log stays honest about
   * what is actually broken.
   */
  let guard: Awaited<ReturnType<typeof scopedDbWithCapability>>;
  try {
    guard = await scopedDbWithCapability(request, "board.edit");
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    throw error;
  }
  if (guard.denied) return guard.denied;
  const { db, orgId } = guard.scope;

  const [record] = await db
    .select({ objectKey: attachments.objectKey })
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.organisationId, orgId)))
    .limit(1);
  if (!record) {
    return Response.json({ error: "File not found." }, { status: 404 });
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.byteLength) {
    return Response.json({ error: "No thumbnail bytes were sent." }, { status: 400 });
  }
  if (bytes.byteLength > MAX_THUMBNAIL_BYTES) {
    return Response.json(
      { error: "That is larger than a thumbnail should ever be." },
      { status: 413 },
    );
  }

  /*
   * WebP only, checked by signature rather than by the caller's word.
   *
   * "RIFF" then "WEBP" at byte 8. A derivative endpoint that stored whatever it
   * was handed would be an arbitrary write into the bucket under a key derived
   * from someone else's file.
   */
  const isWebp =
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (!isWebp) {
    return Response.json(
      { error: "A thumbnail must be WebP." },
      { status: 415 },
    );
  }

  const storage = await bucket();
  if (!storage) {
    return Response.json({ error: "File storage is unavailable." }, { status: 503 });
  }

  await storage.put(`${record.objectKey}.thumb`, bytes, {
    httpMetadata: { contentType: "image/webp" },
  });

  return Response.json({ ok: true, bytes: bytes.byteLength });
}
