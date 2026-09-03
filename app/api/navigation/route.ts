/**
 * Stage 20 — `GET | PUT | DELETE /api/navigation`.
 *
 * Two rows can exist per organisation for any one person: the workspace default
 * (`user_id IS NULL`, set by an admin) and their own arrangement (`user_id` =
 * them). GET resolves them into one answer; PUT writes whichever the caller
 * asked for and is allowed to write; DELETE throws the personal one away, which
 * is what "reset to the workspace default" means.
 *
 * Everything reads `orgId` from `scopedDb`, so a layout belongs to exactly one
 * organisation and the caller cannot pick which — see `app/lib/tenant-access.ts`
 * for why that indirection is the only place tenancy is decided.
 */

import { and, eq, isNull } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import { navigationLayouts, users } from "../../../db/schema";
import { anonymousRefusal, scopedDb, type ScopedDatabase } from "../../lib/tenant-db";
import { can, resolvePermissions } from "../../lib/permissions";
import { auditActor, recordAudit } from "../../lib/audit";
import { loadWorkspaceSections } from "../workspace-sections/route";
import { sectionsToCatalogue } from "../workspace-sections/catalogue";
import {
  BUILT_IN_GROUPS,
  builtInCatalogue,
  lockViolations,
  resolveNavigation,
  sanitiseArrangement,
  sanitiseLocked,
  workspaceLabelMap,
  type NavArrangementItem,
  type NavCatalogueEntry,
} from "./layout";

type LayoutRow = typeof navigationLayouts.$inferSelect;

/**
 * Who may set the workspace default, and therefore who may set locks.
 *
 * The role comes from the membership `scopedDb` resolved, never from a cookie
 * or from anything in the body, so "I am an admin" is something the database
 * says about the caller.
 */
/**
 * Whether this caller may rewrite the WORKSPACE-DEFAULT sidebar.
 *
 * A CAPABILITY, not a role literal. It used to read
 * `role === "admin" || role === "super_admin"`, which quietly opted this route
 * out of the permission matrix: a super admin could revoke `settings.edit`
 * from `admin` and that admin would still be able to rewrite the default
 * sidebar — including its locked items — for everyone in the workspace.
 *
 * `settings.edit` is the capability its two siblings already use for exactly
 * this decision (`/api/workspace-sections` and `/api/dashboard-layout`), so
 * this is the matrix answering one question once rather than three routes
 * answering it three ways. It is also the rule
 * `tests/stage-twenty-teams-audit.test.mjs` states — that gates are
 * capabilities and not role strings — applied to a file its allowlist happened
 * not to name.
 *
 * A caller's OWN arrangement is untouched by this: that path is self-scoped and
 * needs no capability, because rearranging your own sidebar is not an
 * administrative act.
 */
async function mayEditDefault(context: ScopedDatabase) {
  const subject = await resolvePermissions(
    context.db,
    context.orgId,
    context.actor.role,
  );
  return can(subject, "settings.edit");
}

function parseItems(row: LayoutRow | null): NavArrangementItem[] {
  if (!row) return [];
  try {
    return sanitiseArrangement(JSON.parse(row.items) as unknown);
  } catch {
    // A row that will not parse is treated as "no opinion" rather than as an
    // error. A corrupt preference must never be able to break the sidebar.
    return [];
  }
}

function parseLocked(row: LayoutRow | null): string[] {
  if (!row) return [];
  try {
    return sanitiseLocked(JSON.parse(row.locked) as unknown);
  } catch {
    return [];
  }
}

/** The caller's `users.id`, or null for an identity with no user row yet. */
async function resolveUserId(context: ScopedDatabase) {
  const email = context.identityEmail?.trim().toLowerCase();
  if (!email) return null;
  const [row] = await context.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return row?.id ?? null;
}

/**
 * The two rows that can answer for this caller.
 *
 * Both queries carry `organisationId`, so neither can be satisfied by another
 * tenant's row even if a user id were somehow shared between organisations.
 */
async function loadRows(context: ScopedDatabase, userId: string | null) {
  const [workspaceRows, personalRows] = await Promise.all([
    context.db
      .select()
      .from(navigationLayouts)
      .where(
        and(
          eq(navigationLayouts.organisationId, context.orgId),
          isNull(navigationLayouts.userId),
        ),
      )
      .limit(1),
    userId
      ? context.db
          .select()
          .from(navigationLayouts)
          .where(
            and(
              eq(navigationLayouts.organisationId, context.orgId),
              eq(navigationLayouts.userId, userId),
            ),
          )
          .limit(1)
      : Promise.resolve([] as LayoutRow[]),
  ]);
  return {
    workspace: workspaceRows[0] ?? null,
    personal: personalRows[0] ?? null,
  };
}

/**
 * The catalogue for this request.
 *
 * The browser knows what sections exist — it is the thing that renders them —
 * so it may send its live list as `?sections=a,b,c`. When it does not (a curl
 * proof, a test, a server-rendered first paint) the built-in list stands in.
 *
 * The supplied list is only allowed to *narrow or reorder within* what the
 * server already knows plus keys the server can see are real. Rather than trust
 * it wholesale, unknown keys are accepted but carry no route information, and
 * the browser is the only thing that renders them — it will only draw a key it
 * has a `sectionMeta` entry for. So a crafted `sections=` parameter can change
 * nothing except this response's own `layout` field.
 *
 * STAGE 23. `workspace` holds the sections this organisation added for itself,
 * already turned into catalogue entries by `sectionsToCatalogue`. They are
 * appended, never merged into an arrangement, because this is a CATALOGUE — the
 * thing that decides existence — and the stored layers still decide only
 * presentation. That is what makes a section added five minutes ago appear, at
 * the end of its heading and visible, for somebody who arranged their sidebar a
 * year ago and has not touched it since.
 *
 * They are appended even when the browser's `sections=` list does not mention
 * them, so this response tells the truth about the workspace rather than about
 * whichever build the caller happens to be running. The browser re-resolves
 * against its own catalogue anyway and will not draw a key it cannot render.
 */
function requestCatalogue(
  request: Request,
  workspace: NavCatalogueEntry[],
): NavCatalogueEntry[] {
  const raw = new URL(request.url).searchParams.get("sections");
  if (!raw) return [...builtInCatalogue(), ...workspace];
  const known = new Map(
    [...builtInCatalogue(), ...workspace].map((entry) => [entry.key, entry]),
  );
  const catalogue: NavCatalogueEntry[] = [];
  const seen = new Set<string>();
  for (const piece of raw.split(",").slice(0, 200)) {
    const key = piece.trim();
    if (!key || seen.has(key) || !/^[a-z0-9:_-]+$/i.test(key)) continue;
    seen.add(key);
    catalogue.push(known.get(key) ?? { key, label: key, group: "group:operations" });
  }
  for (const entry of workspace) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    catalogue.push(entry);
  }
  return catalogue.length ? catalogue : [...builtInCatalogue(), ...workspace];
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const context = await scopedDb(request);
    const userId = await resolveUserId(context);
    const { workspace, personal } = await loadRows(context, userId);

    const workspaceItems = parseItems(workspace);
    const personalItems = personal ? parseItems(personal) : null;
    const locked = parseLocked(workspace);
    /* The workspace's own sections join the catalogue here — before the merge,
       never inside it. A failure to read them leaves the built-in catalogue
       standing rather than taking the sidebar down with it. */
    const workspaceSections = await loadWorkspaceSections(context.db, context.orgId).catch(
      () => [],
    );
    const catalogue = requestCatalogue(
      request,
      sectionsToCatalogue(
        workspaceSections,
        BUILT_IN_GROUPS.map((group) => group.key),
      ),
    );

    const resolved = resolveNavigation({
      catalogue,
      workspaceItems,
      userItems: personalItems,
      locked,
    });

    return Response.json({
      /* The effective sidebar, already merged. Enough on its own for a caller
         that just wants to know what this person sees. */
      layout: { groups: resolved.groups, appeared: resolved.appeared },
      /* The layers, unmerged, so the browser can re-resolve against its own
         live catalogue — the one place that knows about a section shipped
         after this server module was written. */
      arrangement: { workspace: workspaceItems, user: personalItems },
      /* Stage 23 — the sections this workspace added, with the icon and the
         surface each one draws. Returned from here rather than left to a second
         request because the browser's catalogue is incomplete without them, and
         two fetches means a paint where the sidebar is missing a section. Live
         ones only: an archived section is not part of the product right now. */
      sections: workspaceSections.filter((section) => !section.archived),
      locked,
      /* Which layer answered. "builtin" means nobody has arranged anything. */
      source: personalItems ? "user" : workspaceItems.length ? "workspace" : "builtin",
      canEditDefault: await mayEditDefault(context),
      /* Null when the identity has no `users` row: they can still see a layout,
         they just have nowhere to save a personal one. Told plainly rather
         than discovered when a save silently does nothing. */
      canEditOwn: userId !== null,
      role: context.actor.role,
    });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const message =
      error instanceof Error ? error.message : "The navigation layout could not be loaded.";
    return Response.json({ error: message }, { status: 503 });
  }
}

async function writeRow(
  context: ScopedDatabase,
  userId: string | null,
  existing: LayoutRow | null,
  items: NavArrangementItem[],
  locked: string[],
) {
  const now = new Date().toISOString();
  const payload = {
    items: JSON.stringify(items),
    locked: JSON.stringify(locked),
    updatedBy: context.identityEmail,
    updatedAt: now,
  };
  if (existing) {
    await context.db
      .update(navigationLayouts)
      .set(payload)
      .where(eq(navigationLayouts.id, existing.id));
    return existing.id;
  }
  const id = `nav-${context.orgId.slice(-6)}-${userId ?? "default"}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await context.db.insert(navigationLayouts).values({
    id,
    organisationId: context.orgId,
    userId,
    ...payload,
    createdAt: now,
  });
  return id;
}

/**
 * Save an arrangement.
 *
 * Body: `{ scope: "user" | "workspace", items: [...], locked?: [...] }`, or
 * `{ scope, reset: true }` which deletes that scope's row. `DELETE` is the
 * same thing for the personal scope, which is the one a user reaches for.
 *
 * The two rules worth stating out loud, because both are the sort of thing a
 * disabled button is usually mistaken for:
 *
 *  1. `scope: "workspace"` requires an admin. Refused on the caller's resolved
 *     role, not on anything in the request.
 *  2. A locked item cannot be hidden or renamed by a user, checked here on the
 *     submitted payload. A crafted `fetch` with `hidden: true` on a locked key
 *     is rejected with 422 and saves nothing — not partially applied, not
 *     silently corrected.
 */
/**
 * Record a change to the WORKSPACE DEFAULT sidebar. Never a personal one.
 *
 * The distinction is the whole of the noise/value trade W13-05 asks for. The
 * workspace default decides what every colleague sees when they sign in and
 * which items an admin has locked on — that is a structural change to the
 * product, made by one person, felt by everybody, and it belongs in the trail.
 * A person rearranging their own sidebar changes nothing anybody else can see,
 * grants nothing, and would file an event every time somebody dragged an item;
 * the same split /api/dashboard-layout and /api/workspace-sections/view
 * already make between the two scopes.
 */
async function recordDefaultNavigationChange(
  context: Awaited<ReturnType<typeof scopedDb>>,
  request: Request,
  kind: "saved" | "reset",
  detail: unknown,
) {
  await recordAudit({
    db: context.db,
    organisationId: context.orgId,
    actor: auditActor(context),
    action: kind === "reset" ? "navigation.default_reset" : "navigation.default_changed",
    entityType: "navigation_layout",
    entityId: context.orgId,
    summary:
      kind === "reset"
        ? "Reset the workspace default sidebar to the built-in order."
        : "Changed the workspace default sidebar layout.",
    detail,
    request,
  });
}

export async function PUT(request: Request) {
  try {
    await ensureDatabase();
    const context = await scopedDb(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const scope = body.scope === "workspace" ? "workspace" : "user";

    if (scope === "workspace" && !(await mayEditDefault(context))) {
      return Response.json(
        { error: "Only an admin can change the workspace default sidebar." },
        { status: 403 },
      );
    }

    const userId = scope === "user" ? await resolveUserId(context) : null;
    if (scope === "user" && !userId) {
      return Response.json(
        {
          error:
            "This identity has no user record in the workspace, so it cannot save a personal sidebar.",
        },
        { status: 409 },
      );
    }

    const { workspace, personal } = await loadRows(context, userId);

    /*
     * Reset — throw the row away rather than writing an "empty" one, so the
     * layer genuinely disappears and the one beneath it answers again.
     *
     * Available for both scopes on purpose. A user resets to the workspace
     * default; an admin resets the workspace default to the built-in order. An
     * admin who has made a mess of everyone's sidebar needs a way back just as
     * much as a user does, and "delete the row" is the only one that cannot
     * itself be got wrong.
     */
    if (body.reset === true) {
      const row = scope === "workspace" ? workspace : personal;
      if (row) {
        await context.db
          .delete(navigationLayouts)
          .where(eq(navigationLayouts.id, row.id));
      }
      if (scope === "workspace" && row) await recordDefaultNavigationChange(context, request, "reset", null);
      return Response.json({ ok: true, scope, reset: true });
    }

    const items = sanitiseArrangement(body.items);
    if (!items.length) {
      return Response.json(
        { error: "A sidebar layout needs at least one item." },
        { status: 400 },
      );
    }

    const workspaceItems = parseItems(workspace);
    const storedLocked = parseLocked(workspace);

    // Locks belong to the workspace default. A user's save carries the existing
    // set forward untouched; an admin editing the default may change it, and
    // the same save is then checked against the set they just chose.
    const locked =
      scope === "workspace" && body.locked !== undefined
        ? sanitiseLocked(body.locked)
        : storedLocked;

    const violations = lockViolations(
      items,
      locked,
      workspaceLabelMap(scope === "workspace" ? items : workspaceItems),
    );
    if (violations.length) {
      return Response.json(
        {
          error:
            "Some items are locked by an administrator and cannot be hidden or renamed.",
          violations,
        },
        { status: 422 },
      );
    }

    const existing = scope === "workspace" ? workspace : personal;
    await writeRow(context, userId, existing, items, locked);
    if (scope === "workspace") {
      await recordDefaultNavigationChange(context, request, "saved", {
        items,
        locked,
        previous: { items: workspaceItems, locked: storedLocked },
      });
    }
    return Response.json({ ok: true, scope, locked });
  } catch (error) {
    /* A session that has ended is not a bad request. Without this an expired
       session answered 400 here while the GET beside it answered 401
       {signIn:true}, and `installSessionGuard` bounces to /login only on the
       401 — so a save made just after a session lapsed failed silently and the
       person was left looking at a form that would never work again. */
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const message =
      error instanceof Error ? error.message : "The navigation layout could not be saved.";
    return Response.json({ error: message }, { status: 400 });
  }
}

/** Reset to the workspace default. Always available; never fails for absence. */
export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const context = await scopedDb(request);
    const userId = await resolveUserId(context);
    if (userId) {
      await context.db
        .delete(navigationLayouts)
        .where(
          and(
            eq(navigationLayouts.organisationId, context.orgId),
            eq(navigationLayouts.userId, userId),
          ),
        );
    }
    return Response.json({ ok: true, reset: true });
  } catch (error) {
    /* A session that has ended is not a bad request. Without this an expired
       session answered 400 here while the GET beside it answered 401
       {signIn:true}, and `installSessionGuard` bounces to /login only on the
       401 — so a save made just after a session lapsed failed silently and the
       person was left looking at a form that would never work again. */
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const message =
      error instanceof Error ? error.message : "The sidebar could not be reset.";
    return Response.json({ error: message }, { status: 400 });
  }
}
