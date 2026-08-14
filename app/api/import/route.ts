import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import {
  maintenanceBoardCells,
  maintenanceBoardColumns,
  maintenanceGroupItems,
  maintenanceGroups,
  maintenanceRequests,
  siteAliases,
} from "../../../db/schema";
import { auditActor, recordAudit } from "../../lib/audit";
import { listSites, normaliseSiteName } from "../../lib/sites-repository";
import { scopedDb, scopedDbWithCapability } from "../../lib/tenant-db";
import { resolveBoard } from "../../lib/board-registry";
import {
  EXTERNAL_ID_KEY,
  planImport,
  type ImportBoardKey,
  type ImportPlan,
} from "../../lib/monday-import";
import { parseDelimited, readXlsx } from "../../lib/xlsx-reader";

export const dynamic = "force-dynamic";

/**
 * Monday board import — the migration path off monday.com.
 *
 * Two modes on one endpoint so a preview cannot describe a different outcome
 * from the commit that follows it: both call `planImport` on the same bytes.
 *
 *   mode=preview   parse and report. Writes nothing.
 *   mode=commit    parse and write.
 *
 * Commit is idempotent per file: an item is keyed on the source system's own row
 * id, so re-running an import updates the rows it already created instead of
 * doubling the board. That matters because a 744-row import is exactly the kind
 * of thing someone runs twice after fixing one column.
 *
 * It used to be keyed on the monday item's NAME, which held only because the
 * first board imported — Store Documentation — happens to have unique store
 * names. The Maintenance board names every form submission "Incoming form
 * answer", so 732 of its 744 rows share 20 names; a name-keyed import folded 713
 * distinct jobs onto the rows already present and reported it as "updated".
 * `identityRisk` below now reports that danger in the preview, before anything
 * is written.
 *
 * The whole file is read into memory. A monday board export is a few megabytes
 * at 744 rows, and the alternative — streaming into D1 row by row — cannot
 * produce the preview the screen needs before anything is written.
 */

const MAX_BYTES = 25 * 1024 * 1024;
const BOARD_KEYS: ImportBoardKey[] = ["maintenance", "store-documentation"];

function bad(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** Reads the upload into rows, choosing a parser by extension then by content. */
async function readRows(file: File): Promise<string[][]> {
  const name = file.name.toLowerCase();
  const bytes = new Uint8Array(await file.arrayBuffer());

  // A ZIP starts "PK\x03\x04". Trusting the extension alone means a file named
  // .csv that is really a workbook fails with an unreadable parse instead of a
  // clear message.
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;

  if (isZip || name.endsWith(".xlsx") || name.endsWith(".xlsm")) {
    const sheet = await readXlsx(bytes);
    return sheet.rows;
  }

  const text = new TextDecoder().decode(bytes);
  // Monday's CSV is comma-delimited; its "export to file" tab-separates. Pick
  // whichever appears more often on the busiest line.
  const sample = text.split("\n").slice(0, 40).join("\n");
  const commas = (sample.match(/,/g) ?? []).length;
  const tabs = (sample.match(/\t/g) ?? []).length;
  return parseDelimited(text, tabs > commas ? "\t" : ",");
}

/**
 * How many rows in the file share a name, and whether the file can tell them
 * apart.
 *
 * Surfaced in the preview because it is the difference between an import that
 * lands 744 jobs and one that lands 41. Without an Item ID column, rows sharing
 * a name are matched to each other by title and collapse into one — which is
 * what happened to a 744-row Maintenance import, silently, reported as
 * "updated". The operator now sees the risk on the preview screen, before
 * anything is written, which is the whole point of having a preview.
 */
function identityRisk(plan: ImportPlan) {
  const seen = new Map<string, number>();
  for (const item of plan.items) {
    const name = (item.values.name ?? "").trim().toLowerCase();
    if (name) seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  const shared = [...seen.entries()].filter(([, count]) => count > 1);
  const rowsAffected = shared.reduce((total, [, count]) => total + count, 0);
  const carriesIds = plan.items.some((item) => item.values[EXTERNAL_ID_KEY]);

  return {
    carriesItemIds: carriesIds,
    duplicateTitles: shared.length,
    rowsSharingATitle: rowsAffected,
    // The only combination that silently loses rows.
    wouldCollapse: !carriesIds && rowsAffected > 0 ? rowsAffected - shared.length : 0,
  };
}

/**
 * The statuses monday flags as done on this board.
 *
 * monday has no lifecycle column — a job is finished because its status says
 * so, and because it has been filed into one of the 28 per-store archive
 * groups. Those groups carry no `stage_key`, so without this every one of the
 * 672 completed jobs imported as "Incoming" and the board read 744 open.
 *
 * Taken from the capture's `is_done` flag rather than guessed from the wording:
 * "Completion Invoice Paid" sounds final and is not flagged, while
 * "Job Completed" is.
 */
const DONE_STATUSES = new Set(["Job Completed"]);

/**
 * The end of a monday timeline, which is what a due date means on this board.
 *
 * Exports write a timeline as "start - end". A single date is treated as both,
 * which is how monday renders a one-day timeline.
 */
function timelineEnd(value: string | undefined) {
  const text = (value ?? "").trim();
  if (!text) return null;
  const parts = text.split(/\s+-\s+|\s+–\s+/).map((part) => part.trim());
  const end = parts[parts.length - 1];
  return /^\d{4}-\d{2}-\d{2}/.test(end) ? end : null;
}

function summarise(plan: ImportPlan) {
  return {
    board: plan.board,
    groups: plan.groups,
    itemCount: plan.items.length,
    groupCount: plan.groups.length,
    unmatchedColumns: plan.unmatchedColumns,
    missingColumns: plan.missingColumns,
    identity: identityRisk(plan),
    skipped: plan.skipped.slice(0, 50),
    skippedCount: plan.skipped.length,
    sample: plan.items.slice(0, 8).map((item) => ({
      group: item.group,
      values: item.values,
    })),
  };
}

/**
 * Writes the plan. Returns counts rather than the rows, because 744 rows back
 * through the response is no use to the screen that asked.
 */
async function commit(
  db: Awaited<ReturnType<typeof scopedDb>>["db"],
  orgId: string,
  boardKey: string,
  plan: ImportPlan,
) {
  // Groups first — an item cannot be placed before its group exists.
  const existingGroups = await db
    .select()
    .from(maintenanceGroups)
    .where(
      and(
        eq(maintenanceGroups.organisationId, orgId),
        eq(maintenanceGroups.boardId, boardKey),
        /*
         * Stage 23 — a group in the recycle bin is not a match for an import.
         * Matching one would file freshly imported rows into a group that is
         * off the board, and they would arrive invisible.
         */
        isNull(maintenanceGroups.deletedAt),
      ),
    )
    .orderBy(asc(maintenanceGroups.position));

  // Keyed on the trimmed, lowercased name: monday's own group titles carry
  // stray double spaces ("Westfield Stratford  completed"), and an import that
  // matched exactly would create a second group beside the seeded one.
  const groupIdByName = new Map(
    existingGroups.map((group) => [group.name.trim().toLowerCase(), group.id]),
  );
  /** The group row itself, for the `stage_key` that gives an item its lifecycle. */
  const groupById = new Map(existingGroups.map((group) => [group.id, group]));
  let nextPosition =
    existingGroups.reduce((highest, group) => Math.max(highest, group.position), -1) + 1;

  let groupsCreated = 0;
  for (const name of plan.groups) {
    const key = name.trim().toLowerCase();
    if (!key || groupIdByName.has(key)) continue;

    const id = newId("grp");
    await db.insert(maintenanceGroups).values({
      id,
      organisationId: orgId,
      boardId: boardKey,
      name,
      color: "#579bfc",
      position: nextPosition,
    });
    groupIdByName.set(key, id);
    nextPosition += 1;
    groupsCreated += 1;
  }

  const columns = await db
    .select()
    .from(maintenanceBoardColumns)
    .where(
      and(
        eq(maintenanceBoardColumns.organisationId, orgId),
        eq(maintenanceBoardColumns.boardId, boardKey),
      ),
    );
  const columnByKey = new Map(columns.map((column) => [column.key, column]));

  /*
   * Which site each imported job belongs to.
   *
   * This used to take the first row of `sites` with no ORDER BY and stamp it on
   * all 744 jobs, throwing away the store name the file actually carries. Every
   * site-level figure downstream — spend by site, sites needing attention, the
   * portfolio filter — was then computed against one arbitrary store, and the
   * `?? request.location` fallback elsewhere never fired because the id was
   * valid, just wrong.
   *
   * The sites are listed once and indexed on every name they are known by, so
   * matching 744 rows costs one query rather than 744. `site_id` is NOT NULL,
   * so an unmatched row still needs somewhere to go; it lands on `anySite` and
   * is reported, rather than being silently attributed.
   */
  const siteRows = await listSites(db, orgId, { includeInactive: true });
  const siteIdByName = new Map<string, string>();
  for (const row of siteRows) {
    for (const name of [
      row.name,
      row.mondayMaintenanceName,
      row.mondayComplianceName,
    ]) {
      const key = name ? normaliseSiteName(name) : "";
      if (key && !siteIdByName.has(key)) siteIdByName.set(key, row.id);
    }
    if (row.code) siteIdByName.set(row.code.trim().toLowerCase(), row.id);
  }
  const siteAliasRows = await db
    .select({ siteId: siteAliases.siteId, normalised: siteAliases.normalised })
    .from(siteAliases)
    .where(eq(siteAliases.organisationId, orgId));
  for (const alias of siteAliasRows) {
    if (alias.normalised && !siteIdByName.has(alias.normalised)) {
      siteIdByName.set(alias.normalised, alias.siteId);
    }
  }
  const anySite = siteRows[0] ?? null;
  let unmatchedSites = 0;

  /*
   * How a row in the file is matched to a row already here.
   *
   * By the source system's own id first. Titles are not unique on a real board:
   * the Maintenance board names every form submission "Incoming form answer",
   * so a title-keyed import of its 744 items folded 713 of them onto whichever
   * rows were already present and called it "updated". Store Documentation
   * never showed the fault because store names happen to be unique — which is
   * exactly why an identity has to be explicit rather than assumed.
   *
   * Title remains the fallback for an export that carries no Item ID column,
   * so an older export still updates rather than duplicating. Its weakness is
   * documented in the preview: `duplicateTitles` below tells the operator how
   * many rows share a name BEFORE they commit, rather than after.
   */
  /*
   * Stage 23 — DELIBERATELY UNFILTERED. Do not add `isNull(deletedAt)`.
   *
   * This is the identity map that decides insert-versus-update. A job sitting
   * in the recycle bin still owns its `external_id`, so hiding it here would
   * make the importer create a SECOND row for every binned job on the next
   * monday sync — duplicates that would then both be on the board once the
   * original was restored.
   *
   * Leaving binned rows visible means a re-import updates one in place. It
   * stays in the bin, which is the behaviour someone who deleted it would
   * expect: an import is not a decision to undelete.
   */
  const existingItems = await db
    .select({
      id: maintenanceRequests.id,
      title: maintenanceRequests.title,
      externalId: maintenanceRequests.externalId,
    })
    .from(maintenanceRequests)
    .where(eq(maintenanceRequests.organisationId, orgId));
  const itemByTitle = new Map(
    existingItems.map((item) => [item.title.trim().toLowerCase(), item.id]),
  );
  const itemByExternalId = new Map(
    existingItems
      .filter((item) => item.externalId)
      .map((item) => [item.externalId as string, item.id]),
  );

  let created = 0;
  let updated = 0;
  let cellsWritten = 0;
  /** Next free slot per group, so rows keep the order the file lists them in. */
  const positionInGroup = new Map<string, number>();

  for (const item of plan.items) {
    const name = (item.values.name ?? "").trim();
    if (!name) continue;

    const groupId = groupIdByName.get(item.group.trim().toLowerCase());
    const externalId = (item.values[EXTERNAL_ID_KEY] ?? "").trim();
    // An export carrying ids matches ONLY on them. Falling through to the title
    // when an id is present but unseen would merge a genuinely new job into an
    // unrelated row that happens to share monday's default name.
    const existingId = externalId
      ? itemByExternalId.get(externalId)
      : itemByTitle.get(name.toLowerCase());
    let requestId = existingId;

    /*
     * The fields the row carries in its own right, rather than as cells.
     *
     * Dates especially. These were left to their defaults, so every imported
     * job was stamped "requested today" and none carried a completion or a due
     * date. Everything downstream that reads a date then read a fiction: the
     * period selector had 744 rows all inside every window, the ageing and
     * spend trends collapsed onto a single day, and Avg SLA target had nothing
     * to average.
     *
     * `stage` is the board's lifecycle, which monday does not have a column
     * for — it is implied by which group a row sits in. The seeded groups carry
     * `stage_key` for exactly this, and a row in one of the 28 archive groups
     * is completed by virtue of monday's own done-flagged status, so both are
     * consulted before falling back to Incoming.
     */
    const group = groupId ? groupById.get(groupId) : undefined;
    const completedAt = item.values.completed || null;
    const stage =
      group?.stageKey ??
      (completedAt || DONE_STATUSES.has((item.values.status ?? "").trim())
        ? "Completed"
        : "Incoming");
    const fields = {
      title: name,
      description: item.values.description ?? "",
      location: item.values.location ?? item.values.storeLocation ?? "",
      requester: item.values.requester ?? "",
      contact: item.values.number ?? "",
      category: item.values.label ?? "",
      engineer: item.values.engineer ?? "",
      priority: item.values.priority || "Medium",
      status: item.values.status || "Pending Approval",
      stage,
      completedAt,
      dueAt: timelineEnd(item.values.timeline) ?? null,
      cost: item.values.cost ? Number(item.values.cost) : null,
      approvedBy: item.values.approvedBy || null,
      invoice: item.values.invoice || null,
      contractor: item.values.contractor || null,
      assignee: item.values.assignee || null,
      nextUpdateAt: item.values.nextUpdate || null,
    };

    // The store the row names, not whichever site happened to sort first.
    const locationName = fields.location.trim();
    const matchedSiteId = locationName
      ? siteIdByName.get(normaliseSiteName(locationName))
      : undefined;
    if (locationName && !matchedSiteId) unmatchedSites += 1;
    const siteId = matchedSiteId ?? anySite?.id ?? "";

    if (!requestId) {
      requestId = newId("req");
      await db.insert(maintenanceRequests).values({
        id: requestId,
        organisationId: orgId,
        siteId,
        source: "monday import",
        externalId: externalId || null,
        ...fields,
        // Only set on insert: `requested_at` defaults to now, and a re-import
        // must not restamp a row the board has been working from.
        requestedAt: item.values.requested || new Date().toISOString(),
      });
      itemByTitle.set(name.toLowerCase(), requestId);
      if (externalId) itemByExternalId.set(externalId, requestId);
      created += 1;
    } else {
      /*
       * A re-import refreshes the row from the source.
       *
       * This board is a mirror of monday, so the export is authoritative and
       * "update" has to mean it — writing only the cells left the row's own
       * status, stage and dates frozen at whatever the first import guessed.
       * A row matched by title that has never carried an identity also gets
       * one, so the next run matches on the id instead.
       */
      await db
        .update(maintenanceRequests)
        .set({
          ...fields,
          // Re-attributed too, so a board imported before names were resolved is
          // corrected by a re-run instead of keeping the arbitrary site forever.
          ...(matchedSiteId ? { siteId: matchedSiteId } : {}),
          ...(externalId && !itemByExternalId.has(externalId) ? { externalId } : {}),
          // A row whose source never recorded a raised date keeps the one it
          // has rather than being pushed to today on every re-run.
          ...(item.values.requested ? { requestedAt: item.values.requested } : {}),
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(maintenanceRequests.id, requestId));
      if (externalId) itemByExternalId.set(externalId, requestId);
      updated += 1;
    }

    if (groupId) {
      /*
       * Row order inside the group, taken from the file.
       *
       * Every placement used to be written at position 0, so the board fell
       * back to insertion order and a group read in whatever sequence the
       * import happened to write it. The export lists rows in the order the
       * source board shows them, so counting within the group reproduces that
       * order — which is the difference between a mirror of monday and a bag of
       * the same rows.
       *
       * `request_id` is the primary key — an item sits in exactly one group —
       * so a re-run moves the item rather than adding a second placement, and
       * re-running restores the source order for anything since dragged.
       */
      const position = positionInGroup.get(groupId) ?? 0;
      positionInGroup.set(groupId, position + 1);

      await db
        .insert(maintenanceGroupItems)
        .values({
          organisationId: orgId,
          boardId: boardKey,
          groupId,
          requestId,
          position,
        })
        .onConflictDoUpdate({
          target: maintenanceGroupItems.requestId,
          set: { groupId, position, updatedAt: sql`CURRENT_TIMESTAMP` },
        });
    }

    // Cells carry everything the request row does not have a field for.
    for (const [key, value] of Object.entries(item.values)) {
      const column = columnByKey.get(key);
      if (!column || !value) continue;
      await db
        .insert(maintenanceBoardCells)
        .values({
          id: newId("cell"),
          organisationId: orgId,
          boardId: boardKey,
          requestId,
          columnId: column.id,
          value,
        })
        .onConflictDoUpdate({
          target: [
            maintenanceBoardCells.organisationId,
            maintenanceBoardCells.boardId,
            maintenanceBoardCells.requestId,
            maintenanceBoardCells.columnId,
          ],
          set: { value, updatedAt: sql`CURRENT_TIMESTAMP` },
        });
      cellsWritten += 1;
    }
  }

  return { groupsCreated, created, updated, cellsWritten, unmatchedSites };
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    // Identity is pulled through for the audit trail below.
    const guard = await scopedDbWithCapability(request, "data.import");
    if (guard.denied) return guard.denied;
    const { actor, db, orgId, identityEmail, session } = guard.scope;

    const form = await request.formData().catch(() => null);
    if (!form) return bad("Send the export as multipart form data.");

    const file = form.get("file");
    if (!(file instanceof File)) return bad("Choose a monday export to upload.");
    if (file.size === 0) return bad("That file is empty.");
    if (file.size > MAX_BYTES) {
      return bad("That file is larger than 25 MB. Export one board at a time.");
    }

    const boardKey = String(form.get("board") ?? "maintenance") as ImportBoardKey;
    if (!BOARD_KEYS.includes(boardKey)) {
      return bad(`"${boardKey}" is not a board this can import.`);
    }
    const mode = String(form.get("mode") ?? "preview");
    const acknowledgeCollapse =
      String(form.get("acknowledgeCollapse") ?? "") === "true";
    if (mode !== "preview" && mode !== "commit") {
      return bad('Mode must be "preview" or "commit".');
    }

    let rows: string[][];
    try {
      rows = await readRows(file);
    } catch (error) {
      return bad(error instanceof Error ? error.message : "That file could not be read.");
    }
    if (!rows.length) return bad("That file has no rows.");

    const plan = planImport(rows, boardKey);
    if (!plan.items.length) {
      return bad(
        "No items were found. Check this is a monday board export — the header row must carry the board's column titles.",
      );
    }

    if (mode === "preview") {
      return Response.json({ mode, preview: summarise(plan) });
    }

    /*
     * A commit that would collapse rows is refused, not merely reported.
     *
     * `identityRisk` already works out that a file with no Item ID column and
     * repeated names cannot be matched row-for-row — monday calls every form
     * submission "Incoming form answer", so 744 items can fold onto ~20 and be
     * reported as "744 updated". Until now that number was returned in the
     * preview body and nothing stopped `mode=commit`, which a caller can post
     * without ever having asked for a preview.
     *
     * The operator can still proceed: it is their board, and there are files
     * where collapsing is the intent. But it has to be said out loud.
     */
    const risk = identityRisk(plan);
    if (risk.wouldCollapse > 0 && !acknowledgeCollapse) {
      return Response.json(
        {
          error:
            `${risk.rowsSharingATitle} rows share ${risk.duplicateTitles} names and the file carries no Item ID column, ` +
            `so ${risk.wouldCollapse} of them would be merged into another row rather than imported. ` +
            `Re-export from monday with the Item ID column included, or resend with acknowledgeCollapse to accept the merge.`,
          risk,
        },
        { status: 409 },
      );
    }

    // Commit writes into whichever board the workspace resolves, so an import
    // cannot land on a board the caller is not looking at.
    const board = await resolveBoard(db, orgId, boardKey);
    const result = await commit(db, orgId, board.key, plan);

    /*
     * An import rewrites more rows in one call than any other action in the
     * app — this one landed 744 jobs and 8,555 cells — and it silently updates
     * rows that already existed. Recording the counts and the file's own
     * identity risk is what lets someone later work out whether a board became
     * wrong because of an import, and which one.
     */
    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor({ actor, identityEmail, session }),
      action: "data.imported",
      entityType: "board",
      entityId: board.key,
      summary: `Imported ${result.created} new and ${result.updated} existing item${
        result.created + result.updated === 1 ? "" : "s"
      } into ${board.key}.`,
      detail: {
        board: board.key,
        fileName: file.name,
        fileBytes: file.size,
        ...result,
        groups: plan.groups.length,
        skipped: plan.skipped.length,
        identity: identityRisk(plan),
      },
      request,
    });

    return Response.json({ mode, preview: summarise(plan), result });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The import could not be run." },
      { status: 500 },
    );
  }
}
