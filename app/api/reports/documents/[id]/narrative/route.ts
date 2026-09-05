/**
 * `/api/reports/documents/[id]/narrative` — the prose blocks of one report.
 *
 * ── EVERY DRAFT PASSES THE VALIDATOR BEFORE IT IS STORED ───────────────────
 *
 * Module 4 §4.3: "an invented number in a client report is the worst thing this
 * system can do". So generation here is not "call the model, save the text".
 * `draftNarrativeBlock()` computes the locked figure set from the payload,
 * prompts against it, and runs `validateProseFigures()` over the reply — and
 * this route only ever reaches its write on `status: "generated"`. A draft with
 * an orphan number is answered 422 and NOT written: there is no row anywhere
 * carrying prose that failed the check, so no later reader has to know that
 * some stored drafts are trustworthy and some are not.
 *
 * ── WHY THIS TALKS TO `register_values` ────────────────────────────────────
 *
 * A dedicated `report_narrative_blocks` table is the right home and is what
 * this should become. It could not be added in this change — the schema was out
 * of scope — so the blocks live in `register_values` under the register key
 * `report_narrative`, which is an organisation-scoped
 * (register, entity, column) -> text store with exactly the unique index this
 * needs: one row per (document, block), so two operators editing two blocks
 * never contend, and the same block twice is one row rather than a duplicate.
 *
 * It is safe, and the reasons are worth writing down rather than assuming:
 * every reader and writer of `register_values` in this codebase filters on
 * `register_key`, and both the sites and contractors registers filter on their
 * own; `/api/registers/values` refuses any key but `sites` and `contractors`,
 * so nothing outside this file can forge a block and skip the validator; and
 * the trash sweeps delete by those two keys only, so a purged site cannot take
 * a report's narrative with it.
 *
 * ── LIFECYCLE ──────────────────────────────────────────────────────────────
 *
 * `document.edit` for every write, matching the rest of the generator: writing
 * the report is the Operations Manager's job. A Finalised or Voided document
 * refuses all four actions — "immutable" has to mean the API says no, not that
 * a button is greyed.
 */

import { and, eq } from "drizzle-orm";
import { registerValues } from "../../../../../../db/schema";
import { auditActor, recordAudit } from "../../../../../lib/audit";
import { REPORT_CAPABILITIES } from "../../../../../lib/reporting/access";
import {
  acceptedBlock,
  deterministicBlock,
  draftedBlock,
  editedBlock,
  emptyNarrativeBlock,
  narrativeReviewBlocker,
  narrativeReviewComplete,
  parseNarrativeBlockKey,
  plannedNarrativeBlocks,
  type NarrativeBlock,
  type NarrativeBlockSource,
  type NarrativeBlockState,
} from "../../../../../lib/reporting/narrative-blocks";
import {
  draftNarrativeBlock,
  MAX_NARRATIVE_PROSE,
  narrativeProviderStatus,
  reviewProseFigures,
} from "../../../../../lib/reporting/narrative-provider";
import {
  documentPayload,
  documentStatus,
  readInvoice,
} from "../../../../../lib/reporting/documents";
import {
  badRequest,
  guard,
  notFound,
  reportUnavailable,
  text,
  todayIso,
  visibleStatuses,
} from "../../../../../lib/reporting/route-helpers";

export const dynamic = "force-dynamic";

/**
 * The namespace inside `register_values`. Not `sites`, not `contractors`, so
 * no register UI and no trash sweep can see these rows. See the header.
 */
const NARRATIVE_REGISTER_KEY = "report_narrative";

/* eslint-disable @typescript-eslint/no-explicit-any -- the drizzle handle is
   assembled per driver; the schema import is what types these queries. */
type Db = any;

interface StoredBlock {
  prose: string;
  state: NarrativeBlockState;
  source: NarrativeBlockSource;
  providerId: string | null;
  updatedAt: string | null;
  updatedByEmail: string | null;
}

const STATES: NarrativeBlockState[] = ["empty", "ai-draft", "reviewed"];
const SOURCES: NarrativeBlockSource[] = ["none", "model", "human", "deterministic"];

/**
 * A stored row, read defensively.
 *
 * An unparseable or unrecognised row is treated as ABSENT rather than as an
 * error: the planned block still renders, empty, and the operator writes it
 * again. The alternative — 500 on the whole screen because one JSON blob is
 * malformed — takes the report down for a paragraph.
 *
 * An unknown STATE reads as `ai-draft`, deliberately the strict direction: a
 * block whose review state cannot be established has not been reviewed, and
 * finalisation should stay blocked until somebody looks at it.
 */
function parseStored(raw: string | null): StoredBlock | null {
  if (!raw) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const prose = typeof parsed.prose === "string" ? parsed.prose : "";
  if (!prose.trim()) return null;
  const state = STATES.includes(parsed.state as NarrativeBlockState)
    ? (parsed.state as NarrativeBlockState)
    : "ai-draft";
  const source = SOURCES.includes(parsed.source as NarrativeBlockSource)
    ? (parsed.source as NarrativeBlockSource)
    : "model";
  return {
    prose,
    state,
    source,
    providerId: typeof parsed.providerId === "string" ? parsed.providerId : null,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    updatedByEmail: typeof parsed.updatedByEmail === "string" ? parsed.updatedByEmail : null,
  };
}

async function readStoredBlocks(
  db: Db,
  organisationId: string,
  invoiceId: string,
): Promise<Map<string, StoredBlock>> {
  const rows = await db
    .select({ columnKey: registerValues.columnKey, value: registerValues.value })
    .from(registerValues)
    .where(
      and(
        eq(registerValues.organisationId, organisationId),
        eq(registerValues.registerKey, NARRATIVE_REGISTER_KEY),
        eq(registerValues.entityId, invoiceId),
      ),
    );
  const stored = new Map<string, StoredBlock>();
  for (const row of rows as Array<{ columnKey: string; value: string | null }>) {
    const parsed = parseStored(row.value);
    if (parsed) stored.set(row.columnKey, parsed);
  }
  return stored;
}

async function writeStoredBlock(
  db: Db,
  organisationId: string,
  invoiceId: string,
  block: NarrativeBlock,
): Promise<void> {
  const now = new Date().toISOString();
  const value = JSON.stringify({
    prose: block.prose,
    state: block.state,
    source: block.source,
    providerId: block.providerId,
    updatedAt: block.updatedAt,
    updatedByEmail: block.updatedByEmail,
  } satisfies StoredBlock);

  if (!block.prose.trim()) {
    /* An empty block is an ABSENT row, not a row holding "". The same rule the
       register cells follow: "never written" and "cleared" read the same on
       screen, so storing the difference only creates one to explain. */
    await db
      .delete(registerValues)
      .where(
        and(
          eq(registerValues.organisationId, organisationId),
          eq(registerValues.registerKey, NARRATIVE_REGISTER_KEY),
          eq(registerValues.entityId, invoiceId),
          eq(registerValues.columnKey, block.key),
        ),
      );
    return;
  }

  /* Upsert on the unique cell index. Two operators regenerating two blocks at
     once must not race each other into a constraint violation. */
  await db
    .insert(registerValues)
    .values({
      id: `narr_${crypto.randomUUID().replace(/-/g, "")}`,
      organisationId,
      registerKey: NARRATIVE_REGISTER_KEY,
      entityId: invoiceId,
      columnKey: block.key,
      value,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        registerValues.organisationId,
        registerValues.registerKey,
        registerValues.entityId,
        registerValues.columnKey,
      ],
      set: { value, updatedAt: now },
    });
}

/**
 * The planned blocks, with whatever has been written into them.
 *
 * PLANNED FIRST, ALWAYS. A stored row whose block the payload no longer plans —
 * a hold that was deleted, say — is dropped from the answer rather than
 * rendered: it describes something the document no longer contains, and leaving
 * it in would let a stale `ai-draft` block finalisation for a hold nobody can
 * see. The row is left in place rather than deleted, so restoring the hold
 * restores its explanation.
 */
function mergeBlocks(
  planned: ReturnType<typeof plannedNarrativeBlocks>,
  stored: Map<string, StoredBlock>,
): NarrativeBlock[] {
  return planned.map((entry) => {
    const base = emptyNarrativeBlock(entry);
    const found = stored.get(entry.key);
    if (!found) return base;
    return { ...base, ...found };
  });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const guarded = await guard(request, REPORT_CAPABILITIES["document.read"]);
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;

    const invoice = await readInvoice(scope.db, scope.orgId, id);
    if (!invoice) return notFound();
    const statuses = await visibleStatuses(scope);
    if (!statuses.includes(documentStatus(invoice))) return notFound();

    const result = await documentPayload(scope.db, {
      organisationId: scope.orgId,
      organisationName: scope.organisation.name,
      invoice,
      todayIso: todayIso(),
    });
    if ("error" in result) return Response.json({ error: result.error }, { status: 500 });

    const blocks = mergeBlocks(
      plannedNarrativeBlocks(result.payload),
      await readStoredBlocks(scope.db, scope.orgId, id),
    );

    return Response.json({
      blocks,
      /* A boolean and a sentence. Never the resolution — see the provider's
         header on why the secret stops at that function. */
      provider: await narrativeProviderStatus(),
      reviewComplete: narrativeReviewComplete(blocks),
      blocker: narrativeReviewBlocker(blocks),
    });
  } catch (error) {
    return reportUnavailable(error);
  }
}

type Action = "generate" | "accept" | "edit" | "clear" | "use-computed";

const ACTIONS: Action[] = ["generate", "accept", "edit", "clear", "use-computed"];

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const guarded = await guard(request, REPORT_CAPABILITIES["document.edit"]);
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return badRequest("Send a JSON body.");

    const action = ACTIONS.includes(body.action as Action) ? (body.action as Action) : null;
    if (!action) {
      return badRequest(`Name the action: ${ACTIONS.join(", ")}.`);
    }
    const blockKey = text(body.blockKey, 200);
    if (!blockKey) return badRequest("Name the narrative block.");
    if (!parseNarrativeBlockKey(blockKey)) {
      return badRequest("That is not a narrative block this report has.");
    }

    const invoice = await readInvoice(scope.db, scope.orgId, id);
    if (!invoice) return notFound();
    const status = documentStatus(invoice);
    if (status === "Finalised" || status === "Voided") {
      return Response.json(
        {
          error: `A ${status.toLowerCase()} document cannot be changed. Void it and raise a new one to rewrite its narrative.`,
        },
        { status: 409 },
      );
    }

    const result = await documentPayload(scope.db, {
      organisationId: scope.orgId,
      organisationName: scope.organisation.name,
      invoice,
      todayIso: todayIso(),
    });
    if ("error" in result) return Response.json({ error: result.error }, { status: 500 });
    const payload = result.payload;

    const planned = plannedNarrativeBlocks(payload);
    const entry = planned.find((candidate) => candidate.key === blockKey);
    if (!entry) {
      return badRequest("That narrative block is not part of this document.");
    }

    const stored = await readStoredBlocks(scope.db, scope.orgId, id);
    const current = mergeBlocks([entry], stored)[0];
    const now = new Date().toISOString();
    const email = scope.identityEmail ?? null;

    let next: NarrativeBlock;
    let auditAction: string;
    let summary: string;
    let advisory: ReturnType<typeof reviewProseFigures> | null = null;

    switch (action) {
      case "generate": {
        const outcome = await draftNarrativeBlock({
          payload,
          blockKey,
          guidance: text(body.guidance, 400),
        });
        if (outcome.status === "unavailable") {
          /* 503, not 500 and not a silent no-op: nothing the caller did is
             wrong, the deployment has no provider, and the sentence says so. */
          return Response.json(
            { error: outcome.message, reason: outcome.reason, provider: await narrativeProviderStatus() },
            { status: 503 },
          );
        }
        if (outcome.status === "refused") {
          /*
           * 422 and NOTHING IS WRITTEN. §4.3's hard stop. The orphan tokens go
           * back so the panel can name them — an operator shown which figure
           * was invented understands the safeguard; one shown "generation
           * failed" learns to click again until it passes.
           */
          return Response.json(
            {
              error: outcome.message,
              orphans: outcome.validation.orphans,
              hedges: outcome.validation.hedges,
            },
            { status: 422 },
          );
        }
        if (outcome.status === "unknown-block") return badRequest(outcome.message);
        if (outcome.status === "failed") {
          return Response.json({ error: outcome.message }, { status: 502 });
        }
        next = draftedBlock(current, outcome.prose, outcome.providerId, now);
        advisory = outcome.validation;
        auditAction = "report.narrative_generated";
        summary = `Generated the "${current.title}" narrative block with ${outcome.providerId}. Every figure in it was checked against the report's data.`;
        break;
      }

      case "accept": {
        if (!current.prose.trim()) {
          return badRequest("There is nothing to accept in that block yet.");
        }
        next = acceptedBlock(current, email, now);
        auditAction = "report.narrative_reviewed";
        summary = `Accepted the AI draft of the "${current.title}" narrative block.`;
        break;
      }

      case "edit": {
        const prose = typeof body.prose === "string" ? body.prose : null;
        if (prose === null) return badRequest("Send the prose to save.");
        if (prose.length > MAX_NARRATIVE_PROSE) {
          return badRequest(
            `That is longer than ${MAX_NARRATIVE_PROSE} characters. Narrative blocks are paragraphs, not documents.`,
          );
        }
        next = editedBlock(current, prose, email, now);
        /* Advisory only. A person editing the report is its source of truth —
           see `reviewProseFigures`. The findings are returned, not enforced. */
        advisory = reviewProseFigures(payload, blockKey, next.prose);
        auditAction = "report.narrative_edited";
        summary = `Edited the "${current.title}" narrative block.`;
        break;
      }

      case "clear": {
        next = editedBlock(current, "", email, now);
        auditAction = "report.narrative_cleared";
        summary = `Cleared the "${current.title}" narrative block.`;
        break;
      }

      case "use-computed": {
        /*
         * The deterministic summary, which needs no provider and no review.
         *
         * `maintenance.executive.narrative` is built by `narrative.ts` from the
         * counts — every sentence derivable from a figure in this payload, by
         * code in this repository. It is offered for the executive summary only
         * because that is the only block the engine computes prose for; the
         * others have no computed equivalent and offering an empty one would be
         * a button that does nothing.
         */
        if (entry.kind !== "executive-summary") {
          return badRequest(
            "Only the executive summary has a computed version. The other blocks are written by hand or drafted.",
          );
        }
        const sentences = payload.maintenance.executive.narrative;
        if (!sentences.length) {
          return badRequest("The engine produced no computed summary for this period.");
        }
        next = deterministicBlock(current, sentences.join(" "), now);
        advisory = reviewProseFigures(payload, blockKey, next.prose);
        auditAction = "report.narrative_computed";
        summary = `Used the computed executive summary for the "${current.title}" narrative block.`;
        break;
      }

      default:
        return badRequest("Unknown action.");
    }

    await writeStoredBlock(scope.db, scope.orgId, id, next);

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: auditAction,
      entityType: "invoice",
      entityId: id,
      summary,
      detail: { blockKey, state: next.state, source: next.source },
      request,
    });

    const blocks = mergeBlocks(
      planned,
      await readStoredBlocks(scope.db, scope.orgId, id),
    );

    return Response.json({
      block: next,
      blocks,
      reviewComplete: narrativeReviewComplete(blocks),
      blocker: narrativeReviewBlocker(blocks),
      /* What the validator saw. Present on an edit as advice, on a generation
         as evidence that the check ran and passed. */
      validation: advisory
        ? { ok: advisory.ok, orphans: advisory.orphans, hedges: advisory.hedges }
        : null,
    });
  } catch (error) {
    return reportUnavailable(error);
  }
}
