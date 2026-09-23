import { and, eq, isNull } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import { dashboardLayouts } from "../../../db/schema";
import { anonymousRefusal, scopedDb } from "../../lib/tenant-db";
import { can, resolvePermissions } from "../../lib/permissions";
import { auditActor, recordAudit } from "../../lib/audit";
import {
  dashboardSnapshot,
  restoreVersionFrom,
  summariseChange,
  type DashboardSnapshot,
} from "../../lib/config-versions-model";
import {
  ensureConfigBaseline,
  latestSnapshot,
  loadRestoreSnapshot,
  recordConfigVersion,
  type VersionTarget,
} from "../../lib/config-versions";

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

/** How long a workspace's own name for a panel may be. */
const TITLE_LIMIT = 60;

/**
 * A PANEL'S OWN CONFIGURATION — decision O, and the one thing that may be
 * stored beside its place in the order.
 *
 * Two answers, both presentation: what this workspace CALLS the panel, and
 * whether it spans the row. Neither changes what a panel counts, which is why
 * they can be stored in an arrangement at all — a stored FILTER would make the
 * layout a second source of truth for the figures, and the page's own period
 * and portfolio pickers are that source.
 *
 * Anything else a caller sends is dropped, so this blob cannot grow into a
 * place to keep arbitrary data, and an empty configuration is omitted entirely
 * so an untouched layout is stored exactly as it was before this existed.
 */
type StoredConfig = { title?: string; width?: "full" | "half" };

function cleanConfig(value: unknown): StoredConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim().slice(0, TITLE_LIMIT) : "";
  const width: StoredConfig["width"] =
    record.width === "full" || record.width === "half" ? record.width : undefined;
  if (!title && !width) return undefined;
  const config: StoredConfig = {};
  if (title) config.title = title;
  if (width) config.width = width;
  return config;
}

type StoredItem = { key: string; hidden: boolean; config?: StoredConfig };

/**
 * The stored list, cleaned.
 *
 * Keys are bounded and de-duplicated, and the whole list is capped. This is a
 * per-user JSON blob written from the browser: without a cap it is somewhere
 * anyone can put a megabyte, and duplicate keys would render a panel twice.
 */
function cleanItems(value: unknown) {
  if (!Array.isArray(value)) return [] as StoredItem[];
  const seen = new Set<string>();
  const items: StoredItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const key = typeof record.key === "string" ? record.key.trim().slice(0, 60) : "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const config = cleanConfig(record.config);
    items.push({ key, hidden: record.hidden === true, ...(config ? { config } : {}) });
    if (items.length >= 60) break;
  }
  return items;
}

function newId() {
  return `dash_${crypto.randomUUID().replace(/-/g, "")}`;
}

function unavailable(error?: unknown) {
  // A session that has ended is not an outage: 503 tells a browser to retry
  // something no amount of retrying will fix, and blames the workspace for
  // what a person fixes by signing in. See `anonymousRefusal`.
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  return Response.json(
    { error: "The dashboard layout is temporarily unavailable." },
    { status: 503 },
  );
}

/*
 * None of the three handlers below had a catch, so `scopedDb` refusing an
 * anonymous caller escaped as an unhandled throw and the framework answered 500
 * with an empty body — an outage where every sibling route says "sign in", and
 * a stack trace in the log for a request that was correctly refused. Each is
 * wrapped rather than sharing one entry point because they take different
 * verbs and bodies; the refusal is what has to be common, and it is.
 */
export async function GET(request: Request) {
  try {
    return await readLayout(request);
  } catch (error) {
    return unavailable(error);
  }
}

async function readLayout(request: Request) {
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
  try {
    return await saveLayout(request);
  } catch (error) {
    return unavailable(error);
  }
}

async function saveLayout(request: Request) {
  await ensureDatabase();
  const scope = await scopedDb(request);
  const { db, orgId, session, actor } = scope;

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Send a layout." }, { status: 400 });
  }

  const surface = surfaceFrom(payload.surface);
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
    const subject = await resolvePermissions(db, orgId, actor.role, scope.siteScope);
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

  /*
   * §38 — RESTORE the workspace default to a recorded version: its widgets go
   * through the same `cleanItems` below and the save is recorded as a new
   * version. Only the workspace default is versioned. Loaded from THIS
   * workspace's history for this surface; the request carries only the number.
   */
  const versionTarget: VersionTarget = { organisationId: orgId, subject: "dashboard", key: surface };
  const restoring = restoreVersionFrom(payload);
  if (restoring) {
    if (!asWorkspaceDefault) {
      return Response.json({ error: "Only the workspace default dashboard has a version history." }, { status: 400 });
    }
    const loaded = await loadRestoreSnapshot(db, versionTarget, restoring);
    if (!loaded.ok) return Response.json({ error: loaded.error }, { status: loaded.status });
    payload.items = (loaded.snapshot as DashboardSnapshot).items;
  }
  const items = cleanItems(payload.items);

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
    .select({ id: dashboardLayouts.id, items: dashboardLayouts.items })
    .from(dashboardLayouts)
    .where(
      and(
        eq(dashboardLayouts.organisationId, orgId),
        eq(dashboardLayouts.surface, surface),
        userId ? eq(dashboardLayouts.userId, userId) : isNull(dashboardLayouts.userId),
      ),
    )
    .limit(1);

  const versionActor = { email: actor.email, userId: session?.user.id ?? null };
  if (asWorkspaceDefault) {
    /* §38 — the default as it was, as version 1, before history's first write. */
    let stored: unknown[] | null = null;
    try {
      stored = existing[0] ? (JSON.parse(existing[0].items) as unknown[]) : null;
    } catch {
      stored = null;
    }
    await ensureConfigBaseline(db, versionTarget, dashboardSnapshot(surface, stored), versionActor);
  }

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

  /*
   * The WORKSPACE default is recorded; a personal arrangement is not.
   *
   * Same split the capability check above already makes, and for the same
   * reason: changing the default changes what every colleague opens on, which
   * is a structural change one person made and everybody else has to live with.
   * Rearranging your own dashboard changes nothing anybody else can see, and
   * logging it would file an event on every drag.
   */
  if (asWorkspaceDefault) {
    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor(scope),
      action: "dashboard.default_changed",
      entityType: "dashboard_layout",
      entityId: surface,
      summary: `Changed the workspace default ${surface} dashboard layout.`,
      detail: { surface, items },
      request,
    });
    /* §38 — every change a version; a restore always one. */
    const after = dashboardSnapshot(surface, items);
    const previous = await latestSnapshot(db, versionTarget);
    const summary = summariseChange("dashboard", previous, after);
    const recorded = await recordConfigVersion(db, versionTarget, {
      snapshot: after,
      summary: restoring ? `Restored from version ${restoring} — ${summary}` : summary,
      restoredFrom: restoring,
      actor: versionActor,
    });
    if (restoring) {
      await recordAudit({
        db,
        organisationId: orgId,
        actor: auditActor(scope),
        action: "config.version_restored",
        entityType: "config_version",
        entityId: `dashboard/${surface}`,
        summary: `Restored the workspace default ${surface} dashboard from version ${restoring}.`,
        detail: { subject: "dashboard", key: surface, from: restoring, version: recorded },
        request,
      });
    }
  }

  return Response.json({ ok: true, surface, items, scope: asWorkspaceDefault ? "workspace" : "user" });
}

/**
 * Drops the caller's own arrangement, falling back to the workspace default —
 * or, with `?scope=workspace`, removes the workspace default itself.
 */
export async function DELETE(request: Request) {
  try {
    return await resetLayout(request);
  } catch (error) {
    return unavailable(error);
  }
}

async function resetLayout(request: Request) {
  await ensureDatabase();
  const scope = await scopedDb(request);
  const { db, orgId, session } = scope;
  const url = new URL(request.url);
  const surface = surfaceFrom(url.searchParams.get("surface"));
  if (url.searchParams.get("scope") === "workspace") return removeWorkspaceDefault(request, scope, surface);
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

/**
 * §77 item 17 — REMOVE THE WORKSPACE DEFAULT, so everyone without their own
 * arrangement is back on the built-in order. It could only be replaced before.
 *
 * The same rule as saving one (`settings.edit`), checked here and not by hiding a
 * button. Recorded like every change to it (§38): the default as it was becomes
 * version 1 if history has not started, then a `deleted` version marks the
 * removal — so "restore the version before it" puts the default back exactly,
 * and nothing in the history is removed.
 */
async function removeWorkspaceDefault(
  request: Request,
  scope: Awaited<ReturnType<typeof scopedDb>>,
  surface: string,
) {
  const { db, orgId, session, actor } = scope;
  const subject = await resolvePermissions(db, orgId, actor.role, scope.siteScope);
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
  const [existing] = await db
    .select({ id: dashboardLayouts.id, items: dashboardLayouts.items })
    .from(dashboardLayouts)
    .where(
      and(
        eq(dashboardLayouts.organisationId, orgId),
        eq(dashboardLayouts.surface, surface),
        isNull(dashboardLayouts.userId),
      ),
    )
    .limit(1);
  if (!existing) {
    return Response.json({ error: "This workspace has no default layout to remove." }, { status: 404 });
  }

  const versionTarget: VersionTarget = { organisationId: orgId, subject: "dashboard", key: surface };
  const versionActor = { email: actor.email, userId: session?.user.id ?? null };
  let stored: unknown[] | null = null;
  try {
    stored = JSON.parse(existing.items) as unknown[];
  } catch {
    stored = null;
  }
  await ensureConfigBaseline(db, versionTarget, dashboardSnapshot(surface, stored), versionActor);
  await db.delete(dashboardLayouts).where(eq(dashboardLayouts.id, existing.id));
  const recorded = await recordConfigVersion(db, versionTarget, {
    snapshot: dashboardSnapshot(surface, null),
    kind: "deleted",
    summary: `Removed the workspace default ${surface} layout; the built-in order applies. Restore the version before this one to bring it back.`,
    actor: versionActor,
  });
  await recordAudit({
    db,
    organisationId: orgId,
    actor: auditActor(scope),
    action: "dashboard.default_removed",
    entityType: "dashboard_layout",
    entityId: surface,
    summary: `Removed the workspace default ${surface} dashboard layout.`,
    detail: { surface, version: recorded },
    request,
  });
  return Response.json({ ok: true, surface, scope: "workspace", removed: true });
}
