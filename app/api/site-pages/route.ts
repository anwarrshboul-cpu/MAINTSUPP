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
  listPages,
  writePage,
  type PageInput,
} from "../../lib/cms-repository.ts";

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

const FORBIDDEN = Response.json(
  { error: "The website is administered by MAINTSUPP platform staff." },
  { status: 403 },
);

/** `scope.platformAdmin` or nothing. See the header for why not a capability. */
async function platformScope(request: Request) {
  const scope = await scopedDb(request);
  if (scope.platformAdmin !== true) return null;
  if (!scope.authenticated) return null;
  return scope;
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
    if (!scope) return FORBIDDEN;

    return Response.json({
      canEdit: true,
      pages: await listPages(scope.db),
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
    if (!scope) return FORBIDDEN;

    const payload = (await request.json().catch(() => null)) as {
      slug?: unknown;
      title?: unknown;
      metaTitle?: unknown;
      metaDescription?: unknown;
      published?: unknown;
      blocks?: unknown;
    } | null;
    if (!payload) {
      return Response.json({ error: "Send a page object." }, { status: 400 });
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

    const input: PageInput = {
      slug,
      title,
      metaTitle: text(payload.metaTitle, 180),
      metaDescription: text(payload.metaDescription, 320),
      published: payload.published,
      blocks,
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

    const before = (await listPages(scope.db)).find((page) => page.slug === slug) ?? null;
    const result = await writePage(scope.db, input, scope.identityEmail.toLowerCase());
    if (!result.ok) {
      return Response.json({ error: result.reason }, { status: 503 });
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
      action: before
        ? input.published
          ? "site_page.published"
          : "site_page.updated"
        : "site_page.created",
      entityType: "site_page",
      entityId: slug,
      summary: `${before ? "Updated" : "Created"} the website page /p/${slug}${
        input.published ? " and published it." : " as a draft."
      }`,
      detail: {
        slug,
        title: input.title,
        published: input.published,
        blocks: blocks.map((block) => block.kind),
        wasPublished: before?.published ?? false,
      },
      request,
    });

    return Response.json({
      canEdit: true,
      pages: await listPages(scope.db),
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
    if (!scope) return FORBIDDEN;

    const slug = cleanSlug(new URL(request.url).searchParams.get("slug"));
    if (!slug) {
      return Response.json({ error: "Name the page to delete." }, { status: 400 });
    }
    const result = await deletePage(scope.db, slug);
    if (!result.ok) {
      return Response.json({ error: "There is no page with that slug." }, { status: 404 });
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

    return Response.json({
      canEdit: true,
      pages: await listPages(scope.db),
      catalogue: BLOCK_CATALOGUE,
      omissions: CMS_OMISSIONS,
    });
  } catch (error) {
    return unavailable(error);
  }
}
