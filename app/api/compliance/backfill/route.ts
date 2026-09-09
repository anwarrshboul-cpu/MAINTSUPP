/**
 * 2D — GIVING AN ESTATE ITS COMPLIANCE PROFILE, PREVIEWED AND REVERSIBLE.
 *
 * ── WHY THIS IS NOT JUST A LOOP OVER `ensureComplianceProfile` ────────────
 *
 * Because the last unpreviewed run of exactly that loop is the reason item 2C
 * exists. Repair-on-read walked twelve sites, matched requirement names with
 * `===`, recognised none of the sixty the estate already held, and created 144
 * more beside them. Nobody approved that, because nobody was shown it. The
 * portfolio figure fell to 18% and the confirm queue doubled in length, and the
 * only evidence of what had happened was the row count.
 *
 * So this endpoint's default is a PREVIEW, computed by the same code that would
 * act, and its apply is undoable.
 *
 * ── HOW REVERSAL IS EXACT ─────────────────────────────────────────────────
 *
 * `complianceProfileId(siteId, kind)` is deterministic. Every row this endpoint
 * creates therefore has a primary key that can be recomputed from the two facts
 * that produced it, which is what makes "undo this batch" a precise statement
 * about specific rows rather than "delete everything that looks recent". The
 * batch record is stored so a person can find the batch, but even a lost record
 * could be reconstructed from the site list and the template.
 *
 * ── WHAT REVERSAL REFUSES TO DELETE ───────────────────────────────────────
 *
 * A row that has stopped being an empty placeholder. Once somebody has attached
 * a certificate to it, recorded an expiry, marked it not required, or said whose
 * obligation it is, it is no longer the thing this batch created — it is a
 * person's work that happens to sit on the same primary key. Those are KEPT and
 * reported, and the caller is told how many. An undo that quietly deleted an
 * uploaded certificate would be far worse than the surplus rows it was undoing.
 *
 * ── THE VARIABLE CAP ──────────────────────────────────────────────────────
 *
 * D1 binds one variable per COLUMN per row and refuses past roughly a hundred.
 * The inserts go through `ensureComplianceProfile`, which owns that arithmetic;
 * the reversal's `IN` lists go through `chunkIds`. A 12-site backfill is 144
 * ids, which is already past the cap on its own.
 */

import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { getDb } from "../../../../db";
import { ensureDatabase } from "../../../../db/init";
import { activityLog, complianceDocuments, sites } from "../../../../db/schema";
import { scopedDbWithCapability } from "../../../lib/tenant-db";
import {
  complianceProfileId,
  ensureComplianceProfile,
} from "../../../lib/compliance-profile";
import { readComplianceTemplate } from "../../../lib/compliance-template-store";
import { buildKindResolver, templateKinds } from "../../../lib/compliance-vocabulary";
import { DUTY_HOLDER_UNCONFIRMED } from "../../../lib/compliance-duty-holder";
import { chunkIds } from "../../../lib/sql-batching";

export const dynamic = "force-dynamic";

/** The drizzle handle, typed exactly as `compliance-register.ts` types it. */
type Database = Awaited<ReturnType<typeof getDb>>;

/**
 * How many sites one batch may touch.
 *
 * A blast radius, not a limit of the machinery. The largest tenant on Staging
 * runs to a few dozen sites; 500 is beyond any real estate and short of "the
 * whole database because a filter was empty".
 */
const MAX_SITES = 500;

/** What one site would gain, in the words the preview prints. */
type SitePlan = {
  siteId: string;
  siteName: string;
  /** Requirements with no row under any recognised name. These get created. */
  create: string[];
  /** Requirements already held under the template's own name. */
  held: string[];
  /**
   * Requirements already held under ANOTHER name.
   *
   * The most important line of the preview and the one the old repair had no
   * concept of: `{kind: "Water Hygiene", matchedAs: "Legionella risk
   * assessment"}` is a requirement that is NOT missing and must not be created.
   */
  aliased: Array<{ kind: string; matchedAs: string }>;
};

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    /*
     * `board.edit`, the same capability the responsibility queue writes under.
     * This creates rows in the register, and the register IS the Store
     * Documentation board read another way — a separate capability over the
     * same rows would be one more thing an administrator has to keep in step.
     *
     * Deliberately NOT `data.delete`, even for the reversal. `data.delete` is
     * the permanent purge of somebody's real data and is withheld from `admin`
     * on purpose; undoing a batch of empty placeholder rows this same endpoint
     * created minutes ago is not that, and requiring it would mean the only
     * people who can run a backfill cannot undo one.
     */
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId, actor } = guard.scope;

    let payload: Record<string, unknown>;
    try {
      payload = ((await request.json()) ?? {}) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "The request body was not valid JSON." }, { status: 400 });
    }

    if (payload.action === "revert") {
      return revert(db, orgId, actor.email, payload);
    }

    /*
     * DRY RUN IS THE DEFAULT, and it is the default by omission as well as by
     * value. `dryRun !== false` rather than `dryRun === true`, so a client that
     * forgets the key gets a preview instead of a write — the failure mode of a
     * mistyped field name should be "nothing happened".
     */
    const dryRun = payload.dryRun !== false;

    const template = await readComplianceTemplate(db, orgId);
    const resolve = buildKindResolver(template);
    const kinds = templateKinds(template);
    if (!kinds.length) {
      return Response.json(
        { error: "Every requirement in this workspace's template is switched off." },
        { status: 400 },
      );
    }

    /* An explicit list, or the whole estate. Sites are read rather than
       trusted, so an id from another organisation simply is not in the list. */
    const requested = Array.isArray(payload.siteIds)
      ? new Set(payload.siteIds.filter((id): id is string => typeof id === "string"))
      : null;

    const siteRows = (await db
      .select({ id: sites.id, name: sites.name })
      .from(sites)
      .where(eq(sites.organisationId, orgId))) as Array<{ id: string; name: string }>;
    const targets = requested
      ? siteRows.filter((row) => requested.has(row.id))
      : siteRows;

    if (!targets.length) {
      return Response.json({ error: "No sites matched." }, { status: 400 });
    }
    if (targets.length > MAX_SITES) {
      return Response.json(
        { error: `A batch may cover at most ${MAX_SITES} sites.` },
        { status: 400 },
      );
    }

    /*
     * THE PREVIEW IS ONE READ OVER THE WHOLE ESTATE, not one per site.
     *
     * A per-site round trip would be 500 queries to answer a question about one
     * table, on a pooled connection this app runs two of per instance. The
     * apply below is per site because `ensureComplianceProfile` owns the
     * chunking and the deterministic ids; the preview has no such excuse.
     */
    const existing = (await db
      .select({ siteId: complianceDocuments.siteId, kind: complianceDocuments.kind })
      .from(complianceDocuments)
      .where(eq(complianceDocuments.organisationId, orgId))) as Array<{
      siteId: string;
      kind: string;
    }>;

    /* `siteId -> resolvedName -> the name the row is written under`. First row
       wins, matching `ensureComplianceProfile` exactly so the preview cannot
       disagree with the apply about which name a site is using. */
    const heldBySite = new Map<string, Map<string, string>>();
    for (const row of existing) {
      let held = heldBySite.get(row.siteId);
      if (!held) {
        held = new Map<string, string>();
        heldBySite.set(row.siteId, held);
      }
      const canonical = resolve(row.kind) ?? row.kind;
      if (!held.has(canonical)) held.set(canonical, row.kind);
    }

    const plans: SitePlan[] = targets.map((site) => {
      const held = heldBySite.get(site.id) ?? new Map<string, string>();
      const plan: SitePlan = { siteId: site.id, siteName: site.name, create: [], held: [], aliased: [] };
      for (const kind of kinds) {
        const matchedAs = held.get(resolve(kind) ?? kind);
        if (matchedAs === undefined) plan.create.push(kind);
        else if (matchedAs === kind) plan.held.push(kind);
        else plan.aliased.push({ kind, matchedAs });
      }
      return plan;
    });

    const totals = {
      sites: plans.length,
      sitesChanged: plans.filter((plan) => plan.create.length > 0).length,
      create: plans.reduce((sum, plan) => sum + plan.create.length, 0),
      held: plans.reduce((sum, plan) => sum + plan.held.length, 0),
      /*
       * Reported on its own line because it is the number that shows the work.
       * On Staging's Demo Client this is 60-odd requirements the previous
       * repair could not see and duplicated instead.
       */
      aliased: plans.reduce((sum, plan) => sum + plan.aliased.length, 0),
    };

    if (dryRun) {
      return Response.json({ dryRun: true, totals, plans });
    }

    /*
     * The batch id is minted BEFORE the writes, so a run that fails half way
     * still leaves a record naming everything it had created — which is the
     * only state from which a partial run can be undone.
     */
    const batchId = `backfill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const createdIds: string[] = [];
    const failures: Array<{ siteId: string; message: string }> = [];

    for (const plan of plans) {
      if (!plan.create.length) continue;
      try {
        const result = await ensureComplianceProfile(db, orgId, plan.siteId, {
          kinds: plan.create,
          /* The SAME resolver the preview used. Two resolvers is two answers to
             whether a requirement already exists, and the second one writes. */
          resolve,
        });
        for (const kind of result.created) createdIds.push(complianceProfileId(plan.siteId, kind));
      } catch (cause) {
        /*
         * One site's failure does not abandon the batch. The alternative is a
         * run that stops on site three of five hundred and leaves the operator
         * with no idea which two were done — and the batch record below names
         * exactly what was created either way, so a partial run is still
         * completely reversible.
         */
        console.error("[/api/compliance/backfill] site failed", plan.siteId, cause);
        failures.push({
          siteId: plan.siteId,
          message: cause instanceof Error ? cause.message : "The profile could not be written.",
        });
      }
    }

    await recordBatch(db, orgId, batchId, actor.email, {
      created: createdIds,
      sites: plans.filter((plan) => plan.create.length).map((plan) => plan.siteId),
      totals,
      failures,
    });

    return Response.json({
      dryRun: false,
      batchId,
      created: createdIds.length,
      totals,
      failures,
      /* Handed back so a UI can offer the undo without a second round trip to
         find out what the batch was called. */
      revert: { action: "revert", batchId },
    });
  } catch (cause) {
    console.error("[/api/compliance/backfill] failed", cause);
    return Response.json({ error: "The backfill could not be run." }, { status: 500 });
  }
}

/** The batch, written where an operator can already find changes. */
async function recordBatch(
  db: Database,
  orgId: string,
  batchId: string,
  actorEmail: string,
  detail: Record<string, unknown>,
) {
  await db.insert(activityLog).values({
    id: `activity-compliance-${batchId}`,
    organisationId: orgId,
    legacyClientId: orgId,
    entityType: "compliance_backfill",
    /* The batch id IS the entity, so `activity_entity_idx` finds the record in
       one indexed lookup when somebody asks to undo it. */
    entityId: batchId,
    action: "compliance_backfill",
    actorEmail,
    detail: JSON.stringify(detail),
  });
}

/**
 * Undo one batch.
 *
 * Addressed by batch id rather than by "everything created since", because the
 * second is not a statement about anything: two backfills five minutes apart
 * would undo each other's work.
 */
async function revert(
  db: Database,
  orgId: string,
  actorEmail: string,
  payload: Record<string, unknown>,
) {
  const batchId = typeof payload.batchId === "string" ? payload.batchId.trim() : "";
  if (!batchId) return Response.json({ error: "A batch id is required." }, { status: 400 });

  const [record] = await db
    .select({ detail: activityLog.detail })
    .from(activityLog)
    /* SCOPED BY ORGANISATION, always. A batch id is a guessable-looking string
       and it is not a capability — without this filter one tenant could name
       another tenant's batch and have its rows deleted. */
    .where(
      and(
        eq(activityLog.organisationId, orgId),
        eq(activityLog.entityType, "compliance_backfill"),
        eq(activityLog.entityId, batchId),
      ),
    )
    .limit(1);

  if (!record) return Response.json({ error: "That batch was not found." }, { status: 404 });

  let ids: string[] = [];
  try {
    const detail = JSON.parse(String(record.detail ?? "{}")) as { created?: unknown };
    ids = Array.isArray(detail.created)
      ? detail.created.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return Response.json(
      { error: "That batch's record could not be read, so it cannot be undone safely." },
      { status: 409 },
    );
  }
  if (!ids.length) return Response.json({ batchId, removed: 0, kept: 0, keptRows: [] });

  /*
   * WHICH OF THOSE ROWS ARE STILL THE EMPTY PLACEHOLDERS THIS BATCH CREATED.
   *
   * A row is still undoable only if nobody has done anything to it: no
   * certificate attached, no expiry recorded, not marked as not required, and
   * the duty holder still the machine's own "unconfirmed" stamp. Anything else
   * is a person's work sitting on a primary key this batch happened to mint,
   * and deleting it would destroy evidence that a certificate exists.
   */
  const removable: string[] = [];
  const kept: Array<{ id: string; kind: string; reason: string }> = [];
  for (const chunk of chunkIds(ids)) {
    const rows = (await db
      .select({
        id: complianceDocuments.id,
        kind: complianceDocuments.kind,
        attachmentId: complianceDocuments.attachmentId,
        expiryDate: complianceDocuments.expiryDate,
        notRequired: complianceDocuments.notRequired,
        dutyHolder: complianceDocuments.dutyHolder,
      })
      .from(complianceDocuments)
      .where(
        and(
          eq(complianceDocuments.organisationId, orgId),
          inArray(complianceDocuments.id, chunk),
        ),
      )) as unknown as Array<{
      id: string;
      kind: string;
      attachmentId: string | null;
      expiryDate: string | null;
      notRequired: boolean;
      dutyHolder: string | null;
    }>;
    for (const row of rows) {
      const reason = row.attachmentId
        ? "a certificate has been attached"
        : row.expiryDate
          ? "an expiry date has been recorded"
          : row.notRequired
            ? "it has been marked not required"
            : row.dutyHolder !== DUTY_HOLDER_UNCONFIRMED
              ? "somebody has confirmed whose obligation it is"
              : null;
      if (reason) kept.push({ id: row.id, kind: row.kind, reason });
      else removable.push(row.id);
    }
  }

  for (const chunk of chunkIds(removable)) {
    await db.delete(complianceDocuments).where(
      and(
        eq(complianceDocuments.organisationId, orgId),
        inArray(complianceDocuments.id, chunk),
        /*
         * THE GUARD IS REPEATED IN THE STATEMENT, not only in the read above.
         *
         * Between that read and this delete somebody can upload a certificate.
         * Re-stating the predicate makes the delete conditional on the row
         * still being empty at the moment it runs, so the race loses safely:
         * the row survives and the count comes back one lower.
         */
        isNull(complianceDocuments.attachmentId),
        isNull(complianceDocuments.expiryDate),
        eq(complianceDocuments.notRequired, false),
        or(
          eq(complianceDocuments.dutyHolder, DUTY_HOLDER_UNCONFIRMED),
          isNull(complianceDocuments.dutyHolder),
        ),
      ),
    );
  }

  await db.insert(activityLog).values({
    id: `activity-compliance-${batchId}-revert-${Date.now().toString(36)}`,
    organisationId: orgId,
    legacyClientId: orgId,
    entityType: "compliance_backfill",
    entityId: batchId,
    action: "compliance_backfill_reverted",
    actorEmail,
    detail: JSON.stringify({ removed: removable.length, kept: kept.length }),
  });

  return Response.json({
    batchId,
    removed: removable.length,
    kept: kept.length,
    /* Named, not just counted. "3 rows were kept" is not something an operator
       can act on; "Water Hygiene at Leeds Trinity, because a certificate has
       been attached" is. */
    keptRows: kept,
  });
}
