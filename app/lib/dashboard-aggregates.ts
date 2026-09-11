/**
 * THE OVERVIEW'S NUMBERS, COUNTED IN THE DATABASE.
 *
 * Every figure the Overview prints used to be a `.filter()` in the browser over
 * the whole job list plus a 432 KB `/api/workspace` snapshot. That is why the
 * page had to hold every job in memory to draw a five-segment bar, why the
 * filter bar could only ever filter what had already been downloaded, and why
 * the same question got a different answer on two cards.
 *
 * These functions each issue ONE aggregate — `count(*)` and `sum(case when …)`
 * over an indexed predicate — and return a payload sized by the card rather
 * than by the estate. `SELECT *` on `maintenance_requests` appears nowhere.
 *
 * ── WHERE THE DAY ARITHMETIC HAPPENS ──────────────────────────────────────
 *
 * On the server, always, and never in the browser: a device clock and a device
 * timezone are not something a compliance figure may depend on. It happens in
 * THIS module rather than inside the SQL because `db/sqlite-to-postgres.ts`
 * refuses `julianday()` by name, and there is no expression that computes a day
 * difference in both dialects. So the boundaries are computed here from the
 * server instant and reach SQL as bare `YYYY-MM-DD` comparisons, which are
 * exact against both of the two timestamp formats this estate carries. See the
 * header of `dashboard-filters.ts`.
 *
 * ── EVERY BUCKET IS RETURNED, INCLUDING THE ZEROS ─────────────────────────
 *
 * `GROUP BY` returns no row for a value nothing matches, and a chart drawn
 * straight from that silently omits its empty buckets — which is how a time
 * series came to have a gap at the right-hand edge that nobody could explain.
 * Every function here projects its result onto the full bucket list before
 * returning, so a zero is a zero and an absence is impossible.
 */

import { and, count, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { getDb } from "../../db";
import { maintenanceRequests, sites } from "../../db/schema";
import {
  AGEING_BANDS,
  NOT_RECORDED_LABEL,
  PRIORITY_BANDS,
  UNASSIGNED_SITE_ID,
  UNASSIGNED_SITE_LABEL,
  categoricalColour,
  COMPLETED_STAGE,
  duePassed,
  completedStatuses,
  FAMILY_COLOUR,
  FAMILY_LABEL,
  JOB_STATUS_FAMILIES,
  NOT_RECORDED_COLOUR,
  normalisePriority,
  STATUS_FAMILY,
  statusFamily,
  statusKey,
  type AgeingBandKey,
  type JobStatusFamily,
  type PriorityKey,
} from "./job-metrics";
import {
  anyOfClauses,
  type DashboardFilters,
  daysBetweenDays,
  dayString,
  dimensionConditions,
  jobScopeCondition,
  jobScopeConditionForWindow,
  liveWorkOrderCondition,
  plannedCondition,
  reactiveCondition,
  NOT_RECORDED_KEY,
  type PeriodWindow,
  shiftDay,
  unassignedSiteCondition,
} from "./dashboard-filters";

type Database = Awaited<ReturnType<typeof getDb>>;

/** The closure test, as SQL, built from the one shared vocabulary. */
export const closedJobSql = sql`(${eq(maintenanceRequests.stage, COMPLETED_STAGE)} or lower(trim(${
  maintenanceRequests.status
})) in ${completedStatuses.map((label) => statusKey(label))})`;

const openJobSql = sql`not ${closedJobSql}`;

/** Urgent, by the same spellings `normalisePriority` recognises. */
const urgentSql = sql`lower(trim(${maintenanceRequests.priority})) in ${["urgent", "critical", "p1"]}`;

/**
 * A job with no site — the bucket that used to render as a blank row.
 *
 * Takes the organisation because "no site" has two shapes on this estate and
 * only one of them is a null: 80 of the development board's 111 live jobs point
 * at `site-unassigned`, an id with no row in `sites`. See
 * `unassignedSiteCondition` for why the dangling reference counts.
 */
const unassignedSiteSql = (orgId: string) => unassignedSiteCondition(orgId);

/**
 * PAST ITS TARGET DATE — the SQL twin of `duePassed` in `portal-app.tsx`.
 *
 * That function encodes a rule worth keeping and four tests pin it: a BARE
 * `YYYY-MM-DD` due date is not late until its day is over, while a due date
 * carrying a TIME is late the moment the instant passes. The distinction is not
 * pedantry — treating a bare date as UTC midnight marked every job due today as
 * overdue for anyone west of Greenwich, which is the comparison those tests
 * exist to keep out.
 *
 * Both branches here, chosen by `length()`, which SQLite and Postgres spell the
 * same way, over `dateText()` rather than the bare column — see there for why a
 * cast is not optional:
 *
 *   - ten characters or fewer -> a day; late once TODAY has moved past it;
 *   - longer -> an ISO instant; late once it is before NOW.
 *
 * Only OPEN jobs can be overdue. Finished work is not late, whatever its dates
 * say, and `isOverdue` in the browser has the same guard.
 */
/**
 * A DATE-ISH COLUMN AS ISO-COMPARABLE TEXT, ON EITHER DIALECT.
 *
 * This exists because the comment that used to sit below it was wrong, and the
 * wrongness was invisible until it reached the client. It said `due_at` is TEXT
 * in both dialects so no cast is involved. That is true of a database
 * `db/init.ts` created — it declares these columns TEXT, so Staging and every
 * local Miniflare file have them as `text`. Production predates that: its
 * `maintenance_requests.due_at` is a real Postgres `date`, and Postgres has no
 * `trim(date)`. The Overview answered "temporarily unavailable" for a day with
 * `function pg_catalog.btrim(date) does not exist` as the reason, and nothing
 * on Staging could ever have shown it.
 *
 * So every text operation these date columns receive goes through here first:
 *
 *   - `cast(… as text)` is identity on a text column, so SQLite behaviour and
 *     every existing pinned expectation are unchanged, and it is what turns a
 *     Postgres `date` into `YYYY-MM-DD` and a `timestamp` into
 *     `YYYY-MM-DD HH:MM:SS`;
 *   - the space becomes `T`, because a cast timestamp is otherwise compared
 *     against `toISOString()` output and ' ' sorts before 'T' — a job due later
 *     today would read as overdue;
 *   - `trim` still runs, because the importer wrote padded strings.
 *
 * `cast`, `trim` and `replace` are spelled identically by both dialects, so
 * this is one expression rather than a branch on which database is answering.
 */
export function dateText(column: TextColumn): SQL {
  return sql`replace(trim(cast(${column} as text)), ' ', 'T')`;
}

export function overdueOpenSql(now: Date): SQL {
  const today = dayString(now);
  const instant = now.toISOString();
  const raw = maintenanceRequests.dueAt;
  const due = dateText(raw);
  return sql`(${openJobSql} and ${raw} is not null and ${due} <> '' and ((length(${due}) <= 10 and substr(${due}, 1, 10) < ${today}) or (length(${due}) > 10 and ${due} < ${instant})))`;
}

/* ── Summary ──────────────────────────────────────────────────────────────── */

export type SummaryTotals = {
  inPeriod: number;
  open: number;
  closed: number;
  attention: number;
  urgentOpen: number;
  unassignedOpen: number;
};

export type DashboardSummary = {
  totals: SummaryTotals;
  /** Days the oldest OPEN job in scope has been open, or null when none are. */
  oldestOpenDays: number | null;
  oldestOpenId: string | null;
  /** The same six figures over the immediately preceding window, or null. */
  previous: SummaryTotals | null;
  /** Status labels met in this scope that `STATUS_FAMILY` cannot place. */
  unmappedStatuses: string[];
};

/**
 * Attention counted in SQL.
 *
 * The attention family is a list of status labels, so the predicate is an `IN`
 * over the normalised column built from `statusLabelsInFamily("attention")` —
 * the same array the browser buckets by. It is intersected with open, because a
 * completed job that still carries "Waiting for payment" is finished work, and
 * counting it as attention is how a worklist fills up with jobs nobody can act
 * on.
 */
function attentionSql(attentionKeys: string[]): SQL {
  if (!attentionKeys.length) return sql`0 = 1`;
  return sql`(${openJobSql} and lower(trim(${maintenanceRequests.status})) in ${attentionKeys})`;
}

function tallyRow(attentionKeys: string[], orgId: string) {
  return {
    inPeriod: count(),
    open: sql<number>`sum(case when ${openJobSql} then 1 else 0 end)`,
    attention: sql<number>`sum(case when ${attentionSql(attentionKeys)} then 1 else 0 end)`,
    urgentOpen: sql<number>`sum(case when ${openJobSql} and ${urgentSql} then 1 else 0 end)`,
    unassignedOpen: sql<number>`sum(case when ${openJobSql} and ${unassignedSiteSql(orgId)} then 1 else 0 end)`,
  };
}

function readTotals(
  row:
    | {
        inPeriod: number;
        open: number;
        attention: number;
        urgentOpen: number;
        unassignedOpen: number;
      }
    | undefined,
): SummaryTotals {
  const inPeriod = Number(row?.inPeriod ?? 0);
  const open = Number(row?.open ?? 0);
  return {
    inPeriod,
    open,
    closed: inPeriod - open,
    attention: Number(row?.attention ?? 0),
    urgentOpen: Number(row?.urgentOpen ?? 0),
    unassignedOpen: Number(row?.unassignedOpen ?? 0),
  };
}

export async function loadSummary(
  db: Database,
  orgId: string,
  filters: DashboardFilters,
  window: PeriodWindow,
  now: Date,
  attentionKeys: string[],
): Promise<DashboardSummary> {
  const scope = jobScopeCondition(orgId, filters, window);

  const [current, oldest, unmapped, previous] = await Promise.all([
    db.select(tallyRow(attentionKeys, orgId)).from(maintenanceRequests).where(scope),
    /*
     * The oldest OPEN job, as a date rather than a count of days. One row, two
     * columns; the days are worked out below from the same server instant every
     * other figure on the page uses, so the tile and the band colouring cannot
     * disagree about what "86 days" means.
     */
    db
      .select({ id: maintenanceRequests.id, raisedAt: maintenanceRequests.requestedAt })
      .from(maintenanceRequests)
      .where(and(scope, openJobSql))
      .orderBy(maintenanceRequests.requestedAt)
      .limit(1),
    /*
     * The distinct statuses in scope, so the page can NAME a status it cannot
     * place instead of silently folding it into "in progress". This is the
     * reporting half of the rule in `job-metrics.ts`; without it an operator
     * adding a label in monday would change what a chart means and nothing
     * would say so.
     */
    db
      .select({ status: maintenanceRequests.status })
      .from(maintenanceRequests)
      .where(scope)
      .groupBy(maintenanceRequests.status),
    window.previous
      ? db
          .select(tallyRow(attentionKeys, orgId))
          .from(maintenanceRequests)
          .where(
            jobScopeConditionForWindow(
              orgId,
              filters,
              window.previous.start,
              window.previous.endExclusive,
            ),
          )
      : Promise.resolve(null),
  ]);

  const today = dayString(now);
  const oldestRow = oldest[0];
  const raisedDay = (oldestRow?.raisedAt ?? "").slice(0, 10);

  return {
    totals: readTotals(current[0]),
    oldestOpenDays: raisedDay ? Math.max(0, daysBetweenDays(raisedDay, today)) : null,
    oldestOpenId: oldestRow?.id ?? null,
    previous: previous ? readTotals(previous[0]) : null,
    unmappedStatuses: unmapped
      .map((row) => (row.status ?? "").trim())
      .filter((label) => label && !isMappedStatus(label))
      .sort(),
  };
}

/**
 * Whether the family map really carries this label, asked of the MAP rather
 * than of `statusFamily`.
 *
 * `statusFamily` answers "in_progress" for a label it has never seen, which is
 * the right answer for a chart and the wrong one for this question: it makes an
 * unmapped status indistinguishable from a mapped in-progress one, and the
 * whole purpose of the list this feeds is to NAME the labels nobody has
 * placed.
 */
function isMappedStatus(label: string): boolean {
  return STATUS_FAMILY[statusKey(label)] !== undefined;
}

/* ── Ageing ───────────────────────────────────────────────────────────────── */

export type AgeingCount = {
  key: AgeingBandKey;
  label: string;
  colour: string;
  range: string;
  count: number;
};

/**
 * The four ageing bands as SQL, from day boundaries computed here.
 *
 * A band is "raised on or after day X", so the bounds are cumulative and the
 * `case` arms are ordered youngest first — the first arm that matches wins, and
 * a job raised today satisfies every one of them.
 */
export function ageingCaseSql(now: Date): SQL {
  const today = dayString(now);
  const arms: SQL[] = [];
  for (const band of AGEING_BANDS) {
    if (band.to === null) continue;
    const cutoff = shiftDay(today, -band.to);
    arms.push(sql`when ${maintenanceRequests.requestedAt} >= ${cutoff} then ${band.key}`);
  }
  const last = AGEING_BANDS[AGEING_BANDS.length - 1];
  return sql`case ${sql.join(arms, sql` `)} else ${last.key} end`;
}

export async function loadAgeing(
  db: Database,
  orgId: string,
  filters: DashboardFilters,
  window: PeriodWindow,
  now: Date,
): Promise<AgeingCount[]> {
  const rows = await db
    .select({
      band: sql<string>`${ageingCaseSql(now)}`.as("band"),
      total: count(),
    })
    .from(maintenanceRequests)
    .where(and(jobScopeCondition(orgId, filters, window), openJobSql))
    .groupBy(sql`band`);

  const byKey = new Map(rows.map((row) => [String(row.band), Number(row.total)]));
  return AGEING_BANDS.map((band) => ({
    key: band.key,
    label: band.label,
    colour: band.colour,
    range: band.range,
    count: byKey.get(band.key) ?? 0,
  }));
}

/* ── Sites needing attention ──────────────────────────────────────────────── */

export type AttentionJob = {
  id: string;
  reference: string | null;
  title: string;
  /**
   * Past its due date, decided on the SERVER with `duePassed`.
   *
   * Sent as a boolean rather than sent as a date for the browser to judge: a
   * device clock and a device timezone must not be what decides whether a job
   * is late, and the same rule has to hold for the count in the SLA panel — see
   * `overdueOpenSql`, which is this function's SQL twin.
   */
  overdue: boolean;
  priority: PriorityKey;
  priorityLabel: string;
  status: string;
  family: JobStatusFamily;
  daysOpen: number;
  band: AgeingBandKey;
};

export type AttentionSite = {
  siteId: string;
  siteName: string;
  unassigned: boolean;
  openCount: number;
  urgentCount: number;
  oldestDays: number;
  oldestBand: AgeingBandKey;
  /** One entry per open job, capped by the caller, for the priority dots. */
  priorities: PriorityKey[];
  jobs: AttentionJob[];
};

export const SITE_JOB_LIMIT = 10;
export const SITE_LIMIT = 12;

/**
 * Site rows with their ageing, urgency and top jobs, in two queries.
 *
 * Two rather than one per site: an aggregate over every open job grouped by
 * site, then the jobs themselves for the sites that survived the cap. The
 * per-site jobs are returned INLINE so expanding a row needs no second request
 * — a request per expansion is what made the old panel feel broken on a phone.
 */
export async function loadSitesAttention(
  db: Database,
  orgId: string,
  filters: DashboardFilters,
  window: PeriodWindow,
  now: Date,
  options: { siteLimit?: number; jobLimit?: number } = {},
): Promise<{ sites: AttentionSite[]; siteCount: number }> {
  const siteLimit = options.siteLimit ?? SITE_LIMIT;
  const jobLimit = options.jobLimit ?? SITE_JOB_LIMIT;
  const scope = and(jobScopeCondition(orgId, filters, window), openJobSql)!;
  const today = dayString(now);
  // One instant for the whole payload, so two jobs due in the same minute
  // cannot land on opposite sides of the overdue line.
  const nowMs = now.getTime();

  const [grouped, siteRows] = await Promise.all([
    db
      .select({
        siteId: maintenanceRequests.siteId,
        openCount: count(),
        urgentCount: sql<number>`sum(case when ${urgentSql} then 1 else 0 end)`,
        oldest: sql<string>`min(${maintenanceRequests.requestedAt})`,
      })
      .from(maintenanceRequests)
      .where(scope)
      .groupBy(maintenanceRequests.siteId),
    /*
     * Every site in the organisation, id and name only.
     *
     * Fetched whole rather than filtered to the ids the group-by returned,
     * because the question this answers is which of those ids the register
     * cannot vouch for. An `IN` over the ids would come back missing exactly
     * the rows that matter and leave the caller unable to tell "no such site"
     * from "a site I did not ask about". Two columns over a table this
     * organisation has tens of rows in.
     */
    db
      .select({ id: sites.id, name: sites.name })
      .from(sites)
      .where(eq(sites.organisationId, orgId)),
  ]);

  if (!grouped.length) return { sites: [], siteCount: 0 };

  const nameById = new Map(siteRows.map((row) => [row.id, row.name]));

  /*
   * A dangling `site_id` is folded into the unassigned bucket rather than
   * rendered under its own raw id.
   *
   * This is the fix for the row with no name. The largest cluster of open work
   * on the development board points at `site-unassigned`, which is not a site;
   * grouping by the raw column put it on screen as a row whose name resolved to
   * nothing. Folding by "does the register know this id" catches that shape and
   * the null one together, and it is why the sites are merged HERE rather than
   * in the `GROUP BY` — SQL cannot tell the difference without the join, and the
   * join would have to be an outer one on every dashboard query.
   */
  const merged = new Map<
    string,
    { siteId: string; openCount: number; urgentCount: number; oldestDay: string }
  >();
  for (const row of grouped) {
    const raw = (row.siteId ?? "").trim();
    const siteId = raw && nameById.has(raw) ? raw : UNASSIGNED_SITE_ID;
    const oldestDay = String(row.oldest ?? today).slice(0, 10);
    const current = merged.get(siteId);
    if (current) {
      current.openCount += Number(row.openCount);
      current.urgentCount += Number(row.urgentCount);
      if (oldestDay && oldestDay < current.oldestDay) current.oldestDay = oldestDay;
    } else {
      merged.set(siteId, {
        siteId,
        openCount: Number(row.openCount),
        urgentCount: Number(row.urgentCount),
        oldestDay: oldestDay || today,
      });
    }
  }

  const named = [...merged.values()]
    .map((row) => ({
      siteId: row.siteId,
      openCount: row.openCount,
      urgentCount: row.urgentCount,
      oldestDays: Math.max(0, daysBetweenDays(row.oldestDay, today)),
    }))
    /*
     * Oldest first, then busiest. The order is the card's headline claim: the
     * site with the job that has been waiting longest is the one somebody has
     * to answer for, and a site with more jobs but none of them old is a
     * workload rather than a failure.
     */
    .sort((left, right) => right.oldestDays - left.oldestDays || right.openCount - left.openCount);

  const page = named.slice(0, siteLimit);
  const realIds = page.map((row) => row.siteId).filter((id) => id !== UNASSIGNED_SITE_ID);
  const wantsUnassigned = page.some((row) => row.siteId === UNASSIGNED_SITE_ID);

  /*
   * The jobs for the sites on this page, oldest first, capped per site in the
   * loop below rather than in SQL. `LIMIT … PARTITION BY` is a window function;
   * `db/sqlite-to-postgres.ts` has no rule for one and the two dialects disagree
   * about the syntax, so the cap is applied where both behave the same. The
   * `WHERE` still restricts the read to at most twelve sites' open work.
   */
  const jobRows = realIds.length || wantsUnassigned
    ? await db
        .select({
          id: maintenanceRequests.id,
          reference: maintenanceRequests.reference,
          title: maintenanceRequests.title,
          siteId: maintenanceRequests.siteId,
          priority: maintenanceRequests.priority,
          status: maintenanceRequests.status,
          stage: maintenanceRequests.stage,
          raisedAt: maintenanceRequests.requestedAt,
          dueAt: maintenanceRequests.dueAt,
        })
        .from(maintenanceRequests)
        .where(
          and(
            scope,
            anyOfClauses(
              [
                realIds.length ? inArray(maintenanceRequests.siteId, realIds) : null,
                wantsUnassigned ? unassignedSiteSql(orgId) : null,
              ].filter((clause): clause is SQL => clause !== null),
            )!,
          ),
        )
        .orderBy(maintenanceRequests.requestedAt)
    : [];

  const jobsBySite = new Map<string, AttentionJob[]>();
  const prioritiesBySite = new Map<string, PriorityKey[]>();

  for (const row of jobRows) {
    const raw = (row.siteId ?? "").trim();
    const key = raw && nameById.has(raw) ? raw : UNASSIGNED_SITE_ID;
    const daysOpen = Math.max(0, daysBetweenDays(String(row.raisedAt ?? today).slice(0, 10), today));
    const priority = normalisePriority(row.priority);
    const priorities = prioritiesBySite.get(key) ?? [];
    priorities.push(priority);
    prioritiesBySite.set(key, priorities);

    const list = jobsBySite.get(key) ?? [];
    if (list.length < jobLimit) {
      list.push({
        id: row.id,
        reference: row.reference ?? null,
        title: row.title,
        overdue: duePassed(row.dueAt, nowMs),
        priority,
        priorityLabel:
          PRIORITY_BANDS.find((band) => band.key === priority)?.label ?? NOT_RECORDED_LABEL,
        status: (row.status ?? "").trim() || "No status",
        family: statusFamily(row.status, { warn: false }),
        daysOpen,
        band: bandKeyFor(daysOpen),
      });
    }
    jobsBySite.set(key, list);
  }

  return {
    siteCount: named.length,
    sites: page.map((row) => ({
      siteId: row.siteId,
      siteName:
        row.siteId === UNASSIGNED_SITE_ID
          ? UNASSIGNED_SITE_LABEL
          : nameById.get(row.siteId) ?? row.siteId,
      unassigned: row.siteId === UNASSIGNED_SITE_ID,
      openCount: row.openCount,
      urgentCount: row.urgentCount,
      oldestDays: row.oldestDays,
      oldestBand: bandKeyFor(row.oldestDays),
      priorities: prioritiesBySite.get(row.siteId) ?? [],
      jobs: jobsBySite.get(row.siteId) ?? [],
    })),
  };
}

function bandKeyFor(days: number): AgeingBandKey {
  for (const band of AGEING_BANDS) {
    if (band.to === null || days <= band.to) return band.key;
  }
  return AGEING_BANDS[AGEING_BANDS.length - 1].key;
}

/* ── Job breakdown ────────────────────────────────────────────────────────── */

export type BreakdownBucket = {
  key: string;
  label: string;
  value: number;
  colour: string;
  /** True for the grey bucket, which filters to the jobs missing the field. */
  notRecorded: boolean;
  /** For the two-level status meter only. */
  family?: JobStatusFamily;
};

export type BreakdownDimensionResult = {
  recorded: number;
  total: number;
  buckets: BreakdownBucket[];
};

/**
 * One dimension, counted with `GROUP BY` and then projected onto its buckets.
 *
 * `notRecorded` is appended LAST and always present when `recorded < total`,
 * which is the rule the brief states and the reason it matters here: on this
 * estate the missing values are the largest bucket in two of the five
 * dimensions, and a chart that omitted them reported a tidier board than
 * exists.
 */
type TextColumn = SQLiteColumn<{
  name: string;
  tableName: string;
  dataType: "string";
  columnType: "SQLiteText";
  data: string;
  driverParam: string;
  notNull: boolean;
  hasDefault: boolean;
  isPrimaryKey: boolean;
  isAutoincrement: boolean;
  hasRuntimeDefault: boolean;
  enumValues: [string, ...string[]] | undefined;
  baseColumn: never;
  identity: undefined;
  generated: undefined;
}>;

async function groupText(
  db: Database,
  where: SQL,
  column: TextColumn,
): Promise<Array<{ value: string; total: number }>> {
  const rows = await db
    .select({ value: column, total: count() })
    .from(maintenanceRequests)
    .where(where)
    .groupBy(column);
  return rows.map((row) => ({
    value: String((row as { value: string | null }).value ?? "").trim(),
    total: Number(row.total),
  }));
}

export async function loadBreakdown(
  db: Database,
  orgId: string,
  filters: DashboardFilters,
  window: PeriodWindow,
): Promise<{
  total: number;
  dimensions: Record<string, BreakdownDimensionResult>;
}> {
  const where = jobScopeCondition(orgId, filters, window);

  const [tierRows, engineerRows, priorityRows, labelRows, statusRows] = await Promise.all([
    db
      .select({ value: maintenanceRequests.tier, total: count() })
      .from(maintenanceRequests)
      .where(where)
      .groupBy(maintenanceRequests.tier),
    groupText(db, where, maintenanceRequests.engineer),
    groupText(db, where, maintenanceRequests.priority),
    groupText(db, where, maintenanceRequests.category),
    groupText(db, where, maintenanceRequests.status),
  ]);

  const total = statusRows.reduce((sum, row) => sum + row.total, 0);

  /* Tier — a number, so the grey arc completes the ring rather than sitting
     beside it. Zero and null are both "not recorded"; the importer wrote one
     and the form writes the other. */
  const tierBuckets: BreakdownBucket[] = [];
  let tierRecorded = 0;
  let tierMissing = 0;
  for (const row of tierRows) {
    const value = Number(row.value ?? 0);
    const amount = Number(row.total);
    if (!value) {
      tierMissing += amount;
      continue;
    }
    tierRecorded += amount;
    tierBuckets.push({
      key: String(value),
      label: `Tier ${value}`,
      value: amount,
      colour: categoricalColour(`tier-${value}`),
      notRecorded: false,
    });
  }
  tierBuckets.sort((left, right) => left.key.localeCompare(right.key, "en-GB"));
  appendNotRecorded(tierBuckets, tierMissing);

  /* Priority — an ordinal with a fixed order and fixed semantic colours, so it
     is a single stacked bar and never a pie. */
  const priorityTotals = new Map<PriorityKey, number>();
  for (const row of priorityRows) {
    const key = normalisePriority(row.value);
    priorityTotals.set(key, (priorityTotals.get(key) ?? 0) + row.total);
  }
  const priorityBuckets: BreakdownBucket[] = PRIORITY_BANDS.map((band) => ({
    key: band.key === "not_recorded" ? NOT_RECORDED_KEY : band.key,
    label: band.label,
    value: priorityTotals.get(band.key) ?? 0,
    colour: band.colour,
    notRecorded: band.key === "not_recorded",
  }));

  const statusBuckets: BreakdownBucket[] = statusRows
    .filter((row) => row.value)
    .map((row) => {
      const family = statusFamily(row.value, { warn: false });
      return {
        key: row.value,
        label: row.value,
        value: row.total,
        colour: FAMILY_COLOUR[family],
        notRecorded: false,
        family,
      };
    })
    .sort(
      (left, right) =>
        JOB_STATUS_FAMILIES.indexOf(left.family!) - JOB_STATUS_FAMILIES.indexOf(right.family!) ||
        right.value - left.value,
    );
  const statusMissing = statusRows
    .filter((row) => !row.value)
    .reduce((sum, row) => sum + row.total, 0);
  appendNotRecorded(statusBuckets, statusMissing);

  return {
    total,
    dimensions: {
      tier: { recorded: tierRecorded, total, buckets: tierBuckets },
      engineer: textDimension(engineerRows, total, "engineer"),
      priority: {
        recorded: total - (priorityTotals.get("not_recorded") ?? 0),
        total,
        buckets: priorityBuckets,
      },
      label: textDimension(labelRows, total, "label"),
      status: { recorded: total - statusMissing, total, buckets: statusBuckets },
    },
  };
}

function textDimension(
  rows: Array<{ value: string; total: number }>,
  total: number,
  namespace: string,
): BreakdownDimensionResult {
  let missing = 0;
  const buckets: BreakdownBucket[] = [];
  for (const row of rows) {
    if (!row.value || row.value === "[object Object]") {
      missing += row.total;
      continue;
    }
    buckets.push({
      key: row.value,
      label: row.value,
      value: row.total,
      colour: categoricalColour(`${namespace}:${row.value}`),
      notRecorded: false,
    });
  }
  buckets.sort((left, right) => right.value - left.value || left.label.localeCompare(right.label, "en-GB"));
  appendNotRecorded(buckets, missing);
  return { recorded: total - missing, total, buckets };
}

/**
 * The grey bucket, appended last and only when there is one.
 *
 * Zero is not appended: a dimension with full coverage should show a complete
 * chart, not a legend entry claiming nothing is missing.
 */
function appendNotRecorded(buckets: BreakdownBucket[], missing: number) {
  if (missing <= 0) return;
  buckets.push({
    key: NOT_RECORDED_KEY,
    label: NOT_RECORDED_LABEL,
    value: missing,
    colour: NOT_RECORDED_COLOUR,
    notRecorded: true,
  });
}

/* ── Performance ──────────────────────────────────────────────────────────── */

export type SlaPriorityRow = {
  key: PriorityKey;
  label: string;
  measured: number;
  met: number;
  percent: number | null;
};

export type SlaResult = {
  /** Closed jobs in scope. The denominator the coverage meter is honest about. */
  closed: number;
  /**
   * OPEN jobs already past their due date.
   *
   * The figure the Overview used to print as an "Overdue" tile. It moved here
   * rather than being dropped: a count of work that has already missed its
   * promise belongs beside the percentage that says how often promises are
   * kept, and nothing on this page may lose a number the previous one carried.
   */
  overdueOpen: number;
  /** Closed jobs that carry BOTH a target date and a completion date. */
  measured: number;
  met: number;
  percent: number | null;
  coveragePercent: number;
  /** Which column supplied the target, so the card can say so. */
  targetField: "target_completion_date" | "due_at" | null;
  averageCloseDays: number | null;
  byPriority: SlaPriorityRow[];
};

/**
 * SLA, led by its coverage.
 *
 * WHICH COLUMN IS "THE TARGET DATE". Two exist and they mean different things:
 * `target_completion_date` is the date somebody committed to, `due_at` is the
 * SLA deadline the board carries (see the schema note beside them). This
 * prefers the explicit commitment and falls back to the deadline, and it
 * RETURNS which one it used, because a percentage measured against a different
 * column is a different metric and the card has to be able to say so.
 *
 * Audit finding, reported rather than papered over: on both the development
 * estate and staging, `target_completion_date` is populated on ZERO rows, so
 * every measurement here comes from `due_at`. Coverage is what the card leads
 * with for exactly this reason.
 */
export async function loadSla(
  db: Database,
  orgId: string,
  filters: DashboardFilters,
  window: PeriodWindow,
  now: Date,
): Promise<SlaResult> {
  const scope = jobScopeCondition(orgId, filters, window);
  const where = and(scope, closedJobSql)!;
  const [overdueRow] = await db
    .select({ total: count() })
    .from(maintenanceRequests)
    .where(and(scope, overdueOpenSql(now)));
  const overdueOpen = Number(overdueRow?.total ?? 0);

  const target = maintenanceRequests.targetCompletionDate;
  const fallback = maintenanceRequests.dueAt;
  const completed = maintenanceRequests.completedAt;

  /* Through `dateText`: all three of these are dates, and two of the three are
     a Postgres `date` on Production, where `trim(date)` does not exist. */
  const has = (column: TextColumn) => sql`(${column} is not null and ${dateText(column)} <> '')`;

  const [row] = await db
    .select({
      closed: count(),
      withTarget: sql<number>`sum(case when ${has(target)} then 1 else 0 end)`,
      withFallback: sql<number>`sum(case when ${has(fallback)} then 1 else 0 end)`,
      withCompletion: sql<number>`sum(case when ${has(completed)} then 1 else 0 end)`,
    })
    .from(maintenanceRequests)
    .where(where);

  const closed = Number(row?.closed ?? 0);
  const targetField =
    Number(row?.withTarget ?? 0) > 0
      ? ("target_completion_date" as const)
      : Number(row?.withFallback ?? 0) > 0
        ? ("due_at" as const)
        : null;

  if (!targetField) {
    return {
      closed,
      overdueOpen,
      measured: 0,
      met: 0,
      percent: null,
      coveragePercent: 0,
      targetField: null,
      averageCloseDays: null,
      byPriority: PRIORITY_BANDS.map((band) => ({
        key: band.key,
        label: band.label,
        measured: 0,
        met: 0,
        percent: null,
      })),
    };
  }

  const targetColumn = targetField === "target_completion_date" ? target : fallback;

  /*
   * "Met" is a DATE comparison, on the first ten characters of both values.
   *
   * The two columns carry different shapes — a bare `YYYY-MM-DD` on one estate
   * and a full ISO timestamp on the other — so comparing them whole gets a job
   * closed at 09:00 on its due date wrong in one direction and a job closed at
   * 23:00 wrong in the other. An SLA is a day promise; substr(…,1,10) is what
   * makes both estates answer the same question. `substr` is the one string
   * function the dialects spell identically. Both go through `dateText` first:
   * these columns are TEXT on a database `db/init.ts` created and a Postgres
   * `date` on one that predates it, and `substr(date, ...)` no more exists
   * than `trim(date)` does.
   */
  const measurable = and(where, has(targetColumn), has(completed))!;
  const met = sql`substr(${dateText(completed)}, 1, 10) <= substr(${dateText(targetColumn)}, 1, 10)`;

  const [totals, byPriority] = await Promise.all([
    db
      .select({
        measured: count(),
        met: sql<number>`sum(case when ${met} then 1 else 0 end)`,
      })
      .from(maintenanceRequests)
      .where(measurable),
    db
      .select({
        priority: maintenanceRequests.priority,
        measured: count(),
        met: sql<number>`sum(case when ${met} then 1 else 0 end)`,
      })
      .from(maintenanceRequests)
      .where(measurable)
      .groupBy(maintenanceRequests.priority),
  ]);

  const measured = Number(totals[0]?.measured ?? 0);
  const metCount = Number(totals[0]?.met ?? 0);

  const perPriority = new Map<PriorityKey, { measured: number; met: number }>();
  for (const entry of byPriority) {
    const key = normalisePriority(entry.priority);
    const current = perPriority.get(key) ?? { measured: 0, met: 0 };
    current.measured += Number(entry.measured);
    current.met += Number(entry.met);
    perPriority.set(key, current);
  }

  return {
    closed,
    overdueOpen,
    measured,
    met: metCount,
    percent: measured ? Math.round((metCount / measured) * 100) : null,
    coveragePercent: closed ? Math.round((measured / closed) * 100) : 0,
    targetField,
    averageCloseDays: await averageCloseDays(db, measurable),
    byPriority: PRIORITY_BANDS.map((band) => {
      const entry = perPriority.get(band.key) ?? { measured: 0, met: 0 };
      return {
        key: band.key,
        label: band.label,
        measured: entry.measured,
        met: entry.met,
        percent: entry.measured ? Math.round((entry.met / entry.measured) * 100) : null,
      };
    }),
  };
}

/**
 * Mean days from raised to closed.
 *
 * Read as two date columns and subtracted here rather than in SQL, for the
 * reason in the module header: there is no day-difference expression both
 * dialects accept. Capped at 2000 rows, which is the SLA sample rather than the
 * board — the average of the measurable set is what the card claims.
 */
async function averageCloseDays(db: Database, where: SQL): Promise<number | null> {
  const rows = await db
    .select({
      raisedAt: maintenanceRequests.requestedAt,
      closedAt: maintenanceRequests.completedAt,
    })
    .from(maintenanceRequests)
    .where(where)
    .limit(2000);
  let sum = 0;
  let counted = 0;
  for (const row of rows) {
    const from = String(row.raisedAt ?? "").slice(0, 10);
    const to = String(row.closedAt ?? "").slice(0, 10);
    if (from.length !== 10 || to.length !== 10) continue;
    sum += Math.max(0, daysBetweenDays(from, to));
    counted += 1;
  }
  return counted ? Math.round((sum / counted) * 10) / 10 : null;
}

/* ── Reactive vs planned ──────────────────────────────────────────────────── */

export type TrendBucket = {
  label: string;
  start: string;
  endExclusive: string;
  /**
   * The last day IN the bucket. Sent because tapping a bucket now sets a custom
   * range, and `to` in this application's filters is inclusive while
   * `endExclusive` is not — computing that difference in the browser would put
   * the one piece of date arithmetic this module exists to centralise back on
   * the client, where the timezone is not the server's.
   */
  endInclusive: string;
  reactive: number;
  planned: number;
  /** True for a bucket whose window has not finished. Hatched, never blank. */
  partial: boolean;
};

/**
 * PLANNED AND REACTIVE ARE JOB TYPES, NOT A GUESS.
 *
 * The same rule `classifySpend` applies on the Reports page: the job's
 * canonical type, by its stable code — `planned`, `reactive`. It used to be an
 * inference from the category (compliance) or the tier (4 and above), with
 * "reactive" meaning "everything else"; the owner ruled that out, so a job
 * with no type, a Project or a custom type is in NEITHER stack rather than
 * being counted as reactive by elimination. Kept as SQL here so the buckets are
 * counted rather than downloaded, and named in one place so the pages cannot
 * disagree.
 */
/* The rule itself lives in `dashboard-filters`, because tapping the segment now
   filters by it and a second copy could drift from the one the chart drew. */
const plannedSql = plannedCondition;
const reactiveSql = reactiveCondition;

/**
 * Five buckets across the selected period, boundaries following the period
 * rather than a fixed 21 days.
 *
 * The trailing bucket is marked `partial` when its window runs past today. It
 * is the one that used to render as an unexplained gap at the right-hand edge:
 * a bar of zero height with no number, which reads as a charting failure rather
 * than as a period still in progress.
 */
export async function loadReactiveVsPlanned(
  db: Database,
  orgId: string,
  filters: DashboardFilters,
  window: PeriodWindow,
  now: Date,
  bucketCount = 5,
): Promise<{ buckets: TrendBucket[]; reactivePercent: number | null }> {
  const today = dayString(now);
  const end = window.endExclusive;
  const start = window.start ?? shiftDay(end, -365);
  const span = Math.max(bucketCount, daysBetweenDays(start, end));
  const size = Math.ceil(span / bucketCount);

  const bounds: Array<{ start: string; endExclusive: string }> = [];
  for (let index = 0; index < bucketCount; index += 1) {
    const from = shiftDay(start, index * size);
    const to = index === bucketCount - 1 ? end : shiftDay(start, (index + 1) * size);
    if (from >= to) continue;
    bounds.push({ start: from, endExclusive: to });
  }

  const selection: Record<string, SQL<number>> = {};
  bounds.forEach((bucket, index) => {
    const inBucket = sql`(${maintenanceRequests.requestedAt} >= ${bucket.start} and ${
      maintenanceRequests.requestedAt
    } < ${bucket.endExclusive})`;
    selection[`p${index}`] = sql<number>`sum(case when ${inBucket} and ${plannedSql} then 1 else 0 end)`;
    selection[`r${index}`] = sql<number>`sum(case when ${inBucket} and ${reactiveSql} then 1 else 0 end)`;
  });

  const [row] = bounds.length
    ? await db
        .select(selection)
        .from(maintenanceRequests)
        .where(jobScopeCondition(orgId, filters, window))
    : [undefined];

  let reactiveTotal = 0;
  let plannedTotal = 0;
  const buckets = bounds.map((bucket, index) => {
    const planned = Number(row?.[`p${index}`] ?? 0);
    const reactive = Number(row?.[`r${index}`] ?? 0);
    reactiveTotal += reactive;
    plannedTotal += planned;
    const endInclusive = shiftDay(bucket.endExclusive, -1);
    return {
      label: `${shortDay(bucket.start)}–${shortDay(endInclusive)}`,
      start: bucket.start,
      endExclusive: bucket.endExclusive,
      endInclusive,
      reactive,
      planned,
      partial: bucket.endExclusive > shiftDay(today, 1),
    };
  });

  const total = reactiveTotal + plannedTotal;
  return {
    buckets,
    reactivePercent: total ? Math.round((reactiveTotal / total) * 100) : null,
  };
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function shortDay(day: string): string {
  const [, month, date] = day.split("-");
  return `${Number(date)} ${MONTHS[Number(month) - 1] ?? ""}`.trim();
}

/* ── Cost ─────────────────────────────────────────────────────────────────── */

export type SiteSpendRow = {
  siteId: string;
  siteName: string;
  unassigned: boolean;
  spend: number;
  annualBudget: number | null;
  proRatedBudget: number | null;
  utilisation: number | null;
};

export type ContractorSpendRow = {
  key: string;
  name: string;
  spend: number;
  jobs: number;
  linked: boolean;
};

export type CostResult = {
  totalSpend: number;
  costedJobs: number;
  sites: SiteSpendRow[];
  unattributedSiteSpend: number;
  sitesWithoutBudget: number;
  periodDays: number;
  contractors: ContractorSpendRow[];
  contractorAttributed: number;
  contractorLinked: number;
};

/**
 * Cost per site, pro-rated, and cost per contractor with its coverage.
 *
 * PRO-RATING IS THE WHOLE POINT OF THE FIRST HALF. Comparing 90 days of spend
 * to an annual budget produced 223% against a site that was inside its budget,
 * and the card admitted it in its own subtitle rather than fixing it. The
 * annual figure is still returned so the Period/Annual toggle can show it.
 *
 * THE SECOND HALF LEADS WITH WHAT IT CANNOT SEE. `contractorAttributed` over
 * `totalSpend` is the coverage meter; `contractorLinked` is how much of that is
 * against an actual register record rather than a name somebody typed. Both are
 * returned because the difference between them is the finding.
 */
export async function loadCost(
  db: Database,
  orgId: string,
  filters: DashboardFilters,
  window: PeriodWindow,
): Promise<CostResult> {
  const where = jobScopeCondition(orgId, filters, window);
  const costed = sql`(${maintenanceRequests.cost} is not null and ${maintenanceRequests.cost} > 0)`;

  const [totals, bySite, byContractor, siteRows] = await Promise.all([
    db
      .select({
        total: sql<number>`coalesce(sum(${maintenanceRequests.cost}), 0)`,
        costedJobs: sql<number>`sum(case when ${costed} then 1 else 0 end)`,
        attributed: sql<number>`coalesce(sum(case when (${maintenanceRequests.contractorId} is not null or trim(coalesce(${maintenanceRequests.contractor}, '')) <> '') then ${maintenanceRequests.cost} else 0 end), 0)`,
        linked: sql<number>`coalesce(sum(case when ${maintenanceRequests.contractorId} is not null then ${maintenanceRequests.cost} else 0 end), 0)`,
      })
      .from(maintenanceRequests)
      .where(where),
    db
      .select({
        siteId: maintenanceRequests.siteId,
        spend: sql<number>`coalesce(sum(${maintenanceRequests.cost}), 0)`,
      })
      .from(maintenanceRequests)
      .where(and(where, costed))
      .groupBy(maintenanceRequests.siteId),
    db
      .select({
        contractorId: maintenanceRequests.contractorId,
        contractor: maintenanceRequests.contractor,
        spend: sql<number>`coalesce(sum(${maintenanceRequests.cost}), 0)`,
        jobs: count(),
      })
      .from(maintenanceRequests)
      .where(and(where, costed))
      .groupBy(maintenanceRequests.contractorId, maintenanceRequests.contractor),
    db
      .select({
        id: sites.id,
        name: sites.name,
        annualBudgetPence: sites.annualBudgetPence,
      })
      .from(sites)
      .where(eq(sites.organisationId, orgId)),
  ]);

  const budgetById = new Map(siteRows.map((row) => [row.id, row]));
  const proRate = window.days / 365;

  const siteSpend: SiteSpendRow[] = [];
  let unattributed = 0;
  for (const row of bySite) {
    const raw = (row.siteId ?? "").trim();
    const spend = Number(row.spend ?? 0);
    /*
     * Audit answer for "all spend sits on one site": it does not, and where a
     * cost cannot be placed it is shown as UNATTRIBUTED rather than assigned.
     * The test is "does the register know this id", which catches a dangling
     * reference as well as a null — a cost filed against `site-unassigned`
     * would otherwise have printed under a site with no name, which is exactly
     * how a figure comes to look like it belongs to somebody.
     */
    if (!raw || !budgetById.has(raw)) {
      unattributed += spend;
      continue;
    }
    const id = raw;
    const site = budgetById.get(id);
    const annual = site?.annualBudgetPence == null ? null : Number(site.annualBudgetPence) / 100;
    const proRated = annual === null ? null : Math.round(annual * proRate * 100) / 100;
    siteSpend.push({
      siteId: id,
      siteName: site?.name ?? id,
      unassigned: false,
      spend,
      annualBudget: annual,
      proRatedBudget: proRated,
      utilisation: proRated && proRated > 0 ? Math.round((spend / proRated) * 100) : null,
    });
  }
  if (unattributed > 0) {
    siteSpend.push({
      siteId: UNASSIGNED_SITE_ID,
      siteName: `${UNASSIGNED_SITE_LABEL} (unattributed)`,
      unassigned: true,
      spend: unattributed,
      annualBudget: null,
      proRatedBudget: null,
      utilisation: null,
    });
  }
  siteSpend.sort(
    (left, right) => (right.utilisation ?? -1) - (left.utilisation ?? -1) || right.spend - left.spend,
  );

  const contractorTotals = new Map<string, ContractorSpendRow>();
  for (const row of byContractor) {
    const id = row.contractorId ?? null;
    const name = (row.contractor ?? "").trim();
    if (!id && !name) continue;
    const key = id ?? `name:${name.toLowerCase()}`;
    const current = contractorTotals.get(key) ?? {
      key,
      name: name || id!,
      spend: 0,
      jobs: 0,
      linked: Boolean(id),
    };
    current.spend += Number(row.spend ?? 0);
    current.jobs += Number(row.jobs ?? 0);
    if (name && (!current.name || current.name === id)) current.name = name;
    contractorTotals.set(key, current);
  }

  return {
    totalSpend: Number(totals[0]?.total ?? 0),
    costedJobs: Number(totals[0]?.costedJobs ?? 0),
    sites: siteSpend,
    unattributedSiteSpend: unattributed,
    sitesWithoutBudget: siteRows.filter((row) => row.annualBudgetPence == null).length,
    periodDays: window.days,
    contractors: [...contractorTotals.values()].sort((left, right) => right.spend - left.spend),
    contractorAttributed: Number(totals[0]?.attributed ?? 0),
    contractorLinked: Number(totals[0]?.linked ?? 0),
  };
}

/* ── Filter options ───────────────────────────────────────────────────────── */

export type FilterOption = { value: string; label: string; count: number };

/**
 * The values each filter control offers, and how many jobs carry each.
 *
 * Counted over the WHOLE live estate rather than over the current filter, so a
 * reader can widen a filter as well as narrow it: a control that only ever
 * offered the values already on screen is a dead end.
 */
export async function loadFilterOptions(
  db: Database,
  orgId: string,
): Promise<{
  sites: FilterOption[];
  statuses: FilterOption[];
  engineers: FilterOption[];
  labels: FilterOption[];
  tiers: FilterOption[];
  contractors: FilterOption[];
}> {
  const where = liveWorkOrderCondition(orgId);

  const [siteRows, siteNames, statusRows, engineerRows, labelRows, tierRows, contractorRows] =
    await Promise.all([
    db
      .select({ siteId: maintenanceRequests.siteId, total: count() })
      .from(maintenanceRequests)
      .where(where)
      .groupBy(maintenanceRequests.siteId),
    db
      .select({ id: sites.id, name: sites.name })
      .from(sites)
      .where(eq(sites.organisationId, orgId)),
    groupText(db, where, maintenanceRequests.status),
    groupText(db, where, maintenanceRequests.engineer),
    groupText(db, where, maintenanceRequests.category),
    db
      .select({ value: maintenanceRequests.tier, total: count() })
      .from(maintenanceRequests)
      .where(where)
      .groupBy(maintenanceRequests.tier),
    /*
     * Keyed the way `loadCost` keys its buckets — the id when the job is linked
     * to a record, the typed name when it is not — so a tap on a contractor bar
     * produces a value this list can name in a chip.
     */
    db
      .select({
        contractorId: maintenanceRequests.contractorId,
        contractor: maintenanceRequests.contractor,
        total: count(),
      })
      .from(maintenanceRequests)
      .where(where)
      .groupBy(maintenanceRequests.contractorId, maintenanceRequests.contractor),
  ]);

  const nameById = new Map(siteNames.map((row) => [row.id, row.name]));
  const siteOptions: FilterOption[] = [];
  let unassigned = 0;
  for (const row of siteRows) {
    const id = (row.siteId ?? "").trim();
    /*
     * An id the register does not know is the unassigned bucket, not a site
     * whose name happens to be its id. `nameById.get(id) ?? id` was the line
     * that put `site-unassigned` in the filter list as though it were a store.
     */
    if (!id || !nameById.has(id)) {
      unassigned += Number(row.total);
      continue;
    }
    siteOptions.push({ value: id, label: nameById.get(id)!, count: Number(row.total) });
  }
  siteOptions.sort((left, right) => left.label.localeCompare(right.label, "en-GB"));
  if (unassigned > 0) {
    // Always LAST and always present when it is non-zero, so the control cannot
    // hide the bucket the page exists to surface.
    siteOptions.push({
      value: UNASSIGNED_SITE_ID,
      label: UNASSIGNED_SITE_LABEL,
      count: unassigned,
    });
  }

  const named = (rows: Array<{ value: string; total: number }>): FilterOption[] => {
    const options = rows
      .filter((row) => row.value && row.value !== "[object Object]")
      .map((row) => ({ value: row.value, label: row.value, count: row.total }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "en-GB"));
    const missing = rows
      .filter((row) => !row.value || row.value === "[object Object]")
      .reduce((sum, row) => sum + row.total, 0);
    if (missing > 0) {
      options.push({ value: NOT_RECORDED_KEY, label: NOT_RECORDED_LABEL, count: missing });
    }
    return options;
  };

  const tierOptions: FilterOption[] = [];
  let tierMissing = 0;
  for (const row of tierRows) {
    const value = Number(row.value ?? 0);
    if (!value) {
      tierMissing += Number(row.total);
      continue;
    }
    tierOptions.push({ value: String(value), label: `Tier ${value}`, count: Number(row.total) });
  }
  tierOptions.sort((left, right) => left.value.localeCompare(right.value, "en-GB"));
  if (tierMissing > 0) {
    tierOptions.push({ value: NOT_RECORDED_KEY, label: NOT_RECORDED_LABEL, count: tierMissing });
  }

  const contractorOptions = new Map<string, FilterOption>();
  for (const row of contractorRows) {
    const id = row.contractorId ?? null;
    const name = (row.contractor ?? "").trim();
    if (!id && !name) continue;
    const value = id ?? `name:${name.toLowerCase()}`;
    const current = contractorOptions.get(value) ?? {
      value,
      label: name || id!,
      count: 0,
    };
    if (name && current.label === id) current.label = name;
    current.count += Number(row.total);
    contractorOptions.set(value, current);
  }

  return {
    sites: siteOptions,
    contractors: [...contractorOptions.values()].sort(
      (left, right) => right.count - left.count || left.label.localeCompare(right.label, "en-GB"),
    ),
    statuses: named(statusRows).map((option) => ({
      ...option,
      label: option.value === NOT_RECORDED_KEY ? NOT_RECORDED_LABEL : option.label,
    })),
    engineers: named(engineerRows),
    labels: named(labelRows),
    tiers: tierOptions,
  };
}

/** The three family options, with their fixed words and colours. */
export const FAMILY_OPTIONS = JOB_STATUS_FAMILIES.map((family) => ({
  value: family,
  label: FAMILY_LABEL[family],
  colour: FAMILY_COLOUR[family],
}));

export { dimensionConditions, isNotNull, isNull };
