import { Hono } from "hono";
import type { Db } from "../../../../packages/db/src/client.ts";
import { sendMailBestEffort, templates } from "../lib/mail.ts";
import { hashIp } from "../lib/sessions.ts";
import {
  clientIp,
  email as normaliseEmail,
  isEmail,
  rateLimit,
  str,
} from "../lib/http.ts";
import { liveShareToken, SHARE_TOKEN_SHAPE } from "../lib/share.ts";
import { hideMoneyOnShare } from "../lib/settings.ts";

type Env = { Variables: { db: Db } };

const webUrl = () =>
  (process.env.WEB_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const adminEmail = () => process.env.ADMIN_EMAIL ?? "info@maintsupp.com";

export const publicRoutes = new Hono<Env>();

/* ------------------------------------------------- landing page intake -- */

/** A claim ticket from POST /public/intake/upload. Anything else is a key. */
const UPLOAD_TICKET =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StagedUpload = {
  id: string;
  object_key: string;
  original_name: string;
  content_type: string;
  byte_size: string;
  sha256: string | null;
  kind: string;
};

/**
 * POST /public/report-a-job — the landing page's Report a Job form.
 *
 * Writes to `job_requests`, never to `jobs`. This endpoint is open to the
 * internet; letting it reach the table the whole product reads would put
 * unverified rows on a client's board.
 *
 * PHOTOGRAPHS. `photos` accepts two things, and treats them very differently:
 *
 *   - A claim ticket from `/public/intake/upload` — a `pending_uploads` id.
 *     The server put those bytes there, checked their magic number and knows
 *     their size, so the ticket is claimed into a real `attachments` row here,
 *     inside the same transaction as the request. This is the path the form
 *     uses.
 *   - Anything else is kept as a bare object key in `job_requests.photos` and
 *     becomes no attachment at all. A string a submitter typed is not evidence
 *     that any bytes exist anywhere; promoting it to an attachment row would
 *     manufacture a record of a photograph nobody ever took. The column keeps
 *     working for callers written before the upload endpoint existed, and
 *     `photos` stays the mirror of the keys either way.
 */
publicRoutes.post("/report-a-job", async (c) => {
  const db = c.get("db");
  const body = await c.req.json().catch(() => ({}));

  if (str(body.website, 100)) return c.json({ ok: true, reference: "received" });

  const ip = clientIp(c);
  const limit = rateLimit(`report:${ip ?? "unknown"}`, 10, 60 * 60_000);
  if (!limit.ok) {
    return c.json({ error: "Too many submissions. Try again later." }, 429);
  }

  const siteName = str(body.siteName, 160);
  const contactName = str(body.contactName, 120);
  const phone = str(body.phone, 40);
  const address = normaliseEmail(body.email);
  const description = str(body.description, 4000);
  const faultCategory = str(body.faultCategory, 80);
  const urgency = str(body.urgency, 10) || "P3";
  const photos: string[] = Array.isArray(body.photos)
    ? body.photos
        .filter((v: unknown): v is string => typeof v === "string")
        .map((v: string) => v.trim())
        .filter(Boolean)
        .slice(0, 10)
    : [];
  const tickets = photos.filter((value) => UPLOAD_TICKET.test(value));
  const legacyKeys = photos.filter((value) => !UPLOAD_TICKET.test(value));

  // The monday form's own rules: pictures, manager name and contact number are
  // mandatory, and one issue per ticket.
  const missing: string[] = [];
  if (!siteName) missing.push("store");
  if (!contactName) missing.push("your name");
  if (!phone) missing.push("contact number");
  if (!isEmail(address)) missing.push("a valid email address");
  if (description.length < 10) missing.push("a description of the works");
  if (!faultCategory) missing.push("what is broken");
  if (photos.length === 0) missing.push("at least one photograph");

  if (missing.length) {
    return c.json(
      { error: `Add ${missing.join(", ")}. Requests without clear pictures are declined.` },
      400,
    );
  }

  /*
   * One transaction for the request, its attachments and the tickets they came
   * from. A half-written intake — a request whose photographs did not attach,
   * or attachments hanging off a request that was rolled back — is precisely
   * the state that makes "requests without clear pictures are declined"
   * unenforceable.
   */
  const outcome = await db.transaction(async (tx) => {
    const staged = tickets.length
      ? await tx.query<StagedUpload>(
          `select id::text, object_key, original_name, content_type,
                  byte_size::text, sha256, kind::text
             from pending_uploads
            where id = any($1::uuid[]) and claimed_at is null`,
          [tickets],
        )
      : [];

    // A ticket that is missing or already spent means a photograph the
    // submitter believes they attached is not going to be there. Say so rather
    // than silently filing an incomplete report.
    if (staged.length !== tickets.length) return { expired: true as const };

    const [row] = await tx.query<{ id: string; created_at: string }>(
      `insert into job_requests
         (site_name, contact_name, phone, email, address, postcode, fault_category,
          urgency, description, access_window, photos, source_ip_hash)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,nullif($10,''),$11,$12)
       returning id::text, created_at::text`,
      [
        siteName, contactName, phone, address,
        str(body.address, 300) || siteName,
        str(body.postcode, 20) || "—",
        faultCategory, urgency, description,
        str(body.accessWindow, 200),
        // The denormalised mirror: staged keys first, then any legacy strings.
        [...staged.map((item) => item.object_key), ...legacyKeys],
        hashIp(ip),
      ],
    );

    for (const item of staged) {
      /*
       * `attachments.object_key` is unique, so two submissions racing for the
       * same ticket cannot both produce an attachment — the second fails here
       * and rolls its whole request back, rather than one photograph appearing
       * on two strangers' reports.
       */
      const [attachment] = await tx.query<{ id: string }>(
        `insert into attachments
           (kind, object_key, original_name, content_type, byte_size, sha256, job_request_id)
         values ($1::attachment_kind,$2,$3,$4,$5,$6,$7) returning id::text`,
        [
          item.kind, item.object_key, item.original_name, item.content_type,
          item.byte_size, item.sha256, row.id,
        ],
      );
      await tx.query(
        `update pending_uploads set claimed_at = now(), claimed_attachment_id = $2
          where id = $1 and claimed_at is null`,
        [item.id, attachment.id],
      );
    }

    return { request: row, attached: staged.length };
  });

  if ("expired" in outcome) {
    return c.json(
      { error: "One of your photographs has expired. Attach it again." },
      400,
    );
  }
  const request = outcome.request;

  // A quotable reference. Not the job number — no job exists yet.
  const reference = `REQ-${request.id.slice(0, 8).toUpperCase()}`;

  sendMailBestEffort({
    to: adminEmail(),
    subject: `New job request — ${siteName}`,
    text: `${contactName} (${phone}) reported: ${faultCategory}\n\n${description}\n\nReference ${reference}\nTriage it: ${webUrl()}/portal/requests`,
  });
  sendMailBestEffort({
    to: address,
    subject: `We have your request — ${reference}`,
    text: `Thanks — your maintenance request is with our coordinators.\n\nReference: ${reference}\nStore: ${siteName}\n\nWe will be in touch on ${phone}.`,
  });

  return c.json({ ok: true, reference, photographs: outcome.attached });
});

/** POST /public/portfolio-review — the Book a Portfolio Review form. */
publicRoutes.post("/portfolio-review", async (c) => {
  const db = c.get("db");
  const body = await c.req.json().catch(() => ({}));

  if (str(body.website, 100)) return c.json({ ok: true });

  const limit = rateLimit(`lead:${clientIp(c) ?? "unknown"}`, 10, 60 * 60_000);
  if (!limit.ok) return c.json({ error: "Too many submissions." }, 429);

  const name = str(body.name, 120);
  const company = str(body.company, 160);
  const address = normaliseEmail(body.email);
  const siteRange = str(body.siteRange, 40);
  const challenge = str(body.challenge, 900);
  const regions: string[] = Array.isArray(body.regions)
    ? body.regions.filter((v: unknown) => typeof v === "string").slice(0, 20)
    : [];

  if (!name || !company || !isEmail(address) || !siteRange || challenge.length < 20) {
    return c.json({ error: "Complete the required portfolio and contact details." }, 400);
  }

  const [lead] = await db.query<{ id: string }>(
    `insert into leads (name, company, email, phone, site_range, regions, services, challenge, source_ip_hash)
     values ($1,$2,$3,nullif($4,''),$5,$6,$7,$8,$9) returning id::text`,
    [
      name, company, address, str(body.phone, 40), siteRange, regions,
      Array.isArray(body.services) ? body.services.slice(0, 20) : [],
      challenge, hashIp(clientIp(c)),
    ],
  );

  sendMailBestEffort({
    to: adminEmail(),
    subject: `Portfolio review request — ${company}`,
    text: `${name} at ${company} (${address})\nSites: ${siteRange}\nRegions: ${regions.join(", ") || "—"}\n\n${challenge}`,
  });

  await db.query("update leads set notified_at = now() where id = $1", [lead.id]);
  return c.json({ ok: true });
});

/* ------------------------------------------------------- the share link -- */

/**
 * Everything below is reachable by anyone holding a job's `share_token`.
 *
 * The token IS the credential — no account, no cookie. Two consequences shape
 * every handler here:
 *
 *   1. The token is looked up with `share_enabled` and expiry in the same
 *      WHERE clause, so a revoked or aged-out link is indistinguishable from a
 *      wrong one: both return 404.
 *   2. Writes land as `pending` or clearly attributed, because the only thing
 *      proven about the caller is that somebody forwarded them a link.
 */
async function jobForToken(db: Db, token: string) {
  if (!SHARE_TOKEN_SHAPE.test(token)) return null; // shape-check before the query
  const [job] = await db.query<Record<string, unknown>>(
    `select j.id::text, j.reference, j.title, j.description, j.status::text, j.stage::text,
            j.priority::text, j.engineer_required::text, j.fault_label::text,
            j.location, j.date_requested::text, j.date_completed::text,
            j.job_requested_by, j.contact_number, j.cost_of_works_pence,
            j.invoice_ref, j.approved_by,
            s.name as site_name, o.name as organisation_name
       from jobs j
       left join sites s on s.id = j.site_id
       left join organisations o on o.id = j.organisation_id
      where ${liveShareToken("j", 1)}`,
    [token],
  );
  return job ?? null;
}

/**
 * The money toggle.
 *
 * The owner's decision is that a shared link shows the full ticket, so this is
 * OFF by default.
 *
 * The DATABASE is now the authority — the `settings` table, owner-only, with an
 * audit trail of who changed it. `HIDE_MONEY_ON_SHARE` remains the fallback for
 * a deployment with no row yet, so an existing Railway variable keeps working
 * until somebody makes the decision in the product. Precedence in full:
 *
 *     a row in `settings`  >  HIDE_MONEY_ON_SHARE  >  off
 *
 * and it is explained where it is implemented, in `lib/settings.ts`.
 */
publicRoutes.get("/job/:token", async (c) => {
  const db = c.get("db");
  const job = await jobForToken(db, c.req.param("token"));
  if (!job) return c.json({ error: "This link is not valid." }, 404);

  /*
   * Read ONCE and reused below. The old sync helper was called twice per
   * request; a database read called twice can answer differently either side
   * of a toggle flipped mid-request, and a page that showed the cost but
   * withheld the quotes would be the one shape nobody would think to test.
   */
  const hideMoney = await hideMoneyOnShare(db);

  if (hideMoney) {
    delete job.cost_of_works_pence;
    delete job.invoice_ref;
    delete job.approved_by;
  }

  const [comments, attachments, quotes] = await Promise.all([
    db.query(
      `select c.body, coalesce(c.author_name, p.full_name, 'MAINTSUPP') as author,
              c.created_at::text
         from job_comments c left join profiles p on p.id = c.author_profile_id
        where c.job_id = $1 and c.visibility = 'public' order by c.created_at`,
      [job.id],
    ),
    db.query(
      `select id::text, kind, object_key, original_name, content_type
         from attachments where job_id = $1 and not pending order by created_at`,
      [job.id],
    ),
    hideMoney
      ? Promise.resolve([])
      : db.query(
          `select amount_pence, description, status::text, decided_at::text
             from quotes where job_id = $1 order by created_at desc`,
          [job.id],
        ),
  ]);

  return c.json({ job, comments, attachments, quotes });
});

/** A contractor comments without an account. Their name is required. */
publicRoutes.post("/job/:token/comment", async (c) => {
  const db = c.get("db");
  const token = c.req.param("token");

  const limit = rateLimit(`share-comment:${clientIp(c) ?? "unknown"}`, 20, 60 * 60_000);
  if (!limit.ok) return c.json({ error: "Too many messages. Try again later." }, 429);

  const job = await jobForToken(db, token);
  if (!job) return c.json({ error: "This link is not valid." }, 404);

  const body = await c.req.json().catch(() => ({}));
  const text = str(body.body, 4000);
  const authorName = str(body.authorName, 120);
  if (!text) return c.json({ error: "Write something first." }, 400);
  if (!authorName) return c.json({ error: "Add your name." }, 400);

  await db.query(
    `insert into job_comments (job_id, body, author_name, via_share_link, visibility)
     values ($1,$2,$3,true,'public')`,
    [job.id, text, authorName],
  );

  notifyAdmins(db, job, `${authorName} commented`);
  return c.json({ ok: true });
});

/**
 * "Work completed".
 *
 * Sets the job to Job Completed and records who said so and when. It is the
 * contractor's claim, not a verification — the portal shows it came in through
 * a share link, and an admin closes the job for real.
 */
publicRoutes.post("/job/:token/complete", async (c) => {
  const db = c.get("db");
  const job = await jobForToken(db, c.req.param("token"));
  if (!job) return c.json({ error: "This link is not valid." }, 404);

  const body = await c.req.json().catch(() => ({}));
  const authorName = str(body.authorName, 120);
  if (!authorName) return c.json({ error: "Add your name." }, 400);

  await db.transaction(async (tx) => {
    await tx.query(
      "update jobs set status = 'Job Completed', date_completed = now() where id = $1",
      [job.id],
    );
    await tx.query(
      `insert into job_comments (job_id, body, author_name, via_share_link, visibility)
       values ($1,$2,$3,true,'public')`,
      [job.id, `Marked the work complete (pending verification).`, authorName],
    );
    await tx.query(
      `insert into activity_log (action, entity_type, entity_id, actor_email, detail)
       values ('job.completed_via_share','job',$1,$2,$3)`,
      [job.id, authorName, JSON.stringify({ via: "share_link" })],
    );
  });

  notifyAdmins(db, job, `${authorName} marked the work complete`);
  return c.json({ ok: true, status: "Job Completed" });
});

function notifyAdmins(db: Db, job: Record<string, unknown>, what: string) {
  sendMailBestEffort({
    to: adminEmail(),
    ...templates.jobUpdatedViaShareLink(
      String(job.reference),
      String(job.title),
      what,
      `${webUrl()}/portal/jobs/${job.id}`,
    ),
  });
  void db
    .query(
      `insert into activity_log (action, entity_type, entity_id, detail)
       values ('job.share_activity','job',$1,$2)`,
      [job.id, JSON.stringify({ what })],
    )
    .catch(() => {});
}
