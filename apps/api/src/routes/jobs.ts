import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import {
  canDecideQuotes,
  canManageShareLinks,
  canSeeMoney,
  canTriage,
  isStaff,
  scopeFor,
  siteScopeFor,
  withScope,
  type Role,
} from "../lib/access.ts";
import { requireActor, type Env } from "../lib/middleware.ts";
import { str } from "../lib/http.ts";
import { sendMailBestEffort } from "../lib/mail.ts";

const webUrl = () =>
  (process.env.WEB_URL ?? "http://localhost:3000").replace(/\/+$/, "");

/**
 * Path parameters are checked for shape before they reach a query.
 *
 * Postgres raises `invalid input syntax for type uuid` on anything else, which
 * becomes a 500 and a stack trace in the logs where the honest answer is the
 * same 404 an unknown id gets. It also means a scanner walking
 * `/jobs/<junk>/assign` learns nothing from the difference between malformed
 * and merely absent.
 */
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The 23 labels, guarded at the edge so a typo cannot reach the enum. */
const STATUSES = new Set([
  "Pending Approval", "Pending Scheduling", "Job Scheduled", "Awaiting Access",
  "Job In Progress", "Major works", "Waiting for parts", "Quote requested",
  "Quote Received (waiting for Approval)", "Quote approved", "Quote rejected",
  "Blocked - Awaiting Response", "Awaiting Landlord Approval",
  "Health And Safety Hold", "Waiting for decisions", "Third Party Delay",
  "Escalated", "Waiting for payment", "Deposit Invoice Received",
  "Deposit Invoice Paid", "Completion Invoice Received",
  "Completion Invoice Paid", "Job Completed",
]);

/** The seven stages, guarded at the edge so a typo cannot reach the enum. */
const STAGES = new Set([
  "New", "Scheduling", "In Progress", "Quotes", "On Hold", "Payment", "Done",
]);

/**
 * A page size that is always a whole number between 1 and `max`.
 *
 * `Math.min(Number(q) || 100, 500)` clamped only the top, so a negative or
 * fractional value went straight into `LIMIT` and 500'd.
 */
function pageSize(raw: string | undefined, fallback: number, max: number): number {
  const value = Math.trunc(Number(raw));
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(value, max);
}

/** Columns a contractor may never receive. */
const MONEY_COLUMNS = "j.cost_of_works_pence, j.invoice_ref, j.approved_by";

/**
 * The statuses a contractor may move a job to.
 *
 * A contractor has always been allowed to move a job's status — they are the
 * ones doing the work — but the full set of 23 includes five payment labels
 * ("Deposit Invoice Paid", "Completion Invoice Received"…). Handing those to a
 * role the whole product refuses to show money to is incoherent: they cannot
 * see the invoice and would be asserting it had been paid. This is the list of
 * things a person on site can truthfully say about the job in front of them.
 */
const CONTRACTOR_STATUSES = new Set([
  "Job Scheduled",
  "Awaiting Access",
  "Job In Progress",
  "Waiting for parts",
  "Job Completed",
]);

export const jobs = new Hono<Env>();
jobs.use("*", requireActor);

/**
 * One job, if this caller may see it — the single-row read every write below
 * starts from.
 *
 * `withScope(scopeFor(...))` and nothing else. The rule stated at the top of
 * `access.ts` is that no handler writes its own tenancy predicate, and a helper
 * is how six handlers go on obeying it without six chances to forget one.
 * Out of scope and genuinely absent both answer `null`, which is what keeps
 * every refusal a 404: a 403 would confirm the row exists.
 *
 * `columns` is interpolated, and is only ever a literal from this file.
 */
async function scopedJob<T = Record<string, unknown>>(
  c: Context<Env>,
  columns: string,
): Promise<T | null> {
  const id = c.req.param("id");
  if (!UUID_SHAPE.test(id)) return null;

  const params: unknown[] = [id];
  const scoped = withScope(
    `select ${columns} from jobs j where j.id = $1`,
    params,
    scopeFor(c.get("actor"), "j", params.length),
  );
  const [row] = await c.get("db").query<T>(scoped.sql, scoped.params);
  return row ?? null;
}

/**
 * The board.
 *
 * The tenancy predicate comes from `scopeFor` and is the only thing standing
 * between one client and another's work — there is no organisation filter
 * written by hand anywhere in this file.
 */
jobs.get("/", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const money = canSeeMoney(actor);

  const base = `
    select j.id::text, j.reference, j.title, j.description, j.status, j.stage,
           j.priority, j.engineer_required, j.fault_label, j.tier_level,
           j.location, j.date_requested::text, j.date_completed::text,
           j.next_update::text, j.job_requested_by, j.contact_number,
           j.contractor_name, j.assigned_to_name,
           /* Only to a caller who is shown money. The token opens the public
              view of the job, which includes the cost of works — see the note
              in GET /jobs/:id below. */
           ${money ? "j.share_token," : ""}
           j.site_id::text, s.name as site_name,
           j.organisation_id::text, o.name as organisation_name,
           /* Assignment travels with the list, not just the detail: the
              contractor's own screen is built from this endpoint, and "which
              of these have I not answered yet" is the first thing it has to
              show. None of it is money, so every role gets it. */
           j.assignment_status::text, j.assigned_at::text, j.accepted_at::text,
           j.declined_at::text, j.decline_reason, j.eta_at::text
           ${money ? `, ${MONEY_COLUMNS}` : ""}
      from jobs j
      left join sites s on s.id = j.site_id
      left join organisations o on o.id = j.organisation_id`;

  /*
   * ONE predicate list, shared by the rows and the count.
   *
   * These were built separately and the count composed only `scopeFor`, so
   * `?stage=New` returned 1 row with `total: 17, hasMore: true` — the caller
   * pages forward and walks into empty results, while the UI reports a total
   * belonging to a different query. Anything that filters here must reach both
   * statements or they describe different questions.
   */
  const params: unknown[] = [];
  const where: string[] = [];

  const scope = scopeFor(actor, "j", params.length);
  if (scope.sql !== "true") {
    where.push(scope.sql);
    params.push(...scope.params);
  }

  const stage = str(c.req.query("stage"), 20);
  const siteId = str(c.req.query("siteId"), 40);
  const search = str(c.req.query("q"), 120);

  /*
   * Filters are validated, not just cast.
   *
   * `$n::job_stage` on a value outside the enum, and a non-uuid `siteId`, both
   * made Postgres reject the statement — surfacing as a 500 where a caller
   * mistyping a query string deserves an empty result or a 400. `POST
   * /:id/status` already validated against a fixed list; the read path did not.
   */
  if (stage) {
    if (!STAGES.has(stage)) {
      return c.json({ error: "Unknown stage." }, 400);
    }
    params.push(stage);
    where.push(`j.stage = $${params.length}::job_stage`);
  }
  if (siteId) {
    if (!UUID_SHAPE.test(siteId)) {
      return c.json({ error: "Unknown site." }, 400);
    }
    params.push(siteId);
    where.push(`j.site_id = $${params.length}`);
  }
  if (search) {
    // An engineer looks for "the shutter at Aldgate", not a reference number.
    params.push(`%${search}%`);
    where.push(
      `(j.title ilike $${params.length} or j.description ilike $${params.length}
        or j.reference ilike $${params.length} or s.name ilike $${params.length})`,
    );
  }

  const whereSql = where.length ? ` where ${where.join(" and ")}` : "";

  // Paged, with a stated total. A bare `limit` that the UI renders as the whole
  // board is how "250 of 744 jobs" reads as complete — a bug this product has
  // already had once.
  // Clamped at BOTH ends and coerced to an integer: `?limit=-1` reached
  // Postgres as a negative LIMIT (500), and `?limit=1.5` as a fraction.
  const limit = pageSize(c.req.query("limit"), 100, 500);
  const offset = Math.max(Math.trunc(Number(c.req.query("offset")) || 0), 0);

  const rows = await db.query(
    /*
     * `j.id` is the tiebreaker, and it is load-bearing.
     *
     * `date_requested` is not unique — 638 of 792 real jobs share a timestamp
     * with another, one of them with 30 others, because the legacy import
     * carries dates without a time. LIMIT/OFFSET over a tied sort has no
     * defined order between the tied rows, so Postgres is free to return a row
     * on page 1 and again on page 2 while another is never returned at all.
     * Measured before this line existed: walking every page of `stage=Done` at
     * limit=10 yielded 647 distinct jobs out of a stated total of 675 — 28
     * jobs unreachable, with no error and no gap on screen. A single page was
     * stable when re-fetched, so it never looked like flakiness.
     *
     * Any endpoint that pages needs a unique final sort key. This is the same
     * family as "every document past the first 100 was unreachable", with a
     * different mechanism.
     */
    `${base}${whereSql} order by j.date_requested desc, j.id desc limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, limit, offset],
  );

  const [{ n }] = await db.query<{ n: number }>(
    `select count(*)::int as n from jobs j
       left join sites s on s.id = j.site_id
       left join organisations o on o.id = j.organisation_id${whereSql}`,
    params,
  );

  return c.json({
    jobs: rows,
    total: Number(n),
    limit,
    offset,
    hasMore: offset + rows.length < Number(n),
  });
});

/** Stage counts for the queue tabs — computed over everything, not the page. */
jobs.get("/summary", async (c) => {
  const actor = c.get("actor");
  const scoped = withScope(
    "select j.stage::text as stage, count(*)::int as n from jobs j",
    [],
    scopeFor(actor, "j"),
  );
  const rows = await c
    .get("db")
    .query<{ stage: string; n: number }>(`${scoped.sql} group by j.stage`, scoped.params);
  return c.json({ byStage: Object.fromEntries(rows.map((r) => [r.stage, Number(r.n)])) });
});

/**
 * GET /jobs/summary/monthly — the client admin's month-by-month picture.
 *
 * Twelve months of jobs raised, jobs completed and spend, plus what is open
 * right now by stage. Scoped like everything else: staff get the whole book,
 * a client_admin gets their organisation, a client_user gets their sites.
 * There is no `organisationId` parameter — a caller who could name the
 * organisation could name somebody else's.
 *
 * Contractors are refused outright. Not because the rows would leak (the scope
 * would restrict them to their own jobs) but because every figure on the page
 * is either money or a portfolio-level count of a client's estate, and neither
 * is a contractor's business. `canSeeMoney` is the existing expression of that.
 */
jobs.get("/summary/monthly", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  if (!canSeeMoney(actor)) {
    return c.json({ error: "This summary is not available to your role." }, 403);
  }

  /*
   * ONE predicate, referenced three times.
   *
   * `scopeFor` numbers its placeholders from an offset and the same `$n` may
   * appear as often as it likes in one statement, so the three correlated
   * counts below share a single copy of the parameters. Building it three
   * times with three offsets would be three chances to get the numbering
   * wrong, and a mis-numbered tenancy predicate does not fail loudly — it
   * filters by the wrong value.
   */
  const scope = scopeFor(actor, "j");
  const params = [...scope.params];
  const mine = scope.sql; // "true" for staff

  /*
   * `generate_series` rather than `group by`, so a month with no work is a row
   * of zeroes instead of a gap. A chart drawn from grouped rows silently
   * closes up its empty months and turns a quiet August into a shorter year.
   */
  const months = await db.query<{
    month: string;
    raised: number;
    completed: number;
    spend_pence: string;
  }>(
    `with months as (
       select generate_series(
         date_trunc('month', now()) - interval '11 months',
         date_trunc('month', now()),
         interval '1 month'
       ) as month
     )
     select to_char(m.month, 'YYYY-MM') as month,
            (select count(*)::int from jobs j
              where ${mine} and j.date_requested >= m.month
                and j.date_requested < m.month + interval '1 month') as raised,
            (select count(*)::int from jobs j
              where ${mine} and j.date_completed >= m.month
                and j.date_completed < m.month + interval '1 month') as completed,
            /*
             * Spend: the recorded cost of works, or the approved quote when no
             * cost has been recorded.
             *
             * cost_of_works_pence is monday's column and arrives with
             * imported history; nothing in this product writes it yet, so a
             * summary built on it alone reads £0.00 for a client whose quotes
             * have been approved and whose jobs are finished — a figure that is
             * true of the column and false about the year. COALESCE, not a sum
             * of both: where a cost is recorded it is the better number, and
             * adding the quote to it would count the same work twice.
             *
             * ::text, then Number() in JS. sum() over bigint returns numeric,
             * which both drivers hand back as a string, and a driver that ever
             * returned a BigInt would make JSON.stringify throw at the
             * response.
             */
            (select coalesce(sum(coalesce(
                      j.cost_of_works_pence,
                      (select sum(q.amount_pence) from quotes q
                        where q.job_id = j.id and q.status = 'approved')
                    )), 0)::text
               from jobs j
              where ${mine} and j.date_completed >= m.month
                and j.date_completed < m.month + interval '1 month') as spend_pence
       from months m
      order by m.month`,
    params,
  );

  const openScope = withScope(
    `select j.stage::text as stage, count(*)::int as n from jobs j
      where j.stage <> 'Done'`,
    [],
    scopeFor(actor, "j"),
  );
  const open = await db.query<{ stage: string; n: number }>(
    `${openScope.sql} group by j.stage`,
    openScope.params,
  );

  const rows = months.map((row) => ({
    month: row.month,
    raised: Number(row.raised),
    completed: Number(row.completed),
    spendPence: Number(row.spend_pence),
  }));

  return c.json({
    months: rows,
    openByStage: Object.fromEntries(open.map((r) => [r.stage, Number(r.n)])),
    totals: {
      raised: rows.reduce((sum, row) => sum + row.raised, 0),
      completed: rows.reduce((sum, row) => sum + row.completed, 0),
      spendPence: rows.reduce((sum, row) => sum + row.spendPence, 0),
      open: open.reduce((sum, row) => sum + Number(row.n), 0),
    },
  });
});

/** One job, with its comments and quotes. 404 when out of scope — never 403. */
jobs.get("/:id", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const money = canSeeMoney(actor);

  // The rule stated at the top of this file, which this handler was not
  // obeying: a malformed id reached Postgres, raised `invalid input syntax for
  // type uuid`, and became a 500. That also made a 500-vs-404 oracle telling
  // "malformed" apart from "absent or out of scope".
  if (!UUID_SHAPE.test(c.req.param("id"))) {
    return c.json({ error: "No such job." }, 404);
  }

  const params: unknown[] = [c.req.param("id")];
  const scoped = withScope(
    `select j.*, s.name as site_name, o.name as organisation_name
       from jobs j
       left join sites s on s.id = j.site_id
       left join organisations o on o.id = j.organisation_id
      where j.id = $1`,
    params,
    scopeFor(actor, "j", params.length),
  );

  const [job] = await db.query<Record<string, unknown>>(scoped.sql, scoped.params);
  /*
   * 404, not 403. "Forbidden" confirms the row exists, which lets someone walk
   * uuids to learn how many jobs a competitor has. Out of scope and absent are
   * the same answer.
   */
  if (!job) return c.json({ error: "No such job." }, 404);

  if (!money) {
    delete job.cost_of_works_pence;
    delete job.invoice_ref;
    delete job.approved_by;
    delete job.approved_by_profile_id;
    /*
     * The share token goes too, and it is a money rule rather than a sharing
     * one.
     *
     * `select j.*` was handing `share_token` to a contractor, and that token is
     * a bearer credential for `GET /public/job/:token` — which shows the FULL
     * ticket, cost of works included, by the owner's own decision. So the one
     * role this endpoint carefully strips three money columns from could copy a
     * link out of the same response and read all three in another tab. It cost
     * nothing to notice while a contractor could rarely open a job at all;
     * assignment is what makes them a routine reader of this page.
     *
     * Clients keep it: they may legitimately forward their own job to a
     * landlord or an insurer, and they are shown the money here anyway.
     */
    delete job.share_token;
    delete job.share_enabled;
    delete job.share_expires_at;
  }

  const comments = await db.query(
    `select c.id::text, c.body, c.author_name, c.via_share_link, c.created_at::text,
            p.full_name as author_full_name
       from job_comments c
       left join profiles p on p.id = c.author_profile_id
      where c.job_id = $1 order by c.created_at`,
    [job.id],
  );

  const quotes = money
    ? await db.query(
        `select id::text, amount_pence, description, status, valid_until::text,
                decided_at::text, created_at::text
           from quotes where job_id = $1 order by created_at desc`,
        [job.id],
      )
    : [];

  const attachments = await db.query(
    `select id::text, kind, object_key, original_name, content_type, byte_size,
            uploaded_by_name, via_share_link, pending, created_at::text
       from attachments where job_id = $1 and not pending order by created_at`,
    [job.id],
  );

  return c.json({ job, comments, quotes, attachments });
});

/** Move a job's status. The stage and its timestamp follow in the database. */
jobs.post("/:id/status", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const status = str((await c.req.json().catch(() => ({}))).status, 60);

  if (!STATUSES.has(status)) return c.json({ error: "Unknown status." }, 400);
  // A client watches; staff and the assigned contractor move the work.
  if (!isStaff(actor.role) && actor.role !== "contractor") {
    return c.json({ error: "You cannot change a job's status." }, 403);
  }

  if (actor.role === "contractor") {
    if (!CONTRACTOR_STATUSES.has(status)) {
      return c.json(
        { error: "That status is set by the coordinators, not on site." },
        403,
      );
    }
    /*
     * You may not start work you have not accepted.
     *
     * Read in scope first, so the refusal can say WHICH of the three things is
     * wrong: 404 for a job that is not theirs, and a plain sentence for an
     * offer they have not answered or have already refused. Folding all three
     * into the UPDATE's WHERE would answer "No such job" to a contractor
     * looking straight at it.
     *
     * `assignment_status is null` is allowed on purpose: rows assigned before
     * migration 0008 existed have no offer recorded, and refusing them would
     * strand every job that was already out with a contractor.
     */
    const check = await scopedJob<{
      assignment_status: string | null;
    }>(c, "j.assignment_status::text");
    if (!check) return c.json({ error: "No such job." }, 404);
    if (check.assignment_status === "offered") {
      return c.json(
        { error: "Accept this job before you update it." },
        403,
      );
    }
    if (check.assignment_status === "declined") {
      return c.json(
        { error: "You declined this job. A coordinator has to offer it again." },
        403,
      );
    }
  }

  const params: unknown[] = [c.req.param("id"), status];
  const scoped = withScope(
    /*
     * The completion date follows the status, in the same statement.
     *
     * It did not, and the consequence was quiet: `POST /public/job/:token/
     * complete` set `date_completed` by hand, so a job closed through a share
     * link had one and a job closed in the portal did not. "Date Completed"
     * was therefore blank on most finished jobs, and every "completed this
     * month" figure counted only the ones a contractor had closed from their
     * phone.
     *
     * Cleared on the way back out, because a job sitting in Job In Progress
     * with a completion date against it is a contradiction that would let the
     * monthly summary disagree with the board. Nothing is lost: `stage_done_at`
     * is stamped on FIRST entry by the trigger in 0003 and never rewritten, so
     * the history of when it first finished survives a reopening.
     */
    `update jobs j
        set status = $2::job_status,
            date_completed = case when $2::job_status = 'Job Completed'
                                  then now() else null end
      where j.id = $1`,
    params,
    scopeFor(actor, "j", params.length),
  );
  const rows = await db.query<{ id: string }>(
    `${scoped.sql} returning j.id::text, j.status::text, j.stage::text`,
    scoped.params,
  );
  if (!rows.length) return c.json({ error: "No such job." }, 404);

  await db.query(
    `insert into activity_log (actor_profile_id, actor_email, action, entity_type, entity_id, detail)
     values ($1,$2,'job.status',$3,$4,$5)`,
    [actor.profileId, actor.email, "job", rows[0].id, JSON.stringify({ status })],
  );
  return c.json({ ok: true, job: rows[0] });
});

jobs.post("/:id/comments", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const body = str((await c.req.json().catch(() => ({}))).body, 4000);
  if (!body) return c.json({ error: "Write something first." }, 400);

  const params: unknown[] = [c.req.param("id")];
  const scoped = withScope("select j.id from jobs j where j.id = $1", params,
    scopeFor(actor, "j", params.length));
  const [job] = await db.query<{ id: string }>(scoped.sql, scoped.params);
  if (!job) return c.json({ error: "No such job." }, 404);

  const [comment] = await db.query(
    `insert into job_comments (job_id, body, author_profile_id, visibility)
     values ($1,$2,$3,'public') returning id::text, created_at::text`,
    [job.id, body, actor.profileId],
  );
  return c.json({ ok: true, comment });
});

/* ---------------------------------------------------------------- quotes -- */

jobs.post("/:id/quotes", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  if (!isStaff(actor.role)) return c.json({ error: "Only staff raise quotes." }, 403);

  const body = await c.req.json().catch(() => ({}));
  const amount = Math.round(Number(body.amountPence));
  if (!Number.isFinite(amount) || amount < 0) {
    return c.json({ error: "Enter a valid amount." }, 400);
  }

  const params: unknown[] = [c.req.param("id")];
  const scoped = withScope("select j.id from jobs j where j.id = $1", params,
    scopeFor(actor, "j", params.length));
  const [job] = await db.query<{ id: string }>(scoped.sql, scoped.params);
  if (!job) return c.json({ error: "No such job." }, 404);

  const [quote] = await db.query(
    `insert into quotes (job_id, amount_pence, description, created_by)
     values ($1,$2,nullif($3,''),$4) returning id::text, amount_pence, status`,
    [job.id, amount, str(body.description, 2000), actor.profileId],
  );
  return c.json({ ok: true, quote });
});

/**
 * GET /jobs/quotes/pending — the client admin's approvals queue.
 *
 * Joined through `jobs` so the tenancy predicate is the same one the board
 * uses; without the join there is no organisation on a quote at all and the
 * only way to scope it would be a hand-written subquery, which is precisely
 * what `access.ts` forbids.
 *
 * `canSeeMoney`, not `canDecideQuotes`: a client_user cannot approve anything
 * but may perfectly well look at what their organisation is being asked to
 * approve. The screen decides what to draw from `canDecide` in the response,
 * and `POST /quotes/:id/decide` re-checks it anyway.
 */
jobs.get("/quotes/pending", async (c) => {
  const actor = c.get("actor");
  if (!canSeeMoney(actor)) {
    return c.json({ error: "Quotes are not visible to your role." }, 403);
  }

  const scoped = withScope(
    `select q.id::text, q.amount_pence, q.description, q.valid_until::text,
            q.created_at::text,
            j.id::text as job_id, j.reference, j.title, j.status::text,
            s.name as site_name, o.name as organisation_name
       from quotes q
       join jobs j on j.id = q.job_id
       left join sites s on s.id = j.site_id
       left join organisations o on o.id = j.organisation_id
      where q.status = 'pending'`,
    [],
    scopeFor(actor, "j"),
  );
  const quotes = await c
    .get("db")
    .query(`${scoped.sql} order by q.created_at`, scoped.params);

  return c.json({ quotes, canDecide: canDecideQuotes(actor) });
});

jobs.post("/quotes/:quoteId/decide", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  if (!canDecideQuotes(actor)) {
    return c.json({ error: "You cannot approve or reject quotes." }, 403);
  }

  const decision = str((await c.req.json().catch(() => ({}))).decision, 20);
  if (decision !== "approved" && decision !== "rejected") {
    return c.json({ error: "Decide approved or rejected." }, 400);
  }

  // Joined through `jobs` so the quote is inside the caller's scope: without
  // it, a client_admin could decide any quote in the system by id.
  const params: unknown[] = [c.req.param("quoteId"), decision, actor.profileId];
  const scoped = withScope(
    `update quotes q set status = $2::quote_status, decided_by = $3, decided_at = now()
      from jobs j where q.job_id = j.id and q.id = $1 and q.status = 'pending'`,
    params,
    scopeFor(actor, "j", params.length),
  );
  const rows = await db.query<{ id: string }>(
    `${scoped.sql} returning q.id::text, q.status::text`,
    scoped.params,
  );
  if (!rows.length) return c.json({ error: "No such pending quote." }, 404);
  return c.json({ ok: true, quote: rows[0] });
});

/* ------------------------------------------------------------ assignment -- */

/**
 * POST /jobs/:id/assign — staff hand the job to a contractor.
 *
 * THIS IS THE MOMENT ACCESS IS GRANTED, and it is worth being explicit about
 * why. `scopeFor()` scopes a contractor to `jobs.contractor_id`; there is no
 * grants table, no share row and no second place to look. So writing that
 * column is not bookkeeping about who is doing the work — it IS the
 * authorisation decision. Before this call the contractor's `GET /jobs/:id`
 * answers 404 and their board is empty of it; after it, the job is theirs to
 * read, comment on, photograph and complete.
 *
 * Two consequences follow from that, and both are deliberate:
 *
 *   1. Re-assigning is a revocation. Overwriting `contractor_id` takes the
 *      previous firm's access away in the same statement that grants the new
 *      one's, so there is no cleanup step that can be forgotten and no window
 *      in which two contractors can both read the job.
 *   2. Only staff may call it. A role that could assign could assign to
 *      itself, and self-assignment is self-granted access to any job the caller
 *      could name.
 *
 * The assignment is an OFFER, not a fact — `assignment_status = 'offered'` —
 * until the contractor answers. Everything about that decision is in migration
 * 0008.
 */
jobs.post("/:id/assign", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  if (!isStaff(actor.role)) {
    return c.json({ error: "Only staff assign contractors." }, 403);
  }
  const jobId = c.req.param("id");
  if (!UUID_SHAPE.test(jobId)) return c.json({ error: "No such job." }, 404);

  const body = await c.req.json().catch(() => ({}));
  const contractorId = str(body.contractorId, 40);
  const assignedTo = str(body.assignedTo, 40);
  if (!UUID_SHAPE.test(contractorId)) {
    return c.json({ error: "Choose a contractor." }, 400);
  }
  if (assignedTo && !UUID_SHAPE.test(assignedTo)) {
    return c.json({ error: "Choose a valid person." }, 400);
  }

  const [contractor] = await db.query<{ id: string; name: string; email: string | null }>(
    "select id::text, name, email from contractors where id = $1 and active",
    [contractorId],
  );
  if (!contractor) {
    return c.json({ error: "That contractor is not available." }, 400);
  }

  /*
   * The named individual must plausibly be doing this job: one of our own
   * coordinators, or somebody at the firm being assigned. Without the check an
   * admin can put a client_user's id in `assigned_to`, and the job card then
   * reads as though a store manager is carrying out the repair — a record that
   * is wrong in exactly the way an insurance claim would care about.
   */
  let person: { id: string; full_name: string | null } | null = null;
  if (assignedTo) {
    const [row] = await db.query<{ id: string; full_name: string | null }>(
      `select p.id::text, p.full_name from profiles p
        where p.id = $1 and p.status = 'active'
          and (p.role in ('owner','super_admin','admin') or p.contractor_id = $2)`,
      [assignedTo, contractorId],
    );
    if (!row) {
      return c.json({ error: "That person cannot be assigned to this job." }, 400);
    }
    person = row;
  }

  const params: unknown[] = [
    jobId,
    contractor.id,
    contractor.name,
    person?.id ?? null,
    person?.full_name ?? null,
  ];
  const scoped = withScope(
    `update jobs j
        set contractor_id = $2, contractor_name = $3,
            assigned_to = $4, assigned_to_name = $5,
            assignment_status = 'offered', assigned_at = now(),
            /* A fresh offer clears the last one's answer. Leaving a stale
               declined_at behind would show the new contractor's job as
               refused before they had opened it. */
            accepted_at = null, declined_at = null, decline_reason = null,
            eta_at = null
      where j.id = $1`,
    params,
    scopeFor(actor, "j", params.length),
  );

  /*
   * One transaction for the state change, the visible note and the audit row.
   * An assignment that happened with no trace on the job is the state a
   * coordinator cannot explain three weeks later, and the thread is where the
   * client reads it.
   */
  const assigned = await db.transaction(async (tx) => {
    const rows = await tx.query<{
      id: string;
      reference: string;
      title: string;
      contractor_name: string;
      assigned_to_name: string | null;
      assignment_status: string;
    }>(
      `${scoped.sql} returning j.id::text, j.reference, j.title, j.contractor_name,
              j.assigned_to_name, j.assignment_status::text`,
      scoped.params,
    );
    if (!rows.length) return null;

    await tx.query(
      `insert into job_comments (job_id, body, author_profile_id, visibility)
       values ($1,$2,$3,'public')`,
      [
        rows[0].id,
        `Assigned to ${contractor.name}${person?.full_name ? ` (${person.full_name})` : ""}. Awaiting their acceptance.`,
        actor.profileId,
      ],
    );
    await tx.query(
      `insert into activity_log (actor_profile_id, actor_email, action, entity_type, entity_id, detail)
       values ($1,$2,'job.assigned','job',$3,$4)`,
      [
        actor.profileId,
        actor.email,
        rows[0].id,
        JSON.stringify({ contractorId: contractor.id, assignedTo: person?.id ?? null }),
      ],
    );
    return rows[0];
  });

  if (!assigned) return c.json({ error: "No such job." }, 404);

  // Best effort, and outside the transaction: a mail server having a bad day
  // must not roll back an assignment that has already happened.
  if (contractor.email) {
    sendMailBestEffort({
      to: contractor.email,
      subject: `New job for you — ${assigned.reference}`,
      text: `${assigned.title}\n\nMAINTSUPP has offered this job to ${contractor.name}. Accept it, decline it or give an ETA in the portal:\n\n${webUrl()}/portal/my-jobs`,
    });
  }

  return c.json({ ok: true, job: assigned });
});

/**
 * The three answers a contractor can give, and who may give them.
 *
 * The assigned contractor decides; staff may act for them. That is the same
 * shape as `canDecideQuotes` — the coordinator who takes the phone call at
 * 06:40 has to be able to write down "Acme can't get there before Thursday"
 * without borrowing somebody's login. Every write records who actually made
 * the call in `activity_log`, so acting-for is visible rather than
 * indistinguishable.
 *
 * A client never appears here: the person paying for the work does not get to
 * accept it on the contractor's behalf.
 */
const canAnswerOffer = (role: Role): boolean =>
  isStaff(role) || role === "contractor";

/**
 * Why a write did not happen, said in words rather than as a bare 404.
 *
 * The UPDATEs below carry their preconditions in the WHERE clause so the
 * decision and the write are one statement and cannot race. That makes every
 * failure look identical — nought rows — so this re-reads the row IN SCOPE to
 * tell "not yours" (404, the only answer a stranger gets) from "not in a state
 * where that makes sense" (a sentence the contractor can act on).
 */
async function explainOfferFailure(
  c: Context<Env>,
  action: "accept" | "decline" | "eta",
) {
  const job = await scopedJob<{
    contractor_id: string | null;
    assignment_status: string | null;
  }>(c, "j.contractor_id::text, j.assignment_status::text");

  if (!job) return c.json({ error: "No such job." }, 404);
  if (!job.contractor_id) {
    return c.json({ error: "This job has not been assigned to a contractor." }, 400);
  }
  if (job.assignment_status === "declined") {
    return c.json(
      { error: "This job was declined. A coordinator has to offer it again." },
      400,
    );
  }
  if (action === "eta" && job.assignment_status === "offered") {
    return c.json({ error: "Accept the job before giving an ETA." }, 400);
  }
  if (action === "decline" && job.assignment_status === null) {
    return c.json({ error: "There is no offer on this job to decline." }, 400);
  }
  return c.json({ error: "That is not something you can do to this job now." }, 400);
}

/**
 * POST /jobs/:id/assignment/accept.
 *
 * Idempotent by construction: `accepted` passes the WHERE and `accepted_at` is
 * coalesced, so a double tap on a phone with a slow connection is a no-op
 * rather than a second acceptance that moves the timestamp. A job that was
 * declined is NOT accepted from here — staff re-offer it, which puts a human
 * back in the loop and is the only way `contractor_id` should ever change.
 *
 * A NULL assignment_status is accepted too, and that case is not hypothetical:
 * `0010_import.sql` brings in monday history with `contractor_id` already set
 * and no offer ever recorded. Refusing those would leave a contractor looking
 * at their own imported work with an Accept button that says the job is not
 * theirs.
 */
jobs.post("/:id/assignment/accept", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  if (!canAnswerOffer(actor.role)) {
    return c.json({ error: "Only the assigned contractor answers an offer." }, 403);
  }
  const jobId = c.req.param("id");
  if (!UUID_SHAPE.test(jobId)) return c.json({ error: "No such job." }, 404);

  const params: unknown[] = [jobId];
  const scoped = withScope(
    `update jobs j
        set assignment_status = 'accepted',
            accepted_at = coalesce(j.accepted_at, now())
      where j.id = $1 and j.contractor_id is not null
        and j.assignment_status is distinct from 'declined'`,
    params,
    scopeFor(actor, "j", params.length),
  );
  const rows = await db.query<{ id: string; contractor_name: string | null }>(
    `${scoped.sql} returning j.id::text, j.reference, j.contractor_name,
            j.assignment_status::text, j.accepted_at::text, j.eta_at::text`,
    scoped.params,
  );
  if (!rows.length) return explainOfferFailure(c, "accept");

  await db.transaction(async (tx) => {
    await tx.query(
      `insert into job_comments (job_id, body, author_profile_id, visibility)
       values ($1,$2,$3,'public')`,
      [
        rows[0].id,
        `${rows[0].contractor_name ?? "The contractor"} accepted this job.`,
        actor.profileId,
      ],
    );
    await tx.query(
      `insert into activity_log (actor_profile_id, actor_email, action, entity_type, entity_id)
       values ($1,$2,'job.assignment_accepted','job',$3)`,
      [actor.profileId, actor.email, rows[0].id],
    );
  });

  return c.json({ ok: true, job: rows[0] });
});

/**
 * POST /jobs/:id/assignment/decline.
 *
 * The reason is mandatory here as well as in the database's CHECK, so the
 * refusal arrives as a 400 the contractor can read rather than as a constraint
 * violation. The job KEEPS its contractor — see 0008 — so this does not make it
 * disappear from anybody's screen; it changes it from "waiting on Acme" to
 * "Acme said no, and here is what they said".
 */
jobs.post("/:id/assignment/decline", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  if (!canAnswerOffer(actor.role)) {
    return c.json({ error: "Only the assigned contractor answers an offer." }, 403);
  }
  const jobId = c.req.param("id");
  if (!UUID_SHAPE.test(jobId)) return c.json({ error: "No such job." }, 404);

  const reason = str((await c.req.json().catch(() => ({}))).reason, 500);
  if (!reason) {
    return c.json(
      { error: "Say why. The coordinator's next move depends on it." },
      400,
    );
  }

  const params: unknown[] = [jobId, reason];
  const scoped = withScope(
    `update jobs j
        set assignment_status = 'declined', declined_at = now(), decline_reason = $2
      where j.id = $1 and j.contractor_id is not null
        and j.assignment_status in ('offered','accepted')`,
    params,
    scopeFor(actor, "j", params.length),
  );
  const rows = await db.query<{
    id: string;
    reference: string;
    title: string;
    contractor_name: string | null;
  }>(
    `${scoped.sql} returning j.id::text, j.reference, j.title, j.contractor_name,
            j.assignment_status::text, j.declined_at::text, j.decline_reason`,
    scoped.params,
  );
  if (!rows.length) return explainOfferFailure(c, "decline");

  await db.transaction(async (tx) => {
    await tx.query(
      `insert into job_comments (job_id, body, author_profile_id, visibility)
       values ($1,$2,$3,'public')`,
      [
        rows[0].id,
        `${rows[0].contractor_name ?? "The contractor"} declined this job: ${reason}`,
        actor.profileId,
      ],
    );
    await tx.query(
      `insert into activity_log (actor_profile_id, actor_email, action, entity_type, entity_id, detail)
       values ($1,$2,'job.assignment_declined','job',$3,$4)`,
      [actor.profileId, actor.email, rows[0].id, JSON.stringify({ reason })],
    );
  });

  /*
   * Somebody has to notice. A decline that only changes a column is a job
   * quietly not being done, which is the failure mode this whole feature
   * exists to remove.
   */
  sendMailBestEffort({
    to: process.env.ADMIN_EMAIL ?? "info@maintsupp.com",
    subject: `${rows[0].reference} declined — needs reassignment`,
    text: `${rows[0].contractor_name ?? "The contractor"} declined ${rows[0].reference} (${rows[0].title}).\n\nReason: ${reason}\n\nReassign it: ${webUrl()}/portal/jobs/${rows[0].id}`,
  });

  return c.json({ ok: true, job: rows[0] });
});

/**
 * POST /jobs/:id/assignment/eta — when somebody is actually turning up.
 *
 * Only on an accepted job: an ETA is a promise, and there is nobody to make it
 * until the offer has been taken. Bounded either side because the realistic
 * mistake is a typo, not a lie — a mistyped year lands "2062" on a client's
 * screen as a date they are expected to plan around, and an ETA a week in the
 * past is a slip of the date picker rather than an attendance record.
 */
jobs.post("/:id/assignment/eta", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  if (!canAnswerOffer(actor.role)) {
    return c.json({ error: "Only the assigned contractor sets an ETA." }, 403);
  }
  const jobId = c.req.param("id");
  if (!UUID_SHAPE.test(jobId)) return c.json({ error: "No such job." }, 404);

  const raw = str((await c.req.json().catch(() => ({}))).etaAt, 40);
  const eta = new Date(raw);
  if (!raw || Number.isNaN(eta.getTime())) {
    return c.json({ error: "Give a date and a time." }, 400);
  }
  const now = Date.now();
  if (eta.getTime() < now - 24 * 3600_000) {
    return c.json({ error: "That is in the past. Check the date." }, 400);
  }
  if (eta.getTime() > now + 365 * 24 * 3600_000) {
    return c.json({ error: "That is more than a year away. Check the year." }, 400);
  }

  const params: unknown[] = [jobId, eta.toISOString()];
  const scoped = withScope(
    /*
     * Accepted, or an imported row that was assigned before offers existed —
     * the same pair the status endpoint treats as "this work is under way".
     * An unanswered offer is the one state that blocks an ETA, because there
     * is nobody yet who has promised to attend.
     */
    `update jobs j set eta_at = $2::timestamptz
      where j.id = $1 and j.contractor_id is not null
        and (j.assignment_status = 'accepted' or j.assignment_status is null)`,
    params,
    scopeFor(actor, "j", params.length),
  );
  const rows = await db.query<{ id: string; eta_at: string }>(
    `${scoped.sql} returning j.id::text, j.eta_at::text`,
    scoped.params,
  );
  if (!rows.length) return explainOfferFailure(c, "eta");

  // Written into the thread, not only the audit log: "when are they coming" is
  // the question the client rings up to ask, and the answer belongs where they
  // are already looking.
  const when = eta.toLocaleString("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  await db.transaction(async (tx) => {
    await tx.query(
      `insert into job_comments (job_id, body, author_profile_id, visibility)
       values ($1,$2,$3,'public')`,
      [rows[0].id, `On site by ${when}.`, actor.profileId],
    );
    await tx.query(
      `insert into activity_log (actor_profile_id, actor_email, action, entity_type, entity_id, detail)
       values ($1,$2,'job.eta_set','job',$3,$4)`,
      [actor.profileId, actor.email, rows[0].id, JSON.stringify({ etaAt: eta.toISOString() })],
    );
  });

  return c.json({ ok: true, job: rows[0] });
});

/* ----------------------------------------------------------- share links -- */

jobs.post("/:id/share/rotate", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  if (!canManageShareLinks(actor)) return c.json({ error: "Not permitted." }, 403);

  const params: unknown[] = [c.req.param("id"), randomBytes(32).toString("hex")];
  const scoped = withScope(
    "update jobs j set share_token = $2, share_enabled = true where j.id = $1",
    params,
    scopeFor(actor, "j", params.length),
  );
  const rows = await db.query<{ share_token: string }>(
    `${scoped.sql} returning j.share_token`,
    scoped.params,
  );
  if (!rows.length) return c.json({ error: "No such job." }, 404);
  return c.json({ ok: true, shareToken: rows[0].share_token });
});

jobs.post("/:id/share/disable", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  if (!canManageShareLinks(actor)) return c.json({ error: "Not permitted." }, 403);

  const params: unknown[] = [c.req.param("id")];
  const scoped = withScope(
    "update jobs j set share_enabled = false where j.id = $1",
    params,
    scopeFor(actor, "j", params.length),
  );
  const rows = await db.query(`${scoped.sql} returning j.id::text`, scoped.params);
  if (!rows.length) return c.json({ error: "No such job." }, 404);
  return c.json({ ok: true });
});

/* ------------------------------------------------------------ sites/meta -- */

jobs.get("/meta/sites", async (c) => {
  const actor = c.get("actor");
  /*
   * Address and postcode ride along so the portal's Report a Job form can fill
   * them in from the site the reporter picks. The public form asks a stranger
   * to type both; a store manager already told us where they work when their
   * account was scoped, and asking again is how "Whitechapel Rd" and
   * "Whitechapel Road" become two addresses for one shop.
   */
  const scoped = withScope(
    `select s.id::text, s.name, s.address, s.postcode, s.organisation_id::text
       from sites s where s.active`,
    [],
    siteScopeFor(actor, "s"),
  );
  const rows = await c.get("db").query(`${scoped.sql} order by s.name`, scoped.params);
  return c.json({ sites: rows });
});

/* --------------------------------------------------------------- triage -- */

/** The Incoming Requests queue: public intake awaiting a decision. */
jobs.get("/intake/pending", async (c) => {
  const actor = c.get("actor");
  if (!canTriage(actor)) return c.json({ error: "Not permitted." }, 403);
  const rows = await c.get("db").query(
    `select id::text, site_name, contact_name, phone, email, address, postcode,
            fault_category, urgency, description, access_window, photos,
            created_at::text
       from job_requests where status = 'new' order by created_at desc limit 200`,
  );
  return c.json({ requests: rows });
});

/** Convert an intake request into a real job, in one transaction. */
jobs.post("/intake/:id/convert", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  if (!canTriage(actor)) return c.json({ error: "Not permitted." }, 403);

  const body = await c.req.json().catch(() => ({}));
  const organisationId = str(body.organisationId, 40);
  const siteId = str(body.siteId, 40) || null;
  const priority = str(body.priority, 20) || "Medium";
  if (!organisationId) return c.json({ error: "Choose an organisation." }, 400);

  try {
    const created = await db.transaction(async (tx) => {
      const [request] = await tx.query<Record<string, string>>(
        "select * from job_requests where id = $1 and status = 'new'",
        [c.req.param("id")],
      );
      if (!request) return null;

      const [job] = await tx.query<{ id: string; reference: string }>(
        `insert into jobs (organisation_id, site_id, source_request_id, title, description,
                           location, priority, job_requested_by, contact_number, created_by,
                           status, date_requested)
         values ($1,$2,$3,$4,$5,$6,$7::job_priority,$8,$9,$10,'Pending Scheduling',$11)
         returning id::text, reference`,
        [
          organisationId, siteId, request.id,
          `${request.fault_category} — ${request.site_name}`.slice(0, 200),
          request.description, request.site_name, priority,
          request.contact_name, request.phone, actor.profileId, request.created_at,
        ],
      );

      await tx.query(
        "update job_requests set status = 'converted', converted_job_id = $2, triaged_by = $3, triaged_at = now() where id = $1",
        [request.id, job.id, actor.profileId],
      );
      // The photographs move with it — they are the evidence the job exists.
      await tx.query(
        "update attachments set job_id = $2, job_request_id = null where job_request_id = $1",
        [request.id, job.id],
      );
      return job;
    });

    if (!created) return c.json({ error: "No such pending request." }, 404);
    return c.json({ ok: true, job: created });
  } catch (error) {
    console.error("[triage]", error);
    return c.json({ error: "Could not convert that request." }, 400);
  }
});

jobs.post("/intake/:id/reject", async (c) => {
  const actor = c.get("actor");
  if (!canTriage(actor)) return c.json({ error: "Not permitted." }, 403);
  const reason = str((await c.req.json().catch(() => ({}))).reason, 500);
  if (!reason) return c.json({ error: "Give a reason." }, 400);

  const rows = await c.get("db").query(
    `update job_requests set status = 'rejected', rejected_reason = $2,
            triaged_by = $3, triaged_at = now()
      where id = $1 and status = 'new' returning id::text`,
    [c.req.param("id"), reason, actor.profileId],
  );
  if (!rows.length) return c.json({ error: "No such pending request." }, 404);
  return c.json({ ok: true });
});
