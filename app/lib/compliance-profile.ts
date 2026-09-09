import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { complianceDocuments } from "../../db/schema";
import { storeDocumentationKinds } from "../../db/monday-board-spec";
import { DUTY_HOLDER_UNCONFIRMED } from "./compliance-duty-holder";
/*
 * 2C — the estate's own words for these certificates. `kind` was compared with
 * `===`, and real estates do not write "Water Hygiene"; they write "Legionella
 * risk assessment". See `compliance-vocabulary.ts` for the eight names this was
 * measured against and why a resolver, not an editable list, is what the data
 * asked for.
 */
import { buildKindResolver, type KindResolver } from "./compliance-vocabulary";
import { chunkRows } from "./sql-batching";

type Database = Awaited<ReturnType<typeof getDb>>;

/**
 * How many bound variables one profile row costs.
 *
 * MEASURED AT TWELVE, SET AT FOURTEEN. The failing statement was read straight
 * out of the server log, and each row bound exactly twelve parameters:
 *
 *   id, organisation_id, client_id, site_id, kind, status, expiry_date,
 *   attachment_id, not_required, is_seed, remedials_required, duty_holder
 *
 * Note what that list is NOT. It is not the eight fields this function sets:
 * `client_id`, `is_seed` and `remedials_required` are there because they carry
 * drizzle defaults, so they are named in the statement whether or not anything
 * here mentions them — which is exactly why counting the keys in the object
 * below would have given the wrong answer. `created_at` and `updated_at` cost
 * nothing, compiling to `CURRENT_TIMESTAMP` rather than a parameter, even
 * though the statement names them too.
 *
 * Fourteen leaves two columns of headroom, deliberately. Overstating the width
 * only makes the chunks smaller; understating it brings back `too many SQL
 * variables`, and the next column added to `compliance_documents` — this file
 * has just added one — is precisely what would do it.
 */
const COMPLIANCE_INSERT_COLUMNS = 14;

/**
 * A SITE AND ITS COMPLIANCE PROFILE ARE ONE THING, AND THIS IS THE ONE PLACE
 * THAT SAYS SO.
 *
 * ── THE FAULT ─────────────────────────────────────────────────────────────
 *
 * A site created on the Sites page got no compliance profile at all. Traced
 * through all four write paths — `POST /api/sites`, `POST /api/sites/csv`,
 * `POST /api/workspace {entity:"site"}` and the sample seeder — not one of them
 * inserted a single `compliance_documents` row. The consequence on screen is
 * that a new site reads "No requirements set" and contributes nothing to the
 * portfolio figure, so the register and the site list disagree about whether
 * the estate is covered.
 *
 * ── WHY ROWS, AND NOT A BOARD ROW ─────────────────────────────────────────
 *
 * A compliance record in this product is not normally a row. It is a Store
 * Documentation BOARD row crossed with one of twelve certificate slots, which
 * is why `app/lib/compliance-view.ts` opens by explaining that the counts
 * cannot be aggregated in the database. `compliance_documents` sits on top of
 * that as an annotation table.
 *
 * But `readComplianceRegister` has a SECOND loop — "register rows the board
 * does not speak for" — which emits every `compliance_documents` row that no
 * board row covered, with `itemId: null`, and remembers it against its site.
 * So a profile written here appears in the register, in `bySite`, on the site
 * row's meter and in the portfolio figure, WITHOUT inventing a board row whose
 * title would then have to be name-matched back to the site it came from. That
 * name-matching is the existing weak link (`siteIdByBoardName`), and the board's
 * own "+ New store" button is already known to produce rows titled "New store"
 * that match nothing. Writing the annotation directly avoids adding to that.
 *
 * No second data model: the same table, the same reader, the same twelve kinds
 * the board uses (`storeDocumentationKinds`).
 *
 * ── WHY EVERY ROW STARTS UNCONFIRMED ──────────────────────────────────────
 *
 * Because most of these items are landlord- or centre-controlled in a mall
 * unit, and several do not apply at all — a kiosk has no stored water and no
 * gas. Creating eleven sites' worth of requirements and letting them all count
 * as the client's would turn a 15% portfolio figure into something both worse
 * and meaningless. `DUTY_HOLDER_UNCONFIRMED` keeps them out of the maths until
 * somebody says whose they are; see `compliance-duty-holder.ts` for why that
 * marker is a stored value and not a NULL.
 */

/** What a call did, so a caller can log it and a backfill can report it. */
export type ComplianceProfileResult = {
  /** Requirement kinds inserted by this call. */
  created: string[];
  /**
   * Kinds that already had a row and were left exactly as they were.
   *
   * MATCHED, NEVER DUPLICATED. A second row for the same requirement would be
   * counted twice by both loops in `readComplianceRegister` and there is no
   * unique constraint to stop it, so this check is the only thing standing
   * between a repair and a double count.
   *
   * MATCHED THROUGH THE RESOLVER, not with `===`, and that change is the whole
   * of item 2C. The old comparison was against `kind` exactly, so a site
   * already holding "Legionella risk assessment" was handed "Water Hygiene"
   * beside it and a site holding "Fire risk assessment" was handed "Fire Risk
   * Assessment" — a duplicate created by one capital letter. Measured on
   * Staging: twelve stores holding 204 requirements where about 66 is the
   * honest number, and a confirm queue asking about each certificate twice.
   */
  matched: string[];
  /**
   * Requirements matched under a name that is not the template's.
   *
   * `{ kind: "Water Hygiene", matchedAs: "Legionella risk assessment" }` — the
   * requirement was NOT created and the operator's row was NOT renamed. It is
   * reported so a backfill preview can show what a repair is about to leave
   * alone, which is the part of a preview people actually check.
   */
  aliased: Array<{ kind: string; matchedAs: string }>;
};

/**
 * Gives `siteId` the standard profile, and leaves anything already recorded
 * alone.
 *
 * IDEMPOTENT BY CONSTRUCTION, which is what lets it be called from a create
 * path AND from a read path without either having to know about the other. The
 * repair-on-read case exists because sites created before this function did
 * have no profile and would otherwise stay invisible for ever.
 *
 * Deliberately does NOT open a transaction of its own. Every caller is already
 * inside one request's worth of work, and the D1 interface this app is written
 * against reserves a connection for a batch — see `db/node-pg-d1.ts`. The
 * caller decides atomicity; this decides content.
 */
export async function ensureComplianceProfile(
  db: Database,
  orgId: string,
  siteId: string,
  options: { kinds?: readonly string[]; resolve?: KindResolver } = {},
): Promise<ComplianceProfileResult> {
  const kinds = options.kinds ?? storeDocumentationKinds;
  /*
   * The DEFAULT resolver knows the built-in synonyms and nothing organisation
   * specific. A caller holding the organisation's template should pass its
   * resolver — `readComplianceTemplate` then `buildKindResolver` — and the
   * routes that create sites do. Defaulted rather than required so no existing
   * caller had to change to stop duplicating, which was the point.
   */
  const resolve = options.resolve ?? buildKindResolver();
  if (!kinds.length) return { created: [], matched: [], aliased: [] };

  /*
   * EVERY REQUIREMENT THIS SITE HOLDS, not just the ones about to be written.
   *
   * This used to be `inArray(kind, kinds)` with a note that reading the rest
   * was "a wider query for no answer". That note was wrong, and the 144 surplus
   * rows on Staging are what it cost: the rows this function most needed to see
   * were precisely the ones whose names are NOT in `kinds`. A site's register is
   * a couple of dozen rows on an index built on (organisation, site, kind), so
   * the wider read is the cheaper mistake by a very long way.
   */
  const existing = (await db
    .select({ kind: complianceDocuments.kind })
    .from(complianceDocuments)
    .where(
      and(
        eq(complianceDocuments.organisationId, orgId),
        eq(complianceDocuments.siteId, siteId),
      ),
    )) as Array<{ kind: string }>;

  /*
   * `resolvedName -> the name the row is actually written under`.
   *
   * FIRST ROW WINS, so a site that already holds two spellings of one
   * certificate — and the Demo Client holds several — reports a stable one
   * rather than whichever came back last.
   */
  const heldBy = new Map<string, string>();
  for (const row of existing) {
    const canonical = resolve(row.kind) ?? row.kind;
    if (!heldBy.has(canonical)) heldBy.set(canonical, row.kind);
  }

  const matched: string[] = [];
  const aliased: Array<{ kind: string; matchedAs: string }> = [];
  const missing: string[] = [];
  for (const kind of kinds) {
    /* The requirement is looked up under ITS OWN resolved name, so a template
       whose entry is "Water Hygiene" finds a row written "Legionella risk
       assessment" — and a template that renamed the requirement finds it too. */
    const matchedAs = heldBy.get(resolve(kind) ?? kind);
    if (matchedAs === undefined) {
      missing.push(kind);
      continue;
    }
    matched.push(kind);
    /* Reported, and deliberately NOT renamed. The operator's word for their own
       certificate is theirs; silently rewriting sixty rows to the machine's
       vocabulary would be a data migration disguised as a read. */
    if (matchedAs !== kind) aliased.push({ kind, matchedAs });
  }
  if (!missing.length) return { created: [], matched, aliased };

  /*
   * CHUNKED, BECAUSE A TWELVE-REQUIREMENT PROFILE IS A 144-VARIABLE INSERT.
   *
   * D1 binds one variable per COLUMN per ROW, not one per row, and refuses a
   * statement past roughly a hundred of them. Twelve requirements × the twelve
   * columns drizzle names here is 144, so the whole profile in one statement
   * failed every time — and because the site insert had already succeeded, the
   * visible symptom was the compensating rollback firing on every single site
   * creation. Measured, not guessed: the first probe site returned "its
   * compliance profile could not be set up" and left no row behind.
   *
   * `chunkRows` divides the budget by the row width, which is the same helper
   * and the same failure the recycle bin's 20-row bulk delete hit. Hardcoding a
   * row count here would go stale the next time a column is added to this
   * table — which is precisely how it would come back.
   */
  const rows = missing.map((kind) => ({
      id: complianceProfileId(siteId, kind),
      organisationId: orgId,
      siteId,
      kind,
      /*
       * `status` is written and then never read as truth. Every screen
       * derives the state from the expiry date and the file count instead —
       * `complianceStateFor` — because a stored status is a statement about
       * the day it was written. "Missing" is the column's own default and the
       * honest word for a requirement with no certificate against it; the
       * reason it does not reach a percentage is the duty holder, not this.
       */
      status: "Missing",
      expiryDate: null,
      attachmentId: null,
      notRequired: false,
      dutyHolder: DUTY_HOLDER_UNCONFIRMED,
  }));

  /* The width drizzle actually binds, taken from the row rather than counted by
     hand: `id, organisation_id, client_id, site_id, kind, status, expiry_date,
     attachment_id, not_required, is_seed, remedials_required, duty_holder` — and
     `client_id`, `is_seed` and `remedials_required` are in there because they
     carry drizzle defaults, which is why counting the keys above would be wrong.
     A generous fixed width is safer than an exact one that drifts. */
  for (const chunk of chunkRows(rows, COMPLIANCE_INSERT_COLUMNS)) {
    await db.insert(complianceDocuments).values(chunk);
  }

  return { created: missing, matched, aliased };
}

/**
 * A stable id, so the same site and requirement cannot end up with two rows if
 * two requests race.
 *
 * There is no unique index on (organisation, site, kind) — adding one would
 * mean a destructive migration on a table that already holds duplicates from
 * the monday import, and `db/init.ts` is additive only. A deterministic
 * primary key gets the same protection from the key that IS enforced: the
 * second writer's INSERT collides on the id instead of quietly making a
 * thirteenth requirement.
 *
 * Shaped like the existing generator in `app/api/workspace/route.ts`
 * (`newId("compliance", `${siteId}-${kind}`)`) so the two paths produce ids a
 * reader can tell apart from a monday-imported one.
 */
export function complianceProfileId(siteId: string, kind: string): string {
  const slug = kind
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `compliance-${siteId}-${slug}`;
}
