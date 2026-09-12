/**
 * THE ASSETS API — the store's equipment, components, parts and references.
 *
 * ── WHAT THIS REPLACED ─────────────────────────────────────────────────────
 *
 * `app/api/units/route.ts`, which was the same register with a narrower model
 * and one consumer. It is not kept alongside: two routes writing one table is
 * how the contractor scorecard ended up printing four disagreeing figures, and
 * this file is the only writer of `units` in the product now.
 *
 * Three defects of that route are deliberately NOT carried over, each of which
 * its own file or a sibling already documents:
 *
 *   1. `PATCH` and `DELETE` answered `{ ok: true }` for an id that does not
 *      exist or belongs to another tenant, because an UPDATE whose WHERE clause
 *      matches nothing is a successful UPDATE. Every write here looks the row
 *      up first and answers 404. `app/api/sites/groups/route.ts:203` is where
 *      this rule was written down.
 *   2. The activity id was `activity-unit-<id>-<Date.now base36>` with no
 *      random suffix. Measured on `sites`: 113 of 144 concurrent PATCHes failed
 *      on the primary key, and because the row UPDATE ran first, the caller was
 *      told "failed" for a write that had already landed.
 *   3. No `export const dynamic`.
 *
 * ── SCOPE, WHICH IS THE PART THAT MATTERS ──────────────────────────────────
 *
 * Two independent narrowings, and they are not the same thing:
 *
 *   · THE TENANT. `scopedDb` resolves `orgId` from the actor's memberships, and
 *     every predicate in this file carries `eq(units.organisationId, orgId)` —
 *     including updates and deletes, and including cases where the id was
 *     generated moments earlier. There is no ORM-level filter doing this; it is
 *     a convention, and `tests/w2-scope-model.test.mjs` greps for the omission.
 *   · THE MEMBER'S SITES. `scope.siteScope` is a membership restriction — an
 *     array of site ids, or null for unrestricted. `/api/units` ignored it
 *     entirely, which meant a member confined to three stores read the whole
 *     estate's asset register. Every read AND every write here folds it in
 *     through `siteFilter` / `assertSite`, so a restricted member cannot see an
 *     asset at another store, cannot create one there, and cannot move one
 *     there. An empty intersection matches nothing rather than everything,
 *     which is the trap `confineToSiteScope` exists for on the dashboard side.
 */

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import {
  activityLog,
  attachments,
  contractors,
  organisations,
  sites,
  unitServiceRecords,
  units,
} from "../../../db/schema";
import {
  anonymousRefusal,
  busyRefusal,
  scopedDb,
  scopedDbWithCapability,
  type ScopedDatabase,
} from "../../lib/tenant-db";
import { listOptionValues } from "../../lib/options-repository";
import { auditActor, recordAudit } from "../../lib/audit";
import { attachmentPayload, liveDocumentFilter } from "../files/documents";
import { sendAssetToBin } from "../../lib/recycle-bin";
import {
  ASSET_KINDS,
  ASSET_KIND_LABELS,
  ASSET_EVENTS,
  assetEvent,
  assetKind,
  costPence,
  formatAssetNumber,
  MAX_PARENT_DEPTH,
  needsReplacement,
  parseSpecs,
  safeUrl,
  serialiseSpecs,
  wouldCycle,
} from "../../lib/asset-model";

export const dynamic = "force-dynamic";

type Db = ScopedDatabase["db"];

/* ── Input coercion ───────────────────────────────────────────────────────── */

function text(value: unknown, max = 240) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function optionalText(value: unknown, max = 240) {
  const result = text(value, max);
  return result.length ? result : null;
}

function wholeNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

/** A count of things, so never negative and never a fraction. */
function quantity(value: unknown) {
  const parsed = wholeNumber(value);
  return parsed === null || parsed < 0 ? null : parsed;
}

/**
 * A service or replacement interval in months, bounded.
 *
 * Fifty years is past any equipment anyone will refit, and the ceiling is not
 * tidiness: `addMonths` adds the interval to a date and calls `toISOString()`,
 * which THROWS a RangeError once the result leaves the ±273,790-year range JS
 * dates cover. Unbounded, storing `1e9` here and then recording one service
 * event produced a 503 — after the history row had already been written, so the
 * asset was left with an event and no derived date, repeatably, for ever.
 */
function intervalMonths(value: unknown) {
  const parsed = wholeNumber(value);
  if (parsed === null || parsed < 0) return null;
  return Math.min(parsed, 600);
}

/** `YYYY-MM-DD`. Every date on an asset is a day, never a moment. */
function isoDate(value: unknown) {
  const raw = text(value, 30);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function addMonths(from: string, months: number) {
  const date = new Date(`${from}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

/** A refusal the caller can act on, as opposed to a 503 that blames the database. */
class InvalidAsset extends Error {}

function invalid(message: string): never {
  throw new InvalidAsset(message);
}

/* ── Scope helpers ────────────────────────────────────────────────────────── */

/**
 * The membership's site restriction as a predicate, or undefined for nobody.
 *
 * `undefined` is drizzle's "no condition", which `and()` drops — so an
 * unrestricted member gets the whole workspace and a restricted one gets an
 * `IN` list. A restriction that is present but EMPTY cannot happen:
 * `parseSiteScope` returns null rather than `[]` for exactly that reason, and
 * an `inArray` with no values is a SQL error in one dialect and "everything" in
 * the other.
 */
function siteFilter(siteScope: string[] | null) {
  return siteScope && siteScope.length ? inArray(units.siteId, siteScope) : undefined;
}

/**
 * The site this asset is being filed at, proved to belong to the caller.
 *
 * Two questions in one lookup, because they have the same answer shape: is this
 * site in the workspace, and is it one this member may touch. A restricted
 * member naming a store outside their scope is told the site was not found —
 * the same words another tenant's id gets, because confirming that an id exists
 * somewhere they cannot see is itself a disclosure.
 */
async function assertSite(
  db: Db,
  orgId: string,
  siteScope: string[] | null,
  siteId: string,
) {
  if (!siteId) invalid("Choose the site this asset is at.");
  const [site] = await db
    .select({ id: sites.id })
    .from(sites)
    .where(
      and(
        eq(sites.id, siteId),
        eq(sites.organisationId, orgId),
        siteScope && siteScope.length ? inArray(sites.id, siteScope) : undefined,
      ),
    )
    .limit(1);
  if (!site) invalid("That site is not one you can add assets to.");
  return site.id;
}

/**
 * The supplier link, proved to be this workspace's own contractor.
 *
 * Empty is the ordinary case and is not an error — most assets carry a typed
 * supplier name and no link at all. A NON-empty id that does not resolve is
 * refused rather than silently dropped: quietly storing NULL would tell the
 * operator the link was saved.
 */
async function assertSupplier(db: Db, orgId: string, contractorId: string) {
  if (!contractorId) return null;
  const [row] = await db
    .select({ id: contractors.id })
    .from(contractors)
    .where(and(eq(contractors.id, contractorId), eq(contractors.organisationId, orgId)))
    .limit(1);
  if (!row) invalid("That supplier is not a contractor in this workspace.");
  return row.id;
}

/**
 * The parent, proved to be legal — same workspace, same site, and no loop.
 *
 * THE THREE RULES ARE CHECKED IN ONE PLACE because they fail in different ways
 * and only together do they mean anything. A parent in another tenant is a
 * disclosure; a parent at another site is a lie about where the thing is; and a
 * cycle is a page that never finishes rendering.
 *
 * The cycle walk is `MAX_PARENT_DEPTH` single-row lookups at worst and runs
 * only on a write that actually names a parent. It reads from the database
 * rather than a cached tree, so a tree this process fetched earlier cannot
 * produce a stale answer.
 *
 * WHAT IT DOES NOT COVER, stated because the obvious reading is that it does:
 * there is no transaction around the check and the write, so two SIMULTANEOUS
 * requests — `A parent := B` and `B parent := A` — can each pass their own
 * check and both commit. The consequence is bounded rather than serious:
 * `readOne` resolves exactly one level in each direction and the screen does
 * not recurse, so nothing hangs; the pair simply becomes unreparentable,
 * because every later write touching it exhausts the depth and is refused.
 * Closing it properly needs the check and the update in one transaction, which
 * the D1 interface this file is written against does not offer.
 */
async function assertParent(
  db: Db,
  orgId: string,
  childId: string,
  parentId: string,
  siteId: string,
) {
  if (!parentId) return null;
  if (parentId === childId) invalid("An asset cannot be part of itself.");

  const [parent] = await db
    .select({ id: units.id, siteId: units.siteId, parentUnitId: units.parentUnitId })
    .from(units)
    .where(
      and(
        eq(units.id, parentId),
        eq(units.organisationId, orgId),
        isNull(units.deletedAt),
      ),
    )
    .limit(1);
  if (!parent) invalid("That parent asset is not in this workspace.");
  if (parent.siteId !== siteId) {
    invalid("A parent asset has to be at the same site as the asset it holds.");
  }

  /*
   * Walk UP from the proposed parent, one row at a time, looking for the child.
   *
   * `wouldCycle` is the pure half and lives in `asset-model.ts` so a test can
   * call it; this loads the chain it walks over. The lookups are collected
   * first and the decision is made once, rather than deciding inside the loop,
   * so the rule and the I/O stay separable.
   */
  const chain = new Map<string, string | null>([[parent.id, parent.parentUnitId ?? null]]);
  let cursor = parent.parentUnitId ?? null;
  for (let depth = 0; depth < MAX_PARENT_DEPTH && cursor; depth += 1) {
    if (chain.has(cursor)) break;
    const [row] = await db
      .select({ id: units.id, parentUnitId: units.parentUnitId })
      .from(units)
      .where(and(eq(units.id, cursor), eq(units.organisationId, orgId)))
      .limit(1);
    if (!row) break;
    chain.set(row.id, row.parentUnitId ?? null);
    cursor = row.parentUnitId ?? null;
  }
  if (wouldCycle(childId, parentId, (id) => chain.get(id) ?? null)) {
    invalid("That would make the asset its own ancestor.");
  }
  return parent.id;
}

/**
 * An option the workspace has actually configured.
 *
 * Copied in spirit from the units route, with one change: an EMPTY candidate
 * falls back to the set's default rather than being refused, because category
 * and status are required columns and a create with neither should still land
 * with something sensible. An unrecognised value is refused and says where to
 * add it, which is the message an operator can act on.
 */
async function validateOption(db: Db, orgId: string, key: string, candidate: string) {
  const values = await listOptionValues(db, orgId, key);
  if (!candidate) {
    const fallback =
      values.find((entry) => entry.active && entry.isDefault) ??
      values.find((entry) => entry.active);
    return fallback?.value ?? "";
  }
  const match = values.find((entry) => entry.value === candidate);
  if (!match) {
    invalid(
      `"${candidate}" is not a configured ${key.replace("unit_", "asset ").replace(/_/g, " ")}. ` +
        "Add it in Settings first.",
    );
  }
  return match.value;
}

/* ── The asset number ─────────────────────────────────────────────────────── */

/**
 * The next `AST-000123` for this workspace.
 *
 * ONE STATEMENT, increment and read together. The obvious two-statement
 * version — `UPDATE … SET n = n + 1`, then `SELECT n` — has already been
 * measured wrong in this codebase on job references: the increment is atomic,
 * the read afterwards is not, and a burst of ten concurrent creates was handed
 * three distinct numbers with one of them shared by five rows. `RETURNING`
 * makes each caller see the value its own increment produced.
 *
 * `units_asset_number_idx` is UNIQUE per workspace, so even if this were ever
 * wrong the database would refuse the second row rather than mint a duplicate
 * reference somebody later quotes in an order.
 */
async function nextAssetNumber(db: Db, orgId: string): Promise<string> {
  const [row] = await db
    .update(organisations)
    .set({ assetSequence: sql`${organisations.assetSequence} + 1` })
    .where(eq(organisations.id, orgId))
    .returning({ sequence: organisations.assetSequence });
  return formatAssetNumber(Number(row?.sequence ?? 1));
}

/* ── Payload ──────────────────────────────────────────────────────────────── */

/**
 * The writable fields of an asset, coerced.
 *
 * Every value is bounded, every URL is proved to be http(s) before it is stored
 * (a `javascript:` supplier link would otherwise become a stored XSS the moment
 * a screen rendered it as an anchor), and every figure that is money is pence.
 */
function assetPayload(data: Record<string, unknown>) {
  return {
    name: text(data.name, 140),
    category: text(data.category, 80),
    status: text(data.status, 40),
    kind: assetKind(data.kind),

    manufacturer: optionalText(data.manufacturer, 100),
    model: optionalText(data.model, 100),
    serialNumber: optionalText(data.serialNumber, 100),
    partNumber: optionalText(data.partNumber, 100),
    assetTag: optionalText(data.assetTag, 60),
    specification: optionalText(data.specification, 1000),
    colour: optionalText(data.colour, 80),
    colourCode: optionalText(data.colourCode, 60),
    paintReference: optionalText(data.paintReference, 120),
    specs: serialiseSpecs(parseSpecs(data.specs)),
    quantity: quantity(data.quantity),

    locationInSite: optionalText(data.locationInSite, 160),
    installedAt: isoDate(data.installedAt),
    warrantyExpiry: isoDate(data.warrantyExpiry),
    purchasePricePence: costPence(data.purchasePrice ?? data.purchasePricePence),
    lastServicedAt: isoDate(data.lastServicedAt),
    serviceIntervalMonths: intervalMonths(data.serviceIntervalMonths),

    supplier: optionalText(data.supplier, 160),
    supplierReference: optionalText(data.supplierReference, 120),
    supplierEmail: optionalText(data.supplierEmail, 200),
    supplierPhone: optionalText(data.supplierPhone, 60),
    supplierUrl: safeUrl(data.supplierUrl),

    lastReplacedAt: isoDate(data.lastReplacedAt),
    replacementIntervalMonths: intervalMonths(data.replacementIntervalMonths),
    replacementPartNumber: optionalText(data.replacementPartNumber, 100),
    replacementModel: optionalText(data.replacementModel, 100),
    replacementSpecification: optionalText(data.replacementSpecification, 1000),
    replacementSupplier: optionalText(data.replacementSupplier, 160),
    replacementNotes: optionalText(data.replacementNotes, 1000),
    replacementCostPence: costPence(data.replacementCost ?? data.replacementCostPence),

    notes: optionalText(data.notes, 2000),
  };
}

/**
 * WHICH REQUEST KEY SETS WHICH COLUMN.
 *
 * The table exists so that PATCH can mean PATCH. `assetPayload` above coerces
 * every field it knows about whether or not the caller sent it — which is right
 * for a create, where an absent field genuinely is empty, and wrong for an
 * edit, where an absent field means "leave it alone".
 *
 * Two real defects came out of not having this, and both were found by driving
 * the running server rather than by reading:
 *
 *   · `POST /api/files` then "Make primary" sends `{ primaryImageId }` alone.
 *     The old PATCH ran `assetPayload` over it, found no `name`, and answered
 *     400 "Give the asset a name." for an asset that plainly had one. The
 *     feature could not be used at all.
 *   · The edit form does not carry `primaryImageId` or `nextServiceDueAt` —
 *     one is set from the files panel and the other is derived from a service
 *     event — so saving the form nulled both. A routine edit destroyed the
 *     asset's thumbnail and the next-service date the product had just worked
 *     out for itself.
 *
 * Two keys map to one column on purpose: the browser posts pounds as
 * `purchasePrice` and an API caller may post `purchasePricePence`, and either
 * one counts as "given".
 */
const PAYLOAD_SOURCES: Readonly<Record<string, readonly string[]>> = {
  name: ["name"],
  category: ["category"],
  status: ["status"],
  kind: ["kind"],
  manufacturer: ["manufacturer"],
  model: ["model"],
  serialNumber: ["serialNumber"],
  partNumber: ["partNumber"],
  assetTag: ["assetTag"],
  specification: ["specification"],
  colour: ["colour"],
  colourCode: ["colourCode"],
  paintReference: ["paintReference"],
  specs: ["specs"],
  quantity: ["quantity"],
  locationInSite: ["locationInSite"],
  installedAt: ["installedAt"],
  warrantyExpiry: ["warrantyExpiry"],
  purchasePricePence: ["purchasePrice", "purchasePricePence"],
  lastServicedAt: ["lastServicedAt"],
  serviceIntervalMonths: ["serviceIntervalMonths"],
  supplier: ["supplier"],
  supplierReference: ["supplierReference"],
  supplierEmail: ["supplierEmail"],
  supplierPhone: ["supplierPhone"],
  supplierUrl: ["supplierUrl"],
  lastReplacedAt: ["lastReplacedAt"],
  replacementIntervalMonths: ["replacementIntervalMonths"],
  replacementPartNumber: ["replacementPartNumber"],
  replacementModel: ["replacementModel"],
  replacementSpecification: ["replacementSpecification"],
  replacementSupplier: ["replacementSupplier"],
  replacementNotes: ["replacementNotes"],
  replacementCostPence: ["replacementCost", "replacementCostPence"],
  notes: ["notes"],
};

/**
 * The columns one PATCH may write.
 *
 * The table's own insert shape rather than the payload's, because four of the
 * columns a PATCH can set — the supplier link, the parent, the primary image
 * and the derived next-service date — are resolved by their own lookups rather
 * than coerced from the body, and so are not part of `assetPayload`.
 */
type AssetChanges = Partial<typeof units.$inferInsert>;

/** Whether the caller actually sent this key. An explicit null still counts. */
function given(data: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(data, key);
}

/** The coerced payload, narrowed to the columns the caller actually named. */
function pickGiven(
  payload: ReturnType<typeof assetPayload>,
  data: Record<string, unknown>,
): AssetChanges {
  const out: AssetChanges = {};
  for (const [column, keys] of Object.entries(PAYLOAD_SOURCES)) {
    if (keys.some((key) => given(data, key))) {
      /* The cast is confined to this one loop: `column` is a key of the payload
         by construction — `tests/assets-section.test.mjs` holds the two lists
         level so the map cannot fall behind the payload. */
      (out as Record<string, unknown>)[column] =
        (payload as unknown as Record<string, unknown>)[column];
    }
  }
  return out;
}

/**
 * The asset's own timeline entry, for the reader working the site.
 *
 * Kept alongside `recordAudit` rather than replaced by it, and the two are not
 * redundant: `activity_log` is what the Site screen's Activity tab draws and is
 * about the work, while `audit_events` is the append-only system trail somebody
 * reads months later to answer a question about who changed what. The audit
 * module's own header sets that division out; this follows it.
 */
async function logChange(
  db: Db,
  orgId: string,
  assetId: string,
  action: string,
  actorEmail: string,
  detail: Record<string, unknown>,
) {
  await db.insert(activityLog).values({
    /* The random suffix is not decoration — see the header. */
    id: `activity-asset-${assetId}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    organisationId: orgId,
    entityType: "asset",
    entityId: assetId,
    action,
    actorEmail,
    detail: JSON.stringify(detail).slice(0, 4000),
  });
}

/** The vocabulary and the pickers every screen needs, resolved once. */
async function referenceData(db: Db, orgId: string, siteScope: string[] | null) {
  const [categories, statuses, siteRows, supplierRows] = await Promise.all([
    listOptionValues(db, orgId, "unit_category"),
    listOptionValues(db, orgId, "unit_status"),
    db
      .select({ id: sites.id, name: sites.name })
      .from(sites)
      .where(
        and(
          eq(sites.organisationId, orgId),
          siteScope && siteScope.length ? inArray(sites.id, siteScope) : undefined,
        ),
      )
      .orderBy(asc(sites.name)),
    db
      .select({ id: contractors.id, name: contractors.name })
      .from(contractors)
      .where(and(eq(contractors.organisationId, orgId), eq(contractors.active, true)))
      .orderBy(asc(contractors.name)),
  ]);
  return {
    categories,
    statuses,
    sites: siteRows,
    suppliers: supplierRows,
    kinds: ASSET_KINDS.map((key) => ({ value: key, label: ASSET_KIND_LABELS[key] })),
    events: ASSET_EVENTS,
  };
}

/* ── GET ──────────────────────────────────────────────────────────────────── */

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const { db, orgId, siteScope } = await scopedDb(request);
    const url = new URL(request.url);
    const id = text(url.searchParams.get("id"), 120);
    const siteId = text(url.searchParams.get("siteId"), 120);

    if (id) return await readOne(db, orgId, siteScope, id);

    /*
     * A site named in the query is INTERSECTED with the member's scope rather
     * than replacing it. Asking for a store outside the restriction returns
     * nothing, which is the honest answer; letting the parameter widen the
     * predicate is the bug this shape exists to prevent.
     */
    if (siteId && siteScope && siteScope.length && !siteScope.includes(siteId)) {
      return Response.json({
        assets: [],
        totals: { all: 0, equipment: 0, replacementParts: 0, needsReplacement: 0 },
        ...(await referenceData(db, orgId, siteScope)),
      });
    }

    const rows = await db
      .select({
        id: units.id,
        siteId: units.siteId,
        name: units.name,
        assetNumber: units.assetNumber,
        assetTag: units.assetTag,
        kind: units.kind,
        category: units.category,
        status: units.status,
        manufacturer: units.manufacturer,
        model: units.model,
        partNumber: units.partNumber,
        serialNumber: units.serialNumber,
        specification: units.specification,
        specs: units.specs,
        colour: units.colour,
        colourCode: units.colourCode,
        paintReference: units.paintReference,
        quantity: units.quantity,
        locationInSite: units.locationInSite,
        supplier: units.supplier,
        supplierContractorId: units.supplierContractorId,
        supplierReference: units.supplierReference,
        replacementPartNumber: units.replacementPartNumber,
        replacementModel: units.replacementModel,
        replacementNotes: units.replacementNotes,
        replacementCostPence: units.replacementCostPence,
        lastReplacedAt: units.lastReplacedAt,
        warrantyExpiry: units.warrantyExpiry,
        nextServiceDueAt: units.nextServiceDueAt,
        parentUnitId: units.parentUnitId,
        primaryImageId: units.primaryImageId,
        notes: units.notes,
        updatedAt: units.updatedAt,
      })
      .from(units)
      .where(
        and(
          eq(units.organisationId, orgId),
          isNull(units.deletedAt),
          siteId ? eq(units.siteId, siteId) : undefined,
          siteFilter(siteScope),
        ),
      )
      .orderBy(asc(units.position), asc(units.name));

    /*
     * THE KPI ROW IS COUNTED FROM THE ROWS THIS CALLER MAY SEE, not from a
     * second aggregate over the workspace. A `COUNT(*)` with its own predicate
     * is exactly how a restricted member came to read estate-wide totals off
     * the top of the dashboard — the block's endpoint forgot the scope the list
     * below it applied. Deriving the four figures from the array that is about
     * to be sent makes the tile and the list incapable of disagreeing.
     */
    const totals = {
      all: rows.length,
      equipment: rows.filter((row) => row.kind === "equipment").length,
      replacementParts: rows.filter((row) => row.kind === "replacement_part").length,
      /* Through the model's own helper, never a literal. The tile's figure and
         the filter that tile applies were two separate spellings of this rule,
         which is the server/browser drift `asset-model.ts` exists to prevent. */
      needsReplacement: rows.filter((row) => needsReplacement(row.status)).length,
    };

    return Response.json({
      assets: rows,
      totals,
      ...(await referenceData(db, orgId, siteScope)),
    });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const busy = busyRefusal(error, "The asset register could not be read.");
    if (busy) return busy;
    return Response.json(
      { error: "The asset register is temporarily unavailable." },
      { status: 503 },
    );
  }
}

/**
 * One asset, with everything the detail screen draws.
 *
 * The asset number is minted HERE for a row that predates the column, which is
 * the whole of the back-fill strategy: a write per asset on the boot path would
 * be a cold-start cost paid by every instance forever, and a write per asset on
 * the list read would be hundreds of writes for a page nobody asked to number.
 * One row, when somebody opens it.
 */
async function readOne(
  db: Db,
  orgId: string,
  siteScope: string[] | null,
  id: string,
) {
  const [asset] = await db
    .select()
    .from(units)
    .where(
      and(
        eq(units.id, id),
        eq(units.organisationId, orgId),
        isNull(units.deletedAt),
        siteFilter(siteScope),
      ),
    )
    .limit(1);
  if (!asset) return Response.json({ error: "Asset not found." }, { status: 404 });

  let assetNumber = asset.assetNumber;
  if (!assetNumber) {
    assetNumber = await nextAssetNumber(db, orgId);
    await db
      .update(units)
      .set({ assetNumber })
      .where(and(eq(units.id, id), eq(units.organisationId, orgId)));
  }

  const [history, files, children, parent] = await Promise.all([
    db
      .select()
      .from(unitServiceRecords)
      .where(
        and(
          eq(unitServiceRecords.organisationId, orgId),
          eq(unitServiceRecords.unitId, id),
        ),
      )
      .orderBy(desc(unitServiceRecords.performedAt), desc(unitServiceRecords.createdAt)),
    db
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.organisationId, orgId),
          eq(attachments.unitId, id),
          liveDocumentFilter(),
        ),
      )
      .orderBy(desc(attachments.createdAt)),
    db
      .select({
        id: units.id,
        name: units.name,
        kind: units.kind,
        status: units.status,
        assetNumber: units.assetNumber,
      })
      .from(units)
      /*
       * SCOPED, even though `assertParent` requires a parent and its children to
       * share a site. That invariant is enforced at write time and PATCH can
       * move an asset's site without moving its children's, so a child left
       * behind would otherwise name its parent — and the parent list its
       * children — across a boundary the rest of the route enforces.
       */
      .where(
        and(
          eq(units.organisationId, orgId),
          eq(units.parentUnitId, id),
          isNull(units.deletedAt),
          siteFilter(siteScope),
        ),
      )
      .orderBy(asc(units.name)),
    asset.parentUnitId
      ? db
          .select({ id: units.id, name: units.name, assetNumber: units.assetNumber })
          .from(units)
          .where(
            and(
              eq(units.id, asset.parentUnitId),
              eq(units.organisationId, orgId),
              isNull(units.deletedAt),
              siteFilter(siteScope),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
  ]);

  return Response.json({
    asset: { ...asset, assetNumber },
    history,
    files: files.map(attachmentPayload),
    children,
    parent: parent[0] ?? null,
    ...(await referenceData(db, orgId, siteScope)),
  });
}

/* ── POST — create, or record a lifecycle event ───────────────────────────── */

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "sites.edit");
    if (guard.denied) return guard.denied;
    const { actor, db, orgId, siteScope } = guard.scope;
    const body = (await request.json()) as {
      data?: Record<string, unknown>;
      event?: Record<string, unknown>;
      assetId?: string;
    };

    if (body.event) return await recordEvent(guard.scope, body.assetId, body.event, request);

    const data = body.data ?? {};
    const payload = assetPayload(data);
    if (!payload.name) invalid("Give the asset a name.");

    const siteId = await assertSite(db, orgId, siteScope, text(data.siteId, 120));
    const category = await validateOption(db, orgId, "unit_category", payload.category);
    const status = await validateOption(db, orgId, "unit_status", payload.status);
    const supplierContractorId = await assertSupplier(
      db,
      orgId,
      text(data.supplierContractorId, 120),
    );

    const id = `unit-${payload.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40)}-${Math.random().toString(36).slice(2, 8)}`;

    /* The parent is checked against the id that is about to exist, so a create
       that names a parent cannot produce a loop either. */
    const parentUnitId = await assertParent(
      db,
      orgId,
      id,
      text(data.parentUnitId, 120),
      siteId,
    );

    const assetNumber = await nextAssetNumber(db, orgId);

    await db.insert(units).values({
      id,
      organisationId: orgId,
      siteId,
      ...payload,
      assetNumber,
      category,
      status,
      supplierContractorId,
      parentUnitId,
      createdByEmail: actor.email,
      updatedByEmail: actor.email,
      nextServiceDueAt:
        payload.lastServicedAt && payload.serviceIntervalMonths
          ? addMonths(payload.lastServicedAt, payload.serviceIntervalMonths)
          : isoDate(data.nextServiceDueAt),
    });

    await logChange(db, orgId, id, "created", actor.email, {
      name: payload.name,
      siteId,
      assetNumber,
    });
    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor(guard.scope),
      action: "asset.created",
      entityType: "asset",
      entityId: id,
      summary: `Added asset ${assetNumber} — ${payload.name}.`,
      detail: { siteId, kind: payload.kind, category, status },
      request,
    });

    return Response.json({ ok: true, id, assetNumber });
  } catch (error) {
    return writeFailure(error, "The asset could not be created.");
  }
}

/**
 * One lifecycle event, appended.
 *
 * NEVER an overwrite, which is the whole reason this exists. A site that moves
 * from transformer A to transformer B keeps A here — `previousDetail` holds
 * whatever the operator knew about it — so the answer to "what did we use
 * before" survives the edit that changes `model` on the asset itself. That edit
 * is the caller's own subsequent PATCH; this route deliberately does not make
 * it, because guessing which of fourteen technical fields a replacement changed
 * is how a record ends up with a model that never existed.
 *
 * The two derived fields it DOES write are the ones the event unambiguously
 * establishes: a service sets `lastServicedAt` and rolls the next-due date, and
 * a replacement sets `lastReplacedAt`.
 */
async function recordEvent(
  scope: ScopedDatabase,
  assetIdRaw: string | undefined,
  event: Record<string, unknown>,
  request: Request,
) {
  const { actor, db, orgId, siteScope } = scope;
  const assetId = text(assetIdRaw, 120);
  if (!assetId) invalid("An asset is required to record an event against.");

  const [asset] = await db
    .select()
    .from(units)
    .where(
      and(
        eq(units.id, assetId),
        eq(units.organisationId, orgId),
        isNull(units.deletedAt),
        siteFilter(siteScope),
      ),
    )
    .limit(1);
  if (!asset) return Response.json({ error: "Asset not found." }, { status: 404 });

  const eventType = assetEvent(event.eventType);
  const performedAt = isoDate(event.performedAt) ?? new Date().toISOString().slice(0, 10);
  const contractorId = await assertSupplier(db, orgId, text(event.contractorId, 120));

  const id = `asset-event-${assetId}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  await db.insert(unitServiceRecords).values({
    id,
    organisationId: orgId,
    unitId: assetId,
    siteId: asset.siteId,
    performedAt,
    eventType,
    serviceType: text(event.serviceType, 80) || eventType,
    contractorId,
    contractorName: optionalText(event.contractorName, 160),
    requestId: optionalText(event.requestId, 120),
    outcome: optionalText(event.outcome, 200),
    costPence: costPence(event.cost ?? event.costPence),
    previousDetail: optionalText(event.previousDetail, 600),
    replacementDetail: optionalText(event.replacementDetail, 600),
    notes: optionalText(event.notes, 1000),
    recordedByEmail: actor.email,
  });

  const derived: Record<string, string | null> = {};
  if (eventType === "Serviced") {
    derived.lastServicedAt = performedAt;
    derived.nextServiceDueAt = asset.serviceIntervalMonths
      ? addMonths(performedAt, asset.serviceIntervalMonths)
      : asset.nextServiceDueAt;
  }
  if (eventType === "Replaced") derived.lastReplacedAt = performedAt;

  if (Object.keys(derived).length) {
    await db
      .update(units)
      .set({ ...derived, updatedByEmail: actor.email, updatedAt: new Date().toISOString() })
      .where(and(eq(units.id, assetId), eq(units.organisationId, orgId)));
  }

  await logChange(db, orgId, assetId, `${eventType.toLowerCase()} recorded`, actor.email, {
    performedAt,
    eventType,
  });
  await recordAudit({
    db,
    organisationId: orgId,
    actor: auditActor(scope),
    action: eventType === "Replaced" ? "asset.replacement_recorded" : "asset.event_recorded",
    entityType: "asset",
    entityId: assetId,
    summary: `${eventType} recorded against ${asset.assetNumber ?? asset.name} on ${performedAt}.`,
    detail: {
      eventType,
      performedAt,
      previousDetail: optionalText(event.previousDetail, 600),
      replacementDetail: optionalText(event.replacementDetail, 600),
    },
    request,
  });

  return Response.json({ ok: true, id });
}

/* ── PATCH ────────────────────────────────────────────────────────────────── */

export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "sites.edit");
    if (guard.denied) return guard.denied;
    const { actor, db, orgId, siteScope } = guard.scope;
    const body = (await request.json()) as { id?: string; data?: Record<string, unknown> };
    const id = text(body.id, 120);
    if (!id) invalid("An asset id is required.");

    /*
     * LOOK BEFORE WRITING. An UPDATE whose WHERE clause matches nothing is a
     * successful UPDATE, so without this an unknown id — or another tenant's —
     * was answered 200 and the caller was told an edit happened to a row that
     * was never touched.
     */
    const [current] = await db
      .select()
      .from(units)
      .where(
        and(
          eq(units.id, id),
          eq(units.organisationId, orgId),
          isNull(units.deletedAt),
          siteFilter(siteScope),
        ),
      )
      .limit(1);
    if (!current) return Response.json({ error: "Asset not found." }, { status: 404 });

    const data = body.data ?? {};
    const payload = assetPayload(data);

    /*
     * AN ABSENT KEY MEANS UNCHANGED. See `PAYLOAD_SOURCES` for the two defects
     * that came of the previous whole-record replace. `name` is required only
     * when the caller is actually setting it — a request that never mentions
     * the name is not a request to clear it.
     */
    const changes = pickGiven(payload, data);
    if (given(data, "name") && !payload.name) invalid("Give the asset a name.");

    const siteId = given(data, "siteId")
      ? await assertSite(db, orgId, siteScope, text(data.siteId, 120))
      : current.siteId;
    const category = given(data, "category")
      ? await validateOption(db, orgId, "unit_category", payload.category)
      : current.category;
    const status = given(data, "status")
      ? await validateOption(db, orgId, "unit_status", payload.status)
      : current.status;

    if (given(data, "supplierContractorId")) {
      changes.supplierContractorId = await assertSupplier(
        db,
        orgId,
        text(data.supplierContractorId, 120),
      );
    }
    if (given(data, "parentUnitId")) {
      changes.parentUnitId = await assertParent(
        db,
        orgId,
        id,
        text(data.parentUnitId, 120),
        siteId,
      );
    }

    /*
     * A primary image has to be one of THIS asset's own files.
     *
     * Without the check the column is an arbitrary attachment id, and a caller
     * could point a row's thumbnail at any document in the workspace — a
     * contractor's insurance certificate, another site's drawing — which the
     * register would then render inline to everyone who can see the asset.
     */
    if (given(data, "primaryImageId")) {
      changes.primaryImageId = await assertPrimaryImage(
        db,
        orgId,
        id,
        text(data.primaryImageId, 120),
      );
    }

    /*
     * THE NEXT SERVICE DATE IS DERIVED, NOT TYPED, so it is only recomputed
     * when one of the two facts behind it actually moved. The edit form does
     * not carry this field at all — a service event sets it — and a form save
     * that recomputed it from an absent `lastServicedAt` would clear the date
     * the product had just worked out for itself.
     */
    if (given(data, "lastServicedAt") || given(data, "serviceIntervalMonths")) {
      const servicedAt = given(data, "lastServicedAt")
        ? payload.lastServicedAt
        : current.lastServicedAt;
      const interval = given(data, "serviceIntervalMonths")
        ? payload.serviceIntervalMonths
        : current.serviceIntervalMonths;
      if (servicedAt && interval) changes.nextServiceDueAt = addMonths(servicedAt, interval);
    }
    if (given(data, "nextServiceDueAt")) {
      changes.nextServiceDueAt = isoDate(data.nextServiceDueAt);
    }

    await db
      .update(units)
      .set({
        ...changes,
        siteId,
        category,
        status,
        updatedByEmail: actor.email,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(units.id, id), eq(units.organisationId, orgId)));

    /*
     * A status change is its own history entry, so the register can answer
     * "when did this become a replacement job" without a diff of the audit log.
     * Only on an actual change — re-saving a form must not invent an event.
     */
    if (status && status !== current.status) {
      await db.insert(unitServiceRecords).values({
        id: `asset-event-${id}-${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 8)}`,
        organisationId: orgId,
        unitId: id,
        siteId,
        performedAt: new Date().toISOString().slice(0, 10),
        eventType: "Status changed",
        serviceType: "Status changed",
        previousDetail: current.status,
        replacementDetail: status,
        recordedByEmail: actor.email,
      });
    }

    await logChange(db, orgId, id, "updated", actor.email, {
      name: changes.name ?? current.name,
      changed: Object.keys(changes),
    });
    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor(guard.scope),
      action: status !== current.status ? "asset.status_changed" : "asset.updated",
      entityType: "asset",
      entityId: id,
      summary:
        status !== current.status
          ? `Asset ${current.assetNumber ?? current.name} moved from ${current.status} to ${status}.`
          : `Updated asset ${current.assetNumber ?? current.name}.`,
      detail: { name: changes.name ?? current.name, siteId, status, category },
      request,
    });

    return Response.json({ ok: true, id });
  } catch (error) {
    return writeFailure(error, "The asset could not be updated.");
  }
}

async function assertPrimaryImage(db: Db, orgId: string, assetId: string, fileId: string) {
  if (!fileId) return null;
  const [row] = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(
      and(
        eq(attachments.id, fileId),
        eq(attachments.organisationId, orgId),
        eq(attachments.unitId, assetId),
      ),
    )
    .limit(1);
  if (!row) invalid("That image is not one of this asset's files.");
  return row.id;
}

/* ── DELETE — to the recycle bin, never out of existence ──────────────────── */

/**
 * The asset leaves the register and keeps everything.
 *
 * `sites.edit` rather than `data.delete`, deliberately: this is the reversible
 * verb. The row, its history and its files all survive — that is what makes
 * `POST /api/trash` able to put it back — and the irreversible one lives behind
 * `data.delete` on the bin, which is where every other entity's permanent
 * delete already is. An `admin` does not hold `data.delete` by default, so the
 * destructive half stays shut until an owner opens it.
 *
 * Children are NOT cascaded. A cabinet in the bin leaves its four components on
 * the register pointing at a parent they cannot see, which reads as "no parent"
 * and restores exactly when the cabinet does. Destroying them would be a
 * cascade nobody asked for behind a button labelled Delete.
 */
export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "sites.edit");
    if (guard.denied) return guard.denied;
    const { actor, db, orgId, siteScope } = guard.scope;
    const body = (await request.json()) as { id?: string };
    const id = text(body.id, 120);
    if (!id) invalid("An asset id is required.");

    const [current] = await db
      .select({ id: units.id, name: units.name, assetNumber: units.assetNumber })
      .from(units)
      .where(
        and(
          eq(units.id, id),
          eq(units.organisationId, orgId),
          isNull(units.deletedAt),
          siteFilter(siteScope),
        ),
      )
      .limit(1);
    if (!current) return Response.json({ error: "Asset not found." }, { status: 404 });

    await sendAssetToBin(
      db,
      orgId,
      { email: actor.email, displayName: actor.displayName },
      id,
    );

    await logChange(db, orgId, id, "moved to the recycle bin", actor.email, {});
    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor(guard.scope),
      action: "asset.archived",
      entityType: "asset",
      entityId: id,
      summary: `Moved asset ${current.assetNumber ?? current.name} to the recycle bin.`,
      request,
    });

    return Response.json({ ok: true, id });
  } catch (error) {
    return writeFailure(error, "The asset could not be removed.");
  }
}

/* ── Failure classification ───────────────────────────────────────────────── */

/**
 * A refusal the caller can act on, or a failure that is ours.
 *
 * `InvalidAsset` carries a sentence written for the person at the form and is
 * answered 400. Anything else is 503 with a fixed sentence — never
 * `error.message`, which is how a schema detail once reached a production
 * response from the sites route.
 */
function writeFailure(error: unknown, fallback: string): Response {
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  const busy = busyRefusal(error, fallback);
  if (busy) return busy;
  if (error instanceof InvalidAsset) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  console.error("assets write failed", error);
  return Response.json({ error: fallback }, { status: 503 });
}
