/**
 * `GET /api/automations/usage?boardId=` — honest operational counts.
 *
 * Rules, enabled rules, runs this calendar month, failures this month, and
 * the last run. There is no quota and no billing tier on this product, and
 * this route says so in its payload rather than drawing a meter against an
 * invented ceiling.
 */

import { and, desc, eq, gte, sql } from "drizzle-orm";
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

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

    const rules = await db
      .select({ enabled: boardAutomations.enabled, runCount: boardAutomations.runCount })
      .from(boardAutomations)
      .where(and(eq(boardAutomations.organisationId, orgId), eq(boardAutomations.boardId, boardId)));

    const [month] = await db
      .select({
        runs: sql<number>`COUNT(*)`,
        failed: sql<number>`SUM(CASE WHEN ${automationRuns.status} = 'failed' THEN 1 ELSE 0 END)`,
        skipped: sql<number>`SUM(CASE WHEN ${automationRuns.status} = 'skipped' THEN 1 ELSE 0 END)`,
      })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.organisationId, orgId),
          eq(automationRuns.boardId, boardId),
          gte(automationRuns.createdAt, monthStart),
        ),
      );

    const [last] = await db
      .select({ createdAt: automationRuns.createdAt, status: automationRuns.status })
      .from(automationRuns)
      .where(and(eq(automationRuns.organisationId, orgId), eq(automationRuns.boardId, boardId)))
      .orderBy(desc(automationRuns.createdAt))
      .limit(1);

    return Response.json({
      boardId,
      rules: rules.length,
      enabled: rules.filter((rule) => rule.enabled === "on").length,
      totalRuns: rules.reduce((sum, rule) => sum + Number(rule.runCount ?? 0), 0),
      month: {
        since: monthStart,
        runs: Number(month?.runs ?? 0),
        failed: Number(month?.failed ?? 0),
        skipped: Number(month?.skipped ?? 0),
      },
      lastRun: last ? { at: last.createdAt, status: last.status } : null,
      // Said plainly, so the screen cannot imply a plan that does not exist.
      quota: null,
      note: "There is no run quota on this workspace. These are counts, not an allowance.",
    });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    console.error("[/api/automations/usage]", error);
    return Response.json({ error: "Usage is temporarily unavailable." }, { status: 503 });
  }
}
