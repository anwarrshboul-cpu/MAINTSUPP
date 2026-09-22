/**
 * The website CMS's lifecycle and SEO rules — pure, no database.
 *
 * Four things a page on maintsupp.com now carries beyond its words:
 *
 *   - A PUBLISHING WINDOW. `publishAt` / `unpublishAt` are optional. A page is
 *     LIVE when it is published and "now" is inside the window, decided at the
 *     moment it is read (`pageIsLive`). No cron fires; nothing can be missed.
 *   - INDEXING. 'noindex' keeps a page out of search results and out of the
 *     sitemap while it stays reachable by link.
 *   - A CANONICAL override, SAME-SITE ONLY. A canonical pointing off-site would
 *     hand this page's search ranking to someone else.
 *   - REDIRECTS from an old `/p/<slug>` address. The target is another
 *     `/p/<slug>` or an https://maintsupp.com URL — never another host, so a
 *     redirect can never be used to bounce a visitor off-site (an open
 *     redirect). Chains are collapsed when a redirect is written and loops are
 *     refused; serving follows at most a few hops as a second wall.
 */

import { cleanSlug } from "./cms-blocks.ts";

export const SITE_ORIGIN = "https://maintsupp.com";

/**
 * The request header `proxy.ts` sets from `?preview=1` on a `/p/<slug>`
 * request, because the framework's first render pass cannot see the query.
 * A REQUEST for a preview only — the page grants it to platform staff alone.
 */
export const PREVIEW_REQUEST_HEADER = "x-maintsupp-cms-preview";

/** A page's two window ends as ISO strings, or null for "no bound". */
export type PublishingWindow = { publishAt: string | null; unpublishAt: string | null };

/** Live = published AND inside the window. Compared as instants, in JavaScript. */
export function pageIsLive(
  page: { published: boolean } & PublishingWindow,
  now: number = Date.now(),
): boolean {
  if (!page.published) return false;
  if (page.publishAt && Date.parse(page.publishAt) > now) return false;
  if (page.unpublishAt && Date.parse(page.unpublishAt) <= now) return false;
  return true;
}

/** What the console shows about a page's state right now. */
export function pageState(
  page: { published: boolean } & PublishingWindow,
  now: number = Date.now(),
): "draft" | "scheduled" | "live" | "ended" {
  if (!page.published) return "draft";
  if (page.publishAt && Date.parse(page.publishAt) > now) return "scheduled";
  if (page.unpublishAt && Date.parse(page.unpublishAt) <= now) return "ended";
  return "live";
}

/**
 * An optional instant from the console: empty means "no bound", anything else
 * must parse. Returns the ISO form, or `{ error }`.
 */
export function cleanInstant(value: unknown): { value: string | null } | { error: string } {
  if (value === null || value === undefined || value === "") return { value: null };
  if (typeof value !== "string") return { error: "A date and time is expected." };
  const time = Date.parse(value);
  if (Number.isNaN(time)) return { error: `"${value.slice(0, 40)}" is not a date and time.` };
  return { value: new Date(time).toISOString() };
}

/** Both ends together: the window must not close before it opens. */
export function cleanWindow(
  publishAt: unknown,
  unpublishAt: unknown,
): { value: PublishingWindow } | { error: string } {
  const start = cleanInstant(publishAt);
  if ("error" in start) return { error: `Publish from: ${start.error}` };
  const end = cleanInstant(unpublishAt);
  if ("error" in end) return { error: `Unpublish at: ${end.error}` };
  if (start.value && end.value && Date.parse(end.value) <= Date.parse(start.value)) {
    return { error: "The page must be unpublished after it is published." };
  }
  return { value: { publishAt: start.value, unpublishAt: end.value } };
}

/*
 * A same-site path: starts with one "/", then only the characters a plain URL
 * path needs. No "//" (a protocol-relative URL is another host), no backslash
 * (browsers read "\\" as "/"), no "@", no control characters.
 */
const SAFE_PATH = /^\/(?!\/)[A-Za-z0-9\-._~/]*$/;

function sameSitePath(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith(SITE_ORIGIN)) {
    const rest = trimmed.slice(SITE_ORIGIN.length) || "/";
    return SAFE_PATH.test(rest) && !rest.includes("//") ? rest : null;
  }
  return SAFE_PATH.test(trimmed) && !trimmed.includes("//") ? trimmed : null;
}

/**
 * A canonical override: a same-site path or https://maintsupp.com URL, stored
 * as the absolute URL. Empty means "the page's own address". Anything on
 * another host — or that could be read as one — is refused.
 */
export function cleanCanonical(value: unknown): { value: string | null } | { error: string } {
  if (value === null || value === undefined || value === "") return { value: null };
  if (typeof value !== "string") return { error: "A canonical address is expected." };
  const path = sameSitePath(value);
  if (!path) {
    return { error: "A canonical address must be on maintsupp.com — a path like /p/pricing, or https://maintsupp.com/…" };
  }
  return { value: `${SITE_ORIGIN}${path}` };
}

/** A redirect's source: only a CMS address, `/p/<valid slug>`. */
export function cleanRedirectSource(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^\/p\/([^/?#]+)$/.exec(value.trim());
  const slug = match ? cleanSlug(match[1]) : null;
  return slug ? `/p/${slug}` : null;
}

/**
 * A redirect's target: another CMS address, or a page on maintsupp.com. Stored
 * as `/p/<slug>` for a CMS address and as an absolute https://maintsupp.com URL
 * otherwise, so what is stored is exactly what the browser is sent.
 */
export function cleanRedirectTarget(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const path = sameSitePath(value);
  if (!path) return null;
  const cms = cleanRedirectSource(path);
  if (cms) return cms;
  if (path.startsWith("/p/")) return null; // a malformed CMS address
  return `${SITE_ORIGIN}${path}`;
}

/** Where a CMS address finally leads, following stored redirects; null for none or a loop. */
export function resolveRedirect(
  redirects: ReadonlyMap<string, string>,
  from: string,
  maxHops = 5,
): string | null {
  let current = from;
  const seen = new Set<string>([from]);
  let target: string | null = null;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const next = redirects.get(current);
    if (!next) break;
    if (seen.has(next)) return null; // a loop leads nowhere
    target = next;
    seen.add(next);
    current = next;
  }
  // Still pointing onwards after the last hop: treat as unresolvable, not "stop halfway".
  if (target && redirects.has(current)) return null;
  return target;
}

/**
 * Adding `from → to` to `redirects`: what to store, or why not. The stored
 * target is COLLAPSED to the final destination, and a redirect that would lead
 * back to its own source is refused.
 */
export function planRedirect(
  redirects: ReadonlyMap<string, string>,
  from: string,
  to: string,
): { target: string } | { error: string } {
  if (from === to) return { error: "An address cannot redirect to itself." };
  const onward = redirects.has(to) ? resolveRedirect(redirects, to) : to;
  if (onward === null) return { error: `${to} is already part of a redirect loop.` };
  if (onward === from) return { error: `That would make a loop: ${to} already leads back to ${from}.` };
  return { target: onward };
}

/** A page as the sitemap needs it. */
export type SitemapCandidate = { slug: string; updatedAt: string; robots: string; canonicalUrl: string | null } & {
  published: boolean;
} & PublishingWindow;

/**
 * The CMS pages a crawler should be told about, with a TRUTHFUL lastmod: only
 * pages live NOW, indexed, and canonical to their own address (a page that
 * names another canonical is saying "index that one instead", and a sitemap
 * that listed it would contradict it). `lastmod` is the day the public page
 * last changed — its last edit, or the moment its window opened if that came
 * later, since before then the address answered 404.
 */
export function sitemapEntries(
  pages: readonly SitemapCandidate[],
  now: number = Date.now(),
): Array<{ loc: string; lastmod: string }> {
  const out: Array<{ loc: string; lastmod: string }> = [];
  for (const page of pages) {
    if (!pageIsLive(page, now) || page.robots === "noindex") continue;
    const loc = `${SITE_ORIGIN}/p/${page.slug}`;
    if (page.canonicalUrl && page.canonicalUrl !== loc) continue;
    const edited = Date.parse(page.updatedAt);
    const opened = page.publishAt ? Date.parse(page.publishAt) : Number.NaN;
    const changed = Number.isNaN(opened) ? edited : Math.max(edited, opened);
    if (Number.isNaN(changed)) continue;
    out.push({ loc, lastmod: new Date(changed).toISOString().slice(0, 10) });
  }
  return out.sort((a, b) => (a.loc < b.loc ? -1 : 1));
}

/** The sitemap document itself, in the same shape as `public/sitemap.xml`. */
export function sitemapXml(entries: ReadonlyArray<{ loc: string; lastmod: string }>): string {
  const urls = entries
    .map((entry) => `  <url>\n    <loc>${entry.loc}</loc>\n    <lastmod>${entry.lastmod}</lastmod>\n  </url>\n`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}</urlset>\n`;
}
