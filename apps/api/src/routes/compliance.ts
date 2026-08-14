/**
 * The compliance register — mounted at /compliance.
 *
 * ── THE DENOMINATOR IS THE PRODUCT ────────────────────────────────────────
 * Every number this file returns is a fraction, and the fraction that matters
 * is stated as three separate integers — `required`, `inDate`, `notRequired` —
 * never as a bare percentage. A percentage on its own is how "82% compliant"
 * became "26% compliant" without a single certificate changing: the requirement
 * list grew from nine entries to twelve and nothing on screen said what the
 * denominator was, so nobody could tell a collapse in compliance from a change
 * in what was being counted. The screen prints the denominator because this
 * endpoint makes it impossible not to.
 *
 * ── NOT REQUIRED IS NOT A FAILURE ─────────────────────────────────────────
 * A site with no sprinkler system is not failing its sprinkler certificate.
 * `not_required` rows leave the denominator entirely — they are neither a pass
 * nor a fail — which is the distinction the `compliance_documents.not_required`
 * comment in migration 0004 exists to make. Counting them as failures punishes
 * a client for a truthful answer, and counting them as passes inflates the
 * score of a site nobody has checked.
 *
 * ── STATUS IS COMPUTED, NEVER READ ────────────────────────────────────────
 * `compliance_documents.status` is a stored enum and stored statuses age: a row
 * written 'Valid' in January is still 'Valid' in December after the certificate
 * expired in March. Every read below recomputes with `compliance_status_for`
 * and `current_date`. The stored column is a snapshot for anyone inspecting the
 * database directly and is never what a caller is shown.
 *
 * ── TENANCY ───────────────────────────────────────────────────────────────
 * Composed from `siteScopeFor` and nothing else. A contractor gets DENY from it
 * — they have no business browsing a client's site register — so the register
 * simply comes back empty for them rather than needing its own rule here.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import {
  canManageCompliance,
  siteScopeFor,
  withScope,
  type Actor,
} from "../lib/access.ts";
import { requireActor, type Env } from "../lib/middleware.ts";
import { str } from "../lib/http.ts";
import {
  isoDate,
  receiveOneFile,
  sha256Of,
  UUID_SHAPE,
} from "../lib/attachments.ts";
import type { Db } from "../../../../packages/db/src/client.ts";
import { getStorage } from "../lib/storage.ts";
import { objectKeyFor } from "../lib/files.ts";

export const compliance = new Hono<Env>();
compliance.use("*", requireActor);

/**
 * The one status expression, called the same way everywhere.
 *
 * `r` is the requirement row and `d` the document row (which may be absent —
 * every join below is a LEFT join, because a requirement with no document is
 * precisely the "Missing" case and dropping it would hide every gap).
 * `p_soon_days` is left to its database default so the 90-day window has one
 * definition, in migration 0009, rather than one here and one there.
 */
const STATUS_SQL = `compliance_status_for(
  coalesce(d.not_required, false), r.expires, d.attachment_id is not null,
  d.expiry_date, current_date)`;

/** The requirement list, in the order it is shown. */
const REQUIREMENTS_SQL = `
  select kind, label, expires, sort_order
    from compliance_requirements where active order by sort_order, label`;

type RequirementRow = {
  kind: string;
  label: string;
  expires: boolean;
  sort_order: number;
};

type Counts = {
  required: number;
  inDate: number;
  valid: number;
  expiring: number;
  expired: number;
  missing: number;
  notRequired: number;
};

/**
 * The score, and every integer it is made of.
 *
 * `percent` is null rather than 0 or 100 when the denominator is zero. A site
 * whose every requirement is marked not required has no score — "0% compliant"
 * would be a lie and "100% compliant" would be a different one — and returning
 * null forces the screen to say so instead of printing a number nobody can act
 * on.
 */
function scoreOf(counts: Counts): Counts & { percent: number | null } {
  return {
    ...counts,
    percent:
      counts.required === 0
        ? null
        : Math.round((counts.inDate / counts.required) * 100),
  };
}

const ZERO: Counts = {
  required: 0,
  inDate: 0,
  valid: 0,
  expiring: 0,
  expired: 0,
  missing: 0,
  notRequired: 0,
};

const add = (a: Counts, b: Counts): Counts => ({
  required: a.required + b.required,
  inDate: a.inDate + b.inDate,
  valid: a.valid + b.valid,
  expiring: a.expiring + b.expiring,
  expired: a.expired + b.expired,
  missing: a.missing + b.missing,
  notRequired: a.notRequired + b.notRequired,
});

/** The "Expiring" window, read from the database so there is one copy of it. */
async function soonDays(db: Db): Promise<number> {
  const [row] = await db.query<{ days: number }>(
    "select compliance_soon_days()::int as days",
  );
  return Number(row.days);
}

/* ================================================================ reading == */

/**
 * GET /compliance — every site the caller may see, with its score.
 *
 * The matrix is built by CROSS JOINing the requirement catalogue against the
 * scoped site list, so a site with no `compliance_documents` rows at all comes
 * back as twelve Missing rather than as nothing. A register that only lists
 * what has been filed cannot show what has not, which is the only thing it is
 * for.
 */
compliance.get("/", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");

  /*
   * The scope predicate goes INSIDE the CTE, so it cannot be composed with
   * `withScope` (which appends to the end of a statement). It is still built by
   * `siteScopeFor` and its parameters are still pushed in the order their
   * placeholders appear — this file writes no tenancy predicate of its own.
   */
  const params: unknown[] = [];
  const scope = siteScopeFor(actor, "s", params.length);
  params.push(...scope.params);

  const organisationId = str(c.req.query("organisationId"), 40);
  const orgFilter =
    organisationId && UUID_SHAPE.test(organisationId)
      ? `and s.organisation_id = $${params.push(organisationId)}`
      : "";

  const sites = await db.query<
    {
      id: string;
      name: string;
      organisation_id: string;
      organisation_name: string;
      next_expiry: string | null;
    } & Record<keyof Counts, number>
  >(
    `with req as (${REQUIREMENTS_SQL}),
     scoped as (
       select s.id, s.name, s.organisation_id, o.name as organisation_name
         from sites s
         join organisations o on o.id = s.organisation_id
        where s.active and (${scope.sql}) ${orgFilter}
     ),
     matrix as (
       select scoped.id, scoped.name, scoped.organisation_id, scoped.organisation_name,
              d.expiry_date, ${STATUS_SQL}::text as status
         from scoped
         cross join req r
         left join compliance_documents d
                on d.site_id = scoped.id and d.kind = r.kind
     )
     select id::text, name, organisation_id::text, organisation_name,
            count(*) filter (where status <> 'Not required')::int as "required",
            count(*) filter (where status in ('Valid','Expiring'))::int as "inDate",
            count(*) filter (where status = 'Valid')::int as "valid",
            count(*) filter (where status = 'Expiring')::int as "expiring",
            count(*) filter (where status = 'Expired')::int as "expired",
            count(*) filter (where status = 'Missing')::int as "missing",
            count(*) filter (where status = 'Not required')::int as "notRequired",
            min(expiry_date) filter (where status in ('Valid','Expiring'))::text as next_expiry
       from matrix
      group by 1,2,3,4
      order by name`,
    params,
  );

  const requirements = await db.query<RequirementRow>(REQUIREMENTS_SQL);

  const rows = sites.map((site) => ({
    id: site.id,
    name: site.name,
    organisationId: site.organisation_id,
    organisationName: site.organisation_name,
    nextExpiry: site.next_expiry,
    score: scoreOf({
      required: Number(site.required),
      inDate: Number(site.inDate),
      valid: Number(site.valid),
      expiring: Number(site.expiring),
      expired: Number(site.expired),
      missing: Number(site.missing),
      notRequired: Number(site.notRequired),
    }),
  }));

  return c.json({
    requirements,
    sites: rows,
    /*
     * The portfolio score, summed from the same integers rather than averaged
     * from the per-site percentages. Averaging percentages weights a two-
     * requirement site the same as a twelve-requirement one and answers a
     * question nobody asked.
     */
    summary: {
      sites: rows.length,
      ...scoreOf(rows.reduce((total, site) => add(total, site.score), ZERO)),
    },
    expiringWithinDays: await soonDays(db),
    canManage: canManageCompliance(actor),
  });
});

/**
 * GET /compliance/calendar — what expires, and when.
 *
 * Twelve months forward by default, and everything already expired however far
 * back it goes: an expired certificate does not stop mattering because it fell
 * off the end of a window, and a calendar that hides it is worse than no
 * calendar. `not_required` rows and the three kinds that carry no expiry are
 * excluded — neither has a date that could arrive.
 */
compliance.get("/calendar", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");

  const months = Math.min(Math.max(Number(c.req.query("months") ?? 12) || 12, 1), 24);

  const params: unknown[] = [];
  const scope = siteScopeFor(actor, "s", params.length);
  params.push(...scope.params);
  params.push(months);

  const rows = await db.query<{
    site_id: string;
    site_name: string;
    organisation_name: string;
    kind: string;
    label: string;
    expiry_date: string;
    days_left: number;
  }>(
    `select s.id::text as site_id, s.name as site_name, o.name as organisation_name,
            r.kind, r.label, d.expiry_date::text, (d.expiry_date - current_date)::int as days_left
       from compliance_documents d
       join sites s on s.id = d.site_id
       join organisations o on o.id = s.organisation_id
       join compliance_requirements r on r.kind = d.kind
      where (${scope.sql})
        and s.active and r.active and r.expires
        and not d.not_required
        and d.expiry_date is not null
        and d.expiry_date <= current_date + make_interval(months => $${params.length}::int)
      order by d.expiry_date, s.name
      limit 500`,
    params,
  );

  const soon = await soonDays(db);
  const items = rows.map((row) => ({ ...row, days_left: Number(row.days_left) }));

  return c.json({
    months,
    expiringWithinDays: soon,
    /*
     * Three buckets, because they are three different actions: expired is
     * somebody's problem today, the next three months is what goes in a
     * schedule, and the rest of the year is what goes in a budget.
     */
    expired: items.filter((item) => item.days_left < 0),
    soon: items.filter((item) => item.days_left >= 0 && item.days_left <= soon),
    later: items.filter((item) => item.days_left > soon),
  });
});

/**
 * GET /compliance/site/:siteId — one site, every requirement, filed or not.
 *
 * 404 when the site is out of scope, never 403: "forbidden" would confirm the
 * site exists, which is how somebody walks uuids to learn a competitor's estate.
 */
compliance.get("/site/:siteId", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const siteId = c.req.param("siteId");
  if (!UUID_SHAPE.test(siteId)) return c.json({ error: "No such site." }, 404);

  const site = await siteInScope(db, actor, siteId);
  if (!site) return c.json({ error: "No such site." }, 404);

  const rows = await db.query<{
    kind: string;
    label: string;
    expires: boolean;
    document_id: string | null;
    expiry_date: string | null;
    days_left: number | null;
    not_required: boolean | null;
    not_required_reason: string | null;
    attachment_id: string | null;
    original_name: string | null;
    content_type: string | null;
    uploaded_at: string | null;
    status: string;
  }>(
    `select r.kind, r.label, r.expires,
            d.id::text as document_id, d.expiry_date::text,
            (d.expiry_date - current_date)::int as days_left,
            d.not_required, d.not_required_reason,
            d.attachment_id::text, a.original_name, a.content_type,
            a.created_at::text as uploaded_at,
            ${STATUS_SQL}::text as status
       from compliance_requirements r
       left join compliance_documents d on d.site_id = $1 and d.kind = r.kind
       left join attachments a on a.id = d.attachment_id
      where r.active
      order by r.sort_order, r.label`,
    [site.id],
  );

  /*
   * Superseded certificates. Replacing one keeps the old attachment rather than
   * deleting the bytes: "what was on file when the audit happened" is a
   * question somebody asks eventually, and a compliance register that answers
   * it only for the current document is a register with no history.
   */
  const previous = await db.query<{
    id: string;
    kind: string;
    original_name: string;
    created_at: string;
  }>(
    `select a.id::text, d.kind, a.original_name, a.created_at::text
       from attachments a
       join compliance_documents d on d.id = a.compliance_document_id
      where d.site_id = $1 and (d.attachment_id is null or a.id <> d.attachment_id)
      order by a.created_at desc
      limit 100`,
    [site.id],
  );

  const counts = rows.reduce<Counts>(
    (total, row) => ({
      required: total.required + (row.status === "Not required" ? 0 : 1),
      inDate: total.inDate + (row.status === "Valid" || row.status === "Expiring" ? 1 : 0),
      valid: total.valid + (row.status === "Valid" ? 1 : 0),
      expiring: total.expiring + (row.status === "Expiring" ? 1 : 0),
      expired: total.expired + (row.status === "Expired" ? 1 : 0),
      missing: total.missing + (row.status === "Missing" ? 1 : 0),
      notRequired: total.notRequired + (row.status === "Not required" ? 1 : 0),
    }),
    ZERO,
  );

  return c.json({
    site,
    requirements: rows.map((row) => ({
      ...row,
      days_left: row.days_left === null ? null : Number(row.days_left),
      not_required: Boolean(row.not_required),
      previous: previous.filter((file) => file.kind === row.kind),
    })),
    score: scoreOf(counts),
    expiringWithinDays: await soonDays(db),
    canManage: canManageCompliance(actor),
  });
});

/* ================================================================ writing == */

type Site = { id: string; name: string; organisation_id: string };

/** The site, if this caller may see it. One query, one predicate, no exceptions. */
async function siteInScope(
  db: Db,
  actor: Actor,
  siteId: string,
): Promise<Site | null> {
  const params: unknown[] = [siteId];
  const scoped = withScope(
    `select s.id::text, s.name, s.organisation_id::text
       from sites s where s.id = $1`,
    params,
    siteScopeFor(actor, "s", params.length),
  );
  const [site] = await db.query<Site>(scoped.sql, scoped.params);
  return site ?? null;
}

/** The requirement, if it is one. An unknown kind is a 404, not a new row. */
async function requirement(db: Db, kind: string): Promise<RequirementRow | null> {
  const [row] = await db.query<RequirementRow>(
    "select kind, label, expires, sort_order from compliance_requirements where kind = $1 and active",
    [kind],
  );
  return row ?? null;
}

/**
 * The document row for this site and requirement, created if it is not there.
 *
 * `on conflict do update` rather than `do nothing` because `do nothing` returns
 * no row, and this needs the id back on both paths. The unique index on
 * (site_id, kind) from migration 0004 is what makes it one row per requirement
 * however many people press the button at once.
 */
async function ensureDocument(
  db: Db,
  site: Site,
  kind: string,
): Promise<{ id: string }> {
  const [row] = await db.query<{ id: string }>(
    `insert into compliance_documents (organisation_id, site_id, kind)
     values ($1,$2,$3)
     on conflict (site_id, kind) do update set kind = excluded.kind
     returning id::text`,
    [site.organisation_id, site.id, kind],
  );
  return row;
}

async function log(
  db: Db,
  actor: Actor,
  organisationId: string,
  action: string,
  entityId: string,
  detail: Record<string, unknown>,
) {
  await db.query(
    `insert into activity_log (organisation_id, actor_profile_id, actor_email, action, entity_type, entity_id, detail)
     values ($1,$2,$3,$4,'compliance_document',$5,$6)`,
    [organisationId, actor.profileId, actor.email, action, entityId, JSON.stringify(detail)],
  );
}

/**
 * Resolves the caller, the site and the requirement — or the refusal.
 *
 * Every write below needs the same four checks in the same order, and the order
 * is load-bearing: the capability first (so a client_user learns nothing about
 * which sites exist), then the site through `siteScopeFor`, then the
 * requirement. Four handlers each restating that is four chances to drop one.
 */
type Target =
  | { refusal: Response }
  | { refusal?: undefined; db: Db; actor: Actor; site: Site; kind: RequirementRow };

async function target(c: Context<Env>): Promise<Target> {
  const db = c.get("db");
  const actor = c.get("actor");
  if (!canManageCompliance(actor)) {
    return {
      refusal: c.json({ error: "You cannot change the compliance register." }, 403),
    };
  }
  const siteId = c.req.param("siteId");
  if (!UUID_SHAPE.test(siteId)) {
    return { refusal: c.json({ error: "No such site." }, 404) };
  }

  // 404 rather than 403 for a site out of scope, for the reason given above.
  const site = await siteInScope(db, actor, siteId);
  if (!site) return { refusal: c.json({ error: "No such site." }, 404) };

  const kind = await requirement(db, str(c.req.param("kind"), 60));
  if (!kind) return { refusal: c.json({ error: "No such requirement." }, 404) };

  return { db, actor, site, kind };
}

/**
 * POST /compliance/site/:siteId/:kind/expiry — record or clear the date.
 *
 * `{ expiryDate: null }` clears it, which is not the same as marking the
 * requirement not required: clearing says the date is unknown and the row goes
 * back to Missing, still counted, still somebody's job.
 */
compliance.post("/site/:siteId/:kind/expiry", async (c) => {
  const resolved = await target(c);
  if (resolved.refusal) return resolved.refusal;
  const { db, actor, site, kind } = resolved;

  const body = await c.req.json().catch(() => ({}));
  const raw = body.expiryDate;
  const expiry = raw === null || raw === "" ? null : isoDate(raw);
  if (raw !== null && raw !== "" && expiry === null) {
    return c.json({ error: "Enter the expiry date as YYYY-MM-DD." }, 400);
  }
  if (expiry !== null && !kind.expires) {
    // Refused rather than stored and ignored: a date on a requirement that
    // cannot expire would show on screen and never mean anything.
    return c.json({ error: `${kind.label} does not carry an expiry date.` }, 400);
  }

  const document = await ensureDocument(db, site, kind.kind);
  const [row] = await db.query(
    `update compliance_documents
        set expiry_date = $2, reviewed_by = $3, reviewed_at = now()
      where id = $1
      returning id::text, kind, expiry_date::text, status::text`,
    [document.id, expiry, actor.profileId],
  );

  await log(db, actor, site.organisation_id, "compliance.expiry_set", document.id, {
    site: site.name,
    kind: kind.kind,
    expiryDate: expiry,
  });
  return c.json({ ok: true, document: row });
});

/**
 * POST /compliance/site/:siteId/:kind/not-required — with a reason, always.
 *
 * This is the one control that REMOVES a row from the score's denominator, so
 * it is the one that has to be justified. The database refuses a reasonless
 * `not_required` too (migration 0009); this check exists to give the person a
 * sentence rather than a constraint violation.
 */
compliance.post("/site/:siteId/:kind/not-required", async (c) => {
  const resolved = await target(c);
  if (resolved.refusal) return resolved.refusal;
  const { db, actor, site, kind } = resolved;

  const reason = str((await c.req.json().catch(() => ({}))).reason, 300);
  if (!reason) {
    return c.json({ error: "Say why this is not required." }, 400);
  }

  const document = await ensureDocument(db, site, kind.kind);
  const [row] = await db.query(
    `update compliance_documents
        set not_required = true, not_required_reason = $2,
            reviewed_by = $3, reviewed_at = now()
      where id = $1
      returning id::text, kind, not_required, not_required_reason, status::text`,
    [document.id, reason, actor.profileId],
  );

  await log(db, actor, site.organisation_id, "compliance.not_required", document.id, {
    site: site.name,
    kind: kind.kind,
    reason,
  });
  return c.json({ ok: true, document: row });
});

/** POST /compliance/site/:siteId/:kind/required — put it back in the count. */
compliance.post("/site/:siteId/:kind/required", async (c) => {
  const resolved = await target(c);
  if (resolved.refusal) return resolved.refusal;
  const { db, actor, site, kind } = resolved;

  const document = await ensureDocument(db, site, kind.kind);
  const [row] = await db.query(
    `update compliance_documents
        set not_required = false, not_required_reason = null,
            reviewed_by = $2, reviewed_at = now()
      where id = $1
      returning id::text, kind, not_required, status::text`,
    [document.id, actor.profileId],
  );

  await log(db, actor, site.organisation_id, "compliance.required", document.id, {
    site: site.name,
    kind: kind.kind,
  });
  return c.json({ ok: true, document: row });
});

/**
 * POST /compliance/site/:siteId/:kind/certificate — the file itself.
 *
 * Same pipeline as every other upload in the product: the bytes are sniffed for
 * their real type, the key is minted here and never accepted from the caller,
 * the bucket is private, and the file comes back only through a short-lived
 * signed URL. The attachment's OWNER is the site, which is what makes the
 * existing `GET /uploads/:id/url` serve it under `siteScopeFor` with no second
 * access rule written anywhere.
 *
 * `expiryDate` rides in the same form, because "upload the certificate" and
 * "say when it runs out" are one action to the person doing it, and splitting
 * them into two requests is how a certificate ends up on file with no date.
 */
compliance.post("/site/:siteId/:kind/certificate", async (c) => {
  const resolved = await target(c);
  if (resolved.refusal) return resolved.refusal;
  const { db, actor, site, kind } = resolved;

  const received = await receiveOneFile(c);
  if (!received.ok) return c.json({ error: received.error }, received.status);
  const { bytes, contentType, extension, originalName, form } = received.file;

  const rawExpiry = form.get("expiryDate");
  const expiry = typeof rawExpiry === "string" && rawExpiry.trim()
    ? isoDate(rawExpiry)
    : null;
  if (typeof rawExpiry === "string" && rawExpiry.trim() && expiry === null) {
    return c.json({ error: "Enter the expiry date as YYYY-MM-DD." }, 400);
  }
  if (expiry !== null && !kind.expires) {
    return c.json({ error: `${kind.label} does not carry an expiry date.` }, 400);
  }

  const key = objectKeyFor(`compliance/${site.id}`, extension);
  const storage = getStorage();
  await storage.put(key, bytes, contentType);

  try {
    const document = await ensureDocument(db, site, kind.kind);

    const attachment = await db.transaction(async (tx) => {
      const [file] = await tx.query<{ id: string }>(
        `insert into attachments
           (kind, object_key, original_name, content_type, byte_size, sha256,
            site_id, organisation_id, compliance_document_id, uploaded_by, uploaded_by_name)
         values ('file',$1,$2,$3,$4,$5,$6,$7,$8,$9,
                 (select full_name from profiles where id = $9))
         returning id::text`,
        [
          /*
           * 'file' rather than `defaultKindFor`, which would call a photograph
           * of a certificate an `issue_picture` and file a compliance document
           * under the same heading as a picture of a broken shutter.
           */
          key, originalName, contentType, bytes.length, sha256Of(bytes),
          site.id, site.organisation_id, document.id, actor.profileId,
        ],
      );

      await tx.query(
        `update compliance_documents
            set attachment_id = $2,
                expiry_date = coalesce($3, expiry_date),
                reviewed_by = $4, reviewed_at = now()
          where id = $1`,
        [document.id, file.id, expiry, actor.profileId],
      );
      return file;
    });

    await log(db, actor, site.organisation_id, "compliance.certificate_uploaded", document.id, {
      site: site.name,
      kind: kind.kind,
      attachmentId: attachment.id,
      expiryDate: expiry,
    });

    const [row] = await db.query(
      `select d.id::text, d.kind, d.expiry_date::text, d.attachment_id::text,
              ${STATUS_SQL}::text as status
         from compliance_documents d
         join compliance_requirements r on r.kind = d.kind
        where d.id = $1`,
      [document.id],
    );
    return c.json({ ok: true, document: row, attachmentId: attachment.id });
  } catch (error) {
    // The bytes are already in the bucket. Leaving them on a failed insert is an
    // object nothing references and nothing will ever clean up.
    await storage.delete(key).catch(() => {});
    throw error;
  }
});
