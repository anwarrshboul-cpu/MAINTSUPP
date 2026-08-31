/**
 * One `/api/board?board=store-documentation` payload → what the tabs read.
 *
 * WHAT WAS WRONG
 *
 * `/api/board` returns a normalised board: `requests` are the rows (id, title),
 * `items` are placements (which group, what position) and `cells` is a flat list
 * of `{requestId, columnId, value}`. Three separate arrays describing one grid.
 *
 * The shell handed `payload.items` straight to the Calendar as if a placement
 * were a row. A placement carries no id, no title and no `cells`, so
 * `buildEntries` in `store-expiry-calendar.tsx` read `item.cells?.[columnId]`
 * on 31 objects that have no `cells` at all and found nothing: every month of
 * the calendar reported "0 renewals" while 42 expiry dates sat in the same
 * payload, in `cells`, unread. November 2026 alone carries eleven PAT expiries.
 *
 * The Compliance Tracker had the opposite problem — it never looked at this
 * board. It fetched `/api/workspace`, whose stores come from the `sites` table
 * (10 seeded demo sites) and whose compliance rows come from
 * `compliance_documents` (120 rows, every `attachment_id` NULL). So the tab
 * drew ten stores that are not the estate, thirty expiry dates monday has never
 * held, and "84 Missing" over certificates that are attached and downloadable.
 *
 * WHY THE JOIN LIVES HERE AND NOT IN THE API
 *
 * The alternative was making `/api/board` emit `items` already carrying their
 * cells. That is the same payload the maintenance board consumes through
 * `board-model.ts`, which reads placements and cells as separate arrays on
 * purpose — 744 rows × 25 columns denormalised into every placement is a much
 * larger response, and changing the shape would move a board that is pinned by
 * parity tests for the sake of a board that is not. So the join is done on the
 * shell side, once, and both tabs read the result.
 *
 * KEYED BY COLUMN ID, NOT COLUMN KEY
 *
 * `cells` is keyed by column *id*, and the ids are per-organisation seeds
 * (`seed-<org>-store-documentation-patExpiry`). The spec in
 * `db/monday-board-spec.ts` names columns by *key* (`patExpiry`). Every lookup
 * here therefore resolves key → id through `payload.columns` first.
 * `store-expiry-calendar.tsx` does the same resolution on the entries it builds,
 * and `view-model.ts` records the earlier bug where a view read `cells` by key
 * and silently found nothing. Getting that direction backwards is the failure
 * mode to watch for: it leaves the tabs empty in a way that looks like no data.
 *
 * NOTHING IS INVENTED
 *
 * A store the board has no manager for gets `""`, not a guess. A slot with no
 * file and no date is `Missing`, which is what the board says. `lifecycle` is
 * the group the row sits in — Current stores, Europe, Closed, Other — because
 * that is the only lifecycle this board records.
 */

import {
  storeDocumentationCertificates,
  type StoreDocumentSlot,
} from "../../../../db/monday-board-spec";
import { dateOnlyValue } from "../../../lib/expiry-status";
import type {
  ComplianceItem,
  ComplianceState,
  MaintenanceRequest,
} from "../../../lib/types";
import type { ComplianceTrackerStore } from "./store-compliance-tracker";
import type { BoardItem } from "./view-model";

/**
 * The slice of the board payload these builders read.
 *
 * Deliberately structural rather than the API's own row types: the shell parses
 * JSON, so what arrives is whatever the route serialised, and asking for less
 * than the route sends means a new column on `maintenance_group_items` is not a
 * compile error here.
 */
export type StoreDocumentationPayload = {
  /** The rows. Carry id and title; `items` carries neither. */
  requests?: MaintenanceRequest[];
  /** Placements. Carry group and position; no id, no title, no cells. */
  items?: Array<{ requestId: string; groupId: string; position: number }>;
  /** Groups, in board order. Only used for the row's lifecycle word. */
  groups?: Array<{ id: string; name: string; position?: number }>;
  /** The board's columns, which is how a spec key becomes a cell key. */
  columns?: Array<{ id: string; key: string }>;
  /** Every populated cell on the board, keyed by column id. */
  cells?: Array<{ requestId: string; columnId: string; value: string }>;
  /** How many files sit in each file cell. `preview` is ignored here. */
  fileCounts?: Array<{ requestId: string; columnId: string; count: number }>;
  /**
   * Slots an admin has marked as not applicable, from `compliance_documents`.
   *
   * The board has no column for this, so it is the one part of the tab's data
   * that is not board truth. `/api/board` carries it for this board only — see
   * `readNotRequiredSlots` — so the tab and /dashboard/compliance give the same
   * answer for the same store.
   */
  notRequired?: Array<{ itemId: string; slotKey: string }>;
};

/** `key → id` for this organisation's copy of the board. */
export function columnIdByKey(
  payload: StoreDocumentationPayload,
): Map<string, string> {
  return new Map((payload.columns ?? []).map((column) => [column.key, column.id]));
}

/**
 * The ids of the nine expiry columns on this organisation's copy of the board.
 *
 * The spec names them by key; `payload.columns` is what turns a key into the
 * id `cells` is actually keyed by. Anything not in this set is left exactly as
 * the board sent it — `dateOnlyValue` answers "" for "123 High Street", so
 * normalising every cell would empty the Store Address column.
 */
function expiryColumnIds(
  payload: StoreDocumentationPayload,
  slots: StoreDocumentSlot[] = storeDocumentationCertificates,
): Set<string> {
  const idByKey = columnIdByKey(payload);
  const ids = new Set<string>();
  for (const slot of slots) {
    if (!slot.expiryColumn) continue;
    const id = idByKey.get(slot.expiryColumn);
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * `requestId → {columnId: value}`. One pass over the flat cell list.
 *
 * AN EXPIRY CELL ARRIVES IN TWO SHAPES, AND ONLY ONE OF THEM IS A DATE
 *
 * monday writes a date cell either as a bare `2026-08-29` or as the JSON
 * object `{"date":"2026-08-29","time":"","icon":""}`, and on the imported
 * board the JSON shape is the majority. The server register already normalises
 * it — `store-documentation-register.ts` runs every expiry through
 * `dateOnlyValue(...) || null` — but this file handed the raw string on, and
 * the two readers of these cells fail differently and silently on it:
 *
 *  - the Compliance Tracker's status stayed CORRECT, because `readVerdict`
 *    goes through `expiryStatus`, which calls `dateOnlyValue` itself. But
 *    `daysUntil` does `new Date(raw)` → Invalid Date → null, so the cell
 *    printed no date and no "12 days overdue", and `worstDays` — the tie-break
 *    that decides which store is in the most trouble — ignored the row.
 *  - the renewal Calendar dropped the entry ALTOGETHER: `parseIsoDay` in
 *    `store-expiry-calendar.tsx` anchors `^(\d{4})-(\d{2})-(\d{2})`, a JSON
 *    string does not match, and `buildEntries` does `continue`. Same symptom
 *    as the bug that file's header records — an empty month with the data
 *    sitting in the payload — from a different cause.
 *
 * Normalising HERE is what fixes both at once: `buildStoreBoardItems` and
 * `complianceFor` both read this map, so neither can be repaired without the
 * other. Doing it in the three consumers instead is three places to keep in
 * step, which is how this class of bug came back the first time.
 */
export function cellsByRequest(
  payload: StoreDocumentationPayload,
): Map<string, Record<string, string>> {
  const byRequest = new Map<string, Record<string, string>>();
  const expiryColumns = expiryColumnIds(payload);
  for (const cell of payload.cells ?? []) {
    let row = byRequest.get(cell.requestId);
    if (!row) {
      row = {};
      byRequest.set(cell.requestId, row);
    }
    // `dateOnlyValue` answers "" for anything it cannot read as a date, which
    // the empty check below then drops — an unreadable date is no date, and
    // that is what the register says too.
    const value = expiryColumns.has(cell.columnId)
      ? dateOnlyValue(cell.value)
      : cell.value;
    // An empty string is not a value. The board writes "" when a date is
    // cleared, and a calendar entry for "" would be an entry for nothing.
    if (value !== null && value !== undefined && value !== "") {
      row[cell.columnId] = value;
    }
  }
  return byRequest;
}

/** `requestId::columnId → count`, so an absent cell is 0 rather than undefined. */
export function fileCountsByCell(
  payload: StoreDocumentationPayload,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of payload.fileCounts ?? []) {
    counts.set(`${entry.requestId}::${entry.columnId}`, entry.count);
  }
  return counts;
}

/**
 * The board's rows as `BoardItem[]` — id, title, group, and cells keyed by
 * column id, which is the shape every alternative view already expects.
 *
 * Ordered by group then position, so the Calendar's fallback ordering and the
 * grid agree about what "first" means. A row with no placement still appears:
 * `requests` is scoped to placed ids by the route, so that cannot currently
 * happen, but dropping a store because a join row is missing would hide a real
 * store's real expiry dates, which is the exact failure this file exists to fix.
 */
export function buildStoreBoardItems(
  payload: StoreDocumentationPayload,
): BoardItem[] {
  const cells = cellsByRequest(payload);
  const placement = new Map(
    (payload.items ?? []).map((item) => [item.requestId, item]),
  );
  const groupOrder = new Map(
    (payload.groups ?? []).map((group, index) => [
      group.id,
      group.position ?? index,
    ]),
  );

  const rows = (payload.requests ?? []).map((request) => {
    const placed = placement.get(request.id);
    const item: BoardItem = {
      id: request.id,
      reference: (request as { reference?: string | null }).reference ?? null,
      title: request.title,
      parentId: request.parentId ?? null,
      archived: Boolean((request as { archived?: boolean }).archived),
      groupId: placed?.groupId ?? null,
      status: request.status ?? null,
      priority: request.priority ?? null,
      siteId: request.siteId ?? null,
      location: request.location ?? null,
      description: request.description ?? null,
      requester: request.requester ?? null,
      category: request.category ?? null,
      engineer: request.engineer ?? null,
      tier: request.tier ?? null,
      contractor: request.contractor ?? null,
      assignee: request.assignee ?? null,
      requestedAt: request.requestedAt ?? null,
      dueAt: request.dueAt ?? null,
      completedAt: request.completedAt ?? null,
      nextUpdateAt: request.nextUpdateAt ?? null,
      cost: request.cost ?? null,
      attachmentCount: request.attachmentCount ?? null,
      commentCount: request.commentCount ?? null,
      cells: cells.get(request.id) ?? {},
    };
    return { item, placed };
  });

  rows.sort((left, right) => {
    const leftGroup =
      groupOrder.get(left.placed?.groupId ?? "") ?? Number.MAX_SAFE_INTEGER;
    const rightGroup =
      groupOrder.get(right.placed?.groupId ?? "") ?? Number.MAX_SAFE_INTEGER;
    if (leftGroup !== rightGroup) return leftGroup - rightGroup;
    return (left.placed?.position ?? 0) - (right.placed?.position ?? 0);
  });

  return rows.map((row) => row.item);
}

/**
 * What the register HOLDS for one document slot, as a `ComplianceState`.
 *
 * The tracker's own comment sets the division of labour: "the register's
 * `state` is trusted for 'we do not have this' and 'this does not apply here';
 * the date is trusted for everything about expiry, because a status string goes
 * stale the day after it is written and a date does not". So this answers only
 * the holding question and never looks at a clock — `cellFor` in the tracker
 * derives expired / due soon / in date from the date itself.
 *
 * A slot with an expiry date but no attached file counts as held: monday knows
 * when the PAT certificate runs out even where the PDF was never uploaded, and
 * calling that "Missing" would report a certificate that exists as one that
 * was never obtained. The tracker then says "No expiry recorded" for the
 * mirror case — a file with no date — which is equally the truth.
 *
 * "Not required" is never produced HERE. The board has no way to say it, so it
 * arrives as an override on the payload and `complianceFor` applies it over the
 * top of whatever this function answered.
 */
function holdingState(fileCount: number, expiry: string | null): ComplianceState {
  return fileCount > 0 || expiry !== null ? "Compliant" : "Missing";
}

/** The twelve slots against one row, in monday's column order. */
function complianceFor(
  requestId: string,
  slots: StoreDocumentSlot[],
  idByKey: Map<string, string>,
  cells: Record<string, string>,
  counts: Map<string, number>,
  notRequired: ReadonlySet<string>,
): ComplianceItem[] {
  return slots.map((slot) => {
    const fileColumnId = idByKey.get(slot.fileColumn);
    const expiryColumnId = slot.expiryColumn
      ? idByKey.get(slot.expiryColumn)
      : undefined;
    const fileCount = fileColumnId
      ? (counts.get(`${requestId}::${fileColumnId}`) ?? 0)
      : 0;
    /*
     * `cellsByRequest` has already normalised this — see the note there. The
     * call is repeated because the next line is `holdingState(fileCount,
     * expiry)`, which reads `expiry !== null` as "we hold the certificate", so
     * a raw `{"date":…}` reaching here would be a date-shaped string that no
     * consumer can read and every consumer counts as held.
     *
     * `|| null`, not the bare call: `dateOnlyValue` answers "" rather than
     * null for a value it cannot read, and "" is not null. The server register
     * writes it the same way for the same reason.
     */
    const rawExpiry = expiryColumnId ? (cells[expiryColumnId] ?? null) : null;
    const expiry = dateOnlyValue(rawExpiry) || null;
    /*
     * The override wins over what the board holds. A store told us it does not
     * need this certificate; a missing file is then the expected state and not
     * a finding, and the tracker must not colour it red for ever.
     */
    return {
      kind: slot.label,
      state: notRequired.has(`${requestId}::${slot.key}`)
        ? ("Not required" as ComplianceState)
        : holdingState(fileCount, expiry),
      expiry,
      fileCount,
    };
  });
}

/**
 * The 31 board stores as the Compliance Tracker's rows.
 *
 * Ids are the board's own (`sd-001`), not `site-*`. The tab's counters, filters
 * and Raise-a-ticket handlers all key off `store.id`, and they must key off the
 * row that actually holds the certificate. The `sites` table's ten rows are a
 * different model with different names — "Solihull" against the board's
 * "Touchwood - Solihull", "Bristol Cabot Circus" against "Cabot Circus -
 * Bristol" — so reconciling the two by name would mis-join. It is not attempted.
 */
export function buildComplianceStores(
  payload: StoreDocumentationPayload,
  slots: StoreDocumentSlot[] = storeDocumentationCertificates,
): ComplianceTrackerStore[] {
  const idByKey = columnIdByKey(payload);
  const cells = cellsByRequest(payload);
  const counts = fileCountsByCell(payload);
  const groupName = new Map(
    (payload.groups ?? []).map((group) => [group.id, group.name]),
  );
  const placement = new Map(
    (payload.items ?? []).map((item) => [item.requestId, item]),
  );
  const notRequired = new Set(
    (payload.notRequired ?? []).map((slot) => `${slot.itemId}::${slot.slotKey}`),
  );

  return (payload.requests ?? []).map((request) => ({
    id: request.id,
    name: request.title,
    // The board records no store manager. An empty string is the honest answer
    // and the tab's search already tolerates it; inventing one would put a name
    // beside a compliance failure that nobody agreed to chase.
    manager: "",
    lifecycle: groupName.get(placement.get(request.id)?.groupId ?? "") ?? "",
    compliance: complianceFor(
      request.id,
      slots,
      idByKey,
      cells.get(request.id) ?? {},
      counts,
      notRequired,
    ),
  }));
}
