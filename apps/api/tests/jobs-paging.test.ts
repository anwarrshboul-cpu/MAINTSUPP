/**
 * Paging and filtering on GET /jobs.
 *
 * The bug this file exists for: the row query and the count query were built
 * separately, and the count composed only the tenancy scope. `?stage=New`
 * returned one row alongside `total: 17, hasMore: true` — so a caller pages
 * forward into empty results while the UI displays a total that belongs to a
 * different question. It is the same shape as the defect that once had this
 * product showing 250 of 744 jobs and looking complete: every number agreed
 * with every other number, and all of them were wrong.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type Db } from "../../../packages/db/src/client.ts";
import { createApp } from "../src/server.ts";

let db: Db;
let app: ReturnType<typeof createApp>;
let cookie: string;
const ids: Record<string, string> = {};

const call = (path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      "x-forwarded-for": `10.2.0.${Math.floor(Math.random() * 250) + 1}`,
      ...init.headers,
    },
  });

before(async () => {
  db = await createTestDb();
  app = createApp(db);

  const [org] = await db.query<{ id: string }>(
    "insert into organisations (name, slug) values ('Paging Co','paging-co') returning id::text",
  );
  ids.org = org.id;
  const [siteA] = await db.query<{ id: string }>(
    "insert into sites (organisation_id, name) values ($1,'Alpha') returning id::text",
    [org.id],
  );
  const [siteB] = await db.query<{ id: string }>(
    "insert into sites (organisation_id, name) values ($1,'Beta') returning id::text",
    [org.id],
  );
  ids.siteA = siteA.id;
  ids.siteB = siteB.id;

  // 3 at Alpha in the New stage, 17 at Beta in Scheduling. Deliberately
  // lopsided so a count that ignores the filter is obvious rather than a
  // coincidence that happens to match.
  for (let i = 0; i < 3; i += 1) {
    await db.query(
      `insert into jobs (organisation_id, site_id, title, description, status)
       values ($1,$2,$3,'seed','Pending Approval')`,
      [org.id, siteA.id, `Alpha shutter ${i}`],
    );
  }
  for (let i = 0; i < 17; i += 1) {
    await db.query(
      `insert into jobs (organisation_id, site_id, title, description, status)
       values ($1,$2,$3,'seed','Job Scheduled')`,
      [org.id, siteB.id, `Beta lighting ${i}`],
    );
  }

  await call("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      email: "paging@test.local",
      password: "paging-password-123",
      fullName: "Paging",
    }),
  });
  await db.query(
    "update users set email_verified_at = now() where lower(email) = 'paging@test.local'",
  );
  await db.query("update profiles set role = 'admin', status = 'active' where email = 'paging@test.local'");
  const res = await call("/auth/sign-in", {
    method: "POST",
    body: JSON.stringify({ email: "paging@test.local", password: "paging-password-123" }),
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
});

after(async () => {
  await db.close();
});

const board = async (query = "") =>
  (await (await call(`/jobs${query}`)).json()) as {
    jobs: unknown[];
    total: number;
    hasMore: boolean;
    offset: number;
  };

describe("total and hasMore describe the SAME query as the rows", () => {
  test("unfiltered, the total is the whole board", async () => {
    const all = await board();
    assert.equal(all.total, 20);
    assert.equal(all.jobs.length, 20);
    assert.equal(all.hasMore, false);
  });

  test("a stage filter narrows the total, not just the rows", async () => {
    const filtered = await board("?stage=New");
    assert.equal(filtered.jobs.length, 3);
    assert.equal(
      filtered.total,
      3,
      "the count ignored the stage filter — it is counting the whole board",
    );
    assert.equal(filtered.hasMore, false, "hasMore would page into empty results");
  });

  test("a site filter narrows the total", async () => {
    const filtered = await board(`?siteId=${ids.siteB}`);
    assert.equal(filtered.jobs.length, 17);
    assert.equal(filtered.total, 17);
  });

  test("a search narrows the total", async () => {
    const filtered = await board("?q=Alpha");
    assert.equal(filtered.jobs.length, 3);
    assert.equal(filtered.total, 3);
  });

  test("filters combine, and the total follows", async () => {
    const both = await board(`?stage=New&siteId=${ids.siteA}`);
    assert.equal(both.jobs.length, 3);
    assert.equal(both.total, 3);

    // A combination that matches nothing must say so, not fall back to
    // "no filter" and return the board.
    const none = await board(`?stage=New&siteId=${ids.siteB}`);
    assert.equal(none.jobs.length, 0);
    assert.equal(none.total, 0);
    assert.equal(none.hasMore, false);
  });
});

describe("paging", () => {
  test("limit and offset walk the board without gaps or repeats", async () => {
    const first = await board("?limit=8&offset=0");
    assert.equal(first.jobs.length, 8);
    assert.equal(first.total, 20);
    assert.equal(first.hasMore, true);

    const last = await board("?limit=8&offset=16");
    assert.equal(last.jobs.length, 4);
    assert.equal(last.hasMore, false, "hasMore was still true on the final page");
  });

  test("paging a filtered board terminates", async () => {
    // The original bug in one assertion: with total=20 against 3 filtered rows,
    // hasMore stayed true and a client looped.
    const page = await board("?stage=New&limit=2&offset=2");
    assert.equal(page.jobs.length, 1);
    assert.equal(page.total, 3);
    assert.equal(page.hasMore, false);
  });
});
