/**
 * THE THREE-WAY MATCH — §7, "the reason to build this rather than a spreadsheet".
 *
 * Quote or PO (was this approved, and at what price?), job (is it complete, and
 * does the site match?), invoice (what is being billed?). Eight findings come
 * out, they are reconciled into `invoice_flags`, and the open blocking ones stop
 * "Approved for payment" until they are cleared or waived with a typed reason.
 *
 * ── RECONCILED, NEVER REPLACED ─────────────────────────────────────────────
 *
 * The engine does NOT delete and rewrite. A flag row can be WAIVED, and a
 * waiver carries an author, a typed reason and a time — none of which survives
 * a delete. So:
 *
 *   · a finding with no row            -> insert, `open`
 *   · a finding whose row is `open`    -> refresh its detail
 *   · a finding whose row is `cleared` -> re-open it; the cause came back
 *   · a finding whose row is `waived`  -> LEAVE IT. A waiver is a decision a
 *                                         person took about this exact cause.
 *   · a row whose cause has gone       -> `cleared`, with a timestamp
 *
 * Nothing here deletes a row, ever.
 *
 * ── A CHECK THAT CANNOT BE EVALUATED IS NOT A CHECK THAT PASSED ────────────
 *
 * `matchInvoice` returns the findings AND the list of checks it actually
 * evaluated, and reconciliation only clears flags of types in that list. The
 * distinction is load-bearing for `vat_anomaly`: a supplier's VAT registration
 * is recorded NOWHERE in this schema (`contractors` has no `vat_number`
 * column), so on a payable that check is skipped — and if it merely returned
 * "no finding", reconciliation would silently CLEAR a flag somebody had raised
 * by hand. Skipped means untouched.
 *
 * ── WHAT `vat_anomaly` AND `outside_agreement` KEY ON ──────────────────────
 *
 * Both are spelled out where they are computed — `vatAnomalyFinding` below and
 * `outsideAgreement` in `./rules.ts`. Neither guesses. §7's literal wording
 * asks for facts this schema does not record, and inventing them would put an
 * unfounded block on a real payment.
 */

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { getDb } from "../../../db";
import {
  contractors,
  invoiceFlags,
  invoices,
  maintenanceRequests,
  quotations,
  sites,
} from "../../../db/schema";
import { COMPLETED_STAGE, statusFamily, UNASSIGNED_SITE_ID } from "../job-metrics";
import { selectInChunks } from "../sql-batching";
import { listAllocations } from "./allocations";
import {
  dayOf,
  financeDay,
  hasLinkedJob,
  quoteStatusKey,
  type FinanceFlagType,
  type InvoiceDirection,
} from "./model";
import { readFinanceSettings, type FinanceSettings } from "./settings";
import {
  DEFAULT_FLAG_SEVERITY,
  comparableAmount,
  counterpartyKey,
  duplicateFinding,
  outsideAgreement,
  overQuote,
  referenceKey,
  type DuplicateCandidate,
} from "./rules";

type Database = Awaited<ReturnType<typeof getDb>>;

/* Pure, and re-exported for the same reason as everywhere else in this module —
   see the header of `./rules.ts`. */
export { blockingFlags, DEFAULT_FLAG_SEVERITY, type FlagLike } from "./rules";

export interface MatchFinding {
  flagType: FinanceFlagType;
  severity: "blocking" | "warning";
  detail: string;
}

export interface MatchResult {
  findings: MatchFinding[];
  /** The checks that ran. A type absent from here was NOT evaluated — see the header. */
  evaluated: FinanceFlagType[];
  flags: FlagRow[];
}

export interface FlagRow {
  id: string;
  invoiceId: string;
  flagType: string;
  severity: string;
  detail: string | null;
  status: string;
  waivedBy: string | null;
  waiveReason: string | null;
  waivedAt: string | null;
  clearedAt: string | null;
  createdAt: string;
}

/**
 * Run the match and reconcile the flags. §7: "runs on save".
 *
 * Called by the create route and by the `rematch` action, and by nothing else —
 * a match that runs on read would recompute a block while somebody is looking
 * at the screen, which is the one moment it must not change.
 */
export async function runMatch(
  db: Database,
  organisationId: string,
  invoiceId: string,
  options: { now?: Date; settings?: FinanceSettings } = {},
): Promise<MatchResult> {
  const now = options.now ?? new Date();
  const settings = options.settings ?? (await readFinanceSettings(db, organisationId));
  const result = await matchInvoice(db, organisationId, invoiceId, settings, now);
  const flags = await reconcileFlags(db, organisationId, invoiceId, result, now);
  return { ...result, flags };
}

/**
 * The read-only half: every §7 check, no writes.
 *
 * Split out so that a screen can PREVIEW what a match would say without
 * changing a flag, and so that the checks can be reasoned about without a
 * database in the way.
 */
export async function matchInvoice(
  db: Database,
  organisationId: string,
  invoiceId: string,
  settings: FinanceSettings,
  now: Date = new Date(),
): Promise<{ findings: MatchFinding[]; evaluated: FinanceFlagType[] }> {
  const findings: MatchFinding[] = [];
  const evaluated: FinanceFlagType[] = [];
  const raise = (flagType: FinanceFlagType, detail: string) => {
    findings.push({ flagType, severity: DEFAULT_FLAG_SEVERITY[flagType], detail });
  };

  const [invoice] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.id, invoiceId)))
    .limit(1);
  if (!invoice) return { findings, evaluated };

  const direction: InvoiceDirection = invoice.direction === "receivable" ? "receivable" : "payable";
  const allocations = await listAllocations(db, organisationId, invoiceId);
  const jobIds = allocations.map((row) => row.requestId).filter(hasLinkedJob);
  if (jobIds.length === 0 && hasLinkedJob(invoice.requestId)) jobIds.push(invoice.requestId);

  /* ── 1. No linked job ───────────────────────────────────────────────────── */
  evaluated.push("no_linked_job");
  if (jobIds.length === 0) {
    raise("no_linked_job", "This invoice is not linked to any job.");
  }

  const jobs = jobIds.length
    ? await selectInChunks(jobIds, (chunk) =>
        db
          .select({
            id: maintenanceRequests.id,
            siteId: maintenanceRequests.siteId,
            stage: maintenanceRequests.stage,
            status: maintenanceRequests.status,
            title: maintenanceRequests.title,
          })
          .from(maintenanceRequests)
          .where(
            and(
              eq(maintenanceRequests.organisationId, organisationId),
              inArray(maintenanceRequests.id, chunk),
            ),
          ),
      )
    : [];

  /* ── 2. Job not complete ────────────────────────────────────────────────── */
  if (jobs.length > 0) {
    evaluated.push("job_not_complete");
    const open = jobs.filter((job) => !isJobComplete(job.stage, job.status));
    if (open.length > 0) {
      raise(
        "job_not_complete",
        `${listOf(open.map((job) => job.id))} ${open.length === 1 ? "is" : "are"} still open. `
          + `Invoiced before the work was signed off.`,
      );
    }
  }

  /* ── 3. Site mismatch ───────────────────────────────────────────────────── */
  const invoiceSite = realSiteId(invoice.siteId);
  if (invoiceSite && jobs.length > 0) {
    evaluated.push("site_mismatch");
    /* Only jobs that NAME a site can disagree with one. A job with no site
       recorded is missing information, not evidence of a different site, and
       flagging it would put a block on the 80 unassigned jobs this estate
       already carries. */
    const elsewhere = jobs
      .map((job) => ({ id: job.id, siteId: realSiteId(job.siteId) }))
      .filter((job) => job.siteId && job.siteId !== invoiceSite);
    if (elsewhere.length > 0) {
      raise(
        "site_mismatch",
        `The invoice names site ${invoiceSite}, but ${listOf(elsewhere.map((job) => job.id))} `
          + `${elsewhere.length === 1 ? "is" : "are"} recorded against a different site.`,
      );
    }
  }

  /* ── 4 & 5. The quote: approved at all, and at what price ───────────────── */
  if (direction === "payable") {
    const quotes = await approvedQuotesFor(db, organisationId, invoice.quoteId, jobIds);
    evaluated.push("no_approved_quote");
    if (quotes.length === 0) {
      raise(
        "no_approved_quote",
        jobIds.length === 0
          ? "There is no approved quote behind this invoice."
          : `No approved quote covers ${listOf(jobIds)}.`,
      );
    } else {
      /*
       * NET AGAINST NET where both sides have one — see `comparableAmount` in
       * `./rules.ts`. A multi-job invoice with no explicitly linked quote is
       * compared against the SUM of the approved quotes on its jobs, which is
       * the only comparison that means anything when one invoice covers four
       * visits; a single linked quote is compared on its own.
       */
      const quoteAmount = quotes.reduce((sum, quote) => {
        const value = comparableAmount(quote.netPence, quote.grossPence);
        return sum + (value?.amount ?? 0);
      }, 0);
      const invoiceAmount = comparableAmount(invoice.netPence, invoice.grossPence);
      if (invoiceAmount && quoteAmount > 0) {
        evaluated.push("over_quote");
        const verdict = overQuote({
          invoiceAmountPence: invoiceAmount.amount,
          quoteAmountPence: quoteAmount,
          basisPoints: settings.overQuoteToleranceBasisPoints,
          floorPence: settings.overQuoteTolerancePence,
        });
        if (verdict.over) {
          raise(
            "over_quote",
            `${pounds(invoiceAmount.amount)} against an approved quote of ${pounds(quoteAmount)} — `
              + `${pounds(verdict.excessPence)} over, and the tolerance is ${pounds(verdict.tolerancePence)}.`,
          );
        }
      }
    }
  }

  /* ── 6. Possible duplicate ──────────────────────────────────────────────── */
  const candidate = await duplicateCandidateFor(db, organisationId, invoice);
  if (candidate) {
    evaluated.push("possible_duplicate");
    const others = await duplicateNeighbours(db, organisationId, invoice.id, direction, candidate);
    const duplicate = duplicateFinding(candidate, others, settings.duplicateWindowDays);
    if (duplicate) {
      raise(
        "possible_duplicate",
        `${duplicate.detail} Check against ${duplicate.matchId} before paying — nothing has been removed.`,
      );
    }
  }

  /* ── 7. VAT anomaly ─────────────────────────────────────────────────────── */
  const vat = vatAnomalyFinding(direction, invoice.vatPence, settings);
  if (vat.evaluated) {
    evaluated.push("vat_anomaly");
    if (vat.detail) raise("vat_anomaly", vat.detail);
  }

  /* ── 8. Outside the agreement ───────────────────────────────────────────── */
  const site = invoiceSite ? await readSite(db, organisationId, invoiceSite) : null;
  evaluated.push("outside_agreement");
  const outside = outsideAgreement({
    category: invoice.category,
    siteBillable: site ? Boolean(site.billable) : null,
    siteBillingFrom: dayOf(site?.billingActiveFrom ?? null),
    siteBillingTo: dayOf(site?.billingActiveTo ?? null),
    invoiceDay: dayOf(invoice.invoiceDate) ?? financeDay(now),
  });
  if (outside) raise("outside_agreement", outside);

  return { findings, evaluated };
}

/**
 * VAT CHARGED BY A SUPPLIER WITH NO VAT NUMBER RECORDED — where that is knowable.
 *
 * ── ON A PAYABLE IT IS NOT KNOWABLE, AND THE CHECK IS SKIPPED ──────────────
 *
 * §7's trigger is the SUPPLIER's registration status. There is no column
 * anywhere in this schema that records it: `contractors` carries a
 * `finance_reference` and `payment_terms` and deliberately no bank or tax
 * identifiers (this repository is public), and `billing_settings.vat_number` is
 * the WORKSPACE's own registration, not a supplier's. Inferring registration
 * from the fact that VAT was charged is circular — it would flag nothing — and
 * inferring it from the rate would flag every zero-rated supply.
 *
 * So on a payable the check does not run. It returns `evaluated: false`, which
 * is what stops reconciliation from clearing a `vat_anomaly` flag a person
 * raised by hand. When `contractors` gains a `vat_number`, the rule is one
 * condition here and nothing else changes.
 *
 * ── ON A RECEIVABLE IT IS KNOWABLE, AND IT RUNS ────────────────────────────
 *
 * §15.8 asks for the "VAT registration flip … applied to receivables here", and
 * the fact that decides it IS recorded: `billing_settings.vat_enabled` and
 * `vat_number`. Charging a client VAT while the workspace is not registered, or
 * has no number to print on the document, is an anomaly and a real one.
 */
export function vatAnomalyFinding(
  direction: InvoiceDirection,
  vatPence: number | null,
  settings: Pick<FinanceSettings, "vatEnabled" | "vatNumber">,
): { evaluated: boolean; detail: string | null } {
  if (direction === "payable") return { evaluated: false, detail: null };
  const vat = Math.trunc(vatPence ?? 0);
  if (vat <= 0) return { evaluated: true, detail: null };
  if (!settings.vatEnabled) {
    return {
      evaluated: true,
      detail: "VAT is charged on this invoice, but this workspace is not recorded as VAT registered.",
    };
  }
  if (!settings.vatNumber) {
    return {
      evaluated: true,
      detail: "VAT is charged on this invoice, but no VAT registration number is recorded in settings.",
    };
  }
  return { evaluated: true, detail: null };
}

/* ── Reconciliation ───────────────────────────────────────────────────────── */

/**
 * Write the findings into `invoice_flags` without destroying a waiver.
 *
 * Reads the existing rows first and decides per type — see the table in the
 * header. `INSERT OR IGNORE … RETURNING` is deliberately NOT used: it returns
 * zero rows on conflict, so a caller cannot tell "inserted" from "already
 * there", and the difference matters here because the second case needs an
 * UPDATE.
 */
export async function reconcileFlags(
  db: Database,
  organisationId: string,
  invoiceId: string,
  result: { findings: MatchFinding[]; evaluated: FinanceFlagType[] },
  now: Date = new Date(),
): Promise<FlagRow[]> {
  const stamp = now.toISOString();
  const existing = await db
    .select()
    .from(invoiceFlags)
    .where(and(eq(invoiceFlags.organisationId, organisationId), eq(invoiceFlags.invoiceId, invoiceId)));
  const byType = new Map(existing.map((row) => [row.flagType, row]));
  const found = new Map(result.findings.map((finding) => [finding.flagType, finding]));

  for (const finding of result.findings) {
    const row = byType.get(finding.flagType);
    if (!row) {
      await db.insert(invoiceFlags).values({
        id: crypto.randomUUID(),
        organisationId,
        invoiceId,
        flagType: finding.flagType,
        severity: finding.severity,
        detail: finding.detail.slice(0, 400),
        status: "open",
        createdAt: stamp,
      });
      continue;
    }
    /* A waiver is a person's decision about this exact cause and the cause is
       still there, so it stands. Re-opening it would ask them the same question
       every time the invoice is saved. */
    if (row.status === "waived") continue;
    await db
      .update(invoiceFlags)
      .set({ status: "open", detail: finding.detail.slice(0, 400), clearedAt: null })
      .where(and(eq(invoiceFlags.organisationId, organisationId), eq(invoiceFlags.id, row.id)));
  }

  for (const row of existing) {
    if (found.has(row.flagType as FinanceFlagType)) continue;
    /* Only a check that RAN may clear its flag. See the header. */
    if (!result.evaluated.includes(row.flagType as FinanceFlagType)) continue;
    if (row.status !== "open") continue;
    await db
      .update(invoiceFlags)
      .set({ status: "cleared", clearedAt: stamp })
      .where(and(eq(invoiceFlags.organisationId, organisationId), eq(invoiceFlags.id, row.id)));
  }

  return listFlags(db, organisationId, invoiceId);
}

export async function listFlags(
  db: Database,
  organisationId: string,
  invoiceId: string,
): Promise<FlagRow[]> {
  const rows = await db
    .select()
    .from(invoiceFlags)
    .where(and(eq(invoiceFlags.organisationId, organisationId), eq(invoiceFlags.invoiceId, invoiceId)));
  return rows.map((row) => ({
    id: row.id,
    invoiceId: row.invoiceId,
    flagType: row.flagType,
    severity: row.severity,
    detail: row.detail ?? null,
    status: row.status,
    waivedBy: row.waivedBy ?? null,
    waiveReason: row.waiveReason ?? null,
    waivedAt: row.waivedAt ?? null,
    clearedAt: row.clearedAt ?? null,
    createdAt: row.createdAt,
  }));
}

export async function listFlagsForInvoices(
  db: Database,
  organisationId: string,
  invoiceIds: readonly string[],
): Promise<Map<string, FlagRow[]>> {
  const grouped = new Map<string, FlagRow[]>();
  const ids = [...new Set(invoiceIds.filter(Boolean))];
  if (ids.length === 0) return grouped;
  const rows = await selectInChunks(ids, (chunk) =>
    db
      .select()
      .from(invoiceFlags)
      .where(
        and(eq(invoiceFlags.organisationId, organisationId), inArray(invoiceFlags.invoiceId, chunk)),
      ),
  );
  for (const row of rows) {
    const flag: FlagRow = {
      id: row.id,
      invoiceId: row.invoiceId,
      flagType: row.flagType,
      severity: row.severity,
      detail: row.detail ?? null,
      status: row.status,
      waivedBy: row.waivedBy ?? null,
      waiveReason: row.waiveReason ?? null,
      waivedAt: row.waivedAt ?? null,
      clearedAt: row.clearedAt ?? null,
      createdAt: row.createdAt,
    };
    const bucket = grouped.get(flag.invoiceId);
    if (bucket) bucket.push(flag);
    else grouped.set(flag.invoiceId, [flag]);
  }
  return grouped;
}

/**
 * Waive or clear one flag by hand.
 *
 * §7: waived "with a typed reason". The reason is required by the caller and
 * recorded here with the author and the time; there is no path through this
 * function that waives without one, which is what makes the audit trail worth
 * having. Clearing by hand is separate and does NOT take the waiver fields —
 * "I have fixed the cause" and "I accept the cause" are different statements
 * and a screen that conflated them would lose the second.
 */
export async function setFlagStatus(
  db: Database,
  organisationId: string,
  flagId: string,
  action: "waive" | "clear",
  input: { reason: string | null; actorEmail: string | null; now?: Date },
): Promise<FlagRow | null> {
  const stamp = (input.now ?? new Date()).toISOString();
  const [row] = await db
    .select()
    .from(invoiceFlags)
    .where(and(eq(invoiceFlags.organisationId, organisationId), eq(invoiceFlags.id, flagId)))
    .limit(1);
  if (!row) return null;

  if (action === "waive") {
    if (!input.reason) return null;
    await db
      .update(invoiceFlags)
      .set({
        status: "waived",
        waivedBy: input.actorEmail,
        waiveReason: input.reason.slice(0, 400),
        waivedAt: stamp,
      })
      .where(and(eq(invoiceFlags.organisationId, organisationId), eq(invoiceFlags.id, flagId)));
  } else {
    await db
      .update(invoiceFlags)
      .set({ status: "cleared", clearedAt: stamp })
      .where(and(eq(invoiceFlags.organisationId, organisationId), eq(invoiceFlags.id, flagId)));
  }

  const [updated] = await db
    .select()
    .from(invoiceFlags)
    .where(and(eq(invoiceFlags.organisationId, organisationId), eq(invoiceFlags.id, flagId)))
    .limit(1);
  return updated
    ? {
        id: updated.id,
        invoiceId: updated.invoiceId,
        flagType: updated.flagType,
        severity: updated.severity,
        detail: updated.detail ?? null,
        status: updated.status,
        waivedBy: updated.waivedBy ?? null,
        waiveReason: updated.waiveReason ?? null,
        waivedAt: updated.waivedAt ?? null,
        clearedAt: updated.clearedAt ?? null,
        createdAt: updated.createdAt,
      }
    : null;
}

/* ── The reads the checks need ────────────────────────────────────────────── */

/**
 * The approved quotes behind an invoice.
 *
 * An explicitly linked quote wins outright: somebody said "this invoice is for
 * that quote" and the engine does not second-guess it. Otherwise every approved
 * quote on the invoice's jobs counts, which is what makes a four-job invoice
 * comparable against the four prices that were agreed.
 */
async function approvedQuotesFor(
  db: Database,
  organisationId: string,
  quoteId: string | null,
  jobIds: readonly string[],
) {
  if (quoteId) {
    const rows = await db
      .select()
      .from(quotations)
      .where(and(eq(quotations.organisationId, organisationId), eq(quotations.id, quoteId)))
      .limit(1);
    return rows.filter((row) => quoteStatusKey(row.status) === "approved");
  }
  if (jobIds.length === 0) return [];
  const rows = await selectInChunks(jobIds, (chunk) =>
    db
      .select()
      .from(quotations)
      .where(
        and(eq(quotations.organisationId, organisationId), inArray(quotations.requestId, chunk)),
      ),
  );
  return rows.filter((row) => quoteStatusKey(row.status) === "approved");
}

/** The invoice, reduced to the four facts the duplicate rule compares. */
async function duplicateCandidateFor(
  db: Database,
  organisationId: string,
  invoice: typeof invoices.$inferSelect,
): Promise<DuplicateCandidate | null> {
  const key = counterpartyKey(invoice.counterpartyId, invoice.counterpartyName)
    || (await contractorKey(db, organisationId, invoice.contractorId));
  if (!key) return null;
  return {
    id: invoice.id,
    counterpartyKey: key,
    invoiceNumberKey: referenceKey(invoice.invoiceNumber),
    grossPence: invoice.grossPence ?? invoice.netPence ?? 0,
    invoiceDay: dayOf(invoice.invoiceDate),
  };
}

/**
 * The other invoices this one could be a duplicate of.
 *
 * Narrowed in SQL to the same workspace and the same direction, then compared
 * in JavaScript — because "within N days" is day arithmetic, which
 * `db/sqlite-to-postgres.ts` refuses to let SQL do on both dialects. The
 * candidate set is the counterparty's own invoices, which is small: this is not
 * a scan of the ledger.
 */
async function duplicateNeighbours(
  db: Database,
  organisationId: string,
  invoiceId: string,
  direction: InvoiceDirection,
  candidate: DuplicateCandidate,
): Promise<DuplicateCandidate[]> {
  /*
   * NARROWED IN SQL WHERE IT CAN BE DONE WITHOUT LOSING A MATCH.
   *
   * Where the candidate identifies its supplier by ID, the only rows whose key
   * can equal it are the ones carrying that id in `counterparty_id` or, for a
   * row that predates the field, in `contractor_id` — so the index
   * `invoices_counterparty_idx` does the work instead of a scan of every
   * invoice in the direction. `lower()` on both sides because the key is
   * lower-cased in JavaScript and a differently-cased id is the same supplier.
   *
   * This clause only ever WIDENS relative to the JavaScript check below, which
   * stays the authority. Where the supplier is identified only by NAME there is
   * no lossless narrowing — `counterpartyKey` collapses runs of whitespace and
   * SQL cannot — so that case reads the direction and filters in JavaScript,
   * deliberately choosing correctness over the index.
   */
  const identity = candidate.counterpartyKey.startsWith("id:")
    ? candidate.counterpartyKey.slice(3)
    : null;
  const narrowed = identity
    ? sql`(lower(coalesce(${invoices.counterpartyId}, '')) = ${identity}
        or lower(coalesce(${invoices.contractorId}, '')) = ${identity})`
    : undefined;

  const rows = await db
    .select({
      id: invoices.id,
      counterpartyId: invoices.counterpartyId,
      counterpartyName: invoices.counterpartyName,
      contractorId: invoices.contractorId,
      invoiceNumber: invoices.invoiceNumber,
      grossPence: invoices.grossPence,
      netPence: invoices.netPence,
      invoiceDate: invoices.invoiceDate,
      voidedAt: invoices.voidedAt,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.organisationId, organisationId),
        eq(invoices.direction, direction),
        ne(invoices.id, invoiceId),
        ...(narrowed ? [narrowed] : []),
      ),
    );

  const candidates: DuplicateCandidate[] = [];
  for (const row of rows) {
    /* A voided invoice is evidence that something was withdrawn, not a payment
       waiting to happen. Matching against one would flag the very correction
       that replaced it, every time. Filtered here rather than in the WHERE
       because `voided_at` is the fact; `status` is a label a workspace may
       rename through `invoice_status_map`. */
    if (row.voidedAt) continue;
    const key = counterpartyKey(row.counterpartyId, row.counterpartyName)
      || (row.contractorId ? `id:${row.contractorId.toLowerCase()}` : "");
    if (!key || key !== candidate.counterpartyKey) continue;
    candidates.push({
      id: row.id,
      counterpartyKey: key,
      invoiceNumberKey: referenceKey(row.invoiceNumber),
      grossPence: row.grossPence ?? row.netPence ?? 0,
      invoiceDay: dayOf(row.invoiceDate),
    });
  }
  return candidates;
}

async function contractorKey(
  db: Database,
  organisationId: string,
  contractorId: string | null,
): Promise<string> {
  if (!contractorId) return "";
  const rows = await db
    .select({ id: contractors.id })
    .from(contractors)
    .where(and(eq(contractors.organisationId, organisationId), eq(contractors.id, contractorId)))
    .limit(1);
  return rows[0] ? `id:${rows[0].id.toLowerCase()}` : "";
}

async function readSite(db: Database, organisationId: string, siteId: string) {
  const rows = await db
    .select({
      id: sites.id,
      billable: sites.billable,
      billingActiveFrom: sites.billingActiveFrom,
      billingActiveTo: sites.billingActiveTo,
    })
    .from(sites)
    .where(and(eq(sites.organisationId, organisationId), eq(sites.id, siteId)))
    .limit(1);
  return rows[0] ?? null;
}

/* ── Small shared judgements ──────────────────────────────────────────────── */

/**
 * Whether a job counts as finished, by the ONE vocabulary the product has.
 *
 * `COMPLETED_STAGE` and `statusFamily` come from `app/lib/job-metrics.ts`,
 * which is where every other screen asks the same question. A second list of
 * "done" statuses here would be a second answer to "is this job closed", and
 * the Overview and the invoice tracker would disagree about the same row.
 */
export function isJobComplete(stage: string | null, status: string | null): boolean {
  if ((stage ?? "").trim() === COMPLETED_STAGE) return true;
  return statusFamily(status) === "completed";
}

/**
 * A site id that means a real site.
 *
 * Two sentinels are in play on this estate and both mean "no site":
 * `__unassigned__` is `job-metrics`'s bucket key, and `site-unassigned` is what
 * 80 of the development board's live jobs actually point at — see the header of
 * `app/lib/dashboard-filters.ts`. Neither is a site to disagree with.
 */
function realSiteId(value: string | null | undefined): string | null {
  const id = (value ?? "").trim();
  if (!id || id === UNASSIGNED_SITE_ID || id === "site-unassigned") return null;
  return id;
}

function listOf(ids: readonly string[]): string {
  if (ids.length <= 3) return ids.join(", ");
  return `${ids.slice(0, 3).join(", ")} and ${ids.length - 3} more`;
}

function pounds(pence: number): string {
  const value = Math.trunc(pence || 0);
  const negative = value < 0;
  const absolute = Math.abs(value);
  return `${negative ? "-" : ""}£${Math.floor(absolute / 100).toLocaleString("en-GB")}.${String(
    absolute % 100,
  ).padStart(2, "0")}`;
}
