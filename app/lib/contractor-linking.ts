/**
 * JOINING THE TWO SETS OF CONTRACTOR IDENTITIES.
 *
 * The audit finding this module exists for, measured on the development estate:
 * sixteen distinct contractor-name strings appear on jobs, the register holds
 * 112 records, and the Overview's contractor card reported most of its
 * attributed spend as belonging to no record. Meanwhile every operational
 * column in the register — Assigned, Completed, Completion rate, Open urgent,
 * Spend — read zero.
 *
 * Both facts had one cause. A job is attributed to a contractor by
 * `contractor_id` first and by an exactly-matching, unambiguous NAME second
 * (`contractor-attribution.ts`), and nothing existed to say "the string
 * 'Saed Electrical' means this record". `contractor_name_aliases` is that
 * statement and this module is how it is read and written.
 *
 * ── A ZERO IS A CLAIM, AND IT WAS THE WRONG ONE ───────────────────────────
 *
 * `Assigned 0` asserts that this contractor has done no work. Where nothing
 * links them to the jobs they did, that assertion is false and it is the kind
 * of false that gets somebody paid late. Every reader of these figures is
 * handed `linked` alongside them so it can print `Not linked` instead — a
 * statement about the DATA rather than about the contractor.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { getDb } from "../../db";
import {
  contractorNameAliases,
  contractors,
  maintenanceRequests,
} from "../../db/schema";
import { jobsBoardCondition } from "./dashboard-filters";
import { selectInChunks } from "./sql-batching";

type Database = Awaited<ReturnType<typeof getDb>>;

/**
 * The comparison key for a contractor name.
 *
 * The same normalisation `contractor-attribution.ts` and `contractor-reference.ts`
 * apply: trimmed, lower-cased, internal whitespace collapsed. These strings
 * have been through a spreadsheet, a CSV round trip and a human, so "Saed
 * Electrical", "saed electrical" and "Saed  Electrical" are one name — and
 * treating them as three is how one contractor's history comes to sit in three
 * rows.
 */
export function contractorNameKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export type UnlinkedName = {
  /** The string as typed on the jobs. */
  name: string;
  key: string;
  jobs: number;
  /*
   * POUNDS, not pence — `maintenance_requests.cost` is a REAL in pounds and
   * this carries it through untouched. The field is deliberately not called
   * `spendPence`, and `money()` in `ops-primitives.tsx` takes pounds, so the
   * two agree at every call site. `/api/dashboard/cost` converts to integer
   * pence for the money card because that card shares the finance formatter;
   * the same figure therefore appears as 5342 here and 534200 there, and both
   * are right for their own reader.
   */
  spend: number;
  /** Register rows whose own name matches this string, if any. */
  candidates: Array<{ id: string; name: string }>;
  /**
   * Why this string is unattributed.
   *
   * `none` — no register row answers to it.
   * `ambiguous` — two or more do, and attributing it would double-count money.
   */
  reason: "none" | "ambiguous";
};

/**
 * Distinct job-side contractor strings that resolve to no single record.
 *
 * A string is UNLINKED when every job carrying it has a null `contractor_id`
 * and no alias row maps it, AND the register does not hold exactly one row of
 * that name. The last clause matters: a name exactly one contractor answers to
 * is already attributed by the name rule, so listing it here would send an
 * operator to link something that is already linked.
 *
 * A name TWO records share is listed with `reason: "ambiguous"`, because that
 * is the case an operator has to resolve by hand — renaming one of the pair, or
 * mapping the string to the record it actually means.
 */
export async function unlinkedContractorNames(
  db: Database,
  orgId: string,
): Promise<{ names: UnlinkedName[]; totalSpend: number; unlinkedSpend: number }> {
  const [jobRows, registerRows, aliasRows, totals] = await Promise.all([
    /*
     * Grouped in SQL. The alternative — fetching every job and grouping in the
     * handler — is a thousand rows to produce sixteen, and this endpoint is on
     * the page an operator opens to fix the problem, not a background task.
     */
    db
      .select({
        name: maintenanceRequests.contractor,
        jobs: sql<number>`count(*)`,
        spend: sql<number>`coalesce(sum(${maintenanceRequests.cost}), 0)`,
        linked: sql<number>`sum(case when ${maintenanceRequests.contractorId} is not null then 1 else 0 end)`,
      })
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.organisationId, orgId),
          isNull(maintenanceRequests.deletedAt),
          eq(maintenanceRequests.archived, false),
          isNull(maintenanceRequests.parentId),
          // Jobs only: rows on another board are not work a contractor did.
          jobsBoardCondition(),
          sql`${maintenanceRequests.contractor} is not null and trim(${maintenanceRequests.contractor}) <> ''`,
        ),
      )
      .groupBy(maintenanceRequests.contractor),
    db
      .select({ id: contractors.id, name: contractors.name })
      .from(contractors)
      .where(eq(contractors.organisationId, orgId)),
    db
      .select({ normalised: contractorNameAliases.normalised })
      .from(contractorNameAliases)
      .where(eq(contractorNameAliases.organisationId, orgId)),
    db
      .select({
        total: sql<number>`coalesce(sum(${maintenanceRequests.cost}), 0)`,
      })
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.organisationId, orgId),
          isNull(maintenanceRequests.deletedAt),
          eq(maintenanceRequests.archived, false),
          isNull(maintenanceRequests.parentId),
          jobsBoardCondition(),
        ),
      ),
  ]);

  const byRegisterName = new Map<string, Array<{ id: string; name: string }>>();
  for (const row of registerRows) {
    const key = contractorNameKey(row.name);
    const list = byRegisterName.get(key);
    if (list) list.push(row);
    else byRegisterName.set(key, [row]);
  }
  const aliased = new Set(aliasRows.map((row) => row.normalised));

  const names: UnlinkedName[] = [];
  let unlinkedSpend = 0;
  for (const row of jobRows) {
    const name = (row.name ?? "").trim();
    if (!name) continue;
    const key = contractorNameKey(name);
    if (aliased.has(key)) continue;
    /*
     * ALREADY ATTRIBUTED, HOWEVER MANY REGISTER ROWS SHARE THE NAME.
     *
     * This test used to be written `candidates.length === 0 && ...`, so a name
     * that matched SEVERAL register rows was reported as unlinked even when
     * every job carrying it already had a `contractor_id` on it. Nothing needed
     * linking; the ambiguity was in the register, not in the attribution.
     *
     * That put two panels on one page in contradiction — `/api/dashboard/cost`
     * reporting `unlinkedNames: 0` with every row linked and
     * `contractorLinkedPence` equal to the total, while
     * `/api/overview/contractor-aliases` reported unlinked spend against a name
     * whose attributed spend it simultaneously agreed was complete. §3.6 exists
     * to end exactly that class of disagreement, so it may not open with one.
     */
    if (Number(row.linked) === Number(row.jobs)) continue;
    const candidates = byRegisterName.get(key) ?? [];
    // Exactly one register row of this name — already attributed by the name
    // rule, nothing to link.
    if (candidates.length === 1) continue;
    const spend = Number(row.spend ?? 0);
    unlinkedSpend += spend;
    names.push({
      name,
      key,
      jobs: Number(row.jobs ?? 0),
      spend,
      candidates,
      reason: candidates.length > 1 ? "ambiguous" : "none",
    });
  }

  names.sort((left, right) => right.spend - left.spend || right.jobs - left.jobs);
  return {
    names,
    totalSpend: Number(totals[0]?.total ?? 0),
    unlinkedSpend,
  };
}

/** Every alias mapped to a set of contractors, keyed by contractor id. */
export async function aliasesByContractor(
  db: Database,
  orgId: string,
  contractorIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!contractorIds.length) return out;
  /* Chunked for D1's ~100 bound-variable ceiling, like the tallies beside it
     in `GET /api/contractors`: the ids are every contractor across the
     requested registers. Bucketed per contractor below, so chunking changes
     nothing about the answer. */
  const rows = await selectInChunks(contractorIds, (chunk) =>
    db
      .select({
        contractorId: contractorNameAliases.contractorId,
        alias: contractorNameAliases.alias,
      })
      .from(contractorNameAliases)
      .where(
        and(
          eq(contractorNameAliases.organisationId, orgId),
          inArray(contractorNameAliases.contractorId, chunk),
        ),
      ),
  );
  for (const row of rows) {
    const list = out.get(row.contractorId);
    if (list) list.push(row.alias);
    else out.set(row.contractorId, [row.alias]);
  }
  return out;
}

/**
 * Whether a contractor is linked to any work at all.
 *
 * Three ways to be linked, and the register's zero columns are only honest when
 * one of them holds: a job carries this `contractor_id`, an alias maps a
 * job-side string to this record, or exactly one register row answers to a name
 * jobs use — which is this row.
 *
 * Returned as a SET of ids rather than a per-row query, because the register
 * draws every contractor at once and asking per row is the shape that turns a
 * list into a hundred round trips.
 */
export async function linkedContractorIds(
  db: Database,
  orgId: string,
): Promise<Set<string>> {
  const [withJobs, aliasRows, registerRows, jobNames] = await Promise.all([
    db
      .select({ contractorId: maintenanceRequests.contractorId })
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.organisationId, orgId),
          isNull(maintenanceRequests.deletedAt),
          sql`${maintenanceRequests.contractorId} is not null`,
        ),
      )
      .groupBy(maintenanceRequests.contractorId),
    db
      .select({ contractorId: contractorNameAliases.contractorId })
      .from(contractorNameAliases)
      .where(eq(contractorNameAliases.organisationId, orgId))
      .groupBy(contractorNameAliases.contractorId),
    db
      .select({ id: contractors.id, name: contractors.name })
      .from(contractors)
      .where(eq(contractors.organisationId, orgId)),
    db
      .select({ name: maintenanceRequests.contractor })
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.organisationId, orgId),
          isNull(maintenanceRequests.deletedAt),
          sql`${maintenanceRequests.contractor} is not null and trim(${maintenanceRequests.contractor}) <> ''`,
        ),
      )
      .groupBy(maintenanceRequests.contractor),
  ]);

  const linked = new Set<string>();
  for (const row of withJobs) if (row.contractorId) linked.add(row.contractorId);
  for (const row of aliasRows) linked.add(row.contractorId);

  const nameCounts = new Map<string, string[]>();
  for (const row of registerRows) {
    const key = contractorNameKey(row.name);
    const list = nameCounts.get(key);
    if (list) list.push(row.id);
    else nameCounts.set(key, [row.id]);
  }
  for (const row of jobNames) {
    const key = contractorNameKey(row.name);
    const ids = nameCounts.get(key);
    // A name two records share attributes to NEITHER — the same refusal
    // `contractor-attribution.ts` makes, for the same reason.
    if (ids && ids.length === 1) linked.add(ids[0]);
  }
  return linked;
}

/**
 * Every job whose contractor string maps to a register row through an alias,
 * as `{ jobId -> contractorId }`.
 *
 * Applied on top of `attributeContractorWork` by callers that want alias
 * mapping folded into their totals. Kept separate from that module on purpose:
 * `contractor-attribution.ts` is a PURE partition over rows it is handed, with
 * no database in it, and giving it one would make it untestable in isolation.
 */
export async function aliasJobLinks(
  db: Database,
  orgId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({
      normalised: contractorNameAliases.normalised,
      contractorId: contractorNameAliases.contractorId,
    })
    .from(contractorNameAliases)
    .where(eq(contractorNameAliases.organisationId, orgId));
  return new Map(rows.map((row) => [row.normalised, row.contractorId]));
}
