/**
 * WHOSE WORK IS IT — the one rule every reporting surface counts contractors by.
 *
 * `app/lib/contractor-reference.ts` is the WRITE half of this: it decides which
 * `contractor_id` a job's contractor TEXT resolves to, in SQL, on the way in.
 * This is the READ half. Both answer the same question with the same three
 * clauses, and until this module existed the read half was copied out by hand
 * in three places and one of the copies had never been fixed.
 *
 * ── The defect this file closes (W06-12) ───────────────────────────────────
 *
 * `ContractorScorecard` on the Reports page keyed a contractor's jobs, average
 * close time and spend on the contractor NAME TEXT and never read
 * `contractorId` at all:
 *
 *     const name = (request.contractor ?? "").trim();
 *     if (!name) continue;
 *
 * That is the exact shape commit `9c53bd9` removed from the Contractors
 * register, surviving in Reports because nothing shared the rule and no test
 * covered the panel. Reproduced on the running product: the register showed a
 * renamed contractor holding £250 of work while the scorecard printed that £250
 * against a name that appears on NO register row. Three separate failures, all
 * from the same line:
 *
 *   • a job linked by `contractor_id` whose text was cleared is DROPPED — it has
 *     an owner, and the panel cannot see it;
 *   • a RENAME splits one contractor's history into two rows, the old name
 *     holding the old jobs for ever;
 *   • two contractors who genuinely share a name MERGE into one row, which is
 *     the double count `rosterPerName` in portal-app.tsx and `contractorsPerName`
 *     in app/api/workspace/route.ts were both written to refuse. One £999 job
 *     printed as £1,998 the last time this happened.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 *
 * THE ID FIRST, AND THE NAME ONLY WHERE THERE IS NO ID.
 *
 *   - a job carrying `contractorId` is matched by that id and by nothing else;
 *   - a job carrying none falls back to its text, and only where exactly ONE
 *     register row answers to that text;
 *   - a name two register rows share attributes to NEITHER of them.
 *
 * The two branches are disjoint per job, so no job can reach two contractors
 * and none can be counted twice. That partition property is what lets a total
 * built from these rows be trusted: `sum(rows) + unattributed == every job in`.
 * `attributeContractorWork` returns the leftovers rather than discarding them
 * for exactly that reason — a figure somebody bills from must be able to say
 * what it left out.
 *
 * Refusing to attribute an ambiguous name is the same answer
 * `resolveContractorLink` gives to the same question, and it is the deliberate
 * one: an under-count is visible and fixable — the operator links the jobs, or
 * renames one of the pair — while a double count silently inflates money.
 *
 * ── What is NOT here ───────────────────────────────────────────────────────
 *
 * COMMERCIAL RATES ARE NOT SPEND. `contractors` now carries `day_rate_pence`,
 * `call_out_cost_pence`, `hourly_rate_pence` and `other_cost_pence`: agreed
 * terms, in pence. Nothing in this module reads them, and nothing downstream
 * may add them into a spend figure. Without days worked, hours worked or
 * call-outs used, that arithmetic does not summarise cost — it invents it.
 * The structural guarantee is the signature: every function here takes
 * `MaintenanceRequest[]`, which has no rate field to reach.
 *
 * Actual spend is `maintenance_requests.cost` and only that. It is a `real`
 * holding POUNDS, not pence — the one place in this product where money is not
 * an integer of pence, because it is monday's "Cost of Works" column exported
 * as a number. A job with no cost contributes nothing; the agreed rate is never
 * substituted for a cost nobody recorded.
 *
 * ── And no date basis ──────────────────────────────────────────────────────
 *
 * Deliberately absent. There is no cost-transaction date in this product —
 * `cost` carries no date of its own, the `invoice` column beside it is free
 * text, and the `invoices` table has never been read or written by any code
 * here — so every caller scopes its own rows by whichever operational date its
 * screen is asking about, and says which one in its own label. Putting a window
 * in here would mean choosing that basis on behalf of screens that are asking
 * different questions. See `CONTRACTOR_SPEND_BASIS` below for the two that
 * exist and why they differ.
 */

import type { MaintenanceRequest } from "./types";

/**
 * The minimum a register row has to carry to be attributable.
 *
 * Deliberately structural rather than `WorkspaceContractor`: the Contractors
 * page synthesises a roster out of the job text when the register is empty, and
 * those rows are not workspace records. Widening the parameter to the full type
 * would have forced that caller to fabricate a dozen fields it does not know.
 */
export type ContractorRosterEntry = { id: string; name: string };

/** One attributable party and the jobs this rule says are theirs. */
export type ContractorWorkRow = {
  /** The register id, or null for a name nobody has registered. */
  id: string | null;
  name: string;
  /** Whether a row in the contractor register stands behind this. */
  registered: boolean;
  jobs: MaintenanceRequest[];
};

export type ContractorWorkAttribution = {
  /**
   * One row per roster entry, IN ROSTER ORDER and index-aligned with the array
   * that was passed in, including the contractors with no work at all. A
   * contractor who did nothing this quarter is an answer, not an absence, so
   * the caller gets a zero rather than a missing key.
   */
  byRoster: ContractorWorkRow[];
  /**
   * Names that appear on jobs but on no register row — the unlinked half of a
   * partially imported estate. Kept so a reporting panel that ranks by volume
   * does not silently stop showing work simply because nobody has registered
   * the firm that did it.
   */
  unregistered: ContractorWorkRow[];
  /**
   * Jobs this rule refuses to place: no contractor at all, a name two register
   * rows share, or an id that points at no row in this roster. Surfaced rather
   * than dropped — see the module comment.
   */
  unattributed: MaintenanceRequest[];
};

/**
 * Partition a set of jobs across a contractor roster.
 *
 * The roster pass is written as a filter per contractor rather than a single
 * loop over the jobs, because that is the shape the two already-proven copies
 * of this rule take (`ContractorsView` in portal-app.tsx, and the paired
 * aggregates in app/api/workspace/route.ts) and a rule this load-bearing should
 * read identically wherever a reviewer meets it. The cost is O(jobs × roster);
 * on the live estate that is roughly 750 × 30 per render, which is nothing.
 *
 * The second pass exists because the first cannot distinguish "no register row
 * carries this name" from "two do". Both leave a job unmatched; only the first
 * deserves a row of its own.
 */
export function attributeContractorWork<T extends ContractorRosterEntry>(
  requests: readonly MaintenanceRequest[],
  roster: readonly T[],
): ContractorWorkAttribution {
  /*
   * How many rows in this roster answer to each name.
   *
   * Two contractors can share one, because nothing stops them: there is no
   * unique index on `contractors.name` and no duplicate check on the create.
   */
  const rosterPerName = new Map<string, number>();
  for (const entry of roster) {
    rosterPerName.set(entry.name, (rosterPerName.get(entry.name) ?? 0) + 1);
  }

  const placed = new Set<MaintenanceRequest>();
  const byRoster = roster.map((contractor) => {
    const nameIsUnique = (rosterPerName.get(contractor.name) ?? 0) <= 1;
    const theirs = requests.filter((request) =>
      request.contractorId
        ? request.contractorId === contractor.id
        : nameIsUnique && request.contractor === contractor.name);
    for (const request of theirs) placed.add(request);
    return {
      id: contractor.id,
      name: contractor.name,
      registered: true,
      jobs: theirs,
    };
  });

  /*
   * Everything the roster could not claim, sorted into the two facts it can be.
   *
   * A job with an id is never bucketed by its text here, even when the id
   * points at nothing this roster holds. Falling back to the name at that point
   * would reintroduce the rename split through the back door: the id is the
   * statement of who did the work, and a stale one is a broken reference to be
   * repaired, not a licence to guess from the text beside it.
   */
  const unregisteredByName = new Map<string, ContractorWorkRow>();
  const unattributed: MaintenanceRequest[] = [];
  for (const request of requests) {
    if (placed.has(request)) continue;
    const name = request.contractorId ? "" : (request.contractor ?? "").trim();
    if (!name || rosterPerName.has(name)) {
      // Blank, id-bearing, or a name the register holds more than once.
      unattributed.push(request);
      continue;
    }
    const row =
      unregisteredByName.get(name) ??
      { id: null, name, registered: false, jobs: [] as MaintenanceRequest[] };
    row.jobs.push(request);
    unregisteredByName.set(name, row);
  }

  return { byRoster, unregistered: [...unregisteredByName.values()], unattributed };
}

/**
 * Actual job cost, in POUNDS, for a set of jobs.
 *
 * `maintenance_requests.cost` and nothing else — see the module comment on why
 * an agreed day rate is not a cost. A job nobody has costed adds zero rather
 * than a rate, so the total is what was recorded and never what was quoted.
 */
export function contractorJobCost(jobs: readonly MaintenanceRequest[]): number {
  return jobs.reduce((sum, request) => sum + (request.cost ?? 0), 0);
}

/**
 * WHAT DATE A CONTRACTOR-SPEND FIGURE IS SCOPED BY, said in one place so two
 * screens cannot quietly mean two things by one word.
 *
 * There is no cost-transaction date in this product, so neither of these is a
 * payment date and neither may be labelled as one. Both are OPERATIONAL bases —
 * they date a job, and the job's recorded cost travels with it.
 *
 *   • `requested` — when the work was RAISED. The Reports and Dashboard basis,
 *     and the one every other analytics figure on those two screens already
 *     uses (`withinAnalyticsPeriod(request.requestedAt, …)`). A contractor
 *     spend panel that sat beside a spend trend on a different basis would
 *     print two totals for one window on one screen.
 *
 *   • `completed` — when the work was FINISHED, falling back to when it was
 *     raised for work that is not. The Contractors register's basis, because
 *     that page asks what a contractor DID in a window and a job raised in June
 *     and finished in August is August's work to them. Its spend has to share
 *     the window its "completed 38" uses or one row of that table would be
 *     measuring two periods at once.
 *
 * The two agree EXACTLY over "All records", where neither window excludes
 * anything, and that reconciliation is asserted by
 * tests/workstream-six-reports-attribution.test.mjs. Under any narrower period
 * they differ by the jobs that straddle its edge, which is the two questions
 * being different rather than the two screens disagreeing.
 */
export const CONTRACTOR_SPEND_BASIS = {
  requested: "raised",
  completed: "completed",
} as const;

/**
 * The sentence a panel prints under a contractor spend figure.
 *
 * Held here rather than typed into each panel so the wording cannot drift into
 * claiming something the data does not support. It says two things on purpose:
 * that the figure is recorded JOB COST rather than invoiced or paid money, and
 * which operational date decided the window.
 */
export function contractorSpendBasisNote(
  basis: (typeof CONTRACTOR_SPEND_BASIS)[keyof typeof CONTRACTOR_SPEND_BASIS],
): string {
  return `Recorded job cost attributed by contractor link, counted against the period the work was ${basis} in. Not invoiced or paid amounts, and never an agreed rate.`;
}
