/**
 * Photographs in, photographs out.
 *
 * Three ways bytes arrive, and they are not equally trusted:
 *
 *   1. A signed-in caller attaching to a job — trusted as far as `scopeFor()`
 *      says, which is the same predicate the rest of the product uses. There is
 *      no organisation filter written by hand in this file.
 *   2. A contractor through a share link, with no account — the token proves
 *      only that somebody forwarded them a URL, so the attachment lands
 *      `pending = true` and is invisible until staff release it. Without that
 *      gate, anyone who is ever sent a link can publish an image into a
 *      client's record forever.
 *   3. The public intake form, before its `job_requests` row exists — bytes go
 *      to `pending_uploads` and are claimed into `attachments` by the same
 *      transaction that writes the request.
 *
 * One way bytes leave: a short-lived signed URL, minted only after the same
 * access check that guards the job the attachment hangs off. `object_key` is
 * never a URL and is never enough on its own.
 */
import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import {
  canTriage,
  isStaff,
  scopeFor,
  siteScopeFor,
  withScope,
  type Actor,
} from "../lib/access.ts";
import { requireActor, type Env } from "../lib/middleware.ts";
import { clientIp, rateLimit, str } from "../lib/http.ts";
import { hashIp } from "../lib/sessions.ts";
import { sendMailBestEffort, templates } from "../lib/mail.ts";
import { jobForShareToken } from "../lib/share.ts";
import {
  getStorage,
  SIGNED_URL_TTL_SECONDS,
  verifyObjectToken,
} from "../lib/storage.ts";
import {
  ALLOWED_CONTENT_TYPES,
  ATTACHMENT_KINDS,
  checkUpload,
  defaultKindFor,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_MB,
  MULTIPART_SLACK_BYTES,
  objectKeyFor,
  safeOriginalName,
} from "../lib/files.ts";

const webUrl = () =>
  (process.env.WEB_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const adminEmail = () => process.env.ADMIN_EMAIL ?? "info@maintsupp.com";

/* --------------------------------------------------------- reading a body -- */

type ReceivedFile = {
  bytes: Uint8Array;
  contentType: string;
  extension: string;
  originalName: string;
  form: FormData;
};

type Received =
  | { ok: true; file: ReceivedFile }
  | { ok: false; status: 400 | 413 | 415; error: string };

const isFileLike = (value: unknown): value is File =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as File).arrayBuffer === "function";

/**
 * Reads the one file out of a multipart body, or explains why not.
 *
 * `Content-Length` is checked first so a 500MB body is refused before it is
 * buffered. That header is a claim like any other — a chunked request can omit
 * it entirely — which is why the real byte length is checked again inside
 * `checkUpload` after the body has been read. The header check is a cheap
 * early exit, not the limit.
 */
async function receiveFile(c: Context<Env>): Promise<Received> {
  const declaredLength = Number(c.req.header("content-length") ?? "");
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_UPLOAD_BYTES + MULTIPART_SLACK_BYTES
  ) {
    return {
      ok: false,
      status: 413,
      error: `Files must be ${MAX_UPLOAD_MB}MB or smaller.`,
    };
  }

  const form = await c.req.formData().catch(() => null);
  if (!form) {
    return { ok: false, status: 400, error: "Send the file as form data." };
  }

  const field = form.get("file");
  if (!isFileLike(field)) {
    return { ok: false, status: 400, error: "Attach a file." };
  }

  const bytes = new Uint8Array(await field.arrayBuffer());
  const check = checkUpload(field.type ?? "", bytes);
  if (!check.ok) return { ok: false, status: check.status, error: check.error };

  return {
    ok: true,
    file: {
      bytes,
      contentType: check.contentType,
      extension: check.extension,
      originalName: safeOriginalName(field.name ?? ""),
      form,
    },
  };
}

const sha256Of = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Every id in this file is a uuid path parameter.
 *
 * Checked before it reaches a query because Postgres raises `invalid input
 * syntax for type uuid` on anything else — a 500 with a stack trace in the
 * logs, where the honest answer is the same 404 an unknown id gets. It also
 * means a scanner walking `/uploads/<junk>/url` cannot tell malformed from
 * merely absent.
 */
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads a caller-supplied kind, falling back to what the bytes suggest. */
function kindFrom(form: FormData, contentType: string, fallback?: string): string {
  const requested = str(form.get("kind"), 40);
  if (requested && ATTACHMENT_KINDS.has(requested)) return requested;
  return fallback ?? defaultKindFor(contentType);
}

/* ------------------------------------------------------------ read access -- */

/**
 * The four ways an attachment can be owned, and therefore the four access
 * rules, ORed into one predicate.
 *
 * A job attachment follows the job; a comment's follows the job it is on; a
 * site's follows the site register; an intake request's is staff-only, because
 * the triage queue is. `pending` rows are excluded for everyone but staff —
 * that is the point of the flag, and leaving it to each caller to remember is
 * how an unreviewed share-link upload ends up rendered in a client's portal.
 *
 * Parameters are appended in the order the fragments are built so the `$n`
 * numbering `scopeFor` produces stays correct.
 */
function attachmentAccessSql(actor: Actor, params: unknown[]): string {
  const viaJob = scopeFor(actor, "j", params.length);
  params.push(...viaJob.params);
  const viaComment = scopeFor(actor, "cj", params.length);
  params.push(...viaComment.params);
  const viaSite = siteScopeFor(actor, "s", params.length);
  params.push(...viaSite.params);

  // These two literals come from this file, never from a request.
  const intake = canTriage(actor) ? "true" : "false";
  const pending = isStaff(actor.role) ? "true" : "not a.pending";

  return `(${pending}) and (
       (a.job_id is not null and (${viaJob.sql}))
    or (a.comment_id is not null and (${viaComment.sql}))
    or (a.site_id is not null and (${viaSite.sql}))
    or (a.job_request_id is not null and ${intake})
  )`;
}

const ATTACHMENT_FROM = `
  from attachments a
  left join jobs j on j.id = a.job_id
  left join job_comments cm on cm.id = a.comment_id
  left join jobs cj on cj.id = cm.job_id
  left join sites s on s.id = a.site_id`;

type AttachmentRow = {
  id: string;
  object_key: string;
  content_type: string;
  original_name: string;
  pending: boolean;
};

/* ================================================================ serving == */

/**
 * The download route, on its own router because the HMAC in the URL is the
 * credential — there is no cookie on an `<img src>` to a different origin.
 *
 * Mounted at /uploads AHEAD of the authenticated router, so `requireActor`
 * never runs for it. `tests/uploads.test.ts` asserts that with no cookie at
 * all, because a mounting order that silently changed would turn every
 * photograph in the portal into a broken image.
 */
export const uploadFiles = new Hono<Env>();

/**
 * GET /uploads/limits — the rules, so the form can state them before a
 * five-megabyte photograph is sent over a shop's mobile signal.
 *
 * Advisory only. Everything here is enforced again server-side against the
 * actual bytes; this endpoint exists so `apps/web` does not hardcode a second
 * copy of the numbers that then drifts from this one.
 */
uploadFiles.get("/limits", (c) =>
  c.json({
    maxBytes: MAX_UPLOAD_BYTES,
    maxMb: MAX_UPLOAD_MB,
    accept: ALLOWED_CONTENT_TYPES,
    signedUrlTtlSeconds: SIGNED_URL_TTL_SECONDS,
  }),
);

uploadFiles.get("/file", async (c) => {
  const key = verifyObjectToken(c.req.query("token"));
  // Forged, tampered and expired all land here and all say the same thing.
  if (!key) return c.json({ error: "This link has expired." }, 403);

  const db = c.get("db");
  /*
   * The type and name come from the database, not from the request and not
   * from the bytes on disk. Reflecting a caller-supplied content type back is
   * how a stored file becomes an active one in the browser.
   */
  const [meta] = await db.query<{
    content_type: string;
    original_name: string;
  }>(
    `select content_type, original_name from attachments where object_key = $1
     union all
     select content_type, original_name from pending_uploads where object_key = $1
     limit 1`,
    [key],
  );

  const bytes = await getStorage().get(key);
  if (!bytes) return c.json({ error: "That file is no longer available." }, 404);

  const contentType = meta?.content_type ?? "application/octet-stream";
  c.header("content-type", contentType);
  /*
   * Images render in place; PDFs download.
   *
   * A PDF opened inline runs in a viewer that inherits this origin, and this
   * origin is the API that holds every session cookie. An attachment
   * disposition costs a client one extra click and removes that entirely.
   */
  const disposition = contentType.startsWith("image/") ? "inline" : "attachment";
  // Reduced to a character set that cannot terminate the quoted string or the
  // header itself. A filename is display text; it is not worth a header
  // injection to render an apostrophe faithfully.
  const filename = (meta?.original_name ?? "file").replace(/[^\w.\- ]+/g, "_");
  c.header("content-disposition", `${disposition}; filename="${filename}"`);
  // Private: the URL is a bearer credential, so no shared cache may keep a copy.
  c.header("cache-control", `private, max-age=${SIGNED_URL_TTL_SECONDS}`);

  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return c.body(buffer, 200);
});

/* ========================================================= authenticated == */

export const uploads = new Hono<Env>();
uploads.use("*", requireActor);

/**
 * POST /uploads/job/:id — attach a file to a job.
 *
 * The job is looked up through `scopeFor` before anything is written, so a
 * caller can only attach to work they can already see. A client_admin naming
 * another organisation's job id gets 404, not 403 — "forbidden" would confirm
 * the job exists.
 */
uploads.post("/job/:id", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  if (!UUID_SHAPE.test(c.req.param("id"))) {
    return c.json({ error: "No such job." }, 404);
  }

  const params: unknown[] = [c.req.param("id")];
  const scoped = withScope(
    "select j.id::text, j.organisation_id::text from jobs j where j.id = $1",
    params,
    scopeFor(actor, "j", params.length),
  );
  const [job] = await db.query<{ id: string; organisation_id: string | null }>(
    scoped.sql,
    scoped.params,
  );
  if (!job) return c.json({ error: "No such job." }, 404);

  const received = await receiveFile(c);
  if (!received.ok) return c.json({ error: received.error }, received.status);
  const { bytes, contentType, extension, originalName, form } = received.file;

  const key = objectKeyFor(`jobs/${job.id}`, extension);
  const storage = getStorage();
  await storage.put(key, bytes, contentType);

  try {
    const [attachment] = await db.query(
      `insert into attachments
         (kind, object_key, original_name, content_type, byte_size, sha256,
          job_id, organisation_id, uploaded_by, uploaded_by_name)
       values ($1::attachment_kind,$2,$3,$4,$5,$6,$7,$8,$9,
               (select full_name from profiles where id = $9))
       returning id::text, kind::text, object_key, original_name, content_type,
                 byte_size, pending, created_at::text`,
      [
        kindFrom(form, contentType),
        key,
        originalName,
        contentType,
        bytes.length,
        sha256Of(bytes),
        job.id,
        job.organisation_id,
        actor.profileId,
      ],
    );

    await db.query(
      `insert into activity_log (actor_profile_id, actor_email, action, entity_type, entity_id, detail)
       values ($1,$2,'job.attachment_added','job',$3,$4)`,
      [actor.profileId, actor.email, job.id, JSON.stringify({ key })],
    );

    return c.json({ ok: true, attachment });
  } catch (error) {
    // The bytes are already in the bucket. Leaving them there on a failed
    // insert is an object nothing references and nothing will ever clean up.
    await storage.delete(key).catch(() => {});
    throw error;
  }
});

/**
 * GET /uploads/job/:id — everything attached to a job, releases included.
 *
 * Staff see `pending` rows here and nowhere else: `/jobs/:id` filters them out,
 * so without this endpoint there is no screen on which a share-link upload
 * could be reviewed and the release endpoint below would have no caller.
 */
uploads.get("/job/:id", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  if (!UUID_SHAPE.test(c.req.param("id"))) {
    return c.json({ error: "No such job." }, 404);
  }

  const params: unknown[] = [c.req.param("id")];
  const scoped = withScope(
    "select j.id::text from jobs j where j.id = $1",
    params,
    scopeFor(actor, "j", params.length),
  );
  const [job] = await db.query<{ id: string }>(scoped.sql, scoped.params);
  if (!job) return c.json({ error: "No such job." }, 404);

  const rows = await db.query(
    `select id::text, kind::text, object_key, original_name, content_type,
            byte_size, uploaded_by_name, via_share_link, pending,
            reviewed_at::text, created_at::text
       from attachments
      where job_id = $1 ${isStaff(actor.role) ? "" : "and not pending"}
      order by created_at`,
    [job.id],
  );
  return c.json({ attachments: rows });
});

/**
 * GET /uploads/:id/url — a short-lived URL for one attachment.
 *
 * The access check happens here, once, and the URL it hands back is good for
 * five minutes. That is the trade the whole design rests on: the browser gets
 * something it can put in an `<img>` tag, and it stops working long before it
 * is worth passing on.
 */
uploads.get("/:id/url", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  if (!UUID_SHAPE.test(c.req.param("id"))) {
    return c.json({ error: "No such file." }, 404);
  }

  const params: unknown[] = [c.req.param("id")];
  const [attachment] = await db.query<AttachmentRow>(
    `select a.id::text, a.object_key, a.content_type, a.original_name, a.pending
     ${ATTACHMENT_FROM}
     where a.id = $1 and ${attachmentAccessSql(actor, params)}`,
    params,
  );
  if (!attachment) return c.json({ error: "No such file." }, 404);

  return c.json({
    ok: true,
    url: await getStorage().getSignedUrl(
      attachment.object_key,
      SIGNED_URL_TTL_SECONDS,
    ),
    expiresIn: SIGNED_URL_TTL_SECONDS,
    contentType: attachment.content_type,
    originalName: attachment.original_name,
  });
});

/**
 * POST /uploads/:id/release — staff accept a share-link upload.
 *
 * Clearing `pending` is the moment an anonymous upload becomes part of the
 * client's record, so it records who did it. Staff only: the whole reason the
 * flag exists is that the person who uploaded the file cannot be the person
 * who approves it.
 */
uploads.post("/:id/release", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  if (!isStaff(actor.role)) {
    return c.json({ error: "Only staff can release an upload." }, 403);
  }
  if (!UUID_SHAPE.test(c.req.param("id"))) {
    return c.json({ error: "No such pending file." }, 404);
  }

  const rows = await db.query<{ id: string }>(
    `update attachments set pending = false, reviewed_by = $2, reviewed_at = now()
      where id = $1 and pending
      returning id::text, job_id::text`,
    [c.req.param("id"), actor.profileId],
  );
  if (!rows.length) return c.json({ error: "No such pending file." }, 404);

  await db.query(
    `insert into activity_log (actor_profile_id, actor_email, action, entity_type, entity_id)
     values ($1,$2,'attachment.released','attachment',$3)`,
    [actor.profileId, actor.email, rows[0].id],
  );
  return c.json({ ok: true, attachment: rows[0] });
});

/**
 * POST /uploads/:id/discard — staff refuse one, and the bytes go too.
 *
 * The other half of release. Without it a rejected upload stays in the bucket
 * forever with a row saying it was never wanted, which is both a cost and, for
 * a photograph taken inside somebody's shop, a retention problem.
 */
uploads.post("/:id/discard", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  if (!isStaff(actor.role)) {
    return c.json({ error: "Only staff can discard an upload." }, 403);
  }
  if (!UUID_SHAPE.test(c.req.param("id"))) {
    return c.json({ error: "No such pending file." }, 404);
  }

  const rows = await db.query<{ object_key: string }>(
    "delete from attachments where id = $1 and pending returning object_key",
    [c.req.param("id")],
  );
  if (!rows.length) return c.json({ error: "No such pending file." }, 404);

  await getStorage().delete(rows[0].object_key);
  await db.query(
    `insert into activity_log (actor_profile_id, actor_email, action, entity_type, entity_id, detail)
     values ($1,$2,'attachment.discarded','attachment',null,$3)`,
    [actor.profileId, actor.email, JSON.stringify({ key: rows[0].object_key })],
  );
  return c.json({ ok: true });
});

/* ================================================================ public == */

export const publicUploads = new Hono<Env>();

/**
 * POST /public/job/:token/upload — the contractor's "pictures of completed
 * works", with no account.
 *
 * Rate limited, because this is a write endpoint open to the internet to
 * anyone who has ever been forwarded a link. The limit is per address and per
 * instance — see `rateLimit` — so it is a brake on a script, not a quota.
 */
publicUploads.post("/job/:token/upload", async (c) => {
  const db = c.get("db");
  const ip = clientIp(c);

  const limit = rateLimit(`share-upload:${ip ?? "unknown"}`, 20, 60 * 60_000);
  if (!limit.ok) {
    c.header("retry-after", String(limit.retryAfter));
    return c.json({ error: "Too many uploads. Try again later." }, 429);
  }

  const job = await jobForShareToken(db, c.req.param("token"));
  // Revoked, expired, wrong shape and never-existed are one answer.
  if (!job) return c.json({ error: "This link is not valid." }, 404);

  const received = await receiveFile(c);
  if (!received.ok) return c.json({ error: received.error }, received.status);
  const { bytes, contentType, extension, originalName, form } = received.file;

  /*
   * A name, for the same reason `job_comments` demands one: an unattributed
   * photograph on a job record is worthless in a dispute about who did what.
   * It is a claim, not an identity — which is exactly why the row is pending.
   */
  const uploaderName = str(form.get("uploaderName"), 120) || str(form.get("authorName"), 120);
  if (!uploaderName) return c.json({ error: "Add your name." }, 400);

  const key = objectKeyFor(`jobs/${job.id}`, extension);
  const storage = getStorage();
  await storage.put(key, bytes, contentType);

  try {
    const [attachment] = await db.query<{ id: string }>(
      `insert into attachments
         (kind, object_key, original_name, content_type, byte_size, sha256,
          job_id, organisation_id, uploaded_by_name, via_share_link, pending)
       values ($1::attachment_kind,$2,$3,$4,$5,$6,$7,$8,$9,true,true)
       returning id::text`,
      [
        // Completed work by default: that is what a share link is handed out
        // for. The caller may say `issue_picture` instead, and cannot say
        // anything that is not in the enum.
        kindFrom(form, contentType, "completed_picture"),
        key,
        originalName,
        contentType,
        bytes.length,
        sha256Of(bytes),
        job.id,
        job.organisation_id,
        uploaderName,
      ],
    );

    await db.query(
      `insert into activity_log (action, entity_type, entity_id, actor_email, detail)
       values ('job.attachment_via_share','job',$1,$2,$3)`,
      [job.id, uploaderName, JSON.stringify({ via: "share_link", pending: true })],
    );

    sendMailBestEffort({
      to: adminEmail(),
      ...templates.jobUpdatedViaShareLink(
        job.reference,
        job.title,
        `${uploaderName} uploaded a photograph (awaiting release)`,
        `${webUrl()}/portal/jobs/${job.id}`,
      ),
    });

    /*
     * The id comes back so the uploader's page can show what they sent, and
     * nothing else does — no object key, no URL. Until staff release it, the
     * only thing the uploader learns is that it arrived.
     */
    return c.json({
      ok: true,
      attachmentId: attachment.id,
      pending: true,
      message: "Received. It appears on the job once the team has checked it.",
    });
  } catch (error) {
    await storage.delete(key).catch(() => {});
    throw error;
  }
});

/**
 * GET /public/job/:token/attachment/:id — a signed URL through a share link.
 *
 * Same token, same three checks, and restricted to released attachments on
 * that one job — a contractor holding a link for job A cannot name an
 * attachment id from job B.
 */
publicUploads.get("/job/:token/attachment/:id", async (c) => {
  const db = c.get("db");
  const job = await jobForShareToken(db, c.req.param("token"));
  if (!job) return c.json({ error: "This link is not valid." }, 404);
  if (!UUID_SHAPE.test(c.req.param("id"))) {
    return c.json({ error: "No such file." }, 404);
  }

  const [attachment] = await db.query<AttachmentRow>(
    `select id::text, object_key, content_type, original_name, pending
       from attachments where id = $1 and job_id = $2 and not pending`,
    [c.req.param("id"), job.id],
  );
  if (!attachment) return c.json({ error: "No such file." }, 404);

  return c.json({
    ok: true,
    url: await getStorage().getSignedUrl(
      attachment.object_key,
      SIGNED_URL_TTL_SECONDS,
    ),
    expiresIn: SIGNED_URL_TTL_SECONDS,
  });
});

/**
 * POST /public/intake/upload — a photograph for the Report a Job form, before
 * the request it belongs to exists.
 *
 * Returns a claim ticket, not an object key. The browser sends the tickets back
 * with the form and `/public/report-a-job` turns them into attachments. The
 * client never learns where the bytes live and cannot name a key of its own —
 * which is the difference between "the photographs on this request are the ones
 * that were uploaded for it" and "the photographs are whatever strings the
 * submitter typed".
 */
publicUploads.post("/intake/upload", async (c) => {
  const db = c.get("db");
  const ip = clientIp(c);

  // Ten per hour: the form asks for pictures of one fault, not an album.
  const limit = rateLimit(`intake-upload:${ip ?? "unknown"}`, 10, 60 * 60_000);
  if (!limit.ok) {
    c.header("retry-after", String(limit.retryAfter));
    return c.json({ error: "Too many uploads. Try again later." }, 429);
  }

  const received = await receiveFile(c);
  if (!received.ok) return c.json({ error: received.error }, received.status);
  const { bytes, contentType, extension, originalName } = received.file;

  const now = new Date();
  const key = objectKeyFor(
    `intake/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`,
    extension,
  );
  const storage = getStorage();
  await storage.put(key, bytes, contentType);

  try {
    const [staged] = await db.query<{ id: string }>(
      `insert into pending_uploads
         (object_key, original_name, content_type, byte_size, sha256, kind, source_ip_hash)
       values ($1,$2,$3,$4,$5,'issue_picture',$6) returning id::text`,
      [key, originalName, contentType, bytes.length, sha256Of(bytes), hashIp(ip)],
    );
    return c.json({ ok: true, photo: staged.id, originalName });
  } catch (error) {
    await storage.delete(key).catch(() => {});
    throw error;
  }
});
