/**
 * `/api/calendar/status-map` — what a job status means, as editable data.
 *
 * GET is readable by anyone who can see the board, because the calendar cannot
 * draw a single chip without it. PATCH requires `settings.edit`: recolouring a
 * status changes what every reader of every calendar sees, and marking one
 * `counts_as_open = false` removes those jobs from the open figure and from the
 * unscheduled tray. That is an administrative act, not a per-record edit.
 *
 * ── THE MAP IS NEVER THE PLACE A STATUS IS INVENTED ────────────────────────
 *
 * There is no POST. A row can be edited and a row can be deactivated, but a new
 * mapping is only ever created for a label that already exists on a job — which
 * is why `GET` returns `unmapped` alongside `mappings`: the labels the board is
 * actually using that nobody has given a meaning to yet. An admin screen that
 * let somebody type a status name would invite a mapping for "Awaiting Parts"
 * that never matches the "Awaiting parts" the rows carry, and the job would go
 * on rendering grey while the screen insisted it was mapped.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { jobStatusMap, maintenanceRequests } from "../../../../db/schema";
import { anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../../lib/tenant-db";
import { databaseSafeFailure } from "../../../lib/database-failure";

export const dynamic = "force-dynamic";

const CHIP_STYLES = new Set(["solid", "outline", "hatched", "strikethrough"]);

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** `#RRGGBB` only. A colour is written into inline style, so it is validated. */
function colour(value: unknown): string | null {
  const raw = text(value, 7);
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : null;
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const { db, orgId } = await scopedDb(request);

    const mappings = await db
      .select()
      .from(jobStatusMap)
      .where(eq(jobStatusMap.organisationId, orgId))
      .orderBy(jobStatusMap.sortOrder);

    /*
     * The distinct statuses the board is actually using, so the caller can
     * raise "3 job statuses are unmapped" without loading every job to find
     * out. Live rows only — a status that survives on an archived job from two
     * years ago is not something anybody needs to map today.
     */
    const used = await db
      .select({ status: maintenanceRequests.status, count: sql<number>`count(*)` })
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.organisationId, orgId),
          eq(maintenanceRequests.archived, false),
          isNull(maintenanceRequests.deletedAt),
        ),
      )
      .groupBy(maintenanceRequests.status);

    const known = new Set(
      mappings
        .filter((row: { active: boolean }) => row.active)
        .map((row: { sourceStatusLabel: string }) =>
          row.sourceStatusLabel.trim().toLowerCase().replace(/\s+/g, " "),
        ),
    );
    const unmapped = used
      .filter((row: { status: string | null }) => {
        const label = (row.status ?? "").trim();
        return label.length > 0 && !known.has(label.toLowerCase().replace(/\s+/g, " "));
      })
      .map((row: { status: string | null; count: number }) => ({
        label: (row.status ?? "").trim(),
        jobs: Number(row.count) || 0,
      }));

    return Response.json({ mappings, unmapped });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const { status, message } = databaseSafeFailure(error, "The status map could not be read.");
    return Response.json({ error: message }, { status });
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "settings.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId, actor } = guard.scope;

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const id = text(body?.id, 120);
    if (!body || !id) return Response.json({ error: "Name the mapping." }, { status: 400 });

    /* Omitted is unchanged — the convention every write path here follows. */
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if ("displayLabel" in body) {
      const label = text(body.displayLabel, 120);
      if (!label) return Response.json({ error: "A mapping needs a label." }, { status: 400 });
      patch.displayLabel = label;
    }
    if ("colourHex" in body) {
      const hex = colour(body.colourHex);
      if (!hex) return Response.json({ error: "Use a #RRGGBB colour." }, { status: 400 });
      patch.colourHex = hex;
    }
    if ("icon" in body) patch.icon = text(body.icon, 40) || null;
    if ("chipStyle" in body && CHIP_STYLES.has(text(body.chipStyle, 20))) {
      patch.chipStyle = text(body.chipStyle, 20);
    }
    if ("countsAsOpen" in body) patch.countsAsOpen = body.countsAsOpen === true;
    if ("countsAsOverdueEligible" in body) {
      patch.countsAsOverdueEligible = body.countsAsOverdueEligible === true;
    }
    if ("sortOrder" in body) patch.sortOrder = Math.trunc(Number(body.sortOrder)) || 0;
    if ("active" in body) patch.active = body.active === true;
    patch.updatedByEmail = actor.email || null;

    await db
      .update(jobStatusMap)
      .set(patch)
      .where(and(eq(jobStatusMap.id, id), eq(jobStatusMap.organisationId, orgId)));

    const mappings = await db
      .select()
      .from(jobStatusMap)
      .where(eq(jobStatusMap.organisationId, orgId))
      .orderBy(jobStatusMap.sortOrder);
    return Response.json({ ok: true, mappings });
  } catch (error) {
    const { status, message } = databaseSafeFailure(error, "The mapping could not be saved.");
    return Response.json({ error: message }, { status });
  }
}
