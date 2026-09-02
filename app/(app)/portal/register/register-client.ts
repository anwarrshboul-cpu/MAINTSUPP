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
 * The order a drag produces: `key` lifted out and dropped at `toIndex`.
 *
 * Operates on the FULL column list rather than the visible one, so dropping
 * next to a hidden column does not silently reshuffle the ones nobody can see.
 * Returns keys, ready to hand straight to `reorderRegisterColumns`.
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
  keys.splice(from, 1);
  keys.splice(target, 0, key);
  return keys;
}
