/**
 * `GET /api/automations/runs?boardId=&automationId=` — the Run history.
 *
 * Real rows from `automation_runs`, newest first, capped. Empty when nothing
 * has run, and the screen says so rather than inventing an example. A run
 * whose rule has since been deleted is still listed, named by the sentence
 * stored on the run's audit trail where possible and "(deleted rule)"
 * otherwise.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { automationRuns, boardAutomations } from "../../../../db/schema";
import { normaliseBoardId } from "../../../lib/automations/store";
import { anonymousRefusal, scopedDbWithCapability } from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.view");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const url = new URL(request.url);
    const boardId = normaliseBoardId(url.searchParams.get("boardId") ?? url.searchParams.get("board"));
    const automationId = (url.searchParams.get("automationId") ?? "").trim().slice(0, 80);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);

    const conditions = [
      eq(automationRuns.organisationId, orgId),
      eq(automationRuns.boardId, boardId),
    ];
    if (automationId) conditions.push(eq(automationRuns.automationId, automationId));

    const rows = await db
      .select()
      .from(automationRuns)
      .where(and(...conditions))
      .orderBy(desc(automationRuns.createdAt))
      .limit(limit);

    const ruleIds = Array.from(new Set(rows.map((row) => row.automationId)));
    const rules = ruleIds.length
      ? await db
          .select({ id: boardAutomations.id, name: boardAutomations.name })
          .from(boardAutomations)
          .where(and(eq(boardAutomations.organisationId, orgId), inArray(boardAutomations.id, ruleIds)))
      : [];
    const nameById = new Map(rules.map((rule) => [rule.id, rule.name]));

    return Response.json({
      boardId,
      runs: rows.map((row) => ({
        id: row.id,
        automationId: row.automationId,
        automationName: nameById.get(row.automationId) ?? null,
        requestId: row.requestId,
        status: row.status,
        trigger: row.triggerSummary,
        action: row.actionSummary,
        error: row.error,
        depth: row.depth,
        chainId: row.chainId,
        actorEmail: row.actorEmail,
        createdAt: row.createdAt,
      })),
      total: rows.length,
    });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    console.error("[/api/automations/runs]", error);
    return Response.json({ error: "Run history is temporarily unavailable." }, { status: 503 });
  }
}
