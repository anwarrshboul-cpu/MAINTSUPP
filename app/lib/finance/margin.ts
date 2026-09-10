/**
 * §8 — MARGIN, AND THE UNBILLED WORK ALERT.
 *
 * "For every job, hold both sides: cost in — total payable invoices allocated
 * to the job; charged out — receivable amount attributable to the job; margin =
 * charged out − cost in, and margin %. Roll that up by job, site, client,
 * category, contractor and period."
 *
 * ── THE UNIT OF MARGIN IS THE JOB, AND EVERY ROLL-UP IS A ROLL-UP OF JOBS ──
 *
 * §8 opens with "for every job", and every other grouping is that number
 * aggregated. So both sides of the ledger reach this file through
 * `invoice_job_alloc` — the table §4 exists to fill — and never through an
 * invoice's own site or counterparty. An invoice covering four jobs at one site
 * contributes its four allocated shares to four jobs, which is the entire
 * reason the August report's "costs sitting on the first line of a multi-task
 * visit" was a defect worth fixing.
 *
 * ── WHAT EACH `groupBy` KEYS ON, WRITTEN DOWN ONCE ─────────────────────────
 *
 *   job         the job itself.
 *   site        the JOB's site. Not the invoice's — §15.11 is "client
 *               profitability by site" and the site that matters is where the
 *               work happened.
 *   client      the receivable counterparty attributed to the job. A job with
 *               no receivable at all groups under `unbilled`, which is not a
 *               tidy-up: it is §8's alert, showing as its own row with a cost
 *               and no charge.
 *   category    the CONTRIBUTING INVOICE's §4 category, falling back to the
 *               job's own category. This is the one grouping keyed on the
 *               invoice rather than the job, and deliberately: electrical cost
 *               and fire cost on one job are two categories of spend, and
 *               folding them onto the job's single label would hide that. A job
 *               therefore counts once in each category it has money in — the
 *               `jobs` count is distinct WITHIN a row, never across them.
 *   contractor  the JOB's contractor, falling back to the payable invoice's
 *               counterparty where the job names none. §8: "Contractor cost per
 *               job type, so you can see who is expensive." Keying the charge
 *               side on the same job keeps both halves of one job's margin with
 *               the same contractor.
 *   period      `YYYY-MM` of the job's completion date, falling back to when it
 *               was raised. The JOB's month, not the invoice's, so a cost
 *               invoiced in March and a charge raised in April stay in the same
 *               period and the margin is a margin rather than two halves in two
 *               columns.
 *
 * ── MARGIN PERCENT OVER A ZERO DENOMINATOR IS NULL, NOT −100% ──────────────
 *
 * Margin % is `margin ÷ charged out`. With nothing charged out there is no
 * denominator, and the honest answer is "unknown". Returning −100% would put
 * unbilled work — the thing §8 calls the highest-value alert in the module — at
 * the bottom of a sorted list beside genuinely loss-making jobs, and it is not
 * the same thing at all: one is work sold too cheaply and the other is work
 * nobody has invoiced yet. `coverage` is what tells the two apart.
 *
 * This file imports only `./model`; the SQL lives in the routes. See the header
 * of `./ageing.ts` for why.
 */

import { dayOf, financeCategoryKey, type InvoiceDirection } from "./model";

export const MARGIN_GROUPINGS = [
  "job",
  "site",
  "client",
  "category",
  "contractor",
  "period",
] as const;
export type MarginGrouping = (typeof MARGIN_GROUPINGS)[number];

export function isMarginGrouping(value: unknown): value is MarginGrouping {
  return typeof value === "string" && (MARGIN_GROUPINGS as readonly string[]).includes(value);
}

/** One `invoice_job_alloc` row, with the little of its invoice that matters. */
export interface MarginAllocation {
  requestId: string;
  direction: InvoiceDirection;
  /** The allocated share, in pence. §4: the split sums to the invoice NET. */
  amountPence: number;
  invoiceCategory: string | null;
  invoiceCounterpartyId: string | null;
  invoiceCounterpartyName: string | null;
}

/** One job, with the attributes every grouping keys on. */
export interface MarginJob {
  requestId: string;
  reference: string | null;
  title: string | null;
  siteId: string | null;
  siteName: string | null;
  contractorId: string | null;
  contractorName: string | null;
  /** The job's own category — the board's job type, not §4's accounting list. */
  category: string | null;
  /** `YYYY-MM-DD` or an instant; only the day is read. */
  completedAt: string | null;
  requestedAt: string | null;
  complete: boolean;
}

export interface MarginRow {
  key: string;
  label: string;
  costInPence: number;
  chargedOutPence: number;
  marginPence: number;
  /** `margin ÷ charged out`, to one decimal. NULL when nothing is charged out. */
  marginPercent: number | null;
  /** §8's "recovery rate: charged out ÷ cost in". NULL when nothing was spent. */
  recoveryRatePercent: number | null;
  /** Distinct jobs contributing to THIS row. */
  jobs: number;
  /** Of those, how many carry any charged-out amount. */
  jobsCharged: number;
  /**
   * `jobsCharged ÷ jobs`, 0…1 — how much of this row has actually been billed,
   * and therefore how much of its margin means anything. A site with twenty
   * jobs and three invoices reads 0.15, and its margin is a partial picture
   * rather than a result.
   */
  coverage: number;
  /** §8: "jobs where cost in exceeds charged out — loss-making work". */
  lossMaking: boolean;
}

export interface MarginTotals {
  costInPence: number;
  chargedOutPence: number;
  marginPence: number;
  marginPercent: number | null;
  recoveryRatePercent: number | null;
  jobs: number;
  jobsCharged: number;
  coverage: number;
}

export interface MarginReport {
  groupBy: MarginGrouping;
  rows: MarginRow[];
  totals: MarginTotals;
}

interface Bucket {
  key: string;
  label: string;
  costInPence: number;
  chargedOutPence: number;
  jobs: Set<string>;
  chargedJobs: Set<string>;
}

/**
 * The roll-up. Pure, and the only place a margin figure is decided.
 *
 * Sorted by margin ASCENDING — the worst first. §8's list of things to look at
 * opens with "jobs where cost in exceeds charged out", and a report that puts
 * the most profitable work at the top buries exactly the rows it was built to
 * surface. Ties fall back to cost (the biggest exposure) and then to the label,
 * so two calls over the same data return the same order.
 */
export function marginRollup(
  jobs: readonly MarginJob[],
  allocations: readonly MarginAllocation[],
  groupBy: MarginGrouping,
): MarginReport {
  const jobsById = new Map<string, MarginJob>();
  for (const job of jobs) jobsById.set(job.requestId, job);

  /* The client key needs to know, before any bucket is opened, which
     counterparty a job's receivables belong to — so one pass settles it. A job
     billed to two clients keeps the first by name order, which is stable rather
     than arbitrary, and is vanishingly rare on this estate. */
  const clientOf = new Map<string, { id: string; name: string }>();
  for (const allocation of allocations) {
    if (allocation.direction !== "receivable") continue;
    const name = (allocation.invoiceCounterpartyName ?? "").trim();
    const id = (allocation.invoiceCounterpartyId ?? "").trim() || (name ? `name:${name.toLowerCase()}` : "");
    if (!id) continue;
    const existing = clientOf.get(allocation.requestId);
    if (!existing || (name && name.localeCompare(existing.name) < 0)) {
      clientOf.set(allocation.requestId, { id, name: name || id });
    }
  }

  const buckets = new Map<string, Bucket>();

  for (const allocation of allocations) {
    const amountPence = Math.trunc(allocation.amountPence || 0);
    const job = jobsById.get(allocation.requestId);
    const placed = placement(groupBy, allocation, job, clientOf.get(allocation.requestId));
    if (!placed) continue;

    let bucket = buckets.get(placed.key);
    if (!bucket) {
      bucket = {
        key: placed.key,
        label: placed.label,
        costInPence: 0,
        chargedOutPence: 0,
        jobs: new Set(),
        chargedJobs: new Set(),
      };
      buckets.set(placed.key, bucket);
    }

    bucket.jobs.add(allocation.requestId);
    if (allocation.direction === "payable") {
      bucket.costInPence += amountPence;
    } else {
      bucket.chargedOutPence += amountPence;
      if (amountPence > 0) bucket.chargedJobs.add(allocation.requestId);
    }
  }

  const rows = [...buckets.values()]
    .map((bucket) => {
      const marginPence = bucket.chargedOutPence - bucket.costInPence;
      return {
        key: bucket.key,
        label: bucket.label,
        costInPence: bucket.costInPence,
        chargedOutPence: bucket.chargedOutPence,
        marginPence,
        marginPercent: percentOf(marginPence, bucket.chargedOutPence),
        recoveryRatePercent: percentOf(bucket.chargedOutPence, bucket.costInPence),
        jobs: bucket.jobs.size,
        jobsCharged: bucket.chargedJobs.size,
        coverage: bucket.jobs.size === 0 ? 0 : bucket.chargedJobs.size / bucket.jobs.size,
        lossMaking: bucket.costInPence > bucket.chargedOutPence,
      } satisfies MarginRow;
    })
    .sort(
      (a, b) =>
        a.marginPence - b.marginPence
        || b.costInPence - a.costInPence
        || a.label.localeCompare(b.label),
    );

  /*
   * TOTALS ARE COMPUTED OVER THE JOBS, NOT BY ADDING THE ROWS UP.
   *
   * Under `groupBy=category` one job can appear in two rows, so summing the
   * rows' job counts would report more jobs than exist. The money is safe to
   * add either way — an allocation lands in exactly one bucket — but the counts
   * are not, and a total that disagrees with its own rows is worse than no
   * total.
   */
  const totalCost = allocations
    .filter((row) => row.direction === "payable")
    .reduce((sum, row) => sum + Math.trunc(row.amountPence || 0), 0);
  const totalCharged = allocations
    .filter((row) => row.direction === "receivable")
    .reduce((sum, row) => sum + Math.trunc(row.amountPence || 0), 0);
  const touchedJobs = new Set(allocations.map((row) => row.requestId));
  const chargedJobs = new Set(
    allocations
      .filter((row) => row.direction === "receivable" && Math.trunc(row.amountPence || 0) > 0)
      .map((row) => row.requestId),
  );
  const totalMargin = totalCharged - totalCost;

  return {
    groupBy,
    rows,
    totals: {
      costInPence: totalCost,
      chargedOutPence: totalCharged,
      marginPence: totalMargin,
      marginPercent: percentOf(totalMargin, totalCharged),
      recoveryRatePercent: percentOf(totalCharged, totalCost),
      jobs: touchedJobs.size,
      jobsCharged: chargedJobs.size,
      coverage: touchedJobs.size === 0 ? 0 : chargedJobs.size / touchedJobs.size,
    },
  };
}

/** Where one allocation lands, or null when this grouping cannot place it. */
function placement(
  groupBy: MarginGrouping,
  allocation: MarginAllocation,
  job: MarginJob | undefined,
  client: { id: string; name: string } | undefined,
): { key: string; label: string } | null {
  if (groupBy === "job") {
    const label = job?.reference?.trim() || job?.title?.trim() || allocation.requestId;
    return { key: allocation.requestId, label };
  }

  if (groupBy === "site") {
    const id = (job?.siteId ?? "").trim();
    if (!id) return { key: "site:unknown", label: "No site recorded" };
    return { key: id, label: job?.siteName?.trim() || id };
  }

  if (groupBy === "client") {
    /* §8's alert, as its own row rather than as an omission. */
    if (!client) return { key: "unbilled", label: "Not billed to a client" };
    return { key: client.id, label: client.name };
  }

  if (groupBy === "category") {
    const invoiceCategory = financeCategoryKey(allocation.invoiceCategory);
    const jobCategory = financeCategoryKey(job?.category);
    const key = invoiceCategory || jobCategory;
    if (!key) return { key: "uncategorised", label: "Uncategorised" };
    const label = (allocation.invoiceCategory ?? job?.category ?? key).toString().trim() || key;
    return { key, label };
  }

  if (groupBy === "contractor") {
    const jobContractor = (job?.contractorId ?? "").trim();
    if (jobContractor) {
      return { key: jobContractor, label: job?.contractorName?.trim() || jobContractor };
    }
    if (allocation.direction === "payable") {
      const name = (allocation.invoiceCounterpartyName ?? "").trim();
      const id = (allocation.invoiceCounterpartyId ?? "").trim() || (name ? `name:${name.toLowerCase()}` : "");
      if (id) return { key: id, label: name || id };
    }
    const fallbackName = (job?.contractorName ?? "").trim();
    if (fallbackName) return { key: `name:${fallbackName.toLowerCase()}`, label: fallbackName };
    return { key: "contractor:unknown", label: "No contractor recorded" };
  }

  /* period */
  const day = dayOf(job?.completedAt ?? null) ?? dayOf(job?.requestedAt ?? null);
  if (!day) return { key: "period:unknown", label: "No date recorded" };
  const month = day.slice(0, 7);
  return { key: month, label: month };
}

/**
 * `numerator ÷ denominator` as a percentage to one decimal, or null.
 *
 * NULL rather than zero, rather than −100, rather than Infinity. Every one of
 * those is a number a chart will happily plot as if it meant something.
 */
export function percentOf(numeratorPence: number, denominatorPence: number): number | null {
  const denominator = Math.trunc(denominatorPence || 0);
  if (denominator === 0) return null;
  return Math.round((Math.trunc(numeratorPence || 0) / denominator) * 1000) / 10;
}

/* ── §8's highest-value alert ─────────────────────────────────────────────── */

export interface UnbilledRow {
  requestId: string;
  reference: string | null;
  title: string | null;
  siteName: string | null;
  costInPence: number;
  completedAt: string | null;
}

export interface UnbilledReport {
  count: number;
  totalPence: number;
  rows: UnbilledRow[];
}

/**
 * §8 and §15.1 — "completed jobs with supplier costs but no client invoice,
 * with a total".
 *
 * THREE CONDITIONS, ALL REQUIRED, and each of them is doing work:
 *
 *   · COMPLETED. Work still in progress is not unbilled, it is unfinished, and
 *     listing it would bury the real alert under every open job on the board.
 *   · CARRIES A SUPPLIER COST. "Money already spent and not yet recovered" is
 *     the definition; a completed job nobody has spent anything on has nothing
 *     to recover.
 *   · NO CLIENT INVOICE AT ALL. Not "under-billed" — that is a margin question
 *     and §8 handles it separately. A single penny of receivable allocation
 *     takes a job off this list, because from here on the conversation is about
 *     whether the charge is right rather than whether one exists.
 *
 * Sorted by cost descending: the most exposed job first, which is the order
 * somebody clearing this list wants to work in.
 */
export function unbilledWork(
  jobs: readonly MarginJob[],
  allocations: readonly MarginAllocation[],
): UnbilledReport {
  const cost = new Map<string, number>();
  const charged = new Set<string>();
  for (const allocation of allocations) {
    const amountPence = Math.trunc(allocation.amountPence || 0);
    if (allocation.direction === "payable") {
      cost.set(allocation.requestId, (cost.get(allocation.requestId) ?? 0) + amountPence);
    } else if (amountPence !== 0) {
      charged.add(allocation.requestId);
    }
  }

  const rows: UnbilledRow[] = [];
  for (const job of jobs) {
    if (!job.complete) continue;
    if (charged.has(job.requestId)) continue;
    const costInPence = cost.get(job.requestId) ?? 0;
    if (costInPence <= 0) continue;
    rows.push({
      requestId: job.requestId,
      reference: job.reference,
      title: job.title,
      siteName: job.siteName,
      costInPence,
      completedAt: job.completedAt,
    });
  }

  rows.sort((a, b) => b.costInPence - a.costInPence || a.requestId.localeCompare(b.requestId));
  return {
    count: rows.length,
    totalPence: rows.reduce((sum, row) => sum + row.costInPence, 0),
    rows,
  };
}
