/**
 * The website's pages, read and written — Master Specification §6–9.
 *
 * WHY THIS GATES ON PLATFORM STAFF AND NOT ON A CAPABILITY.
 *
 * Every capability in this product is per-workspace: `navigation.edit` means "may
 * edit the sidebar of the workspace you are in". These rows are not in a workspace.
 * They are MAINTSUPP's own marketing site, and there is one of it.
 *
 * So the gate is `scope.platformAdmin`, which `resolveTenantAccess` reads from the
 * `platform_admins` table and never from the request — the same decision
 * `requirePlatformAdmin` makes for the `/admin` console this screen lives in. A
 * capability would have been the wrong instrument twice over: `can()` returns true
 * for `super_admin` before it reads anything, so it cannot tell platform staff from
 * a client's Owner; and an Owner editing `maintsupp.com` is not a thing this product
 * should be able to express.
 *
 * GET IS GATED TOO, unlike `/api/theme`'s. A palette is what the page in front of
 * you is painted with, so withholding it hides nothing. This answers with every
 * DRAFT on the site — unpublished copy, half-written wording — which is not a
 * customer's business.
 *
 * WHAT CANNOT REACH A PAGE.
 *
 * Nothing here is interpolated into HTML: the renderer puts every field through
 * React as a text child or a plain attribute, and there is no
 * `dangerouslySetInnerHTML` on the CMS path. `validateBlock` therefore is not a
 * sanitiser — it guarantees SHAPE so the renderer cannot index a missing field, and
 * it restricts the one field that is not text. A `href` becomes an attribute a
 * browser will follow, so it must be a same-site path or an `https://` URL:
 * `javascript:` and `data:` are refused because they are not on a list of two
 * shapes, rather than because somebody remembered to block them.
 */

import { ensureDatabase } from "../../../db/init";
import { auditActor, recordAudit } from "../../lib/audit";
import { anonymousRefusal, scopedDb } from "../../lib/tenant-db";
import { invalidatePublicNavigation } from "../../lib/site-navigation-public.ts";
import { mediaKinds } from "../../lib/cms-media-repository.ts";
import {
  BLOCK_CATALOGUE,
  CMS_OMISSIONS,
  claimViolation,
  cleanSlug,
  validateBlock,
  type BlockBody,
} from "../../lib/cms-blocks.ts";
import {
  deletePage,
  deleteRedirect,
  listPages,
  listRedirects,
  redirectMap,
  saveRedirect,
  writePage,
  type PageInput,
} from "../../lib/cms-repository.ts";
import {
  cleanCanonical,
  cleanRedirectSource,
  cleanRedirectTarget,
  cleanWindow,
  planRedirect,
} from "../../lib/cms-seo.ts";
import {
  pageShape,
  pageSnapshot,
  restoreVersionFrom,
  summariseChange,
  type PageSnapshot,
} from "../../lib/config-versions-model.ts";
import {
  ensureConfigBaseline,
  latestSnapshot,
  loadRestoreSnapshot,
  recordConfigVersion,
  type VersionTarget,
} from "../../lib/config-versions.ts";

export const dynamic = "force-dynamic";

function unavailable(error?: unknown) {
  // A session that has ended is not an outage — the same helper `/api/theme` uses.
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  return Response.json(
    { error: "The website pages are temporarily unavailable." },
    { status: 503 },
  );
}

/**
 * The refusal, built FRESH on every call.
 *
 * ⚠️ This was a module-level `const FORBIDDEN = Response.json(…)` returned from all
 * three methods, and that is a bug with a very specific shape: a `Response` body is a
 * stream that can be consumed once, so the first refusal in a serverless instance
 * answered 403 and every refusal after it in the same instance became a **500** while
 * the runtime tried to serialise a body that had already been read.
 *
 * Measured on a deployed Preview with a real signed-in non-platform-admin: `GET`
 * answered 403 and `PUT` and `DELETE` answered 500. The authorization decision was
 * correct and the answer was not — a 500 tells a caller "we broke" where the truth is
 * "you may not", and it is the shape a client retries.
 *
 * No source test could see this. The pin asserting all three methods are gated
 * identically passed, because they ARE; what was not reusable was the gate's answer.
 * It took an authenticated request against a deployment, exercising more than one
 * method in one instance.
 */
function forbidden() {
  return Response.json(
    { error: "The website is administered by MAINTSUPP platform staff." },
    { status: 403 },
  );
}

/** `scope.platformAdmin` or nothing. See the header for why not a capability. */
async function platformScope(request: Request) {
  const scope = await scopedDb(request);
  if (scope.platformAdmin !== true) return null;
  if (!scope.authenticated) return null;
  return scope;
}

/** The first free `<slug>-copy`, `-copy-2`, … that is still a valid address. */
function copySlugFor(base: string, taken: Set<string>): string | null {
  const stem = base.slice(0, 70).replace(/-+$/, "");
  for (let n = 1; n <= 50; n += 1) {
    const candidate = n === 1 ? `${stem}-copy` : `${stem}-copy-${n}`;
    if (!taken.has(candidate) && cleanSlug(candidate) === candidate) return candidate;
  }
  return null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const scope = await platformScope(request);
    if (!scope) return forbidden();

    return Response.json({
      canEdit: true,
      pages: await listPages(scope.db),
      redirects: await listRedirects(scope.db),
      /* The catalogue and the honest gaps both travel, so the console shows what a
         block is and what this slice does not do without keeping its own copy of
         either — a second copy of the omissions list is how one of them becomes
         stale and starts claiming something untrue. */
      catalogue: BLOCK_CATALOGUE,
      omissions: CMS_OMISSIONS,
    });
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
      slug?: unknown;
      title?: unknown;
      metaTitle?: unknown;
      metaDescription?: unknown;
      published?: unknown;
      blocks?: unknown;
      restoreVersion?: unknown;
      original?: unknown;
      duplicate?: unknown;
      publishAt?: unknown;
      unpublishAt?: unknown;
      noindex?: unknown;
      canonicalUrl?: unknown;
      redirect?: unknown;
    } | null;
    if (!payload) {
      return Response.json({ error: "Send a page object." }, { status: 400 });
    }

    /*
     * A MANUAL REDIRECT, from an old `/p/<slug>` address to another CMS address
     * or a page on maintsupp.com — never another host (see `cleanRedirectTarget`:
     * a redirect that could send a visitor off-site is an open redirect). An
     * address a page still lives at cannot be redirected; the page would always
     * win. The stored target is collapsed to its final destination and a loop is
     * refused (`planRedirect`).
     */
    if (payload.redirect !== undefined) {
      const wanted = (payload.redirect ?? {}) as { from?: unknown; to?: unknown };
      const from = cleanRedirectSource(wanted.from);
      if (!from) {
        return Response.json({ error: "Redirect from a website page address, like /p/old-page." }, { status: 400 });
      }
      const to = cleanRedirectTarget(wanted.to);
      if (!to) {
        return Response.json(
          { error: "Redirect to another /p/ address or a page on https://maintsupp.com — never another site." },
          { status: 400 },
        );
      }
      const pagesNow = await listPages(scope.db);
      if (pagesNow.some((page) => `/p/${page.slug}` === from)) {
        return Response.json(
          { error: `A page lives at ${from}. Move or delete it first; a page always wins over a redirect.` },
          { status: 409 },
        );
      }
      const plan = planRedirect(await redirectMap(scope.db), from, to);
      if ("error" in plan) return Response.json({ error: plan.error }, { status: 409 });
      await saveRedirect(scope.db, from, plan.target, "manual", scope.identityEmail.toLowerCase());
      await recordAudit({
        db: scope.db,
        organisationId: scope.orgId,
        actor: auditActor(scope),
        action: "site_redirect.added",
        entityType: "site_redirect",
        entityId: from,
        summary: `Redirected ${from} to ${plan.target}.`,
        detail: { from, to: plan.target },
        request,
      });
      return Response.json({
        canEdit: true,
        pages: pagesNow,
        redirects: await listRedirects(scope.db),
        catalogue: BLOCK_CATALOGUE,
        omissions: CMS_OMISSIONS,
      });
    }

    /*
     * §38b — RESTORE a page to a recorded version, keyed by its slug: the
     * version's title, search text, published flag and blocks replace the body,
     * then EVERY check below runs on them — the slug rules, `validateBlock`, the
     * claims rules — so an old page that breaks today's rules is refused whole.
     * The history is the installation's (no workspace); the request carries
     * only the slug and the number. A page that was deleted comes back this way:
     * restore the version before its deletion marker.
     */
    const restoring = restoreVersionFrom(payload);
    if (restoring) {
      const key = cleanSlug(payload.slug);
      if (!key) return Response.json({ error: "Name the page to restore." }, { status: 400 });
      const loaded = await loadRestoreSnapshot(scope.db, { organisationId: null, subject: "site_page", key }, restoring);
      if (!loaded.ok) return Response.json({ error: loaded.error }, { status: loaded.status });
      const snapshot = loaded.snapshot as PageSnapshot;
      payload.title = snapshot.title;
      payload.metaTitle = snapshot.metaTitle;
      payload.metaDescription = snapshot.metaDescription;
      payload.published = snapshot.published;
      payload.blocks = snapshot.blocks;
    }

    /*
     * DUPLICATE (§6, §77 item 10) — a copy of a page as it is SAVED: the same
     * blocks and search text, as a new unpublished draft at the first free
     * `<slug>-copy` address, with "(copy)" on its title. From here on it is an
     * ordinary new page: every rule below runs on it, through the create path.
     */
    let duplicatedFrom: string | null = null;
    if (typeof payload.duplicate === "string") {
      const sourceSlug = cleanSlug(payload.duplicate);
      const everyPage = await listPages(scope.db);
      const source = sourceSlug ? everyPage.find((page) => page.slug === sourceSlug) : undefined;
      if (!source) {
        return Response.json({ error: "There is no page at that address to duplicate." }, { status: 404 });
      }
      const copy = copySlugFor(source.slug, new Set(everyPage.map((page) => page.slug)));
      if (!copy) {
        return Response.json({ error: "There is no free address for another copy. Rename or delete earlier copies first." }, { status: 409 });
      }
      duplicatedFrom = source.slug;
      payload.slug = copy;
      payload.original = null;
      payload.title = `${source.title.slice(0, 173)} (copy)`;
      payload.metaTitle = source.metaTitle;
      payload.metaDescription = source.metaDescription;
      payload.published = false;
      payload.blocks = source.blocks.map((block) => ({ kind: block.kind, body: block.body }));
    }

    const slug = cleanSlug(payload.slug);
    if (!slug) {
      return Response.json(
        {
          error:
            "A slug must be lowercase letters, digits and single hyphens, and must not be a name the site already uses.",
        },
        { status: 400 },
      );
    }
    const title = text(payload.title, 180);
    if (!title) {
      return Response.json({ error: "A page needs a title." }, { status: 400 });
    }
    if (typeof payload.published !== "boolean") {
      return Response.json(
        { error: "published must be true or false." },
        { status: 400 },
      );
    }
    if (!Array.isArray(payload.blocks)) {
      return Response.json({ error: "blocks must be a list." }, { status: 400 });
    }
    if (payload.blocks.length > 40) {
      return Response.json(
        { error: "A page may have at most 40 blocks." },
        { status: 400 },
      );
    }

    /*
     * Validate every block before writing any of it, for the reason `/api/theme`
     * gives: a partial save leaves an editor looking at a page that is neither what
     * they had nor what they asked for, with no way to tell which half landed.
     */
    const blocks: Array<{ kind: string; body: BlockBody }> = [];
    for (const [index, raw] of payload.blocks.entries()) {
      const entry = (raw ?? {}) as { kind?: unknown; body?: unknown };
      const checked = validateBlock(entry.kind, entry.body);
      if (!checked.ok) {
        return Response.json(
          { error: `Block ${index + 1}: ${checked.reason}`, block: index },
          { status: 400 },
        );
      }
      blocks.push({ kind: checked.kind, body: checked.body });
    }

    /*
     * DECISION K — AN IMAGE OR A VIDEO IS AN ASSET IN THE LIBRARY, NOW.
     *
     * `validateBlock` can only see that a block names a well-formed id; whether
     * that asset exists, is the kind the block draws, and — for an image — has
     * something for a screen reader to say, is only knowable here. Asked of every
     * save, a restore included, so an old version that names a deleted asset is
     * refused whole rather than published with a hole in it. An ARCHIVED asset is
     * still an asset: it keeps working on the pages that use it.
     */
    const named = blocks.flatMap((block) => (typeof block.body.mediaId === "string" ? [block.body.mediaId] : []));
    if (named.length) {
      const library = await mediaKinds(scope.db, named);
      for (const [index, block] of blocks.entries()) {
        const mediaId = block.body.mediaId;
        if (typeof mediaId !== "string") continue;
        const asset = library.get(mediaId);
        const noun = block.kind === "video" ? "video" : "image";
        if (!asset || !asset.hasFile) {
          return Response.json(
            { error: `Block ${index + 1}: that ${noun} is no longer in the media library. Choose another.`, block: index },
            { status: 400 },
          );
        }
        if (asset.kind !== block.kind) {
          return Response.json({ error: `Block ${index + 1}: choose ${noun === "video" ? "a video" : "an image"} for this block.`, block: index }, { status: 400 });
        }
        const blockAlt = typeof block.body.alt === "string" && block.body.alt.trim();
        if (block.kind === "image" && !blockAlt && !asset.altText) {
          return Response.json(
            {
              error: `Block ${index + 1}: an image needs alt text — describe it on the block, or give the image alt text in the media library.`,
              block: index,
            },
            { status: 400 },
          );
        }
      }
    }

    /*
     * THE LIFECYCLE AND SEO FIELDS — a publishing window, indexing and a
     * canonical (see `app/lib/cms-seo.ts`). A field the request does not carry
     * keeps the page's current value: a restore replays a version recorded
     * before these existed, and it must not quietly clear a canonical.
     */
    const pages = await listPages(scope.db);
    const current = pages.find(
      (page) => page.slug === (typeof payload.original === "string" ? cleanSlug(payload.original) : slug),
    );
    const span = cleanWindow(
      "publishAt" in payload ? payload.publishAt : (current?.publishAt ?? null),
      "unpublishAt" in payload ? payload.unpublishAt : (current?.unpublishAt ?? null),
    );
    if ("error" in span) return Response.json({ error: span.error }, { status: 400 });
    const canonical = cleanCanonical("canonicalUrl" in payload ? payload.canonicalUrl : (current?.canonicalUrl ?? null));
    if ("error" in canonical) return Response.json({ error: canonical.error }, { status: 400 });
    if ("noindex" in payload && typeof payload.noindex !== "boolean") {
      return Response.json({ error: "noindex must be true or false." }, { status: 400 });
    }
    const robots: "index" | "noindex" =
      "noindex" in payload ? (payload.noindex ? "noindex" : "index") : (current?.robots ?? "index");

    const input: PageInput = {
      slug,
      title,
      metaTitle: text(payload.metaTitle, 180),
      metaDescription: text(payload.metaDescription, 320),
      published: payload.published,
      blocks,
      /* A copy starts as a plain draft: no window, no borrowed canonical. */
      publishAt: duplicatedFrom ? null : span.value.publishAt,
      unpublishAt: duplicatedFrom ? null : span.value.unpublishAt,
      robots,
      canonicalUrl: duplicatedFrom ? null : canonical.value,
    };

    /*
     * The page's own three text fields go through the same claims rules the blocks
     * do. `validateBlock` cannot reach them — they are columns on the page, not
     * fields in a block — and a forbidden phrase in a meta description is the worst
     * place for one: it is what a search result shows, and nothing on the page
     * itself would reveal it.
     */
    const brokenRule = claimViolation(
      [input.title, input.metaTitle, input.metaDescription].filter(Boolean).join(" . "),
    );
    if (brokenRule) {
      return Response.json({ error: `This page: ${brokenRule}.` }, { status: 400 });
    }

    /*
     * WHICH PAGE THIS SAVE IS FOR. The console says: `original` is the address the
     * editor opened, or null for a new page. That is what makes an address edit a
     * MOVE — the page at the old address takes the new one, and the old address
     * redirects to it — and what stops a new page landing on an existing address,
     * which used to overwrite the other page's content without a word. A caller
     * that states no intent (a restore, an older client) keeps upsert-by-address.
     */
    const intent = "original" in payload ? payload.original : undefined;
    let fromSlug = slug;
    if (intent === null && pages.some((page) => page.slug === slug)) {
      return Response.json(
        { error: `A page already lives at /p/${slug}. Open it from the list to edit it, or choose another address.` },
        { status: 409 },
      );
    }
    if (typeof intent === "string") {
      const opened = cleanSlug(intent);
      if (!opened || !pages.some((page) => page.slug === opened)) {
        return Response.json(
          { error: "That page no longer exists. It may have been moved or deleted meanwhile; reload the list." },
          { status: 404 },
        );
      }
      if (opened !== slug && pages.some((page) => page.slug === slug)) {
        return Response.json({ error: `/p/${slug} is already another page's address.` }, { status: 409 });
      }
      fromSlug = opened;
    }
    const renaming = fromSlug !== slug;

    const before = pages.find((page) => page.slug === fromSlug) ?? null;
    const versionTarget: VersionTarget = { organisationId: null, subject: "site_page", key: slug };
    const fromTarget: VersionTarget = { ...versionTarget, key: fromSlug };
    const versionActor = { email: scope.identityEmail, userId: scope.session?.user.id ?? null };
    /* §38b — an existing page's state before history's first write, as version 1,
       under the address it had. */
    if (before) await ensureConfigBaseline(scope.db, fromTarget, pageSnapshot(before), versionActor);
    const result = await writePage(scope.db, input, scope.identityEmail.toLowerCase(), fromSlug);
    if (!result.ok) {
      return Response.json({ error: result.reason }, { status: 503 });
    }
    /*
     * REDIRECTS FOLLOW THE PAGE. A page now lives at `/p/<slug>`, so any
     * redirect FROM that address is gone (a page always wins). A move leaves a
     * redirect behind at the old address — so a saved link, a search result or a
     * shared URL keeps working — and every redirect that led to the old address
     * is re-pointed at the new one (`saveRedirect` collapses the chain).
     */
    await deleteRedirect(scope.db, `/p/${slug}`);
    if (renaming) {
      const plan = planRedirect(await redirectMap(scope.db), `/p/${fromSlug}`, `/p/${slug}`);
      if (!("error" in plan)) {
        await saveRedirect(scope.db, `/p/${fromSlug}`, plan.target, "moved", scope.identityEmail.toLowerCase());
      }
    }
    {
      /* A page that does not exist right now is being created — or, by a
         restore, brought back after its deletion. Its latest version is then the
         deletion marker, which carries the page as it was, so comparing with it
         would record an undelete as "Saved with no change". */
      const previous = before ? await latestSnapshot(scope.db, fromTarget) : null;
      const after = pageSnapshot(input);
      const changed = summariseChange("site_page", previous && !("absent" in (previous as object)) ? previous : null, after);
      /* A move is said as a move, and a copy says where it came from. */
      const summary = renaming
        ? `Renamed from /p/${fromSlug} — ${changed.startsWith("Saved with no change") ? pageShape(after) : changed}`
        : duplicatedFrom
          ? `Duplicated from /p/${duplicatedFrom} — ${pageShape(after)}`
          : changed;
      const recorded = await recordConfigVersion(scope.db, versionTarget, {
        snapshot: after,
        summary: !restoring
          ? summary
          : before
            ? `Restored from version ${restoring} — ${summary}`
            : `Brought back from version ${restoring} after its deletion — ${pageShape(after)}`,
        restoredFrom: restoring,
        actor: versionActor,
      });
      if (restoring) {
        await recordAudit({
          db: scope.db,
          organisationId: scope.orgId,
          actor: auditActor(scope),
          action: "config.version_restored",
          entityType: "config_version",
          entityId: `site_page/${slug}`,
          summary: `Restored the website page /p/${slug} from version ${restoring}.`,
          detail: { subject: "site_page", key: slug, from: restoring, version: recorded },
          request,
        });
      }
      /*
       * The OLD address's history is closed, not deleted and not rewritten: its
       * versions stay where they are, and this marker says where the page went.
       * It is a `renamed` entry rather than a `deleted` one, so "Deleted pages"
       * does not offer to bring back a page that simply moved.
       */
      if (renaming && before) {
        await recordConfigVersion(scope.db, fromTarget, {
          snapshot: pageSnapshot(before),
          kind: "renamed",
          summary: `Moved to /p/${slug}. Its history continues there; nothing here was removed.`,
          actor: versionActor,
        });
      }
    }

    /*
     * Audited against the actor's own organisation, because `audit_events` is
     * scoped that way and there is nowhere else to put it. The entity id is the
     * SLUG rather than the row id: a reader of the trail wants to know which page
     * changed, and the slug is how anybody refers to it.
     */
    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: renaming
        ? "site_page.renamed"
        : duplicatedFrom
          ? "site_page.duplicated"
          : before
            ? input.published
              ? "site_page.published"
              : "site_page.updated"
            : "site_page.created",
      entityType: "site_page",
      entityId: slug,
      summary: renaming
        ? `Moved the website page /p/${fromSlug} to /p/${slug}; the old address now redirects there.`
        : duplicatedFrom
          ? `Duplicated the website page /p/${duplicatedFrom} as the draft /p/${slug}.`
          : `${before ? "Updated" : "Created"} the website page /p/${slug}${
              input.published ? " and published it." : " as a draft."
            }`,
      detail: {
        slug,
        ...(renaming ? { from: fromSlug } : {}),
        ...(duplicatedFrom ? { duplicatedFrom } : {}),
        title: input.title,
        published: input.published,
        blocks: blocks.map((block) => block.kind),
        wasPublished: before?.published ?? false,
      },
      request,
    });

    /* A menu link to this page shows only while the page is live (decision J),
       so the public navigation re-reads the pages' states on this instance. */
    invalidatePublicNavigation();

    return Response.json({
      canEdit: true,
      /* The address this save landed at — a copy's is chosen by the server. */
      saved: slug,
      pages: await listPages(scope.db),
      redirects: await listRedirects(scope.db),
      catalogue: BLOCK_CATALOGUE,
      omissions: CMS_OMISSIONS,
    });
  } catch (error) {
    return unavailable(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const scope = await platformScope(request);
    if (!scope) return forbidden();

    /* Removing a REDIRECT (`?redirect=/p/old`) rather than a page. */
    const redirectParam = new URL(request.url).searchParams.get("redirect");
    if (redirectParam !== null) {
      const from = cleanRedirectSource(redirectParam);
      if (!from || !(await deleteRedirect(scope.db, from))) {
        return Response.json({ error: "There is no redirect from that address." }, { status: 404 });
      }
      await recordAudit({
        db: scope.db,
        organisationId: scope.orgId,
        actor: auditActor(scope),
        action: "site_redirect.removed",
        entityType: "site_redirect",
        entityId: from,
        summary: `Removed the redirect from ${from}; that address now answers 404.`,
        detail: { from },
        request,
      });
      return Response.json({
        canEdit: true,
        pages: await listPages(scope.db),
        redirects: await listRedirects(scope.db),
        catalogue: BLOCK_CATALOGUE,
        omissions: CMS_OMISSIONS,
      });
    }

    const slug = cleanSlug(new URL(request.url).searchParams.get("slug"));
    if (!slug) {
      return Response.json({ error: "Name the page to delete." }, { status: 400 });
    }
    /* §38b — the page as it was, read before it goes: the deletion is recorded
       as a version carrying that state, so "restore the version before it"
       brings the page back exactly. The delete itself stays a real delete. */
    const doomed = (await listPages(scope.db)).find((page) => page.slug === slug) ?? null;
    const versionTarget: VersionTarget = { organisationId: null, subject: "site_page", key: slug };
    const versionActor = { email: scope.identityEmail, userId: scope.session?.user.id ?? null };
    if (doomed) await ensureConfigBaseline(scope.db, versionTarget, pageSnapshot(doomed), versionActor);
    const result = await deletePage(scope.db, slug);
    if (!result.ok) {
      return Response.json({ error: "There is no page with that slug." }, { status: 404 });
    }
    if (doomed) {
      await recordConfigVersion(scope.db, versionTarget, {
        snapshot: pageSnapshot(doomed),
        kind: "deleted",
        summary: `Deleted /p/${slug}. Restore the version before this one to bring it back.`,
        actor: versionActor,
      });
    }

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "site_page.deleted",
      entityType: "site_page",
      entityId: slug,
      /* Said in the trail rather than only in the code: this is a real delete, not
         an archive, and the reason is in `cms-repository.ts`. */
      summary: `Deleted the website page /p/${slug}. This is permanent — a marketing page is not archived.`,
      detail: { slug },
      request,
    });
    /* A menu link to a page that is gone stops showing (decision J). */
    invalidatePublicNavigation();

    return Response.json({
      canEdit: true,
      pages: await listPages(scope.db),
      redirects: await listRedirects(scope.db),
      catalogue: BLOCK_CATALOGUE,
      omissions: CMS_OMISSIONS,
    });
  } catch (error) {
    return unavailable(error);
  }
}
