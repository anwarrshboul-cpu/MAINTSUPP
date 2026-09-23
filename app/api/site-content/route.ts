/**
 * The built-in pages' copy, read and written — decision L (§77 item 9).
 *
 * WHO: MAINTSUPP platform staff, and nobody else — `scope.platformAdmin` AND a
 * real session, the same two conditions as `/api/site-pages` and
 * `/api/site-navigation`, for the same reason: this is MAINTSUPP's own website,
 * not a workspace's setting, so no workspace capability can reach it. A client's
 * Owner holds every capability in their workspace and still gets 403 here.
 *
 * WHAT A SAVE MAY DO is decided in `app/lib/site-content.ts` and nowhere else:
 * which pages, which sections, which fields, how long each may be, the claim and
 * price rules every CMS page is held to, what may be hidden and what may be
 * moved. A refusal is a 422 naming the rule, never a silent repair.
 *
 * TWO CHECKS THIS ROUTE ADDS, because only the server can make them:
 *
 *   - THE NAVIGATION IN FORCE. A section cannot be hidden while a visible header
 *     or footer link points at its anchor, because that link would then scroll
 *     nowhere. The refusal names the link. The navigation is read here, at save
 *     time, so the answer is about the menu as it stands rather than the menu as
 *     it shipped.
 *   - THE MEDIA LIBRARY. A hero photograph must still be in the library, must be
 *     an image, and must have alt text somewhere — the same rule, and the same
 *     words, as an `image` block on a CMS page.
 *
 * WHAT A SAVE SETS OFF, in order: the version history's baseline (the state
 * before history's first write), the conditional write (`revision`, so two
 * editors cannot overwrite each other unseen), the new version, the audit entry,
 * and finally this instance's public cache is dropped so the site shows the
 * change at once here — and within `PUBLIC_CONTENT_TTL_MS` on every other
 * instance.
 *
 *   GET                                the editor's payload
 *   PUT { content, expectedRevision }  save
 *   PUT { reset: true, … }             back to the words the site ships with
 *   PUT { restoreVersion }             a recorded version, through the same rules
 */

import { ensureDatabase } from "../../../db/init";
import { auditActor, recordAudit } from "../../lib/audit";
import { mediaKinds } from "../../lib/cms-media-repository.ts";
import {
  restoreVersionFrom,
  siteContentSnapshot,
  summariseChange,
  type SiteContentSnapshot,
} from "../../lib/config-versions-model.ts";
import {
  ensureConfigBaseline,
  latestSnapshot,
  loadRestoreSnapshot,
  recordConfigVersion,
  type VersionTarget,
} from "../../lib/config-versions.ts";
import {
  CONTENT_OMISSIONS,
  CONTENT_PAGES,
  EMPTY_SITE_CONTENT,
  HOME_SECTION_ORDER,
  MOVABLE_HOME_SECTIONS,
  contentMediaIds,
  resolveSiteContent,
  validateSiteContent,
  type SiteContent,
} from "../../lib/site-content.ts";
import { invalidatePublicSiteContent, PUBLIC_CONTENT_TTL_MS } from "../../lib/site-content-public.ts";
import { readStoredContent, resetContent, writeContent } from "../../lib/site-content-repository.ts";
import { publicNavigation } from "../../lib/site-navigation.ts";
import { readStoredNavigation } from "../../lib/site-navigation-repository.ts";
import { anonymousRefusal, scopedDb } from "../../lib/tenant-db";

export const dynamic = "force-dynamic";

const VERSION_TARGET: VersionTarget = { organisationId: null, subject: "site_content", key: "public" };

/** Built fresh on every call — a Response body can be read once (see `/api/site-pages`). */
function forbidden() {
  return Response.json({ error: "The website is administered by MAINTSUPP platform staff." }, { status: 403 });
}

function unavailable(error?: unknown) {
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  console.error("[site-content] the page copy could not be read or saved:", error instanceof Error ? error.message : "error");
  return Response.json({ error: "The website copy is temporarily unavailable." }, { status: 503 });
}

/** `scope.platformAdmin` and a real session, or nothing. Not a capability — see the header. */
async function platformScope(request: Request) {
  const scope = await scopedDb(request);
  if (scope.platformAdmin !== true) return null;
  if (!scope.authenticated) return null;
  return scope;
}

type Scope = NonNullable<Awaited<ReturnType<typeof platformScope>>>;

/**
 * Every anchor a VISIBLE navigation link points at, and how to say which link it
 * is. `#pricing`, `/#pricing` and `https://maintsupp.com/#pricing` are the same
 * destination, so all three forms are read.
 */
async function anchorsNavigationNeeds(scope: Scope): Promise<Map<string, string>> {
  const stored = await readStoredNavigation(scope.db);
  const menu = publicNavigation(stored.navigation, null);
  const needed = new Map<string, string>();
  const note = (href: string, description: string) => {
    const anchor = /^(?:https:\/\/maintsupp\.com)?\/?(#.+)$/.exec(href)?.[1];
    if (!anchor) return;
    const id = anchor.slice(1);
    if (!needed.has(id)) needed.set(id, description);
  };
  for (const link of menu.primary) note(link.href, `"${link.label}" in the header menu`);
  for (const group of menu.footer) {
    for (const link of group.links) note(link.href, `"${link.label}" in the footer's ${group.heading} list`);
  }
  return needed;
}

/** Everything the editor needs, read uncached — the editor always sees the truth. */
async function editorPayload(scope: Scope) {
  const stored = await readStoredContent(scope.db);
  const needed = await anchorsNavigationNeeds(scope);
  return {
    canEdit: true,
    stored: stored.stored,
    revision: stored.revision,
    updatedAt: stored.updatedAt,
    updatedByEmail: stored.updatedByEmail,
    /* The overrides as stored, and the words a visitor is reading right now. */
    content: stored.content,
    resolved: resolveSiteContent(stored.content),
    pages: CONTENT_PAGES,
    home: { order: HOME_SECTION_ORDER, movable: MOVABLE_HOME_SECTIONS },
    /* anchor -> the link that needs it, so "Hide" can say why it is refused
       before anyone presses it. */
    navigationNeeds: Object.fromEntries(needed),
    omissions: CONTENT_OMISSIONS,
    cacheSeconds: Math.round(PUBLIC_CONTENT_TTL_MS / 1000),
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
      content?: unknown;
      expectedRevision?: unknown;
      reset?: unknown;
      restoreVersion?: unknown;
    } | null;
    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Send the content, a reset, or a version to restore." }, { status: 400 });
    }
    if (
      "expectedRevision" in payload &&
      payload.expectedRevision !== null &&
      !(Number.isInteger(payload.expectedRevision) && (payload.expectedRevision as number) >= 1)
    ) {
      return Response.json(
        { error: "expectedRevision must be the revision you opened, or null when nothing has been saved yet." },
        { status: 400 },
      );
    }

    /*
     * A RESTORE names a version, loaded here on the server — never a state the
     * browser claims. Its content then goes through EVERY rule below, so a
     * version that names a since-deleted photograph, or hides a section the menu
     * now points at, is refused whole. A version that recorded a reset restores
     * as a reset.
     */
    const restoring = restoreVersionFrom(payload);
    let submitted: unknown = payload.content;
    let reset = payload.reset === true;
    if (restoring) {
      const loaded = await loadRestoreSnapshot(scope.db, VERSION_TARGET, restoring);
      if (!loaded.ok) return Response.json({ error: loaded.error }, { status: loaded.status });
      const snapshot = loaded.snapshot as SiteContentSnapshot;
      reset = !snapshot.present;
      submitted = snapshot.content;
    }

    let content: SiteContent | null = null;
    if (!reset) {
      const needed = await anchorsNavigationNeeds(scope);
      const checked = validateSiteContent(submitted, { requiredAnchors: needed });
      if (!checked.ok) return Response.json({ error: checked.reason }, { status: 422 });
      content = checked.value;

      /*
       * THE PHOTOGRAPH MUST STILL BE THERE, and must be an image with something a
       * screen reader can say — the same rule, and the same words, as an `image`
       * block on a website page. Asked of a restore too, so an old version that
       * names a deleted asset is refused rather than published with a hole.
       */
      const named = contentMediaIds(content);
      if (named.length) {
        const library = await mediaKinds(scope.db, named);
        for (const id of named) {
          const asset = library.get(id);
          if (!asset || !asset.hasFile) {
            return Response.json({ error: "That photograph is no longer in the media library. Choose another." }, { status: 422 });
          }
          if (asset.kind !== "image") {
            return Response.json({ error: "Choose an image for the hero photograph." }, { status: 422 });
          }
          if (!asset.altText) {
            return Response.json(
              { error: "The hero photograph needs alt text — describe it in the media library first." },
              { status: 422 },
            );
          }
        }
      }
    }

    const actor = { email: scope.identityEmail, userId: scope.session?.user.id ?? null };
    const before = await readStoredContent(scope.db);
    /* A restore names a version, not a revision; a save or reset names what it was edited from. */
    const expectedRevision = restoring
      ? undefined
      : "expectedRevision" in payload
        ? (payload.expectedRevision as number | null)
        : undefined;
    if (expectedRevision !== undefined && expectedRevision !== before.revision) {
      return Response.json(
        { error: "Someone else saved the website copy after you opened it. Reload to see their version, then make your change again." },
        { status: 409 },
      );
    }

    /* §38 — the state before history's first write, as version 1. */
    await ensureConfigBaseline(
      scope.db,
      VERSION_TARGET,
      siteContentSnapshot(before.stored ? before.content : null),
      actor,
    );

    if (reset) {
      if (before.stored) await resetContent(scope.db);
    } else if (content) {
      const written = await writeContent(scope.db, content, {
        expectedRevision,
        actorEmail: scope.identityEmail,
      });
      if (!written.ok) {
        return Response.json(
          { error: "Someone else saved the website copy after you opened it. Reload to see their version, then make your change again." },
          { status: 409 },
        );
      }
    }

    const after = siteContentSnapshot(content);
    /* "What changed" is said against what visitors read before: the previous
       version, or — when there was no row — nothing overridden at all. */
    const latest = (await latestSnapshot(scope.db, VERSION_TARGET)) as SiteContentSnapshot | null;
    const previous = latest?.present ? latest : siteContentSnapshot(EMPTY_SITE_CONTENT);
    const summary = summariseChange("site_content", previous, after);
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
      action: restoring ? "config.version_restored" : reset ? "site_content.reset" : "site_content.updated",
      entityType: restoring ? "config_version" : "site_content",
      entityId: restoring ? "site_content/public" : "public",
      summary: restoring
        ? `Restored the website's page copy from version ${restoring}.`
        : reset
          ? "Reset the website's page copy to the words the site ships with."
          : `Saved the website's page copy: ${summary}`,
      detail: { version: recorded, ...(restoring ? { subject: "site_content", key: "public", from: restoring } : {}) },
      request,
    });

    /* Last, after the write has landed: this instance shows the change at once. */
    invalidatePublicSiteContent();

    return Response.json({ ...(await editorPayload(scope)), saved: true, version: recorded });
  } catch (error) {
    return unavailable(error);
  }
}
