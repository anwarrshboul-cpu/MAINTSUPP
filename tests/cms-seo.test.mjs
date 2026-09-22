/**
 * The website CMS's lifecycle and SEO — Master Specification §6 (schedule,
 * redirects), §11 (SEO management), §44/§45 (preview).
 *
 *   - REDIRECTS. Moving a page leaves a 308 at its old address; staff add and
 *     remove more. A target is another /p/ address or a page on maintsupp.com —
 *     never another host, so a redirect is never an open redirect. Chains are
 *     collapsed when written and loops refused; serving follows at most a few
 *     hops as a second wall.
 *   - A PUBLISHING WINDOW, decided when the page is read. No cron.
 *   - INDEXING and a SAME-SITE CANONICAL per page, applied by generateMetadata;
 *     a noindex page is also out of the sitemap.
 *   - A PREVIEW for signed-in platform staff only, never indexed.
 *   - `/sitemap-pages.xml`: live, indexable pages with a truthful lastmod.
 *
 * Three halves: the pure rules (`app/lib/cms-seo.ts`), the repository against a
 * real SQLite built from `db/init.ts`'s own DDL, and the live server.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import "./reports-ts-loader.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const seo = await import("../app/lib/cms-seo.ts");
const repo = await import("../app/lib/cms-repository.ts");

/* ------------------------------------------------------------------ */
/* The publishing window                                               */
/* ------------------------------------------------------------------ */

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const at = (offsetMinutes) => new Date(NOW + offsetMinutes * 60_000).toISOString();

test("a page is live only when published and inside its window, decided at the instant asked", () => {
  const page = (published, publishAt = null, unpublishAt = null) => ({ published, publishAt, unpublishAt });
  assert.equal(seo.pageIsLive(page(true), NOW), true, "no window: published is live");
  assert.equal(seo.pageIsLive(page(false), NOW), false, "a draft is never live");
  assert.equal(seo.pageIsLive(page(false, at(-60)), NOW), false, "a window does not publish a draft");
  assert.equal(seo.pageIsLive(page(true, at(1)), NOW), false, "not yet");
  assert.equal(seo.pageIsLive(page(true, at(0)), NOW), true, "the opening instant is inside");
  assert.equal(seo.pageIsLive(page(true, null, at(0)), NOW), false, "the closing instant is outside");
  assert.equal(seo.pageIsLive(page(true, at(-60), at(60)), NOW), true);

  assert.equal(seo.pageState(page(false), NOW), "draft");
  assert.equal(seo.pageState(page(true, at(5)), NOW), "scheduled");
  assert.equal(seo.pageState(page(true, at(-5), at(-1)), NOW), "ended");
  assert.equal(seo.pageState(page(true, at(-5), at(5)), NOW), "live");
  /* The same page, asked again later, has moved on with no write in between. */
  assert.equal(seo.pageState(page(true, at(5)), NOW + 10 * 60_000), "live");
});

test("a window is cleaned to ISO instants, and must close after it opens", () => {
  assert.deepEqual(seo.cleanWindow("", null), { value: { publishAt: null, unpublishAt: null } });
  assert.deepEqual(seo.cleanWindow("2026-10-01T09:00:00Z", undefined), {
    value: { publishAt: "2026-10-01T09:00:00.000Z", unpublishAt: null },
  });
  assert.match(seo.cleanWindow("next tuesday", null).error, /Publish from/);
  assert.match(seo.cleanWindow(null, 5).error, /Unpublish at/);
  assert.match(seo.cleanWindow(at(10), at(10)).error, /after it is published/);
  assert.match(seo.cleanWindow(at(10), at(5)).error, /after it is published/);
});

/* ------------------------------------------------------------------ */
/* Same-site only: canonicals and redirect targets                     */
/* ------------------------------------------------------------------ */

/* Every way a URL has been used to smuggle another host past a check. */
const OFF_SITE = [
  "https://evil.example/p/x",
  "http://maintsupp.com/p/x",
  "//evil.example/p/x",
  "///evil.example",
  "/\\evil.example",
  "\\\\evil.example",
  "https://maintsupp.com.evil.example/p/x",
  "https://maintsupp.com@evil.example/p/x",
  "https://maintsupp.com//evil.example",
  "javascript:alert(1)",
  "data:text/html,hi",
  "/%2F%2Fevil.example",
  "evil.example",
  " https://evil.example",
];

test("a canonical override is same-site only, stored absolute", () => {
  assert.deepEqual(seo.cleanCanonical(""), { value: null }, "empty is the page's own address");
  assert.deepEqual(seo.cleanCanonical(null), { value: null });
  assert.deepEqual(seo.cleanCanonical("/p/pricing"), { value: "https://maintsupp.com/p/pricing" });
  assert.deepEqual(seo.cleanCanonical("https://maintsupp.com/contractors"), { value: "https://maintsupp.com/contractors" });
  assert.deepEqual(seo.cleanCanonical("https://maintsupp.com"), { value: "https://maintsupp.com/" });
  for (const value of OFF_SITE) {
    assert.ok("error" in seo.cleanCanonical(value), `${JSON.stringify(value)} must be refused as a canonical`);
  }
  assert.ok("error" in seo.cleanCanonical(42));
});

test("a redirect goes from a /p/ address to a /p/ address or a maintsupp.com page — never off-site", () => {
  assert.equal(seo.cleanRedirectSource("/p/old-page"), "/p/old-page");
  assert.equal(seo.cleanRedirectSource(" /p/Old-Page "), "/p/old-page", "the slug rule, lower-cased");
  for (const value of ["/faqs", "/p/", "/p/a/b", "/p/a?x=1", "/p/-bad", "p/old", "https://maintsupp.com/p/old", 7, null]) {
    assert.equal(seo.cleanRedirectSource(value), null, `${JSON.stringify(value)} is not a CMS address`);
  }

  assert.equal(seo.cleanRedirectTarget("/p/new-page"), "/p/new-page");
  assert.equal(seo.cleanRedirectTarget("https://maintsupp.com/p/new-page"), "/p/new-page", "a CMS address is stored as one");
  assert.equal(seo.cleanRedirectTarget("/contractors"), "https://maintsupp.com/contractors");
  assert.equal(seo.cleanRedirectTarget("https://maintsupp.com/faqs"), "https://maintsupp.com/faqs");
  assert.equal(seo.cleanRedirectTarget("/p/../admin"), null, "a malformed /p/ address is not quietly a site path");
  assert.equal(seo.cleanRedirectTarget("/p/Bad_Slug"), null);
  assert.equal(seo.cleanRedirectTarget(""), null);
  for (const value of OFF_SITE) {
    assert.equal(seo.cleanRedirectTarget(value), null, `${JSON.stringify(value)} would be an open redirect`);
  }
});

/* ------------------------------------------------------------------ */
/* Chains and loops                                                    */
/* ------------------------------------------------------------------ */

test("serving follows a chain to its end, and a loop or an over-long chain leads nowhere", () => {
  const map = (pairs) => new Map(pairs);
  assert.equal(seo.resolveRedirect(map([]), "/p/a"), null, "no redirect");
  assert.equal(seo.resolveRedirect(map([["/p/a", "/p/b"]]), "/p/a"), "/p/b");
  assert.equal(seo.resolveRedirect(map([["/p/a", "/p/b"], ["/p/b", "/p/c"]]), "/p/a"), "/p/c", "a chain is followed");
  assert.equal(seo.resolveRedirect(map([["/p/a", "/p/b"], ["/p/b", "/p/a"]]), "/p/a"), null, "a two-step loop");
  assert.equal(seo.resolveRedirect(map([["/p/a", "/p/b"], ["/p/b", "/p/c"], ["/p/c", "/p/b"]]), "/p/a"), null, "a loop further on");
  const long = map(["a", "b", "c", "d", "e", "f", "g"].map((name, index, all) => [`/p/${name}`, `/p/${all[index + 1] ?? "end"}`]));
  assert.equal(seo.resolveRedirect(long, "/p/a"), null, "beyond the hop limit is refused, not stopped halfway");
  assert.equal(seo.resolveRedirect(long, "/p/c"), "/p/end", "within it, the end");
  assert.equal(seo.resolveRedirect(map([["/p/a", "https://maintsupp.com/faqs"]]), "/p/a"), "https://maintsupp.com/faqs");
});

test("writing a redirect collapses the chain and refuses a loop", () => {
  const existing = new Map([
    ["/p/a", "/p/b"],
    ["/p/x", "/p/y"],
    ["/p/y", "/p/x"],
  ]);
  assert.deepEqual(seo.planRedirect(existing, "/p/z", "/p/a"), { target: "/p/b" }, "stored as the final destination");
  assert.deepEqual(seo.planRedirect(existing, "/p/z", "/p/new"), { target: "/p/new" });
  assert.match(seo.planRedirect(existing, "/p/z", "/p/z").error, /itself/);
  assert.match(seo.planRedirect(existing, "/p/b", "/p/a").error, /loop/, "b → a would close a → b → a");
  assert.match(seo.planRedirect(existing, "/p/z", "/p/x").error, /loop/, "an existing loop is not a destination");
});

/* ------------------------------------------------------------------ */
/* The sitemap                                                         */
/* ------------------------------------------------------------------ */

test("the pages sitemap lists live, indexable, self-canonical pages with the day each last changed", () => {
  const base = { published: true, publishAt: null, unpublishAt: null, robots: "index", canonicalUrl: null, updatedAt: "2026-09-20T08:00:00.000Z" };
  const entries = seo.sitemapEntries(
    [
      { ...base, slug: "plain" },
      { ...base, slug: "hidden", robots: "noindex" },
      { ...base, slug: "draft", published: false },
      { ...base, slug: "later", publishAt: at(60) },
      { ...base, slug: "over", unpublishAt: at(-60) },
      { ...base, slug: "elsewhere", canonicalUrl: "https://maintsupp.com/contractors" },
      { ...base, slug: "self", canonicalUrl: "https://maintsupp.com/p/self" },
      /* Went public at its window, after its last edit: THAT is when the public page changed. */
      { ...base, slug: "opened", publishAt: "2026-09-21T23:30:00.000Z" },
    ],
    NOW,
  );
  assert.deepEqual(entries, [
    { loc: "https://maintsupp.com/p/opened", lastmod: "2026-09-21" },
    { loc: "https://maintsupp.com/p/plain", lastmod: "2026-09-20" },
    { loc: "https://maintsupp.com/p/self", lastmod: "2026-09-20" },
  ]);
  const xml = seo.sitemapXml(entries);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.equal([...xml.matchAll(/<url>/g)].length, 3);
  assert.match(xml, /<loc>https:\/\/maintsupp\.com\/p\/plain<\/loc>\n    <lastmod>2026-09-20<\/lastmod>/);
  assert.match(seo.sitemapXml([]), /<urlset[^>]*>\n<\/urlset>\n$/, "no pages is an empty, valid sitemap");
});

/* ------------------------------------------------------------------ */
/* Source: where each rule is applied                                  */
/* ------------------------------------------------------------------ */

test("the public route: preview for staff only, a live page before a redirect, a redirect before a 404", async () => {
  const page = code(await read("app/(marketing)/p/[slug]/page.tsx"));
  assert.match(page, /const asked = \(await searchParams\)\.preview === "1" \|\| incoming\.get\(PREVIEW_REQUEST_HEADER\) === "1";\s*if \(!asked\) return false;/);
  /* The header only carries `?preview=1` past vinext's probe pass; the proxy
     drops any incoming copy and runs for /p/<slug> alone. */
  const proxy = code(await read("proxy.ts"));
  assert.match(proxy, /headers\.delete\(PREVIEW_REQUEST_HEADER\);\s*if \(request\.nextUrl\.searchParams\.get\("preview"\) === "1"\) headers\.set\(PREVIEW_REQUEST_HEADER, "1"\);/);
  assert.match(proxy, /export const config = \{ matcher: "\/p\/:slug" \};/);
  assert.match(page, /return scope\.platformAdmin === true && scope\.authenticated;/, "signed-in platform staff, not the dev demo identity");
  assert.match(page, /\} catch \{\s*return false;\s*\}/, "a failure to decide is no");
  assert.ok(page.indexOf("permanentRedirect(target)") < page.indexOf("if (!page) notFound();"), "a redirect is tried before the 404");
  assert.match(page, /if \(!page\) \{\s*const target = await leadsTo\(slug\);/, "only when no live page is here");
  /* A preview is never for a crawler; a noindex page keeps `follow`. */
  assert.match(page, /\? \{ robots: \{ index: false, follow: false \} \}\s*: page\.robots === "noindex"\s*\? \{ robots: \{ index: false, follow: true \} \}/);
  assert.match(page, /export const dynamic = "force-dynamic"/);

  const repository = code(await read("app/lib/cms-repository.ts"));
  const published = repository.slice(repository.indexOf("export async function readPublishedPage"));
  assert.match(published, /if \(!pageIsLive\(read, now\)\) return null;/, "the window is applied on the public read");
});

test("the API: redirects stay behind the platform gate, are validated, and follow a moved page", async () => {
  const route = code(await read("app/api/site-pages/route.ts"));
  assert.equal((route.match(/return forbidden\(\);/g) ?? []).length, 3, "no new door around the platform gate");
  const put = route.slice(route.indexOf("export async function PUT"), route.indexOf("export async function DELETE"));
  assert.ok(put.indexOf("requirePlatformAdmin") < put.indexOf("payload.redirect !== undefined"), "the gate before the redirect branch");
  assert.match(put, /const from = cleanRedirectSource\(wanted\.from\);/);
  assert.match(put, /const to = cleanRedirectTarget\(wanted\.to\);/);
  assert.match(put, /const plan = planRedirect\(await redirectMap\(scope\.db\), from, to\);/);
  assert.match(put, /await deleteRedirect\(scope\.db, `\/p\/\$\{slug\}`\);/, "a page at an address removes a redirect from it");
  assert.match(put, /saveRedirect\(scope\.db, `\/p\/\$\{fromSlug\}`, plan\.target, "moved"/, "a move leaves a redirect");
  assert.match(put, /const canonical = cleanCanonical\(/);
  assert.match(put, /const span = cleanWindow\(/);
  const remove = route.slice(route.indexOf("export async function DELETE"));
  assert.ok(remove.indexOf("requirePlatformAdmin") < remove.indexOf('searchParams.get("redirect")'), "and before removing one");
});

test("the migration is additive: four guarded columns, one guarded table, text states", async () => {
  const init = await read("db/init.ts");
  /* RE-POINTED (decision J): this sliced up to `ensureThemeTokens`, the function
     that happened to follow. `ensureSiteNavigation` now sits between the two, so
     the slice swept in another stage's comment ("a rename") and failed on it.
     Bounded by this function's own closing brace at column zero instead — the
     same assertion, about exactly this stage and nothing after it. */
  const stageStart = init.indexOf("async function ensureSitePageLifecycle");
  const stage = init.slice(stageStart, init.indexOf("\n}\n", stageStart) + 2);
  assert.match(init, /await ensureSitePageLifecycle\(d1\);/);
  assert.match(stage, /addColumns\(d1, "site_pages", \[/);
  assert.match(stage, /\["robots", "TEXT NOT NULL DEFAULT 'index'"\]/, "a state is TEXT, never a boolean");
  assert.match(stage, /CREATE TABLE IF NOT EXISTS site_redirects/);
  assert.match(stage, /CREATE UNIQUE INDEX IF NOT EXISTS site_redirects_from_idx ON site_redirects\(from_path\)/);
  assert.doesNotMatch(stage, /\bDROP\b|\bRENAME\b|BOOLEAN/i);
  /* BOOLEAN_COLUMNS rewrites 0/1 BY COLUMN NAME; none of these may be in it. */
  const shim = await read("db/sqlite-to-postgres.ts");
  const booleans = shim.slice(shim.indexOf("BOOLEAN_COLUMNS"), shim.indexOf("]", shim.indexOf("BOOLEAN_COLUMNS")));
  for (const column of ["robots", "publish_at", "unpublish_at", "canonical_url", "kind", "from_path", "to_target"]) {
    assert.doesNotMatch(booleans, new RegExp(`"${column}"`), `${column} must not be rewritten as a boolean`);
  }
});

test("the pages sitemap is named in robots.txt and the static one is untouched", async () => {
  const robots = await read("public/robots.txt");
  assert.match(robots, /^Sitemap: https:\/\/maintsupp\.com\/sitemap\.xml$/m);
  assert.match(robots, /^Sitemap: https:\/\/maintsupp\.com\/sitemap-pages\.xml$/m);
  const route = code(await read("app/sitemap-pages.xml/route.ts"));
  assert.match(route, /sitemapXml\(sitemapEntries\(pages\)\)/);
  assert.match(route, /"content-type": "application\/xml; charset=utf-8"/);
  assert.doesNotMatch(await read("public/sitemap.xml"), /\/p\//);
});

/* ------------------------------------------------------------------ */
/* The repository, against db/init.ts's own DDL                        */
/* ------------------------------------------------------------------ */

async function database() {
  const sqlite = new DatabaseSync(":memory:");
  const init = await read("db/init.ts");
  for (const table of ["site_pages", "site_blocks"]) {
    sqlite.exec(init.match(new RegExp("`(CREATE TABLE IF NOT EXISTS " + table + " \\([\\s\\S]*?\\))`"))[1]);
  }
  sqlite.exec(init.match(/"(CREATE UNIQUE INDEX IF NOT EXISTS site_pages_slug_idx[^"]+)"/)[1]);
  /* The new stage, exactly as written: its columns and its table. */
  /* RE-POINTED (decision J), as above: bounded by this stage's own closing brace. */
  const stageStart = init.indexOf("async function ensureSitePageLifecycle");
  const stage = init.slice(stageStart, init.indexOf("\n}\n", stageStart) + 2);
  for (const [, column, definition] of stage.matchAll(/\["(\w+)", "([^"]+)"\]/g)) {
    sqlite.exec(`ALTER TABLE site_pages ADD COLUMN ${column} ${definition}`);
  }
  sqlite.exec(stage.match(/`(CREATE TABLE IF NOT EXISTS site_redirects \([\s\S]*?\))`/)[1]);
  sqlite.exec(stage.match(/"(CREATE UNIQUE INDEX IF NOT EXISTS site_redirects_from_idx[^"]+)"/)[1]);
  return drizzle(async (sql, params, method) => {
    const statement = sqlite.prepare(sql);
    const values = params.map((value) => (value === undefined ? null : value));
    if (method === "run") {
      statement.run(...values);
      return { rows: [] };
    }
    statement.setReturnArrays?.(true);
    const rows = statement.all(...values).map((row) => (Array.isArray(row) ? row : Object.values(row)));
    return { rows: method === "get" ? rows[0] : rows };
  });
}

const input = (slug, extra = {}) => ({
  slug,
  title: slug,
  metaTitle: null,
  metaDescription: null,
  published: true,
  blocks: [{ kind: "heading", body: { title: slug } }],
  ...extra,
});

test("the public read honours the window; a preview read sees every state", async () => {
  const db = await database();
  const actor = "staff@maintsupp.com";
  await repo.writePage(db, input("open"), actor);
  await repo.writePage(db, input("soon", { publishAt: at(60) }), actor);
  await repo.writePage(db, input("gone", { unpublishAt: at(-60) }), actor);
  await repo.writePage(db, input("hidden", { robots: "noindex", canonicalUrl: "https://maintsupp.com/p/open" }), actor);
  await repo.writePage(db, input("draft", { published: false }), actor);

  assert.equal((await repo.readPublishedPage(db, "open", NOW))?.state, "live");
  assert.equal(await repo.readPublishedPage(db, "soon", NOW), null, "scheduled reads as not here");
  assert.equal((await repo.readPublishedPage(db, "soon", NOW + 2 * 3_600_000))?.slug, "soon", "and is here once its window opens");
  assert.equal(await repo.readPublishedPage(db, "gone", NOW), null, "ended reads as not here");
  assert.equal(await repo.readPublishedPage(db, "draft", NOW), null);

  const hidden = await repo.readPublishedPage(db, "hidden", NOW);
  assert.equal(hidden.robots, "noindex");
  assert.equal(hidden.canonicalUrl, "https://maintsupp.com/p/open");
  assert.equal(hidden.blocks.length, 1, "the live read still carries the blocks");

  /* At NOW, like every read above. This line read the real clock, so from
     13:00 UTC on 2026-09-22 — an hour past the fixed NOW — "soon" was live and
     the test failed on an untouched tree. */
  assert.equal((await repo.readPageForPreview(db, "draft", NOW))?.state, "draft");
  assert.equal((await repo.readPageForPreview(db, "soon", NOW))?.state, "scheduled");
  assert.equal(await repo.readPageForPreview(db, "never", NOW), null);

  const listed = (await repo.listPagesForSitemap(db)).map((page) => page.slug).sort();
  assert.deepEqual(listed, ["draft", "gone", "hidden", "open", "soon"], "every row; the rules pick");
  assert.deepEqual(
    seo.sitemapEntries(await repo.listPagesForSitemap(db), NOW).map((entry) => entry.loc),
    ["https://maintsupp.com/p/open"],
  );
});

test("redirects: one per address, a chain re-pointed when written, removed by address", async () => {
  const db = await database();
  const actor = "staff@maintsupp.com";
  await repo.saveRedirect(db, "/p/a", "/p/b", "moved", actor);
  assert.equal(await repo.redirectTargetFor(db, "a"), "/p/b");
  /* b moves on to c: the redirect that led to b now leads straight to c. */
  const plan = seo.planRedirect(await repo.redirectMap(db), "/p/b", "/p/c");
  await repo.saveRedirect(db, "/p/b", plan.target, "moved", actor);
  const map = await repo.redirectMap(db);
  assert.equal(map.get("/p/a"), "/p/c", "no chain is left behind");
  assert.equal(map.get("/p/b"), "/p/c");
  /* Writing the same address again replaces it; the unique index holds one. */
  await repo.saveRedirect(db, "/p/a", "https://maintsupp.com/faqs", "manual", actor);
  const rows = await repo.listRedirects(db);
  assert.equal(rows.filter((row) => row.from === "/p/a").length, 1);
  assert.equal(rows.find((row) => row.from === "/p/a").kind, "manual");
  assert.equal(await repo.deleteRedirect(db, "/p/a"), true);
  assert.equal(await repo.deleteRedirect(db, "/p/a"), false, "nothing left to remove");
  assert.equal(await repo.redirectTargetFor(db, "a"), null);
});

/* ------------------------------------------------------------------ */
/* Live (dev server)                                                    */
/* ------------------------------------------------------------------ */

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER = { email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com", password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026" };
const RUN = `p12-qa-${Date.now().toString(36)}`;
const made = new Set();
let cookie = "";

const serverUp = await (async () => {
  try {
    return (await fetch(`${BASE_URL}/api/context`, { signal: AbortSignal.timeout(8000) })).status < 500;
  } catch {
    return false;
  }
})();

async function call(pathName, init = {}) {
  const response = await fetch(`${BASE_URL}${pathName}`, {
    ...init,
    headers: { accept: "application/json", "content-type": "application/json", ...(init.headers ?? {}) },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

async function signIn(t) {
  if (cookie) return true;
  const login = await fetch(`${BASE_URL}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(OWNER) });
  if (!login.ok) {
    t.skip("the seeded owner could not sign in");
    return false;
  }
  cookie = (login.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
  if ((await call("/api/site-pages", { headers: { cookie } })).status !== 200) {
    t.skip("this identity is not platform staff here");
    return false;
  }
  return true;
}

const page = (slug, extra = {}) => ({
  original: null,
  slug,
  title: `QA ${slug}`,
  metaTitle: null,
  metaDescription: null,
  published: true,
  blocks: [{ kind: "heading", body: { title: `QA ${slug}` } }],
  ...extra,
});
const put = (body) => call("/api/site-pages", { method: "PUT", headers: { cookie }, body: JSON.stringify(body) });
const create = async (slug, extra = {}) => {
  made.add(slug);
  const response = await put(page(slug, extra));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response;
};
const visit = (pathName, init = {}) => fetch(`${BASE_URL}${pathName}`, { redirect: "manual", ...init });
const robotsMeta = (html) => [...html.matchAll(/<meta[^>]*name="robots"[^>]*>/g)].map((match) => match[0]).join(" ");
const canonicalOf = (html) => /<link[^>]*rel="canonical"[^>]*href="([^"]+)"|<link[^>]*href="([^"]+)"[^>]*rel="canonical"/.exec(html)?.slice(1).find(Boolean) ?? null;

test("live: a move answers 308; manual redirects are same-site only; a loop is refused", { skip: !serverUp }, async (t) => {
  if (!(await signIn(t))) return;
  const [a, b] = [`${RUN}-a`, `${RUN}-b`];
  await create(a);
  const moved = await put({ ...page(b), original: a });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  made.add(b);
  const old = await visit(`/p/${a}`);
  assert.equal(old.status, 308, "the old address answers a permanent redirect");
  assert.equal(new URL(old.headers.get("location"), BASE_URL).pathname, `/p/${b}`);
  assert.equal(moved.body.redirects.find((row) => row.from === `/p/${a}`)?.kind, "moved");

  /* Manual: to a /p/ address (collapsed through a → b), and to a site page. */
  const manual = await put({ redirect: { from: `/p/${RUN}-m`, to: `/p/${a}` } });
  assert.equal(manual.status, 200, JSON.stringify(manual.body));
  assert.equal(manual.body.redirects.find((row) => row.from === `/p/${RUN}-m`)?.to, `/p/${b}`, "stored as the final destination");
  assert.equal(new URL((await visit(`/p/${RUN}-m`)).headers.get("location"), BASE_URL).pathname, `/p/${b}`);
  assert.equal((await put({ redirect: { from: `/p/${RUN}-s`, to: "/contractors" } })).status, 200);
  const site = await visit(`/p/${RUN}-s`);
  assert.equal(site.status, 308);
  assert.equal(site.headers.get("location"), "https://maintsupp.com/contractors");

  for (const to of ["https://evil.example/", "//evil.example", "https://maintsupp.com.evil.example/x", "javascript:alert(1)"]) {
    const refused = await put({ redirect: { from: `/p/${RUN}-o`, to } });
    assert.equal(refused.status, 400, `${to} must be refused`);
  }
  assert.equal((await visit(`/p/${RUN}-o`)).status, 404, "and nothing was stored");
  assert.equal((await put({ redirect: { from: "/faqs", to: `/p/${b}` } })).status, 400, "only a /p/ address is a source");
  assert.equal((await put({ redirect: { from: `/p/${b}`, to: "/contractors" } })).status, 409, "a live page wins");

  /* A loop: p → q, then q → p. */
  assert.equal((await put({ redirect: { from: `/p/${RUN}-p`, to: `/p/${RUN}-q` } })).status, 200);
  const loop = await put({ redirect: { from: `/p/${RUN}-q`, to: `/p/${RUN}-p` } });
  assert.equal(loop.status, 409, JSON.stringify(loop.body));
  assert.match(loop.body.error, /loop/);
  assert.equal((await visit(`/p/${RUN}-q`)).status, 404, "the refused loop was not stored");

  /* Remove: the address answers 404 again. */
  const removed = await call(`/api/site-pages?redirect=${encodeURIComponent(`/p/${RUN}-s`)}`, { method: "DELETE", headers: { cookie } });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal((await visit(`/p/${RUN}-s`)).status, 404);
  assert.equal((await call(`/api/site-pages?redirect=${encodeURIComponent(`/p/${RUN}-s`)}`, { method: "DELETE", headers: { cookie } })).status, 404);

  /* Signed out, the redirect API is closed like the rest of the console. */
  assert.equal((await call("/api/site-pages", { method: "PUT", body: JSON.stringify({ redirect: { from: `/p/${RUN}-x`, to: "/faqs" } }) })).status >= 401, true);
});

test("live: a scheduled page is not public until its window opens, and not after it closes", { skip: !serverUp }, async (t) => {
  if (!(await signIn(t))) return;
  const slug = `${RUN}-w`;
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const saved = await create(slug, { publishAt: future });
  assert.equal(saved.body.pages.find((entry) => entry.slug === slug).state, "scheduled");
  assert.equal((await visit(`/p/${slug}`)).status, 404, "not live yet");
  const opened = await put({ ...page(slug), original: slug, publishAt: new Date(Date.now() - 60_000).toISOString() });
  assert.equal(opened.body.pages.find((entry) => entry.slug === slug).state, "live");
  assert.equal((await visit(`/p/${slug}`)).status, 200, "live once the window has opened");
  const closed = await put({ ...page(slug), original: slug, unpublishAt: new Date(Date.now() - 1_000).toISOString() });
  assert.equal(closed.body.pages.find((entry) => entry.slug === slug).state, "ended");
  assert.equal((await visit(`/p/${slug}`)).status, 404, "gone once it has closed");
  const backwards = await put({ ...page(slug), original: slug, publishAt: future, unpublishAt: new Date().toISOString() });
  assert.equal(backwards.status, 400, "a window that closes before it opens");
});

test("live: noindex, canonical and the pages sitemap", { skip: !serverUp }, async (t) => {
  if (!(await signIn(t))) return;
  const [plain, hidden, pointed] = [`${RUN}-i`, `${RUN}-n`, `${RUN}-c`];
  await create(plain);
  await create(hidden, { noindex: true });
  await create(pointed, { canonicalUrl: "/contractors" });
  assert.equal((await put({ ...page(pointed), original: pointed, canonicalUrl: "https://evil.example/" })).status, 400);

  const plainHtml = await (await visit(`/p/${plain}`)).text();
  assert.doesNotMatch(robotsMeta(plainHtml), /noindex/, "an ordinary page is indexable");
  assert.equal(canonicalOf(plainHtml), `https://maintsupp.com/p/${plain}`);
  const hiddenHtml = await (await visit(`/p/${hidden}`)).text();
  assert.match(robotsMeta(hiddenHtml), /noindex/);
  assert.match(robotsMeta(hiddenHtml), /(?<!no)follow/, "its links still count");
  assert.equal(canonicalOf(await (await visit(`/p/${pointed}`)).text()), "https://maintsupp.com/contractors");

  const sitemap = await visit("/sitemap-pages.xml");
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers.get("content-type"), /application\/xml/);
  const xml = await sitemap.text();
  const today = new Date().toISOString().slice(0, 10);
  assert.match(xml, new RegExp(`<loc>https://maintsupp\\.com/p/${plain}</loc>\\n    <lastmod>${today}</lastmod>`));
  assert.doesNotMatch(xml, new RegExp(`/p/${hidden}<`), "noindex is out of the sitemap");
  assert.doesNotMatch(xml, new RegExp(`/p/${pointed}<`), "a page canonical elsewhere is out of the sitemap");
});

test("live: preview is for signed-in platform staff only, noindex, and never publicly cached", { skip: !serverUp }, async (t) => {
  if (!(await signIn(t))) return;
  const slug = `${RUN}-v`;
  await create(slug, { published: false });
  assert.equal((await visit(`/p/${slug}?preview=1`)).status, 404, "signed out: the same 404 as the public");
  assert.equal((await visit(`/p/${slug}`, { headers: { cookie } })).status, 404, "signed in without ?preview: still the public answer");
  const preview = await visit(`/p/${slug}?preview=1`, { headers: { cookie } });
  assert.equal(preview.status, 200);
  const html = await preview.text();
  assert.match(html, /Preview — this page is not public \(draft\)/);
  assert.match(robotsMeta(html), /noindex/);
  assert.doesNotMatch(preview.headers.get("cache-control") ?? "", /public|s-maxage/, "a preview is never cached publicly");
});

after(async () => {
  if (!cookie) return;
  for (const slug of made) {
    await fetch(`${BASE_URL}/api/site-pages?slug=${slug}`, { method: "DELETE", headers: { cookie } }).catch(() => undefined);
  }
  const redirects = (await call("/api/site-pages", { headers: { cookie } })).body?.redirects ?? [];
  for (const entry of redirects.filter((row) => row.from.startsWith(`/p/${RUN}`))) {
    await fetch(`${BASE_URL}/api/site-pages?redirect=${encodeURIComponent(entry.from)}`, { method: "DELETE", headers: { cookie } }).catch(() => undefined);
  }
});
