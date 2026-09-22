/**
 * §38b — the website's pages keep every version, a deleted page included.
 *
 * Installation-wide (there is one website): the history rows carry no
 * workspace and only MAINTSUPP platform staff may read or restore them — the
 * same rule as the page editor itself. A restore goes back through the page's
 * own save, so the slug rules, `validateBlock` and the claims rules all apply,
 * and is recorded as a NEW version. A delete stays a real delete, but it is
 * recorded as a version carrying the page as it was, so "restore the version
 * before it" brings the page back at the same address.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import "./reports-ts-loader.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const model = await import("../app/lib/config-versions-model.ts");
const store = await import("../app/lib/config-versions.ts");

test("a page is keyed by a well-formed slug, and a restore goes to the page editor's own save", () => {
  assert.deepEqual(model.versionSubject("site_page", "about-us"), { subject: "site_page", key: "about-us" });
  for (const bad of ["About", "a--b", "-x", "a b", "x".repeat(81), 3]) assert.equal(model.versionSubject("site_page", bad), null, String(bad));
  assert.deepEqual(model.restoreRequest("site_page", "about-us", 4), { url: "/api/site-pages", body: { slug: "about-us", restoreVersion: 4 } });
  assert.equal(model.VERSION_SUBJECTS.site_page.scope, "installation");
  assert.equal(model.VERSION_SUBJECTS.site_page.capability, "platform");
});

test("a stored page and a page being saved become the same snapshot", () => {
  const stored = {
    slug: "a", title: "T", metaTitle: null, metaDescription: null, published: true,
    blocks: [{ id: "2", kind: "richText", position: 1, body: { paragraphs: ["b"] } }, { id: "1", kind: "heading", position: 0, body: { title: "a" } }],
  };
  const saving = { slug: "a", title: "T", metaTitle: null, metaDescription: null, published: true, blocks: [{ kind: "heading", body: { title: "a" } }, { kind: "richText", body: { paragraphs: ["b"] } }] };
  assert.equal(model.canonicalJson(model.pageSnapshot(stored)), model.canonicalJson(model.pageSnapshot(saving)), "block ids and positions do not make a new version");
  const created = model.summariseChange("site_page", null, model.pageSnapshot(saving));
  assert.match(created, /^Created — 2 blocks, published\.$/);
  const unpublished = model.summariseChange("site_page", model.pageSnapshot(saving), { ...model.pageSnapshot(saving), published: false, title: "U" });
  assert.match(unpublished, /^Retitled, unpublished — 2 blocks, draft\.$/);
  assert.equal(model.pageShape({ ...model.pageSnapshot(saving), published: false, blocks: [{ kind: "heading", body: {} }] }), "1 block, draft.");
});

async function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE organisations (id TEXT PRIMARY KEY);");
  const init = await read("db/init.ts");
  sqlite.exec(init.match(/`(CREATE TABLE IF NOT EXISTS config_versions \([\s\S]*?\))`/)[1]);
  for (const index of init.matchAll(/"(CREATE UNIQUE INDEX IF NOT EXISTS config_versions_[^"]+)"/g)) sqlite.exec(index[1]);
  const db = drizzle(async (sql, params, method) => {
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
  return { sqlite, db };
}

test("installation-wide page versions number uniquely, and a deleted page is listed until it is brought back", async () => {
  const { db } = await database();
  const page = (key) => ({ organisationId: null, subject: "site_page", key });
  const actor = { email: "staff@maintsupp.com" };
  const state = { slug: "a", title: "A", metaTitle: null, metaDescription: null, published: true, blocks: [] };
  assert.equal(await store.recordConfigVersion(db, page("a"), { snapshot: state, summary: "created", actor }), 1);
  assert.equal(await store.recordConfigVersion(db, page("a"), { snapshot: state, kind: "deleted", summary: "deleted", actor }), 2, "a deletion always records");
  await store.recordConfigVersion(db, page("b"), { snapshot: { ...state, slug: "b" }, summary: "created", actor });
  assert.deepEqual((await store.listDeletedKeys(db, "site_page")).map((entry) => entry.key), ["a"]);
  assert.equal((await store.loadRestoreSnapshot(db, page("a"), 2)).status, 409, "the deletion marker itself is not a state to restore");
  assert.equal((await store.loadRestoreSnapshot(db, page("a"), 1)).ok, true, "the version before it is");
  await store.recordConfigVersion(db, page("a"), { snapshot: state, summary: "restored", restoredFrom: 1, actor });
  assert.deepEqual(await store.listDeletedKeys(db, "site_page"), [], "brought back, so no longer listed");
});

test("the page route: gate first, restore before every content rule, baseline before the write, record after", async () => {
  const route = code(await read("app/api/site-pages/route.ts"));
  assert.equal((route.match(/return forbidden\(\);/g) ?? []).length, 3, "no new door around the platform gate");
  const put = route.slice(route.indexOf("export async function PUT"), route.indexOf("export async function DELETE"));
  assert.ok(put.indexOf("platformScope(request)") < put.indexOf("loadRestoreSnapshot("));
  assert.ok(put.indexOf("loadRestoreSnapshot(") < put.indexOf("const slug = cleanSlug(payload.slug);"));
  assert.ok(put.indexOf("loadRestoreSnapshot(") < put.indexOf("validateBlock(entry.kind, entry.body)"));
  assert.ok(put.indexOf("loadRestoreSnapshot(") < put.indexOf("claimViolation("));
  assert.ok(put.indexOf("ensureConfigBaseline(") < put.indexOf("await writePage(") && put.indexOf("await writePage(") < put.indexOf("recordConfigVersion("));
  assert.match(put, /organisationId: null, subject: "site_page", key/);
  /* An undelete is compared with nothing, not with the deletion marker's copy
     of the page — which would read "Saved with no change". */
  assert.match(put, /const previous = before \? await latestSnapshot\(scope\.db, versionTarget\) : null;/);
  assert.match(put, /`Brought back from version \$\{restoring\} after its deletion — \$\{pageShape\(after\)\}`/);
  const del = route.slice(route.indexOf("export async function DELETE"));
  assert.ok(del.indexOf("const doomed = (await listPages(scope.db))") < del.indexOf("await deletePage("), "the page is read before it goes");
  assert.ok(del.indexOf("await deletePage(") < del.indexOf('kind: "deleted"'));
});

test("page history is read only by platform staff, and never mixes with a workspace's", async () => {
  const route = code(await read("app/api/versions/route.ts"));
  assert.match(route, /if \(url\.searchParams\.get\("subject"\) === "site_page" && url\.searchParams\.get\("deleted"\) === "1"\) \{\s*if \(!platformStaff\) return Response\.json/);
  const repository = code(await read("app/lib/config-versions.ts"));
  const deleted = repository.slice(repository.indexOf("export async function listDeletedKeys"));
  assert.match(deleted, /isNull\(configVersions\.organisationId\)/);
  const omissions = (await import("../app/lib/cms-blocks.ts")).CMS_OMISSIONS;
  assert.ok(omissions.some((line) => /deleted page/.test(line) && /new row/.test(line)), "the cost of bringing a page back is stated in the editor");
});

test("the editor offers each page's history and a list of deleted pages", async () => {
  const view = await read("app/(app)/admin/site-pages-view.tsx");
  assert.match(view, /<VersionHistory\s+subject="site_page"\s+subjectKey=\{draft\.original\}/);
  assert.match(view, /useAdminResource<DeletedPayload>\("\/api\/versions\?subject=site_page&deleted=1"\)/);
});

/* ================================================================== */
/* The live half                                                       */
/* ================================================================== */

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";
const OWNER = {
  email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com",
  password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026",
};
const serverUp = await (async () => {
  try {
    const r = await fetch(`${BASE_URL}/api/context`, { signal: AbortSignal.timeout(8000) });
    return r.status < 500;
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

test("live: a page is saved, changed, deleted and brought back from its history", { skip: !serverUp }, async (t) => {
  const login = await fetch(`${BASE_URL}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(OWNER) });
  if (!login.ok) return t.skip("the seeded owner could not sign in");
  const cookie = (login.headers.getSetCookie?.() ?? []).map((v) => v.split(";")[0]).join("; ");
  const as = { headers: { cookie } };
  if ((await call("/api/site-pages", as)).status !== 200) return t.skip("this identity is not platform staff here");

  const slug = `p38b-qa-${Date.now()}`;
  const page = (title) => ({ slug, title, metaTitle: null, metaDescription: null, published: false, blocks: [{ kind: "heading", body: { title } }] });
  try {
    assert.equal((await call("/api/site-pages", { ...as, method: "PUT", body: JSON.stringify(page("P38b QA first")) })).status, 200);
    assert.equal((await call("/api/site-pages", { ...as, method: "PUT", body: JSON.stringify(page("P38b QA second")) })).status, 200);
    const history = await call(`/api/versions?subject=site_page&key=${slug}`, as);
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.deepEqual(history.body.versions.map((row) => row.version), [2, 1]);
    assert.equal(history.body.versions[0].current, true);

    assert.equal((await call(`/api/site-pages?slug=${slug}`, { ...as, method: "DELETE" })).status, 200);
    const deleted = await call("/api/versions?subject=site_page&deleted=1", as);
    assert.ok(deleted.body.deleted.some((entry) => entry.key === slug), "listed as deleted");
    const afterDelete = await call(`/api/versions?subject=site_page&key=${slug}`, as);
    assert.equal(afterDelete.body.versions[0].kind, "deleted");
    assert.equal((await call("/api/site-pages", { ...as, method: "PUT", body: JSON.stringify({ slug, restoreVersion: 3 }) })).status, 409, "the deletion marker is not restorable");

    const restored = await call("/api/site-pages", { ...as, method: "PUT", body: JSON.stringify({ slug, restoreVersion: 1 }) });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    const back = restored.body.pages.find((entry) => entry.slug === slug);
    assert.equal(back?.title, "P38b QA first", "the page is back as version 1 had it");
    const final = await call(`/api/versions?subject=site_page&key=${slug}`, as);
    assert.equal(final.body.versions[0].restoredFromVersion, 1);
    assert.match(final.body.versions[0].summary, /^Brought back from version 1 after its deletion — 1 block, draft\.$/);
    assert.equal(final.body.versions.length, 4, "saved, saved, deleted, restored — nothing removed");
    const stillDeleted = await call("/api/versions?subject=site_page&deleted=1", as);
    assert.ok(!stillDeleted.body.deleted.some((entry) => entry.key === slug), "no longer listed as deleted");
  } finally {
    await call(`/api/site-pages?slug=${slug}`, { ...as, method: "DELETE" });
  }
});

test("live: a workspace member who is not platform staff cannot read page history", { skip: !serverUp }, async () => {
  const refused = await call("/api/versions?subject=site_page&key=anything", { headers: { "x-maintsupp-identity": "client@sunnamusk-uk.test.maintsupp.com" } });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal((await call("/api/versions?subject=site_page&deleted=1", { headers: { "x-maintsupp-identity": "client@sunnamusk-uk.test.maintsupp.com" } })).status, 403);
});
