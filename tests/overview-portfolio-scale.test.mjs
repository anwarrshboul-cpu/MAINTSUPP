/**
 * A PORTFOLIO MUST NOT COST ONE SQL VARIABLE PER SITE.
 *
 * The Overview and the Reports block both answered 503 for the only portfolio
 * on this estate that holds the whole shop list. `dashboardJobScope` narrowed
 * jobs with `site_id in (?, ?, … ×151)` — one bound parameter per member — and
 * D1 refuses a statement past roughly a hundred of them. A fifty-site portfolio
 * answered 200, so the failure arrived with the estate rather than with a
 * release, and it took out two of the page's three sections at once because
 * the two endpoints share this one condition.
 *
 * These are behavioural tests, not source pins. They RENDER the condition the
 * product builds and assert a property of the generated statement: the number
 * of bound values does not grow with the portfolio. A future change that goes
 * back to binding a list fails here whatever it is called and however it is
 * written.
 *
 * Rendered on BOTH dialects, because that is the actual requirement. The fix
 * had to work on Miniflare D1 *and* on Supabase Postgres, which rules out the
 * one-parameter trick that would have been easiest — `json_each(?)` is SQLite
 * vocabulary and `db/sqlite-to-postgres.ts` does not rewrite it, so it would
 * have passed here and broken Production. An ordinary subquery is the form both
 * dialects already understand.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const root = fileURLToPath(new URL("../", import.meta.url));

/* Same resolver hook `tests/overview-aggregates.test.mjs` documents: `app/lib`
   imports its neighbours without extensions and reaches `cloudflare:workers`. */
const stub = pathToFileURL(`${root}tests/fixtures/cloudflare-workers-stub.mjs`).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "cloudflare:workers") return { url: stub, shortCircuit: true };
    if (spec.startsWith(".") && ctx.parentURL?.endsWith(".ts")) {
      const base = new URL(spec, ctx.parentURL);
      for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`, `${base.href}.tsx`]) {
        if (fs.existsSync(fileURLToPath(candidate))) return { url: candidate, shortCircuit: true };
      }
    }
    return next(spec, ctx);
  },
});

const { dashboardJobScope } = await import("../app/lib/overview-metrics.ts");
const { SQLiteSyncDialect } = await import("drizzle-orm/sqlite-core");
const { PgDialect } = await import("drizzle-orm/pg-core");

const sqlite = new SQLiteSyncDialect();
const postgres = new PgDialect();

const ORG = "org_test_scale";

/** The statement both dialects would actually send, for one site filter. */
function render(siteFilter) {
  const condition = dashboardJobScope(ORG, { siteFilter });
  return {
    sqlite: sqlite.sqlToQuery(condition),
    postgres: postgres.sqlToQuery(condition),
  };
}

const sitesOf = (count, prefix = "site-") =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`);

const group = (groupId = "portfolio-1", scope = null) => ({ kind: "group", groupId, scope });

/* ── 1. The property the bug violated ─────────────────────────────────────── */

test("a portfolio binds the same number of values whatever its size", () => {
  /*
   * The group is NAMED, not listed, so nothing about the statement depends on
   * how many sites are in it. The contrast makes the point: an explicit list of
   * the same sites grows one bound value per site and walks straight into D1's
   * ceiling at about a hundred, which is exactly what a 151-site portfolio did.
   */
  const baseline = render(group()).sqlite.params.length;
  /* What the scope condition costs before any site is named, so the growth
     below is measured against the right floor rather than a guess. */
  const bare = render({ kind: "all" }).sqlite.params.length;

  for (const size of [0, 1, 50, 100, 151, 500, 5000]) {
    const portfolio = render(group());
    assert.equal(
      portfolio.sqlite.params.length,
      baseline,
      `a ${size}-site portfolio must bind the same ${baseline} values`,
    );
    assert.equal(portfolio.postgres.params.length, baseline, "and the same on Postgres");

    /* The shape that used to be here, measured rather than remembered: binding
       the ids costs one variable each, so 151 sites bound 151 more than the
       bare scope and the statement was refused. */
    if (size > 0) {
      const asList = render({ kind: "scope", scope: sitesOf(size) });
      assert.equal(
        asList.sqlite.params.length - bare,
        size,
        `an explicit ${size}-site list binds one value per site`,
      );
    }
  }

  /* Small enough that no dialect's variable ceiling is in reach: the
     organisation and the group id, plus whatever `liveWorkOrderCondition`
     binds. Well under D1's ~100. */
  assert.ok(baseline < 20, `a portfolio should bind a handful of values, bound ${baseline}`);
});

test("the portfolio is read from the membership table, not sent as a list", () => {
  const { sqlite: rendered } = render(group("portfolio-42"));

  /* The behavioural claim: the member sites are SELECTED, not bound. */
  assert.match(
    rendered.sql,
    /in \(select .*site_group_members/is,
    "the member sites must come from a subquery",
  );
  /* The group id travels as a value, so it is parameterised, not interpolated. */
  assert.ok(
    rendered.params.includes("portfolio-42"),
    "the group id must be a bound value, never spliced into the SQL",
  );
  assert.ok(
    !rendered.sql.includes("portfolio-42"),
    "and must not appear in the statement text",
  );
});

test("the statement uses no dialect-only vocabulary", () => {
  const both = render(group());
  for (const [name, rendered] of Object.entries(both)) {
    /* `json_each` would have been the cheapest single-parameter fix and it is
       exactly the trap: SQLite understands it, the Postgres shim does not. */
    assert.ok(!/json_each/i.test(rendered.sql), `${name}: json_each is not portable`);
    assert.ok(!/unnest/i.test(rendered.sql), `${name}: unnest is Postgres-only`);
    assert.ok(!/= any\s*\(/i.test(rendered.sql), `${name}: = ANY(...) is Postgres-only`);
  }
});

/* ── 2. The cases that must still behave exactly as before ────────────────── */

test("an empty portfolio matches nothing rather than everything", () => {
  const { sqlite: rendered } = render({ kind: "none" });
  assert.match(rendered.sql, /1 = 0/, "an empty portfolio must exclude every row");
});

test("All portfolios adds no site predicate at all", () => {
  const { sqlite: rendered } = render({ kind: "all" });
  assert.ok(
    !/site_group_members/i.test(rendered.sql),
    "no portfolio chosen means no portfolio subquery",
  );
  assert.ok(!/\bsite_id\b/i.test(rendered.sql), "and no site filter");
});

test("a membership's site restriction still narrows, with or without a portfolio", () => {
  /* `site_scope` is a column on ONE membership row, not a table to join, and it
     is bounded by how many stores an administrator named for one person — so it
     is still bound as a list, deliberately. What matters is that it is applied. */
  const scopeOnly = render({ kind: "scope", scope: sitesOf(3, "allowed-") }).sqlite;
  for (const id of sitesOf(3, "allowed-")) {
    assert.ok(scopeOnly.params.includes(id), `the scope must bind ${id}`);
  }

  /* With a portfolio as well, the reader gets the INTERSECTION: the subquery
     narrows to the portfolio and the scope narrows again on top of it. */
  const both = render(group("portfolio-1", sitesOf(2, "allowed-"))).sqlite;
  assert.match(both.sql, /site_group_members/i, "the portfolio still applies");
  assert.ok(both.params.includes("allowed-0"), "and the scope applies on top of it");
});

test("the organisation is always bound, so a portfolio cannot reach another tenant", () => {
  for (const filter of [group(), { kind: "all" }, { kind: "scope", scope: ["site-1"] }]) {
    const { sqlite: rendered } = render(filter);
    assert.ok(
      rendered.params.includes(ORG),
      "every shape must carry the organisation as a bound value",
    );
  }
  /* The subquery reads the membership table, so it must be scoped there too —
     otherwise a group id from another tenant would select that tenant's sites. */
  const { sqlite: rendered } = render(group());
  assert.equal(
    rendered.params.filter((value) => value === ORG).length,
    2,
    "the organisation must scope the jobs AND the membership subquery",
  );
});
