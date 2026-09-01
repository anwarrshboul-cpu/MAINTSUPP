/**
 * Reading the compliance register out of the database — one query, one join,
 * one set of answers.
 *
 * WHAT WAS WRONG
 *
 * Two things read compliance out of the database and they read different
 * things. `/api/workspace` read `compliance_documents`, a table only the sample
 * seeder and the manual CRUD ever wrote. The compliance digest
 * (`/api/notifications/compliance`) read the same table joined to `sites`. So
 * the whole product's view of compliance was 120 rows seeded from
 * `app/lib/mock-data.ts` across ten fictional sites, while the Store
 * Documentation board — the client's actual monday export, 31 stores and 42
 * expiry dates — reached nothing at all.
 *
 * The consequences were not academic. Eleven certificates were expired on the
 * board on 2026-08-09: five at Churchill Square - Brighton, the PLI at Mall of
 * Netherlands (2024-02-18) and at Item 5 (2024-02-13), and PAT certificates at
 * Westfield White City Bespoke, Highcross Leicester, Metrocentre - Gateshead
 * and HQ — The Loom. Not one of them could ever produce an alert, because none
 * of those stores has a row in `sites` or in `compliance_documents`. Meanwhile
 * the digest would happily alert on dates that exist nowhere but the seed.
 *
 * WHAT THIS DOES
 *
 * Derives the register from the board (see
 * app/lib/store-documentation-register.ts for the per-slot rules) and keeps
 * `compliance_documents` as the override and annotation layer:
 *
 *   - "Not required" comes from the register. The board has no column for it.
 *   - A register row the board cannot speak for — a site with no board row, or
 *     a requirement outside the twelve board slots — is kept, with its state
 *     recomputed from its own expiry date rather than read from a status string
 *     nothing ever revisits.
 *   - `last_alert_stage` bookkeeping travels with the entry, so the digest can
 *     record what it has already warned about without a second source of truth.
 *
 * Nothing here writes, and nothing here drops a row.
 */

import { and, count, eq, isNotNull, isNull } from "drizzle-orm";
import type { getDb } from "../../db";
import {
  attachments,
  complianceDocuments,
  maintenanceBoardCells,
  maintenanceBoardColumns,
  maintenanceGroupItems,
  maintenanceGroups,
  maintenanceRequests,
  siteAliases,
  sites,
} from "../../db/schema";
import { storeDocumentationCertificates } from "../../db/monday-board-spec";
import { liveAttachmentRows } from "./attachment-counts";
import { normaliseSiteName } from "./sites-repository";
import {
  boardRowsFrom,
  complianceStateFor,
  notRequiredKey,
  registerDocumentId,
  storeDocumentationRegister,
  type BoardStoreRow,
} from "./store-documentation-register";
import type { ComplianceItem, ComplianceState } from "./types";

/** The board the register is derived from. */
export const STORE_DOCUMENTATION_BOARD_ID = "store-documentation";

/**
 * The drizzle handle, exactly as `sites-repository.ts` types it. Both callers
 * get theirs from `scopedDb`, which has already narrowed it to one organisation
 * — every query below still filters on `organisationId` as well, because a
 * repository that relies on its caller for tenant scoping is one refactor away
 * from serving another client's certificates.
 */
type Database = Awaited<ReturnType<typeof getDb>>;

/** One document, ready for a screen or for the digest. */
export type RegisterEntry = {
  /** The board item this came from, or null for a register-only row. */
  itemId: string | null;
  /** The board slot key, or null for a requirement the board does not track. */
  slotKey: string | null;
  /** The `compliance_documents` row backing it, when there is one. */
  registerId: string | null;
  /** The id a screen should use: the register row's when there is one. */
  id: string;
  /** The linked site id, or the board item id when no site matches. */
  siteId: string;
  siteName: string;
  /** Store Type from the board, when the board holds this store. */
  siteType: string | null;
  /** Store Address from the board, when the board holds this store. */
  siteAddress: string | null;
  kind: string;
  state: ComplianceState;
  expiry: string | null;
  fileCount: number;
  notRequired: boolean;
  /** The last warning stage the digest sent for this document. */
  lastAlertStage: string | null;
  /**
   * The board group this document's store sits in, or null for a register-only
   * row. Carried so the digest can scope itself without a second query — see
   * `withinOperationalEstate`.
   */
  boardGroup: string | null;
  /**
   * Whether the linked site is closed, from `sites.lifecycle` / `sites.status`.
   * False when there is no linked site to ask.
   */
  siteClosed: boolean;
};

export type ComplianceRegister = {
  entries: RegisterEntry[];
  /** Documents per site id, for `StoreRecord.compliance`. */
  bySite: Map<string, ComplianceItem[]>;
};

/** Slot key for a requirement name, e.g. "Fire Alarm" → `fire-alarm`. */
const slotKeyByKind = new Map(
  storeDocumentationCertificates.map((slot) => [slot.label, slot.key]),
);

/**
 * Whether the board tracks an expiry date for a requirement NAME.
 *
 * Used for register-only rows, which carry a `kind` and no slot. It is how a
 * dated requirement with no date recorded is told apart from one that never has
 * a date — see the `state` derivation in `readComplianceRegister`.
 */
const tracksExpiryByKind = new Map(
  storeDocumentationCertificates.map((slot) => [slot.label, slot.expiryColumn !== null]),
);

/* ── Operational scope ───────────────────────────────────────────────────── */

/**
 * The board groups whose rows are not part of the active UK operation.
 *
 * `europe` is the only geographic discriminator this data has. Every one of the
 * client's 31 sites is `region = 'UK'` in the database, so region cannot
 * separate anything; the two non-UK rows — Mall of Netherlands and the
 * placeholder "Item 5" — are identified by sitting in the board's Europe group
 * and by nothing else. Neither may ever become a UK canonical site.
 *
 * `closed` is a lifecycle discriminator, not a geographic one, and it is the
 * reason this is a set rather than a single check.
 */
const NON_OPERATIONAL_GROUPS = new Set(["europe", "closed"]);

/**
 * Whether a document counts towards the ACTIVE UK OPERATIONAL view — which
 * today means: whether the compliance digest may raise an alert about it.
 *
 * WHAT THIS IS NOT. It is not a visibility rule. `readComplianceRegister`
 * returns every row whatever this says, and every screen keeps showing the
 * whole board. A closed store's expired fire alarm certificate stays fully
 * readable on the board, in the register, on the Compliance Tracker and in the
 * CSV export — it simply stops generating a CURRENT operational alert, because
 * nobody is going to book a contractor for a shop that is not trading, and an
 * alert nobody can action is what teaches people to filter the digest to junk.
 *
 * THE TWO EXCLUSIONS, and why each is drawn where it is:
 *
 *  - EUROPE / non-UK. Excluded outright. These rows are outside the estate this
 *    digest speaks for.
 *  - CLOSED. Excluded from alerting, kept everywhere else. Read from the board
 *    group AND from the linked site's own lifecycle, because the two can
 *    disagree: a store can be marked Closed on the site record before anyone
 *    moves its board row, and the safe reading of "closed" for the purpose of
 *    NOT nagging someone is either source saying so.
 *
 * Everything else is in, "Current stores" and "Other" alike. Internal and
 * warehouse rows keep exactly the treatment they have today: the code has never
 * said anything special about them and this is not the place to invent a policy
 * for them.
 *
 * A row with no board group and no resolvable site is INCLUDED. Silently
 * dropping it would re-create, in the opposite direction, the exact failure this
 * module exists to end — a digest that is loud about fiction and silent about
 * the estate. If we cannot tell, we tell someone.
 */
export function withinOperationalEstate(entry: {
  boardGroup: string | null;
  siteClosed: boolean;
}): boolean {
  const group = (entry.boardGroup ?? "").trim().toLowerCase();
  if (group && NON_OPERATIONAL_GROUPS.has(group)) return false;
  if (entry.siteClosed) return false;
  return true;
}

/** The `sites` lifecycle/status words that mean a store is not trading. */
const CLOSED_SITE_WORDS = new Set(["closed", "archived", "inactive"]);

function siteIsClosed(site: { lifecycle?: string | null; status?: string | null }) {
  const lifecycle = (site.lifecycle ?? "").trim().toLowerCase();
  const status = (site.status ?? "").trim().toLowerCase();
  return CLOSED_SITE_WORDS.has(lifecycle) || CLOSED_SITE_WORDS.has(status);
}

/**
 * Every Store Documentation row with its cells and file counts.
 *
 * Filtered by organisation *and* board, with soft-deleted rows excluded, so a
 * binned store leaves the register the way it leaves the board.
 */
async function readStoreDocumentationRows(
  db: Database,
  orgId: string,
): Promise<BoardStoreRow[]> {
  /*
   * `groupId` comes back with the placement now.
   *
   * It costs nothing — this query already runs, and the column is NOT NULL on
   * `maintenance_group_items` — and it is the only thing on this board that
   * separates the UK estate from the European rows. See `BoardStoreRow.boardGroup`
   * and `withinOperationalEstate` for what it is for.
   */
  const placements = await db
    .select({
      requestId: maintenanceGroupItems.requestId,
      groupId: maintenanceGroupItems.groupId,
    })
    .from(maintenanceGroupItems)
    .where(
      and(
        eq(maintenanceGroupItems.organisationId, orgId),
        eq(maintenanceGroupItems.boardId, STORE_DOCUMENTATION_BOARD_ID),
      ),
    );
  if (placements.length === 0) return [];
  const placedRows = placements as Array<{ requestId: string; groupId: string }>;
  const placed = new Set(placedRows.map((row) => row.requestId));
  const groupIdByRequest = new Map(placedRows.map((row) => [row.requestId, row.groupId]));

  const groupRows = await db
    .select({ id: maintenanceGroups.id, name: maintenanceGroups.name })
    .from(maintenanceGroups)
    .where(
      and(
        eq(maintenanceGroups.organisationId, orgId),
        eq(maintenanceGroups.boardId, STORE_DOCUMENTATION_BOARD_ID),
      ),
    );
  const groupNameById = new Map(
    (groupRows as Array<{ id: string; name: string }>).map((row) => [row.id, row.name]),
  );

  const [requestRows, columnRows, cellRows, fileRows] = await Promise.all([
    db
      .select({ id: maintenanceRequests.id, title: maintenanceRequests.title })
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.organisationId, orgId),
          isNull(maintenanceRequests.deletedAt),
        ),
      ),
    db
      .select({ id: maintenanceBoardColumns.id, key: maintenanceBoardColumns.key })
      .from(maintenanceBoardColumns)
      .where(
        and(
          eq(maintenanceBoardColumns.organisationId, orgId),
          eq(maintenanceBoardColumns.boardId, STORE_DOCUMENTATION_BOARD_ID),
        ),
      ),
    db
      .select({
        requestId: maintenanceBoardCells.requestId,
        columnId: maintenanceBoardCells.columnId,
        value: maintenanceBoardCells.value,
      })
      .from(maintenanceBoardCells)
      .where(
        and(
          eq(maintenanceBoardCells.organisationId, orgId),
          eq(maintenanceBoardCells.boardId, STORE_DOCUMENTATION_BOARD_ID),
        ),
      ),
    /*
     * A certificate is "held" when a LIVE file hangs off its file column, so the
     * count matters rather than the existence of a row somewhere. Grouped in
     * SQL because this organisation has 2,968 attachments and only a few dozen
     * of them are on this board.
     *
     * `liveAttachmentRows()` IS THE WHOLE CORRECTNESS OF THIS COUNT, and it was
     * missing here. Without it the count is of ROWS, and a row is not a
     * document once documents have versions:
     *
     *   upload a PAT certificate        → 1
     *   replace it                      → 2
     *   replace it again                → 3
     *   archive the current version     → 3
     *
     * One certificate, replaced twice, counted three times; and archiving the
     * live version changed nothing at all. That number is not cosmetic here —
     * `complianceStateFor` decides a slot is HELD by asking `fileCount > 0`, so
     * a slot stayed "Compliant" on the strength of superseded certificates,
     * including ones superseded precisely BECAUSE they had expired, and an
     * archived certificate went on holding its slot open. This is the exact
     * failure the register was rebuilt to end, re-entering through versioning
     * rather than through a stale status column.
     *
     * The predicate is imported, never re-typed. It already existed and was
     * already correct in `reconcileAttachmentCounts` and in `GET /api/files`;
     * it was applied to two of the four readers of this table, and the two that
     * missed it disagreed with the two that did. A third hand-written copy of
     * `is_current AND archived_at IS NULL` is how that divergence happens, so
     * the shared helper is the fix and the copy is the bug.
     */
    db
      .select({
        requestId: attachments.requestId,
        columnId: attachments.boardColumnId,
        count: count(),
      })
      .from(attachments)
      .where(
        and(
          eq(attachments.organisationId, orgId),
          isNotNull(attachments.boardColumnId),
          liveAttachmentRows(),
        ),
      )
      .groupBy(attachments.requestId, attachments.boardColumnId),
  ]);

  const columnIds = new Set(columnRows.map((column: { id: string }) => column.id));

  return boardRowsFrom({
    requests: (requestRows as Array<{ id: string; title: string | null }>)
      .filter((row) => placed.has(row.id))
      .map((row) => ({
        ...row,
        group: groupNameById.get(groupIdByRequest.get(row.id) ?? "") ?? null,
      })),
    columns: columnRows,
    cells: cellRows,
    fileCounts: fileRows.filter(
      (
        row: { requestId: string | null; columnId: string | null; count: number },
      ): row is { requestId: string; columnId: string; count: number } =>
        Boolean(row.requestId) &&
        Boolean(row.columnId) &&
        columnIds.has(row.columnId ?? "") &&
        placed.has(row.requestId ?? ""),
    ),
  });
}

/**
 * Which site, if any, a board row is the same place as.
 *
 * Board rows carry no `site_id` — the monday export has store names and nothing
 * else — so the link goes through `normaliseSiteName`, the same resolver the
 * sites importer uses, over a site's canonical name, its two recorded monday
 * names and its aliases. There is no fuzzy matching: a name either normalises
 * to one of those or the board row keeps its own identity. Guessing would
 * attach one store's fire alarm certificate to another store's row, which is
 * worse than not linking at all.
 *
 * "Solihull" and "Touchwood - Solihull" therefore do NOT link until somebody
 * records the board name on the site — `db/monday-export/link-store-documentation-sites.mjs`
 * writes exactly that, and only where the token sets are identical.
 */
function siteIdByBoardName(
  siteRows: Array<{
    id: string;
    name: string;
    mondayComplianceName: string | null;
    mondayMaintenanceName: string | null;
  }>,
  aliasRows: Array<{ siteId: string; normalised: string }>,
) {
  const byName = new Map<string, string>();
  const remember = (value: string | null | undefined, siteId: string) => {
    const key = value ? normaliseSiteName(value) : "";
    if (key && !byName.has(key)) byName.set(key, siteId);
  };
  for (const site of siteRows) {
    remember(site.name, site.id);
    remember(site.mondayComplianceName, site.id);
    remember(site.mondayMaintenanceName, site.id);
  }
  for (const alias of aliasRows) remember(alias.normalised, alias.siteId);
  return byName;
}

/** One board slot an admin has marked as not applicable to that store. */
export type NotRequiredSlot = { itemId: string; slotKey: string };

/**
 * Which board slots are marked "Not required", from the register rows.
 *
 * Pure, and shared by the two readers below so the flag cannot mean one thing
 * on /dashboard/compliance and another on the board's Compliance Tracker tab —
 * which is exactly what it did: the tab was fed straight from the board
 * payload, the board has no not-required column, and Westfield Stratford's fire
 * alarm and water hygiene rows read "Missing" on one screen and "Not required"
 * on the other. Two screens, one flag, one answer.
 *
 * A register row reaches a board row either by already being keyed on the board
 * item id, or through the site link. A row whose requirement is not one of the
 * twelve board slots has no board slot to mark and is skipped — it survives as
 * a register-only entry in `readComplianceRegister`.
 */
export function notRequiredSlotsFrom(
  registerRows: Array<{
    siteId: string;
    kind: string;
    status: string;
    notRequired: boolean;
  }>,
  boardRowIds: ReadonlySet<string>,
  itemIdBySiteId: ReadonlyMap<string, string>,
): NotRequiredSlot[] {
  const slots: NotRequiredSlot[] = [];
  for (const row of registerRows) {
    if (!row.notRequired && row.status !== "Not required") continue;
    const slotKey = slotKeyByKind.get(row.kind);
    if (!slotKey) continue;
    const itemId = boardRowIds.has(row.siteId)
      ? row.siteId
      : itemIdBySiteId.get(row.siteId);
    if (itemId) slots.push({ itemId, slotKey });
  }
  return slots;
}

/**
 * `boardItemId → siteId` and its inverse, for one organisation's board rows.
 *
 * The link is by normalised name only — see `siteIdByBoardName` for why there
 * is no fuzzy matching.
 */
function linkBoardRowsToSites(
  boardNames: Array<{ id: string; name: string }>,
  siteRows: Array<{
    id: string;
    name: string;
    mondayComplianceName: string | null;
    mondayMaintenanceName: string | null;
  }>,
  aliasRows: Array<{ siteId: string; normalised: string }>,
) {
  const linkByName = siteIdByBoardName(siteRows, aliasRows);
  const siteIdByItemId = new Map<string, string | null>(
    boardNames.map((row) => [row.id, linkByName.get(normaliseSiteName(row.name)) ?? null]),
  );
  const itemIdBySiteId = new Map<string, string>();
  for (const [itemId, siteId] of siteIdByItemId) {
    if (siteId && !itemIdBySiteId.has(siteId)) itemIdBySiteId.set(siteId, itemId);
  }
  return { siteIdByItemId, itemIdBySiteId };
}

/**
 * Just the "Not required" overrides, for the board payload.
 *
 * `/api/board` serves the Compliance Tracker tab, and the tab reads the board
 * and nothing else — correctly, because the board is the record. But
 * "Not required" is the one fact the board cannot hold, so it has to travel
 * with the payload or the tab has a filter option it can never populate.
 *
 * Deliberately lighter than `readComplianceRegister`: it wants row NAMES to
 * make the site link, not cells and not attachment counts, so it never touches
 * `maintenance_board_cells` or the 2,968-row attachments table.
 */
export async function readNotRequiredSlots(
  db: Database,
  orgId: string,
): Promise<NotRequiredSlot[]> {
  const [siteRows, aliasRows, registerRows, placements] = await Promise.all([
    db
      .select({
        id: sites.id,
        name: sites.name,
        mondayComplianceName: sites.mondayComplianceName,
        mondayMaintenanceName: sites.mondayMaintenanceName,
      })
      .from(sites)
      .where(eq(sites.organisationId, orgId)),
    db
      .select({ siteId: siteAliases.siteId, normalised: siteAliases.normalised })
      .from(siteAliases)
      .where(eq(siteAliases.organisationId, orgId)),
    db
      .select({
        siteId: complianceDocuments.siteId,
        kind: complianceDocuments.kind,
        status: complianceDocuments.status,
        notRequired: complianceDocuments.notRequired,
      })
      .from(complianceDocuments)
      .where(eq(complianceDocuments.organisationId, orgId)),
    db
      .select({ requestId: maintenanceGroupItems.requestId })
      .from(maintenanceGroupItems)
      .where(
        and(
          eq(maintenanceGroupItems.organisationId, orgId),
          eq(maintenanceGroupItems.boardId, STORE_DOCUMENTATION_BOARD_ID),
        ),
      ),
  ]);

  const placed = new Set(
    (placements as Array<{ requestId: string }>).map((row) => row.requestId),
  );
  if (placed.size === 0) return [];

  const titleRows = await db
    .select({ id: maintenanceRequests.id, title: maintenanceRequests.title })
    .from(maintenanceRequests)
    .where(
      and(
        eq(maintenanceRequests.organisationId, orgId),
        isNull(maintenanceRequests.deletedAt),
      ),
    );
  const boardNames = (titleRows as Array<{ id: string; title: string | null }>)
    .filter((row) => placed.has(row.id))
    .map((row) => ({ id: row.id, name: (row.title ?? "").trim() || row.id }));

  const { itemIdBySiteId } = linkBoardRowsToSites(boardNames, siteRows, aliasRows);
  return notRequiredSlotsFrom(
    registerRows as Array<{
      siteId: string;
      kind: string;
      status: string;
      notRequired: boolean;
    }>,
    placed,
    itemIdBySiteId,
  );
}

/**
 * The whole register: the board, with `compliance_documents` layered over it.
 *
 * `today` is injectable so a caller can classify a whole estate against one
 * instant, and so a test can pin the date.
 */
export async function readComplianceRegister(
  db: Database,
  orgId: string,
  options: { today?: Date } = {},
): Promise<ComplianceRegister> {
  const today = options.today ?? new Date();

  const [siteRows, aliasRows, registerRows, boardRows] = await Promise.all([
    db
      .select({
        id: sites.id,
        name: sites.name,
        mondayComplianceName: sites.mondayComplianceName,
        mondayMaintenanceName: sites.mondayMaintenanceName,
        /*
         * For `withinOperationalEstate`. Both columns, because they can
         * disagree — Staging holds four sites at `lifecycle='Closed',
         * status='closed'` and three at `lifecycle='Closed', status='other'`,
         * and the second group is just as shut as the first.
         */
        lifecycle: sites.lifecycle,
        status: sites.status,
      })
      .from(sites)
      .where(eq(sites.organisationId, orgId)),
    db
      .select({ siteId: siteAliases.siteId, normalised: siteAliases.normalised })
      .from(siteAliases)
      .where(eq(siteAliases.organisationId, orgId)),
    db
      .select()
      .from(complianceDocuments)
      .where(eq(complianceDocuments.organisationId, orgId))
      .orderBy(complianceDocuments.siteId, complianceDocuments.kind),
    readStoreDocumentationRows(db, orgId),
  ]);

  type RegisterRow = {
    id: string;
    siteId: string;
    kind: string;
    status: string;
    expiryDate: string | null;
    attachmentId: string | null;
    notRequired: boolean;
    lastAlertStage: string | null;
  };
  const rows = registerRows as RegisterRow[];

  const siteNameById = new Map<string, string>(
    (siteRows as Array<{ id: string; name: string }>).map((site) => [site.id, site.name]),
  );
  const siteClosedById = new Map<string, boolean>(
    (
      siteRows as Array<{ id: string; lifecycle: string | null; status: string | null }>
    ).map((site) => [site.id, siteIsClosed(site)]),
  );
  /** Board group NAME per board item, for `withinOperationalEstate`. */
  const groupByItemId = new Map<string, string | null>(
    boardRows.map((row) => [row.id, row.boardGroup]),
  );
  const boardRowIds = new Set(boardRows.map((row) => row.id));
  const { siteIdByItemId, itemIdBySiteId } = linkBoardRowsToSites(
    boardRows,
    siteRows,
    aliasRows,
  );

  const registerByKey = new Map(rows.map((row) => [`${row.siteId}::${row.kind}`, row]));
  const registerRowFor = (itemId: string, kind: string) => {
    const siteId = siteIdByItemId.get(itemId);
    return (
      (siteId ? registerByKey.get(`${siteId}::${kind}`) : undefined) ??
      registerByKey.get(`${itemId}::${kind}`) ??
      null
    );
  };

  // "Not required" survives a board read. It is set from Manage register, the
  // board has no column for it, and losing it would silently switch twelve
  // requirements back on for a store that does not need them.
  const notRequired = new Set(
    notRequiredSlotsFrom(rows, boardRowIds, itemIdBySiteId).map((slot) =>
      notRequiredKey(slot.itemId, slot.slotKey),
    ),
  );

  const entries: RegisterEntry[] = [];
  const bySite = new Map<string, ComplianceItem[]>();
  const covered = new Set<string>();

  const remember = (siteId: string, item: ComplianceItem) => {
    const current = bySite.get(siteId) ?? [];
    current.push(item);
    bySite.set(siteId, current);
  };

  for (const store of storeDocumentationRegister(boardRows, { today, notRequired })) {
    const linkedSiteId = siteIdByItemId.get(store.id) ?? null;
    for (const document of store.documents) {
      const registerRow = registerRowFor(store.id, document.kind);
      if (registerRow) covered.add(registerRow.id);
      entries.push({
        itemId: store.id,
        slotKey: document.slotKey,
        registerId: registerRow?.id ?? null,
        id: registerRow?.id ?? registerDocumentId(store.id, document.slotKey),
        siteId: linkedSiteId ?? store.id,
        siteName: store.name,
        siteType: store.type || null,
        siteAddress: store.address || null,
        kind: document.kind,
        state: document.state,
        expiry: document.expiry,
        fileCount: document.fileCount,
        notRequired: document.state === "Not required",
        lastAlertStage: registerRow?.lastAlertStage ?? null,
        boardGroup: groupByItemId.get(store.id) ?? null,
        siteClosed: linkedSiteId ? (siteClosedById.get(linkedSiteId) ?? false) : false,
      });
      if (linkedSiteId) {
        remember(linkedSiteId, {
          kind: document.kind,
          state: document.state,
          expiry: document.expiry,
          fileCount: document.fileCount,
        });
      }
    }
  }

  /*
   * Register rows the board does not speak for. Their state is recomputed from
   * their own expiry date for the same reason the board's is: a stored status
   * string is a statement about the day it was written.
   *
   * THE STORED STATUS IS NO LONGER A FALLBACK. This branch used to end
   * `: (row.status as ComplianceState)` — so a row with no expiry date served
   * whatever word was written into `compliance_documents.status`, whenever that
   * was, and by whoever. It was the last path in the codebase by which a stale
   * stored status could still reach a screen, and it was also an unchecked cast:
   * the PATCH accepted arbitrary text for `state`, so the "ComplianceState" this
   * produced could be any string at all, including one no screen has a colour
   * for.
   *
   * It is derived instead, from the same classifier everything else uses.
   * `tracksExpiry` comes from the requirement NAME: for one of the twelve board
   * slots we know whether a date is expected, so a dated requirement with no
   * date lands on "Expiring soon" (we hold the certificate and cannot say it is
   * in date — the amber case) or "Missing", exactly as it would on the board.
   * For a requirement outside the twelve we cannot know, so held-or-not is the
   * whole question and the answer is Compliant or Missing.
   */
  for (const row of rows) {
    if (covered.has(row.id)) continue;
    const fileCount = row.attachmentId ? 1 : 0;
    const state: ComplianceState = row.notRequired
      ? "Not required"
      : complianceStateFor({
          /*
           * A date ON THE ROW counts, even for a requirement the board does not
           * know. Somebody recorded an expiry against it, which is the only
           * evidence there is that this requirement has one — and dropping that
           * evidence would classify a register-only certificate with a perfectly
           * good date two years out as "Missing", because `complianceStateFor`
           * ignores `expiry` entirely when `tracksExpiry` is false.
           *
           * The `tracksExpiryByKind` half is what makes the NO-DATE case right:
           * one of the twelve board requirements with no date recorded is amber
           * or Missing, not silently "Compliant", exactly as it would be on the
           * board.
           */
          tracksExpiry: (tracksExpiryByKind.get(row.kind) ?? false) || Boolean(row.expiryDate),
          expiry: row.expiryDate,
          fileCount,
          today,
        });
    entries.push({
      itemId: null,
      slotKey: null,
      registerId: row.id,
      id: row.id,
      siteId: row.siteId,
      siteName: siteNameById.get(row.siteId) ?? "Unknown site",
      siteType: null,
      siteAddress: null,
      kind: row.kind,
      state,
      expiry: row.expiryDate,
      fileCount,
      notRequired: row.notRequired || state === "Not required",
      lastAlertStage: row.lastAlertStage,
      /* No board row, so no group. The site's own lifecycle is all there is. */
      boardGroup: null,
      siteClosed: siteClosedById.get(row.siteId) ?? false,
    });
    remember(row.siteId, {
      kind: row.kind,
      state,
      expiry: row.expiryDate,
      fileCount,
    });
  }

  // Store, then requirement. The register is read down a page, and the board's
  // placement order is the order somebody dragged rows into on monday.
  entries.sort(
    (left, right) =>
      left.siteName.localeCompare(right.siteName, "en-GB") ||
      left.kind.localeCompare(right.kind, "en-GB"),
  );

  return { entries, bySite };
}

/* ── One site's documents ────────────────────────────────────────────────── */

/**
 * One compliance requirement for one site, in the shape `/api/sites` has always
 * served, ENRICHED with the derived state.
 *
 * WHY THE OLD SHAPE IS KEPT RATHER THAN REPLACED. `GET /api/sites?id=` used to
 * return raw `compliance_documents` rows, and `site-detail.tsx` reads four
 * fields off them: `id` (the React key), `kind`, `expiryDate` and `notRequired`.
 * The register's own per-site type, `ComplianceItem`, has none of those three
 * last ones — it is `{kind, state, expiry, fileCount}` — so handing that over
 * instead would have given every row `key={undefined}` and
 * `formatDate(undefined)`, and the Compliance tab would have rendered a table of
 * "No expiry recorded" while looking like it was working. The compatible fields
 * stay, the derived ones arrive beside them, and the screen can move across one
 * field at a time.
 *
 * `status` is the DERIVED word, not the stored one. Nothing outside this module
 * should ever read `compliance_documents.status` again.
 */
export type SiteComplianceRecord = {
  /* ── The `ComplianceRecord` contract site-detail.tsx already reads ─────── */
  id: string;
  siteId: string;
  kind: string;
  /** The derived five-word state. Named `status` for payload compatibility. */
  status: ComplianceState;
  expiryDate: string | null;
  attachmentId: string | null;
  notRequired: boolean;
  /* ── Enrichment ───────────────────────────────────────────────────────── */
  /** The same value as `status`, under the name the rest of the platform uses. */
  state: ComplianceState;
  /** Real attachment count — board file columns included, not a 0/1 pointer. */
  fileCount: number;
  /** The board row this came from, or null for a register-only requirement. */
  itemId: string | null;
  slotKey: string | null;
  /** Whether a date is expected for this requirement at all. */
  tracksExpiry: boolean;
};

/**
 * Every compliance requirement for ONE site, derived.
 *
 * Built on `readComplianceRegister` on purpose: a second query path is a second
 * definition, and the whole point of that module is that there is one. The
 * register is already on the Dashboard's critical path, so this is not a new
 * class of cost; if it ever needs narrowing, the place to narrow it is inside
 * `readComplianceRegister`, where every caller benefits.
 *
 * Returns [] for a site with nothing recorded, which is a real answer and not an
 * error. Note that a BOARD row with no matching site is deliberately absent
 * here: a document belongs to a site only through a verified name link (see
 * `siteIdByBoardName`), and inventing one would attach one store's fire alarm
 * certificate to another store's page.
 */
export async function readSiteComplianceRecords(
  db: Database,
  orgId: string,
  siteId: string,
  options: { today?: Date } = {},
): Promise<SiteComplianceRecord[]> {
  const { entries } = await readComplianceRegister(db, orgId, options);
  return entries
    .filter((entry) => entry.siteId === siteId)
    .map((entry) => ({
      id: entry.id,
      siteId: entry.siteId,
      kind: entry.kind,
      status: entry.state,
      expiryDate: entry.expiry,
      /*
       * Null for a board slot: its files hang off the board's file COLUMN, not
       * off a single `attachment_id` pointer, and `fileCount` beside this is the
       * truthful answer to "is it held". The pointer only ever meant anything
       * for a register-only row, and even there it is write-dead — every
       * assignment of `compliance_documents.attachment_id` in the codebase is a
       * literal null.
       */
      attachmentId: null,
      notRequired: entry.notRequired,
      state: entry.state,
      fileCount: entry.fileCount,
      itemId: entry.itemId,
      slotKey: entry.slotKey,
      /*
       * The same rule that CLASSIFIED the row, so the field cannot contradict
       * the state beside it: one of the twelve dated board requirements, or any
       * requirement that actually has a date recorded against it.
       */
      tracksExpiry:
        (tracksExpiryByKind.get(entry.kind) ?? false) || Boolean(entry.expiry),
    }));
}
