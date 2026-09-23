/**
 * Decision J — the public website's navigation, edited by MAINTSUPP platform
 * staff and read by every public page through a cache (§77 item 11).
 *
 * What is pinned here, and why each matters:
 *   - SAFE DESTINATIONS ONLY: an allowlist of shapes (homepage sections that
 *     exist, the site's own pages, CMS pages, https:// sites) — never a
 *     blocklist of schemes;
 *   - THE FIVE LOCKS: Report a Job, Portal Login, Privacy, Terms, Cookies
 *     cannot be removed, hidden or re-pointed by a save, and a stored row that
 *     lost one gets it back when read;
 *   - THE HEADER'S WIDTH: at most six links shown, within a label budget;
 *   - NO DRAFT LEAKS: a link to a CMS page that is not live is left out of the
 *     public render, and hidden links never reach it;
 *   - THE CACHE: fresh within its window, immediate on the saving instance,
 *     never the reason a page fails or hangs;
 *   - WHO: platform staff only — no workspace capability reaches it;
 *   - HISTORY: §38 versions, restore through the same rules;
 *   - STORAGE: a conditional write against real (in-memory) SQLite.
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

const nav = await import("../app/lib/site-navigation.ts");
const { createNavigationCache } = await import("../app/lib/site-navigation-cache.ts");
const model = await import("../app/lib/config-versions-model.ts");

const clone = (value) => structuredClone(value);
const footerLinks = (navigation, id) => navigation.footer.find((group) => group.id === id).links;

/* ------------------------------------------------------------------ */
/* The built-in navigation                                             */
/* ------------------------------------------------------------------ */

test("the built-in navigation is today's menu, and it passes its own rules", () => {
  const built = nav.defaultNavigation();
  assert.deepEqual(
    built.primary.map((link) => [link.href, link.label]),
    [
      ["#services", "Services"],
      ["#how", "How It Works"],
      ["#pricing", "Pricing"],
      ["#case-study", "Case Study"],
      ["/contractors", "Contractors"],
      ["#contact", "Contact Us"],
    ],
  );
  assert.deepEqual(built.footer.map((group) => group.id), ["services", "company", "clients", "legal"]);
  assert.deepEqual(footerLinks(built, "legal").map((link) => link.href), ["/privacy", "/terms", "/cookies"]);
  assert.ok(built.primary.concat(built.footer.flatMap((group) => group.links)).every((link) => link.hidden === false));
  const checked = nav.validateNavigation(built);
  assert.equal(checked.ok, true, checked.reason);
  assert.deepEqual(checked.value, built);
  assert.deepEqual(nav.normaliseNavigation(JSON.stringify(built)), built, "a stored copy of the built-in reads back unchanged");
});

/* ------------------------------------------------------------------ */
/* Destinations                                                        */
/* ------------------------------------------------------------------ */

test("a destination is one of four safe shapes, or it is refused", () => {
  const accepted = [
    ["#services", "#services"],
    ["/#pricing", "#pricing"],
    ["/", "/"],
    ["/faqs", "/faqs"],
    ["/portal", "/portal"],
    ["/p/careers", "/p/careers"],
    ["/p/Careers", "/p/careers"],
    ["https://www.linkedin.com/company/maintsupp", "https://www.linkedin.com/company/maintsupp"],
    ["https://maintsupp.com/faqs", "/faqs"],
    ["https://maintsupp.com/#how", "#how"],
    ["https://www.maintsupp.com/p/careers", "/p/careers"],
  ];
  for (const [input, expected] of accepted) assert.equal(nav.cleanNavHref(input), expected, input);
  const refused = [
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "http://example.com",
    "//evil.example",
    "/\\evil.example",
    "https://maintsupp.com@evil.example/",
    "https://user:pass@example.com/",
    "https://maintsupp.com//evil.example",
    "https://maintsupp.com/admin",
    "https://localhost/",
    "https://exa mple.com",
    "#top",
    "#hero",
    "#nowhere",
    "/admin",
    "/api/files/abc",
    "/dashboard",
    "/p/../admin",
    "/p/a--b",
    "/faqs#faq",
    "mailto:info@maintsupp.com",
    "",
    "x".repeat(301),
    42,
    null,
  ];
  for (const input of refused) assert.equal(nav.cleanNavHref(input), null, String(input).slice(0, 60));
});

test("every anchor the editor offers is a section the homepage renders", async () => {
  const ids = new Set();
  for (const file of ["app/(marketing)/page.tsx", ...(await import("node:fs")).readdirSync(path.join(root, "app/(marketing)/_sections")).filter((name) => name.endsWith(".tsx")).map((name) => `app/(marketing)/_sections/${name}`)]) {
    for (const [, id] of (await read(file)).matchAll(/\sid="([^"{}]+)"/g)) ids.add(id);
  }
  for (const anchor of nav.HOMEPAGE_ANCHORS) assert.ok(ids.has(anchor.id), `#${anchor.id} is offered but not rendered`);
  assert.ok(!nav.HOMEPAGE_ANCHORS.some((anchor) => anchor.id === "top"), "the logo is the way home, not #top");
  for (const route of nav.SITE_ROUTES.filter((entry) => entry.path !== "/" && entry.path !== "/portal")) {
    await read(`app/(marketing)${route.path}/page.tsx`); // throws if the page is gone
  }
});

/* ------------------------------------------------------------------ */
/* Locks                                                               */
/* ------------------------------------------------------------------ */

test("the five locked links cannot be removed, hidden, re-pointed or moved — but may be renamed and reordered", () => {
  assert.deepEqual(nav.LOCKED_LINKS.map((lock) => lock.href).sort(), ["#report", "/cookies", "/portal", "/privacy", "/terms"]);
  for (const lock of nav.LOCKED_LINKS) {
    const removed = clone(nav.defaultNavigation());
    const list = footerLinks(removed, lock.group);
    list.splice(list.findIndex((link) => link.id === lock.id), 1);
    const refusal = nav.validateNavigation(removed);
    assert.equal(refusal.ok, false, `${lock.id} removed`);
    assert.match(refusal.reason, /locked and cannot be removed/);

    const hidden = clone(nav.defaultNavigation());
    footerLinks(hidden, lock.group).find((link) => link.id === lock.id).hidden = true;
    assert.match(nav.validateNavigation(hidden).reason, /cannot be hidden/, `${lock.id} hidden`);

    const repointed = clone(nav.defaultNavigation());
    footerLinks(repointed, lock.group).find((link) => link.id === lock.id).href = "#services";
    assert.match(nav.validateNavigation(repointed).reason, /must keep pointing at/, `${lock.id} re-pointed`);

    const moved = clone(nav.defaultNavigation());
    const entry = footerLinks(moved, lock.group).find((link) => link.id === lock.id);
    footerLinks(moved, lock.group).splice(footerLinks(moved, lock.group).indexOf(entry), 1);
    footerLinks(moved, "company").push(entry);
    assert.match(nav.validateNavigation(moved).reason, /locked to its own footer list/, `${lock.id} moved`);
  }
  const renamed = clone(nav.defaultNavigation());
  footerLinks(renamed, "legal").find((link) => link.id === "ftr-privacy").label = "Privacy policy";
  footerLinks(renamed, "legal").reverse();
  assert.equal(nav.validateNavigation(renamed).ok, true, "a new label and a new order take nothing away");

  const inHeader = clone(nav.defaultNavigation());
  inHeader.primary.push({ id: "ftr-portal", label: "Portal", href: "/portal", hidden: true });
  assert.equal(nav.validateNavigation(inHeader).ok, false, "a locked id cannot be borrowed by another link");
});

test("a stored row that lost a lock gets it back — shown, in its list, at its destination", () => {
  const broken = clone(nav.defaultNavigation());
  footerLinks(broken, "legal").splice(0, 3);
  footerLinks(broken, "clients").find((link) => link.id === "ftr-portal").href = "https://evil.example";
  footerLinks(broken, "clients").find((link) => link.id === "ftr-report").hidden = true;
  const read = nav.normaliseNavigation(JSON.stringify(broken));
  assert.deepEqual(footerLinks(read, "legal").map((link) => link.href), ["/privacy", "/terms", "/cookies"]);
  assert.equal(footerLinks(read, "clients").find((link) => link.id === "ftr-portal").href, "/portal");
  assert.equal(footerLinks(read, "clients").find((link) => link.id === "ftr-report").hidden, false);
  assert.equal(nav.validateNavigation(read).ok, true, "what the read path hands back always passes the write path");

  for (const garbage of ["not json", "[]", "null", JSON.stringify({ primary: "x" }), 7]) {
    const repaired = nav.normaliseNavigation(garbage);
    assert.equal(nav.validateNavigation(repaired).ok, true, String(garbage));
  }
  assert.deepEqual(nav.normaliseNavigation("not json"), nav.defaultNavigation());
});

/* ------------------------------------------------------------------ */
/* Limits and content rules                                            */
/* ------------------------------------------------------------------ */

test("the header holds at most six shown links that fit its width; hidden ones cost nothing", () => {
  const seven = clone(nav.defaultNavigation());
  seven.primary.push({ id: "nav-extra", label: "Careers", href: "/p/careers", hidden: false });
  assert.match(nav.validateNavigation(seven).reason, /at most 6 links/);
  seven.primary.at(-1).hidden = true;
  assert.equal(nav.validateNavigation(seven).ok, true, "hidden, it is fine");

  /* Width, not characters: the shipped six fill the bar; the same six in
     capitals do not, and a narrower rename always does. */
  assert.equal(nav.headerFit(nav.NAV.map(([, label]) => label)).fits, true, "the shipped menu fits");
  const caps = clone(nav.defaultNavigation());
  caps.primary.forEach((link) => (link.label = link.label.toUpperCase()));
  assert.match(nav.validateNavigation(caps).reason, /px wider than the bar has room for on a 1280px or wider screen/);
  const renamed = clone(nav.defaultNavigation());
  renamed.primary[2].label = "Prices";
  assert.equal(nav.validateNavigation(renamed).ok, true);
  const swapped = clone(nav.defaultNavigation());
  swapped.primary[3].hidden = true;
  swapped.primary.push({ id: "nav-careers", label: "Careers", href: "/p/careers", hidden: false });
  assert.equal(nav.validateNavigation(swapped).ok, true, "hide one to make room for another");
  /* Few, very long links: fine at 1280, too wide for the packed 1120 band. */
  const few = ["Planned Maintenance", "Compliance Coordination", "Reactive Repairs Online"];
  assert.ok(nav.headerWidth(few, "wide") <= nav.HEADER_LAYOUTS.wide.roomPx);
  assert.equal(nav.headerFit(few).fits, false);
  assert.equal(nav.headerFit(few).layout, "band", "both layouts are checked");
  assert.ok(nav.labelEm("\u{1F600}") >= 1, "a character outside the table is costed as the widest");

  const twelve = clone(nav.defaultNavigation());
  for (let index = 0; index < 7; index += 1) twelve.primary.push({ id: `nav-h${index}`, label: `H${index}`, href: "#faq", hidden: true });
  assert.match(nav.validateNavigation(twelve).reason, /at most 12 links/);

  const stored = clone(nav.defaultNavigation());
  stored.primary.push({ id: "nav-extra", label: "Careers", href: "/p/careers", hidden: false });
  const read = nav.normaliseNavigation(JSON.stringify(stored));
  assert.equal(read.primary.filter((link) => !link.hidden).length, 6, "a stored row over the limit reads with the extra hidden, not a broken bar");
  assert.equal(read.primary.at(-1).hidden, true);
});

test("the width check uses marketing.css's own font sizes and paddings", async () => {
  const css = await read("app/(marketing)/marketing.css");
  assert.match(css, /\.nav__link\{[^}]*padding:10px 8px;[^}]*font-size:\.91rem;/, "the wide layout");
  assert.equal(nav.HEADER_LAYOUTS.wide.fontPx, 0.91 * 16);
  assert.equal(nav.HEADER_LAYOUTS.wide.padPx, 8);
  const band = css.match(/@media\(min-width:1120px\) and \(max-width:1279px\)\{([^\n]*)\}\n/);
  assert.ok(band, "the packed band exists");
  assert.match(band[1], /\.nav__link\{padding:10px 3px;font-size:\.86rem\}/);
  assert.equal(nav.HEADER_LAYOUTS.band.fontPx, 0.86 * 16);
  assert.equal(nav.HEADER_LAYOUTS.band.padPx, 3);
  /* The booking button keeps its short label (full name in aria-label) up to
     1365: with six links the long one only fits from 1366. */
  assert.match(css, /@media\(min-width:1120px\) and \(max-width:1365px\)\{\.cta-long\{display:none\}\.cta-short\{display:inline\}\}/);
  assert.match(css, /\.nav__list\{display:flex;align-items:center;gap:2px;/);
  assert.equal(nav.HEADER_LAYOUTS.wide.gapPx, 2);
  /* Measured 547.9px for the shipped six in the browser; the table agrees to a pixel. */
  assert.ok(Math.abs(nav.headerWidth(nav.NAV.map(([, label]) => label), "wide") - 547.9) < 1);
});

test("labels and headings are held to the site's copy rules and lengths", () => {
  const cases = [
    ["Our engineers", /forbids "our engineers"/],
    ["From £99", /price/],
    ["Prices + VAT", /VAT/],
  ];
  for (const [label, reason] of cases) {
    const bad = clone(nav.defaultNavigation());
    footerLinks(bad, "company")[0].label = label;
    assert.match(nav.validateNavigation(bad).reason, reason, label);
  }
  const heading = clone(nav.defaultNavigation());
  heading.footer[0].heading = "We certify";
  assert.match(nav.validateNavigation(heading).reason, /we certify/);
  const empty = clone(nav.defaultNavigation());
  empty.primary[0].label = "   ";
  assert.match(nav.validateNavigation(empty).reason, /label of 1–24/);
  const tooLong = clone(nav.defaultNavigation());
  tooLong.primary[0].label = "x".repeat(25);
  assert.equal(nav.validateNavigation(tooLong).ok, false);
  const missingGroup = clone(nav.defaultNavigation());
  missingGroup.footer.pop();
  assert.match(nav.validateNavigation(missingGroup).reason, /missing/);
  const extraKey = clone(nav.defaultNavigation());
  extraKey.primary[0].onclick = "alert(1)";
  extraKey.injected = true;
  const checked = nav.validateNavigation(extraKey);
  assert.equal(checked.ok, true);
  assert.equal("onclick" in checked.value.primary[0], false, "an unknown key never rides into storage");
  assert.equal("injected" in checked.value, false);
  const duplicate = clone(nav.defaultNavigation());
  duplicate.primary[1].id = duplicate.primary[0].id;
  assert.match(nav.validateNavigation(duplicate).reason, /share the id/);
});

/* ------------------------------------------------------------------ */
/* The public render                                                   */
/* ------------------------------------------------------------------ */

test("a visitor's page never carries a hidden link or a link to a page that is not live", () => {
  const stored = clone(nav.defaultNavigation());
  stored.primary[1].hidden = true;
  footerLinks(stored, "company").push({ id: "link-live", label: "Careers", href: "/p/careers", hidden: false });
  footerLinks(stored, "company").push({ id: "link-draft", label: "Secret launch", href: "/p/secret-launch", hidden: false });
  footerLinks(stored, "company").push({ id: "link-out", label: "LinkedIn", href: "https://www.linkedin.com/company/maintsupp", hidden: false });
  assert.equal(nav.namesCmsPages(stored), true);
  const shown = nav.publicNavigation(stored, new Set(["careers"]));
  assert.equal(shown.primary.some((link) => link.label === "How It Works"), false, "hidden stays out");
  const company = shown.footer.find((group) => group.id === "company").links.map((link) => link.label);
  assert.ok(company.includes("Careers"));
  assert.ok(!company.includes("Secret launch"), "a draft's name and address never reach the page");
  assert.equal(shown.footer.find((group) => group.id === "company").links.find((link) => link.label === "LinkedIn").external, true);
  const unknown = nav.publicNavigation(stored, null);
  assert.ok(!unknown.footer.flatMap((group) => group.links).some((link) => link.href.startsWith("/p/")), "page states unknown → no CMS link at all");
  assert.equal(nav.namesCmsPages(nav.defaultNavigation()), false, "the built-in menu needs no page read");
});

/* ------------------------------------------------------------------ */
/* The cache                                                           */
/* ------------------------------------------------------------------ */

function harness(overrides = {}) {
  let clock = 1_000;
  const calls = { load: 0, errors: 0 };
  let behave = async () => "db-1";
  const cache = createNavigationCache({
    load: () => {
      calls.load += 1;
      return behave();
    },
    fallback: () => "built-in",
    ttlMs: 30_000,
    timeoutMs: 50,
    backoffMs: 15_000,
    now: () => clock,
    onError: () => {
      calls.errors += 1;
    },
    ...overrides,
  });
  return {
    cache,
    calls,
    tick: (ms) => (clock += ms),
    set: (fn) => (behave = fn),
  };
}

test("the cache: one read per window, and the saving instance sees its change at once", async () => {
  const h = harness();
  assert.deepEqual(await h.cache.read(), { value: "db-1", source: "database" });
  assert.deepEqual(await h.cache.read(), { value: "db-1", source: "cache" });
  h.tick(29_999);
  assert.equal((await h.cache.read()).source, "cache");
  assert.equal(h.calls.load, 1, "one database read inside the window");
  h.tick(2);
  h.set(async () => "db-2");
  assert.deepEqual(await h.cache.read(), { value: "db-2", source: "database" }, "re-read once the window has passed");
  h.set(async () => "db-3");
  h.cache.invalidate();
  assert.deepEqual(await h.cache.read(), { value: "db-3", source: "database" }, "a save drops the copy at once");
});

test("the cache: a read that began before a save cannot put the old navigation back", async () => {
  const h = harness({ timeoutMs: 1_000 });
  let release;
  h.set(() => new Promise((resolve) => (release = resolve)));
  const first = h.cache.read();
  h.cache.invalidate(); // the save lands while that read is in flight
  release("before-the-save");
  assert.equal((await first).value, "before-the-save", "that one request sees what it read");
  h.set(async () => "after-the-save");
  assert.deepEqual(await h.cache.read(), { value: "after-the-save", source: "database" }, "but it was not cached");
});

test("the cache: a failure or a slow database never fails or hangs a page", async () => {
  const h = harness();
  h.set(async () => {
    throw new Error("connection refused");
  });
  assert.deepEqual(await h.cache.read(), { value: "built-in", source: "fallback" }, "never read → the built-in navigation");
  assert.equal(h.calls.errors, 1);
  assert.deepEqual(await h.cache.read(), { value: "built-in", source: "fallback" });
  assert.equal(h.calls.load, 1, "and the database is not asked again during the back-off");
  h.tick(15_001);
  h.set(async () => "db-ok");
  assert.equal((await h.cache.read()).value, "db-ok", "asked again after it");
  h.tick(30_001);
  h.set(async () => {
    throw new Error("down again");
  });
  assert.deepEqual(await h.cache.read(), { value: "db-ok", source: "stale" }, "a later failure keeps the last good navigation");

  const slow = harness({ timeoutMs: 20 });
  let finish;
  slow.set(() => new Promise((resolve) => (finish = resolve)));
  const started = Date.now();
  assert.deepEqual(await slow.cache.read(), { value: "built-in", source: "fallback" });
  assert.ok(Date.now() - started < 1_000, "the page waited only for the timeout");
  assert.deepEqual(await slow.cache.read(), { value: "built-in", source: "fallback" }, "a load past its time is not waited on twice");
  assert.equal(slow.calls.load, 1);
  finish("late-but-good");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await slow.cache.read(), { value: "late-but-good", source: "cache" }, "the late answer is kept for the next page");
});

/* ------------------------------------------------------------------ */
/* Version history (§38)                                               */
/* ------------------------------------------------------------------ */

test("the navigation is a §38 subject: installation-wide, staff-only, restored through its own save", () => {
  assert.equal(model.VERSION_SUBJECTS.site_navigation.scope, "installation");
  assert.equal(model.VERSION_SUBJECTS.site_navigation.capability, "platform");
  assert.deepEqual(model.versionSubject("site_navigation", "public"), { subject: "site_navigation", key: "public" });
  assert.equal(model.versionSubject("site_navigation", "footer"), null);
  assert.deepEqual(model.restoreRequest("site_navigation", "public", 3), { url: "/api/site-navigation", body: { restoreVersion: 3 } });

  const before = model.siteNavigationSnapshot(nav.defaultNavigation());
  const after = clone(before);
  after.navigation.primary[0].label = "What we do";
  after.navigation.primary[2].hidden = true;
  footerLinks(after.navigation, "company").push({ id: "link-careers", label: "Careers", href: "/p/careers", hidden: false });
  after.navigation.primary.reverse();
  const summary = model.summariseChange("site_navigation", before, after);
  assert.match(summary, /^Added Careers; renamed What we do; hid Pricing; reordered header — header 5 links shown, footer 21; 1 hidden\.$/);
  assert.equal(model.summariseChange("site_navigation", before, model.siteNavigationSnapshot(null)), "Reset to the built-in navigation.");
  assert.match(model.summariseChange("site_navigation", before, before), /^Saved with no change — /);
});

/* ------------------------------------------------------------------ */
/* Storage, against real SQLite                                        */
/* ------------------------------------------------------------------ */

async function database() {
  const sqlite = new DatabaseSync(":memory:");
  const init = await read("db/init.ts");
  sqlite.exec(init.match(/`(CREATE TABLE IF NOT EXISTS site_navigation \([\s\S]*?\))`/)[1]);
  sqlite.exec(init.match(/`(CREATE TABLE IF NOT EXISTS site_pages \([\s\S]*?\))`/)[1].replace(/\/\*[\s\S]*?\*\//g, ""));
  for (const column of ["publish_at TEXT", "unpublish_at TEXT", "robots TEXT NOT NULL DEFAULT 'index'", "canonical_url TEXT"]) {
    sqlite.exec(`ALTER TABLE site_pages ADD COLUMN ${column}`);
  }
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

test("storage: no row is the built-in navigation, and every save names the revision it was edited from", async () => {
  const repo = await import("../app/lib/site-navigation-repository.ts");
  const { db, sqlite } = await database();
  const empty = await repo.readStoredNavigation(db);
  assert.equal(empty.stored, false);
  assert.equal(empty.revision, null);
  assert.deepEqual(empty.navigation, nav.defaultNavigation());

  const edited = clone(nav.defaultNavigation());
  edited.primary[0].label = "What we do";
  assert.deepEqual(await repo.writeNavigation(db, edited, { expectedRevision: null, actorEmail: "Staff@MAINTSUPP.com" }), { ok: true, revision: 1 });
  assert.deepEqual(await repo.writeNavigation(db, edited, { expectedRevision: null, actorEmail: "b@maintsupp.com" }), { ok: false, conflict: true }, "somebody created it meanwhile");
  assert.deepEqual(await repo.writeNavigation(db, edited, { expectedRevision: 1, actorEmail: "b@maintsupp.com" }), { ok: true, revision: 2 });
  assert.deepEqual(await repo.writeNavigation(db, edited, { expectedRevision: 1, actorEmail: "c@maintsupp.com" }), { ok: false, conflict: true }, "a stale editor is refused, not merged");
  assert.deepEqual(await repo.writeNavigation(db, edited, { actorEmail: "d@maintsupp.com" }), { ok: true, revision: 3 }, "a restore is unconditional");
  const stored = await repo.readStoredNavigation(db);
  assert.equal(stored.stored, true);
  assert.equal(stored.revision, 3);
  assert.equal(stored.updatedByEmail, "d@maintsupp.com");
  assert.equal(stored.navigation.primary[0].label, "What we do");
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM site_navigation").get().n, 1, "one row, always");

  /* A hand-edited row that dropped a lock still reads with it. */
  sqlite.prepare("UPDATE site_navigation SET document = ?").run(JSON.stringify({ primary: [], footer: [] }));
  assert.deepEqual(footerLinks((await repo.readStoredNavigation(db)).navigation, "legal").map((link) => link.href), ["/privacy", "/terms", "/cookies"]);

  assert.equal(await repo.resetNavigation(db), true);
  assert.equal((await repo.readStoredNavigation(db)).stored, false, "reset removes the row — the code's navigation is in force again");
  assert.equal(await repo.resetNavigation(db), false);

  sqlite.prepare("INSERT INTO site_pages (id, slug, title, published, publish_at) VALUES ('p1', 'careers', 'Careers', 1, NULL), ('p2', 'soon', 'Soon', 1, '2999-01-01T00:00:00.000Z'), ('p3', 'draft', 'Draft', 0, NULL)").run();
  const windows = await repo.cmsPageWindows(db);
  assert.deepEqual(windows.map((page) => [page.slug, page.published]).sort(), [["careers", true], ["draft", false], ["soon", true]]);
  assert.equal(Object.keys(windows[0]).sort().join(","), "publishAt,published,slug,unpublishAt", "states only — no titles, no bodies");
});

/* ------------------------------------------------------------------ */
/* Source pins: who, in what order, and where it is read               */
/* ------------------------------------------------------------------ */

test("the route: platform staff only, and a save runs gate → restore → rules → baseline → write → version → audit → cache", async () => {
  const route = code(await read("app/api/site-navigation/route.ts"));
  assert.match(route, /if \(scope\.platformAdmin !== true\) return null;\s*if \(!scope\.authenticated\) return null;/);
  assert.doesNotMatch(route, /requireCapability|resolvePermissions|can\(/, "no workspace capability can reach MAINTSUPP's website");
  assert.equal((route.match(/if \(!scope\) return forbidden\(\);/g) ?? []).length, 2, "GET and PUT, both gated");
  const put = route.slice(route.indexOf("export async function PUT"));
  const order = [
    "platformScope(request)",
    "loadRestoreSnapshot(",
    "validateNavigation(submitted)",
    "ensureConfigBaseline(",
    "writeNavigation(",
    "recordConfigVersion(",
    "recordAudit(",
    "invalidatePublicNavigation()",
  ];
  for (let index = 1; index < order.length; index += 1) {
    assert.ok(put.indexOf(order[index - 1]) < put.indexOf(order[index]), `${order[index - 1]} before ${order[index]}`);
  }
  assert.match(route, /status: 422/, "a rule refusal is a 422 naming the rule");
  assert.match(route, /status: 409/, "a stale editor is told, not overwritten");
  assert.match(route, /organisationId: null, subject: "site_navigation", key: "public"/);

  const versions = code(await read("app/api/versions/route.ts"));
  assert.match(versions, /if \(installation\) \{\s*if \(!platformStaff\) return Response\.json/, "history is staff-only, like the page history");
  const live = code(await read("app/lib/config-versions-live.ts"));
  assert.match(live, /if \(subject === "site_navigation"\) \{/);
});

test("the public read: cached, never ensureDatabase, and drawn by the layout into both bars and the footer", async () => {
  const reader = code(await read("app/lib/site-navigation-public.ts"));
  assert.doesNotMatch(reader, /ensureDatabase/, "a marketing page must not start paying the migration check for its menu");
  assert.match(reader, /PUBLIC_NAVIGATION_TTL_MS = 30_000/);
  assert.match(reader, /fallback: \(\) => \(\{ navigation: defaultNavigation\(\), pages: null \}\)/);
  assert.match(reader, /catch \{\s*return publicNavigation\(defaultNavigation\(\), null\);/, "even an unexpected throw draws the built-in menu");

  const layout = await read("app/(marketing)/layout.tsx");
  assert.match(layout, /const navigation = await readPublicNavigation\(\);/);
  assert.match(layout, /<SiteHeader navigation=\{navigation\} \/>/);
  assert.match(layout, /<SiteFooter navigation=\{navigation\} \/>/);

  const chrome = code(await read("app/(marketing)/_sections/chrome.tsx"));
  assert.match(chrome, /const NAV = navigation\.primary;/);
  assert.equal((chrome.match(/NAV\.map\(\(\{ id, href, label \}\) =>/g) ?? []).length, 2, "the desktop bar and the drawer, from one list");
  assert.match(chrome, /className="logo" href="\/"/, "home stays structural");
  assert.match(chrome, /<Link href="\/portal">/, "the utility bar's portal door is frame, not data");
  assert.match(chrome, /target: "_blank", rel: "noopener noreferrer"/, "another site opens without an opener");

  const pages = code(await read("app/api/site-pages/route.ts"));
  assert.ok((pages.match(/invalidatePublicNavigation\(\);/g) ?? []).length >= 2, "a page's save or delete re-reads the states a menu link depends on");
});

test("the migration is one guarded table with no seed, in applyMigrations, mirrored in the schema", async () => {
  const init = await read("db/init.ts");
  const apply = init.slice(init.indexOf("async function applyMigrations"), init.indexOf("async function applyMigrations") + 12_000);
  assert.match(apply, /await ensureSiteNavigation\(d1\);/);
  /* RE-POINTED (decision L): `ensureSiteContent` was added directly beneath this
     stage, so the slice now ends where this stage ends rather than at the next one
     but two — otherwise the `doesNotMatch` below reads another stage's prose and
     this test starts reporting a defect in a file it is not about. */
  const stage = init.slice(init.indexOf("async function ensureSiteNavigation"), init.indexOf("async function ensureSiteContent"));
  assert.match(stage, /CREATE TABLE IF NOT EXISTS site_navigation/);
  assert.doesNotMatch(stage, /INSERT|DROP|ALTER|DELETE/i);
  const repairs = init.slice(init.indexOf("async function repairInvariants"), init.indexOf("async function applyMigrations"));
  assert.doesNotMatch(repairs, /ensureSiteNavigation/, "a migration, not a repair");
  const schema = await read("db/schema.ts");
  assert.match(schema, /export const siteNavigation = sqliteTable\("site_navigation"/);
  /* BOOLEAN_COLUMNS rewrites 0/1 by bare column name; a link's `hidden` lives in
     the JSON document, and none of the table's own columns may be in that map. */
  const { BOOLEAN_COLUMN_NAMES } = await import("../db/sqlite-to-postgres.ts");
  for (const column of ["id", "document", "revision", "updated_by_email", "updated_at", "hidden"]) {
    assert.equal(BOOLEAN_COLUMN_NAMES.has(column), false, `${column} must not be rewritten as a boolean`);
  }
});

test("the editor: platform console only, with history and the frame said out loud", async () => {
  const view = await read("app/(app)/admin/site-navigation-view.tsx");
  assert.match(view, /useAdminResource<Payload>\("\/api\/site-navigation"\)/);
  assert.match(view, /<VersionHistory\s+subject="site_navigation"\s+subjectKey="public"/);
  assert.match(view, /expectedRevision: data\.revision/);
  assert.match(view, /useUnsavedChanges\(dirty\)/);
  assert.match(view, /data\.fixed\.map/, "what is not editable is listed, not hunted for");
  const { platformSection } = await import("../app/lib/platform-sections.ts");
  assert.equal(platformSection("navigation")?.capability, null);
});

/* ------------------------------------------------------------------ */
/* Live                                                                */
/* ------------------------------------------------------------------ */

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";
const OWNER = {
  email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com",
  password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026",
};
const serverUp = await (async () => {
  try {
    const response = await fetch(`${BASE_URL}/api/context`, { signal: AbortSignal.timeout(8000) });
    return response.status < 500;
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

test("live: nobody outside platform staff reads or writes the navigation", { skip: !serverUp }, async () => {
  const anonymous = await fetch(`${BASE_URL}/api/site-navigation`, { headers: { accept: "application/json" } });
  assert.ok([401, 403].includes(anonymous.status), `signed out answered ${anonymous.status}`);
  for (const identity of ["admin@sunnamusk-uk.test.maintsupp.com", "client@sunnamusk-uk.test.maintsupp.com"]) {
    const refused = await call("/api/site-navigation", { headers: { "x-maintsupp-identity": identity } });
    assert.equal(refused.status, 403, `${identity} — a workspace role, however senior, does not edit MAINTSUPP's website`);
    const write = await call("/api/site-navigation", {
      method: "PUT",
      headers: { "x-maintsupp-identity": identity },
      body: JSON.stringify({ reset: true }),
    });
    assert.equal(write.status, 403);
  }
  const history = await call("/api/versions?subject=site_navigation&key=public", { headers: { "x-maintsupp-identity": "admin@sunnamusk-uk.test.maintsupp.com" } });
  assert.equal(history.status, 403);
});

test("live: staff edit, the public site reflects it at once, locks hold, and a version restores", { skip: !serverUp }, async (t) => {
  const login = await fetch(`${BASE_URL}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(OWNER) });
  if (!login.ok) return t.skip("the seeded owner could not sign in");
  const cookie = (login.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
  const as = { headers: { cookie } };
  const opened = await call("/api/site-navigation", as);
  if (opened.status !== 200) return t.skip("this identity is not platform staff here");
  const original = opened.body;
  const tag = `QA-J-${Date.now().toString(36)}`;
  let revision = original.revision;
  try {
    assert.equal(original.locked.length, 5);
    assert.ok(original.destinations.anchors.some((entry) => entry.href === "#services"));

    /* A lock cannot be removed, and an unsafe destination is refused. */
    const noPrivacy = clone(original.navigation);
    footerLinks(noPrivacy, "legal").splice(footerLinks(noPrivacy, "legal").findIndex((link) => link.id === "ftr-privacy"), 1);
    const refused = await call("/api/site-navigation", { ...as, method: "PUT", body: JSON.stringify({ navigation: noPrivacy, expectedRevision: revision }) });
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.match(refused.body.error, /locked and cannot be removed/);
    const script = clone(original.navigation);
    footerLinks(script, "company").push({ id: "link-qa-bad", label: tag, href: "javascript:alert(1)", hidden: false });
    assert.equal((await call("/api/site-navigation", { ...as, method: "PUT", body: JSON.stringify({ navigation: script, expectedRevision: revision }) })).status, 422);

    /* A real edit: a new footer link, and a hidden header link. */
    const edited = clone(original.navigation);
    footerLinks(edited, "company").push({ id: "link-qa-j", label: tag, href: "/faqs", hidden: false });
    const hiddenLabel = edited.primary.find((link) => !link.hidden)?.label;
    edited.primary.find((link) => !link.hidden).hidden = true;
    const saved = await call("/api/site-navigation", { ...as, method: "PUT", body: JSON.stringify({ navigation: edited, expectedRevision: revision }) });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    revision = saved.body.revision;
    assert.equal((await call("/api/site-navigation", { ...as, method: "PUT", body: JSON.stringify({ navigation: edited, expectedRevision: original.revision }) })).status, 409, "the stale revision is refused");

    const home = await (await fetch(`${BASE_URL}/`)).text();
    assert.ok(home.includes(tag), "the public homepage shows the new link straight away on this instance");
    const faqs = await (await fetch(`${BASE_URL}/faqs`)).text();
    assert.ok(faqs.includes(tag), "and every marketing page does");
    const primaryList = home.slice(home.indexOf('aria-label="Primary"'), home.indexOf("hdr__actions"));
    assert.ok(!primaryList.includes(`>${hiddenLabel}<`), "the hidden header link is not in the page");

    const history = await call("/api/versions?subject=site_navigation&key=public&limit=5", as);
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.equal(history.body.versions[0].current, true);
    assert.match(history.body.versions[0].summary, new RegExp(`Added ${tag}`));
    const previous = history.body.versions.find((row) => !row.current && row.kind !== "deleted");
    if (previous) {
      const restored = await call("/api/site-navigation", { ...as, method: "PUT", body: JSON.stringify({ restoreVersion: previous.version }) });
      assert.equal(restored.status, 200, JSON.stringify(restored.body));
      revision = restored.body.revision;
      assert.ok(!(await (await fetch(`${BASE_URL}/`)).text()).includes(tag), "restoring the version before takes the link away again");
    }
  } finally {
    /* Put the navigation back exactly as this test found it. */
    const now = await call("/api/site-navigation", as);
    const current = now.body ? now.body.revision : revision;
    const body = original.stored
      ? { navigation: original.navigation, expectedRevision: current }
      : { reset: true, expectedRevision: current };
    const back = await call("/api/site-navigation", { ...as, method: "PUT", body: JSON.stringify(body) });
    assert.equal(back.status, 200, `cleanup: ${JSON.stringify(back.body)}`);
    assert.ok(!(await (await fetch(`${BASE_URL}/`)).text()).includes(tag), "nothing from this test is left on the site");
  }
});
