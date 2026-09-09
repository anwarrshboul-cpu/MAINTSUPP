/**
 * THE RESPONSIBILITY QUEUE — the requirements waiting on somebody to say whose
 * obligation they are, and the one place they can be answered in bulk.
 *
 * ── WHY A SECOND WRITE PATH AT ALL ────────────────────────────────────────
 *
 * `PATCH /api/workspace {entity:"compliance"}` can already set one duty holder,
 * and it is not being replaced. But it cannot serve this screen, for three
 * reasons that are properties of that endpoint rather than opinions about it:
 *
 *   1. It is a FULL REPLACE. `state` and `expiry` are required — deliberately,
 *      because the calendar's drag sends them together and an omitted key there
 *      is an erasure. Confirming a responsibility means resending a status and
 *      a date the reader never looked at, and any drift between what the screen
 *      last read and what is in the row is written back as fact.
 *   2. It is ONE ROW PER REQUEST. Clearing a twelve-site backlog is 144
 *      requests, each with its own chance of half-finishing.
 *   3. It addresses a row by `compliance_documents.id`, so it cannot reach a
 *      requirement the BOARD speaks for — those have no annotation row until
 *      somebody makes one, which is exactly what confirming is.
 *
 * This endpoint changes ONE FIELD, addresses a requirement the way the register
 * itself addresses it (site × requirement name), and creates the annotation row
 * when there is not one yet.
 *
 * ── HOW A REQUIREMENT IS ADDRESSED, AND WHY NOT BY id ─────────────────────
 *
 * By `{siteId, kind}` — `registerByKey` in `compliance-register.ts` is built on
 * exactly that pair, and it is the only address that names a board-derived
 * requirement and a register-only one in the same words. An `id` cannot: a
 * board-derived entry's id is `registerDocumentId(itemId, slotKey)`, a
 * synthesised string with no row behind it, so half the register would be
 * unaddressable.
 *
 * ── THE ALLOW-LIST IS THE REGISTER ITSELF ─────────────────────────────────
 *
 * Every pair in a request is resolved against `readComplianceRegister`, and
 * anything that is not already a requirement of this organisation is refused
 * rather than created. That is what stops this endpoint being a way to mint
 * arbitrary rows in `compliance_documents` — a `kind` of three zero-width
 * spaces has done exactly that through another route, and the fix there was to
 * scrub the text. Here there is no free text to scrub: a name that names
 * nothing simply matches nothing.
 *
 * ── THE VARIABLE CAP ──────────────────────────────────────────────────────
 *
 * D1 binds one variable per COLUMN per row, not one per row, and refuses past
 * roughly a hundred. Every statement below goes through `chunkIds` /
 * `chunkRows`; the inserts go through `ensureComplianceProfile`, which owns that
 * arithmetic already and whose 144-variable failure is written up in
 * `app/lib/compliance-profile.ts`. Nothing here rebuilds it.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { getDb } from "../../../../db";
import { ensureDatabase } from "../../../../db/init";
import { activityLog, complianceDocuments, sites } from "../../../../db/schema";
import { anonymousRefusal, scopedDbWithCapability } from "../../../lib/tenant-db";
import { readComplianceRegister } from "../../../lib/compliance-register";
import { ensureComplianceProfile } from "../../../lib/compliance-profile";
import {
  DUTY_HOLDERS,
  DUTY_HOLDER_UNCONFIRMED,
  dutyHolderLabel,
  isDutyHolder,
  notRequiredAfterDutyHolder,
  responsibilityCoverage,
} from "../../../lib/compliance-duty-holder";
import {
  filterComplianceRows,
  parseComplianceFilters,
  responsibilityFor,
  type ComplianceRow,
} from "../../../lib/compliance-view";
import { chunkIds } from "../../../lib/sql-batching";

export const dynamic = "force-dynamic";

/**
 * How many requirements one request may set.
 *
 * Not a variable-cap number — the chunking below handles any size — but a blast
 * radius. 500 is comfortably more than "every unconfirmed requirement on the
 * biggest site group on screen" and far less than "silently restate the whole
 * estate from one mis-click".
 */
const MAX_RECORDS = 500;

/** The drizzle handle, typed exactly as `compliance-register.ts` types it. */
type Database = Awaited<ReturnType<typeof getDb>>;

type Pair = { siteId: string; kind: string };

const pairKey = (siteId: string, kind: string) => `${siteId}::${kind}`;

/**
 * The rows of the register as `ComplianceRow`, which is what the filters take.
 *
 * The same projection the summary and records routes do, and for the same
 * reason: `filterComplianceRows` needs `responsibility` (who CHASES it) even
 * though this screen is about the other axis, because the register's `?who=`
 * chip has to keep meaning what it means when the reader switches view.
 */
async function registerRows(db: Database, orgId: string, today: Date) {
  const [register, siteRows] = await Promise.all([
    readComplianceRegister(db, orgId, { today }),
    db
      .select({ id: sites.id, manager: sites.manager, managerName: sites.managerName })
      .from(sites)
      .where(and(eq(sites.organisationId, orgId))),
  ]);
  const managerById = new Map(
    siteRows.map((row) => [row.id, (row.managerName || row.manager || "").trim()]),
  );
  const rows: ComplianceRow[] = register.entries.map((entry) => ({
    id: entry.id,
    siteId: entry.siteId,
    siteName: entry.siteName,
    kind: entry.kind,
    responsibility: responsibilityFor(entry.kind, managerById.get(entry.siteId) ?? ""),
    dutyHolder: entry.dutyHolder,
    state: entry.state,
    expiry: entry.expiry,
    fileCount: entry.fileCount,
    /* Both halves of the board address, the same predicate as the two sibling
       routes. A responsibility can be set on either kind of row — that is the
       point of this endpoint — but the SCREEN still needs to know which rows
       the board speaks for, because those cannot be edited any other way. */
    editable: !(Boolean(entry.itemId) && Boolean(entry.slotKey)),
  }));
  return rows;
}

/**
 * GET — the queue, grouped by site, plus the coverage sentence.
 *
 * ── WHAT IS IN THE QUEUE, AND WHAT IS DELIBERATELY NOT ────────────────────
 *
 * Only requirements sitting at the stored placeholder `"unconfirmed"`. A NULL
 * duty holder is a DIFFERENT fact — nobody has ever been asked — and every row
 * that predates the column is one. Sweeping those into a "confirm these" list
 * would invite one afternoon of clicking to restate the compliance figure for
 * an estate nobody had changed, which is the failure `compliance-duty-holder.ts`
 * opens by arguing against. They remain answerable one at a time from the
 * register's own per-requirement control, which is a decision somebody makes
 * about a requirement they are looking at.
 *
 * A board-derived requirement never appears here either, and that falls out of
 * the model rather than being filtered for: `readComplianceRegister` runs a
 * board row's annotation through `boardDutyHolder`, which reads the placeholder
 * off precisely because a board row IS the answer it was waiting for.
 */
export async function GET(request: Request) {
  try {
    await ensureDatabase();
    /* `board.view` — the same capability as the register this queue is a view
       of. Reading which responsibilities are outstanding is not a wider
       permission than reading the register itself. */
    const guard = await scopedDbWithCapability(request, "board.view");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;

    const url = new URL(request.url);
    const filters = parseComplianceFilters(url);
    const today = new Date();
    const rows = await registerRows(db, orgId, today);
    const filtered = filterComplianceRows(rows, filters, today);

    const bySite = new Map<string, ComplianceRow[]>();
    for (const row of filtered) {
      const list = bySite.get(row.siteId);
      if (list) list.push(row);
      else bySite.set(row.siteId, [row]);
    }

    const groups = [...bySite]
      .map(([siteId, siteRows]) => ({
        siteId,
        siteName: siteRows[0]?.siteName ?? siteId,
        /* Coverage over the site's WHOLE set, not just its queue — "3 of 12
           confirmed" is only meaningful against everything there is to
           confirm. */
        coverage: responsibilityCoverage(siteRows),
        records: siteRows
          .filter((row) => row.dutyHolder === DUTY_HOLDER_UNCONFIRMED)
          .sort((left, right) => left.kind.localeCompare(right.kind, "en-GB"))
          .map((row) => ({
            id: row.id,
            siteId: row.siteId,
            kind: row.kind,
            state: row.state,
            expiry: row.expiry,
            dutyHolder: row.dutyHolder,
          })),
      }))
      /* A site with nothing outstanding is not in the queue. It still counts
         towards the coverage sentence above, which is computed over every row
         before this filter. */
      .filter((group) => group.records.length > 0)
      .sort(
        (left, right) =>
          right.records.length - left.records.length ||
          left.siteName.localeCompare(right.siteName, "en-GB"),
      );

    return Response.json({
      /* The sentence itself, computed on the server so the register header, the
         group headers and the queue cannot print three different answers. */
      coverage: responsibilityCoverage(filtered),
      outstanding: groups.reduce((total, group) => total + group.records.length, 0),
      /* Unfiltered, so the header can say "showing 40 of 204" rather than
         quietly redefining the estate every time somebody ticks a box. */
      registerTotal: rows.length,
      groups,
    });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json(
      {
        error:
          process.env.NODE_ENV === "development"
            ? `Preview database error: ${message}`
            : "The responsibility queue is temporarily unavailable.",
      },
      { status: 503 },
    );
  }
}

/**
 * POST — set the duty holder on one requirement or on many.
 *
 * One field, many rows, one answer. `dutyHolder: null` clears back to "never
 * asked", which is a legitimate thing to do on purpose and is why the key is
 * validated as "one of the four, or explicitly null" rather than as a
 * non-empty string.
 *
 * NOT idempotent-by-accident: a pair already carrying the requested value is
 * counted as `unchanged` and no statement is written for it, so pressing Apply
 * twice costs one round trip and no rows.
 */
export async function POST(request: Request) {
  try {
    await ensureDatabase();
    /* `board.edit`. Confirming a responsibility moves a requirement into or out
       of the compliance percentage, which is a change to the estate's record —
       the same capability the board's own cells are written under, and not a
       new one an administrator would have to keep in step by hand. */
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { actor, db, orgId } = guard.scope;

    const body = (await request.json().catch(() => null)) as
      | { dutyHolder?: unknown; records?: unknown }
      | null;
    if (!body || typeof body !== "object") {
      return Response.json({ error: "Send a JSON body." }, { status: 400 });
    }

    /*
     * THE ONE FIELD, VALIDATED AGAINST THE VOCABULARY AND NOTHING ELSE.
     *
     * `null` clears; the four answers set. `"unconfirmed"` is refused even
     * though the column legally holds it — it is the machine's statement that
     * nobody has answered, and letting a caller write it would let a person
     * "confirm" a requirement into the waiting state it is already in.
     */
    const raw = body.dutyHolder;
    const dutyHolder = raw === null || raw === "" ? null : raw;
    if (dutyHolder !== null && !isDutyHolder(dutyHolder)) {
      return Response.json(
        { error: `A responsibility must be one of: ${DUTY_HOLDERS.join(", ")}, or null to clear it.` },
        { status: 400 },
      );
    }

    const requested = Array.isArray(body.records) ? body.records : null;
    if (!requested || !requested.length) {
      return Response.json(
        { error: "Choose at least one requirement to set." },
        { status: 400 },
      );
    }
    if (requested.length > MAX_RECORDS) {
      return Response.json(
        { error: `Set at most ${MAX_RECORDS} requirements at once.` },
        { status: 400 },
      );
    }

    const pairs: Pair[] = [];
    const seen = new Set<string>();
    for (const entry of requested) {
      if (!entry || typeof entry !== "object") continue;
      const siteId = typeof (entry as Pair).siteId === "string" ? (entry as Pair).siteId : "";
      const kind = typeof (entry as Pair).kind === "string" ? (entry as Pair).kind : "";
      if (!siteId || !kind) continue;
      const key = pairKey(siteId, kind);
      /* De-duplicated before anything is resolved: the same requirement twice
         in one payload would otherwise be counted twice in the reply and,
         worse, could appear in two different update groups. */
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ siteId, kind });
    }
    if (!pairs.length) {
      return Response.json(
        { error: "Each requirement needs a site and a requirement name." },
        { status: 400 },
      );
    }

    const today = new Date();
    const rows = await registerRows(db, orgId, today);
    const known = new Map(rows.map((row) => [pairKey(row.siteId, row.kind), row]));

    const targets: Pair[] = [];
    let skipped = 0;
    for (const pair of pairs) {
      if (known.has(pairKey(pair.siteId, pair.kind))) targets.push(pair);
      else skipped += 1;
    }
    if (!targets.length) {
      return Response.json(
        { error: "None of those requirements are on this register." },
        { status: 404 },
      );
    }

    /*
     * The STORED value, which is not always the value the register reported.
     *
     * `readComplianceRegister` runs a board-derived row's annotation through
     * `boardDutyHolder`, which hides the "unconfirmed" placeholder — correctly,
     * for reading. Writing has to see what is actually in the column, because
     * `notRequiredAfterDutyHolder` turns on whether the answer being withdrawn
     * was "not applicable".
     *
     * Read for the whole organisation with no `IN` list, which is the same
     * unbounded read `readComplianceRegister` itself does one statement
     * earlier. A per-pair `IN` list would be the thing that needs chunking; not
     * building one is cheaper and cannot go wrong.
     */
    const stored = (await db
      .select({
        id: complianceDocuments.id,
        siteId: complianceDocuments.siteId,
        kind: complianceDocuments.kind,
        dutyHolder: complianceDocuments.dutyHolder,
        notRequired: complianceDocuments.notRequired,
      })
      .from(complianceDocuments)
      .where(eq(complianceDocuments.organisationId, orgId))) as Array<{
      id: string;
      siteId: string;
      kind: string;
      dutyHolder: string | null;
      notRequired: boolean;
    }>;
    /*
     * A MULTIMAP, BECAUSE (site, kind) IS NOT UNIQUE IN THIS TABLE.
     *
     * There is no unique index on (organisation, site, kind) — `db/init.ts` is
     * additive only and the monday import already left duplicates — and
     * `readComplianceRegister`'s second loop emits EVERY uncovered register row,
     * so a duplicated pair appears in the register TWICE and is counted twice.
     * Writing to one of them would leave the other at "unconfirmed", still in
     * this queue, still out of the percentage, and the change would look as
     * though it had not taken.
     *
     * So every row for a pair gets the same answer. `new Map(rows.map(...))`,
     * which is what a first cut writes, silently keeps only the last.
     */
    const storedByKey = new Map<string, typeof stored>();
    for (const row of stored) {
      const key = pairKey(row.siteId, row.kind);
      const list = storedByKey.get(key);
      if (list) list.push(row);
      else storedByKey.set(key, [row]);
    }

    /*
     * A requirement the BOARD speaks for has no annotation row until somebody
     * confirms it, and confirming it is what makes one. Created through
     * `ensureComplianceProfile` rather than by a second insert here: it owns the
     * deterministic id that makes a racing writer collide instead of minting a
     * thirteenth requirement, and it owns the row-width arithmetic that a
     * hand-rolled insert would have to restate — the same 144-variable failure.
     *
     * NOT created when the request is `null`. "Clear this back to never asked"
     * on a requirement nobody has ever recorded is already true, and writing a
     * row to say so would put a placeholder into the register for no change.
     */
    const missing = targets.filter((pair) => !storedByKey.has(pairKey(pair.siteId, pair.kind)));
    let created = 0;
    if (dutyHolder !== null && missing.length) {
      const kindsBySite = new Map<string, string[]>();
      for (const pair of missing) {
        const list = kindsBySite.get(pair.siteId);
        if (list) list.push(pair.kind);
        else kindsBySite.set(pair.siteId, [pair.kind]);
      }
      for (const [siteId, kinds] of kindsBySite) {
        const result = await ensureComplianceProfile(db, orgId, siteId, { kinds });
        created += result.created.length;
      }
      /* Re-resolved rather than predicted. `ensureComplianceProfile` decides
         the id, and a row that already existed under a kind this pass did not
         see must be updated, not double-created. */
      const refreshed = (await db
        .select({
          id: complianceDocuments.id,
          siteId: complianceDocuments.siteId,
          kind: complianceDocuments.kind,
          dutyHolder: complianceDocuments.dutyHolder,
          notRequired: complianceDocuments.notRequired,
        })
        .from(complianceDocuments)
        .where(eq(complianceDocuments.organisationId, orgId))) as typeof stored;
      storedByKey.clear();
      for (const row of refreshed) {
        const key = pairKey(row.siteId, row.kind);
        const list = storedByKey.get(key);
        if (list) list.push(row);
        else storedByKey.set(key, [row]);
      }
    }

    /*
     * THREE UPDATE SHAPES, because `not_required` follows the answer that set
     * it — see `notRequiredAfterDutyHolder`. Grouping by the resulting flag is
     * what keeps this to three statements per chunk instead of one per row.
     */
    const setTrue: string[] = [];
    const setFalse: string[] = [];
    const leaveFlag: string[] = [];
    const touchedSites = new Map<string, number>();
    let unchanged = 0;
    let updatedPairs = 0;

    for (const pair of targets) {
      const rowsForPair = storedByKey.get(pairKey(pair.siteId, pair.kind)) ?? [];
      /* Only reachable when the request is a clear (`null`) against a
         board-derived requirement with no annotation — nothing to clear. */
      if (!rowsForPair.length) {
        unchanged += 1;
        continue;
      }
      let touched = false;
      for (const row of rowsForPair) {
        const flag = notRequiredAfterDutyHolder(row.dutyHolder, dutyHolder, row.notRequired);
        /* Already carrying the answer, so no statement is written for it —
           which is what makes pressing Apply twice cost one round trip and no
           rows. */
        if (row.dutyHolder === dutyHolder && row.notRequired === flag) continue;
        if (flag !== row.notRequired) (flag ? setTrue : setFalse).push(row.id);
        else leaveFlag.push(row.id);
        touched = true;
      }
      if (!touched) {
        unchanged += 1;
        continue;
      }
      /* Counted per REQUIREMENT, not per row: the reader selected twelve
         requirements and the reply has to say twelve, whether or not the table
         happens to hold two rows for one of them. */
      updatedPairs += 1;
      touchedSites.set(pair.siteId, (touchedSites.get(pair.siteId) ?? 0) + 1);
    }

    const now = new Date().toISOString();
    const applyTo = async (ids: string[], flag: boolean | null) => {
      /* `chunkIds` at its default 90, which leaves margin under the
         hundred-variable floor for the handful of bound values in the same
         statement — the organisation filter and the SET list. */
      for (const chunk of chunkIds(ids)) {
        await db
          .update(complianceDocuments)
          .set({
            dutyHolder,
            ...(flag === null ? {} : { notRequired: flag }),
            updatedAt: now,
          })
          .where(
            and(
              eq(complianceDocuments.organisationId, orgId),
              inArray(complianceDocuments.id, chunk),
            ),
          );
      }
    };
    await applyTo(setTrue, true);
    await applyTo(setFalse, false);
    await applyTo(leaveFlag, null);

    /* Requirements, not rows. `rowsWritten` is the statement count and exists so
       a duplicate pair is visible to whoever reads a log, rather than hidden
       inside a number that says twelve. */
    const updated = updatedPairs;
    const rowsWritten = setTrue.length + setFalse.length + leaveFlag.length;

    /*
     * ONE AUDIT LINE PER SITE, not per requirement.
     *
     * A twelve-site bulk confirm writing 144 activity rows would bury every
     * other event on those sites, and the interesting fact is "somebody
     * confirmed twelve requirements at Cabot Circus as the landlord's" rather
     * than twelve copies of it. Bounded by the number of sites, so the audit
     * cannot become the expensive half of the request.
     */
    for (const [siteId, count] of touchedSites) {
      await db.insert(activityLog).values({
        /* Timestamp plus a random suffix: `Date.now()` has millisecond
           resolution and two saves inside one millisecond built the same
           primary key, which failed the insert AFTER the update had landed.
           Same shape as `logChange` in /api/sites. */
        id: `activity-compliance-${siteId}-${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 8)}`,
        organisationId: orgId,
        entityType: "site",
        entityId: siteId,
        action: "compliance_responsibility_set",
        actorEmail: actor.email,
        detail: JSON.stringify({ dutyHolder, label: dutyHolderLabel(dutyHolder), count }).slice(
          0,
          4000,
        ),
      });
    }

    return Response.json({
      ok: true,
      dutyHolder,
      /* The words, from the one function allowed to decide them, so a toast
         cannot invent a fifth spelling of "Shopping centre". */
      label: dutyHolderLabel(dutyHolder),
      updated,
      rowsWritten,
      created,
      unchanged,
      /* Requested but not on this register. Reported rather than silently
         dropped: a queue that was stale when Apply was pressed is exactly when
         this is non-zero, and the reader needs to know some of the selection
         did not land. */
      skipped,
    });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json(
      {
        error:
          process.env.NODE_ENV === "development"
            ? `Preview database error: ${message}`
            : "That responsibility could not be saved.",
      },
      { status: 503 },
    );
  }
}
