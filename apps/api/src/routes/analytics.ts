import { Hono } from "hono";
import type { Db } from "../../../../packages/db/src/client.ts";
import {
  canSeeMoney,
  scopeFor,
  siteScopeFor,
  withScope,
  type Actor,
} from "../lib/access.ts";
import { requireActor, type Env } from "../lib/middleware.ts";

/**
 * analytics — mounted at /analytics.
 *
 * WHO SEES WHAT. There is no role list on this router, and that is deliberate.
 * Every figure below is composed from `scopeFor()` or `siteScopeFor()`, so the
 * numbers a caller gets are aggregates of exactly the rows `GET /jobs` would
 * already hand them: staff see the portfolio, a client_admin sees their
 * organisation, a client_user their sites, a contractor only the jobs assigned
 * to them. The screen is offered to staff and client_admins — that decision
 * lives in the web app's nav — but a second role list here would be a copy of
 * the scope rules that can drift out of step with them, and the drift is
 * always discovered as a leak.
 *
 * MONEY. `canSeeMoney()` is false for contractors, so spend-bearing sections
 * are OMITTED for them rather than nulled — the same shape `GET /jobs` uses,
 * where a missing key means "you were never sent this" and a null would mean
 * "there is no figure". `GET /analytics/spend` refuses outright, because a
 * money endpoint that answers with no money is an endpoint that looks broken.
 *
 * ONE PREDICATE LIST per question, exactly as `GET /jobs` builds one for its
 * rows and its count. Where a section runs two statements — the buckets and
 * the list inside them, the counts and the windows — both are composed from
 * the same scope, or the summary and its detail describe different questions.
 */
export const analytics = new Hono<Env>();
analytics.use("*", requireActor);

/** The seven stages, in board order, so a stage with no jobs still has a bar. */
const STAGES = [
  "New",
  "Scheduling",
  "In Progress",
  "Quotes",
  "On Hold",
  "Payment",
  "Done",
] as const;

const PRIORITIES = ["Urgent", "Medium", "Low"] as const;

const COMPLIANCE_STATUSES = [
  "Valid",
  "Expiring",
  "Expired",
  "Missing",
  "Not required",
] as const;

/** Ageing bands for open work, youngest first. Ordered — the UI colours them so. */
const AGE_BUCKETS = [
  { label: "0–7 days", upperDays: 7 },
  { label: "8–14 days", upperDays: 14 },
  { label: "15–30 days", upperDays: 30 },
  { label: "31–60 days", upperDays: 60 },
  { label: "Over 60 days", upperDays: null },
] as const;

/** How many sites the spend table names before it rolls the rest into one row. */
const SPEND_SITE_LIMIT = 12;

/**
 * Money is integer pence, end to end.
 *
 * `sum(bigint)` is `numeric`, which postgres.js returns as a string and PGlite
 * as a number. Both go through here and come out an integer count of pence —
 * never a float, and never divided: turning pence into pounds is the UI's job,
 * once, at the point of display.
 */
const pence = (value: unknown): number => {
  const n = Math.round(Number(value ?? 0));
  return Number.isFinite(n) ? n : 0;
};

const count = (value: unknown): number => Number(value ?? 0);

/* ------------------------------------------------------------- job mix -- */

type Slice = { label: string; jobs: number };

async function jobMix(db: Db, actor: Actor) {
  const stageQuery = withScope(
    "select j.stage::text as label, count(*)::int as n from jobs j",
    [],
    scopeFor(actor, "j"),
  );
  const priorityQuery = withScope(
    // `Unset` rather than dropping the row: a job with no priority is a job
    // nobody has triaged, which is exactly the thing worth seeing.
    "select coalesce(j.priority::text, 'Unset') as label, count(*)::int as n from jobs j",
    [],
    scopeFor(actor, "j"),
  );

  const [stageRows, priorityRows] = await Promise.all([
    db.query<{ label: string; n: number }>(
      `${stageQuery.sql} group by 1`,
      stageQuery.params,
    ),
    db.query<{ label: string; n: number }>(
      `${priorityQuery.sql} group by 1`,
      priorityQuery.params,
    ),
  ]);

  const found = new Map(stageRows.map((row) => [row.label, count(row.n)]));
  /*
   * Zeros filled from the fixed list rather than returned as whatever the
   * GROUP BY happened to produce. An absent stage and an empty stage look
   * identical to a reader once the bar is missing, and this product has
   * already shipped a board where a column that should not have been empty
   * was indistinguishable from one that correctly was.
   */
  const byStage: Slice[] = STAGES.map((stage) => ({
    label: stage,
    jobs: found.get(stage) ?? 0,
  }));

  const priorities = new Map(priorityRows.map((row) => [row.label, count(row.n)]));
  const byPriority: Slice[] = PRIORITIES.map((priority) => ({
    label: priority,
    jobs: priorities.get(priority) ?? 0,
  }));
  if (priorities.get("Unset")) {
    byPriority.push({ label: "Unset", jobs: priorities.get("Unset") ?? 0 });
  }

  const total = byStage.reduce((sum, slice) => sum + slice.jobs, 0);
  const done = byStage.find((slice) => slice.label === "Done")?.jobs ?? 0;

  return { byStage, byPriority, total, open: total - done, completed: done };
}

/* ---------------------------------------------------------- spend by site -- */

/** The six month buckets, newest last, named by the database's own clock. */
async function spendMonths(db: Db): Promise<string[]> {
  const rows = await db.query<{ month: string }>(
    `select to_char(m, 'YYYY-MM') as month
       from generate_series(
              date_trunc('month', now()) - interval '5 months',
              date_trunc('month', now()),
              interval '1 month') m
      order by m`,
  );
  return rows.map((row) => row.month);
}

async function spendBySite(db: Db, actor: Actor) {
  /*
   * Attributed to `date_requested`, not `date_completed`.
   *
   * Half the spend on a board belongs to work still in flight, which has no
   * completion date at all — attributing on completion would drop live cost
   * out of the chart entirely and show a portfolio spending less than it is.
   * The month a job was raised is also the month the client's board shows it
   * in, so the two agree.
   */
  const scoped = withScope(
    /*
     * Grouped by site ID, not site name.
     *
     * `group by s.name` merged every site that shares a name — and 19 names are
     * duplicated between the demo organisation and the real one, so one row of
     * the owner's spend table was two organisations' money added together. The
     * name is still selected for display; it is no longer what defines a row.
     * The same code merges two REAL clients the first time two of them have a
     * store in the same shopping centre, which is not unlikely.
     */
    `select coalesce(s.id::text, 'unassigned') as site_key,
            coalesce(s.name, 'Unassigned') as site_name,
            to_char(date_trunc('month', j.date_requested), 'YYYY-MM') as month,
            sum(j.cost_of_works_pence)::bigint as pence
       from jobs j
       left join sites s on s.id = j.site_id
      where j.cost_of_works_pence is not null
        and j.date_requested >= date_trunc('month', now()) - interval '5 months'`,
    [],
    scopeFor(actor, "j"),
  );

  const [months, rows] = await Promise.all([
    spendMonths(db),
    db.query<{ site_key: string; site_name: string; month: string; pence: unknown }>(
      // 1,2,3 = site_key, site_name, month. Named rather than positional would
      // be safer still, but the scoped SQL is assembled as text; the important
      // part is that adding a column shifts these numbers, so they move with it.
      `${scoped.sql} group by 1, 2, 3`,
      scoped.params,
    ),
  ]);

  const index = new Map(months.map((month, position) => [month, position]));
  const bySite = new Map<string, number[]>();
  const siteNames = new Map<string, string>();

  for (const row of rows) {
    const position = index.get(row.month);
    // A month outside the window cannot happen given the WHERE, but a row that
    // did fall outside must not silently land in January's column.
    if (position === undefined) continue;
    // Keyed by site id; the display name rides along. Two stores with the same
    // name in different organisations are two rows, as they must be.
    const monthly = bySite.get(row.site_key) ?? months.map(() => 0);
    monthly[position] += pence(row.pence);
    bySite.set(row.site_key, monthly);
    siteNames.set(row.site_key, row.site_name);
  }

  const all = [...bySite.entries()]
    .map(([siteKey, monthly]) => ({
      siteName: siteNames.get(siteKey) ?? "Unassigned",
      monthly,
      totalPence: monthly.reduce((sum, value) => sum + value, 0),
    }))
    .sort((a, b) => b.totalPence - a.totalPence);

  /*
   * The long tail is rolled up, not cut off.
   *
   * A portfolio can hold hundreds of stores and a table of hundreds of rows is
   * not a chart. Truncating alone would leave a table whose rows do not add up
   * to its own total — the same defect as a board reading "250 jobs" when there
   * are 744 — so the remainder is kept as one named row and the columns still
   * sum to the portfolio.
   */
  const named = all.slice(0, SPEND_SITE_LIMIT);
  const rest = all.slice(SPEND_SITE_LIMIT);
  if (rest.length) {
    named.push({
      siteName: `Other sites (${rest.length})`,
      monthly: months.map((_, position) =>
        rest.reduce((sum, site) => sum + site.monthly[position], 0),
      ),
      totalPence: rest.reduce((sum, site) => sum + site.totalPence, 0),
    });
  }

  const monthlyTotals = months.map((_, position) =>
    all.reduce((sum, site) => sum + site.monthly[position], 0),
  );

  return {
    months,
    sites: named,
    /*
     * How many SITES the spend covers — not how many rows the table has.
     *
     * `sites.length` is the row count, and the last row is the "Other sites
     * (n)" rollup, so the screen read "Across 13 sites" while the money
     * actually spanned 23. Returned from here rather than counted in the UI,
     * because only this function knows what the rollup stands for.
     */
    siteCount: all.length,
    monthlyTotals,
    totalPence: monthlyTotals.reduce((sum, value) => sum + value, 0),
  };
}

/* ---------------------------------------------------------------- ageing -- */

async function ageing(db: Db, actor: Actor) {
  const bucketCase = AGE_BUCKETS.map((bucket, position) =>
    bucket.upperDays === null
      ? `else ${position}`
      : `when j.date_requested > now() - interval '${bucket.upperDays} days' then ${position}`,
  ).join("\n        ");

  // Open work only. A job that finished 400 days after it was raised is a
  // fact about the past; ageing is about what is still waiting today.
  const inner = withScope(
    `select case
        ${bucketCase}
      end as bucket
       from jobs j
      where j.stage <> 'Done'`,
    [],
    scopeFor(actor, "j"),
  );

  const oldest = withScope(
    `select j.id::text, j.reference, j.title, j.status::text as status,
            j.stage::text as stage, j.priority::text as priority,
            coalesce(s.name, '—') as site_name,
            j.date_requested::text as date_requested,
            (extract(epoch from now() - j.date_requested) / 86400)::int as age_days
       from jobs j
       left join sites s on s.id = j.site_id
      where j.stage <> 'Done'`,
    [],
    scopeFor(actor, "j"),
  );

  const [bucketRows, waiting] = await Promise.all([
    db.query<{ bucket: number; n: number }>(
      `select bucket, count(*)::int as n from (${inner.sql}) b group by bucket`,
      inner.params,
    ),
    db.query(
      `${oldest.sql} order by j.date_requested asc limit 8`,
      oldest.params,
    ),
  ]);

  const found = new Map(bucketRows.map((row) => [Number(row.bucket), count(row.n)]));
  return {
    buckets: AGE_BUCKETS.map((bucket, position) => ({
      label: bucket.label,
      jobs: found.get(position) ?? 0,
    })),
    waitingLongest: waiting,
  };
}

/* ------------------------------------------------------------ compliance -- */

/*
 * Compliance status is COMPUTED, never read out of the stored column.
 *
 * `compliance_documents.status` is a snapshot maintained by a trigger, and a
 * snapshot of a date-relative fact rots: nothing writes to a row on the morning
 * its certificate expires, so a register read from that column reports as
 * "Expiring" something that lapsed a month ago. `compliance_status_for` — added
 * by migration 0009 and used by the compliance screen itself — is the rule, and
 * this asks it with today's date so the two screens cannot disagree about how
 * many certificates are out of date.
 */
const LIVE_STATUS = `compliance_status_for(
        d.not_required, r.expires, d.attachment_id is not null,
        d.expiry_date, current_date)::text`;

async function compliance(db: Db, actor: Actor) {
  /*
   * Scoped through `sites`, not through `jobs`.
   *
   * A certificate belongs to a store, so `siteScopeFor` is the predicate that
   * applies — and it denies contractors outright, which is right: a contractor
   * has no business reading a client's compliance register. They get zeros,
   * from `where false`, rather than a special case written here.
   */
  /*
   * The requirement CATALOGUE crossed with the sites — not the documents table.
   *
   * This counted rows in `compliance_documents`, which meant a requirement
   * nobody has filed a certificate for was invisible. With an empty documents
   * table the panel reported `Valid 0, Expiring 0, Expired 0, Missing 0` and
   * the screen read "Certificates expired: 0" — which a reader takes as "all
   * clear" — while `/compliance` correctly reported 516 of 516 missing and a
   * score of 0%. The denominator was the numerator, so the figure was
   * structurally incapable of being anything but zeros.
   *
   * `/compliance` builds the same matrix with a CROSS JOIN, and this now
   * mirrors it exactly: every active requirement, at every visible site, with
   * the document if one exists. `s.active` and `r.active` are filtered here
   * too — the register filters both, and counting a closed store on one screen
   * and not the other is the same disagreement in a smaller form.
   */
  const byStatus = withScope(
    `select ${LIVE_STATUS} as label, count(*)::int as n
       from sites s
       cross join compliance_requirements r
       left join compliance_documents d
              on d.site_id = s.id and d.kind = r.kind
      where s.active and r.active`,
    [],
    siteScopeFor(actor, "s"),
  );

  /*
   * The windows are CUMULATIVE: `within60` includes everything in `within30`.
   * That is how "what expires in the next 60 days" is asked out loud, and the
   * screen labels them the same way. Anything already expired is counted
   * separately — it is not "due", it is late.
   */
  /*
   * Joined to the catalogue so a requirement that never expires is not counted
   * as expired.
   *
   * Three of the twelve certificates carry no expiry by design (RAMS, the fire
   * risk assessment, the store drawing). Without this join a stale
   * `expiry_date` on one of them was reported as expired here while
   * `compliance_status_for` — which knows the requirement does not expire —
   * called it Valid. Two counters, same row, opposite answers.
   */
  const windows = withScope(
    `select
        count(*) filter (where d.expiry_date < current_date)::int as expired,
        count(*) filter (where d.expiry_date >= current_date
                           and d.expiry_date <= current_date + 30)::int as within30,
        count(*) filter (where d.expiry_date >= current_date
                           and d.expiry_date <= current_date + 60)::int as within60,
        count(*) filter (where d.expiry_date >= current_date
                           and d.expiry_date <= current_date + 90)::int as within90
       from compliance_documents d
       join sites s on s.id = d.site_id
       join compliance_requirements r on r.kind = d.kind and r.expires
      where not d.not_required and d.expiry_date is not null and s.active`,
    [],
    siteScopeFor(actor, "s"),
  );

  const soonest = withScope(
    `select d.id::text, coalesce(r.label, d.kind) as kind, ${LIVE_STATUS} as status,
            s.name as site_name, d.expiry_date::text as expiry_date,
            (d.expiry_date - current_date)::int as days_left
       from compliance_documents d
       join sites s on s.id = d.site_id
       join compliance_requirements r on r.kind = d.kind
      where not d.not_required and d.expiry_date is not null`,
    [],
    siteScopeFor(actor, "s"),
  );

  const [statusRows, [windowRow], due] = await Promise.all([
    db.query<{ label: string; n: number }>(
      `${byStatus.sql} group by 1`,
      byStatus.params,
    ),
    db.query<Record<string, unknown>>(windows.sql, windows.params),
    db.query(`${soonest.sql} order by d.expiry_date asc limit 8`, soonest.params),
  ]);

  const found = new Map(statusRows.map((row) => [row.label, count(row.n)]));
  return {
    byStatus: COMPLIANCE_STATUSES.map((status) => ({
      label: status,
      documents: found.get(status) ?? 0,
    })),
    expired: count(windowRow?.expired),
    dueWithin: {
      days30: count(windowRow?.within30),
      days60: count(windowRow?.within60),
      days90: count(windowRow?.within90),
    },
    soonest: due,
  };
}

/* ------------------------------------------------ contractor scorecard -- */

async function contractors(db: Db, actor: Actor) {
  const money = canSeeMoney(actor);

  /*
   * An INNER join to `contractors`: a job with nobody assigned belongs on the
   * ageing chart, not on a scorecard of who did the work.
   *
   * Spend is summed over every scoped job for that contractor, completed or
   * not, because committed cost is committed whether or not the shutter is
   * back on its runners yet. The completed count is separate so the two are
   * never mistaken for one figure.
   */
  const scoped = withScope(
    `select c.id::text as id, c.name,
            count(*)::int as jobs,
            count(*) filter (where j.stage = 'Done')::int as completed
            ${money ? ", coalesce(sum(j.cost_of_works_pence), 0)::bigint as spend" : ""}
       from jobs j
       join contractors c on c.id = j.contractor_id`,
    [],
    scopeFor(actor, "j"),
  );

  const rows = await db.query<Record<string, unknown>>(
    `${scoped.sql} group by c.id, c.name
      order by completed desc, jobs desc, c.name asc limit 20`,
    scoped.params,
  );

  return {
    rows: rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      jobs: count(row.jobs),
      completed: count(row.completed),
      // Absent, not null, when the caller may not see money — see the header.
      ...(money ? { spendPence: pence(row.spend) } : {}),
    })),
  };
}

/* ---------------------------------------------------------------- routes -- */

/** Everything the analytics screen draws, in one round trip. */
analytics.get("/overview", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  const money = canSeeMoney(actor);

  const [jobs, age, docs, contractorRows, spend] = await Promise.all([
    jobMix(db, actor),
    ageing(db, actor),
    compliance(db, actor),
    contractors(db, actor),
    money ? spendBySite(db, actor) : Promise.resolve(null),
  ]);

  return c.json({
    // Stated, not inferred from the absence of a key: a screen that must say
    // "spend is not shown to your role" needs to know the difference between
    // "no money for you" and "no money spent".
    money,
    generatedAt: new Date().toISOString(),
    jobs,
    ageing: age,
    compliance: docs,
    contractors: contractorRows,
    ...(spend ? { spend } : {}),
  });
});

analytics.get("/jobs", async (c) =>
  c.json(await jobMix(c.get("db"), c.get("actor"))),
);

analytics.get("/spend", async (c) => {
  const actor = c.get("actor");
  if (!canSeeMoney(actor)) {
    return c.json({ error: "Spend figures are not shown to your role." }, 403);
  }
  return c.json(await spendBySite(c.get("db"), actor));
});

analytics.get("/ageing", async (c) =>
  c.json(await ageing(c.get("db"), c.get("actor"))),
);

analytics.get("/compliance", async (c) =>
  c.json(await compliance(c.get("db"), c.get("actor"))),
);

analytics.get("/contractors", async (c) =>
  c.json(await contractors(c.get("db"), c.get("actor"))),
);
