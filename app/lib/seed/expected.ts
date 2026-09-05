/**
 * THE INDEPENDENT SOURCE OF TRUTH — §4.
 *
 * *** DO NOT IMPORT ANY APPLICATION MODULE INTO THIS FILE. ***
 * *** NOT app/lib/reporting/*. NOT app/lib/reminders/*. NOT A DASHBOARD ***
 * *** QUERY, NOT A VIEW HELPER, NOT scopedDb, NOT certificateExpiryBand. ***
 *
 * Module 3 §4 states the reason in one sentence and it is the reason this file
 * exists at all: "If the dashboard computes a number and you check it using the
 * same code that produced it, you have tested nothing." Everything below counts
 * the seeded dataset DIRECTLY. If a later edit tidies one of these loops into a
 * call to the helper the product already has, the harness keeps passing and
 * stops meaning anything, and nobody will notice for months.
 *
 * The same rule applies inside this repository's own seed module. Note in
 * particular what is NOT read off a certificate row:
 *
 *   · `matrixOffsetDays` is IGNORED. The offset is re-derived from the stored
 *     `expiryDate` and `today`, with a date parser written differently from the
 *     one in `dataset.ts`. That is deliberate. If `addDays` in the generator is
 *     a day out, reading the intended offset back off the row would cancel the
 *     error out and every band would still balance; re-deriving it makes the
 *     mistake show up as a band count that does not match the matrix, which is
 *     the failure §4.3 calls the highest-value assertion in the harness.
 *   · `statusIsMapped` is IGNORED for the same reason — the label is looked up
 *     in the catalogue instead, so a row that claims to be mapped and is not
 *     is caught rather than believed.
 *
 * ── THE BANDS ARE RESTATED, NOT IMPORTED ───────────────────────────────────
 *
 * `certificateExpiryBand()` in `app/(app)/portal/calendar-item-types.ts` is the
 * APPLICATION's ladder. `certificateBand()` below is the SPECIFICATION's,
 * transcribed from the §3.3 table. They are expected to agree, and
 * `tests/pre-w14-seed-reconcile.test.mjs` asserts that they do — which is only
 * evidence because the two were written apart. One documented divergence: the
 * application has no `superseded` state, because supersession is a fact about
 * the row (`renewal_status`) and not about the date, so it returns `Expired`
 * for a superseded certificate 120 days past its expiry. That is recorded in
 * the test rather than papered over here.
 *
 * ── WHY `generated_at` IS NOT A WALL CLOCK ─────────────────────────────────
 *
 * §7 requires two consecutive runs to produce byte-identical output. A real
 * timestamp in the payload would break that on the first run and the acceptance
 * criterion would have to be weakened to "identical apart from the timestamp",
 * which is the kind of exception that eventually hides a real difference. So
 * `generated_at` is midnight UTC on the `today` the dataset was built for: it
 * still says which day the numbers describe, and it says it reproducibly.
 */

import type { SeedCertificate, SeedDataset, SeedJob } from "./dataset";

/* --------------------------------------------------- independent date maths -- */

/**
 * A second, deliberately different parser.
 *
 * `dataset.ts` builds its milliseconds with `Date.UTC(y, m - 1, d)` after
 * splitting the string; this one hands the whole ISO string to `Date.parse`
 * with an explicit UTC time part. Two formulations of the same thing is the
 * cheapest available insurance against one bug living in both halves of a
 * comparison.
 */
function utcMs(iso: string): number {
  const parsed = Date.parse(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) throw new Error(`expected-values: unparseable date "${iso}"`);
  return parsed;
}

/** Whole days from `from` to `to`, negative when `to` is earlier. */
function dayOffset(from: string, to: string): number {
  return Math.round((utcMs(to) - utcMs(from)) / 86_400_000);
}

/* ------------------------------------------------------------- the bands -- */

export type CertificateBandKey =
  | "valid"
  | "d90"
  | "d60"
  | "d30"
  | "d14"
  | "expired"
  | "superseded"
  | "undated";

/**
 * §3.3's colour column, as words.
 *
 * Carried so a failing row can be reported in the specification's own
 * vocabulary — "expected Yellow, got Orange" is diagnosable; "expected d90, got
 * d60" sends the reader back to the table to find out which is which.
 */
export const CERTIFICATE_BAND_COLOUR: Readonly<Record<CertificateBandKey, string>> = {
  valid: "Grey",
  d90: "Yellow",
  d60: "Orange",
  d30: "Red",
  d14: "Dark red",
  expired: "Expired",
  superseded: "Superseded",
  undated: "No expiry recorded",
};

/**
 * The band a certificate is in, from the §3.3 table and nothing else.
 *
 * The comparisons are written as `<=` against the window's own number so that
 * the edges land where the specification says: 90 is INSIDE the 90 window and
 * 91 is outside it; 14 is inside the urgent window and 15 is outside it; 0 is
 * expiring, not expired, and −1 is expired. Every one of those five edges is
 * asserted individually in the test.
 *
 * Supersession is checked FIRST, because it is a fact about the row rather than
 * about the date: §3.3 marks the −120 rows "renewed, cascade cancelled", and a
 * renewed certificate that is also 120 days past its expiry is not an
 * outstanding compliance failure — it is history, and counting it as expired
 * would overstate the client's exposure on every screen that shows the number.
 */
export function certificateBand(
  daysToExpiry: number | null,
  superseded: boolean,
): CertificateBandKey {
  if (superseded) return "superseded";
  if (daysToExpiry === null) return "undated";
  if (daysToExpiry < 0) return "expired";
  if (daysToExpiry <= 14) return "d14";
  if (daysToExpiry <= 30) return "d30";
  if (daysToExpiry <= 60) return "d60";
  if (daysToExpiry <= 90) return "d90";
  return "valid";
}

/* ------------------------------------------------------------- the shape -- */

export type ExpectedTotals = {
  readonly stores: number;
  readonly users: number;
  readonly contacts: number;
  readonly contractors: number;
  readonly jobs: number;
  readonly certificates: number;
  readonly notes: number;
  readonly planned_visits: number;
  readonly attachments: number;
  readonly jobs_open: number;
  readonly jobs_completed: number;
  readonly jobs_overdue: number;
  readonly jobs_unscheduled: number;
  readonly jobs_unassigned: number;
  /** Not in §4.1. §3.4 asks for three, and a number nobody emits is a number nobody checks. */
  readonly jobs_unmapped_status: number;
};

export type ExpectedCertificateWindows = Readonly<Record<CertificateBandKey, number>>;

export type ExpectedCoverageGap = {
  readonly store_id: string;
  readonly missing_type: string;
};

export type ExpectedReminderStepCounts = Readonly<Record<string, number>>;

export type ExpectedReminders = {
  readonly pending_total: number;
  readonly due_today: number;
  readonly sent_total: number;
  /** Pending occurrences per step — strictly in the future. */
  readonly by_step: ExpectedReminderStepCounts;
  readonly due_today_by_step: ExpectedReminderStepCounts;
  readonly sent_by_step: ExpectedReminderStepCounts;
  /** §3.3's "2 escalations sent" and "cap reached", as numbers. */
  readonly overdue_escalations_total: number;
  readonly overdue_cap_reached: number;
  /** Certificates the cascade runs on at all. */
  readonly cascade_certificates: number;
};

export type ExpectedSla = {
  readonly breached: number;
  readonly approaching: number;
  readonly within: number;
  /** Measured, or honestly excluded. Never estimated. */
  readonly excluded: number;
  readonly excluded_by_reason: Readonly<Record<string, number>>;
};

export type ExpectedValues = {
  readonly generated_at: string;
  readonly seed_batch_id: string;
  readonly today: string;
  readonly totals: ExpectedTotals;
  readonly certificates_by_window: ExpectedCertificateWindows;
  readonly certificates_by_store: Readonly<
    Record<string, { readonly total: number; readonly expired: number }>
  >;
  /** Keyed by the re-derived offset, so §3.3 can be compared line by line. */
  readonly certificates_by_offset: Readonly<Record<string, number>>;
  readonly coverage_gaps: readonly ExpectedCoverageGap[];
  readonly reminders: ExpectedReminders;
  readonly jobs_by_status: Readonly<Record<string, number>>;
  readonly sla: ExpectedSla;
  readonly cost_totals: {
    /** Pence is authoritative — money is stored as an integer in this product. */
    readonly certificates_pence: number;
    readonly certificates_gbp: number;
  };
};

/* ---------------------------------------------------------- the counting -- */

function increment(into: Record<string, number>, key: string, by = 1): void {
  into[key] = (into[key] ?? 0) + by;
}

/**
 * How many overdue escalations a certificate has already had.
 *
 * The overdue step fires 7 days after expiry and repeats every 7 days to a cap
 * of 8 — `REMINDER_DEFAULTS_SEED`'s numbers, restated as arithmetic rather than
 * read from the database. §3.3 asserts the answers this must give: 0 at −1
 * (`floor(1 / 7)`), 2 at −14, and the cap at −60, where `floor(60 / 7)` is 8
 * and the ninth send never happens.
 */
function overdueEscalations(
  daysToExpiry: number,
  intervalDays: number,
  cap: number,
): number {
  if (daysToExpiry >= 0) return 0;
  return Math.min(cap, Math.floor(-daysToExpiry / intervalDays));
}

/**
 * Every number the reconciliation page compares the application against.
 *
 * `today` is passed separately from the dataset on purpose: `seed:travel`
 * evaluates yesterday's dataset against a later day, and a function that read
 * `dataset.today` could not express that at all.
 */
export function computeExpectedValues(dataset: SeedDataset, today: string): ExpectedValues {
  utcMs(today); /* Fail here rather than 200 lines in. */

  /* -- the status catalogue, as the harness understands it ---------------- */

  const openLabels = new Set(
    dataset.jobStatusCatalogue.mapped
      .filter((entry) => entry.countsAsOpen)
      .map((entry) => entry.label),
  );
  const mappedLabels = new Set(dataset.jobStatusCatalogue.mapped.map((entry) => entry.label));

  /* -- certificates ------------------------------------------------------- */

  const byWindow: Record<CertificateBandKey, number> = {
    valid: 0,
    d90: 0,
    d60: 0,
    d30: 0,
    d14: 0,
    expired: 0,
    superseded: 0,
    undated: 0,
  };
  const byOffset: Record<string, number> = {};
  const byStore: Record<string, { total: number; expired: number }> = {};
  for (const store of dataset.stores) byStore[store.id] = { total: 0, expired: 0 };

  /* store id -> mandatory kinds that have a live certificate. */
  const covered = new Map<string, Set<string>>();
  let certificatePence = 0;

  const offsetOf = (certificate: SeedCertificate): number | null =>
    certificate.expiryDate === null ? null : dayOffset(today, certificate.expiryDate);

  for (const certificate of dataset.certificates) {
    const offset = offsetOf(certificate);
    const superseded = certificate.renewalStatus === "superseded";
    const band = certificateBand(offset, superseded);

    byWindow[band] += 1;
    increment(byOffset, offset === null ? "undated" : String(offset));
    certificatePence += certificate.costPence;

    const store = byStore[certificate.storeId];
    if (store) {
      store.total += 1;
      if (band === "expired") store.expired += 1;
    }

    /*
     * Coverage is "does a certificate exist at all", per §3.3. An EXPIRED
     * certificate still counts: the store has one, it is simply out of date,
     * and that is a different finding from having none. A SUPERSEDED one does
     * not, because its successor is the live document and counting both would
     * let a store be covered by nothing but history.
     */
    if (!superseded && dataset.mandatoryCertificateTypes.includes(certificate.kind)) {
      const kinds = covered.get(certificate.storeId) ?? new Set<string>();
      kinds.add(certificate.kind);
      covered.set(certificate.storeId, kinds);
    }
  }

  const coverageGaps: ExpectedCoverageGap[] = [];
  for (const store of dataset.stores) {
    const held = covered.get(store.id) ?? new Set<string>();
    for (const kind of dataset.mandatoryCertificateTypes) {
      if (!held.has(kind)) coverageGaps.push({ store_id: store.id, missing_type: kind });
    }
  }

  /* -- reminders ---------------------------------------------------------- */

  /*
   * ONE occurrence per step per certificate, repeats NOT expanded.
   *
   * `reminder_rules` holds one row per step with `next_send_at`, `sends_count`
   * and `repeat_cap`, so a repeating step is one row that moves rather than
   * eight rows scheduled in advance. Expanding the repeats here would emit a
   * pending total in the hundreds that no table in the database could ever
   * match, which is the wrong kind of independence: the harness must count the
   * same THINGS as the application, by different means.
   *
   * A superseded certificate contributes nothing — §3.3 says its cascade is
   * cancelled — and neither does an undated one, which has no anchor to
   * measure from.
   */
  const cascade = dataset.certificates.filter(
    (certificate) => certificate.expiryDate !== null && certificate.renewalStatus !== "superseded",
  );

  const pendingByStep: Record<string, number> = {};
  const dueTodayByStep: Record<string, number> = {};
  const sentByStep: Record<string, number> = {};
  for (const step of dataset.reminderSteps) {
    pendingByStep[step.key] = 0;
    dueTodayByStep[step.key] = 0;
    sentByStep[step.key] = 0;
  }

  let overdueEscalationsTotal = 0;
  let overdueCapReached = 0;

  for (const certificate of cascade) {
    const offset = offsetOf(certificate) as number;
    for (const step of dataset.reminderSteps) {
      /*
       * The occurrence sits `step.offsetDays` from the expiry, so its distance
       * from today is the certificate's own offset plus the step's. Derived
       * this way rather than by adding days to a date string a second time: one
       * subtraction is easier to reason about at an edge than two additions.
       */
      const daysFromToday = offset + step.offsetDays;
      if (daysFromToday > 0) pendingByStep[step.key] += 1;
      else if (daysFromToday === 0) dueTodayByStep[step.key] += 1;
      else sentByStep[step.key] += 1;
    }
    const escalations = overdueEscalations(offset, 7, 8);
    overdueEscalationsTotal += escalations;
    if (escalations >= 8) overdueCapReached += 1;
  }

  const sum = (counts: Record<string, number>) =>
    Object.values(counts).reduce((total, value) => total + value, 0);

  /* -- jobs --------------------------------------------------------------- */

  const byStatus: Record<string, number> = {};
  let jobsOpen = 0;
  let jobsCompleted = 0;
  let jobsOverdue = 0;
  let jobsUnscheduled = 0;
  let jobsUnassigned = 0;
  let jobsUnmapped = 0;

  let breached = 0;
  let approaching = 0;
  let within = 0;
  const excludedByReason: Record<string, number> = {};

  const isOpen = (job: SeedJob) => openLabels.has(job.status);

  for (const job of dataset.jobs) {
    increment(byStatus, job.status);

    if (!mappedLabels.has(job.status)) {
      jobsUnmapped += 1;
      increment(excludedByReason, "unmapped-status");
      continue;
    }

    if (job.status === "Completed") jobsCompleted += 1;

    if (!isOpen(job)) {
      increment(excludedByReason, "closed");
      continue;
    }

    jobsOpen += 1;
    if (job.scheduledDate === null) jobsUnscheduled += 1;
    if (job.assignee === null) jobsUnassigned += 1;

    if (job.dueAt === null) {
      increment(excludedByReason, "no-deadline");
      continue;
    }

    const remaining = dayOffset(today, job.dueAt);
    const window = dayOffset(job.raisedAt, job.dueAt);

    if (remaining < 0) {
      jobsOverdue += 1;
      breached += 1;
      continue;
    }
    if (window <= 0) {
      /* A deadline on or before the day the job was raised measures nothing. */
      increment(excludedByReason, "zero-window");
      continue;
    }
    /*
     * "Approaching" is `remaining <= 25% of the window`, inclusive, because
     * §3.4 seeds four jobs at EXACTLY a quarter and calls them the trigger.
     * An exclusive comparison would seed the trigger and then not fire it.
     */
    if (remaining * 4 <= window) approaching += 1;
    else within += 1;
  }

  return {
    generated_at: `${dataset.today}T00:00:00.000Z`,
    seed_batch_id: dataset.seedBatchId,
    today,
    totals: {
      stores: dataset.stores.length,
      users: dataset.users.length,
      contacts: dataset.contacts.length,
      contractors: dataset.contractors.length,
      jobs: dataset.jobs.length,
      certificates: dataset.certificates.length,
      notes: dataset.notes.length,
      planned_visits: dataset.plannedVisits.length,
      attachments: dataset.attachments.length,
      jobs_open: jobsOpen,
      jobs_completed: jobsCompleted,
      jobs_overdue: jobsOverdue,
      jobs_unscheduled: jobsUnscheduled,
      jobs_unassigned: jobsUnassigned,
      jobs_unmapped_status: jobsUnmapped,
    },
    certificates_by_window: byWindow,
    certificates_by_store: byStore,
    certificates_by_offset: byOffset,
    coverage_gaps: coverageGaps,
    reminders: {
      pending_total: sum(pendingByStep),
      due_today: sum(dueTodayByStep),
      sent_total: sum(sentByStep),
      by_step: pendingByStep,
      due_today_by_step: dueTodayByStep,
      sent_by_step: sentByStep,
      overdue_escalations_total: overdueEscalationsTotal,
      overdue_cap_reached: overdueCapReached,
      cascade_certificates: cascade.length,
    },
    jobs_by_status: byStatus,
    sla: {
      breached,
      approaching,
      within,
      excluded: sum(excludedByReason),
      excluded_by_reason: excludedByReason,
    },
    cost_totals: {
      certificates_pence: certificatePence,
      certificates_gbp: Math.round(certificatePence) / 100,
    },
  };
}
