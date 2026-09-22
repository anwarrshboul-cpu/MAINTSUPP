/**
 * CMS integrity and editor safety (post-§77 plan B+C).
 *
 *   - Changing a page's address MOVES it: the same page takes the new address and
 *     the old one answers a 308 to it (it answered 404 until the CMS gained
 *     redirects). It used to create a second page and leave the first one
 *     published.
 *   - A new page cannot land on an address another page holds: 409. It used to
 *     overwrite that page's content without a word.
 *   - Duplicate (§77 item 10): a new unpublished `<slug>-copy` with the same blocks.
 *   - §38b history stays truthful across a move: the new address says "Renamed
 *     from", the old one is closed with a `renamed` marker that is neither
 *     restorable nor offered as a deleted page.
 *   - §69: editors warn before unsaved changes are lost.
 *   - §77 item 17: the workspace default dashboard can be removed, as a version.
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

/* ------------------------------------------------------------------ */
/* Source                                                              */
/* ------------------------------------------------------------------ */

test("a save states which page it is for; a new page on a taken address is refused; an edit can move the page", async () => {
  const route = code(await read("app/api/site-pages/route.ts"));
  assert.equal((route.match(/return forbidden\(\);/g) ?? []).length, 3, "no new door around the platform gate");
  const put = route.slice(route.indexOf("export async function PUT"), route.indexOf("export async function DELETE"));
  assert.match(put, /if \(intent === null && pages\.some\(\(page\) => page\.slug === slug\)\) \{\s*return Response\.json\([\s\S]*?\{ status: 409 \}/);
  assert.match(put, /if \(opened !== slug && pages\.some\(\(page\) => page\.slug === slug\)\) \{\s*return Response\.json\([\s\S]*?\{ status: 409 \}/);
  assert.match(put, /await writePage\(scope\.db, input, scope\.identityEmail\.toLowerCase\(\), fromSlug\)/);
  assert.ok(put.indexOf("await writePage(") < put.indexOf('kind: "renamed"'), "the old address is closed only after the move is written");
  assert.ok(put.indexOf("payload.duplicate") < put.indexOf("const slug = cleanSlug(payload.slug);"), "a copy then goes through every content rule");

  const repository = code(await read("app/lib/cms-repository.ts"));
  const write = repository.slice(repository.indexOf("export async function writePage"), repository.indexOf("export async function deletePage"));
  assert.match(write, /from: string = input\.slug/);
  assert.match(write, /\.where\(eq\(sitePages\.slug, from\)\)/, "the page is found at the address it HAS");
  assert.match(write, /\.set\(\{\s*slug: input\.slug,/, "and takes the new one");

  const view = code(await read("app/(app)/admin/site-pages-view.tsx"));
  assert.match(view, /original: draft\.original,/, "the console says which page it opened");
  assert.match(view, /duplicate: slug/);
});

test("editors warn before unsaved work is lost, and the hook runs before any early return", async () => {
  const hook = code(await read("app/lib/use-unsaved-changes.ts"));
  assert.match(hook, /addEventListener\("beforeunload"/);
  assert.match(hook, /document\.addEventListener\("click", leaveByLink, true\)/, "in-app links are asked about too");
  assert.match(hook, /return useCallback\(\(\) => !dirty \|\| window\.confirm\(UNSAVED_CHANGES_MESSAGE\), \[dirty\]\)/);
  /* Each component's own first early return — a return inside a memo above it is not one. */
  for (const [file, firstReturn] of [
    ["app/(app)/portal/views/brand-colours-panel.tsx", "  if (failure && !state) {"],
    ["app/(app)/portal/views/nav-icons-panel.tsx", "  if (withheld) return null;"],
  ]) {
    const source = code(await read(file));
    const call = source.indexOf("useUnsavedChanges(");
    assert.ok(call > 0 && source.indexOf(firstReturn) > 0 && call < source.indexOf(firstReturn), `${file}: the hook must run before the early returns`);
  }
  const view = code(await read("app/(app)/admin/site-pages-view.tsx"));
  assert.match(view, /const confirmLeave = useUnsavedChanges\(dirty\);/);
  assert.match(view, /onCancel=\{\(\) => \{\s*if \(confirmLeave\(\)\) setDraft\(null\);/);
  assert.match(code(await read("app/(app)/portal/dashboard-widgets.tsx")), /useUnsavedChanges\(saving\);/);
});

test("the workspace default dashboard can be removed — by settings.edit only, recorded as a version", async () => {
  const route = code(await read("app/api/dashboard-layout/route.ts"));
  const remove = route.slice(route.indexOf("async function removeWorkspaceDefault"));
  assert.ok(remove.indexOf('can(subject, "settings.edit")') < remove.indexOf(".delete(dashboardLayouts)"), "the rule before the delete");
  assert.ok(remove.indexOf("ensureConfigBaseline(") < remove.indexOf(".delete(dashboardLayouts)"), "the default as it was is kept first");
  assert.match(remove, /kind: "deleted"/);
  assert.match(remove, /action: "dashboard\.default_removed"/);
  /* The editor offers it to settings.edit holders. `canSetWorkspaceDefault` was
     never passed where the widgets render, so the save, the history and now the
     remove control were reachable only through the API (Preview QA found it). */
  const portal = code(await read("app/(app)/portal/portal-app.tsx"));
  assert.match(portal, /canSetWorkspaceDefault=\{runtimeContext\?\.capabilities\?\.\["settings\.edit"\] === true\}/);
  assert.match(portal, /surface="reports"\s*barSlot=\{layoutSlot\}\s*canSetWorkspaceDefault=\{canSetWorkspaceDefault\}/);
  assert.match(code(await read("app/(app)/portal/dashboard-widgets.tsx")), /onClick=\{\(\) => void removeDefault\(\)\}/);
});

/* ------------------------------------------------------------------ */
/* Storage: a `renamed` marker is not a state to restore               */
/* ------------------------------------------------------------------ */

const store = await import("../app/lib/config-versions.ts");

async function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE organisations (id TEXT PRIMARY KEY);");
  const init = await read("db/init.ts");
  sqlite.exec(init.match(/`(CREATE TABLE IF NOT EXISTS config_versions \([\s\S]*?\))`/)[1]);
  for (const index of init.matchAll(/"(CREATE UNIQUE INDEX IF NOT EXISTS config_versions_[^"]+)"/g)) sqlite.exec(index[1]);
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

test("a moved page's old address: not restorable, and not offered as a deleted page", async () => {
  const db = await database();
  const target = { organisationId: null, subject: "site_page", key: "old-address" };
  const actor = { email: "staff@maintsupp.com" };
  const state = { slug: "old-address", title: "T", metaTitle: null, metaDescription: null, published: true, blocks: [] };
  await store.recordConfigVersion(db, target, { snapshot: state, summary: "saved", actor });
  await store.recordConfigVersion(db, target, { snapshot: state, kind: "renamed", summary: "Moved to /p/new-address.", actor });
  assert.equal((await store.loadRestoreSnapshot(db, target, 2)).status, 409, "the marker itself is not a state");
  assert.deepEqual(await store.listDeletedKeys(db, "site_page"), [], "a page that moved is not a page to bring back");
});

/* ------------------------------------------------------------------ */
/* Live (dev server)                                                    */
/* ------------------------------------------------------------------ */

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER = { email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com", password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026" };
const RUN = `p11-qa-${Date.now().toString(36)}`;
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

const page = (slug, title, extra = {}) => ({ slug, title, metaTitle: null, metaDescription: null, published: true, blocks: [{ kind: "heading", body: { title } }], ...extra });
const put = (body) => call("/api/site-pages", { method: "PUT", headers: { cookie }, body: JSON.stringify(body) });
const history = async (slug) => (await call(`/api/versions?subject=site_page&key=${slug}`, { headers: { cookie } })).body?.versions ?? [];

test("live: a new page on a taken address is refused, and an address edit moves the page", { skip: !serverUp }, async (t) => {
  if (!(await signIn(t))) return;
  const a = `${RUN}-a`;
  const b = `${RUN}-b`;
  const c = `${RUN}-c`;
  made.add(a).add(b).add(c);
  assert.equal((await put({ ...page(a, "Page A"), original: null })).status, 200);
  assert.equal((await put({ ...page(c, "Page C"), original: null })).status, 200);
  const clash = await put({ ...page(a, "Someone else's page"), original: null });
  assert.equal(clash.status, 409, "a new page on a taken address is refused");
  const kept = (await call("/api/site-pages", { headers: { cookie } })).body.pages.find((entry) => entry.slug === a);
  assert.equal(kept.title, "Page A", "and the page that was there is untouched");

  assert.equal((await put({ ...page(c, "A onto C"), original: a })).status, 409, "a move onto another page's address is refused");
  assert.equal((await put({ ...page(b, "Ghost"), original: `${RUN}-gone` })).status, 404, "an edit of a page that no longer exists");

  const moved = await put({ ...page(b, "Page A"), original: a });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.saved, b);
  const slugs = moved.body.pages.map((entry) => entry.slug);
  assert.ok(slugs.includes(b) && !slugs.includes(a), "one page, at the new address");
  /* RE-POINTED from 404 when a move started leaving a redirect behind: the old
     address now leads to the new one, permanently, so a saved link keeps
     working. `redirect: "manual"` so the 308 itself is what is asserted. */
  const old = await fetch(`${BASE_URL}/p/${a}`, { redirect: "manual" });
  assert.equal(old.status, 308, "the old address redirects");
  assert.equal(new URL(old.headers.get("location"), BASE_URL).pathname, `/p/${b}`, "to the new one");
  assert.equal((await fetch(`${BASE_URL}/p/${b}`)).status, 200, "the new one serves the page");

  const newHistory = await history(b);
  assert.match(newHistory[0].summary, new RegExp(`^Renamed from /p/${a} — `));
  const oldHistory = await history(a);
  assert.equal(oldHistory[0].kind, "renamed", "the old address's history is closed, not removed");
  assert.ok(oldHistory.length >= 2, "and keeps what it had");
  const deleted = (await call("/api/versions?subject=site_page&deleted=1", { headers: { cookie } })).body.deleted;
  assert.ok(!deleted.some((entry) => entry.key === a), "a moved page is not offered back as deleted");
});

test("live: duplicate makes an unpublished copy at the first free -copy address", { skip: !serverUp }, async (t) => {
  if (!(await signIn(t))) return;
  const source = `${RUN}-d`;
  made.add(source);
  assert.equal((await put({ ...page(source, "Source page"), original: null })).status, 200);
  const first = await put({ duplicate: source });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.saved, `${source}-copy`);
  made.add(`${source}-copy`);
  const copy = first.body.pages.find((entry) => entry.slug === `${source}-copy`);
  assert.equal(copy.published, false, "a copy is a draft");
  assert.equal(copy.title, "Source page (copy)");
  assert.deepEqual(copy.blocks.map((block) => block.body), [{ title: "Source page" }]);
  const second = await put({ duplicate: source });
  assert.equal(second.body.saved, `${source}-copy-2`);
  made.add(`${source}-copy-2`);
  assert.match((await history(`${source}-copy`))[0].summary, new RegExp(`^Duplicated from /p/${source} — `));
  assert.equal((await put({ duplicate: `${RUN}-missing` })).status, 404);
});

test("live: the workspace default dashboard is removed by settings.edit only, and comes back from history", { skip: !serverUp }, async (t) => {
  if (!(await signIn(t))) return;
  const read = async () => (await call("/api/dashboard-layout?surface=reports", { headers: { cookie } })).body;
  const original = (await read()).workspaceDefault;
  const client = await call("/api/dashboard-layout?surface=reports&scope=workspace", {
    method: "DELETE",
    headers: { "x-maintsupp-identity": "client@sunnamusk-uk.test.maintsupp.com" },
  });
  assert.equal(client.status, 403, "a client may not remove it");

  const arrangement = [{ key: "spend-trend", hidden: false }, { key: "job-mix", hidden: true }];
  assert.equal((await call("/api/dashboard-layout", { method: "PUT", headers: { cookie }, body: JSON.stringify({ surface: "reports", scope: "workspace", items: arrangement }) })).status, 200);
  const removed = await call("/api/dashboard-layout?surface=reports&scope=workspace", { method: "DELETE", headers: { cookie } });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.deepEqual((await read()).workspaceDefault, [], "the built-in order applies");
  const versions = (await call("/api/versions?subject=dashboard&key=reports", { headers: { cookie } })).body.versions;
  assert.equal(versions[0].kind, "deleted");
  const back = await call("/api/dashboard-layout", { method: "PUT", headers: { cookie }, body: JSON.stringify({ surface: "reports", scope: "workspace", restoreVersion: versions[1].version }) });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual((await read()).workspaceDefault, arrangement, "restoring the version before the removal puts it back");
  assert.equal((await call("/api/dashboard-layout?surface=reports&scope=workspace", { method: "DELETE", headers: { cookie } })).status, 200);
  assert.equal((await call("/api/dashboard-layout?surface=reports&scope=workspace", { method: "DELETE", headers: { cookie } })).status, 404, "nothing left to remove");
  if (original.length) {
    await call("/api/dashboard-layout", { method: "PUT", headers: { cookie }, body: JSON.stringify({ surface: "reports", scope: "workspace", items: original }) });
  }
});

after(async () => {
  if (!cookie) return;
  for (const slug of made) {
    await fetch(`${BASE_URL}/api/site-pages?slug=${slug}`, { method: "DELETE", headers: { cookie } }).catch(() => undefined);
  }
  /* The redirect a move left behind, swept by this run's prefix. */
  const redirects = (await call("/api/site-pages", { headers: { cookie } })).body?.redirects ?? [];
  for (const entry of redirects.filter((row) => row.from.startsWith(`/p/${RUN}`))) {
    await fetch(`${BASE_URL}/api/site-pages?redirect=${encodeURIComponent(entry.from)}`, { method: "DELETE", headers: { cookie } }).catch(() => undefined);
  }
});
