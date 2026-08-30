import { and, count, desc, eq, isNull } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import {
  activityLog,
  attachments,
  complianceDocuments,
  maintenanceRequests,
  siteGroupMembers,
  sites,
  units,
} from "../../../db/schema";
import { anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../lib/tenant-db";
import { listOptionValues } from "../../lib/options-repository";
import {
  cleanAddress,
  codeConflict,
  composeAddress,
  existingSiteCodes,
  findDuplicateCandidates,
  addSiteAlias,
  generateSiteCode,
  getSite,
  junkReason,
  listAliases,
  listSiteGroups,
  listSites,
  mirrorAddress,
  nameConflict,
  nextSitePosition,
  recordAnomaly,
  releaseSiteAlias,
  setSiteAliases,
  setSiteGroupMembership,
  uniqueSlug,
} from "../../lib/sites-repository";

/**
 * What a reader is told when Sites cannot load, and what a developer is told.
 *
 * THE BUG THIS REPLACES. The catch returned `error.message` verbatim, and the
 * Sites screen renders that string. Drizzle's wrapper message is the whole
 * failing statement, so a transient database fault painted this across the top
 * of the page:
 *
 *   Failed query: select "id", "name", "slug", "logo_url", … from
 *   "organisations" where "organisations"."status" = ?  params: active
 *
 * Two separate faults, both fixed here:
 *
 *  1. IT WAS UNDIAGNOSABLE. `DrizzleQueryError.message` is only ever the SQL;
 *     the REAL reason — "no such table", an I/O fault, a closed connection —
 *     is on `error.cause`, and reading `.message` alone threw it away. So the
 *     message named a query that is provably correct (the `organisations` DDL
 *     matches the model in every source, and that statement runs clean against
 *     the live database) while saying nothing about what actually failed. The
 *     cause is now unwrapped and included in development.
 *
 *  2. IT PUBLISHED THE SCHEMA. Column names and table names went to whoever
 *     opened the page, including an unauthenticated visitor on a shared link.
 *     Raw text is development-only now, matching `databaseError` in
 *     /api/maintenance, which is the house pattern for exactly this.
 *
 * The bootstrap case is called out separately because it is the one a reader
 * can act on: it resolves by itself, and "retry in a moment" is true advice.
 */
function sitesDatabaseError(error: unknown) {
  const top = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const combined = `${top} ${cause}`.trim();

  if (process.env.NODE_ENV === "development") {
    return cause ? `Sites database error: ${cause} — while running: ${top}` : `Sites database error: ${top}`;
  }
  if (combined.includes("no such table") || combined.includes("no such column")) {
    return "The workspace database is being prepared. Please retry in a moment.";
  }
  return "Sites are temporarily unavailable.";
}

/**
 * A refusal of the caller's input, marked as one.
 *
 * `siteWriteFailure` decides between "your input was wrong" (400) and "the
 * database is unwell" (503) by reading the error's message. That works until a
 * refusal QUOTES the caller, which this one does:
 *
 *   "no such table" is not a configured site type. Add it in Settings first.
 *
 * A site type typed as `no such table`, `SQLITE_BUSY` or `too many clients`
 * therefore came back as "the workspace database is being prepared, retry in a
 * moment" — measured live, nine times. The user is told to wait for a fault
 * that never happened, and never learns which field they got wrong.
 *
 * Matching harder would not fix it: the fault words are genuinely in the
 * string, because the caller put them there. So the answer is not to guess from
 * the text at all, but to say what the error IS at the point it is raised.
 *
 * ANY refusal that interpolates caller-supplied text must be thrown as this
 * class. Refusals that name only fixed text ("A site name is required.") are
 * safe as plain Errors and are left alone.
 */
export class SiteInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteInputError";
  }
}

/**
 * A database fault that never went through Drizzle, and so has neither the
 * `Failed query:` prefix nor an `Error` cause to recognise it by.
 *
 * The first version of `siteWriteFailure` tested only those two marks, and QA
 * showed six real shapes walking straight past it and answering 400 with their
 * raw text in production:
 *
 *   D1_ERROR: no such table: sites
 *   D1_ERROR: UNIQUE constraint failed: site_aliases.organisation_id, …
 *   no such column: sites.annual_budget_pence
 *   connect ECONNREFUSED 10.12.4.7:5432
 *   sorry, too many clients already
 *   password authentication failed for user "portal_writer"
 *
 * They are reachable, not hypothetical. `ensureDatabase()` is the FIRST
 * statement inside the try of every write verb here and `db/init.ts` runs its
 * DDL through 249 raw `.prepare()` calls that Drizzle never sees; a connection
 * failure is thrown before there is a query to wrap at all; and the session
 * pooler's client cap makes "too many clients" an ordinary Tuesday.
 *
 * It also fixed a hole of its own making: `sitesDatabaseError` has a branch
 * for "no such table"/"no such column" that answers "the workspace database is
 * being prepared, retry in a moment" — and the narrow classifier rejected
 * exactly those errors before they could reach the helper written for them.
 *
 * WIDENING THE RECOGNISER, NOT THE SUPPRESSION, is the point. None of the
 * twenty-one messages these routes and their helpers throw matches this
 * pattern, so every one of them still reaches the caller unchanged at 400.
 *
 * The last two alternatives are belt and braces. A constraint violation
 * normally arrives either Drizzle-wrapped or `D1_ERROR:`-prefixed and is
 * already caught above, and no real path producing a bare unmarked one could be
 * constructed — only a synthetic one. They cost nothing and close the shape.
 * `codeCollision` is deliberately tested BEFORE this, so a duplicate site code
 * still answers 409 rather than being reported as an outage.
 */
const DATABASE_FAULT =
  /^D1_ERROR|no such (table|column)|database is locked|SQLITE_|ECONNREFUSED|ETIMEDOUT|too many clients|authentication failed|UNIQUE constraint failed|duplicate key/i;

/**
 * The same protection, for the verbs that WRITE.
 *
 * `sitesDatabaseError` above was written for exactly this leak and then wired
 * into one catch — the GET. POST, PATCH and DELETE here, all four verbs in
 * `groups/route.ts` and both in `csv/route.ts` still answered with
 * `error.message` verbatim, which for a Drizzle fault IS the failing
 * statement. Captured from the running app before this change:
 *
 *   400 {"error":"Failed query: update \"sites\" set \"name\" = ?, \"type\" = ?,
 *        \"region\" = ?, …"}
 *
 * so the schema went to the caller on eleven paths instead of one, and in
 * production rather than only in development.
 *
 * The status was wrong as well. A database outage was reported as 400, which
 * tells the caller their input was bad and invites them to edit a form that
 * was never the problem; it is 503, the same answer the GET already gives.
 *
 * VALIDATION IS LEFT ALONE, and this narrows to the database fault rather than
 * the other way round for a concrete reason. These routes refuse bad input by
 * THROWING — "A site name is required.", "A first line of address is required.",
 * `"<x>" is not a configured site type. Add it in Settings first.` and eleven
 * others, plus whatever `junkReason` returns. All fifteen land in these same
 * catches. Suppressing unrecognised messages in production would therefore
 * replace every one of them with "The site could not be created.", and a form
 * that cannot say which field is wrong is worse than the leak this closes.
 *
 * So only a fault that IS the database is converted. Drizzle prefixes its
 * wrapper `Failed query:` and carries the real reason on `.cause`; a validation
 * `new Error("A site name is required.")` has neither, and passes through at
 * 400 exactly as before. What is left exposed is the message of some other
 * unexpected error, which contains no statement and no bound parameters — the
 * two things Part 16 names.
 */
/**
 * The site-code unique index, refused in the caller's language.
 *
 * `codeConflict()` catches this before the write in every path that calls it,
 * so reaching here means the check could not: two concurrent creates that both
 * passed their SELECT, or an importer that never asked. The index is what
 * actually holds the invariant, and its refusal is a CONFLICT about the value
 * the caller sent — not the outage `DATABASE_FAULT` would otherwise report it
 * as, since "UNIQUE constraint failed" matches that pattern too. This is tested
 * first for exactly that reason.
 *
 * The two engines word it differently: SQLite names the columns, Postgres names
 * the index. Both are matched rather than assuming the deployment target.
 */
function codeCollision(error: unknown) {
  const text =
    error instanceof Error
      ? `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`
      : String(error);
  return (
    text.includes("sites_organisation_code_idx") ||
    (/UNIQUE constraint failed/i.test(text) && /sites\.code/i.test(text))
  );
}

export function siteWriteFailure(error: unknown, fallback: string) {
  // Asked before anything reads the message, because this is the one refusal
  // whose text is partly the caller's own and so can contain a fault word.
  if (error instanceof SiteInputError) {
    return { message: error.message, status: 400 as const };
  }

  if (codeCollision(error)) {
    return {
      message: "Another site already uses that code.",
      status: 409 as const,
    };
  }

  const databaseFault =
    error instanceof Error &&
    (error.message.startsWith("Failed query:") ||
      error.cause instanceof Error ||
      DATABASE_FAULT.test(error.message));

  if (databaseFault) {
    return { message: sitesDatabaseError(error), status: 503 as const };
  }

  return {
    message: error instanceof Error && error.message ? error.message : fallback,
    status: 400 as const,
  };
}

function text(value: unknown, max = 240) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function optionalText(value: unknown, max = 240) {
  const result = text(value, max);
  return result.length ? result : null;
}

function optionalNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Money is stored as integer pence. A float here loses a penny per rounding. */
function pence(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}

/**
 * Pounds in, or pence in — but only ONE of them is multiplied.
 *
 * THE BUG THIS FIXES. Both keys were funnelled through `pence()`, which
 * multiplies by 100, so a value that already arrived in pence was multiplied
 * again. `PATCH { serviceChargePence: 123456 }` stored 12345600, and because
 * `GET` returns the column as `serviceChargePence`, an ordinary read-edit-save
 * of an untouched form multiplied the figure by a hundred every single time.
 * `annualBudgetPence` had it too. Both keys are advertised in
 * `PAYLOAD_SOURCES`, so both were reachable.
 *
 * The two names mean different units and now behave that way: `serviceCharge`
 * is pounds and is scaled, `serviceChargePence` is already the stored integer
 * and is only rounded. Pounds keeps precedence, as before.
 */
function moneyPence(pounds: unknown, pennies: unknown) {
  if (pounds !== undefined && pounds !== null) return pence(pounds);
  if (pennies === undefined || pennies === null || pennies === "") return null;
  const parsed = Number(pennies);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/[,;\n]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function newId(name: string) {
  const stem = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `site-${stem || "record"}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Values are validated against the option tables rather than a union type, so
 * an admin can add a fifth site type without a deploy. An unrecognised value is
 * rejected with the permitted list rather than silently coerced.
 */
async function validateOption(
  db: Awaited<ReturnType<typeof scopedDb>>["db"],
  orgId: string,
  key: string,
  candidate: string,
  required: boolean,
) {
  const values = await listOptionValues(db, orgId, key);
  const active = values.filter((entry) => entry.active);
  if (!candidate) {
    if (!required) return "";
    const fallback = active.find((entry) => entry.isDefault) ?? active[0];
    if (!fallback) throw new Error(`No ${key} options are configured for this workspace.`);
    return fallback.value;
  }
  const match = values.find((entry) => entry.value === candidate);
  if (!match) {
    throw new SiteInputError(
      `"${candidate}" is not a configured ${key.replace(/_/g, " ")}. Add it in Settings first.`,
    );
  }
  return match.value;
}

function sitePayload(data: Record<string, unknown>) {
  return {
    name: text(data.name, 120),
    code: optionalText(data.code, 40),
    siteTypeValue: text(data.siteTypeValue ?? data.type, 60),
    status: text(data.status, 40),
    addressLine1: text(data.addressLine1 ?? data.address, 300),
    addressLine2: optionalText(data.addressLine2, 300),
    city: optionalText(data.city, 120),
    postcode: optionalText(data.postcode, 20),
    country: text(data.country, 80) || "United Kingdom",
    latitude: optionalNumber(data.latitude),
    longitude: optionalNumber(data.longitude),
    region: text(data.region, 60) || "UK",
    managerName: optionalText(data.managerName ?? data.manager, 120),
    managerPhone: optionalText(data.managerPhone, 60),
    managerEmail: optionalText(data.managerEmail, 160),
    landlord: optionalText(data.landlord, 160),
    managingAgent: optionalText(data.managingAgent, 160),
    outOfHoursContact: optionalText(data.outOfHoursContact, 160),
    accessMethod: optionalText(data.accessMethod, 80),
    accessContact: optionalText(data.accessContact, 200),
    accessUrl: optionalText(data.accessUrl, 400),
    accessNotes: optionalText(data.accessNotes, 1000),
    openingHours: optionalText(data.openingHours, 400),
    deliveryRestrictions: optionalText(data.deliveryRestrictions, 400),
    parkingNotes: optionalText(data.parkingNotes, 400),
    keyAlarmNotes: optionalText(data.keyAlarmNotes, 400),
    leaseStart: optionalText(data.leaseStart, 20),
    leaseEnd: optionalText(data.leaseEnd, 20),
    breakClause: optionalText(data.breakClause, 200),
    rentReview: optionalText(data.rentReview, 200),
    serviceChargePence: moneyPence(data.serviceCharge, data.serviceChargePence),
    annualBudgetPence: moneyPence(data.annualBudget, data.annualBudgetPence),
    mondayMaintenanceName: optionalText(data.mondayMaintenanceName, 160),
    mondayComplianceName: optionalText(data.mondayComplianceName, 160),
    notes: optionalText(data.notes, 2000),
  };
}

type SitePayload = ReturnType<typeof sitePayload>;

/**
 * Which request keys each stored column may arrive under.
 *
 * This is a restatement of the `??` chains in `sitePayload` above and it has to
 * be kept beside them: adding a column there and forgetting it here means an
 * edit can no longer reach that column. The two are one table read twice, and
 * the compiler holds the shape — `Record<keyof SitePayload, …>` fails to build
 * the moment `sitePayload` gains a key this does not name.
 */
const PAYLOAD_SOURCES: Record<keyof SitePayload, readonly string[]> = {
  name: ["name"],
  code: ["code"],
  siteTypeValue: ["siteTypeValue", "type"],
  status: ["status"],
  addressLine1: ["addressLine1", "address"],
  addressLine2: ["addressLine2"],
  city: ["city"],
  postcode: ["postcode"],
  country: ["country"],
  latitude: ["latitude"],
  longitude: ["longitude"],
  region: ["region"],
  managerName: ["managerName", "manager"],
  managerPhone: ["managerPhone"],
  managerEmail: ["managerEmail"],
  landlord: ["landlord"],
  managingAgent: ["managingAgent"],
  outOfHoursContact: ["outOfHoursContact"],
  accessMethod: ["accessMethod"],
  accessContact: ["accessContact"],
  accessUrl: ["accessUrl"],
  accessNotes: ["accessNotes"],
  openingHours: ["openingHours"],
  deliveryRestrictions: ["deliveryRestrictions"],
  parkingNotes: ["parkingNotes"],
  keyAlarmNotes: ["keyAlarmNotes"],
  leaseStart: ["leaseStart"],
  leaseEnd: ["leaseEnd"],
  breakClause: ["breakClause"],
  rentReview: ["rentReview"],
  serviceChargePence: ["serviceCharge", "serviceChargePence"],
  annualBudgetPence: ["annualBudget", "annualBudgetPence"],
  mondayMaintenanceName: ["mondayMaintenanceName"],
  mondayComplianceName: ["mondayComplianceName"],
  notes: ["notes"],
};

/**
 * AN EDIT MAY ONLY CHANGE WHAT IT CARRIED.
 *
 * THE BUG THIS FIXES, stated plainly because it was silently destroying data on
 * real sites. `sitePayload` builds EVERY column from the request body, and the
 * builders answer a missing key the same way they answer a cleared one:
 * `optionalText(undefined)` is `null`, `optionalNumber(undefined)` is `null`,
 * and `text(undefined, 60) || "UK"` is the literal `"UK"`. PATCH then wrote the
 * whole object. So a column the editor does not render was not "left alone" —
 * it was overwritten with the default on every save.
 *
 * Three columns were being hit. `region` reverted to "UK" — the Sites form has
 * never had a region field, so opening any site outside the default region and
 * pressing Save quietly relabelled it. `latitude` and `longitude` were nulled,
 * and unlike a name nobody notices coordinates going missing until a map is
 * empty. The comment on the rename branch below says the full-payload path is
 * "right for the Sites form (it sends everything)"; the form does not send
 * everything, and this closes the gap between that sentence and the code.
 *
 * ABSENT AND CLEARED STAY DIFFERENT, which is the whole discipline. A key the
 * caller did not send at all (`undefined`) keeps what is stored. A key sent as
 * `""` or `null` is somebody emptying a field on purpose and still clears it,
 * exactly as before — otherwise a user could never delete a postcode.
 *
 * POST is untouched. A new row has nothing to preserve, and the defaults are
 * correct there.
 */
function preserveUnsent<Row extends Record<string, unknown>>(
  payload: SitePayload,
  data: Record<string, unknown>,
  existing: Row,
): { [K in keyof SitePayload]: SitePayload[K] | (K extends keyof Row ? Row[K] : never) } {
  const merged = { ...payload } as Record<string, unknown>;
  for (const [column, sources] of Object.entries(PAYLOAD_SOURCES)) {
    if (sources.some((source) => data[source] !== undefined)) continue;
    merged[column] = existing[column];
  }
  /*
   * The return type is the UNION of what the builders produce and what the row
   * holds, rather than `SitePayload`, because those differ where a column is
   * nullable in storage but non-null out of `text()` — `address_line1` and
   * `site_type_value` both are. Typing this as `SitePayload` would have been
   * one cast and would have hidden exactly the two nulls the callers below now
   * have to answer for.
   */
  return merged as { [K in keyof SitePayload]: SitePayload[K] | (K extends keyof Row ? Row[K] : never) };
}

/**
 * Every requested reporting group must be one THIS organisation owns.
 *
 * THE BUG THIS FIXES. `setSiteGroupMembership` clears the site's membership
 * first and then re-inserts only the groups the organisation owns, so a group
 * id belonging to another tenant — or one that exists nowhere — was DROPPED in
 * silence while the route answered `{ok:true}`. The caller was told the
 * assignment had been made; what had actually happened was that the site's real
 * groups were deleted and nothing put back.
 *
 * Checked BEFORE anything is written, so a bad id costs nothing rather than
 * costing the memberships the site already had. Answering an unknown id and
 * another tenant's id identically is deliberate — the same rule the board's
 * create route follows for `site_id` — so a 404 cannot be used to confirm that
 * an id is real.
 */
async function unknownGroupRefusal(
  db: Awaited<ReturnType<typeof scopedDb>>["db"],
  orgId: string,
  requested: string[],
) {
  if (!requested.length) return null;
  const owned = new Set((await listSiteGroups(db, orgId)).map((group) => group.id));
  const missing = requested.filter((groupId) => !owned.has(groupId));
  if (!missing.length) return null;
  return Response.json({ error: "Group not found." }, { status: 404 });
}

async function logChange(
  db: Awaited<ReturnType<typeof scopedDb>>["db"],
  orgId: string,
  siteId: string,
  action: string,
  actorEmail: string,
  detail: Record<string, unknown>,
) {
  await db.insert(activityLog).values({
    /*
     * A RANDOM SUFFIX, because the timestamp alone is not unique.
     *
     * `Date.now()` has millisecond resolution, so two saves of the SAME site
     * inside one millisecond built the same primary key and the second insert
     * failed on it. Under 144 concurrent PATCHes, 113 failed this way.
     *
     * The damage was not a missing audit line. The site UPDATE runs BEFORE
     * this insert, so the row was already written when the audit failed and
     * the request then answered as an error: measured at 12 concurrent saves,
     * 8 were reported FAILED to the caller and the value left in the row came
     * from one of them. "It failed" has to mean nothing happened, and here it
     * did not. Same suffix shape as `newId` above.
     *
     * `app/api/units/route.ts:110` builds its audit id the identical way and
     * has the identical defect; it is outside this workstream and unchanged.
     */
    id: `activity-site-${siteId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    organisationId: orgId,
    entityType: "site",
    entityId: siteId,
    action,
    actorEmail,
    detail: JSON.stringify(detail).slice(0, 4000),
  });
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const { db, orgId } = await scopedDb(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    if (id) {
      const site = await getSite(db, orgId, id);
      if (!site) return Response.json({ error: "Site not found." }, { status: 404 });
      const [jobs, assets, documents, groups, files, activity] = await Promise.all([
        db
          .select()
          .from(maintenanceRequests)
          .where(
            and(
              eq(maintenanceRequests.organisationId, orgId),
              eq(maintenanceRequests.siteId, id),
              // Stage 23 — a site's job history excludes anything in the bin.
              isNull(maintenanceRequests.deletedAt),
            ),
          )
          .orderBy(desc(maintenanceRequests.requestedAt))
          .limit(200),
        db
          .select()
          .from(units)
          .where(and(eq(units.organisationId, orgId), eq(units.siteId, id))),
        db
          .select()
          .from(complianceDocuments)
          .where(
            and(
              eq(complianceDocuments.organisationId, orgId),
              eq(complianceDocuments.siteId, id),
            ),
          ),
        db
          .select({ siteGroupId: siteGroupMembers.siteGroupId })
          .from(siteGroupMembers)
          .where(
            and(
              eq(siteGroupMembers.organisationId, orgId),
              eq(siteGroupMembers.siteId, id),
            ),
          ),
        db
          .select()
          .from(attachments)
          .where(and(eq(attachments.organisationId, orgId), eq(attachments.siteId, id)))
          .orderBy(desc(attachments.createdAt))
          .limit(200),
        db
          .select()
          .from(activityLog)
          .where(
            and(
              eq(activityLog.organisationId, orgId),
              eq(activityLog.entityType, "site"),
              eq(activityLog.entityId, id),
            ),
          )
          .orderBy(desc(activityLog.createdAt))
          .limit(100),
      ]);
      return Response.json({
        site,
        jobs,
        jobCount: jobs.length,
        units: assets,
        compliance: documents,
        files,
        activity,
        groupIds: groups.map((entry) => entry.siteGroupId),
      });
    }

    const [rows, groups, siteTypes, statuses, aliases] = await Promise.all([
      listSites(db, orgId, { includeInactive: true }),
      listSiteGroups(db, orgId),
      listOptionValues(db, orgId, "site_type"),
      listOptionValues(db, orgId, "site_status"),
      listAliases(db, orgId),
    ]);

    /*
     * Every name a site also answers to, sent with the site.
     *
     * The register's search advertised "name, code, postcode or monday name"
     * and matched none of the former names the alias table exists to hold, so
     * searching "Cardiff St Davids" — a name this business used, and the exact
     * case the rename machinery was built for — found nothing. The screen was
     * not at fault: the payload simply had no aliases in it to match against.
     *
     * Grouped here rather than fetched per row: `listAliases` is one query for
     * the whole organisation, and the register is read whole anyway.
     *
     * The array can repeat a monday name, because `setSiteAliases` records
     * those as alias rows too. That is harmless — the search matches the same
     * site either way — and filtering them out would mean deciding which of two
     * identical strings is the "real" one.
     */
    const aliasesBySite = new Map<string, string[]>();
    for (const alias of aliases) {
      const list = aliasesBySite.get(alias.siteId);
      if (list) list.push(alias.alias);
      else aliasesBySite.set(alias.siteId, [alias.alias]);
    }

    return Response.json({
      sites: rows.map((row) => ({ ...row, aliases: aliasesBySite.get(row.id) ?? [] })),
      groups,
      siteTypes,
      statuses,
    });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json({ error: sitesDatabaseError(error) }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "sites.edit");
    if (guard.denied) return guard.denied;
    const { actor, db, orgId } = guard.scope;
    const body = (await request.json()) as {
      data?: Record<string, unknown>;
      confirmDuplicate?: boolean;
    };
    const payload = sitePayload(body.data ?? {});

    if (!payload.name) throw new Error("A site name is required.");
    const address = cleanAddress(payload.addressLine1);
    if (!address.value) throw new Error("A first line of address is required.");

    const junk = junkReason(payload.name, address.value);
    if (junk) throw new Error(junk);

    const badGroup = await unknownGroupRefusal(db, orgId, stringList(body.data?.groupIds));
    if (badGroup) return badGroup;

    // X6 — warn, do not block. Two centres can legitimately share a name.
    const duplicates = await findDuplicateCandidates(db, orgId, payload.name);
    if (duplicates.length && !body.confirmDuplicate) {
      return Response.json(
        {
          error: "A similar site already exists.",
          requiresConfirmation: true,
          duplicates,
        },
        { status: 409 },
      );
    }

    const siteTypeValue = await validateOption(db, orgId, "site_type", payload.siteTypeValue, true);
    const status = await validateOption(db, orgId, "site_status", payload.status, true);

    const id = newId(payload.name);
    const slug = await uniqueSlug(db, orgId, payload.name);
    // The owner has no existing store-code convention, so one is generated and
    // stored. It stays editable afterwards like any other field.
    /*
     * A code the CALLER supplied is checked; a generated one does not need to
     * be, because `generateSiteCode` is already handed the existing codes and
     * picks around them. Two sites answering to one code make
     * `resolveSiteByName` non-deterministic — see `codeConflict`.
     */
    if (payload.code) {
      const clash = await codeConflict(db, orgId, payload.code, id);
      if (clash) {
        return Response.json(
          { error: `Another site already uses the code "${payload.code}".`, conflictSiteId: clash },
          { status: 409 },
        );
      }
    }
    const code = payload.code ?? generateSiteCode(payload.name, await existingSiteCodes(db, orgId));
    const position = await nextSitePosition(db, orgId);

    await db.insert(sites).values({
      id,
      organisationId: orgId,
      ...payload,
      code,
      addressLine1: address.value,
      siteTypeValue,
      status,
      slug,
      position,
      active: status !== "closed",
      // The Stage 0 columns are kept in step until Stage 3 retires them, so
      // screens that still read `type`, `lifecycle` and `address` keep working.
      type: siteTypeValue,
      lifecycle: status === "closed" ? "Closed" : "Current",
      // A new row has nothing stored to lose, so the composite is built
      // outright — but still without repeating a part the first line already
      // carries. See `composeAddress`.
      address: composeAddress({
        addressLine1: address.value,
        addressLine2: payload.addressLine2,
        city: payload.city,
        postcode: payload.postcode,
      }),
      manager: payload.managerName,
    });

    if (address.changed) {
      await recordAnomaly(db, orgId, {
        batchId: "manual-entry",
        entityType: "site",
        entityId: id,
        sourceName: payload.name,
        kind: "address_cleaned",
        field: "address_line1",
        originalValue: payload.addressLine1,
        appliedValue: address.value,
        detail: "Stray quotation marks were removed from the address.",
      });
    }

    const aliasWrite = await setSiteAliases(db, orgId, id, [
      ...stringList(body.data?.aliases),
      ...(payload.mondayMaintenanceName ? [payload.mondayMaintenanceName] : []),
      ...(payload.mondayComplianceName ? [payload.mondayComplianceName] : []),
    ]);
    await setSiteGroupMembership(db, orgId, id, stringList(body.data?.groupIds));
    await logChange(db, orgId, id, "created", actor.email, { name: payload.name });

    // A name another site already answers to is not recorded. Saying so is the
    // difference between an alias that is missing and an alias nobody knows is
    // missing — see `setSiteAliases`.
    return Response.json({
      ok: true,
      id,
      ...(aliasWrite.refused.length ? { aliasConflicts: aliasWrite.refused } : {}),
    });
  } catch (error) {
    const failure = siteWriteFailure(error, "The site could not be created.");
    return Response.json({ error: failure.message }, { status: failure.status });
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "sites.edit");
    if (guard.denied) return guard.denied;
    const { actor, db, orgId } = guard.scope;
    const body = (await request.json()) as {
      id?: string;
      data?: Record<string, unknown>;
      confirmDuplicate?: boolean;
      rename?: unknown;
    };
    const id = text(body.id, 120);
    if (!id) throw new Error("A site ID is required.");

    const existing = await getSite(db, orgId, id);
    if (!existing) return Response.json({ error: "Site not found." }, { status: 404 });

    if (body.data?.groupIds !== undefined) {
      const badGroup = await unknownGroupRefusal(db, orgId, stringList(body.data.groupIds));
      if (badGroup) return badGroup;
    }

    /*
     * A NAME-ONLY rename, for callers that hold the site's identity and
     * nothing else — the form builder's Location editor. The full-payload
     * branch below rewrites every field with whatever was sent, which is right
     * for the Sites form (it sends everything) and destructive for anyone
     * else: a rename that had to travel as a full payload would null the
     * thirty fields the caller did not have. Same duplicate check, same
     * slug refresh, same audit trail; jobs and compliance rows reference the
     * site by ID, so nothing else needs rewriting.
     */
    if (typeof body.rename === "string") {
      const nextName = text(body.rename, 120);
      if (!nextName) throw new Error("A site name is required.");
      if (nextName !== existing.name) {
        /*
         * A name that already resolves elsewhere cannot be taken.
         * `findDuplicateCandidates` only warns, and only about site names; an
         * ALIAS pointing at another site is a hard conflict, because
         * `site_aliases` is uniquely indexed on (organisation_id, normalised)
         * and the alias insert below would be rejected — leaving the rename
         * applied and its history lost.
         */
        const conflict = await nameConflict(db, orgId, nextName, id);
        if (conflict?.kind === "alias") {
          return Response.json(
            {
              error:
                "That name is already recorded as a former name of another site. Remove it there first.",
              conflictSiteId: conflict.siteId,
            },
            { status: 409 },
          );
        }
        const duplicates = await findDuplicateCandidates(db, orgId, nextName, id);
        if (duplicates.length && !body.confirmDuplicate) {
          return Response.json(
            { error: "A similar site already exists.", requiresConfirmation: true, duplicates },
            { status: 409 },
          );
        }
        await db
          .update(sites)
          .set({
            name: nextName,
            slug: await uniqueSlug(db, orgId, nextName, id),
            updatedAt: new Date().toISOString(),
          })
          .where(and(eq(sites.id, id), eq(sites.organisationId, orgId)));

        /*
         * The previous name survives as an organisation-scoped alias, so every
         * job, compliance row and import that recorded the old spelling still
         * resolves. Additive: two renames leave both earlier names resolving.
         * `releaseSiteAlias` runs first because renaming back to a name this
         * site once had must retire it as an alias, rather than leave the
         * register saying one string is both the current name and a historic
         * spelling of it.
         */
        await releaseSiteAlias(db, orgId, id, nextName);
        const recorded = await addSiteAlias(db, orgId, id, existing.name, "rename");

        await logChange(db, orgId, id, "renamed", actor.email, {
          from: existing.name,
          to: nextName,
          aliasRecorded: recorded.ok ? recorded.created : false,
          aliasSkipped: recorded.ok ? null : recorded.reason,
        });
      }
      return Response.json({ ok: true, id, name: nextName });
    }

    const sent = body.data ?? {};
    const payload = preserveUnsent(sitePayload(sent), sent, existing);
    if (!payload.name) throw new Error("A site name is required.");
    // `addressLine1` is nullable in storage even though the form insists on it,
    // and preservation can hand back that null for a caller that sent no
    // address at all. The check two lines down is what still refuses to save.
    const address = cleanAddress(payload.addressLine1 ?? "");
    if (!address.value) throw new Error("A first line of address is required.");

    // Same rule on edit: a code is an identity, and it may not be duplicated.
    if (payload.code && payload.code !== existing.code) {
      const clash = await codeConflict(db, orgId, payload.code, id);
      if (clash) {
        return Response.json(
          { error: `Another site already uses the code "${payload.code}".`, conflictSiteId: clash },
          { status: 409 },
        );
      }
    }

    if (payload.name !== existing.name) {
      // A name another site already answers to by alias is a hard conflict, not
      // a warning — the alias insert below would be rejected by the unique
      // index and the rename would be left half-applied.
      const conflict = await nameConflict(db, orgId, payload.name, id);
      if (conflict?.kind === "alias") {
        return Response.json(
          {
            error:
              "That name is already recorded as a former name of another site. Remove it there first.",
            conflictSiteId: conflict.siteId,
          },
          { status: 409 },
        );
      }
      const duplicates = await findDuplicateCandidates(db, orgId, payload.name, id);
      if (duplicates.length && !body.confirmDuplicate) {
        return Response.json(
          { error: "A similar site already exists.", requiresConfirmation: true, duplicates },
          { status: 409 },
        );
      }
    }

    /*
     * `?? ""` because `site_type_value` is nullable in storage and preservation
     * can hand back that null for a legacy row that never had one. Empty is the
     * "not stated" case `validateOption` already answers, with the workspace's
     * default option rather than a rejection.
     */
    const siteTypeValue = await validateOption(db, orgId, "site_type", payload.siteTypeValue ?? "", true);
    const status = await validateOption(db, orgId, "site_status", payload.status ?? "", true);
    const slug =
      payload.name === existing.name && existing.slug
        ? existing.slug
        : await uniqueSlug(db, orgId, payload.name, id);

    /*
     * THE STAGE 0 TWINS MOVE ONLY WHEN THE THING THEY TWIN MOVES.
     *
     * `lifecycle` and `active` are derived from `status`, and the derivation
     * only knows two answers: 'closed' is Closed/false, everything else is
     * Current/true. `status` also carries 'other' and 'international', which
     * are neither — and the register already holds rows that say so. The three
     * legacy rows on the canonical register are `status='other'` with
     * `lifecycle='Closed'` and `active=false`, recorded that way deliberately
     * because they are unverified and must not be offered as current sites.
     *
     * Re-deriving on every save flattened them. A notes-only PATCH — which
     * sends no status at all, so `preserveUnsent` hands back the stored one —
     * still wrote `active = true` and `lifecycle = 'Current'`, promoting a
     * legacy row into the live register and moving it out of the Closed
     * reporting group, which `seedStoreDocumentationGroups` rebuilds from
     * `lifecycle`. That is the same fault `preserveUnsent` exists to stop, one
     * layer further down: these two columns are not payload fields, so
     * preservation never reached them.
     *
     * So they are rewritten when the status actually changes and left alone
     * when it does not. Closing and reopening still move all three together —
     * see the DELETE verb below, which writes the trio outright. This is the
     * rule `/api/workspace` already applies from the other direction: it too
     * only clears a site that was ACTUALLY closed, because 'international' and
     * 'other' are open states a two-way toggle cannot express.
     */
    const lifecycleState =
      status === existing.status
        ? {}
        : {
            active: status !== "closed",
            lifecycle: status === "closed" ? "Closed" : "Current",
          };

    /*
     * THE STAGE 0 ADDRESS IS REBUILT ONLY WHEN REBUILDING IT LOSES NOTHING.
     *
     * THE BUG THIS FIXES. `address` was rebuilt from address_line1/2 + city +
     * postcode on every save, and the canonical columns do not always hold what
     * the string holds. The monday import read "<unit or mall> - <street>,
     * <city> <postcode>", kept only the part before the " - " as
     * `address_line1` and dropped the street, so on Highcross Leicester and
     * Bullring - Birmingham the street lives ONLY in `address` — and a
     * notes-only save deleted it. The contractor job link builds its map URL
     * from this column, so what was lost was the road an engineer drives to.
     *
     * The rule is general and names no row: `mirrorAddress` holds the stored
     * string whenever the rebuild would drop a word that no canonical address
     * column has ever carried, before this edit or after it. A word the caller
     * is deliberately changing or clearing WAS in a canonical column, so an
     * ordinary address edit still updates the mirror exactly as before.
     */
    const mirror = mirrorAddress(existing.address, existing, {
      addressLine1: address.value,
      addressLine2: payload.addressLine2,
      city: payload.city,
      postcode: payload.postcode,
      country: payload.country,
      region: payload.region,
    });

    await db
      .update(sites)
      .set({
        ...payload,
        addressLine1: address.value,
        siteTypeValue,
        status,
        slug,
        type: siteTypeValue,
        ...lifecycleState,
        address: mirror.value,
        manager: payload.managerName,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(sites.id, id), eq(sites.organisationId, orgId)));

    /*
     * The same rule on the full-payload path. It recorded nothing at all unless
     * the caller happened to send an `aliases` array, so a rename from the Sites
     * form lost the old name while the identical rename from the Location editor
     * kept it. The alias comes from the rename itself, never from a field the
     * caller may not have sent — and it runs BEFORE `setSiteAliases` so the
     * hand-typed list ("manual") and this row ("rename") occupy different slots
     * and cannot delete one another.
     */
    if (payload.name !== existing.name) {
      await releaseSiteAlias(db, orgId, id, payload.name);
      await addSiteAlias(db, orgId, id, existing.name, "rename");
    }

    let aliasConflicts: Array<{ alias: string; conflictSiteId: string }> = [];
    if (Array.isArray(body.data?.aliases) || typeof body.data?.aliases === "string") {
      const aliasWrite = await setSiteAliases(db, orgId, id, [
        ...stringList(body.data?.aliases),
        ...(payload.mondayMaintenanceName ? [payload.mondayMaintenanceName] : []),
        ...(payload.mondayComplianceName ? [payload.mondayComplianceName] : []),
      ]);
      aliasConflicts = aliasWrite.refused;
    }
    if (body.data?.groupIds !== undefined) {
      await setSiteGroupMembership(db, orgId, id, stringList(body.data.groupIds));
    }
    // Holding the mirror is recorded rather than silent: the audit line names
    // the words the canonical columns are missing, which is the whole of what an
    // admin has to paste into `address_line2` to make the rebuild lossless.
    await logChange(db, orgId, id, "updated", actor.email, {
      name: payload.name,
      ...(mirror.heldFor.length ? { addressMirrorHeld: mirror.heldFor } : {}),
    });

    // See `setSiteAliases`: a name another site already answers to is refused,
    // and the save must say so rather than report a list it did not record.
    return Response.json({
      ok: true,
      id,
      ...(mirror.heldFor.length ? { addressMirrorHeld: mirror.heldFor } : {}),
      ...(aliasConflicts.length ? { aliasConflicts } : {}),
    });
  } catch (error) {
    const failure = siteWriteFailure(error, "The site could not be updated.");
    return Response.json({ error: failure.message }, { status: failure.status });
  }
}

/**
 * Sites are archived, never deleted. Jobs, compliance documents and assets all
 * reference the site; deleting the row would orphan legally significant
 * records. Archiving sets the status to closed and hides it from selectors.
 */
export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "sites.edit");
    if (guard.denied) return guard.denied;
    const { actor, db, orgId } = guard.scope;
    const body = (await request.json()) as { id?: string };
    const id = text(body.id, 120);
    if (!id) throw new Error("A site ID is required.");

    const existing = await getSite(db, orgId, id);
    if (!existing) return Response.json({ error: "Site not found." }, { status: 404 });

    const [openJobs] = await db
      .select({ total: count() })
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.organisationId, orgId),
          eq(maintenanceRequests.siteId, id),
          // Stage 23 — `retainedJobs` tells the caller what survives closing a
          // site. Jobs in the bin are not retained; they are on their way out.
          isNull(maintenanceRequests.deletedAt),
        ),
      );

    await db
      .update(sites)
      .set({
        status: "closed",
        lifecycle: "Closed",
        active: false,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(sites.id, id), eq(sites.organisationId, orgId)));

    await logChange(db, orgId, id, "archived", actor.email, {
      name: existing.name,
      retainedJobs: openJobs?.total ?? 0,
    });

    return Response.json({ ok: true, id, retainedJobs: openJobs?.total ?? 0 });
  } catch (error) {
    const failure = siteWriteFailure(error, "The site could not be archived.");
    return Response.json({ error: failure.message }, { status: failure.status });
  }
}
