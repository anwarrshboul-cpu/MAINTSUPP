"use client";

/**
 * W09 — COMPLIANCE, ANSWERED FROM STORE DOCUMENTATION AND NOWHERE ELSE.
 *
 * The owner's review of /dashboard/compliance drew an arrow from the sidebar's
 * "Store Documentation" to "Compliance": the two must be the same estate, the
 * same numbers and one definition. The DERIVATION already is — the register is
 * read off the Store Documentation board by `app/lib/compliance-register.ts`,
 * and `liveAttachmentRows()` means only the CURRENT version of a document can
 * hold a slot open. What was missing is everything downstream of that: the
 * screen could not say where a record actually lives, could not say why every
 * row on the owner's register reads the same thing, and computed its score
 * twice.
 *
 * This module is the answer to those three, kept pure and kept out of the view
 * so it can be tested against numbers and so the Overview tile and the
 * Compliance page cannot drift into two arithmetics.
 *
 * ── WHY EVERY ROW ON THE OWNER'S REGISTER SAYS "New store" ───────────────
 *
 * It is not a placeholder default and not a broken join. It is the board.
 * Reproduced exactly on the local estate: `store-documentation` holds TWO
 * placements, `MN-1114` and `MN-1142`, both with their Name cell still reading
 * "New store" — the label `boardMutations` gives a row created with the board's
 * own "+ New store" button — and neither matching any site, monday name or
 * alias. Twelve certificate slots against two stores is twenty-four
 * requirements, none of them held, which is the owner's "0 of 24 on track"
 * exactly. The register is telling the truth; what it was not doing was making
 * that truth actionable.
 *
 * So `isUnlinkedBoardRow` is derived from the record's own identity rather than
 * from its NAME. Matching the string "New store" would be a lie that worked
 * until somebody typed a real store name into a row that still had no site —
 * and the register would go back to reporting a store it cannot reach with
 * nothing to say about it. See the note on that function.
 *
 * ── WHY A RECORD'S "EDIT" MUST KNOW WHERE IT LIVES ──────────────────────
 *
 * A board-derived requirement's certificate and expiry are BOARD CELLS. The
 * register recomputes its state from those cells on every read, so anything
 * written into the `compliance_documents` copy instead is discarded on the next
 * refresh — the operator watches their edit disappear. Worse, a register row
 * created that way is not inert: `DELETE /api/workspace {entity:"compliance"}`
 * on one sets `not_required`, and `notRequiredSlotsFrom` maps a register row
 * back onto a real board slot, so a stray row can switch a requirement OFF for
 * a store that needs it. `complianceRecordTarget` is what stops a screen
 * offering that.
 */

import type { ComplianceState } from "../../lib/types";

/**
 * The slice of a compliance record this module reads.
 *
 * Structural rather than an import of `WorkspaceComplianceRecord`, so this can
 * be exercised without dragging the whole workspace payload type — and so a
 * server-side `RegisterEntry`, which carries the same four provenance fields
 * under the same names, can be passed straight in.
 */
export type ComplianceRecordLike = {
  id: string;
  siteId: string;
  siteName: string;
  kind: string;
  state: ComplianceState;
  expiry: string | null;
  fileCount: number;
  /** The Store Documentation board row, or null/absent for a register-only row. */
  itemId?: string | null;
  /** The board slot key, e.g. "pat". Null/absent for a register-only row. */
  slotKey?: string | null;
};

/**
 * Is this requirement read off a Store Documentation board row?
 *
 * BOTH halves, because both are needed to address the cell: `itemId` names the
 * row and `slotKey` names which of the twelve certificates. A record carrying
 * one and not the other is not addressable on the board and is treated as
 * register-only, which is the safe direction — it routes an edit to a real
 * endpoint rather than to a board cell that cannot be found.
 *
 * The `id` prefix would answer this too (`registerDocumentId` writes
 * `board:<item>:<slot>`), and deliberately is NOT what is read: that string is
 * a server-side construction and this would be the second place in the codebase
 * that knew its shape. The fields are the fact; the id is a rendering of it.
 */
export function isBoardDerived(record: ComplianceRecordLike): boolean {
  return Boolean(record.itemId) && Boolean(record.slotKey);
}

/**
 * A Store Documentation row that no site could be matched to.
 *
 * DERIVED FROM IDENTITY, NEVER FROM THE NAME. `readComplianceRegister` sets
 * `siteId: linkedSiteId ?? store.id` — so when no site, monday name or alias
 * matches the board row's name, the record's `siteId` IS its board item id.
 * That is deliberate there: the register refuses to fuzzy-match, because
 * guessing would file one store's fire alarm certificate against another. The
 * consequence is that `siteId` is sometimes a site and sometimes a board row,
 * and this is the one function that tells them apart.
 *
 * It is the same test `recordStage` in `app/api/notifications/compliance/route.ts`
 * makes before it writes bookkeeping — `if (item.entry.siteId === itemId) return;`
 * — which is there to stop a board item id being written into
 * `compliance_documents.site_id`, a NOT NULL column whose whole meaning is "a
 * site". Two places asking the same question is fine; two places asking it
 * DIFFERENTLY is how one of them ends up wrong, so both spellings should stay
 * this one.
 *
 * MATCHING THE TITLE WOULD BE THE OBVIOUS ALTERNATIVE AND IS THE WRONG ONE. The
 * rows that provoked this all read "New store", which is what the board's own
 * "+ New store" button names a row it has just created. Filtering on that
 * string would work today and fail the moment somebody types a real store name
 * into a row that still has no `sites` record — the register would go back to
 * reporting a store it cannot reach, with nothing on screen to say so, which is
 * the defect rather than a variation of it.
 */
export function isUnlinkedBoardRow(record: ComplianceRecordLike): boolean {
  return isBoardDerived(record) && record.siteId === record.itemId;
}

/**
 * Where the LIVE record is — the thing a click-through has to reach.
 *
 * `board` means the certificate and its expiry are cells on a Store
 * Documentation row: the file lives in that slot's file column and the date in
 * its expiry column, and both are written through
 * `PATCH /api/board?board=<register>` with `update_cell`. `register` means
 * there is no board row and `compliance_documents` really is the record, so
 * `PATCH /api/workspace` is right.
 *
 * The BOARD KEY is deliberately not returned. `RegisterEntry` carries it —
 * derived from the placement, so a row cannot be alerted under one register and
 * edited on another — but `WorkspaceComplianceRecord` drops it on the way out,
 * so a client holding only the payload cannot honestly name a register. Until
 * that field travels (the handover records the one-line change), a caller
 * navigates to the Store Documentation surface and lets the section resolve its
 * own board, which is correct for the canonical estate and no worse than
 * today's behaviour for a section instance.
 */
export type ComplianceTarget =
  | { kind: "board"; itemId: string; slotKey: string }
  | { kind: "register"; id: string };

export function complianceRecordTarget(record: ComplianceRecordLike): ComplianceTarget {
  if (isBoardDerived(record)) {
    return { kind: "board", itemId: record.itemId as string, slotKey: record.slotKey as string };
  }
  return { kind: "register", id: record.id };
}

/**
 * May this record be edited through "Manage register"?
 *
 * Only a register-only one. Offering it on a board-derived requirement is an
 * invitation to write into a copy that the next read recomputes away — and, as
 * the module header sets out, a register row minted that way can go on to
 * switch a real board slot off. A screen should route a board-derived record to
 * its board row instead, and this is the question it asks.
 */
export function isRegisterEditable(record: ComplianceRecordLike): boolean {
  return !isBoardDerived(record);
}

/* ── One score, one definition ───────────────────────────────────────────── */

/**
 * The requirements a score is computed over.
 *
 * "Not required" is excluded because it is an ANSWER, not an outstanding
 * requirement: a store with no sprinkler system is not 1/12 short of compliant.
 * The portfolio filter is applied here rather than by each caller so that the
 * Overview tile and the Compliance page cannot filter differently — which they
 * were one edit away from doing, having each written the same three lines.
 */
export function scorableComplianceRecords<T extends ComplianceRecordLike>(
  records: readonly T[],
  portfolio = "all",
): T[] {
  return records.filter(
    (record) =>
      record.state !== "Not required" &&
      (portfolio === "all" || record.siteId === portfolio),
  );
}

export type ComplianceCounts = {
  Compliant: number;
  "Expiring soon": number;
  Expired: number;
  Missing: number;
};

export function complianceCounts(records: readonly ComplianceRecordLike[]): ComplianceCounts {
  const counts: ComplianceCounts = {
    Compliant: 0,
    "Expiring soon": 0,
    Expired: 0,
    Missing: 0,
  };
  for (const record of records) {
    if (record.state in counts) counts[record.state as keyof ComplianceCounts] += 1;
  }
  return counts;
}

/**
 * The headline percentage.
 *
 * An empty register scores 0, not 100. "No requirements recorded" and "every
 * requirement met" are opposite facts and a screen that renders them the same
 * way is telling somebody their estate is fine when nothing has been checked —
 * which is precisely the state the owner's register is in. The caller shows the
 * coverage line beside it to say which of the two this is.
 */
export function complianceScore(records: readonly ComplianceRecordLike[]): number {
  if (records.length === 0) return 0;
  return Math.round((complianceCounts(records).Compliant / records.length) * 100);
}

/* ── Coverage: how much of the estate Store Documentation speaks for ─────── */

/**
 * WHY A SCORE NEEDS A DENOMINATOR IT CAN EXPLAIN.
 *
 * A compliance score is a fraction of the requirements the register KNOWS
 * about, and the register knows about a store only if that store has a Store
 * Documentation row. On the owner's estate that is two rows out of thirty-one
 * sites, both unnamed and unlinked — so "0 of 24 requirements on track" is
 * arithmetically correct and operationally meaningless, and there was nothing
 * on the screen to say which.
 *
 * This counts that, from the two lists the page already holds. No new endpoint,
 * no new table, and above all NO INVENTED RECORDS: the brief is explicit that
 * the dashboard must not be populated with fabricated compliance rows, and a
 * count of what is absent is the honest opposite of that.
 *
 * `siteIds` is every site on the Sites register. `records` is the compliance
 * register. A site is COVERED when some record's `siteId` is that site — which
 * is only ever true through `linkBoardRowsToSites`, i.e. through an exact match
 * on the site's name, its two recorded monday names or one of its aliases.
 */
export type ComplianceCoverage = {
  /** Sites on the Sites register. */
  sites: number;
  /** Sites with at least one compliance requirement behind them. */
  linkedSites: number;
  /** Sites the register says nothing about at all. */
  sitesWithoutRequirements: number;
  /** Store Documentation rows that matched no site — they need naming or linking. */
  unlinkedBoardRows: number;
  /** Requirements hanging off those unlinked rows. */
  unlinkedRequirements: number;
};

export function complianceCoverage(
  records: readonly ComplianceRecordLike[],
  siteIds: readonly string[],
): ComplianceCoverage {
  const covered = new Set<string>();
  const unlinkedRows = new Set<string>();
  let unlinkedRequirements = 0;

  for (const record of records) {
    if (isUnlinkedBoardRow(record)) {
      unlinkedRows.add(record.itemId as string);
      unlinkedRequirements += 1;
      continue;
    }
    covered.add(record.siteId);
  }

  const known = new Set(siteIds);
  let linkedSites = 0;
  for (const id of known) if (covered.has(id)) linkedSites += 1;

  return {
    sites: known.size,
    linkedSites,
    sitesWithoutRequirements: known.size - linkedSites,
    unlinkedBoardRows: unlinkedRows.size,
    unlinkedRequirements,
  };
}

/**
 * The coverage line, in words, or null when there is nothing worth saying.
 *
 * Null rather than a cheerful sentence: a screen that always carries a banner
 * teaches people to stop reading it. This speaks only when the register cannot
 * account for the estate, and it says what to DO — name the row, or record the
 * board's name on the site — rather than merely reporting a number.
 *
 * The wording never contains a store name. "New store" is what the board's own
 * button calls a row nobody has named, and repeating it back would read as the
 * product having invented a store.
 */
export function complianceCoverageNotice(coverage: ComplianceCoverage): string | null {
  const parts: string[] = [];
  if (coverage.unlinkedBoardRows > 0) {
    parts.push(
      `${coverage.unlinkedBoardRows} Store Documentation ${
        coverage.unlinkedBoardRows === 1 ? "row is" : "rows are"
      } not linked to a site (${coverage.unlinkedRequirements} ${
        coverage.unlinkedRequirements === 1 ? "requirement" : "requirements"
      }). Name the row after the store, or record that name on the site, and its certificates will count here.`,
    );
  }
  if (coverage.sitesWithoutRequirements > 0) {
    parts.push(
      `${coverage.sitesWithoutRequirements} of ${coverage.sites} ${
        coverage.sites === 1 ? "site has" : "sites have"
      } no Store Documentation row, so nothing tracks their certificates.`,
    );
  }
  return parts.length ? parts.join(" ") : null;
}
