/**
 * THE DASHBOARD BLOCK'S ONE SOURCE OF TRUTH.
 *
 * Every number on `.ov-dash` — six KPIs, the status donut, the SLA
 * speedometer, the priority rings, the category rings, the compliance gauge
 * and the spend trend — is computed HERE, in one pass, from one server
 * instant. No widget counts anything of its own.
 *
 * That is not tidiness. The page this block sits on top of already carries a
 * second set of figures about the same estate, and the only thing keeping the
 * two from contradicting each other in front of a reader is that each set is
 * internally consistent and says which question it answered. A widget that
 * derived its own subtotal would break that on the first rounding difference.
 *
 * ── WHAT IS REUSED RATHER THAN REDEFINED ──────────────────────────────────
 *
 * Every definition below already existed somewhere in this product, and the
 * brief's own instruction was to reuse it and say so:
 *
 *   · open / closed comes from `job_status_map.counts_as_open`, the
 *     configurable category, not from a hardcoded status list;
 *   · overdue is `overdueOpenSql`, the same expression the Jobs board and the
 *     ageing card use;
 *   · a job counts as work at all through `liveWorkOrderCondition` — not
 *     binned, not archived, not a sub-item, and not a row that lives on
 *     another board (a Store Documentation store is not a job);
 *   · priority folds through `normalisePriority`, the one classifier;
 *   · compliance is `readComplianceRegister` + `complianceCompletion`, which
 *     the Compliance page and the nightly digest already share.
 *
 * The compliance one is worth stating plainly because the figure surprises.
 * `complianceCompletion` EXCLUDES "Not required" from its denominator, and its
 * own comment records that an earlier brief asked for the other arrangement
 * and it was refused because it inflates: on this estate 449 of 748 register
 * rows are marked not required, so counting them as satisfied would score the
 * portfolio near 70% where the shipped rule scores it near 25%. The gauge
 * therefore reads low, and it reads the same as the Compliance page and the
 * digest, which is the point.
 *
 * ── THE DIALECT RULES ARE THE SAME AS EVERYWHERE ELSE ─────────────────────
 *
 * No `julianday`, `strftime`, `unixepoch`, `json_extract`, `printf`, `GLOB` or
 * `rowid`; no window functions. Day arithmetic happens in JS from `now` and
 * reaches SQL as a bare `YYYY-MM-DD`. Every date-ish column is cast through
 * `dateText` before any text operation touches it, because `due_at` and
 * `completed_at` are real Postgres `date` columns on Production and `text` on
 * Staging — see `app/lib/dashboard-aggregates.ts` for the outage that rule
 * exists to prevent.
 */

import { and, count, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import type { getDb } from "../../db";
import {
  jobStatusMap,
  maintenanceRequests,
  siteGroupMembers,
  siteGroups,
  units,
} from "../../db/schema";
import { closedJobSql, dateText, overdueOpenSql } from "./dashboard-aggregates";
import { dayString, liveWorkOrderCondition, shiftDay } from "./dashboard-filters";
import { drillSiteIds, normalisePriority } from "./job-metrics";
import { complianceCompletion } from "./compliance-status";
import { readComplianceRegister } from "./compliance-register";
import {
  AGING_THRESHOLD_DAYS,
  BREACH_WINDOW_HOURS,
  buildJobIntel,
  closuresFrom,
  isCalendarDay,
} from "./overview-intel";
import type { OiIntel } from "./overview-intel-contract";

type Database = Awaited<ReturnType<typeof getDb>>;

/**
 * The first ten characters of a date-ish column: `YYYY-MM-DD`, both dialects.
 * Exported so the Reports block buckets days with the identical expression.
 */
export function dayOnly(column: Parameters<typeof dateText>[0]): SQL {
  return sql`substr(${dateText(column)}, 1, 10)`;
}

/* ── The wire shape ───────────────────────────────────────────────────────── */

export type OvSlice = {
  key: string;
  label: string;
  value: number;
  colour: string;
  /*
   * THE VALUES THIS SLICE ACTUALLY STANDS FOR, so its drill-through opens the
   * rows it counted rather than the rows sharing its name.
   *
   * A grouped bucket is the reason this exists. "Other" on the category ring
   * can be a dozen small labels folded together, and a link that sent
   * `label=Other` would open one of them — or, on this estate, would open the
   * unrelated category a reader has literally named "Other". The board's
   * filter takes a pipe-joined list, so the slice carries the list.
   */
  labels: string[];
};

export type OvSpark = { day: string; value: number }[];

export type OvKpi = {
  key: "activeUnits" | "attention" | "openJobs" | "overdue" | "completed" | "compliance";
  label: string;
  value: number;
  /** Rendered with a `%` when true. */
  isPercent: boolean;
  /**
   * NULL WHERE HISTORY DOES NOT EXIST, and that is deliberate.
   *
   * Open jobs, Overdue and Completed can be reconstructed for any past day
   * from the dates the rows already carry. Active units and Compliance cannot:
   * nothing records what either was last Tuesday, and there is no snapshot
   * table. A flat line drawn from today's value would be an invention, so
   * those two carry `null` and the card draws no sparkline at all.
   */
  spark: OvSpark | null;
};

export type OvMetrics = {
  /** Echoed so a card states the window it was counted over, not the one asked for. */
  range: { from: string; to: string; label: string };
  /*
   * THE CHOSEN PORTFOLIO, AND THE SITES IT IS MADE OF.
   *
   * `siteIds` is here so a drill-through can carry the portfolio across to the
   * board. A portfolio is a `site_groups` row and the board's filter speaks
   * `site=`, so a link that sent only the group id would narrow nothing: the
   * reader taps a figure counted over eleven stores and opens a board showing
   * the whole estate. Empty array means "every site" — the same shape the
   * scope check uses — and it is empty for "All portfolios" too, where there
   * is nothing to narrow.
   */
  portfolio: { id: string; name: string; siteIds: string[] };
  portfolios: { id: string; name: string }[];
  kpis: OvKpi[];
  jobsByStatus: OvSlice[];
  sla: { percent: number; open: number; overdue: number; withinSla: number };
  priority: OvSlice[];
  categories: OvSlice[];
  compliance: {
    percent: number;
    satisfied: number;
    applicable: number;
    notRequired: number;
    scored: boolean;
  };
  spend: { month: string; label: string; pence: number }[];
  openJobs: number;
  /*
   * THE SITES BEHIND "Requiring attention", so its tile can open exactly them.
   *
   * The figure is a count of DISTINCT SITES with at least one open job that is
   * high or medium priority, or overdue — so no jobs filter can reproduce it,
   * and a link to the unfiltered register would show the whole estate under a
   * figure of seven. The register learned a `sites=` filter for this; these are
   * the ids it takes.
   */
  attentionSiteIds: string[];
  /** The Overview's "Job Intelligence" section — see `overview-intel.ts`. */
  intel: OiIntel;
};

/* ── Colour ───────────────────────────────────────────────────────────────── */

/**
 * The block's own palette, as the brief specifies it.
 *
 * These are the `--ov-*` accents, restated here because a SERVER cannot read a
 * stylesheet and the widgets are drawn from data — an arc's colour travels
 * with its slice. The names are the brief's; the values are the brief's.
 */
export const OV_COLOURS = {
  teal: "#46A2AD",
  orange: "#D8652B",
  amber: "#E3A140",
  blue: "#5A7293",
  green: "#5E946E",
  red: "#D34E49",
  grey: "#5E697E",
} as const;

/** "Default colour order: teal, orange, amber, blue, green, grey." */
const SERIES_ORDER = [
  OV_COLOURS.teal,
  OV_COLOURS.orange,
  OV_COLOURS.amber,
  OV_COLOURS.blue,
  OV_COLOURS.green,
  OV_COLOURS.grey,
] as const;

const PRIORITY_COLOUR: Record<string, string> = {
  urgent: OV_COLOURS.red,
  medium: OV_COLOURS.amber,
  low: OV_COLOURS.grey,
  not_recorded: OV_COLOURS.grey,
};

const PRIORITY_LABEL: Record<string, string> = {
  urgent: "High",
  medium: "Medium",
  low: "Low",
  not_recorded: "Unset",
};

/* ── Scope ────────────────────────────────────────────────────────────────── */

/**
 * The rows that count as work at all, plus the portfolio.
 *
 * `liveWorkOrderCondition` ITSELF, extended with the portfolio. This used to
 * restate its three exclusions through the same columns, on the belief that
 * drizzle could not extend an `and()` after the fact — it can, by nesting it —
 * and the restatement is exactly how a fourth exclusion gets added in one place
 * and missed in the other. The fourth one arrived: a row placed on another
 * board (a Store Documentation store, a section's row) is not a job, and it is
 * `jobsBoardCondition` that says so. See that function for the "98 open jobs
 * over a board drawing 82" defect it ends.
 *
 * Exported because the Reports block counts the same jobs and must count them
 * the same way — one scope, two dashboards.
 */
export function dashboardJobScope(orgId: string, siteIds: readonly string[] | null): SQL {
  const base = liveWorkOrderCondition(orgId);
  if (!siteIds) return base;
  /* An empty portfolio matches nothing rather than everything — the same trap
     `confineToSiteScope` documents on the dashboard routes. */
  if (siteIds.length === 0) return and(base, sql`1 = 0`)!;
  return and(base, inArray(maintenanceRequests.siteId, [...siteIds]))!;
}

/* ── Portfolios, shared by the three blocks ───────────────────────────────── */

export type DashboardPortfolio = {
  portfolios: { id: string; name: string }[];
  chosen: { id: string; name: string } | null;
  /** The chosen portfolio's member sites; null for "All portfolios". */
  siteIds: string[] | null;
};

/**
 * THE PORTFOLIO FILTER, resolved once, for every block that offers it.
 *
 * A portfolio is an active `site_groups` row and its members. An id this
 * organisation does not hold resolves to "All portfolios" rather than to an
 * error — every read here is already scoped to `orgId`, so a foreign id in the
 * query string cannot reach another tenant's sites; it simply matches nothing
 * and is ignored.
 */
export async function resolveDashboardPortfolio(
  db: Database,
  orgId: string,
  wantedId: string | null | undefined,
  /**
   * THE MEMBERSHIP'S SITE RESTRICTION — `guard.scope.siteScope`.
   *
   * Every `/api/dashboard/*` route folds it into its site filter through
   * `confineToSiteScope`; the dashboard block's endpoint did not, so a member
   * confined to three stores read estate-wide totals off the top of the page —
   * aggregate leakage, which is leakage. Applied HERE, where all three blocks
   * resolve their portfolio, so no block can forget it: the sites a block counts
   * are the portfolio's members INTERSECTED with the scope, or the scope itself
   * when no portfolio is chosen. An empty intersection matches nothing.
   */
  siteScope: readonly string[] | null = null,
): Promise<DashboardPortfolio> {
  const groupRows = await db
    .select({ id: siteGroups.id, name: siteGroups.name })
    .from(siteGroups)
    .where(and(eq(siteGroups.organisationId, orgId), eq(siteGroups.active, true)));
  const portfolios = groupRows
    .map((row) => ({ id: row.id, name: row.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const wanted = (wantedId ?? "").trim();
  const chosen = portfolios.find((row) => row.id === wanted) ?? null;

  let siteIds: string[] | null = null;
  if (chosen) {
    const members = await db
      .select({ siteId: siteGroupMembers.siteId })
      .from(siteGroupMembers)
      .where(
        and(
          eq(siteGroupMembers.organisationId, orgId),
          eq(siteGroupMembers.siteGroupId, chosen.id),
        ),
      );
    siteIds = [...new Set(members.map((row) => row.siteId).filter(Boolean))];
  }
  if (siteScope) {
    const allowed = new Set(siteScope);
    siteIds = siteIds ? siteIds.filter((id) => allowed.has(id)) : [...allowed];
  }
  return { portfolios, chosen, siteIds };
}

/* ── Spend, shared by the Overview and Reports ───────────────────────────── */

/**
 * SPEND BY MONTH — the one query both spend trends are drawn from.
 *
 * `maintenance_requests.cost` is a REAL in POUNDS — the same column
 * `/api/dashboard/cost` reads — counted when the job has a completion date and
 * dated by it. Summed per month in SQL, converted to integer pence once, here,
 * and never handled as a float again.
 *
 * Extracted from the Overview's own pass so the Reports block's trend is not a
 * second query that happens to agree: it IS this query, over the same scope,
 * so "Spend trend values = Overview spend trend values for the same months and
 * portfolio" holds by construction rather than by coincidence.
 */
export async function loadSpendByMonth(
  db: Database,
  scope: SQL,
  fromDay: string,
  endExclusive: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      month: sql<string>`substr(${dayOnly(maintenanceRequests.completedAt)}, 1, 7)`.as("month"),
      pounds: sql<number>`coalesce(sum(${maintenanceRequests.cost}), 0)`,
    })
    .from(maintenanceRequests)
    .where(
      and(
        scope,
        isNotNull(maintenanceRequests.completedAt),
        sql`${dayOnly(maintenanceRequests.completedAt)} >= ${fromDay}`,
        sql`${dayOnly(maintenanceRequests.completedAt)} < ${endExclusive}`,
        isNotNull(maintenanceRequests.cost),
      ),
    )
    .groupBy(sql`month`);
  const tally = new Map<string, number>();
  for (const row of rows) {
    const month = String(row.month ?? "").slice(0, 7);
    if (!month) continue;
    tally.set(month, (tally.get(month) ?? 0) + Math.round(Number(row.pounds ?? 0) * 100));
  }
  return tally;
}

/** `Sep` for `2026-09`, in Europe/London — the trend's axis label. */
export function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "short",
    timeZone: "Europe/London",
  });
}

/* ── The one pass ─────────────────────────────────────────────────────────── */

export async function loadOverviewMetrics(
  db: Database,
  orgId: string,
  options: {
    portfolio?: string | null;
    from?: string | null;
    to?: string | null;
    now?: Date;
    /** The membership's site restriction — see `resolveDashboardPortfolio`. */
    siteScope?: readonly string[] | null;
  } = {},
): Promise<OvMetrics> {
  const now = options.now ?? new Date();
  const today = dayString(now);

  /* The window: 30 days back through today, unless asked otherwise. Ends
     EXCLUSIVE at tomorrow for the same reason every other window here does —
     a job completed an hour ago belongs to today. */
  /* A real calendar day, not merely the right shape: "2026-13-01" in a link
     falls back to the default rather than failing the whole block. */
  const from = isCalendarDay(options.from) ? options.from : shiftDay(today, -30);
  const to = isCalendarDay(options.to) ? options.to : today;
  const [rangeFrom, rangeTo] = from <= to ? [from, to] : [to, from];
  const endExclusive = shiftDay(rangeTo, 1);

  /* ── Portfolios ─────────────────────────────────────────────────────────── */

  const { portfolios, chosen, siteIds } = await resolveDashboardPortfolio(
    db,
    orgId,
    options.portfolio,
    options.siteScope ?? null,
  );

  const scope = dashboardJobScope(orgId, siteIds);
  const openScope = and(scope, sql`not ${closedJobSql}`)!;

  /* ── Statuses, from configuration ───────────────────────────────────────── */

  const statusRows = await db
    .select({
      label: jobStatusMap.sourceStatusLabel,
      display: jobStatusMap.displayLabel,
      colour: jobStatusMap.colourHex,
      open: jobStatusMap.countsAsOpen,
      sortOrder: jobStatusMap.sortOrder,
    })
    .from(jobStatusMap)
    .where(and(eq(jobStatusMap.organisationId, orgId), eq(jobStatusMap.active, true)));

  const statusMeta = new Map(
    statusRows.map((row) => [
      String(row.label ?? "").trim().toLowerCase(),
      {
        display: row.display || row.label,
        colour: row.colour || OV_COLOURS.grey,
        sortOrder: Number(row.sortOrder ?? 0),
      },
    ]),
  );

  /* ── The counts ─────────────────────────────────────────────────────────── */

  const [
    openRows,
    overdueRows,
    completedRows,
    statusGrouped,
    priorityGrouped,
    categoryGrouped,
    attentionRows,
    unitRows,
    spendTally,
    openByDay,
    overdueDueDays,
    completedByDay,
  ] = await Promise.all([
    db.select({ total: count() }).from(maintenanceRequests).where(openScope),
    db.select({ total: count() }).from(maintenanceRequests).where(and(scope, overdueOpenSql(now))),
    db
      .select({ total: count() })
      .from(maintenanceRequests)
      .where(
        and(
          scope,
          isNotNull(maintenanceRequests.completedAt),
          sql`${dayOnly(maintenanceRequests.completedAt)} >= ${rangeFrom}`,
          sql`${dayOnly(maintenanceRequests.completedAt)} < ${endExclusive}`,
        ),
      ),
    db
      .select({ status: maintenanceRequests.status, total: count() })
      .from(maintenanceRequests)
      .where(openScope)
      .groupBy(maintenanceRequests.status),
    db
      .select({ priority: maintenanceRequests.priority, total: count() })
      .from(maintenanceRequests)
      .where(openScope)
      .groupBy(maintenanceRequests.priority),
    db
      .select({ category: maintenanceRequests.category, total: count() })
      .from(maintenanceRequests)
      .where(openScope)
      .groupBy(maintenanceRequests.category),
    /*
     * "Distinct units with ≥ 1 open job that is High or Medium priority, or
     * overdue." This estate files work against SITES rather than units, so the
     * distinct count is over `site_id` — the level the rows actually carry.
     */
    db
      .select({ siteId: maintenanceRequests.siteId })
      .from(maintenanceRequests)
      .where(
        and(
          openScope,
          sql`(lower(trim(coalesce(${maintenanceRequests.priority}, ''))) in ${["urgent", "critical", "p1", "medium", "normal", "standard"]} or ${overdueOpenSql(now)})`,
        ),
      )
      .groupBy(maintenanceRequests.siteId),
    db
      .select({ total: count() })
      .from(units)
      .where(
        siteIds
          ? and(
              eq(units.organisationId, orgId),
              eq(units.status, "Active"),
              siteIds.length ? inArray(units.siteId, siteIds) : sql`1 = 0`,
            )!
          : and(eq(units.organisationId, orgId), eq(units.status, "Active"))!,
      ),
    /*
     * Spend by month — `loadSpendByMonth`, the query the Reports block's trend
     * is also drawn from. Pounds become integer pence once, inside it.
     */
    loadSpendByMonth(db, scope, shiftDay(rangeTo, -364), endExclusive),
    /* The three sparkline series, each reconstructed from dates the rows
       already carry. Grouped in SQL and expanded to a dense series in JS. */
    db
      .select({
        day: sql<string>`${dayOnly(maintenanceRequests.requestedAt)}`.as("day"),
        total: count(),
      })
      .from(maintenanceRequests)
      .where(and(scope, sql`${dayOnly(maintenanceRequests.requestedAt)} < ${endExclusive}`))
      .groupBy(sql`day`),
    db
      .select({
        day: sql<string>`${dayOnly(maintenanceRequests.dueAt)}`.as("day"),
        total: count(),
      })
      .from(maintenanceRequests)
      .where(
        and(
          scope,
          isNotNull(maintenanceRequests.dueAt),
          sql`${dayOnly(maintenanceRequests.dueAt)} <> ''`,
        ),
      )
      .groupBy(sql`day`),
    db
      .select({
        day: sql<string>`${dayOnly(maintenanceRequests.completedAt)}`.as("day"),
        total: count(),
      })
      .from(maintenanceRequests)
      .where(
        and(
          scope,
          isNotNull(maintenanceRequests.completedAt),
          sql`${dayOnly(maintenanceRequests.completedAt)} <> ''`,
        ),
      )
      .groupBy(sql`day`),
  ]);

  /* ── Job Intelligence: the splits and clocks the Overview's first section adds ──
   *
   * Same scope, same open-work predicate and same overdue rule as every figure
   * above, so each split sums back to Open jobs and the per-priority SLA sums
   * back to the headline's. See `overview-intel.ts` for the definitions.
   */
  const agedBefore = shiftDay(today, -AGING_THRESHOLD_DAYS);
  const dueSoonEnd = shiftDay(today, 2);
  const instant = now.toISOString();
  const instantEnd = new Date(now.getTime() + BREACH_WINDOW_HOURS * 3_600_000).toISOString();
  const dueText = dateText(maintenanceRequests.dueAt);
  /* Not yet overdue and due inside the window, by the overdue test's own two
     shapes: a date-only due is compared by day, a stamped one by instant. */
  const dueDay = dayOnly(maintenanceRequests.dueAt);
  const dueSoonSql = sql`(${maintenanceRequests.dueAt} is not null and ${dueText} <> '' and ((length(${dueText}) <= 10 and ${dueDay} >= ${today} and ${dueDay} < ${dueSoonEnd}) or (length(${dueText}) > 10 and ${dueText} >= ${instant} and ${dueText} < ${instantEnd})))`;
  /* High is `urgent` by `normalisePriority`'s spellings; Tier 1 is the top tier. */
  const riskPoolSql = sql`(lower(trim(coalesce(${maintenanceRequests.priority}, ''))) in ${["urgent", "critical", "p1"]} or ${maintenanceRequests.tier} = 1)`;
  const requestedDay = dayOnly(maintenanceRequests.requestedAt);
  const completedDay = dayOnly(maintenanceRequests.completedAt);
  const [tierRows, engineerRows, priorityOverdueRows, agingRows, breachRows, closureRows] = await Promise.all([
    db
      .select({ tier: maintenanceRequests.tier, total: count() })
      .from(maintenanceRequests)
      .where(openScope)
      .groupBy(maintenanceRequests.tier),
    db
      .select({ engineer: maintenanceRequests.engineer, total: count() })
      .from(maintenanceRequests)
      .where(openScope)
      .groupBy(maintenanceRequests.engineer),
    db
      .select({
        priority: maintenanceRequests.priority,
        total: count(),
        overdue: sql<number>`sum(case when ${overdueOpenSql(now)} then 1 else 0 end)`,
      })
      .from(maintenanceRequests)
      .where(openScope)
      .groupBy(maintenanceRequests.priority),
    db
      .select({ total: count(), oldest: sql<string | null>`min(${requestedDay})` })
      .from(maintenanceRequests)
      .where(and(openScope, sql`${requestedDay} <> ''`, sql`${requestedDay} < ${agedBefore}`)),
    db
      .select({ pool: count(), risk: sql<number>`sum(case when ${dueSoonSql} then 1 else 0 end)` })
      .from(maintenanceRequests)
      .where(and(openScope, riskPoolSql)),
    db
      .select({ requestedDay: sql<string>`${requestedDay}`, completedDay: sql<string>`${completedDay}` })
      .from(maintenanceRequests)
      .where(
        and(
          scope,
          isNotNull(maintenanceRequests.completedAt),
          sql`${completedDay} >= ${closuresFrom({ from: rangeFrom, to: rangeTo })}`,
          sql`${completedDay} < ${endExclusive}`,
        ),
      ),
  ]);

  const openJobs = Number(openRows[0]?.total ?? 0);
  const overdue = Math.min(Number(overdueRows[0]?.total ?? 0), openJobs);
  const completed = Number(completedRows[0]?.total ?? 0);
  const activeUnits = Number(unitRows[0]?.total ?? 0);
  const attentionSiteIds = [
    ...new Set(attentionRows.map((row) => String(row.siteId ?? "").trim()).filter(Boolean)),
  ];
  const attention = attentionSiteIds.length;

  /* ── Jobs by status ─────────────────────────────────────────────────────── */

  const statusTally = new Map<
    string,
    { label: string; value: number; colour: string; order: number; sources: Set<string> }
  >();
  for (const row of statusGrouped) {
    const raw = String(row.status ?? "").trim();
    const key = raw.toLowerCase();
    const meta = statusMeta.get(key);
    const label = meta?.display ?? (raw || "Unset");
    const entry = statusTally.get(label) ?? {
      label,
      value: 0,
      colour: meta?.colour ?? OV_COLOURS.grey,
      order: meta?.sortOrder ?? 999,
      /* Two raw statuses can map to one display label, and the drill has to
         send both or the list is shorter than the segment. */
      sources: new Set<string>(),
    };
    entry.value += Number(row.total ?? 0);
    if (raw) entry.sources.add(raw);
    statusTally.set(label, entry);
  }
  const jobsByStatus: OvSlice[] = [...statusTally.values()]
    .filter((entry) => entry.value > 0)
    .sort((a, b) => a.order - b.order || b.value - a.value)
    .map((entry, index) => ({
      key: entry.label,
      label: entry.label,
      value: entry.value,
      /* The configured colour when there is one; otherwise the brief's series
         order, so an unconfigured status is still distinguishable. */
      colour: entry.colour || SERIES_ORDER[index % SERIES_ORDER.length],
      labels: [...(entry.sources.size ? entry.sources : new Set([entry.label]))],
    }));

  /* ── Priority rings ─────────────────────────────────────────────────────── */

  const priorityTally = new Map<string, number>();
  for (const row of priorityGrouped) {
    const key = normalisePriority(row.priority);
    priorityTally.set(key, (priorityTally.get(key) ?? 0) + Number(row.total ?? 0));
  }
  const priority: OvSlice[] = ["urgent", "medium", "low", "not_recorded"]
    .map((key) => ({
      key,
      label: PRIORITY_LABEL[key],
      value: priorityTally.get(key) ?? 0,
      colour: PRIORITY_COLOUR[key],
      /* The board's priority filter speaks `PriorityKey`, not the display
         word: "High" is `urgent` there. */
      labels: [key],
    }))
    /* "Unset" appears only when it has a count, so the rings always add up to
       Open jobs without inventing a fourth ring nobody needs. */
    .filter((slice) => slice.key !== "not_recorded" || slice.value > 0);

  /* ── Categories ─────────────────────────────────────────────────────────── */

  const categoryTally = new Map<string, number>();
  let unassigned = 0;
  for (const row of categoryGrouped) {
    const raw = String(row.category ?? "").trim();
    const amount = Number(row.total ?? 0);
    if (!raw || raw === "[object Object]") {
      unassigned += amount;
      continue;
    }
    categoryTally.set(raw, (categoryTally.get(raw) ?? 0) + amount);
  }
  const ranked = [...categoryTally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const head = ranked.slice(0, 5);
  const tail = ranked.slice(5);
  const categories: OvSlice[] = head.map(([label, value], index) => ({
    key: label,
    label,
    value,
    colour: SERIES_ORDER[index % SERIES_ORDER.length],
    labels: [label],
  }));
  const otherTotal = tail.reduce((sum, [, value]) => sum + value, 0);
  if (otherTotal > 0) {
    /*
     * THIS ESTATE HAS A CATEGORY LITERALLY NAMED "Other" — 61 of 98 open jobs.
     *
     * So the grouped tail cannot also be called "Other": the legend would show
     * the word twice with two different numbers, and a reader has no way to
     * tell which is the category and which is the remainder. When the real one
     * is already on the chart the tail folds INTO it, carrying both sets of
     * labels so the drill still opens exactly what the ring counted. When it
     * is not, the tail keeps the name.
     */
    const existing = categories.find((slice) => slice.label.toLowerCase() === "other");
    if (existing) {
      existing.value += otherTotal;
      existing.labels = [...existing.labels, ...tail.map(([label]) => label)];
    } else {
      categories.push({
        key: "__other__",
        label: "Other",
        value: otherTotal,
        colour: OV_COLOURS.grey,
        labels: tail.map(([label]) => label),
      });
    }
  }
  if (unassigned > 0) {
    categories.push({
      key: "__unassigned__",
      label: "Unassigned",
      value: unassigned,
      colour: OV_COLOURS.grey,
      /* The shared sentinel every "not recorded" bucket filters by. */
      labels: ["__not_recorded__"],
    });
  }
  /* Re-sorted because the fold can move "Other" up the order. */
  categories.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));

  /* ── Compliance ─────────────────────────────────────────────────────────── */

  const register = await readComplianceRegister(db, orgId, { today: now });
  const allowed = siteIds ? new Set(siteIds) : null;
  /*
   * `complianceCompletion` is handed the portfolio's WHOLE register, "Not
   * required" included, and excludes those records itself — so its percent,
   * satisfied and applicable are exactly what they were when this list was
   * pre-filtered, and its `notRequired` is now a count rather than the 0 the
   * pre-filtering always left for it (the export's "requirements not required"
   * row read 0 on an estate holding 541).
   */
  const scorable = register.entries.filter(
    (entry) => !allowed || allowed.has(String(entry.siteId ?? "")),
  );
  const completion = complianceCompletion(scorable);

  /* ── Sparklines ─────────────────────────────────────────────────────────── */

  const days: string[] = [];
  for (let day = rangeFrom; day <= rangeTo; day = shiftDay(day, 1)) {
    days.push(day);
    if (days.length > 400) break;
  }

  const byDay = (rows: { day: string | null; total: number }[]) => {
    const map = new Map<string, number>();
    for (const row of rows) {
      const key = String(row.day ?? "").slice(0, 10);
      if (key) map.set(key, (map.get(key) ?? 0) + Number(row.total ?? 0));
    }
    return map;
  };
  const raisedOn = byDay(openByDay);
  const dueOn = byDay(overdueDueDays);
  const closedOn = byDay(completedByDay);

  /*
   * OPEN ON A GIVEN DAY = raised on or before it, minus closed on or before it.
   * Both halves come from dates the rows already carry, so the series is a
   * reconstruction rather than a guess — and its last point equals the Open
   * jobs KPI, which is the property the reconciliation test pins.
   */
  let raisedRunning = 0;
  let closedRunning = 0;
  const before = (map: Map<string, number>, upTo: string) => {
    let total = 0;
    for (const [day, value] of map) if (day <= upTo) total += value;
    return total;
  };
  raisedRunning = days.length ? before(raisedOn, shiftDay(days[0], -1)) : 0;
  closedRunning = days.length ? before(closedOn, shiftDay(days[0], -1)) : 0;

  const openSpark: OvSpark = [];
  const overdueSpark: OvSpark = [];
  const completedSpark: OvSpark = [];
  let overdueRunning = days.length ? before(dueOn, shiftDay(days[0], -1)) : 0;
  for (const day of days) {
    raisedRunning += raisedOn.get(day) ?? 0;
    closedRunning += closedOn.get(day) ?? 0;
    overdueRunning += dueOn.get(day) ?? 0;
    openSpark.push({ day, value: Math.max(0, raisedRunning - closedRunning) });
    /* Overdue on a past day is "due by then and not yet closed by then" — the
       same two dates, read the same way. */
    overdueSpark.push({ day, value: Math.max(0, Math.min(overdueRunning - closedRunning, raisedRunning - closedRunning)) });
    completedSpark.push({ day, value: closedOn.get(day) ?? 0 });
  }

  /* The last point of the open series IS the KPI, so the line cannot end
     somewhere the number above it does not. */
  if (openSpark.length) openSpark[openSpark.length - 1] = { day: rangeTo, value: openJobs };
  if (overdueSpark.length) overdueSpark[overdueSpark.length - 1] = { day: rangeTo, value: overdue };

  /* ── Spend ──────────────────────────────────────────────────────────────── */

  const spend: { month: string; label: string; pence: number }[] = [];
  let cursor = `${rangeTo.slice(0, 7)}-01`;
  const months: string[] = [];
  for (let index = 0; index < 12; index += 1) {
    months.unshift(cursor.slice(0, 7));
    cursor = `${shiftDay(cursor, -1).slice(0, 7)}-01`;
  }
  for (const month of months) {
    spend.push({
      month,
      label: monthLabel(month),
      pence: spendTally.get(month) ?? 0,
    });
  }

  /* ── SLA ────────────────────────────────────────────────────────────────── */

  const withinSla = Math.max(0, openJobs - overdue);
  const slaPercent = openJobs > 0 ? Math.round((withinSla / openJobs) * 100) : 0;

  return {
    range: {
      from: rangeFrom,
      to: rangeTo,
      label: formatDayRange(rangeFrom, rangeTo),
    },
    /* For "All portfolios" the list is empty — nothing to narrow — unless the
       membership is site-restricted, when it is the scope, so a drill opens
       the member's stores rather than the whole estate. A scope that resolved
       to no sites at all is `NO_SITE_IN_SCOPE`, so its drills open nothing. */
    portfolio: chosen
      ? { ...chosen, siteIds: drillSiteIds(siteIds) }
      : { id: "all", name: "All portfolios", siteIds: drillSiteIds(siteIds) },
    portfolios,
    openJobs,
    attentionSiteIds,
    kpis: [
      { key: "activeUnits", label: "Active units", value: activeUnits, isPercent: false, spark: null },
      { key: "attention", label: "Requiring attention", value: attention, isPercent: false, spark: null },
      { key: "openJobs", label: "Open jobs", value: openJobs, isPercent: false, spark: openSpark },
      { key: "overdue", label: "Overdue", value: overdue, isPercent: false, spark: overdueSpark },
      { key: "completed", label: "Completed", value: completed, isPercent: false, spark: completedSpark },
      {
        key: "compliance",
        label: "Compliance",
        value: completion.scored ? completion.percent : 0,
        isPercent: true,
        spark: null,
      },
    ],
    jobsByStatus,
    sla: { percent: slaPercent, open: openJobs, overdue, withinSla },
    priority,
    categories,
    compliance: {
      percent: completion.scored ? completion.percent : 0,
      satisfied: completion.satisfied,
      applicable: completion.applicable,
      notRequired: completion.notRequired,
      scored: completion.scored,
    },
    spend,
    intel: buildJobIntel({
      today,
      range: { from: rangeFrom, to: rangeTo },
      open: openJobs,
      overdue,
      completed,
      statusSlices: jobsByStatus,
      prioritySlices: priority,
      categoryRows: categoryGrouped.map((row) => ({ category: row.category, total: Number(row.total ?? 0) })),
      tierRows: tierRows.map((row) => ({ tier: row.tier === null ? null : Number(row.tier), total: Number(row.total ?? 0) })),
      engineerRows: engineerRows.map((row) => ({ engineer: row.engineer, total: Number(row.total ?? 0) })),
      priorityRows: priorityOverdueRows.map((row) => ({
        priority: row.priority,
        total: Number(row.total ?? 0),
        overdue: Number(row.overdue ?? 0),
      })),
      aging: {
        count: Number(agingRows[0]?.total ?? 0),
        oldestDay: agingRows[0]?.oldest ? String(agingRows[0].oldest) : null,
      },
      breach: { pool: Number(breachRows[0]?.pool ?? 0), count: Number(breachRows[0]?.risk ?? 0) },
      closures: closureRows.map((row) => ({
        requestedDay: row.requestedDay ? String(row.requestedDay) : null,
        completedDay: row.completedDay ? String(row.completedDay) : null,
      })),
      normalisePriority,
    }),
  };
}

/** `12 May 2026`, en-GB, Europe/London — the brief's date format. */
export function formatDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/London",
  });
}

/**
 * `12 May – 11 Jun 2026` — the three briefs' range format: the year once, at
 * the end, when both days share it; both years when they do not. Shared by the
 * three blocks' endpoints so their header pills read alike.
 */
export function formatDayRange(from: string, to: string): string {
  if (from.slice(0, 4) !== to.slice(0, 4)) return `${formatDay(from)} – ${formatDay(to)}`;
  const short = new Date(`${from}T12:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "Europe/London",
  });
  return `${short} – ${formatDay(to)}`;
}

/* ── Reconciliation, asserted rather than assumed ─────────────────────────── */

/**
 * §5.3's rules, as a function, so the tests and the route can both run them.
 *
 * Returned as a list of failures rather than thrown: a dashboard that refuses
 * to render because one subtotal disagrees is worse than one that renders and
 * says so, and the route logs these rather than 500ing on a reader.
 */
export function reconcile(metrics: OvMetrics): string[] {
  const failures: string[] = [];
  const sum = (rows: OvSlice[]) => rows.reduce((total, row) => total + row.value, 0);
  const open = metrics.openJobs;

  if (sum(metrics.jobsByStatus) !== open) {
    failures.push(`jobs by status ${sum(metrics.jobsByStatus)} != open ${open}`);
  }
  if (sum(metrics.priority) !== open) {
    failures.push(`priority rings ${sum(metrics.priority)} != open ${open}`);
  }
  if (sum(metrics.categories) !== open) {
    failures.push(`categories ${sum(metrics.categories)} != open ${open}`);
  }
  if (metrics.sla.overdue > open) {
    failures.push(`overdue ${metrics.sla.overdue} > open ${open}`);
  }
  const expected = open > 0 ? Math.round(((open - metrics.sla.overdue) / open) * 100) : 0;
  if (metrics.sla.percent !== expected) {
    failures.push(`sla ${metrics.sla.percent}% != ${expected}%`);
  }
  const compliance = metrics.kpis.find((kpi) => kpi.key === "compliance");
  if (compliance && compliance.value !== metrics.compliance.percent) {
    failures.push(`compliance KPI ${compliance.value}% != gauge ${metrics.compliance.percent}%`);
  }
  return failures;
}
