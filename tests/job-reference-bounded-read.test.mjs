/**
 * THE CEILING READ IS BOUNDED, AND THE BOUND IS NOT A GUESS.
 *
 * `nextJobNumber` used to fetch EVERY `MN-%` row out of three tables and throw
 * all but one away — 339 rows on the dev estate, ~1,600 on production — on
 * every created job, through a pooler with a documented client cap, on a path
 * that now includes the anonymous public intake at `/api/report-job`. The cost
 * of raising a job grew with the number of jobs ever raised.
 *
 * The repair is a top-N window per table, ordered `length(reference) DESC,
 * reference DESC`. What makes that ordering the right one is worth stating
 * because two obvious alternatives are both wrong:
 *
 *   · `max(reference)` orders TEXT, so `MN-999` beats `MN-1000`;
 *   · `max(cast(substr(id, 4) as integer))` orders numbers and is a deployed-
 *     only outage — SQLite casts a malformed id to 0 in silence, Postgres
 *     raises `22P02 invalid input syntax`. It was removed from this codebase
 *     for exactly that reason and must not come back.
 *
 * `length()` and `>` are total functions on text in both dialects: no row of
 * any shape can make them throw. And for an unpadded `MN-<digits>` the ordering
 * IS the numbers — a longer digit run is always the larger number, and within
 * one length the characters compare position by position.
 *
 * WHY A WINDOW AND NOT `LIMIT 1`. Verified against Postgres 17.6 on the staging
 * project (`en_US.UTF-8`, `portal.maintenance_requests.id` is `text` with the
 * default collation) and against SQLite under BINARY, which returned the same
 * order character for character:
 *
 *   MN-1272-copy > MN-0000001 > MN-draft > MN-1300 > MN-127a > MN-1279 > MN-1272
 *
 * `LIKE 'MN-%'` is the only shape filter the two dialects share, so a row that
 * matches it without being `MN-<digits>` sorts ABOVE the real maximum. At
 * `LIMIT 1` the answer there is `MN-1272-copy`, which parses to nothing, the
 * ceiling collapses to the floor, and every live reference is re-issued. The
 * test "a reference that is not MN-<digits>…" below runs exactly that.
 *
 * These tests call the SHIPPED `nextJobNumber` over a real SQLite database
 * through a recording D1 binding, so the row counts are measured rather than
 * asserted about source text, and the statements they capture are the ones the
 * product sends — which is what the translator half then translates.
 */

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
/* Normalised: line endings are per file in this repo and the slices below find
   their bounds with markers that contain a newline. */
const read = (file) => fs.readFileSync(path.join(root, file), "utf8").split("\r\n").join("\n");

/*
 * The same resolve hook `performance-legacy-date-types` and
 * `legacy-schema-upgrade` install. `app/lib/**` imports its neighbours without
 * file extensions and reaches `cloudflare:workers` for a binding; TypeScript
 * resolves the first and the deployed build aliases the second, so Node needs
 * both spelled out. Spelling them here keeps the source honest rather than
 * editing imports to suit a test.
 */
const stub = pathToFileURL(path.join(root, "tests/fixtures/cloudflare-workers-stub.mjs")).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { url: stub, shortCircuit: true };
    if (specifier.startsWith(".") && context.parentURL?.endsWith(".ts")) {
      const base = new URL(specifier, context.parentURL);
      for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`, `${base.href}.tsx`]) {
        if (fs.existsSync(fileURLToPath(candidate))) return { url: candidate, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
});

const { allocateSubmission, nextJobNumber } = await import("../app/lib/submission-service.ts");
const {
  highestJobReference,
  jobReferenceNumber,
  jobReferenceWindowInconclusive,
  nextJobReferenceNumber,
  JOB_REFERENCE_FLOOR,
  JOB_REFERENCE_WINDOW,
} = await import("../app/lib/job-reference.ts");
const { translateSql } = await import("../db/sqlite-to-postgres.ts");
const { drizzle } = await import("drizzle-orm/d1");
const schema = await import("../db/schema.ts");

const ORG = "org_test_bounded_read";
const OTHER = "org_someone_else";

/* ── The harness ──────────────────────────────────────────────────────────── */

/**
 * A D1 binding over `node:sqlite` that RECORDS every statement and how many
 * rows it returned. The row count is the whole point of this file: it is the
 * thing that used to grow with the estate, and it is not visible from source.
 */
function recordingBinding(database) {
  const log = [];
  class Statement {
    constructor(sql, params = []) {
      this.sql = sql;
      this.params = params;
    }
    bind(...params) {
      return new Statement(this.sql, params);
    }
    #exec() {
      const rows = database.prepare(this.sql).all(...this.params);
      log.push({ sql: this.sql, params: this.params, rows: rows.length });
      return rows;
    }
    async all() {
      return { results: this.#exec(), success: true, meta: {} };
    }
    async run() {
      this.#exec();
      return { results: [], success: true, meta: {} };
    }
    async raw() {
      return this.#exec().map((row) => Object.values(row));
    }
    async first(column) {
      const [row] = this.#exec();
      if (!row) return null;
      return column === undefined ? row : (row[column] ?? null);
    }
  }
  const client = {
    prepare: (sql) => new Statement(sql),
    async batch(statements) {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      return out;
    },
    async exec(sql) {
      database.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
  return { client, log };
}

/**
 * The three tables `nextJobNumber` reads, with the columns it reads.
 *
 * Minimal on purpose. The function under test only ever SELECTs a reference
 * column, so a fixture carrying the other ninety columns of
 * `maintenance_requests` would be ninety columns of noise. The concurrency test
 * at the bottom, which WRITES, uses a copy of the real database instead.
 */
function estate({ requests = [], placements = [], bin = [], foreign = [] } = {}) {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    create table maintenance_requests (id text primary key not null, organisation_id text not null);
    create table maintenance_group_items (request_id text primary key not null, organisation_id text not null);
    create table recycle_bin (
      id text primary key not null,
      organisation_id text not null,
      entity_type text not null,
      entity_id text not null
    );
  `);
  const request = database.prepare("insert into maintenance_requests values (?, ?)");
  const placement = database.prepare("insert into maintenance_group_items values (?, ?)");
  const binned = database.prepare("insert into recycle_bin values (?, ?, ?, ?)");
  for (const id of requests) request.run(id, ORG);
  for (const id of placements) placement.run(id, ORG);
  bin.forEach((id, index) => binned.run(`bin_${index}`, ORG, "job", id));
  /* A neighbouring tenant's rows, so every assertion below is also an assertion
     that the reads stay scoped. */
  foreign.forEach((id, index) => {
    request.run(id, OTHER);
    placement.run(id, OTHER);
    binned.run(`bin_other_${index}`, OTHER, "job", id);
  });

  const { client, log } = recordingBinding(database);
  return { database, log, db: drizzle(client, { schema }) };
}

/**
 * The algorithm as it stood before the bound: read every `MN-%` row in the
 * three tables, parse in JS, take the maxima. Nothing here is bounded, and that
 * is the point — every test that compares against it is asserting the repair
 * did not change any ANSWER, only the number of rows it took to get one.
 */
function unboundedAnswer(database) {
  const all = (sql) => database.prepare(sql).all(ORG).map((row) => Object.values(row)[0]);
  return {
    next: nextJobReferenceNumber([
      highestJobReference(
        all("select id from maintenance_requests where organisation_id = ? and id like 'MN-%'"),
      ),
      highestJobReference(
        all(
          "select request_id from maintenance_group_items where organisation_id = ? and request_id like 'MN-%'",
        ),
      ),
      highestJobReference(
        all(
          "select entity_id from recycle_bin where organisation_id = ? and entity_type = 'job' and entity_id like 'MN-%'",
        ),
      ),
    ]),
    rows:
      all("select id from maintenance_requests where organisation_id = ? and id like 'MN-%'")
        .length +
      all(
        "select request_id from maintenance_group_items where organisation_id = ? and request_id like 'MN-%'",
      ).length +
      all(
        "select entity_id from recycle_bin where organisation_id = ? and entity_type = 'job' and entity_id like 'MN-%'",
      ).length,
  };
}

const series = (from, to) => {
  const out = [];
  for (let n = from; n <= to; n += 1) out.push(`MN-${n}`);
  return out;
};

/* ── 1. The bound, measured ───────────────────────────────────────────────── */

test("a 2,000-job estate costs one window per table, not the whole estate", async (t) => {
  /*
   * The neighbouring tenant's `MN-99999` was removed from this fixture when the
   * ceiling stopped being organisation-scoped. It was here to prove a foreign
   * reference stayed INVISIBLE, which is the behaviour that turned out to be
   * the collision — a second tenant walking into ids it does not own. That
   * question now has a test of its own above, in both directions. This one is
   * about COST, and a foreign row would only add noise to the counts it exists
   * to measure.
   */
  const requests = series(1049, 3048);
  const { database, db, log } = estate({
    requests,
    placements: requests,
    bin: requests.slice(0, 500),
  });

  const answer = await nextJobNumber(db, ORG);
  assert.equal(answer, 3049, "the ceiling is still the highest reference plus one");

  assert.equal(log.length, 3, "still exactly three reads — one per table that holds a reference");
  const total = log.reduce((sum, entry) => sum + entry.rows, 0);
  assert.equal(
    total,
    3 * JOB_REFERENCE_WINDOW,
    `every read must stop at the window; got ${log.map((e) => e.rows).join(" + ")}`,
  );

  const before = unboundedAnswer(database);
  assert.equal(before.next, answer, "and the answer must be the one the unbounded read gave");
  assert.equal(before.rows, 4500, "the shape this replaced read 4,500 rows to say the same thing");
  t.diagnostic(
    `rows read per created job: ${before.rows} before, ${total} after (${log
      .map((entry) => entry.rows)
      .join(" + ")}), same answer MN-${answer}`,
  );
});

test("the reads stay bounded and ordered in the SQL, and span every tenant", async () => {
  /*
   * RE-POINTED, AND THE CLAIM IS REVERSED, because the original claim was the
   * defect.
   *
   * This asserted the ceiling read was scoped to the caller's organisation and
   * that "a neighbouring tenant's higher references must not be visible".
   * `maintenance_requests.id` is `text("id").primaryKey()` — ONE namespace for
   * every tenant — so an organisation-scoped ceiling answers a question the
   * allocator is not asking, and hands it a number another tenant already owns.
   *
   * Measured on Staging, which is exactly that shape: `org_…0001` holds
   * MN-1049 through MN-1078 and no other organisation holds a numbered id.
   * A share-link submission for a second tenant therefore started at the floor,
   * walked MN-1049…MN-1056, found all eight taken, exhausted the attempts and
   * answered "Could not allocate a job id; too many simultaneous creates" — a
   * message about concurrency for a collision, behind a 503 the route swallowed
   * unlogged. That tenant could not create its first job at all.
   *
   * So the neighbouring tenant's references MUST be visible: they are the ones
   * that would collide. The bound and the ordering — the actual subject of this
   * file — are asserted exactly as before.
   */
  const { db, log } = estate({ requests: series(1049, 1100), foreign: series(2000, 2100) });
  const answer = await nextJobNumber(db, ORG);
  assert.equal(
    answer,
    2101,
    "the ceiling must clear EVERY tenant's references, because the id is a global primary key",
  );

  for (const entry of log) {
    assert.match(entry.sql, /order by length\("[a-z_]+"\."[a-z_]+"\) desc/, entry.sql);
    assert.match(entry.sql, /limit \?$/, `${entry.sql} — the window must reach the database`);
    assert.equal(
      entry.params.at(-1),
      JOB_REFERENCE_WINDOW,
      "the bound the database receives is the exported one, not a literal typed twice",
    );
    assert.ok(
      !entry.params.includes(ORG),
      `${entry.sql} must NOT filter the ceiling by organisation — that is the collision`,
    );
  }
});

test("a tenant with no jobs of its own does not collide with another tenant's", async () => {
  /*
   * The outage, reproduced. The caller's organisation holds nothing; another
   * holds the ids immediately above the floor. Before the fix the ceiling was
   * the floor and the allocator walked straight into rows it did not own.
   */
  const { db } = estate({ requests: [], foreign: series(1049, 1078) });
  assert.equal(
    await nextJobNumber(db, ORG),
    1079,
    "the first job of a new tenant must land above every id that already exists",
  );
});

/* ── 2. The ordering is the numbers ───────────────────────────────────────── */

test("the ceiling clears a length boundary the product will actually cross", async () => {
  /*
   * A text `MAX()` answers `MN-9999` here, because '9' > '1'. The estate is
   * deliberately mixed so the window has to sort rather than luck into it.
   */
  const { database, db } = estate({
    requests: [...series(9990, 9999), "MN-10000", ...series(1049, 1060)],
  });
  assert.equal(await nextJobNumber(db, ORG), 10001);

  const textMax = database
    .prepare("select max(id) as top from maintenance_requests where id like 'MN-%'")
    .get().top;
  assert.equal(textMax, "MN-9999", "which is what a SQL text MAX would have answered");
});

test("every length boundary sorts numerically, 8 -> 9 -> 10 -> 100 -> 1000", () => {
  /*
   * Run rather than reasoned about, and run against the same expression the
   * product sends. The identical statement was executed on Postgres 17.6
   * (staging, `en_US.UTF-8`) and returned this exact order, which is what makes
   * the two estates agree:
   *
   *   MN-1300 > MN-1289 > MN-1272 > MN-1049 > MN-1048 > MN-1001 > MN-1000 >
   *   MN-999 > MN-101 > MN-100 > MN-99 > MN-11 > MN-10 > MN-9 > MN-8
   */
  const { database } = estate({
    requests: [
      "MN-9",
      "MN-10",
      "MN-99",
      "MN-100",
      "MN-999",
      "MN-1000",
      "MN-1048",
      "MN-1049",
      "MN-1272",
      "MN-1289",
      "MN-1300",
      "MN-8",
      "MN-11",
      "MN-101",
      "MN-1001",
    ],
  });
  const ordered = database
    .prepare(
      "select id from maintenance_requests where id like 'MN-%' order by length(id) desc, id desc",
    )
    .all()
    .map((row) => row.id);

  assert.deepEqual(ordered, [
    "MN-1300",
    "MN-1289",
    "MN-1272",
    "MN-1049",
    "MN-1048",
    "MN-1001",
    "MN-1000",
    "MN-999",
    "MN-101",
    "MN-100",
    "MN-99",
    "MN-11",
    "MN-10",
    "MN-9",
    "MN-8",
  ]);

  /* The property the window rests on, stated as a property: the ordered list is
     descending numeric order, so its FIRST well-formed row is the maximum. */
  const numbers = ordered.map((id) => jobReferenceNumber(id));
  assert.deepEqual(numbers, [...numbers].sort((a, b) => b - a));
});

/* ── 3. A malformed reference cannot crash it or lower the ceiling ────────── */

test("a reference that is not MN-<digits> cannot crash the read or lower the ceiling", async () => {
  /*
   * Every one of these matches `LIKE 'MN-%'` and none is `MN-<digits>`, and
   * every one of them sorts ABOVE the true maximum — measured identically on
   * SQLite and on Postgres 17.6. This is the case that decides window vs
   * `LIMIT 1`, so both are run.
   */
  const junk = ["MN-1272-copy", "MN-0000001", "MN-draft", "MN-", "MN-127a"];
  const { database, db } = estate({ requests: [...junk, "MN-1300", "MN-1279", "MN-1272"] });

  assert.equal(
    await nextJobNumber(db, ORG),
    1301,
    "the malformed rows are read, parsed to nothing and ignored — the ceiling is the real maximum",
  );

  const top = database
    .prepare(
      "select id from maintenance_requests where id like 'MN-%' order by length(id) desc, id desc limit 1",
    )
    .get().id;
  assert.equal(top, "MN-1272-copy", "the row a LIMIT 1 read would have answered with");
  assert.equal(
    jobReferenceNumber(top),
    null,
    "which parses to nothing — a LIMIT 1 read would have collapsed the ceiling to the floor and " +
      "re-issued every live reference",
  );

  /* And the estate's own shape: a `req_…` id never reaches the parser at all,
     because `LIKE 'MN-%'` excludes it before the ordering sees it. */
  const { db: mixed } = estate({ requests: ["MN-1300"] });
  assert.equal(await nextJobNumber(mixed, ORG), 1301);
});

test("an estate of nothing but malformed references is re-read rather than guessed at", async () => {
  /*
   * The one answer a bounded read may not conclude from: a FULL window that
   * carried no reference at all. Concluding "this table holds none" there would
   * hand a new job a reference another table still holds. The read is widened
   * instead, which is why there are four statements here and not three.
   */
  const junk = Array.from(
    { length: JOB_REFERENCE_WINDOW + 4 },
    (_, i) => `MN-draft-${String(i).padStart(3, "0")}`,
  );
  const { db, log } = estate({ requests: [...junk, "MN-1300"] });

  assert.equal(await nextJobNumber(db, ORG), 1301, "the widened read must still find MN-1300");
  assert.equal(log.length, 4, "one table was re-read; the other two answered from their window");
  assert.ok(
    log[1].params.at(-1) > JOB_REFERENCE_WINDOW,
    "the second read of that table asks for more than a window",
  );

  /* A SHORT window is conclusive however empty it is — the read asked for more
     rows than existed, so it saw every candidate there was. */
  assert.equal(jobReferenceWindowInconclusive(["MN-x", "MN-y"]), false);
  assert.equal(
    jobReferenceWindowInconclusive(Array.from({ length: JOB_REFERENCE_WINDOW }, () => "MN-x")),
    true,
  );
  assert.equal(
    jobReferenceWindowInconclusive(
      Array.from({ length: JOB_REFERENCE_WINDOW }, (_, i) => (i ? "MN-x" : "MN-1300")),
    ),
    false,
    "one well-formed row in the window is enough — the rows arrive in numeric order",
  );
});

/* ── 4. The answers did not move ──────────────────────────────────────────── */

test("the bounded read answers exactly what the unbounded read answered", async () => {
  /*
   * The repair is only allowed to change the COST. Every shape the three tables
   * can be in — including the two that caused the original outage, a placement
   * and a bin entry that outlived their job — must produce the same number.
   */
  const shapes = [
    ["an empty workspace", {}],
    ["one job", { requests: ["MN-1049"] }],
    ["a placement that outlived its job", { requests: series(1049, 1157), placements: ["MN-1162"] }],
    ["a bin entry that outlived its job", { requests: series(1049, 1157), bin: ["MN-1301"] }],
    ["nothing left over", { requests: series(1049, 1157), placements: series(1049, 1157) }],
    ["a full window of jobs", { requests: series(1049, 1049 + JOB_REFERENCE_WINDOW) }],
    ["one job past a full window", { requests: series(1049, 1050 + JOB_REFERENCE_WINDOW) }],
    ["references below the floor", { requests: ["MN-1", "MN-9", "MN-10"] }],
    ["a zero-padded reference", { requests: ["MN-0000001", "MN-1300"] }],
    ["malformed rows above the maximum", { requests: ["MN-draft", "MN-1272-copy", "MN-1300"] }],
    ["a large estate", { requests: series(1049, 2500), placements: series(1049, 2500) }],
    ["only a bin", { bin: series(1049, 1400) }],
  ];

  for (const [name, shape] of shapes) {
    const { database, db, log } = estate(shape);
    const bounded = await nextJobNumber(db, ORG);
    const before = unboundedAnswer(database);
    assert.equal(bounded, before.next, `${name}: the bounded read changed the answer`);
    const rows = log.reduce((sum, entry) => sum + entry.rows, 0);
    assert.ok(
      rows <= 3 * JOB_REFERENCE_WINDOW,
      `${name}: ${rows} rows read, which is past the window`,
    );
  }
});

test("an empty workspace still starts at the historical floor", async () => {
  const { db } = estate({});
  assert.equal(await nextJobNumber(db, ORG), JOB_REFERENCE_FLOOR + 1);
});

/* ── 5. What Postgres receives ────────────────────────────────────────────── */

test("the SQL Postgres receives keeps length() and gains no cast", async () => {
  /*
   * Translated from the statements the product ACTUALLY sent above, not from a
   * copy of them written here. `length()` is neither rewritten nor rejected by
   * `db/sqlite-to-postgres.ts`, and it means the same thing in both dialects
   * for text; the whole hazard this shape exists to avoid is a cast.
   *
   * The translated statement was then executed against the real
   * `portal.maintenance_requests` on Postgres 17.6 (staging) and returned the
   * org's references in descending numeric order, planned as an index scan on
   * `organisation_id` plus a bounded sort.
   */
  const { db, log } = estate({ requests: series(1049, 1100), bin: ["MN-1200"] });
  await nextJobNumber(db, ORG);
  assert.equal(log.length, 3);

  for (const entry of log) {
    const postgres = translateSql(entry.sql);
    assert.match(postgres, /order by length\(/, postgres);
    assert.match(postgres, /limit \$\d+$/, `${postgres} — the bound must survive translation`);
    assert.doesNotMatch(
      postgres,
      /\bcast\s*\(/i,
      "a cast is the 22P02 that took the whole create path down on Postgres and could not fail locally",
    );
    assert.doesNotMatch(postgres, /\bsubstr\s*\(/i, postgres);
    /* Placeholders renumber; nothing else about the statement may change. */
    assert.equal(
      postgres.replace(/\$\d+/g, "?"),
      entry.sql,
      "the translator must be a no-op on this statement beyond the placeholders",
    );
  }
});

/* ── 6. The source contracts the measurements rest on ─────────────────────── */

test("all three reads are bounded and ordered, and none of them casts", () => {
  const source = read("app/lib/submission-service.ts");
  const fn = source.slice(
    source.indexOf("export async function nextJobNumber("),
    source.indexOf("export type AllocatedSubmission"),
  );
  assert.ok(fn.length > 0, "nextJobNumber must still exist");

  assert.equal(
    (fn.match(/\.limit\(limit\)/g) ?? []).length,
    3,
    "each of the three reads must carry the window; an unbounded one puts the whole estate back on the create path",
  );
  assert.equal(
    (fn.match(/length\(\$\{/g) ?? []).length,
    3,
    "and each must order by length first — without it MN-999 outranks MN-1000",
  );
  assert.equal(
    (fn.match(/\bdesc\(/g) ?? []).length,
    3,
    "and by the reference itself second, which within one length is numeric order",
  );
  assert.ok(
    !/cast\s*\(/i.test(fn),
    "no cast may reach the database — SQLite yields 0 and Postgres raises 22P02",
  );
});

test("the walk past a taken id is unchanged, because the bound is not a reservation", () => {
  /*
   * A bounded read is a smaller read. It is still a MAX, still taken outside a
   * transaction, and still able to hand the same number to two simultaneous
   * submissions — the safety is, and stays, in the caller.
   */
  const source = read("app/lib/submission-service.ts");
  const loop = source.slice(
    source.indexOf("const base = await nextJobNumber(db, input.organisationId);"),
    source.indexOf("return { request: created, placement: placed ?? null };"),
  );
  assert.ok(loop.length > 0, "the allocation loop must still exist");
  assert.match(loop, /for \(let attempt = 0; attempt < MAX_ITEM_ID_ATTEMPTS; attempt\+\+\)/);
  assert.match(loop, /const id = `MN-\$\{base \+ attempt\}`;/);
  assert.match(loop, /\.onConflictDoNothing\(\)/);
  assert.ok(
    !/JOB_REFERENCE_WINDOW|\.limit\(/.test(loop),
    "the window belongs to the read, not to the walk",
  );
});

/* ── 7. Simultaneous submissions, against a real database ─────────────────── */

/** The dev estate, so the writes below meet the real schema and its constraints. */
function localDatabaseFile() {
  const dir = path.join(root, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite");
  return files.length === 1 ? path.join(dir, files[0]) : null;
}

test("simultaneous submissions never share a reference", async (t) => {
  /*
   * A COPY of the dev estate, thrown away at the end. Nothing here touches the
   * database the dev server is serving, and nothing is left behind to be swept.
   *
   * This is the race reproduced deterministically rather than hopefully. Every
   * creator runs `nextJobNumber` before any of them inserts — `Promise.all`
   * over an async binding interleaves at exactly those await points — so all of
   * them compute the SAME base, which is the worst case the live test can only
   * hope to hit. What must come out is one reference each.
   */
  const source = localDatabaseFile();
  if (!source) {
    t.skip("no single local D1 database to copy; run the dev server once first");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maintsupp-jobref-"));
  const file = path.join(dir, "estate.sqlite");
  fs.copyFileSync(source, file);
  const database = new DatabaseSync(file);

  try {
    const seed = database
      .prepare(
        `select r.organisation_id as org, r.site_id as site, i.group_id as grp, i.board_id as board
           from maintenance_group_items i
           join maintenance_requests r on r.id = i.request_id
          limit 1`,
      )
      .get();
    if (!seed) {
      t.skip("the copied estate has no placed job to borrow a group from");
      return;
    }

    const { client, log } = recordingBinding(database);
    const db = drizzle(client, { schema });
    const base = await nextJobNumber(db, seed.org);

    /*
     * Diagnostic, not an assertion: the dev estate moves, and CLAUDE.md is
     * explicit that a test may not depend on `.wrangler` state. It is here
     * because the claim this file makes is about real data, and a number
     * printed from real data is worth more than the same number reasoned about.
     */
    const count = (sql) => database.prepare(sql).all(seed.org)[0].n;
    const unbounded =
      count(
        "select count(*) as n from maintenance_requests where organisation_id = ? and id like 'MN-%'",
      ) +
      count(
        "select count(*) as n from maintenance_group_items where organisation_id = ? and request_id like 'MN-%'",
      ) +
      count(
        "select count(*) as n from recycle_bin where organisation_id = ? and entity_type = 'job' and entity_id like 'MN-%'",
      );
    t.diagnostic(
      `dev estate: ${unbounded} rows before, ${log.reduce((sum, e) => sum + e.rows, 0)} after ` +
        `(${log.map((e) => e.rows).join(" + ")}), ceiling MN-${base}`,
    );
    log.length = 0;

    const creators = 6;
    const results = await Promise.all(
      Array.from({ length: creators }, (_, index) =>
        allocateSubmission(db, {
          organisationId: seed.org,
          boardId: seed.board,
          groupId: seed.grp,
          values: {
            siteId: seed.site,
            title: `bounded-read race ${index}`,
            description: "",
            location: "",
            requester: "",
            contact: "",
            category: "",
            engineer: "",
          },
        }),
      ),
    );

    const ids = results.map((result) => result.request.id);
    ids.forEach((id) => assert.match(id, /^MN-\d+$/, `${id} keeps the MN-#### shape`));
    assert.equal(
      new Set(ids).size,
      creators,
      `every reference must be distinct, got ${ids.join(", ")}`,
    );
    results.forEach((result, index) =>
      assert.equal(
        result.placement?.requestId,
        ids[index],
        "and each must have come down with its placement",
      ),
    );

    /* The base every creator computed, and the fan-out that made them distinct.
       Nothing may be issued below the base, which is the invariant the walk and
       the bounded read share. */
    const numbers = ids.map((id) => jobReferenceNumber(id)).sort((a, b) => a - b);
    assert.deepEqual(
      numbers,
      Array.from({ length: creators }, (_, index) => base + index),
      "the creators must fan out across consecutive slots from one base",
    );
    t.diagnostic(`${creators} simultaneous creates from base MN-${base}: ${ids.join(", ")}`);

    /* Nothing that ran during the race was an unbounded read. */
    for (const entry of log.filter((row) => /^select .* order by length\(/.test(row.sql))) {
      assert.ok(entry.rows <= JOB_REFERENCE_WINDOW, `${entry.rows} rows is past the window`);
    }
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
