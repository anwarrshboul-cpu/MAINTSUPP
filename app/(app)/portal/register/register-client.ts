"use client";

/**
 * WORKSTREAM 5/6 — the browser's half of the configurable register.
 *
 * Every call `/api/registers` accepts, typed, plus the two helpers a grid
 * cannot be written correctly without. Mounting a configurable register on a
 * screen should be importing this and rendering the result; a screen that
 * hand-rolls its own `fetch("/api/registers")` is a screen that will eventually
 * forget one of the rules below.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE, restated where the client can see it:
 * a NATIVE column's value lives on the site or contractor row and a CUSTOM
 * column's value lives in `register_values`. `registerCellValue` is the only
 * function that should ever decide which — it takes both sources and reads the
 * right one — and `writeRegisterCell` refuses a native column in the browser
 * rather than making the round trip to be told no. The server refuses natives
 * too, of course; this is so the mistake is caught where somebody can see it
 * rather than as a 400 in a network tab.
 *
 * There is no React here on purpose. A register is a table, a settings panel
 * and a drag gesture, and each of those wants its own component; what they
 * share is this, so the three cannot drift into three ideas of what a column is.
 */

/** The wire shape `/api/registers` returns. Mirrors `app/lib/register-columns.ts`. */
export type RegisterColumn = {
  id: string;
  register: RegisterKey;
  /** The cell key. For a native column this IS the entity's field name. */
  key: string;
  /** The DISPLAY label. Renaming changes this and nothing else. */
  title: string;
  type: string;
  position: number;
  width: number;
  /** True when the column is a view onto a real field on the entity row. */
  native: boolean;
  nativeField: string | null;
  hidden: boolean;
  /**
   * Carries the pin. DERIVED from `settings.pinned` by the server — there is no
   * `pinned` SQL column and there must not be one.
   *
   * At most one column per register carries it. `/api/registers` refuses a
   * REQUEST for `{pinned: true, hidden: true}` and pinning clears `hidden_at`,
   * but HIDING LEAVES THE PIN ALONE. So "pinned, and currently off the
   * register" is not an exotic state: it is what every register is in while its
   * frozen column is unticked, and the remembered pin is what gives the lane
   * back when the operator ticks it again.
   *
   * IT IS STILL NOT THE ANSWER TO "IS THIS THE FROZEN LANE?". Most registers
   * freeze a column that carries no flag at all — nobody has ever pressed Pin
   * on a live one — and a hidden column can carry a stale pin that no lane may
   * be drawn from. `frozenRegisterColumn` is the question a grid has; this is
   * one of the three things it reads to answer it.
   */
  pinned: boolean;
  settings: Record<string, unknown>;
};

export type RegisterKey = "sites" | "contractors";

/** `{ [entityId]: { [columnKey]: value } }` — custom cells only. */
export type RegisterValues = Record<string, Record<string, string | null>>;

export type RegisterSnapshot = {
  register: RegisterKey;
  columns: RegisterColumn[];
  values: RegisterValues;
  /** `board.edit`. Whether this person may reorder, rename, hide or add. */
  canConfigure: boolean;
  /** `sites.edit`. Whether this person may fill a custom cell in. */
  canEditValues: boolean;
  types: string[];
  widthRange: { min: number; max: number };
};

async function readJson(response: Response) {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: text.slice(0, 200) } as Record<string, unknown>;
  }
}

/**
 * Thrown with the server's own sentence in it.
 *
 * The refusals on this endpoint are written to be read by a person — "Native
 * columns cannot be deleted. Hide it instead." is an instruction, not a status
 * code — so the caller should show `error.message` rather than inventing its
 * own wording and losing the instruction.
 */
export class RegisterError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === "string" ? body.error : "The register could not be changed.");
    this.name = "RegisterError";
    this.status = status;
    this.body = body;
  }
}

async function send(
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = await readJson(response);
  if (!response.ok) throw new RegisterError(response.status, parsed);
  return parsed;
}

/** Everything one register needs to draw: its columns, and its custom cells. */
export async function fetchRegister(register: RegisterKey): Promise<RegisterSnapshot> {
  const body = await send("GET", `/api/registers?register=${register}`);
  return body as unknown as RegisterSnapshot;
}

/** Add a column of your own. The server generates the key from the title. */
export async function addRegisterColumn(
  register: RegisterKey,
  title: string,
  type = "text",
): Promise<RegisterColumn> {
  const body = await send("POST", "/api/registers", { register, title, type });
  return body.column as RegisterColumn;
}

/**
 * Rename a column — native or custom.
 *
 * Allowed on a native column precisely because it changes the LABEL and nothing
 * else: "Store" becomes "Branch" on the register while `sites.name` and every
 * join, import and other screen reading it carry on unchanged.
 */
export async function renameRegisterColumn(id: string, title: string): Promise<RegisterColumn> {
  const body = await send("PATCH", "/api/registers", { id, title });
  return body.column as RegisterColumn;
}

/** Resize. The server clamps to `widthRange`; an overshoot stops, it does not fail. */
export async function resizeRegisterColumn(id: string, width: number): Promise<RegisterColumn> {
  const body = await send("PATCH", "/api/registers", { id, width });
  return body.column as RegisterColumn;
}

/** Show or hide. This is what "remove" means for a native column. */
export async function setRegisterColumnHidden(
  id: string,
  hidden: boolean,
): Promise<RegisterColumn> {
  const body = await send("PATCH", "/api/registers", { id, hidden });
  return body.column as RegisterColumn;
}

/**
 * Freeze this column at the left of the register, or release it.
 *
 * TAKES THE REGISTER as well as the id, and sends both. The id alone would
 * identify the row perfectly well — every other single-column verb here is
 * addressed by id — but "at most one pinned column" is a claim about a
 * REGISTER, and pinning a contractors column while believing it to be a sites
 * one would silently release the other screen's lane. The server answers a
 * mismatch 404, the same as a foreign id, so the guard costs a caller nothing
 * it does not already know.
 *
 * THE TWO THINGS THIS DOES BESIDES SET A FLAG, both on the server, both worth
 * knowing before calling it:
 *
 *   It UNPINS whatever else was pinned on this register.
 *   It SHOWS the column — pinning clears `hidden_at`. The live contractors
 *   register has every native column hidden, so a pin that respected that
 *   would freeze a lane nobody could see.
 *
 * Unpinning does neither: the column stays exactly where it is, still shown.
 * "Stop freezing this" is not "take this off the register".
 */
export async function pinRegisterColumn(
  register: RegisterKey,
  id: string,
  pinned: boolean,
): Promise<RegisterColumn> {
  const body = await send("PATCH", "/api/registers", { register, id, pinned });
  return body.column as RegisterColumn;
}

/**
 * Commit a new order. `order` may hold keys or ids, mixed.
 *
 * Send the whole visible order, not a pair of indices: a list cannot express
 * two columns in the same place, so the invalid state is unrepresentable rather
 * than validated. Anything left out keeps its relative position at the end.
 */
export async function reorderRegisterColumns(
  register: RegisterKey,
  order: string[],
): Promise<RegisterColumn[]> {
  const body = await send("PATCH", "/api/registers", { register, order });
  return body.columns as RegisterColumn[];
}

/**
 * Remove a CUSTOM column. Soft — the cells survive and `restore` brings both
 * back. A native column is refused; hide it instead.
 */
export async function removeRegisterColumn(id: string): Promise<RegisterColumn[]> {
  const body = await send("DELETE", `/api/registers?id=${encodeURIComponent(id)}`);
  return body.columns as RegisterColumn[];
}

/** Undo a removal, cells included. */
export async function restoreRegisterColumn(id: string): Promise<RegisterColumn> {
  const body = await send("PATCH", "/api/registers", { id, restore: true });
  return body.column as RegisterColumn;
}

/**
 * Write one CUSTOM cell. `null` clears it.
 *
 * REFUSES A NATIVE COLUMN HERE, in the browser, rather than making the round
 * trip. A native value belongs to the site or the contractor and is written
 * through that entity's own API — `PATCH /api/sites { [column.nativeField]:
 * value }`, or `PATCH /api/workspace { entity: "contractor", id, data: {
 * [column.nativeField]: value } }` — which is where its validation, its
 * uniqueness rules and its audit line already live. Writing it here would put a
 * second copy in `register_values`, and the two would disagree the moment
 * anybody edited the site through the ordinary form.
 */
export async function writeRegisterCell(
  register: RegisterKey,
  column: RegisterColumn,
  entityId: string,
  value: string | null,
): Promise<string | null> {
  if (column.native) {
    throw new RegisterError(400, {
      error: `"${column.title}" is a built-in field. Save it on the ${
        register === "sites" ? "site" : "contractor"
      } itself.`,
      nativeField: column.nativeField,
    });
  }
  const body = await send("PATCH", "/api/registers/values", {
    register,
    entityId,
    columnKey: column.key,
    value,
  });
  return (body.value as { value: string | null }).value;
}

/**
 * THE ONE READER. What this column holds for this row.
 *
 * Native reads the entity row by its field name; custom reads the values map by
 * its key. Every cell on a register screen should come through here, because
 * the two kinds are drawn side by side and look identical, and a grid that
 * reaches into `values` for all of them silently renders every native column
 * blank — which looks like missing data rather than like a bug.
 */
export function registerCellValue(
  column: RegisterColumn,
  entity: Record<string, unknown> | undefined,
  values: RegisterValues,
  entityId: string,
): string | null {
  if (column.native) {
    const raw = entity?.[column.nativeField ?? column.key];
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "boolean") return raw ? "true" : "false";
    if (Array.isArray(raw)) return JSON.stringify(raw);
    return String(raw);
  }
  return values[entityId]?.[column.key] ?? null;
}

/** The columns a grid draws: everything not hidden, in order. */
export function visibleColumns(columns: readonly RegisterColumn[]): RegisterColumn[] {
  return columns.filter((column) => !column.hidden);
}

/** The columns a "show hidden" panel offers to bring back. */
export function hiddenColumns(columns: readonly RegisterColumn[]): RegisterColumn[] {
  return columns.filter((column) => column.hidden);
}

/**
 * THE COMPOSITE CONTRACTOR COLUMN — one column, one key, one label.
 *
 * The Contractors register draws WHO a contractor is and HOW TO REACH THEM as a
 * single lane: the company name, the archived badge, and the actionable
 * contact / phone / WhatsApp / email block underneath. That lane is a COLUMN of
 * the register — `Contractor` — and not a second thing invented beside one. So
 * there is exactly one checkbox for it in the columns panel, one entry in the
 * order, one title to rename, and unticking it takes the WHOLE lane off the
 * table. There is no second logical column called "Reach them": that name
 * belongs to a SECTION of the contractor summary drawer, which is a different
 * surface and is not a register column at all.
 *
 * WHY THE KEY IS `name` WHEN THE LABEL IS `Contractor`. For a native column the
 * key IS the entity's field: `seedNativeColumns` writes `columnKey: seed.field`,
 * `registerCellValue` reads `entity[column.nativeField]`, and the unique index
 * is on `(organisation, register, column_key)`. Renaming the key to
 * `contractor` would therefore be a DATA MIGRATION on a live register — and a
 * silent one, because `addMissingNativeColumns` inserts every catalogue field
 * the register does not already hold. A catalogue saying `contractor` would put
 * a SECOND identity column beside the `name` row the owner already has, leaving
 * two checkboxes on the panel with their pin, their title and their position
 * stranded on the one nobody draws.
 *
 * The ambiguity is removed from the language instead. `name` is the key,
 * `Contractor` is the label, and nothing in this codebase may introduce a
 * `contractor` COLUMN KEY on a register — `CONTRACTOR_NATIVE_COLUMNS` is the
 * only thing that ever seeds a native key, and a test pins that it holds
 * exactly one identity entry and that its field is this constant.
 */
export const CONTRACTOR_COLUMN_KEY = "name";

/**
 * The label the lane carries when there is no row to ask.
 *
 * Only reachable on a snapshot taken before the catalogue seeded. Every other
 * render reads `column.title`, so a rename to "Supplier" renames the lane.
 */
export const CONTRACTOR_COLUMN_TITLE = "Contractor";

/**
 * The composite Contractor column — shown or hidden — or null.
 *
 * Matched on `nativeField` and never on position: the reader may have moved it
 * anywhere, and the identity belongs to the column wherever it sits. Found
 * whether or not it is on the table, because a column's LABEL is a property of
 * the column and not of its visibility.
 *
 * NULL AND HIDDEN ARE DIFFERENT FACTS and the callers must treat them
 * differently. Null means the register has no ROW for the identity at all,
 * which is only true of a register seeded before the catalogue described it;
 * hidden means somebody unticked it. Reading the second for the first is the
 * defect that made unticking "Contractor" do nothing — see
 * `frozenRegisterColumn`.
 */
export function identityRegisterColumn(
  columns: readonly RegisterColumn[],
): RegisterColumn | null {
  return columns.find((column) => column.nativeField === CONTRACTOR_COLUMN_KEY) ?? null;
}

/**
 * The one column CARRYING the pin, or null.
 *
 * "At most one" is the server's invariant, not a hope — see the pin verb in
 * `app/api/registers/route.ts` — so this returns a column rather than a list,
 * and a grid drawing the frozen lane cannot accidentally render two of them if
 * a stale answer ever carried two. `find` takes the first in stored order,
 * which is the same one every reader would pick.
 *
 * THIS READS THE FLAG AND NOTHING ELSE, which is why a grid must not call it to
 * decide what to freeze. `PATCH /api/registers` KEEPS the pin when it hides a
 * column — deliberately, so that ticking the column again gives back the lane
 * the operator had — so `pinned && hidden` is the ORDINARY state of a register
 * whose frozen column is currently unticked, and not the stale-snapshot corner
 * this paragraph once described. A lane rendered from such a column is a frozen
 * strip with nothing in it and a width the scrolling cells are indented past.
 * `frozenRegisterColumn` is the question a grid actually has, and it answers
 * this one first.
 *
 * A grid that freezes a lane should ALSO drop that column from the scrolling
 * run — `registerTableColumns` does both — or the value is drawn twice on every
 * row.
 */
export function pinnedColumn(columns: readonly RegisterColumn[]): RegisterColumn | null {
  return columns.find((column) => column.pinned) ?? null;
}

/**
 * WHICH COLUMN THE REGISTER IS FREEZING. The one answer, for every grid.
 *
 * Exported from HERE rather than from the Contractors grid so that the rule has
 * one home: the grid, the columns panel and the ordering helpers below all have
 * to agree about which column is out of the scrolling run, and three readings
 * of `settings` would be three chances to disagree.
 *
 * VISIBILITY WINS, in every branch and without exception. This is the whole of
 * the fix for "unticking Contractor leaves the lane on the table": the previous
 * version ended `columns.find((column) => column.nativeField === "name")` with
 * no `hidden` check, so the checkbox wrote `hidden_at` and the lane was
 * re-derived from the same column on the very next render. A hidden column is
 * one the reader has taken off the register, and there is no state — pin
 * included — in which the answer to "should this be drawn" is yes. The stored
 * pin is left alone rather than repaired, so showing the column again returns
 * it to the lane it was in.
 *
 * THE FALLBACK IS STILL THE POINT OF THE FUNCTION. Not one organisation in
 * either database pinned a column by hand: the seed sets the flag once, at
 * seed, so it reaches a workspace created after the flag existed and nobody
 * else. An unpinned register therefore freezes its IDENTITY, because a row that
 * does not say whose row it is was the defect the lane was built for — but only
 * while that identity is on the table, which is the clause that was missing.
 *
 * A STORED `pinned: false` IS HONOURED. Unpinning WRITES `false` rather than
 * removing the key (see `settingsWithPin`), precisely so "somebody chose no" is
 * distinguishable from "nobody ever chose". `{}` means the second and falls
 * back; an explicit `false` anywhere on the register means the first and leaves
 * no frozen lane at all — the only way a reader can turn the lane OFF, because
 * the fallback would otherwise freeze the identity again on the next render.
 */
export function frozenRegisterColumn(
  columns: readonly RegisterColumn[],
): RegisterColumn | null {
  const pinned = pinnedColumn(columns);
  if (pinned) return pinned.hidden ? null : pinned;

  const identity = identityRegisterColumn(columns);
  if (!identity || identity.hidden) return null;

  /*
   * "SOMEBODY CHOSE NO" IS A CHOICE ABOUT ONE COLUMN, so it is read off that
   * column and no other.
   *
   * This used to ask whether ANY column in the register carried
   * `settings.pinned === false`, which made one column's history speak for the
   * whole table. It is reachable and it is not hypothetical: the live
   * contractors register carries `{"pinned": false}` on `contactName` and
   * `email`, because somebody pinned each of them once while trying the control
   * out and then unpinned it. Under the old rule, the day the identity's own
   * pin was cleared the register would have rendered NO frozen lane at all —
   * not because anyone declined the lane, but because of a flag left on two
   * unrelated columns months earlier, and with nothing on screen to explain it.
   *
   * The fallback exists so a register nobody has configured still says whose
   * row is whose. The only person who can withdraw that is somebody who unpins
   * THE IDENTITY, and `{"pinned": false}` on the identity is exactly how that
   * is recorded — see `settingsWithPin`, which writes the refusal rather than
   * erasing the key so this branch has something to read.
   */
  const declined =
    identity.settings &&
    typeof identity.settings === "object" &&
    identity.settings.pinned === false;
  return declined ? null : identity;
}

/**
 * WHAT IS ON THE TABLE, IN THE ORDER IT IS DRAWN. One list, drawn twice.
 *
 * A header loop over one list beside a cell loop over another is a table whose
 * labels stop matching its values the first time anything is reordered, hidden
 * or pinned — and nothing about it fails, the figures simply appear under the
 * wrong headings, which is the one rendering fault a reader will believe. The
 * order is decided once, here, and both loops are a `.map` over the answer.
 *
 * THE FROZEN COLUMN IS LIFTED OUT OF THE SCROLLING RUN rather than drawn beside
 * it. A lane and a still-visible copy of the same column is the contractor's
 * name printed twice on every row, which is what the live register did.
 *
 * AND THERE IS NO SPACER. When nothing is frozen the answer simply starts with
 * the first scrolling column, so there is no empty lane to leave behind, no
 * reserved offset and no width to reset — a stale frozen strip is
 * unrepresentable rather than cleaned up.
 */
export function registerTableColumns(
  columns: readonly RegisterColumn[],
  frozen: RegisterColumn | null = frozenRegisterColumn(columns),
): RegisterColumn[] {
  const scrolling = visibleColumns(columns).filter(
    (column) => !frozen || column.id !== frozen.id,
  );
  return frozen ? [frozen, ...scrolling] : scrolling;
}

/**
 * The pin as an ORDERING fact: the key of the column no press can move, or null.
 *
 * The stored pin, and only while the column is on the table — a pinned column
 * that somehow arrived hidden is drawn nowhere, so it is an ordinary member of
 * the order and its move buttons must work. Sites takes this default and is
 * right to: it persists a pin and hoists that column to the front of its own
 * run. Contractors passes `frozenRegisterColumn(...)?.key` instead, because its
 * lane can be the identity FALLBACK, which carries no flag for this to read.
 */
function defaultFrozenKey(columns: readonly RegisterColumn[]): string | null {
  const pinned = pinnedColumn(columns);
  return pinned && !pinned.hidden ? pinned.key : null;
}

/**
 * The column one press of Move earlier / Move later swaps with, or -1.
 *
 * EVERY MOVE IS A SWAP OF TWO ENTRIES IN THE FULL ORDER. That is the whole
 * model, and it is what makes a press reversible: Move earlier followed by Move
 * later restores the exact order that was there, and every column the press did
 * not name keeps its index. A splice would not — it drags the run of hidden
 * columns between the two along with it, and the pair of presses would leave
 * the checklist rearranged.
 *
 * WHICH NEIGHBOUR, and this is the defect this function exists for. Stepping
 * ±1 through the FULL list is what made Move earlier do nothing: the owner's
 * contractors register holds 22 hidden columns and its visible positions are 0,
 * 15, 20, 21, 26…30, so almost every press swapped a column on the table with a
 * HIDDEN neighbour. The metadata really did change and the checklist really did
 * show it; the table could not, because nothing on it had moved. So:
 *
 *   A COLUMN ON THE TABLE steps past the next column ON THE TABLE, however many
 *   hidden ones lie between. One press, one visible change, every time.
 *
 *   A HIDDEN COLUMN steps one place through the full order. It is not on the
 *   table, so there is no visible sibling for it to cross and nothing for the
 *   table to do — and the checklist, which lists every column, shows the move.
 *   Swapping a hidden column with anything can never disturb the visible order,
 *   because it contributes nothing to it.
 *
 *   THE FROZEN COLUMN DOES NOT MOVE, and neither does anything move past it.
 *   It is drawn in a lane of its own rather than in the run, so a press on it —
 *   or a press that would only carry another column over it — writes metadata
 *   the table cannot follow. Refused here, and the panel draws the button
 *   disabled from the same answer.
 */
function stepNeighbour(
  columns: readonly RegisterColumn[],
  from: number,
  delta: number,
  frozenKey: string | null,
): number {
  const moving = columns[from];
  if (!moving || delta === 0) return -1;
  if (frozenKey !== null && moving.key === frozenKey) return -1;
  const step = delta < 0 ? -1 : 1;
  const onTable = !moving.hidden;
  for (let index = from + step; index >= 0 && index < columns.length; index += step) {
    const candidate = columns[index];
    if (!onTable) return index;
    if (candidate.hidden) continue;
    if (frozenKey !== null && candidate.key === frozenKey) continue;
    return index;
  }
  return -1;
}

/**
 * Would this press change anything? Asked before it is offered.
 *
 * The columns panel draws Move earlier and Move later disabled from this rather
 * than from `index === 0`, which was a test on the FULL list and so left the
 * button live on a column that was already first ON THE TABLE. A press that
 * writes a new order the reader cannot see is the same defect as a press that
 * writes nothing, and this is where both are refused.
 */
export function canMoveRegisterColumn(
  columns: readonly RegisterColumn[],
  column: RegisterColumn,
  delta: number,
  frozenKey: string | null = defaultFrozenKey(columns),
): boolean {
  const from = columns.findIndex((entry) => entry.key === column.key);
  return from >= 0 && stepNeighbour(columns, from, delta, frozenKey) >= 0;
}

/**
 * THE ONE PRESS OF MOVE EARLIER / MOVE LATER, as a whole new order.
 *
 * `delta` is a DIRECTION, not a distance: -1 is earlier and +1 is later, and
 * anything further is still one step, because "one press, one visible change"
 * is the contract and a caller that wanted two would press twice.
 *
 * Returns every key, ready to hand straight to `reorderRegisterColumns`, which
 * rewrites positions 0..n-1 densely. So the persisted order stays a TOTAL order
 * over all columns — hidden ones keep their place in it — and a reload draws
 * exactly what the press produced.
 */
export function orderAfterStep(
  columns: readonly RegisterColumn[],
  key: string,
  delta: number,
  frozenKey: string | null = defaultFrozenKey(columns),
): string[] {
  const keys = columns.map((column) => column.key);
  const from = keys.indexOf(key);
  if (from < 0) return keys;
  const to = stepNeighbour(columns, from, delta, frozenKey);
  if (to < 0) return keys;
  const next = keys.slice();
  next[from] = keys[to];
  next[to] = keys[from];
  return next;
}

/**
 * The order a DROP produces: `key` lifted out and dropped at `toIndex`.
 *
 * Operates on the FULL column list rather than the visible one, so dropping
 * next to a hidden column does not silently reshuffle the ones nobody can see.
 * Returns keys, ready to hand straight to `reorderRegisterColumns`.
 *
 * A ONE-PLACE TARGET IS A PRESS, AND IS DELEGATED. Both grids compute
 * `index + delta` off the column's own place in the full list and call this,
 * which is how ±1 came to mean "swap with whatever is next, hidden or not" —
 * the defect `stepNeighbour` sets out. Routed there rather than fixed twice, so
 * a press behaves identically wherever it is made and there is exactly one
 * definition of what "earlier" means. Anything further than one place is a real
 * drop to a real index and keeps the plain splice.
 */
export function orderAfterMove(
  columns: readonly RegisterColumn[],
  key: string,
  toIndex: number,
): string[] {
  const keys = columns.map((column) => column.key);
  const from = keys.indexOf(key);
  if (from < 0) return keys;
  const target = Math.min(Math.max(toIndex, 0), keys.length - 1);
  if (Math.abs(target - from) === 1) return orderAfterStep(columns, key, target - from);
  keys.splice(from, 1);
  keys.splice(target, 0, key);
  return keys;
}
