/**
 * The sitemap must describe the site that exists, at the host the rest of the
 * site names, with dates somebody could defend.
 *
 * The regression these guard: six entries frozen at 2026-09-09 while the pages
 * kept changing, all of them pointing at www.maintsupp.com, which 30x'd away to
 * the apex. Both were invisible — the XML parsed, the build passed, and the
 * only symptom was five of six pages never being indexed.
 */
import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

const sitemap = await readFile("public/sitemap.xml", "utf8");
const worker = await readFile("worker/index.ts", "utf8");
const generator = await readFile("scripts/generate-sitemap.mjs", "utf8");

const entries = sitemap.split("<url>").slice(1).map((block) => ({
  loc: block.match(/<loc>([^<]+)<\/loc>/)?.[1],
  lastmod: block.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1],
}));

test("the generator and the worker name the same canonical origin", () => {
  const fromWorker = worker.match(/const CANONICAL_ORIGIN = "([^"]+)"/)?.[1];
  const fromGenerator = generator.match(/const ORIGIN = "([^"]+)"/)?.[1];
  assert.ok(fromWorker, "worker/index.ts must declare CANONICAL_ORIGIN");
  assert.ok(fromGenerator, "generate-sitemap.mjs must declare ORIGIN");
  /* Drift here is how the www/apex contradiction got in: one file was changed
     and the other was not, and nothing failed until Google stopped indexing. */
  assert.equal(fromGenerator, fromWorker);
});

test("every url is on that origin, and none of them redirects", () => {
  const origin = generator.match(/const ORIGIN = "([^"]+)"/)[1];
  for (const { loc } of entries) {
    assert.ok(loc?.startsWith(`${origin}/`), `${loc} is not on ${origin}`);
    /* A sitemap that lists a host which 301s or 308s elsewhere asks the
       crawler to index an address that is not the address. */
    assert.ok(!loc.includes("://www."), `${loc} names the redirecting host`);
  }
});

test("it lists exactly the STATIC marketing pages that exist", async () => {
  /*
   * RE-POINTED when the website CMS added `app/(marketing)/p/[slug]/page.tsx`.
   *
   * This walk used to claim every `page.tsx` under `app/(marketing)`, and that was
   * right while every one of them was a file at a fixed address. A dynamic segment
   * is not: `[slug]` begins with neither `_` nor `(`, so the walker descended into
   * it and added the literal string "/p/[slug]" to the set of addresses it demanded
   * the sitemap contain. No sitemap can legitimately contain that, so the test
   * would have failed for a page that is correctly absent.
   *
   * What the assertion was written to protect is unchanged and still enforced
   * below: a STATIC marketing page cannot be added or removed without
   * `public/sitemap.xml` following, because that file is generated from a
   * hand-maintained route list in `scripts/generate-sitemap.mjs` and nothing else
   * would notice the two disagreeing.
   *
   * The second assertion is new, and it is the honest statement of where the CMS
   * stands rather than a hole left open. `public/sitemap.xml` is a committed
   * artifact whose per-route `lastmod` comes from `git log` over that route's
   * source files; a database-driven URL has no source file and no commit, so it
   * has no date to put there. Emitting one would mean either a fabricated
   * `lastmod` or a build that reads the production database. So a CMS page is
   * deliberately not listed HERE: since the CMS gained its own live sitemap,
   * `/sitemap-pages.xml` (app/sitemap-pages.xml/route.ts, named in robots.txt),
   * that is where a published page appears, with its own `updated_at` as its
   * date. This file stays git-dated and static, and this asserts it.
   */
  const found = new Set();
  const dynamicRoutes = [];
  const walk = async (dir, prefix) => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (item.name === "page.tsx") {
        if (prefix.includes("[")) dynamicRoutes.push(prefix);
        else found.add(prefix || "/");
      }
      /* `_sections` and `_cms` hold components, not routes, and a route group's
         parentheses never reach the URL. Neither is a page. A `[segment]` IS a
         route, but not one with a fixed address, so it is collected separately
         above rather than skipped and forgotten. */
      if (item.isDirectory() && !item.name.startsWith("_") && !item.name.startsWith("(")) {
        await walk(`${dir}/${item.name}`, `${prefix}/${item.name}`);
      }
    }
  };
  await walk("app/(marketing)", "");

  const listed = new Set(entries.map((e) => new URL(e.loc).pathname));
  assert.deepEqual(
    [...listed].sort(),
    [...found].sort(),
    "a static marketing page was added or removed without the sitemap following",
  );

  assert.deepEqual(
    dynamicRoutes.sort(),
    ["/p/[slug]"],
    "the CMS route is the only dynamic marketing route; a second one needs its own decision about the sitemap",
  );
  for (const { loc } of entries) {
    assert.ok(
      !new URL(loc).pathname.startsWith("/p/"),
      `${loc} is a CMS page, and the sitemap has no date it could honestly give one`,
    );
  }
});

test("every lastmod is a real date that has already happened", () => {
  const today = new Date().toISOString().slice(0, 10);
  for (const { loc, lastmod } of entries) {
    assert.match(lastmod ?? "", /^\d{4}-\d{2}-\d{2}$/, `${loc} has no usable lastmod`);
    assert.ok(!Number.isNaN(Date.parse(lastmod)), `${loc} has an unparseable lastmod`);
    /* A future date is the tell that somebody stamped the clock rather than
       reading history, and it is the one value a crawler will not believe. */
    assert.ok(lastmod <= today, `${loc} claims to have been modified in the future`);
  }
});

test("the committed file is what full history would produce", async (t) => {
  /*
   * The published sitemap is the RECORD: on Vercel, which clones at depth 1,
   * the generator cannot date anything and simply republishes this file. So a
   * stale record is a stale sitemap, and nothing else would notice.
   *
   * Only a full clone can check that, and the environments that matter here
   * are the ones that have one.
   */
  const shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
    encoding: "utf8",
  }).trim();
  if (shallow !== "false") {
    t.skip("shallow clone — no history to check the record against");
    return;
  }

  const before = await readFile("public/sitemap.xml", "utf8");
  execFileSync("node", ["scripts/generate-sitemap.mjs"], { stdio: "ignore" });
  const after = await readFile("public/sitemap.xml", "utf8");
  /* Put it back before asserting, so a failure does not also leave a dirty
     tree behind for whoever runs the suite next. */
  if (before !== after) await writeFile("public/sitemap.xml", before);

  assert.equal(
    after,
    before,
    "public/sitemap.xml is behind the commits it describes — run node scripts/generate-sitemap.mjs and commit the result",
  );
});
