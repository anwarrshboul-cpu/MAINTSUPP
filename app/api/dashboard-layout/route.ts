import { and, eq, isNull } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import { dashboardLayouts } from "../../../db/schema";
import { scopedDb } from "../../lib/tenant-db";
import { can, resolvePermissions } from "../../lib/permissions";

export const dynamic = "force-dynamic";

/**
 * Where a person's dashboard arrangement is kept.
 *
 * Deliberately the same shape as `/api/navigation`: three layers, with the
 * user's own row over the workspace default over the built-in order. Anything
 * else would mean two different mental models for "my screen, arranged my way".
 *
 * WHAT IS STORED IS AN ARRANGEMENT, NOT AN INVENTORY. `items` records the order
 * panels sit in and which are hidden. Whether a panel exists is decided by the
 * widget registry in the client. A layout saved last year that has never heard
 * of "Spend against budget" therefore gets it — appended, visible — rather than
 * losing it, which is the failure mode a stored inventory has.
 *
 * A `surface` distinguishes the overview from the reports page, so hiding a
 * panel on one does not hide it on the other.
 */

const SURFACES = new Set(["overview", "reports"]);

function surfaceFrom(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return SURFACES.has(text) ? text : "overview";
}

/**
 * The stored list, cleaned.
 *
 * Keys are bounded and de-duplicated, and the whole list is capped. This is a
 * per-user JSON blob written from the browser: without a cap it is somewhere
 * anyone can put a megabyte, and duplicate keys would render a panel twice.
 */
function cleanItems(value: unknown) {
  if (!Array.isArray(value)) return [] as Array<{ key: string; hidden: boolean }>;
  const seen = new Set<string>();
  const items: Array<{ key: string; hidden: boolean }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const key = typeof record.key === "string" ? record.key.trim().slice(0, 60) : "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push({ key, hidden: record.hidden === true });
    if (items.length >= 60) break;
  }
  return items;
}

function newId() {
  return `dash_${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function GET(request: Request) {
  await ensureDatabase();
  const { db, orgId, session } = await scopedDb(request);
  const surface = surfaceFrom(new URL(request.url).searchParams.get("surface"));
  const userId = session?.user.id ?? null;

  const rows = await db
    .select()
    .from(dashboardLayouts)
    .where(
      and(
        eq(dashboardLayouts.organisationId, orgId),
        eq(dashboardLayouts.surface, surface),
      ),
    );

  const workspaceDefault = rows.find((row) => row.userId === null);
  const mine = userId ? rows.find((row) => row.userId === userId) : undefined;

  const parse = (value: string | undefined) => {
    if (!value) return [];
    try {
      return cleanItems(JSON.parse(value));
    } catch {
      return [];
    }
  };

  return Response.json({
    surface,
    // Both are returned rather than pre-merged, so the client can show "this is
    // your arrangement" against "this is the workspace default" and offer a
    // reset that means something.
    items: parse(mine?.items),
    workspaceDefault: parse(workspaceDefault?.items),
    isPersonal: Boolean(mine),
  });
}

export async function PUT(request: Request) {
  await ensureDatabase();
  const { db, orgId, session, actor } = await scopedDb(request);

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Send a layout." }, { status: 400 });
  }

  const surface = surfaceFrom(payload.surface);
  const items = cleanItems(payload.items);
  const asWorkspaceDefault = payload.scope === "workspace";

  /*
   * Saving YOUR OWN arrangement needs no capability — it is your screen, and it
   * grants nothing. Saving the WORKSPACE default changes what every colleague
   * sees by default, so that one is `settings.edit`.
   *
   * Checked here on the server rather than by hiding the button: the button is
   * a courtesy, this is the rule.
   */
  if (asWorkspaceDefault) {
    const subject = await resolvePermissions(db, orgId, actor.role);
    if (!can(subject, "settings.edit")) {
      return Response.json(
        {
          error: "Your role cannot change the workspace default dashboard.",
          capability: "settings.edit",
          denied: true,
        },
        { status: 403 },
      );
    }
  }

  const userId = asWorkspaceDefault ? null : session?.user.id ?? null;
  if (!asWorkspaceDefault && !userId) {
    // An anonymous browser has nowhere to save to. Saying so is better than
    // writing a row keyed on nobody and pretending it worked.
    return Response.json(
      { error: "Sign in to save your own dashboard layout." },
      { status: 401 },
    );
  }

  const existing = await db
    .select({ id: dashboardLayouts.id })
    .from(dashboardLayouts)
    .where(
      and(
        eq(dashboardLayouts.organisationId, orgId),
        eq(dashboardLayouts.surface, surface),
        userId ? eq(dashboardLayouts.userId, userId) : isNull(dashboardLayouts.userId),
      ),
    )
    .limit(1);

  const serialised = JSON.stringify(items);
  if (existing[0]) {
    await db
      .update(dashboardLayouts)
      .set({
        items: serialised,
        updatedBy: actor.email,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(dashboardLayouts.id, existing[0].id));
  } else {
    await db.insert(dashboardLayouts).values({
      id: newId(),
      organisationId: orgId,
      userId,
      surface,
      items: serialised,
      updatedBy: actor.email,
    });
  }

  return Response.json({ ok: true, surface, items, scope: asWorkspaceDefault ? "workspace" : "user" });
}

/** Drops the caller's own arrangement, falling back to the workspace default. */
export async function DELETE(request: Request) {
  await ensureDatabase();
  const { db, orgId, session } = await scopedDb(request);
  const surface = surfaceFrom(new URL(request.url).searchParams.get("surface"));
  const userId = session?.user.id ?? null;
  if (!userId) {
    return Response.json({ error: "Sign in first." }, { status: 401 });
  }

  await db
    .delete(dashboardLayouts)
    .where(
      and(
        eq(dashboardLayouts.organisationId, orgId),
        eq(dashboardLayouts.surface, surface),
        eq(dashboardLayouts.userId, userId),
      ),
    );

  return Response.json({ ok: true, surface });
}
