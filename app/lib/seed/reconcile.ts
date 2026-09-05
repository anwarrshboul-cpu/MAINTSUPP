/**
 * THE OTHER HALF OF THE HARNESS — the APPLICATION's answer to every number.
 *
 * Module 3 §4 states the reason this file must not be tidy: "If the dashboard
 * computes a number and you check it using the same code that produced it, you
 * have tested nothing." `./expected.ts` counts the dataset directly and imports
 * nothing at runtime. THIS file does the opposite and must keep doing it: it
 * reads the DATABASE and classifies what it finds with the PRODUCT'S OWN
 * functions —
 *
 *   · `certificateExpiryBand()` from `app/(app)/portal/calendar-item-types.ts`
 *     — the ladder the calendar actually paints with;
 *   · `jobChipAppearance()` and `jobIsOverdue()` from
 *     `app/(app)/portal/job-status-map.ts`, over `job_status_map` rows read out
 *     of the database — so a drift between `db/init.ts`'s seeded map and the
 *     harness's copy of it in `./dataset.ts` shows up as a red row rather than
 *     as two numbers that agree because they came from one place.
 *
 * `./expected.ts` IS IMPORTED FOR ITS TYPE AND FOR NOTHING ELSE. The expected
 * values arrive as an ARGUMENT, computed by the caller. If a later edit has
 * this module call `computeExpectedValues` and compare the result to itself,
 * every row below goes green and the harness stops meaning anything — which is
 * precisely the failure §4 warns about, and it is invisible on screen.
 *
 * ── WHAT "NOT MEASURED" IS FOR, AND WHY IT IS NOT A PASS ───────────────────
 *
 * A metric this schema cannot answer is reported as `not-measured` with the
 * reason on the row, and it is excluded from the pass rate rather than counted
 * as a pass. §4.2 asks for Pass/Fail; a third state is added because the
 * alternative is worse in both directions — a green tick against a number
 * nobody measured is a lie, and a red cross against one nobody can measure
 * trains the reader to ignore red.
 *
 * ── ONE DOCUMENTED DIVERGENCE, ASSERTED RATHER THAN HIDDEN ────────────────
 *
 * `jobChipAppearance()` counts an UNMAPPED status as OPEN — deliberately, and
 * its header explains why at length: an unmapped job that counted as closed
 * would drop out of the unscheduled tray and the open-jobs figure, and vanish.
 * `./expected.ts` excludes unmapped jobs from `jobs_open` and reports them
 * separately. Both are right about different questions, so `jobs_open` below is
 * measured over MAPPED statuses (which is what §4.1's figure means) and the
 * app's wider reading is emitted beside it as its own row, checked as an
 * identity. Collapsing the two would hide a real difference between two screens.
 */

import { and, eq, like, or, sql } from "drizzle-orm";
import {
  attachments,
  calendarEvents,
  complianceDocuments,
  contractors,
  jobStatusMap,
  maintenanceRequests,
  reminderRules,
  sites,
  users,
} from "../../../db/schema";
import { certificateExpiryBand } from "../../(app)/portal/calendar-item-types";
import {
  jobChipAppearance,
  jobIsOverdue,
  jobStatusIndex,
  type JobStatusMapping,
} from "../../(app)/portal/job-status-map";
import { listDueReminders } from "../reminders/repository";
import { SEED_ID_PREFIX } from "./dataset";
import type { CertificateBandKey, ExpectedValues } from "./expected";
import { SEED_ORGANISATION_ID } from "./loader";

/* eslint-disable @typescript-eslint/no-explicit-any -- see the same note in
   ./loader.ts: the drizzle handle is assembled per-driver and its type is not
   importable here without dragging the D1 binding into a pure module. */
type Db = any;

/* ------------------------------------------------------------- the shape -- */

export type ReconcileStatus = "pass" | "fail" | "not-measured";

export type ReconcileRow = {
  /** Stable across runs, so a row can be linked to and a fix can be verified. */
  readonly key: string;
  readonly section: string;
  readonly metric: string;
  readonly expected: number | null;
  readonly actual: number | null;
  readonly difference: number | null;
  readonly status: ReconcileStatus;
  /** What the application ran, in one sentence — §4.2's expandable detail. */
  readonly query: string;
  /** Why a row is not measured, or what a reader should know about it. */
  readonly note?: string;
  /** The records behind each side, capped. §4.2 wants the discrepancy
      diagnosable in one click rather than in an afternoon. */
  readonly expectedIds?: readonly string[];
  readonly actualIds?: readonly string[];
};

export type ReconcileReport = {
  readonly ranAt: string;
  readonly today: string;
  readonly seedBatchId: string;
  readonly organisationId: string;
  readonly rows: readonly ReconcileRow[];
  readonly passed: number;
  readonly failed: number;
  readonly notMeasured: number;
  /** 0–100, over the MEASURED rows only. Null when nothing was measured. */
  readonly passRate: number | null;
  readonly seeded: boolean;
};

/** How many ids a row carries. Enough to diagnose, not enough to be a dump. */
const ID_SAMPLE = 25;

/* --------------------------------------------------------- row assembly -- */

/**
 * One comparison. PURE, so the arithmetic that decides red or green can be
 * tested without a database — which matters more here than usual, because this
 * function decides what the whole page says.
 */
export function compareMetric(input: {
  key: string;
  section: string;
  metric: string;
  expected: number | null;
  actual: number | null;
  query: string;
  note?: string;
  expectedIds?: readonly string[];
  actualIds?: readonly string[];
}): ReconcileRow {
  const measurable = input.expected !== null && input.actual !== null;
  const difference = measurable ? (input.actual as number) - (input.expected as number) : null;
  return {
    key: input.key,
    section: input.section,
    metric: input.metric,
    expected: input.expected,
    actual: input.actual,
    difference,
    status: !measurable ? "not-measured" : difference === 0 ? "pass" : "fail",
    query: input.query,
    ...(input.note ? { note: input.note } : {}),
    ...(input.expectedIds ? { expectedIds: input.expectedIds.slice(0, ID_SAMPLE) } : {}),
    ...(input.actualIds ? { actualIds: input.actualIds.slice(0, ID_SAMPLE) } : {}),
  };
}

/** The headline §4.2 asks for, over the measured rows only. */
export function summarise(rows: readonly ReconcileRow[]): {
  passed: number;
  failed: number;
  notMeasured: number;
  passRate: number | null;
} {
  let passed = 0;
  let failed = 0;
  let notMeasured = 0;
  for (const row of rows) {
    if (row.status === "pass") passed += 1;
    else if (row.status === "fail") failed += 1;
    else notMeasured += 1;
  }
  const measured = passed + failed;
  return {
    passed,
    failed,
    notMeasured,
    passRate: measured === 0 ? null : Math.round((passed / measured) * 1000) / 10,
  };
}

/* ------------------------------------------------------------ date maths -- */

/**
 * Whole days from `from` to `to`, UTC.
 *
 * A third spelling, and deliberately so. `dataset.ts` splits and calls
 * `Date.UTC`; `expected.ts` hands the whole string to `Date.parse`; this one
 * parses the string it read out of a DATABASE COLUMN, which may be a date or a
 * timestamp, so it slices to ten characters first. That slice is the whole
 * reason this cannot borrow either of the others.
 */
function dayOffset(from: string, to: string): number {
  const left = Date.parse(`${from.slice(0, 10)}T00:00:00.000Z`);
  const right = Date.parse(`${to.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(left) || Number.isNaN(right)) return Number.NaN;
  return Math.round((right - left) / 86_400_000);
}

/** The app's band, as the key `./expected.ts` speaks. */
const BAND_BY_APP_LABEL: Readonly<Record<string, CertificateBandKey>> = {
  Valid: "valid",
  "90-day window": "d90",
  "60-day window": "d60",
  "30-day window": "d30",
  Urgent: "d14",
  Expired: "expired",
};

/**
 * The band one stored certificate row is in, by the APPLICATION's ladder.
 *
 * Supersession is read off the ROW and checked first, because
 * `certificateExpiryBand` is given a number of days and has no superseded state
 * — a documented gap, asserted in `tests/pre-w14-seed-reconcile.test.mjs` rather
 * than papered over. A screen that wants §3.3's seventh state has to read
 * `renewal_status`, which is exactly what this does.
 */
export function bandForStoredCertificate(
  row: { expiryDate: string | null; renewalStatus: string | null },
  today: string,
): CertificateBandKey {
  if ((row.renewalStatus ?? "").trim().toLowerCase() === "superseded") return "superseded";
  if (!row.expiryDate) return "undated";
  const days = dayOffset(today, row.expiryDate);
  if (Number.isNaN(days)) return "undated";
  return BAND_BY_APP_LABEL[certificateExpiryBand(days).label] ?? "expired";
}

/* ------------------------------------------------------------ the counts -- */

async function countWhere(db: Db, table: unknown, where: unknown): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`COUNT(*)` })
    .from(table as never)
    .where(where as never);
  return Number(row?.total ?? 0);
}

/** `is_seed = 1` on a table `db/schema.ts` does not model the column on. */
const seedFlag = sql`is_seed = ${1}`;

function increment(into: Record<string, number>, key: string): void {
  into[key] = (into[key] ?? 0) + 1;
}

function push(into: Record<string, string[]>, key: string, id: string): void {
  (into[key] ??= []).push(id);
}

export type ReconcileInput = {
  /** Computed by the CALLER from `computeExpectedValues`. Never recomputed here. */
  readonly expected: ExpectedValues;
  readonly today: string;
  /** The types a store must hold, from the dataset. Data, not logic. */
  readonly mandatoryTypes: readonly string[];
  /** Provenance ids per row key, so a failing row can name records. */
  readonly expectedIdsByKey?: Readonly<Record<string, readonly string[]>>;
};

/**
 * Run every §4.1 metric and every §4.3 cross-section check against the database.
 *
 * The whole seeded estate is 60 certificates and 180 jobs, so the rows are read
 * once and classified in memory rather than counted with a dozen aggregate
 * queries. That is not an optimisation — it is what lets each row be classified
 * by the PRODUCT'S OWN function instead of by a `CASE WHEN` in SQL, which would
 * be a second copy of the ladder and would make the comparison worthless.
 */
export async function reconcileSeedData(
  db: Db,
  input: ReconcileInput,
): Promise<ReconcileReport> {
  const { expected, today, mandatoryTypes } = input;
  const ids = input.expectedIdsByKey ?? {};
  const org = SEED_ORGANISATION_ID;
  const prefix = `${SEED_ID_PREFIX}%`;
  const rows: ReconcileRow[] = [];
  const add = (row: Parameters<typeof compareMetric>[0]) =>
    rows.push(compareMetric({ ...row, expectedIds: row.expectedIds ?? ids[row.key] }));

  /* -- 1. volumes -------------------------------------------------------- */

  const seededSites = and(eq(sites.organisationId, org), or(seedFlag, like(sites.id, prefix)));
  const seededUsers = and(eq(users.organisationId, org), or(seedFlag, like(users.id, prefix)));
  const seededContractors = and(
    eq(contractors.organisationId, org),
    or(seedFlag, like(contractors.id, prefix)),
  );
  const seededFiles = and(
    eq(attachments.organisationId, org),
    or(seedFlag, like(attachments.id, prefix)),
  );

  add({
    key: "totals.stores",
    section: "Totals",
    metric: "Stores",
    expected: expected.totals.stores,
    actual: await countWhere(db, sites, seededSites),
    query: "SELECT COUNT(*) FROM sites WHERE organisation_id = :demo AND is_seed = 1",
  });
  add({
    key: "totals.users",
    section: "Totals",
    metric: "Users",
    expected: expected.totals.users,
    actual: await countWhere(db, users, seededUsers),
    query: "SELECT COUNT(*) FROM users WHERE organisation_id = :demo AND is_seed = 1",
  });
  add({
    key: "totals.contractors",
    section: "Totals",
    metric: "Contractors",
    expected: expected.totals.contractors,
    actual: await countWhere(db, contractors, seededContractors),
    query: "SELECT COUNT(*) FROM contractors WHERE organisation_id = :demo AND is_seed = 1",
  });
  add({
    key: "totals.attachments",
    section: "Totals",
    metric: "Attachments",
    expected: expected.totals.attachments,
    actual: await countWhere(db, attachments, seededFiles),
    query: "SELECT COUNT(*) FROM attachments WHERE organisation_id = :demo AND is_seed = 1",
  });

  /*
   * CONTACTS HAVE NO TABLE, and the honest answer is to say so.
   *
   * §3.2 asks for 20 contacts. This schema has none: a site's contact is
   * `sites.manager_email` and a job's is `maintenance_requests.contact`, so the
   * twelve site contacts are denormalised onto the sites and the eight
   * client-side contacts have nowhere to be written at all. Counting the twelve
   * and calling it 20 would be the kind of number this whole harness exists to
   * catch.
   */
  add({
    key: "totals.contacts",
    section: "Totals",
    metric: "Contacts",
    expected: expected.totals.contacts,
    actual: null,
    query: "— no contacts table exists in this schema",
    note:
      "This product has no contacts table: a site's contact is sites.manager_email " +
      "and a job's is maintenance_requests.contact. The 12 site contacts are " +
      "denormalised onto the sites; the 8 client-side contacts have no home. " +
      "Excluded rather than counted as 12 and called 20.",
  });

  const eventRows = (await db
    .select({
      id: calendarEvents.id,
      category: calendarEvents.category,
      startsOn: calendarEvents.startsOn,
    })
    .from(calendarEvents)
    .where(
      and(eq(calendarEvents.organisationId, org), eq(calendarEvents.isSeed, true)),
    )) as Array<{ id: string; category: string; startsOn: string }>;

  add({
    key: "totals.notes",
    section: "Totals",
    metric: "Notes",
    expected: expected.totals.notes,
    actual: eventRows.filter((row) => row.category === "Note").length,
    query: "SELECT * FROM calendar_events WHERE is_seed = 1 AND category = 'Note'",
    actualIds: eventRows.filter((row) => row.category === "Note").map((row) => row.id),
  });
  add({
    key: "totals.planned_visits",
    section: "Totals",
    metric: "Planned visits",
    expected: expected.totals.planned_visits,
    actual: eventRows.filter((row) => row.category === "Planned visit").length,
    query: "SELECT * FROM calendar_events WHERE is_seed = 1 AND category = 'Planned visit'",
    actualIds: eventRows.filter((row) => row.category === "Planned visit").map((row) => row.id),
  });

  /* -- 2. certificates, classified by the app's own ladder --------------- */

  const certificateRows = (await db
    .select({
      id: complianceDocuments.id,
      siteId: complianceDocuments.siteId,
      kind: complianceDocuments.kind,
      expiryDate: complianceDocuments.expiryDate,
      renewalStatus: complianceDocuments.renewalStatus,
      costPence: complianceDocuments.costPence,
    })
    .from(complianceDocuments)
    .where(
      and(eq(complianceDocuments.organisationId, org), eq(complianceDocuments.isSeed, true)),
    )) as Array<{
    id: string;
    siteId: string;
    kind: string;
    expiryDate: string | null;
    renewalStatus: string | null;
    costPence: number | null;
  }>;

  add({
    key: "totals.certificates",
    section: "Totals",
    metric: "Certificates",
    expected: expected.totals.certificates,
    actual: certificateRows.length,
    query: "SELECT * FROM compliance_documents WHERE organisation_id = :demo AND is_seed = 1",
  });

  const bandCounts: Record<string, number> = {};
  const bandIds: Record<string, string[]> = {};
  const offsetCounts: Record<string, number> = {};
  const offsetIds: Record<string, string[]> = {};
  const perStore: Record<string, { total: number; expired: number }> = {};
  const heldByStore = new Map<string, Set<string>>();
  let costPence = 0;

  for (const row of certificateRows) {
    const band = bandForStoredCertificate(row, today);
    increment(bandCounts, band);
    push(bandIds, band, row.id);

    const offsetKey =
      row.expiryDate === null ? "undated" : String(dayOffset(today, row.expiryDate));
    increment(offsetCounts, offsetKey);
    push(offsetIds, offsetKey, row.id);

    costPence += Number(row.costPence ?? 0);

    const bucket = (perStore[row.siteId] ??= { total: 0, expired: 0 });
    bucket.total += 1;
    if (band === "expired") bucket.expired += 1;

    if (band !== "superseded" && mandatoryTypes.includes(row.kind)) {
      const held = heldByStore.get(row.siteId) ?? new Set<string>();
      held.add(row.kind);
      heldByStore.set(row.siteId, held);
    }
  }

  for (const band of Object.keys(expected.certificates_by_window) as CertificateBandKey[]) {
    add({
      key: `band.${band}`,
      section: "Certificate bands",
      metric: `Band — ${band}`,
      expected: expected.certificates_by_window[band],
      actual: bandCounts[band] ?? 0,
      query:
        "certificateExpiryBand(days) over compliance_documents.expiry_date, with " +
        "renewal_status = 'superseded' read off the row",
      actualIds: bandIds[band] ?? [],
    });
  }

  /*
   * THE HIGHEST-VALUE ASSERTION IN THE HARNESS — §4.3's last bullet.
   *
   * One row per §3.3 offset, counted from the offset RE-DERIVED out of the
   * stored date. An error of one day at 90 puts every reminder in the system a
   * day out with no screen looking wrong, and this is the only place it shows.
   */
  for (const offsetKey of Object.keys(expected.certificates_by_offset)) {
    const label = offsetKey === "undated" ? "no expiry" : `${offsetKey} days`;
    add({
      key: `offset.${offsetKey}`,
      section: "Boundary matrix (§3.3)",
      metric: `Expiring in ${label}`,
      expected: expected.certificates_by_offset[offsetKey],
      actual: offsetCounts[offsetKey] ?? 0,
      query: "days between today and compliance_documents.expiry_date, UTC, whole days",
      actualIds: offsetIds[offsetKey] ?? [],
    });
  }

  /* -- 3. jobs, classified by job_status_map as the product reads it ----- */

  const mappings = (await db
    .select()
    .from(jobStatusMap)
    .where(eq(jobStatusMap.organisationId, org))) as JobStatusMapping[];
  const statusIndex = jobStatusIndex(mappings);

  const jobRows = (await db
    .select({
      id: maintenanceRequests.id,
      status: maintenanceRequests.status,
      dueAt: maintenanceRequests.dueAt,
      requestedAt: maintenanceRequests.requestedAt,
      scheduledDate: maintenanceRequests.scheduledDate,
      assignee: maintenanceRequests.assignee,
    })
    .from(maintenanceRequests)
    .where(
      and(
        eq(maintenanceRequests.organisationId, org),
        eq(maintenanceRequests.isSeed, true),
      ),
    )) as Array<{
    id: string;
    status: string;
    dueAt: string | null;
    requestedAt: string | null;
    scheduledDate: string | null;
    assignee: string | null;
  }>;

  add({
    key: "totals.jobs",
    section: "Totals",
    metric: "Jobs",
    expected: expected.totals.jobs,
    actual: jobRows.length,
    query: "SELECT * FROM maintenance_requests WHERE organisation_id = :demo AND is_seed = 1",
  });

  const statusCounts: Record<string, number> = {};
  const openIds: string[] = [];
  const unmappedIds: string[] = [];
  const overdueIds: string[] = [];
  const unscheduledIds: string[] = [];
  const unassignedIds: string[] = [];
  const completedIds: string[] = [];
  const slaIds: Record<string, string[]> = {};
  const excluded: Record<string, number> = {};
  let breached = 0;
  let approaching = 0;
  let within = 0;
  let openIncludingUnmapped = 0;

  for (const job of jobRows) {
    increment(statusCounts, job.status);
    const appearance = jobChipAppearance(job.status, statusIndex);
    if (appearance.countsAsOpen) openIncludingUnmapped += 1;

    if (!appearance.mapped) {
      unmappedIds.push(job.id);
      increment(excluded, "unmapped-status");
      continue;
    }
    if (job.status === "Completed") completedIds.push(job.id);
    if (!appearance.countsAsOpen) {
      increment(excluded, "closed");
      continue;
    }

    openIds.push(job.id);
    if (job.scheduledDate === null) unscheduledIds.push(job.id);
    if (job.assignee === null) unassignedIds.push(job.id);
    if (jobIsOverdue({ deadline: job.dueAt, today, appearance })) overdueIds.push(job.id);

    if (!job.dueAt) {
      increment(excluded, "no-deadline");
      continue;
    }
    const remaining = dayOffset(today, job.dueAt);
    const window = job.requestedAt ? dayOffset(job.requestedAt, job.dueAt) : Number.NaN;
    if (remaining < 0) {
      breached += 1;
      push(slaIds, "breached", job.id);
      continue;
    }
    if (!Number.isFinite(window) || window <= 0) {
      increment(excluded, "zero-window");
      continue;
    }
    /* Inclusive at a quarter, because §3.4 seeds four jobs at EXACTLY 25% and
       calls them the trigger. An exclusive comparison would seed it and never
       fire it. */
    if (remaining * 4 <= window) {
      approaching += 1;
      push(slaIds, "approaching", job.id);
    } else {
      within += 1;
      push(slaIds, "within", job.id);
    }
  }

  add({
    key: "totals.jobs_open",
    section: "Totals",
    metric: "Open jobs (mapped statuses)",
    expected: expected.totals.jobs_open,
    actual: openIds.length,
    query: "job_status_map.counts_as_open = 1, matched on maintenance_requests.status",
    actualIds: openIds,
  });
  add({
    key: "totals.jobs_completed",
    section: "Totals",
    metric: "Completed jobs",
    expected: expected.totals.jobs_completed,
    actual: completedIds.length,
    query: "maintenance_requests.status = 'Completed'",
    actualIds: completedIds,
  });
  add({
    key: "totals.jobs_overdue",
    section: "Totals",
    metric: "Overdue jobs",
    expected: expected.totals.jobs_overdue,
    actual: overdueIds.length,
    query: "jobIsOverdue({ deadline: due_at, today, appearance }) — the calendar's own overlay rule",
    actualIds: overdueIds,
  });
  add({
    key: "totals.jobs_unscheduled",
    section: "Totals",
    metric: "Unscheduled jobs",
    expected: expected.totals.jobs_unscheduled,
    actual: unscheduledIds.length,
    query: "scheduled_date IS NULL AND the status counts as open — the unscheduled tray's rule",
    actualIds: unscheduledIds,
  });
  add({
    key: "totals.jobs_unassigned",
    section: "Totals",
    metric: "Unassigned jobs",
    expected: expected.totals.jobs_unassigned,
    actual: unassignedIds.length,
    query: "assignee IS NULL AND the status counts as open",
    actualIds: unassignedIds,
  });
  add({
    key: "totals.jobs_unmapped_status",
    section: "Totals",
    metric: "Jobs with an unmapped status",
    expected: expected.totals.jobs_unmapped_status,
    actual: unmappedIds.length,
    query: "maintenance_requests.status not present in job_status_map for this workspace",
    actualIds: unmappedIds,
  });

  /* -- 4. status breakdown ---------------------------------------------- */

  for (const status of Object.keys(expected.jobs_by_status)) {
    add({
      key: `status.${status}`,
      section: "Jobs by status",
      metric: status,
      expected: expected.jobs_by_status[status],
      actual: statusCounts[status] ?? 0,
      query: "GROUP BY maintenance_requests.status over the seeded rows",
    });
  }

  /* -- 5. SLA ------------------------------------------------------------ */

  add({
    key: "sla.breached",
    section: "SLA",
    metric: "Breached",
    expected: expected.sla.breached,
    actual: breached,
    query: "open, mapped, due_at earlier than today",
    actualIds: slaIds.breached ?? [],
  });
  add({
    key: "sla.approaching",
    section: "SLA",
    metric: "Approaching (≤ 25% of the window left)",
    expected: expected.sla.approaching,
    actual: approaching,
    query: "(days to due_at) × 4 ≤ (days from requested_at to due_at), inclusive",
    actualIds: slaIds.approaching ?? [],
  });
  add({
    key: "sla.within",
    section: "SLA",
    metric: "Within",
    expected: expected.sla.within,
    actual: within,
    query: "open, mapped, dated, and more than a quarter of the window remaining",
  });
  add({
    key: "sla.excluded",
    section: "SLA",
    metric: "Excluded",
    expected: expected.sla.excluded,
    actual: Object.values(excluded).reduce((total, value) => total + value, 0),
    query: "closed, unmapped, undated or zero-window — measured, or honestly excluded",
    note: Object.entries(excluded)
      .map(([reason, count]) => `${reason}: ${count}`)
      .join(", "),
  });

  /* -- 6. cost ----------------------------------------------------------- */

  add({
    key: "cost.certificates_pence",
    section: "Cost",
    metric: "Certificate cost (pence)",
    expected: expected.cost_totals.certificates_pence,
    actual: costPence,
    query: "SELECT SUM(cost_pence) FROM compliance_documents WHERE is_seed = 1",
    note: "Pence is authoritative — a fractional penny is a rounding bug wearing a total.",
  });

  /* -- 7. coverage gaps -------------------------------------------------- */

  const siteIds = (await db
    .select({ id: sites.id })
    .from(sites)
    .where(seededSites)) as Array<{ id: string }>;
  const gapIds: string[] = [];
  for (const site of siteIds) {
    const held = heldByStore.get(site.id) ?? new Set<string>();
    for (const kind of mandatoryTypes) {
      if (!held.has(kind)) gapIds.push(`${site.id}:${kind}`);
    }
  }
  add({
    key: "coverage.gaps",
    section: "Coverage",
    metric: "Mandatory certificates missing",
    expected: expected.coverage_gaps.length,
    actual: gapIds.length,
    query:
      "for each seeded site × mandatory type, no live (non-superseded) row in " +
      "compliance_documents",
    actualIds: gapIds,
    expectedIds: expected.coverage_gaps.map((gap) => `${gap.store_id}:${gap.missing_type}`),
  });

  /* -- 8. reminders ------------------------------------------------------ */

  const ruleRows = (await db
    .select({
      id: reminderRules.id,
      subjectId: reminderRules.subjectId,
      stepKey: reminderRules.stepKey,
      status: reminderRules.status,
      nextSendAt: reminderRules.nextSendAt,
      sendsCount: reminderRules.sendsCount,
      repeatCap: reminderRules.repeatCap,
    })
    .from(reminderRules)
    .where(
      and(
        eq(reminderRules.organisationId, org),
        eq(reminderRules.subjectType, "certificate"),
        like(reminderRules.subjectId, prefix),
      ),
    )) as Array<{
    id: string;
    subjectId: string;
    stepKey: string | null;
    status: string;
    nextSendAt: string | null;
    sendsCount: number;
    repeatCap: number;
  }>;

  /*
   * `d90` in the database, `90` in the harness.
   *
   * `reminder_defaults` names its steps `d90`…`overdue`; §3.3 and `./expected.ts`
   * name them `90`…`overdue`. One leading letter, mapped in one place rather
   * than in six comparisons.
   */
  const stepKeyOf = (raw: string | null): string =>
    (raw ?? "").replace(/^d(?=\d)/, "") || "unknown";

  const pendingByStep: Record<string, number> = {};
  const dueTodayByStep: Record<string, number> = {};
  const sentByStep: Record<string, number> = {};
  const cascadeSubjects = new Set<string>();
  let overdueEscalations = 0;
  let capReached = 0;

  for (const rule of ruleRows) {
    cascadeSubjects.add(rule.subjectId);
    const step = stepKeyOf(rule.stepKey);
    const status = (rule.status ?? "").trim().toLowerCase();
    const day = rule.nextSendAt ? rule.nextSendAt.slice(0, 10) : null;
    const distance = day ? dayOffset(today, day) : Number.NaN;

    if (status === "sent" || status === "acknowledged") increment(sentByStep, step);
    else if (distance === 0) increment(dueTodayByStep, step);
    else increment(pendingByStep, step);

    if (step === "overdue") {
      overdueEscalations += Number(rule.sendsCount ?? 0);
      if (Number(rule.sendsCount ?? 0) >= Number(rule.repeatCap ?? 0)) capReached += 1;
    }
  }

  const sum = (counts: Record<string, number>) =>
    Object.values(counts).reduce((total, value) => total + value, 0);

  add({
    key: "reminders.cascade_certificates",
    section: "Reminders",
    metric: "Certificates with a cascade",
    expected: expected.reminders.cascade_certificates,
    actual: cascadeSubjects.size,
    query: "COUNT(DISTINCT subject_id) FROM reminder_rules WHERE subject_type = 'certificate'",
  });
  add({
    key: "reminders.pending_total",
    section: "Reminders",
    metric: "Pending",
    expected: expected.reminders.pending_total,
    actual: sum(pendingByStep),
    query: "reminder_rules.status = 'pending' AND next_send_at is later than today",
  });
  add({
    key: "reminders.due_today",
    section: "Reminders",
    metric: "Due today",
    expected: expected.reminders.due_today,
    actual: sum(dueTodayByStep),
    query: "reminder_rules.status = 'pending' AND date(next_send_at) = today",
  });
  add({
    key: "reminders.sent_total",
    section: "Reminders",
    metric: "Already sent",
    expected: expected.reminders.sent_total,
    actual: sum(sentByStep),
    query: "reminder_rules.status IN ('sent', 'acknowledged')",
  });
  for (const step of Object.keys(expected.reminders.by_step)) {
    add({
      key: `reminders.pending.${step}`,
      section: "Reminders by step",
      metric: `Pending — ${step}`,
      expected: expected.reminders.by_step[step],
      actual: pendingByStep[step] ?? 0,
      query: `reminder_rules WHERE step_key IN ('${step}', 'd${step}') AND status = 'pending'`,
    });
    add({
      key: `reminders.sent.${step}`,
      section: "Reminders by step",
      metric: `Sent — ${step}`,
      expected: expected.reminders.sent_by_step[step],
      actual: sentByStep[step] ?? 0,
      query: `reminder_rules WHERE step_key IN ('${step}', 'd${step}') AND status = 'sent'`,
    });
    add({
      key: `reminders.due.${step}`,
      section: "Reminders by step",
      metric: `Due today — ${step}`,
      expected: expected.reminders.due_today_by_step[step],
      actual: dueTodayByStep[step] ?? 0,
      query: `reminder_rules WHERE step_key IN ('${step}', 'd${step}') AND date(next_send_at) = today`,
    });
  }
  add({
    key: "reminders.overdue_escalations",
    section: "Reminders",
    metric: "Overdue escalations already sent",
    expected: expected.reminders.overdue_escalations_total,
    actual: overdueEscalations,
    query: "SUM(sends_count) FROM reminder_rules WHERE step_key = 'overdue'",
  });
  add({
    key: "reminders.overdue_cap_reached",
    section: "Reminders",
    metric: "Overdue cascades at their cap",
    expected: expected.reminders.overdue_cap_reached,
    actual: capReached,
    query: "reminder_rules WHERE step_key = 'overdue' AND sends_count >= repeat_cap",
  });

  /* -- 9. §4.3 cross-section consistency --------------------------------- */

  const storeTotals = Object.values(perStore).reduce((total, entry) => total + entry.total, 0);
  add({
    key: "cross.per_store_sum",
    section: "Cross-section (§4.3)",
    metric: "Per-store certificate totals sum to the portfolio total",
    expected: certificateRows.length,
    actual: storeTotals,
    query: "GROUP BY site_id, summed — a multi-store certificate would double-count here",
  });
  add({
    key: "cross.per_store_expired",
    section: "Cross-section (§4.3)",
    metric: "Per-store expired counts sum to the portfolio expired count",
    expected: bandCounts.expired ?? 0,
    actual: Object.values(perStore).reduce((total, entry) => total + entry.expired, 0),
    query: "a store's RAG score must derive only from its own certificates",
  });
  add({
    key: "cross.bands_account_for_all",
    section: "Cross-section (§4.3)",
    metric: "Every certificate is in exactly one band",
    expected: certificateRows.length,
    actual: sum(bandCounts),
    query: "SUM over the band histogram",
  });
  add({
    key: "cross.offsets_account_for_all",
    section: "Cross-section (§4.3)",
    metric: "Every certificate is at exactly one offset",
    expected: certificateRows.length,
    actual: sum(offsetCounts),
    query: "SUM over the offset histogram",
  });
  add({
    key: "cross.statuses_account_for_all",
    section: "Cross-section (§4.3)",
    metric: "Every job is in exactly one status bucket",
    expected: jobRows.length,
    actual: sum(statusCounts),
    query: "SUM over the status histogram",
  });
  add({
    key: "cross.sla_accounts_for_all",
    section: "Cross-section (§4.3)",
    metric: "Every job is in exactly one SLA bucket",
    expected: jobRows.length,
    actual:
      breached + approaching + within + Object.values(excluded).reduce((a, b) => a + b, 0),
    query: "breached + approaching + within + excluded",
    note: "A job in no bucket is a job nobody is reporting on.",
  });
  add({
    key: "cross.overdue_is_breached",
    section: "Cross-section (§4.3)",
    metric: "The overdue overlay and the SLA table agree",
    expected: overdueIds.length,
    actual: breached,
    query: "jobIsOverdue() against the SLA breach count — two views of one measurement",
  });
  add({
    key: "cross.open_including_unmapped",
    section: "Cross-section (§4.3)",
    metric: "Open jobs by the app's wider rule (unmapped counted open)",
    expected: expected.totals.jobs_open + expected.totals.jobs_unmapped_status,
    actual: openIncludingUnmapped,
    query: "jobChipAppearance().countsAsOpen, which returns true for an unmapped status",
    note:
      "A DOCUMENTED DIVERGENCE, asserted rather than hidden. jobChipAppearance() " +
      "counts an unmapped status as open on purpose, so a job with a status " +
      "nobody has mapped stays visible instead of disappearing; expected.ts " +
      "reports unmapped jobs separately. Both are right about different " +
      "questions, and this row is where the difference is stated as an identity.",
  });
  add({
    key: "cross.reminder_states_disjoint",
    section: "Cross-section (§4.3)",
    metric: "Every cascade step is in exactly one state",
    expected: expected.reminders.cascade_certificates * Object.keys(expected.reminders.by_step).length,
    actual: ruleRows.length,
    query: "pending + due today + sent = one row per step per cascading certificate",
  });

  /*
   * §4.3: "Reminders marked pending = reminder rows the cron would select for
   * the same window." Asked of the CRON'S OWN SELECT — `listDueReminders` is
   * the function `/api/cron/reminders` calls — rather than of a second query
   * shaped like it. A limit is passed because that function is bounded; the
   * seeded estate is 288 rules, so 2000 cannot truncate the answer.
   */
  const endOfToday = `${today}T23:59:59.999Z`;
  const dueByCron = (await listDueReminders(db, endOfToday, 2000)) as Array<{
    subjectId: string;
    subjectType: string;
  }>;
  add({
    key: "cross.cron_selection",
    section: "Cross-section (§4.3)",
    metric: "The cron would select exactly the reminders marked due today",
    expected: expected.reminders.due_today,
    actual: dueByCron.filter(
      (rule) => rule.subjectType === "certificate" && rule.subjectId.startsWith(SEED_ID_PREFIX),
    ).length,
    query:
      "listDueReminders(db, end of today) — the same select /api/cron/reminders runs, " +
      "filtered to seeded certificate subjects",
  });

  const summary = summarise(rows);
  return {
    ranAt: new Date().toISOString(),
    today,
    seedBatchId: expected.seed_batch_id,
    organisationId: org,
    rows,
    seeded: certificateRows.length > 0 || jobRows.length > 0,
    ...summary,
  };
}
