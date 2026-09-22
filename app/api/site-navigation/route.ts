/**
 * The public website's navigation, read and written — decision J (§77 item 11).
 *
 * WHO: MAINTSUPP platform staff, and nobody else — `scope.platformAdmin` AND a
 * real session, the same two conditions as `/api/site-pages`, for the same
 * reason: this is MAINTSUPP's own website, not a workspace's setting, so no
 * workspace capability can reach it. A client's Owner or Super Admin holds
 * every capability in their workspace and still gets 403 here. GET is gated
 * too: it carries hidden links and the names of draft pages.
 *
 * WHAT A SAVE MAY DO is decided in `app/lib/site-navigation.ts` and nowhere
 * else: add, rename, reorder, hide and re-point links; safe destinations only;
 * the five locked links cannot be removed, hidden or re-pointed. A refusal is
 * a 422 naming the rule, never a silent repair — the editor must see why.
 *
 * WHAT A SAVE SETS OFF, in order: the version history's baseline (the state
 * before history's first write), the conditional write (`revision`, so two
 * editors cannot overwrite each other unseen), the new version, the audit
 * entry, and finally this instance's public-navigation cache is dropped so the
 * site shows the change at once here — and within `PUBLIC_NAVIGATION_TTL_MS`
 * on every other instance.
 *
 *   GET                                   the editor's payload
 *   PUT { navigation, expectedRevision }  save
 *   PUT { reset: true, expectedRevision } back to the built-in navigation
 *   PUT { restoreVersion }                a recorded version, through the same rules
 */

import { ensureDatabase } from "../../../db/init";
import { auditActor, recordAudit } from "../../lib/audit";
import { listPages } from "../../lib/cms-repository.ts";
import {
  restoreVersionFrom,
  siteNavigationSnapshot,
  summariseChange,
  type SiteNavigationSnapshot,
} from "../../lib/config-versions-model.ts";
import {
  ensureConfigBaseline,
  latestSnapshot,
  loadRestoreSnapshot,
  recordConfigVersion,
  type VersionTarget,
} from "../../lib/config-versions.ts";
import {
  FIXED_CHROME,
  HOMEPAGE_ANCHORS,
  LOCKED_LINKS,
  NAVIGATION_RULES,
  SITE_ROUTES,
  defaultNavigation,
  validateNavigation,
  type SiteNavigation,
} from "../../lib/site-navigation.ts";
import { invalidatePublicNavigation, PUBLIC_NAVIGATION_TTL_MS } from "../../lib/site-navigation-public.ts";
import {
  readStoredNavigation,
  resetNavigation,
  writeNavigation,
} from "../../lib/site-navigation-repository.ts";
import { anonymousRefusal, scopedDb } from "../../lib/tenant-db";

export const dynamic = "force-dynamic";

const VERSION_TARGET: VersionTarget = { organisationId: null, subject: "site_navigation", key: "public" };

/** Built fresh on every call — a Response body can be read once (see `/api/site-pages`). */
function forbidden() {
  return Response.json(
    { error: "The website is administered by MAINTSUPP platform staff." },
    { status: 403 },
  );
}

function unavailable(error?: unknown) {
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  console.error("[site-navigation] the navigation could not be read or saved:", error instanceof Error ? error.message : "error");
  return Response.json({ error: "The website navigation is temporarily unavailable." }, { status: 503 });
}

/** `scope.platformAdmin` and a real session, or nothing. Not a capability — see the header. */
async function platformScope(request: Request) {
  const scope = await scopedDb(request);
  if (scope.platformAdmin !== true) return null;
  if (!scope.authenticated) return null;
  return scope;
}

type Scope = NonNullable<Awaited<ReturnType<typeof platformScope>>>;

/** Everything the editor needs, read uncached — the editor always sees the truth. */
async function editorPayload(scope: Scope) {
  const stored = await readStoredNavigation(scope.db);
  const pages = await listPages(scope.db);
  return {
    canEdit: true,
    stored: stored.stored,
    revision: stored.revision,
    updatedAt: stored.updatedAt,
    updatedByEmail: stored.updatedByEmail,
    navigation: stored.navigation,
    defaults: defaultNavigation(),
    rules: NAVIGATION_RULES,
    locked: LOCKED_LINKS,
    fixed: FIXED_CHROME,
    destinations: {
      anchors: HOMEPAGE_ANCHORS.map((entry) => ({ href: `#${entry.id}`, label: entry.label })),
      routes: SITE_ROUTES.map((entry) => ({ href: entry.path, label: entry.label })),
      /* Every website page, drafts included — this payload is staff-only. The
         public render leaves out a link to any page that is not live. */
      pages: pages.map((page) => ({ href: `/p/${page.slug}`, label: page.title, state: page.state })),
    },
    cacheSeconds: Math.round(PUBLIC_NAVIGATION_TTL_MS / 1000),
  };
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const scope = await platformScope(request);
    if (!scope) return forbidden();
    return Response.json(await editorPayload(scope));
  } catch (error) {
    return unavailable(error);
  }
}

export async function PUT(request: Request) {
  try {
    await ensureDatabase();
    const scope = await platformScope(request);
    if (!scope) return forbidden();

    const payload = (await request.json().catch(() => null)) as {
      navigation?: unknown;
      expectedRevision?: unknown;
      reset?: unknown;
      restoreVersion?: unknown;
    } | null;
    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Send the navigation, a reset, or a version to restore." }, { status: 400 });
    }
    if ("expectedRevision" in payload && payload.expectedRevision !== null && !(Number.isInteger(payload.expectedRevision) && (payload.expectedRevision as number) >= 1)) {
      return Response.json({ error: "expectedRevision must be the revision you opened, or null for the built-in navigation." }, { status: 400 });
    }

    /*
     * A RESTORE names a version, loaded here on the server — never a state the
     * browser claims. Its navigation then goes through EVERY rule below, so an
     * old version that breaks today's locks is refused whole. A version that
     * recorded a reset restores as a reset.
     */
    const restoring = restoreVersionFrom(payload);
    let submitted: unknown = payload.navigation;
    let reset = payload.reset === true;
    if (restoring) {
      const loaded = await loadRestoreSnapshot(scope.db, VERSION_TARGET, restoring);
      if (!loaded.ok) return Response.json({ error: loaded.error }, { status: loaded.status });
      const snapshot = loaded.snapshot as SiteNavigationSnapshot;
      reset = !snapshot.present;
      submitted = snapshot.navigation;
    }

    let navigation: SiteNavigation | null = null;
    if (!reset) {
      const checked = validateNavigation(submitted);
      if (!checked.ok) return Response.json({ error: checked.reason }, { status: 422 });
      navigation = checked.value;
    }

    const actor = { email: scope.identityEmail, userId: scope.session?.user.id ?? null };
    const before = await readStoredNavigation(scope.db);
    /* A restore names a version, not a revision; a save or reset names what it was edited from. */
    const expectedRevision = restoring
      ? undefined
      : "expectedRevision" in payload
        ? (payload.expectedRevision as number | null)
        : undefined;
    if (expectedRevision !== undefined && expectedRevision !== before.revision) {
      return Response.json(
        { error: "Someone else saved the navigation after you opened it. Reload to see their version, then make your change again." },
        { status: 409 },
      );
    }

    /* §38 — the state before history's first write, as version 1. */
    await ensureConfigBaseline(scope.db, VERSION_TARGET, siteNavigationSnapshot(before.stored ? before.navigation : null), actor);

    if (reset) {
      if (before.stored) await resetNavigation(scope.db);
    } else if (navigation) {
      const written = await writeNavigation(scope.db, navigation, {
        expectedRevision,
        actorEmail: scope.identityEmail,
      });
      if (!written.ok) {
        return Response.json(
          { error: "Someone else saved the navigation after you opened it. Reload to see their version, then make your change again." },
          { status: 409 },
        );
      }
    }

    const after = siteNavigationSnapshot(navigation);
    /* "What changed" is said against the navigation visitors saw before: the
       previous version, or — when there was no row — the built-in one. */
    const latest = (await latestSnapshot(scope.db, VERSION_TARGET)) as SiteNavigationSnapshot | null;
    const previous = latest?.present ? latest : siteNavigationSnapshot(defaultNavigation());
    const summary = summariseChange("site_navigation", previous, after);
    const recorded = await recordConfigVersion(scope.db, VERSION_TARGET, {
      snapshot: after,
      summary: restoring ? `Restored from version ${restoring} — ${summary}` : summary,
      restoredFrom: restoring,
      actor,
    });

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: restoring ? "config.version_restored" : reset ? "site_navigation.reset" : "site_navigation.updated",
      entityType: restoring ? "config_version" : "site_navigation",
      entityId: restoring ? "site_navigation/public" : "public",
      summary: restoring
        ? `Restored the website navigation from version ${restoring}.`
        : reset
          ? "Reset the website navigation to the built-in one."
          : `Saved the website navigation: ${summary}`,
      detail: { version: recorded, ...(restoring ? { subject: "site_navigation", key: "public", from: restoring } : {}) },
      request,
    });

    /* Last, after the write has landed: this instance shows the change at once. */
    invalidatePublicNavigation();

    return Response.json({ ...(await editorPayload(scope)), saved: true, version: recorded });
  } catch (error) {
    return unavailable(error);
  }
}
