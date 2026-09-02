/**
 * WORKSTREAM 5/6 — `GET | POST | DELETE /api/contractor-sites`.
 *
 * THE FIFTH CONNECTION, and the one that did not exist. W05-09 asks that a site
 * be connected to Jobs, Compliance, Documents, Assets and Contractors; the first
 * four were already there and the fifth was not, in either direction. W06-10
 * asks the same edge from the other end — a contractor's Sites. One relation
 * answers both, because it IS one relation: `contractor_sites`, a plain
 * many-to-many with the organisation in its unique key.
 *
 * ── WHY A TABLE AND NOT AN INFERENCE ──────────────────────────────────────
 *
 * There were two things in the schema that looked like an answer and were not.
 *
 *   `contractors.coverage_areas` is free text, and on this workspace every
 *   contractor holds exactly `["UK"]` while every site is `region = 'UK'`. A
 *   "matching" rule over that connects all 19 contractors to all 13 sites and
 *   discriminates NOTHING — it is a cross join wearing a filter's clothes. So
 *   nothing here reads `coverage_areas`, and nothing here ever should: the
 *   answer it gives is confidently wrong, which is worse than absent.
 *
 *   A job carries both `site_id` and `contractor_id`, so "who has worked here"
 *   is already answerable. That is HISTORY, and history is not a relationship:
 *   it cannot say a contractor is appointed to a store they have not yet been
 *   called to, and it cannot be ended when a contract is. This table is the
 *   deliberate, current statement; the job history is untouched by it and stays
 *   exactly as it is.
 *
 * ── WHY 404 AND NOT 403 FOR A FOREIGN ID ─────────────────────────────────
 *
 * Both ids are checked against `organisation_id` BEFORE anything is written. A
 * foreign key proves a row exists; it does not prove the caller may see it, and
 * `contractor_sites` references `contractors(id)` and `sites(id)` without the
 * tenant in either constraint — so the database would happily accept a link
 * from this organisation's site to another organisation's contractor. The
 * refusal is 404 in both cases and in the same words `contractorTarget` in
 * `app/api/workspace/route.ts` uses, because telling "not yours" apart from
 * "does not exist" tells a caller which ids live inside a tenant they may not
 * read.
 *
 * ── WHO MAY WRITE ────────────────────────────────────────────────────────
 *
 * `sites.edit`. Not a new capability and not `board.edit`: this is entity data
 * about a site and a contractor, which is exactly what `sites.edit` already
 * means in this product, and a key nobody has been granted is a feature nobody
 * can use. Reading is open to any member, because both profiles have to draw
 * the section for everybody who can see the screen at all.
 */

import { and, asc, eq, inArray, like, or } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import { contractorSites, contractors, sites } from "../../../db/schema";
import {
  anonymousRefusal,
  scopedDb,
  scopedDbWithCapability,
  type ScopedDatabase,
} from "../../lib/tenant-db";
import { auditActor, recordAudit } from "../../lib/audit";
import { can, resolvePermissions } from "../../lib/permissions";
import { databaseSafeFailure } from "../../lib/database-failure";

export const dynamic = "force-dynamic";

/**
 * How many unlinked candidates one read may offer.
 *
 * The picker is a list somebody scans, not a directory export. A tenant with
 * four hundred sites gets the first hundred by name plus `candidateTotal`, so
 * the control can say how many it is not showing and ask for a search term
 * rather than pretending the hundred are all of them — the same failure
 * `/api/files` had before W07-11 gave it `total`.
 */
const CANDIDATE_LIMIT = 100;

/** Longest an id or a search term may be. Truncated, never rejected. */
const MAX_ID = 120;
const MAX_QUERY = 80;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * One side of the relation, named by the caller — or a refusal.
 *
 * Exactly one. Both is ambiguous (is it "this pair" or "the union"?) and
 * neither would be a request to dump every link in the workspace, which is a
 * different question from the two this endpoint answers. Refused rather than
 * defaulted, for the reason `readRegister` gives in the registers route: a
 * silently chosen side is a wrong answer that looks like a right one.
 */
function readSide(
  url: URL,
): { side: "site"; id: string } | { side: "contractor"; id: string } | { refusal: Response } {
  const siteId = text(url.searchParams.get("siteId"), MAX_ID);
  const contractorId = text(url.searchParams.get("contractorId"), MAX_ID);
  if (siteId && contractorId) {
    return {
      refusal: Response.json(
        {
          error:
            "Ask from one side: siteId for a site's contractors, contractorId for a contractor's sites.",
        },
        { status: 400 },
      ),
    };
  }
  if (siteId) return { side: "site", id: siteId };
  if (contractorId) return { side: "contractor", id: contractorId };
  return {
    refusal: Response.json(
      { error: "Name a site or a contractor: siteId=… or contractorId=…" },
      { status: 400 },
    ),
  };
}

/**
 * The site exists IN THIS TENANT — or the 404 that says nothing more.
 *
 * Deliberately identical in shape to `contractorExists` below rather than
 * folded into one generic helper: drizzle's `.from()` does not take a union of
 * table types, and two explicit selects read more honestly than a cast that
 * hides which table is being asked. `anchorReferencesRefusal` in
 * `app/api/files/documents.ts` makes the same choice for the same reason.
 */
async function siteRefusal(
  db: ScopedDatabase["db"],
  orgId: string,
  id: string,
): Promise<Response | null> {
  if (!id) return Response.json({ error: "Name the site." }, { status: 400 });
  const [row] = await db
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.id, id), eq(sites.organisationId, orgId)))
    .limit(1);
  return row ? null : Response.json({ error: "Site not found." }, { status: 404 });
}

async function contractorRefusal(
  db: ScopedDatabase["db"],
  orgId: string,
  id: string,
): Promise<Response | null> {
  if (!id) return Response.json({ error: "Name the contractor." }, { status: 400 });
  const [row] = await db
    .select({ id: contractors.id })
    .from(contractors)
    .where(and(eq(contractors.id, id), eq(contractors.organisationId, orgId)))
    .limit(1);
  return row ? null : Response.json({ error: "Contractor not found." }, { status: 404 });
}

/** The contractor fields a site's Contractors section can actually draw. */
function contractorSummary(row: typeof contractors.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    contactName: row.contactName,
    email: row.email,
    phone: row.phone,
    whatsappNumber: row.whatsappNumber,
    availability: row.availability,
    /*
     * Served so the linked list can mark a contractor who has been taken off
     * the register. A link to an archived contractor is not an error and is not
     * deleted when they are archived — it is a fact about who was appointed —
     * but a reader ringing down the list has to be able to see it.
     */
    active: row.active,
  };
}

/**
 * One link row, as every caller receives it.
 *
 * `organisation_id` is deliberately absent: it is the tenant filter every query
 * here already applied, not a fact about the appointment, and serving it would
 * put a workspace id into a payload no screen has any use for.
 */
function linkPayload(row: typeof contractorSites.$inferSelect) {
  return {
    id: row.id,
    contractorId: row.contractorId,
    siteId: row.siteId,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}

/** The site fields a contractor's Sites section can actually draw. */
function siteSummary(row: typeof sites.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    city: row.city,
    postcode: row.postcode,
    region: row.region,
    status: row.status,
    active: row.active,
  };
}

/**
 * One audit line about an appointment.
 *
 * Structure the whole workspace shares, in exactly the sense `recordColumnChange`
 * means in the registers route: linking a contractor to a store changes what
 * every colleague sees on two screens, and "who appointed them, and when" is a
 * question somebody asks a year later. The entity is the LINK row, so an
 * unlink and a later re-link are two events rather than one row rewritten.
 */
async function recordLinkChange(
  scope: ScopedDatabase,
  request: Request,
  action: string,
  entityId: string,
  summary: string,
  detail: unknown,
) {
  await recordAudit({
    db: scope.db,
    organisationId: scope.orgId,
    actor: auditActor(scope),
    action,
    entityType: "contractor_site",
    entityId,
    summary,
    detail,
    request,
  });
}

/**
 * GET — one side's links, plus the rows it could still be linked to.
 *
 * BOTH HALVES IN ONE ANSWER. A picker that offered every contractor in the
 * workspace would offer the ones already linked, and choosing one of those is a
 * request the server answers "already linked" — a dead end the reader had no
 * way to see coming. `candidates` is what remains after the links are removed,
 * so every option in the list does something.
 *
 * `canEdit` is stated rather than inferred from the role, for the reason the
 * registers route states `canConfigure`: a role whose `sites.edit` was revoked
 * in Roles is still called "Admin", and a screen that decides by role name
 * draws controls that will be refused.
 */
export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const url = new URL(request.url);
    const named = readSide(url);
    if ("refusal" in named) return named.refusal;

    const scope = await scopedDb(request);
    const { db, orgId } = scope;
    const query = text(url.searchParams.get("q"), MAX_QUERY);

    const refusal =
      named.side === "site"
        ? await siteRefusal(db, orgId, named.id)
        : await contractorRefusal(db, orgId, named.id);
    if (refusal) return refusal;

    /* Resolved once and asked twice rather than two capability probes: each of
       those re-resolves tenant access from scratch, and this is the read every
       open of a site or contractor profile goes through. */
    const subject = await resolvePermissions(db, orgId, scope.actor.role);
    const canEdit = can(subject, "sites.edit");
    /*
     * The OTHER capability a contractor profile has to know about.
     *
     * Linking a site is `sites.edit`; filing a document against a contractor is
     * `board.edit`, because that is what `PATCH /api/files/[id]` and every
     * upload route already require. A profile drawing both sections would
     * otherwise need a second round trip to find out which of its two panels
     * may offer controls, and a panel that guesses draws buttons the server
     * refuses.
     */
    const canManageDocuments = can(subject, "board.edit");

    const linkRows = await db
      .select()
      .from(contractorSites)
      .where(
        and(
          eq(contractorSites.organisationId, orgId),
          named.side === "site"
            ? eq(contractorSites.siteId, named.id)
            : eq(contractorSites.contractorId, named.id),
        ),
      );

    /*
     * The linked ids drive one `inArray`, not one query per link. Thirteen
     * sites today; a contractor appointed to two hundred stores would otherwise
     * be two hundred round trips on the boot path of a profile screen.
     */
    const linkedIds = linkRows.map((row) =>
      named.side === "site" ? row.contractorId : row.siteId,
    );

    if (named.side === "site") {
      const rows = linkedIds.length
        ? await db
            .select()
            .from(contractors)
            .where(
              and(
                eq(contractors.organisationId, orgId),
                inArray(contractors.id, linkedIds),
              ),
            )
        : [];
      const byId = new Map(rows.map((row) => [row.id, row]));
      const links = linkRows
        .map((link) => {
          const row = byId.get(link.contractorId);
          /*
           * A link whose contractor has been PURGED is dropped rather than
           * rendered as a blank row. `data.delete` is a real verb in this
           * product and the FK is not `ON DELETE CASCADE`, so this is the
           * defensive half of the read rather than a hypothetical.
           */
          return row
            ? {
                id: link.id,
                contractor: contractorSummary(row),
                createdAt: link.createdAt,
                createdBy: link.createdBy,
              }
            : null;
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .sort((a, b) => a.contractor.name.localeCompare(b.contractor.name));

      const candidateWhere = and(
        eq(contractors.organisationId, orgId),
        query ? like(contractors.name, `%${query}%`) : undefined,
      );
      const pool = await db
        .select()
        .from(contractors)
        .where(candidateWhere)
        .orderBy(asc(contractors.name));
      const linkedSet = new Set(linkedIds);
      const unlinked = pool.filter((row) => !linkedSet.has(row.id));

      return Response.json({
        siteId: named.id,
        links,
        canEdit,
        canManageDocuments,
        candidates: unlinked.slice(0, CANDIDATE_LIMIT).map(contractorSummary),
        candidateTotal: unlinked.length,
        candidateLimit: CANDIDATE_LIMIT,
      });
    }

    const rows = linkedIds.length
      ? await db
          .select()
          .from(sites)
          .where(and(eq(sites.organisationId, orgId), inArray(sites.id, linkedIds)))
      : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const links = linkRows
      .map((link) => {
        const row = byId.get(link.siteId);
        return row
          ? {
              id: link.id,
              site: siteSummary(row),
              createdAt: link.createdAt,
              createdBy: link.createdBy,
            }
          : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => a.site.name.localeCompare(b.site.name));

    /*
     * A site is searched by the two things a person would type — the name on
     * the door and the code on the register — because half this estate is known
     * internally by its code and a picker that only matched names would look
     * broken to the people who use them.
     */
    const candidateWhere = and(
      eq(sites.organisationId, orgId),
      query
        ? or(like(sites.name, `%${query}%`), like(sites.code, `%${query}%`))
        : undefined,
    );
    const pool = await db
      .select()
      .from(sites)
      .where(candidateWhere)
      .orderBy(asc(sites.name));
    const linkedSet = new Set(linkedIds);
    const unlinked = pool.filter((row) => !linkedSet.has(row.id));

    return Response.json({
      contractorId: named.id,
      links,
      canEdit,
      canManageDocuments,
      candidates: unlinked.slice(0, CANDIDATE_LIMIT).map(siteSummary),
      candidateTotal: unlinked.length,
      candidateLimit: CANDIDATE_LIMIT,
    });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    /*
     * A driver fault answers 503 with a fixed sentence instead of the failing
     * statement; every other error keeps the status and message chosen above.
     * See app/lib/database-failure.ts — this leak only appears on Postgres.
     */
    const failure = databaseSafeFailure(error, "The links could not be loaded.", 503);
    return Response.json({ error: failure.message }, { status: failure.status });
  }
}

/**
 * POST — appoint a contractor to a site. Body: `{ contractorId, siteId }`.
 *
 * IDEMPOTENT BY DESIGN, and the design is the unique index. A repeat link is
 * answered 200 with the row that already exists and `unchanged: true`, so a
 * double-tap on a phone, a retried request and two coordinators pressing Link
 * within the same second all produce one row and no error. The index is what
 * makes that safe rather than a race: the read below narrows the window, and
 * the constraint closes it — a loser of the race is caught and re-read rather
 * than surfaced as a 503.
 */
export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "sites.edit");
    if (guard.denied) return guard.denied;
    const scope = guard.scope;
    const { db, orgId } = scope;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const contractorId = text(body.contractorId, MAX_ID);
    const siteId = text(body.siteId, MAX_ID);

    /*
     * BOTH SIDES, BEFORE ANY WRITE. The order matters only in that neither may
     * be skipped: a caller who may edit this tenant's sites must not be able to
     * name another tenant's contractor and have the FK accept it, because the
     * FK does not carry the organisation.
     */
    const badContractor = await contractorRefusal(db, orgId, contractorId);
    if (badContractor) return badContractor;
    const badSite = await siteRefusal(db, orgId, siteId);
    if (badSite) return badSite;

    const [existing] = await db
      .select()
      .from(contractorSites)
      .where(
        and(
          eq(contractorSites.organisationId, orgId),
          eq(contractorSites.contractorId, contractorId),
          eq(contractorSites.siteId, siteId),
        ),
      )
      .limit(1);
    if (existing) {
      /*
       * The SAME shape the 201 answers with, minus nothing and plus nothing.
       * A client that reads `body.link` after a link must not have to care
       * whether it won the race — and `organisation_id` is machinery, not a
       * fact about the appointment, so it is not served on either path.
       */
      return Response.json({ link: linkPayload(existing), unchanged: true });
    }

    const id = `csite_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    try {
      await db.insert(contractorSites).values({
        id,
        organisationId: orgId,
        contractorId,
        siteId,
        createdAt: now,
        createdBy: scope.identityEmail,
      });
    } catch (error) {
      /*
       * The other half of the idempotency, for the race the read above cannot
       * close. Re-read rather than trusted: if a row is there now, the caller
       * asked for a state that holds and gets the truthful 200. If there is
       * none, the insert failed for some other reason and the error is real.
       */
      const [raced] = await db
        .select()
        .from(contractorSites)
        .where(
          and(
            eq(contractorSites.organisationId, orgId),
            eq(contractorSites.contractorId, contractorId),
            eq(contractorSites.siteId, siteId),
          ),
        )
        .limit(1);
      if (raced) return Response.json({ link: linkPayload(raced), unchanged: true });
      throw error;
    }

    const [contractor] = await db
      .select({ name: contractors.name })
      .from(contractors)
      .where(and(eq(contractors.id, contractorId), eq(contractors.organisationId, orgId)))
      .limit(1);
    const [site] = await db
      .select({ name: sites.name })
      .from(sites)
      .where(and(eq(sites.id, siteId), eq(sites.organisationId, orgId)))
      .limit(1);

    await recordLinkChange(
      scope,
      request,
      "contractor_site.linked",
      id,
      `Linked ${contractor?.name ?? contractorId} to ${site?.name ?? siteId}.`,
      { contractorId, siteId },
    );

    return Response.json(
      {
        link: {
          id,
          contractorId,
          siteId,
          createdAt: now,
          createdBy: scope.identityEmail,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    /*
     * A driver fault answers 503 with a fixed sentence instead of the failing
     * statement; every other error keeps the status and message chosen above.
     * See app/lib/database-failure.ts — this leak only appears on Postgres.
     */
    const failure = databaseSafeFailure(error, "The link could not be created.", 400);
    return Response.json({ error: failure.message }, { status: failure.status });
  }
}

/**
 * DELETE — end an appointment. `?id=` or `?contractorId=&siteId=`.
 *
 * Both spellings, because the two callers hold different things: the site
 * profile is rendering link rows and has the id, while a "remove" pressed
 * straight after a link on the contractor side has the pair. Deleting by pair
 * is scoped by `organisation_id` exactly as deleting by id is, so neither is a
 * way round the tenant filter.
 *
 * HARD, not soft. There is nothing to keep: the row carries no data of its own
 * beyond who made it and when, the audit trail keeps that, and a soft-deleted
 * link would have to be excluded from the unique index for a re-link to work —
 * turning a two-column invariant into a predicate every reader would have to
 * remember. A register column is soft-deleted because its VALUES would be lost;
 * this has none.
 */
export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "sites.edit");
    if (guard.denied) return guard.denied;
    const scope = guard.scope;
    const { db, orgId } = scope;

    const url = new URL(request.url);
    const id = text(url.searchParams.get("id"), MAX_ID);
    const contractorId = text(url.searchParams.get("contractorId"), MAX_ID);
    const siteId = text(url.searchParams.get("siteId"), MAX_ID);

    if (!id && !(contractorId && siteId)) {
      return Response.json(
        { error: "Name the link: id=…, or contractorId=… and siteId=… together." },
        { status: 400 },
      );
    }

    const [existing] = await db
      .select()
      .from(contractorSites)
      .where(
        and(
          eq(contractorSites.organisationId, orgId),
          id
            ? eq(contractorSites.id, id)
            : and(
                eq(contractorSites.contractorId, contractorId),
                eq(contractorSites.siteId, siteId),
              ),
        ),
      )
      .limit(1);
    if (!existing) {
      return Response.json({ error: "That link does not exist." }, { status: 404 });
    }

    await db
      .delete(contractorSites)
      .where(
        and(eq(contractorSites.id, existing.id), eq(contractorSites.organisationId, orgId)),
      );

    const [contractor] = await db
      .select({ name: contractors.name })
      .from(contractors)
      .where(
        and(
          eq(contractors.id, existing.contractorId),
          eq(contractors.organisationId, orgId),
        ),
      )
      .limit(1);
    const [site] = await db
      .select({ name: sites.name })
      .from(sites)
      .where(and(eq(sites.id, existing.siteId), eq(sites.organisationId, orgId)))
      .limit(1);

    await recordLinkChange(
      scope,
      request,
      "contractor_site.unlinked",
      existing.id,
      `Unlinked ${contractor?.name ?? existing.contractorId} from ${site?.name ?? existing.siteId}.`,
      { contractorId: existing.contractorId, siteId: existing.siteId },
    );

    return Response.json({
      ok: true,
      removed: {
        id: existing.id,
        contractorId: existing.contractorId,
        siteId: existing.siteId,
      },
    });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    /*
     * A driver fault answers 503 with a fixed sentence instead of the failing
     * statement; every other error keeps the status and message chosen above.
     * See app/lib/database-failure.ts — this leak only appears on Postgres.
     */
    const failure = databaseSafeFailure(error, "The link could not be removed.", 400);
    return Response.json({ error: failure.message }, { status: failure.status });
  }
}
