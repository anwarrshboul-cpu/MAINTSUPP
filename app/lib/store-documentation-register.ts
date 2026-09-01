/**
 * The compliance register, derived from the Store Documentation UK board.
 *
 * WHAT WAS WRONG
 *
 * The register was not derived from anything. `compliance_documents` had
 * exactly three writers — the sample seeder in `/api/workspace`, and that
 * route's own POST and PATCH — and the monday importer never touched it. So the
 * board held 31 stores and 42 expiry dates imported from the client's monday
 * account, while every compliance surface in the product read 120 rows seeded
 * from `app/lib/mock-data.ts` against ten fictional sites whose managers are
 * called "Sample Manager F". The two sets of numbers had nothing to do with
 * each other:
 *
 *   - HQ — The Loom's PAT certificate expired on 2025-04-29 on the board, with
 *     four files attached. Both compliance screens showed it as "Compliant, in
 *     date, 05/06/2027".
 *   - Cabot Circus - Bristol's electrical wiring certificate runs to 2029-03-26
 *     with ten files attached. The screens said "Missing".
 *   - The board holds eleven expired certificates across seven stores. The
 *     screens showed one, and it was invented: store-solihull PAT 2026-07-20, a
 *     date that appears nowhere on the board.
 *
 * WHY THIS FIXES IT
 *
 * The board is the record. This module turns board rows into register records
 * and is the only definition of how that is done, so `/api/workspace`, the
 * Compliance Tracker and the compliance digest cannot drift apart again. It is
 * pure — no database handle, no React, no clock of its own — because the same
 * derivation has to run on the server against drizzle rows and in the browser
 * against the `/api/board` payload.
 *
 * `compliance_documents` is not deleted and not bypassed. It becomes the
 * override and annotation layer it always should have been: it is where "Not
 * required" lives (the board has no column for it), and any requirement an
 * admin adds through Manage register that the board does not track stays
 * readable. See `readWorkspace` in app/api/workspace/route.ts for the join.
 */

import {
  storeDocumentationCertificates,
  type StoreDocumentSlot,
} from "../../db/monday-board-spec";
import type { ComplianceState } from "./types";
import { dateOnlyValue, expiryStatus } from "./expiry-status";

/* ── Input shapes ────────────────────────────────────────────────────────── */

/** A board column, as both `/api/board` and the columns table describe one. */
export type RegisterColumn = { id: string; key: string };

/** A stored cell value. `columnId`, never `columnKey` — the ids are per-org. */
export type RegisterCell = { requestId: string; columnId: string; value: string };

/** How many files hang off one file column of one row. */
export type RegisterFileCount = {
  requestId: string;
  columnId: string;
  count: number;
};

/**
 * One Store Documentation row, with its cells and file counts already resolved
 * from column id to column key. Build it with `boardRowsFrom` rather than by
 * hand, so the id→key resolution happens in one place.
 */
export type BoardStoreRow = {
  /** The board item id, e.g. `sd-001`. Stable, and the register's key. */
  id: string;
  /** The item name exactly as the board holds it, e.g. "Cabot Circus - Bristol". */
  name: string;
  /** Cell values keyed by column key, e.g. `{ patExpiry: "2026-11-24" }`. */
  cells: Record<string, string>;
  /** Attachment counts keyed by column key, e.g. `{ patCertificate: 4 }`. */
  fileCounts: Record<string, number>;
  /**
   * The board GROUP this row sits in — "Current stores", "Closed", "Europe",
   * "Other" — or null when the caller did not resolve one.
   *
   * WHY THE REGISTER CARRIES IT. The group is the only thing on this board that
   * separates the UK estate from everything else. Every one of the client's 31
   * sites is `region = 'UK'` in the database, so region cannot do it: the two
   * European rows (Mall of Netherlands, and the placeholder "Item 5") are
   * distinguished by sitting in the Europe group and by nothing else. The
   * compliance digest has to know, because alerting an operations team about a
   * Dutch store's employer's liability certificate is noise that trains them to
   * ignore the email.
   *
   * It travels on the ROW rather than being re-queried by the digest so there is
   * one definition of which group a document came from. `readComplianceRegister`
   * still returns every row whatever its group — see `withinOperationalEstate`
   * in compliance-register.ts, which the DIGEST applies and the screens do not.
   */
  boardGroup: string | null;
};

/* ── Output shapes ───────────────────────────────────────────────────────── */

/** One store's answer for one of the twelve document slots. */
export type RegisterDocument = {
  /** Stable id: the board row and the slot. Survives a rename of either. */
  id: string;
  /** The slot key from the board capture, e.g. `fire-alarm`. */
  slotKey: string;
  /** The requirement name in the register's vocabulary, e.g. "Fire Alarm". */
  kind: string;
  /** Who chases it, from the board capture. */
  responsibility: string;
  /** Whether the board tracks an expiry date for this slot at all. */
  tracksExpiry: boolean;
  /** The expiry the board holds, normalised to `YYYY-MM-DD`, or null. */
  expiry: string | null;
  /** How many files are attached to the slot's file column on this row. */
  fileCount: number;
  /** The five-word state the compliance screens speak. Derived, never stored. */
  state: ComplianceState;
};

/** One board row and its twelve documents. */
export type RegisterStore = {
  /** The board item id. */
  id: string;
  /** The item name, as the board holds it. */
  name: string;
  /** Store Type from the board, or "" when the row does not carry one. */
  type: string;
  /** Store Address from the board, or "" when the row does not carry one. */
  address: string;
  /** The Access Request contact — the only person the board names per store. */
  contact: string;
  documents: RegisterDocument[];
};

/* ── Column keys this module reads besides the twelve slots ──────────────── */

const STORE_TYPE_COLUMN = "storeType";
const STORE_ADDRESS_COLUMN = "storeAddress";
const ACCESS_REQUEST_COLUMN = "accessRequest";

/**
 * monday's export leaves a stray opening quote on some addresses — the same
 * defect `cleanMondayAddress` handles for the sites importer. Stripped here so
 * the drawer does not print `"UNIT 5, THE WHITECHAPEL…`.
 */
function tidy(value: string | undefined): string {
  return (value ?? "").replace(/^["']+/, "").trim();
}

/* ── Building rows from a board payload ──────────────────────────────────── */

/**
 * Resolve `/api/board`-shaped rows into `BoardStoreRow`s.
 *
 * The trap this closes: `/api/board` returns `items` as *placement* rows —
 * `{requestId, groupId, position, …}` and nothing else — while the values live
 * in a sibling `cells` array keyed by column id. The Calendar tab was handed
 * `payload.items` and read `item.cells[columnId]` off it, which is `undefined`
 * for every row, so a board holding 42 renewal dates rendered "No renewal dates
 * recorded yet". Anything that wants board values must join the two arrays, and
 * this is where that join is written down.
 */
export function boardRowsFrom(input: {
  /**
   * `group` is the board group's NAME when the caller resolved one. Optional
   * because the browser-side callers read `/api/board`, which already knows the
   * group by id; the server-side reader joins `maintenance_groups` for it.
   */
  requests: Array<{
    id: string;
    title?: string | null;
    reference?: string | null;
    group?: string | null;
  }>;
  columns: RegisterColumn[];
  cells: RegisterCell[];
  fileCounts?: RegisterFileCount[];
}): BoardStoreRow[] {
  const keyById = new Map(input.columns.map((column) => [column.id, column.key]));

  const cellsByRequest = new Map<string, Record<string, string>>();
  for (const cell of input.cells) {
    const key = keyById.get(cell.columnId);
    if (!key) continue;
    const bucket = cellsByRequest.get(cell.requestId) ?? {};
    bucket[key] = cell.value;
    cellsByRequest.set(cell.requestId, bucket);
  }

  const filesByRequest = new Map<string, Record<string, number>>();
  for (const entry of input.fileCounts ?? []) {
    const key = keyById.get(entry.columnId);
    if (!key) continue;
    const bucket = filesByRequest.get(entry.requestId) ?? {};
    bucket[key] = (bucket[key] ?? 0) + entry.count;
    filesByRequest.set(entry.requestId, bucket);
  }

  return input.requests.map((request) => ({
    id: request.id,
    name: (request.title ?? "").trim() || request.reference || request.id,
    cells: cellsByRequest.get(request.id) ?? {},
    fileCounts: filesByRequest.get(request.id) ?? {},
    boardGroup: (request.group ?? "").trim() || null,
  }));
}

/* ── The classifier ──────────────────────────────────────────────────────── */

/**
 * The five-word state for one document.
 *
 * `ComplianceState` is the vocabulary of the register CRUD panel, the CSV
 * export and `complianceTone`, so the five words are fixed. What changed is
 * where they come from: they are computed from the expiry date and the file
 * count on every read, not read out of a `status` column that nothing ever
 * recomputes. A row stored "Compliant" in 2026 stayed Compliant for ever.
 *
 * The one thing still taken from the register is `notRequired`. The board has
 * no column for "this store does not need a sprinkler report", so that flag has
 * nowhere else to live and an admin who sets it must not have it overwritten by
 * the next board read.
 *
 * Two edges worth stating plainly:
 *
 *  - RAMS, the Fire Risk Assessment and the Drawing have no expiry column on
 *    the board at all. Held is the whole question for them, so a file makes
 *    them "Compliant" and no file makes them "Missing"; they are never amber.
 *  - A dated slot that holds a file but no date is "Expiring soon", not
 *    "Compliant". We have the certificate and cannot say it is in date, which
 *    is precisely the amber case — something has to be done and nothing has
 *    lapsed. Calling it Compliant would file it under "nothing to do" and it
 *    would never be looked at again, which is the failure this whole module
 *    exists to end. The Compliance Tracker, which has a wider vocabulary, says
 *    "No expiry recorded" for the same document.
 */
export function complianceStateFor(input: {
  tracksExpiry: boolean;
  expiry: string | null;
  fileCount: number;
  notRequired?: boolean;
  today: Date;
}): ComplianceState {
  if (input.notRequired) return "Not required";

  const held = input.fileCount > 0;

  if (!input.tracksExpiry) return held ? "Compliant" : "Missing";

  if (input.expiry) {
    const status = expiryStatus(input.expiry, input.today);
    if (status.state === "expired") return "Expired";
    if (status.state === "due-soon") return "Expiring soon";
    if (status.state === "valid") return "Compliant";
  }

  return held ? "Expiring soon" : "Missing";
}

/* ── The derivation ──────────────────────────────────────────────────────── */

function documentFor(
  row: BoardStoreRow,
  slot: StoreDocumentSlot,
  today: Date,
  notRequired: boolean,
): RegisterDocument {
  const expiry = slot.expiryColumn
    ? dateOnlyValue(row.cells[slot.expiryColumn]) || null
    : null;
  const fileCount = row.fileCounts[slot.fileColumn] ?? 0;
  return {
    id: registerDocumentId(row.id, slot.key),
    slotKey: slot.key,
    kind: slot.label,
    responsibility: slot.responsibility,
    tracksExpiry: slot.expiryColumn !== null,
    expiry,
    fileCount,
    state: complianceStateFor({
      tracksExpiry: slot.expiryColumn !== null,
      expiry,
      fileCount,
      notRequired,
      today,
    }),
  };
}

/**
 * The id a board-derived record carries.
 *
 * Prefixed, so nothing mistakes it for a `compliance_documents.id` and tries to
 * PATCH it, and stable across imports because both halves are board identity
 * rather than a row number.
 */
export function registerDocumentId(itemId: string, slotKey: string) {
  return `board:${itemId}:${slotKey}`;
}

/**
 * Every store on the board against every document the board tracks.
 *
 * `notRequired` is the set of `${itemId}::${slotKey}` pairs an admin has marked
 * as not applicable, from the register. Everything else is board truth.
 */
export function storeDocumentationRegister(
  rows: BoardStoreRow[],
  options: { today?: Date; notRequired?: ReadonlySet<string> } = {},
): RegisterStore[] {
  const today = options.today ?? new Date();
  const notRequired = options.notRequired;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: tidy(row.cells[STORE_TYPE_COLUMN]),
    address: tidy(row.cells[STORE_ADDRESS_COLUMN]),
    contact: tidy(row.cells[ACCESS_REQUEST_COLUMN]),
    documents: storeDocumentationCertificates.map((slot) =>
      documentFor(
        row,
        slot,
        today,
        notRequired?.has(`${row.id}::${slot.key}`) ?? false,
      ),
    ),
  }));
}

/** The key `storeDocumentationRegister` expects in its `notRequired` set. */
export function notRequiredKey(itemId: string, slotKey: string) {
  return `${itemId}::${slotKey}`;
}
