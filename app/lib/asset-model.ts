/**
 * WHAT AN ASSET IS — the rules, in one pure module.
 *
 * ── THE ASSET IS THE `units` ROW, AND THAT IS DELIBERATE ───────────────────
 *
 * The Assets section is not a new entity. `units` has been this product's asset
 * register since W5 and says so in its own schema comment; it already carries
 * `asset_tag`, `location_in_site`, `installed_at`, `warranty_expiry`,
 * `supplier` and `purchase_price_pence`, its history lives in
 * `unit_service_records`, `attachments.unit_id` is an anchor the upload routes
 * already validate against the tenant, the Sites screen already draws a tab
 * called "Assets" from those rows, and the capability that guards it is
 * literally labelled "Edit sites and assets".
 *
 * A second table called `assets` would therefore have given this product two
 * answers to "what equipment is at Kingsway", which is the failure every long
 * comment in this repository is written against. So the table is extended
 * additively and the PRODUCT VOCABULARY becomes Asset: the screen, the API
 * (`/api/assets`) and this module all say asset, and `units` survives as the
 * physical table name because renaming a live table is not something the
 * additive migration mechanism in `db/init.ts` can do, and not something worth
 * doing to a client's estate to win a word.
 *
 * ── WHY THIS FILE IS PURE ──────────────────────────────────────────────────
 *
 * The same rules have to hold in three places — the route that writes, the
 * screen that draws the form, and the tests that pin them. Kind labels,
 * specification parsing and the cycle check were each about to be written
 * twice, and the codebase has already paid for that twice over (see the
 * contractor scorecard, where a SQL aggregate and a TypeScript reducer
 * disagreed on four figures at once). No hooks, no JSX, no clock, no imports
 * beyond types: a test can load this module and CALL it.
 */

/* ── Kind ─────────────────────────────────────────────────────────────────── */

/**
 * The nature of the record, as opposed to what trade it belongs to.
 *
 * A FIXED vocabulary, unlike category and status, and the difference is not an
 * oversight. Category and status are business language that changes — a
 * workspace may well want "EV charging" next year — so they live in the option
 * store and need no migration. Kind is structural: the screen groups by it, the
 * KPI row counts two of its four members by name, and a fifth member invented
 * by an administrator would appear in neither. Four stable values, stored
 * verbatim, displayed through `ASSET_KIND_LABELS`.
 */
export const ASSET_KINDS = [
  "equipment",
  "component",
  "replacement_part",
  "reference",
] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  equipment: "Equipment",
  component: "Component",
  replacement_part: "Replacement part",
  reference: "Reference",
};

/** What each kind is for, shown beside the field rather than in a manual. */
export const ASSET_KIND_HINTS: Record<AssetKind, string> = {
  equipment: "A whole item installed at the site — an AC unit, a screen, a sink.",
  component: "Part of something larger — a transformer, a hinge, an LED driver.",
  replacement_part: "A part held or ordered to replace one that fails.",
  reference: "A specification rather than an object — a paint code, a finish.",
};

export const DEFAULT_ASSET_KIND: AssetKind = "equipment";

export function isAssetKind(value: unknown): value is AssetKind {
  return typeof value === "string" && (ASSET_KINDS as readonly string[]).includes(value);
}

/** An untrusted value narrowed to a kind, falling back rather than throwing. */
export function assetKind(value: unknown): AssetKind {
  return isAssetKind(value) ? value : DEFAULT_ASSET_KIND;
}

export function assetKindLabel(value: unknown): string {
  return ASSET_KIND_LABELS[assetKind(value)];
}

/* ── Status ───────────────────────────────────────────────────────────────── */

/**
 * The status a "needs replacement" filter and KPI count.
 *
 * Statuses come from the option store (`unit_status`) and a workspace may add
 * its own, so this is the SEEDED value rather than a closed list — the same
 * relationship `job_status_map` has with the board's Status column. Counting by
 * the stored value is what lets an administrator rename the LABEL without the
 * KPI silently going to zero.
 */
export const NEEDS_REPLACEMENT_STATUS = "Needs replacement";

/** The seeded status that takes an asset out of service permanently. */
export const RETIRED_STATUS = "Retired";

export function needsReplacement(status: string | null | undefined): boolean {
  return (status ?? "").trim().toLowerCase() === NEEDS_REPLACEMENT_STATUS.toLowerCase();
}

/* ── Asset number ─────────────────────────────────────────────────────────── */

/** `AST-000123`. Six digits, so the register sorts as text and reads as a code. */
export function formatAssetNumber(sequence: number): string {
  const safe = Number.isFinite(sequence) && sequence > 0 ? Math.trunc(sequence) : 1;
  return `AST-${String(safe).padStart(6, "0")}`;
}

export const ASSET_NUMBER_PATTERN = /^AST-\d{6,}$/;

/* ── Flexible specifications ──────────────────────────────────────────────── */

/**
 * One technical fact about an asset: a name, a value, and optionally a unit.
 *
 * WHY NOT COLUMNS. An LED strip has a colour temperature and an IP rating, a
 * transformer has an input and an output voltage, a hinge has an opening angle
 * and a paint has a finish. Modelled as columns that is forty nullable fields,
 * thirty-eight of them empty on every row, and a migration every time somebody
 * buys a new kind of thing.
 *
 * WHY NOT A TABLE. A specification is never queried across assets — nobody asks
 * "every asset whose IP rating is 65". It is read with its asset and written
 * with its asset, always in full, which is the shape a JSON column serves
 * exactly and a join serves at the cost of a second write path. `contractors`
 * already stores `service_categories` and `certifications` this way.
 *
 * The search does reach into it, as text, which is the one cross-asset question
 * that is actually asked: "what did we use, it was 3000K something".
 */
export type AssetSpec = {
  key: string;
  value: string;
  unit: string;
};

export const MAX_SPECS = 40;
export const SPEC_KEY_MAX = 60;
export const SPEC_VALUE_MAX = 120;
export const SPEC_UNIT_MAX = 20;

function trimTo(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Untrusted input — a request body or a stored column — as a clean spec list.
 *
 * Never throws and never returns a partial entry: a row with no key is dropped
 * rather than stored as `"": "24"`, because a nameless specification is not a
 * fact about the asset, it is a typo somebody abandoned. Duplicate keys keep
 * the LAST value, matching how a form's own later field wins.
 */
export function parseSpecs(input: unknown): AssetSpec[] {
  const raw = typeof input === "string" ? safeJson(input) : input;
  if (!Array.isArray(raw)) return [];
  const seen = new Map<string, AssetSpec>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const key = trimTo(record.key ?? record.name, SPEC_KEY_MAX);
    if (!key) continue;
    seen.set(key.toLowerCase(), {
      key,
      value: trimTo(record.value, SPEC_VALUE_MAX),
      unit: trimTo(record.unit, SPEC_UNIT_MAX),
    });
  }
  return [...seen.values()].slice(0, MAX_SPECS);
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** The column value. `[]` rather than NULL, so every reader gets an array. */
export function serialiseSpecs(specs: readonly AssetSpec[]): string {
  return JSON.stringify(specs);
}

/** `Voltage 24 V · Width 10 mm` — one line for the table and the search index. */
export function specsSummary(specs: readonly AssetSpec[]): string {
  return specs
    .map((spec) => [spec.key, spec.value, spec.unit].filter(Boolean).join(" "))
    .join(" · ");
}

/* ── Relationships ────────────────────────────────────────────────────────── */

/**
 * How far a parent chain may be walked before the answer is "this is a cycle".
 *
 * A display cabinet holding a light holding a driver is three deep and real;
 * anything past this is either a mistake or an attack, and either way the walk
 * has to stop. The check runs against the SAME rows the writer is about to
 * commit, so it is the depth of the chain and not the size of the estate.
 */
export const MAX_PARENT_DEPTH = 12;

export type ParentLookup = (id: string) => string | null | undefined;

/**
 * Whether making `parentId` the parent of `childId` would close a loop.
 *
 * Walks UP from the proposed parent looking for the child. Self-parenting is
 * the zero-length case and is caught first, because `a -> a` never enters the
 * loop below. Returns true for a chain longer than `MAX_PARENT_DEPTH` as well:
 * an unresolvable chain is not a proven cycle, but it is not something to write
 * either, and refusing is the safe direction.
 */
export function wouldCycle(
  childId: string,
  parentId: string,
  parentOf: ParentLookup,
): boolean {
  if (!childId || !parentId) return false;
  if (childId === parentId) return true;
  let cursor: string | null | undefined = parentId;
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
    if (!cursor) return false;
    if (cursor === childId) return true;
    cursor = parentOf(cursor);
  }
  return true;
}

/* ── Search ───────────────────────────────────────────────────────────────── */

/**
 * Every field one search box has to reach, as one lowercase haystack.
 *
 * Built in the BROWSER from rows the server already sent, deliberately. The
 * alternative — a `LIKE` across fourteen columns on every keystroke — is a
 * table scan per character against a register that is a few hundred rows, and
 * it would still have to reach inside the specification JSON to answer "3000K",
 * which SQLite and Postgres spell differently. This is the pattern the
 * Contractors register already uses.
 */
export function assetHaystack(asset: {
  name?: string | null;
  assetNumber?: string | null;
  assetTag?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  partNumber?: string | null;
  serialNumber?: string | null;
  specification?: string | null;
  colour?: string | null;
  colourCode?: string | null;
  paintReference?: string | null;
  supplier?: string | null;
  supplierReference?: string | null;
  locationInSite?: string | null;
  replacementPartNumber?: string | null;
  replacementModel?: string | null;
  notes?: string | null;
  specs?: readonly AssetSpec[] | string | null;
  siteName?: string | null;
}): string {
  const specs = Array.isArray(asset.specs)
    ? asset.specs
    : parseSpecs(asset.specs ?? null);
  return [
    asset.name,
    asset.assetNumber,
    asset.assetTag,
    asset.manufacturer,
    asset.model,
    asset.partNumber,
    asset.serialNumber,
    asset.specification,
    asset.colour,
    asset.colourCode,
    asset.paintReference,
    asset.supplier,
    asset.supplierReference,
    asset.locationInSite,
    asset.replacementPartNumber,
    asset.replacementModel,
    asset.notes,
    asset.siteName,
    specsSummary(specs),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/* ── History ──────────────────────────────────────────────────────────────── */

/**
 * What happened to an asset, as opposed to what was done to the record.
 *
 * `unit_service_records` was a service timeline and is now an asset lifecycle:
 * the same row, with the event named. "Replaced" is the one that earns the
 * table its keep — a site that moved from transformer A to transformer B must
 * not lose A, and overwriting `model` is exactly how it would.
 *
 * Stored in `event_type`. `service_type` beside it keeps its old meaning (the
 * KIND of service: "Annual", "Callout"), so no existing row had to be rewritten
 * and no existing reader changed.
 */
export const ASSET_EVENTS = [
  "Installed",
  "Replaced",
  "Serviced",
  "Retired",
  "Status changed",
] as const;

export type AssetEvent = (typeof ASSET_EVENTS)[number];

export const DEFAULT_ASSET_EVENT: AssetEvent = "Serviced";

export function isAssetEvent(value: unknown): value is AssetEvent {
  return typeof value === "string" && (ASSET_EVENTS as readonly string[]).includes(value);
}

export function assetEvent(value: unknown): AssetEvent {
  return isAssetEvent(value) ? value : DEFAULT_ASSET_EVENT;
}

/* ── Validation shared by the route and the form ──────────────────────────── */

export const ASSET_NAME_MAX = 140;

/** A URL a person typed, or null. Only http(s) — never `javascript:`. */
export function safeUrl(value: unknown, max = 500): string | null {
  const raw = trimTo(value, max);
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? raw : null;
}

/**
 * Whether a URL a person typed is unusable, for the message beside the field.
 *
 * Separate from `safeUrl` because the two answers differ: an empty box is fine
 * and an unparseable one is not, and both make `safeUrl` return null.
 */
export function urlProblem(value: string): string | null {
  if (!value.trim()) return null;
  return safeUrl(value) ? null : "Enter a full web address, starting http:// or https://";
}

/** Non-negative money in pence, or null. Never a float; never a negative cost. */
export function costPence(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}
