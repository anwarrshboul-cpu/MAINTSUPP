/**
 * `/api/automations` — the rules on one board.
 *
 *   GET    ?boardId=   the rules, with counts; also kicks the time-based sweep
 *   POST               create a rule
 *   PATCH              enable/disable, rename, description, importance, edit
 *   DELETE ?id=        remove a rule (its run history stays)
 *
 * Reading needs `board.view` — the rules describe the board. Writing needs
 * `board.edit`, the capability that manages the board itself; a rule changes
 * the board on the writer's behalf, so whoever may not change the board may
 * not set rules on it either. Everything is scoped to the caller's
 * organisation by `scopedDb` and to one board by an allow-listed id.
 */

import { and, eq } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import { boardAutomations } from "../../../db/schema";
import { auditActor, recordAudit } from "../../lib/audit";
import { automationContext, sweepTimeBasedRules } from "../../lib/automations";
import {
  boardVocabulary,
  currentCatalog,
  exposeRule,
  exposeVocabulary,
  findRule,
  listRules,
  normaliseBoardId,
  normaliseImportance,
  templatesFor,
  validateRule,
} from "../../lib/automations/store";
import { parseConfig } from "../../lib/automations/types";
import { anonymousRefusal, scopedDbWithCapability } from "../../lib/tenant-db";

export const dynamic = "force-dynamic";

function unavailable(error: unknown) {
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  console.error("[/api/automations]", error);
  return Response.json({ error: "Automations are temporarily unavailable." }, { status: 503 });
}

function text(value: unknown, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.view");
    if (guard.denied) return guard.denied;
    const scope = guard.scope;
    const url = new URL(request.url);
    const boardId = normaliseBoardId(url.searchParams.get("boardId") ?? url.searchParams.get("board"));

    /*
     * Opening the board is when time-based rules get their chance. The sweep
     * rate-limits itself to once per ten minutes per workspace and never
     * throws; a failure here is logged and the list still answers.
     */
    const sweep = await sweepTimeBasedRules(automationContext(scope, request)).catch((cause) => {
      console.error("[/api/automations] sweep", cause);
      return null;
    });

    const rules = await listRules(scope.db, scope.orgId, boardId);
    const { columns, groups } = await boardVocabulary(scope.db, scope.orgId, boardId);
    const canManage =
      (await scopedDbWithCapability(request, "board.edit")).denied === undefined;
    return Response.json({
      boardId,
      rules: rules.map(exposeRule),
      counts: {
        total: rules.length,
        enabled: rules.filter((rule) => rule.enabled === "on").length,
      },
      canManage,
      vocabulary: exposeVocabulary(columns, groups),
      templates: templatesFor(boardId),
      sweep,
    });
  } catch (error) {
    return unavailable(error);
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId, actor, identityEmail, session } = guard.scope;
    const body = record(await request.json().catch(() => ({})));
    const boardId = normaliseBoardId(body.boardId);
    const { columns, groups } = await boardVocabulary(db, orgId, boardId);
    const outcome = validateRule(currentCatalog(), columns, groups, {
      triggerType: text(body.triggerType, 60),
      triggerConfig: record(body.triggerConfig),
      actionType: text(body.actionType, 60),
      actionConfig: record(body.actionConfig),
    });
    if (!outcome.ok) return Response.json({ error: outcome.error }, { status: 400 });

    const importance = normaliseImportance(body.importance) ?? "minor";
    const now = new Date().toISOString();
    const [created] = await db
      .insert(boardAutomations)
      .values({
        id: `auto_${crypto.randomUUID().replace(/-/g, "")}`,
        organisationId: orgId,
        boardId,
        name: outcome.name.slice(0, 300),
        triggerType: text(body.triggerType, 60),
        triggerConfig: JSON.stringify(outcome.triggerConfig),
        actionType: text(body.actionType, 60),
        actionConfig: JSON.stringify(outcome.actionConfig),
        enabled: body.enabled === false ? "off" : "on",
        importance,
        description: text(body.description, 600) || null,
        createdBy: identityEmail || actor.email || null,
        runCount: 0,
        lastRunAt: null,
        lastSweepAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor({ actor, identityEmail, session }),
      action: "automation.created",
      entityType: "board_automation",
      entityId: created.id,
      summary: `Created the automation "${created.name}" on ${boardId}.`,
      detail: { board: boardId, trigger: created.triggerType, action: created.actionType },
      request,
    });
    return Response.json({ rule: exposeRule(created) }, { status: 201 });
  } catch (error) {
    return unavailable(error);
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId, actor, identityEmail, session } = guard.scope;
    const body = record(await request.json().catch(() => ({})));
    const id = text(body.id, 80);
    const existing = id ? await findRule(db, orgId, id) : null;
    if (!existing) return Response.json({ error: "That automation is not on this board." }, { status: 404 });

    const changes: Partial<typeof boardAutomations.$inferInsert> = {
      updatedAt: new Date().toISOString(),
    };
    const changed: string[] = [];
    if (typeof body.enabled === "boolean") {
      changes.enabled = body.enabled ? "on" : "off";
      changed.push(body.enabled ? "enabled" : "disabled");
    }
    if (typeof body.name === "string") {
      const name = text(body.name, 300);
      if (name.length < 3) return Response.json({ error: "Give the automation a name." }, { status: 400 });
      changes.name = name;
      changed.push("renamed");
    }
    if (typeof body.description === "string" || body.description === null) {
      changes.description = text(body.description, 600) || null;
      changed.push("description");
    }
    if (body.importance !== undefined) {
      const importance = normaliseImportance(body.importance);
      if (!importance) return Response.json({ error: "Importance is minor, major or critical." }, { status: 400 });
      changes.importance = importance;
      changed.push("importance");
    }
    /*
     * Editing the rule itself goes back through validation, and the stored
     * name is recomposed unless the caller had renamed it by hand — a rule
     * whose sentence no longer describes it is worse than one with a plain
     * name.
     */
    if (body.triggerType !== undefined || body.actionType !== undefined || body.triggerConfig !== undefined || body.actionConfig !== undefined) {
      const { columns, groups } = await boardVocabulary(db, orgId, existing.boardId);
      const outcome = validateRule(currentCatalog(), columns, groups, {
        triggerType: text(body.triggerType, 60) || existing.triggerType,
        triggerConfig: body.triggerConfig !== undefined ? record(body.triggerConfig) : parseConfig(existing.triggerConfig),
        actionType: text(body.actionType, 60) || existing.actionType,
        actionConfig: body.actionConfig !== undefined ? record(body.actionConfig) : parseConfig(existing.actionConfig),
      });
      if (!outcome.ok) return Response.json({ error: outcome.error }, { status: 400 });
      changes.triggerType = text(body.triggerType, 60) || existing.triggerType;
      changes.triggerConfig = JSON.stringify(outcome.triggerConfig);
      changes.actionType = text(body.actionType, 60) || existing.actionType;
      changes.actionConfig = JSON.stringify(outcome.actionConfig);
      if (typeof body.name !== "string") changes.name = outcome.name.slice(0, 300);
      changed.push("rule");
    }
    if (!changed.length) return Response.json({ error: "Nothing to change." }, { status: 400 });

    const [updated] = await db
      .update(boardAutomations)
      .set(changes)
      .where(and(eq(boardAutomations.id, existing.id), eq(boardAutomations.organisationId, orgId)))
      .returning();

    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor({ actor, identityEmail, session }),
      action: "automation.updated",
      entityType: "board_automation",
      entityId: existing.id,
      summary: `Automation "${updated.name}" ${changed.join(", ")}.`,
      detail: { board: existing.boardId, changed },
      request,
    });
    return Response.json({ rule: exposeRule(updated) });
  } catch (error) {
    return unavailable(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId, actor, identityEmail, session } = guard.scope;
    const id = text(new URL(request.url).searchParams.get("id"), 80);
    const existing = id ? await findRule(db, orgId, id) : null;
    if (!existing) return Response.json({ error: "That automation is not on this board." }, { status: 404 });

    await db
      .delete(boardAutomations)
      .where(and(eq(boardAutomations.id, existing.id), eq(boardAutomations.organisationId, orgId)));

    // The run history is kept: it is the record that the rule existed and
    // what it did, and the history screen labels a deleted rule's rows.
    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor({ actor, identityEmail, session }),
      action: "automation.deleted",
      entityType: "board_automation",
      entityId: existing.id,
      summary: `Deleted the automation "${existing.name}" from ${existing.boardId}.`,
      detail: { board: existing.boardId, runCount: existing.runCount },
      request,
    });
    return Response.json({ ok: true, id: existing.id });
  } catch (error) {
    return unavailable(error);
  }
}
