/**
 * WORKSTREAM 5/6 — the shared configurable register engine.
 *
 * ONE implementation serving BOTH Sites and Contractors, discriminated by
 * `registerKey`. Not two. The owner asked for the same thing on both screens —
 * reorder, rename, show/hide, resize, and add columns of your own — and two
 * implementations would have meant two sets of bugs and a third register
 * costing a third implementation. A third register here is an entry in
 * `REGISTER_KEYS` and a catalogue in `register-catalogue.ts`; no migration, no
 * new table, no new route.
 *
 * WHAT LIVES WHERE, because this is the part that is easy to get wrong:
 *
 *   register_columns  — presentation only. Label, order, width, hidden.
 *                       One row per column per organisation per register.
 *   register_values   — values of CUSTOM columns only.
 *   sites/contractors — values of NATIVE columns. Always. Only.
 *
 * The last line is the invariant. `PATCH /api/registers/values` refuses a
 * native key rather than writing a second copy, because a register that holds
 * its own idea of a site's postcode will disagree with the site the first time
 * somebody edits one through the ordinary form, and neither answer will be
 * marked as the wrong one.
 *
 * WHY THE FLAGS ARE TIMESTAMPS. `hidden_at` and `deleted_at` are nullable
 * timestamps rather than the `visible` / `deleted` booleans that would read
 * more naturally. `db/sqlite-to-postgres.ts` rewrites `WHERE visible = 1` to
 * `WHERE visible = true` on the strength of the column NAME alone — `visible`
 * is already in `BOOLEAN_COLUMN_NAMES` from `maintenance_board_columns` — so an
 * INTEGER column of that name on a new table would be silently mis-rewritten on
 * deployed Postgres while passing locally on SQLite. A timestamp also answers
 * "when", which a boolean never could. The wire shape below exposes plain
 * `hidden` / `native` booleans; those are JSON, no SQL ever sees them.
 */

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { contractors, registerColumns, registerValues, sites } from "../../db/schema";
import { chunkRows } from "./sql-batching";
import {
  defaultWidthFor,
  nativeCatalogue,
  type RegisterColumnType,
  type RegisterKey,
} from "./register-catalogue";
import { type ScopedDatabase } from "./tenant-db";

type RegisterDb = ScopedDatabase["db"];
type ColumnRow = typeof registerColumns.$inferSelect;

/**
 * A register column as the wire sees it.
 *
 * `native` and `hidden` are DERIVED booleans, not stored ones — see the header
 * for why the table cannot carry a column called `visible`. `nativeField` is
 * carried alongside `native` rather than left to be inferred, because the
 * client needs the field NAME to read and write the value and would otherwise
 * need its own copy of the catalogue.
 */
export type RegisterColumn = {
  id: string;
  register: RegisterKey;
  key: string;
  title: string;
  type: RegisterColumnType;
  position: number;
  width: number;
  native: boolean;
  nativeField: string | null;
  hidden: boolean;
  settings: Record<string, unknown>;
};

/**
 * How wide a register column may be dragged.
 *
 * 60 so a checkbox column can shrink to something a tick fits in, 640 so an
 * address or a notes column can be opened wide enough to read a sentence
 * without a tooltip. The board's own writer clamps 90..600
 * (`app/api/board/route.ts`, `update_column`); the register is deliberately
 * wider at both ends because it holds long free text the job board does not,
 * and narrower columns than the board's because a register of 40 columns is
 * mostly short fields. Stated here rather than left as two magic numbers so
 * the divergence reads as a decision.
 */
export const MIN_REGISTER_COLUMN_WIDTH = 60;
export const MAX_REGISTER_COLUMN_WIDTH = 640;

/** Clamped, not refused — a drag that overshoots should stop, not fail. */
export function clampRegisterWidth(value: unknown): number | null {
  const width = Math.round(Number(value));
  if (!Number.isFinite(width)) return null;
  return Math.min(MAX_REGISTER_COLUMN_WIDTH, Math.max(MIN_REGISTER_COLUMN_WIDTH, width));
}

/**
 * A stable key for a column somebody typed a name for.
 *
 * snake_case ASCII, so it is safe in a URL, in a CSV header and as a JSON key.
 * Accents are folded rather than stripped, so "Sécurité" becomes `securite`
 * rather than `s_curit`. Empty means the title had no letters or digits in it
 * at all, which the caller must refuse — a column nothing can address is not a
 * column.
 *
 * Native keys are camelCase (they ARE the field name), so a custom column can
 * only collide with a native one when its title is a single lowercase word
 * matching a field exactly — "Name" -> `name`. That collision is real and is
 * refused with a 409 rather than prevented by a prefix: `custom_name` in a CSV
 * header would be a permanent apology for a five-second rename.
 */
export function columnKeyFrom(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

export function toRegisterColumn(row: ColumnRow): RegisterColumn {
  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.settings || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  } catch {
    // A column whose settings will not parse still has a label, a width and a
    // place in the order. Losing the whole column over its own metadata would
    // be the worse failure.
  }
  return {
    id: row.id,
    register: row.registerKey as RegisterKey,
    key: row.columnKey,
    title: row.title,
    type: row.type as RegisterColumnType,
    position: row.position,
    width: row.width,
    native: row.nativeField !== null,
    nativeField: row.nativeField,
    hidden: row.hiddenAt !== null,
    settings,
  };
}

/**
 * Position, then key.
 *
 * Sorted in JS rather than left to `ORDER BY` alone because the tiebreaker is
 * text: SQLite compares with BINARY and Postgres with the database collation,
 * and two columns that somehow shared a position would come back in different
 * orders on the two dialects. Positions are dense and unique after every write
 * here, so the tiebreaker should never fire — which is exactly why it must not
 * be the thing that differs when it does.
 */
function byPosition(left: RegisterColumn, right: RegisterColumn): number {
  if (left.position !== right.position) return left.position - right.position;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

/** How many bound parameters one seeded row costs. See `chunkRows`. */
const SEED_COLUMNS_PER_ROW = 13;

/**
 * Put the native catalogue in front of an organisation that has never opened
 * this register.
 *
 * IDEMPOTENT BY CONSTRUCTION, because it runs on a READ path that is hit on
 * every page load and by every one of them at once. `onConflictDoNothing`
 * against the unique `(organisation, register, column_key)` index is what makes
 * two simultaneous first-loads produce one catalogue rather than a duplicate
 * key error — a check-then-insert would lose that race, and losing it would
 * turn the first open of the Sites screen into a 503.
 *
 * Chunked because a bulk insert binds one parameter per column PER ROW: 40
 * sites columns at 13 columns each is 520 parameters against a limit of about
 * 100, and D1 answers `too many SQL variables` rather than inserting some of
 * them. `chunkRows` divides the budget by the row width.
 */
async function seedNativeColumns(db: RegisterDb, orgId: string, register: RegisterKey) {
  const now = new Date().toISOString();
  const rows = nativeCatalogue(register).map((seed, index) => ({
    id: `rcol_${crypto.randomUUID().replace(/-/g, "")}`,
    organisationId: orgId,
    registerKey: register,
    // The key IS the field for a native column. They can never diverge —
    // renaming writes `title` and nothing else — so a second identifier would
    // be a second thing to keep in step for no gain.
    columnKey: seed.field,
    title: seed.title,
    type: seed.type,
    position: index,
    width: seed.width ?? defaultWidthFor(seed.type),
    nativeField: seed.field,
    settings: "{}",
    hiddenAt: seed.hidden ? now : null,
    createdAt: now,
    updatedAt: now,
  }));
  for (const chunk of chunkRows(rows, SEED_COLUMNS_PER_ROW)) {
    await db.insert(registerColumns).values(chunk).onConflictDoNothing();
  }
}

/**
 * Every live column of one register, in order, seeding the catalogue on the
 * first read.
 *
 * Deleted rows are read and then dropped rather than filtered in SQL, because
 * their PRESENCE is what says this register has been seeded before. An
 * organisation that soft-deleted its only custom column must not have the whole
 * native catalogue inserted again underneath it — and since a native column can
 * never be deleted, "no rows at all" is the only honest reading of "never
 * seeded".
 */
export async function loadRegisterColumns(
  db: RegisterDb,
  orgId: string,
  register: RegisterKey,
): Promise<RegisterColumn[]> {
  const read = () =>
    db
      .select()
      .from(registerColumns)
      .where(
        and(
          eq(registerColumns.organisationId, orgId),
          eq(registerColumns.registerKey, register),
        ),
      )
      .orderBy(asc(registerColumns.position));

  let rows = await read();
  if (rows.length === 0) {
    await seedNativeColumns(db, orgId, register);
    rows = await read();
  }
  return rows
    .filter((row) => row.deletedAt === null)
    .map(toRegisterColumn)
    .sort(byPosition);
}

/**
 * One column of this organisation's, by id, or null.
 *
 * The organisation filter is part of the WHERE rather than a check on the row
 * afterwards, so a foreign id is indistinguishable from a nonexistent one and
 * the caller can only answer 404. Telling those two apart would tell a caller
 * which ids exist inside a tenant they may not read — the same reasoning as
 * `contractorTarget` in `app/api/workspace/route.ts`.
 */
export async function findRegisterColumn(
  db: RegisterDb,
  orgId: string,
  id: string,
): Promise<ColumnRow | null> {
  if (!id) return null;
  const [row] = await db
    .select()
    .from(registerColumns)
    .where(
      and(
        eq(registerColumns.id, id),
        eq(registerColumns.organisationId, orgId),
        isNull(registerColumns.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The same lookup by key, for callers that hold a key rather than an id. */
export async function findRegisterColumnByKey(
  db: RegisterDb,
  orgId: string,
  register: RegisterKey,
  key: string,
): Promise<ColumnRow | null> {
  if (!key) return null;
  const [row] = await db
    .select()
    .from(registerColumns)
    .where(
      and(
        eq(registerColumns.organisationId, orgId),
        eq(registerColumns.registerKey, register),
        eq(registerColumns.columnKey, key),
        isNull(registerColumns.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The position a new column takes: after everything, so it lands on the right. */
export async function nextColumnPosition(
  db: RegisterDb,
  orgId: string,
  register: RegisterKey,
): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`COALESCE(MAX(${registerColumns.position}), -1)` })
    .from(registerColumns)
    .where(
      and(
        eq(registerColumns.organisationId, orgId),
        eq(registerColumns.registerKey, register),
      ),
    );
  return Number(row?.value ?? -1) + 1;
}

/**
 * Rewrite the order of a register's columns, densely.
 *
 * TAKES A LIST, NOT PAIRS. A client that sends `["postcode", "city"]` cannot
 * send two columns the same position; a client that sends `[{ id, position }]`
 * can, and then the server has to validate what the shape should have made
 * unrepresentable. Positions come out 0..n-1 with no gaps and no duplicates,
 * every time, whatever arrived.
 *
 * AN ENTRY MAY BE AN ID OR A KEY. The grid holds keys — that is what a cell is
 * addressed by — and the column settings panel holds rows, which have ids.
 * Accepting either keeps a lookup table out of the client. They cannot be
 * confused: an id is `rcol_` followed by 32 hex characters.
 *
 * ANYTHING THE LIST DID NOT MENTION keeps its relative order at the tail rather
 * than collapsing to zero. A browser's list can be a moment stale — a colleague
 * added a column while this one was being dragged — and a reorder that drops
 * the unmentioned column to the front would be a worse answer than one that
 * leaves it where it was. Unknown entries are ignored for the same reason,
 * rather than failing the whole request.
 */
export async function reorderRegisterColumns(
  db: RegisterDb,
  orgId: string,
  register: RegisterKey,
  requested: readonly string[],
): Promise<RegisterColumn[]> {
  const live = await loadRegisterColumns(db, orgId, register);
  const byId = new Map(live.map((column) => [column.id, column]));
  const byKey = new Map(live.map((column) => [column.key, column]));

  const named: RegisterColumn[] = [];
  const seen = new Set<string>();
  for (const entry of requested) {
    if (typeof entry !== "string") continue;
    const column = byId.get(entry.trim()) ?? byKey.get(entry.trim());
    if (!column || seen.has(column.id)) continue;
    seen.add(column.id);
    named.push(column);
  }
  const trailing = live.filter((column) => !seen.has(column.id)).sort(byPosition);
  const ordered = [...named, ...trailing];

  const now = new Date().toISOString();
  for (const [index, column] of ordered.entries()) {
    // Only rows that actually move. A reorder that touches one column should
    // not stamp `updated_at` on forty.
    if (column.position === index) continue;
    await db
      .update(registerColumns)
      .set({ position: index, updatedAt: now })
      .where(
        and(
          eq(registerColumns.id, column.id),
          eq(registerColumns.organisationId, orgId),
        ),
      );
  }
  return ordered.map((column, index) => ({ ...column, position: index }));
}

/**
 * Does this entity exist, in THIS organisation?
 *
 * Asked before any value is written, and answered from the entity's own table
 * rather than from anything the request said. `register_values.entity_id` has
 * no foreign key — it points at two different tables depending on
 * `register_key`, which is not a relationship SQL can express — so this check
 * is the only thing standing between a typo and a row of orphaned values, and
 * the only thing standing between a foreign id and a cell written against
 * another tenant's site.
 */
export async function registerEntityExists(
  db: RegisterDb,
  orgId: string,
  register: RegisterKey,
  entityId: string,
): Promise<boolean> {
  if (!entityId) return false;
  if (register === "sites") {
    const [row] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, entityId), eq(sites.organisationId, orgId)))
      .limit(1);
    return Boolean(row);
  }
  const [row] = await db
    .select({ id: contractors.id })
    .from(contractors)
    .where(and(eq(contractors.id, entityId), eq(contractors.organisationId, orgId)))
    .limit(1);
  return Boolean(row);
}

/**
 * Every custom value one register holds for a set of entities.
 *
 * Returned as `{ [entityId]: { [columnKey]: value } }` — the shape a grid
 * indexes into, so the client does no grouping of its own. Native columns are
 * absent from this by construction: there is nothing to be absent, because
 * nothing ever wrote them here.
 *
 * Deliberately reads the WHOLE register rather than taking an entity list. The
 * alternative binds one parameter per entity, which is the `too many SQL
 * variables` failure `chunkIds` exists for, and these registers are tens of
 * rows: 31 sites and a similar number of contractors against a table that only
 * ever holds cells somebody typed. When a register grows past the point where
 * that is true, this grows a page argument — not an `IN` list.
 */
export async function loadRegisterValues(
  db: RegisterDb,
  orgId: string,
  register: RegisterKey,
): Promise<Record<string, Record<string, string | null>>> {
  const rows = await db
    .select({
      entityId: registerValues.entityId,
      columnKey: registerValues.columnKey,
      value: registerValues.value,
    })
    .from(registerValues)
    .where(
      and(
        eq(registerValues.organisationId, orgId),
        eq(registerValues.registerKey, register),
      ),
    );
  const grouped: Record<string, Record<string, string | null>> = {};
  for (const row of rows) {
    (grouped[row.entityId] ??= {})[row.columnKey] = row.value;
  }
  return grouped;
}
