/**
 * THE JOB REFERENCE MUST NOT BE RE-ISSUED WHILE ANY TABLE STILL HOLDS IT.
 *
 * `MN-…` is the primary key of `maintenance_requests`, the primary key of
 * `maintenance_group_items`, and half the unique key of `recycle_bin`. The
 * allocator used to take its MAX over the first of those alone, so a row in
 * either of the others that outlived its job dragged the ceiling back below a
 * reference that was still spoken for. The allocator re-issued it, and the
 * insert that collided was NOT the one the retry guarded:
 *
 *   · a surviving placement  ->  `create_item`  answered a bare 503
 *   · a surviving bin entry  ->  `delete_items` answered a bare 503
 *
 * Both were observed on the dev estate: `maintenance_requests` topped out at
 * MN-1157 while placements held MN-1162, and no job could be created on the
 * board at all until the leftovers were removed by hand.
 *
 * These tests pin the two halves of the repair:
 *
 *   1. THE FLOOR — the starting number is above every table that still holds a
 *      reference, so the product does not depend on a cleanup script.
 *   2. THE RETRY — the request row and its placement are allocated together, so
 *      the guarantee does not depend on that list of tables being complete.
 *      This is the half that survives somebody adding a fourth table.
 *
 * The live half runs against a dev server and skips without one. It creates
 * jobs, and every id it creates is deleted through the app's own purge — which
 * removes the placement too, and is precisely what the QA scripts that caused
 * this bug did not do. MN-1049 is never touched.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const read = async (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

const BASE = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER = { email: "owner@maintsupp.com", password: "Sunnamusk-Owner-2026" };
const SOURCE = "app/lib/board-mutations.ts";

/* ── 1. The floor ─────────────────────────────────────────────────────────── */

test("the allocator's floor is taken over every table that holds a reference", async () => {
  const source = await read(SOURCE);
  const fn = source.slice(
    source.indexOf("async function nextItemNumber("),
    source.indexOf("/**\n * How many consecutive ids"),
  );
  assert.ok(fn.length > 0, "nextItemNumber must still exist");

  for (const table of [
    "maintenanceRequests",
    "maintenanceGroupItems",
    "recycleBin",
  ]) {
    assert.ok(
      fn.includes(`.from(${table})`),
      `the floor must consider ${table} — a row there can outlive its job`,
    );
  }

  /* The arithmetic itself moved to ./job-reference.ts so a test can run it —
     this function is only the three reads that feed it, and it must feed ALL
     three rather than picking one. */
  assert.match(
    fn,
    /nextJobReferenceNumber\(\[\s*fromRequests\?\.maxNumber,\s*fromPlacements\?\.maxNumber,\s*fromBin\?\.maxNumber,?\s*\]\)/,
    "all three maxima must reach the allocator",
  );

  /*
   * `recycle_bin.entity_id` also carries group, column and board-view ids,
   * which share no numbering with MN-…. Counting them would inflate the floor
   * and skip references for no reason.
   */
  assert.match(
    fn,
    /eq\(recycleBin\.entityType, "job"\)/,
    "only job entries in the bin carry an MN reference",
  );

  // Still per organisation, like the read it replaced.
  assert.equal(
    (fn.match(/organisationId, orgId\)/g) ?? []).length,
    3,
    "every one of the three reads stays scoped to the organisation",
  );
});

test("the bin is still counted, so a binned job keeps its reference", async () => {
  /*
   * Stage 23's rule, unchanged and easy to break while 'fixing' this: a job in
   * the recycle bin still owns its id. Filtering `deleted_at` out of the
   * request read would hand the same reference to a new job and collide when
   * somebody restored the old one — the worst possible moment.
   */
  const source = await read(SOURCE);
  const fn = source.slice(
    source.indexOf("async function nextItemNumber("),
    source.indexOf("/**\n * How many consecutive ids"),
  );
  assert.ok(
    !/isNull\((maintenanceRequests\.)?deletedAt\)/.test(fn),
    "the allocator must not exclude binned jobs",
  );
  assert.match(source, /DELIBERATELY UNFILTERED/, "and must keep saying why");
});

/* ── 2. The retry ─────────────────────────────────────────────────────────── */

test("the request row and its placement are allocated together", async () => {
  const source = await read(SOURCE);
  const loop = source.slice(
    source.indexOf("const base = await nextItemNumber(db, orgId);"),
    source.indexOf("const item = placement;"),
  );
  assert.ok(loop.length > 0, "the allocation loop must still exist");

  // Both inserts inside the one loop, both tolerant of a lost race.
  assert.match(loop, /\.insert\(maintenanceRequests\)[\s\S]*?\.onConflictDoNothing\(\)/);
  assert.match(loop, /\.insert\(maintenanceGroupItems\)[\s\S]*?\.onConflictDoNothing\(\)/);

  /*
   * And a lost placement must undo its request row. Leaving it strands an
   * unplaced row, which the board files onto the default board belonging to
   * nobody — six were produced that way during W02-06.
   */
  assert.match(
    loop,
    /\.delete\(maintenanceRequests\)/,
    "a taken placement must delete the request row before walking on",
  );
  assert.match(
    loop,
    /if \(!created \|\| !placement\)/,
    "success requires BOTH, or the allocation failed",
  );
});

/* ── 3. Live: the exact shapes that used to 503 ───────────────────────────── */

const serverUp = async () => {
  try {
    await fetch(`${BASE}/api/context`, { signal: AbortSignal.timeout(4000) });
    return true;
  } catch {
    return false;
  }
};

async function signIn() {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(OWNER),
  });
  const jar = (response.headers.getSetCookie?.() ?? [])
    .map((line) => line.split(";")[0])
    .join("; ");
  assert.ok(response.ok, `sign-in failed: ${response.status}`);
  return jar;
}

const api = (jar) => async (path, init = {}) =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", cookie: jar, ...(init.headers ?? {}) },
  });

/** Removes a job the way the APP does — placement included. Never MN-1049. */
async function purge(call, id) {
  assert.notEqual(id, "MN-1049", "MN-1049 must never be touched");
  await call(`/api/board?board=maintenance`, {
    method: "POST",
    body: JSON.stringify({ action: "delete_items", requestIds: [id] }),
  });
  const bin = await (await call("/api/trash")).json();
  const entry = (bin.bin?.entries ?? []).find((row) => row.entityId === id);
  if (entry) await call(`/api/trash?id=${entry.id}`, { method: "DELETE" });
}

test("live: a job can be created, and the reference it gets is free everywhere", async (t) => {
  if (!(await serverUp())) {
    t.skip(`no dev server at ${BASE}`);
    return;
  }
  const call = api(await signIn());
  const board = await (await call("/api/board?board=maintenance&compact=1")).json();
  const groupId = board.groupIds?.[0] ?? board.groups?.[0]?.id;
  assert.ok(groupId, "the maintenance board must have a group to create into");

  const created = [];
  try {
    const response = await call("/api/board?board=maintenance", {
      method: "POST",
      body: JSON.stringify({ action: "create_item", boardId: "maintenance", groupId }),
    });
    assert.equal(response.status, 201, `create_item must succeed, got ${response.status}`);
    const body = await response.json();
    const id = body.request?.id;
    assert.match(id, /^MN-\d+$/, "the reference keeps its MN-#### shape");
    created.push(id);

    /*
     * The reference it was handed must not already be spoken for anywhere —
     * which is the whole property. Deleting it exercises the bin path that used
     * to 503 on a stale entry.
     */
    const removal = await call("/api/board?board=maintenance", {
      method: "POST",
      body: JSON.stringify({ action: "delete_items", requestIds: [id] }),
    });
    assert.equal(removal.status, 200, `delete_items must succeed, got ${removal.status}`);
  } finally {
    for (const id of created) await purge(call, id).catch(() => undefined);
  }
});

test("live: simultaneous creates all succeed and every reference is distinct", async (t) => {
  if (!(await serverUp())) {
    t.skip(`no dev server at ${BASE}`);
    return;
  }
  const call = api(await signIn());
  const board = await (await call("/api/board?board=maintenance&compact=1")).json();
  const groupId = board.groupIds?.[0] ?? board.groups?.[0]?.id;

  const created = [];
  try {
    /*
     * Five at once. `nextItemNumber` reads a MAX rather than reserving from a
     * counter, so all five compute the same base and fan out across
     * consecutive slots through the retry. What must never happen is two jobs
     * sharing a reference, or one of them 503ing.
     */
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        call("/api/board?board=maintenance", {
          method: "POST",
          body: JSON.stringify({ action: "create_item", boardId: "maintenance", groupId }),
        }),
      ),
    );
    const bodies = await Promise.all(responses.map((r) => r.json().catch(() => ({}))));
    responses.forEach((r, i) =>
      assert.equal(r.status, 201, `create ${i} failed ${r.status}: ${JSON.stringify(bodies[i])}`),
    );

    const ids = bodies.map((b) => b.request?.id);
    ids.forEach((id) => assert.match(String(id), /^MN-\d+$/));
    created.push(...ids);
    assert.equal(new Set(ids).size, ids.length, `references must be distinct, got ${ids.join(", ")}`);
  } finally {
    for (const id of created) await purge(call, id).catch(() => undefined);
  }
});

/* ── 4. The stale rows themselves, run rather than read ──────────────────── */

/*
 * These are the two shapes that caused the outage, and they cannot be made
 * through the API — the API is now the thing that prevents them. So the real
 * arithmetic is RUN against the maxima a database holding a leftover row would
 * report.
 *
 * It lives in `app/lib/job-reference.ts` rather than beside the reads because
 * `board-mutations.ts` reaches the database, and that pulls `board-registry` ->
 * `chatgpt-auth` -> `next/headers` into the graph, which `node --test` cannot
 * resolve. Same split, same reason, as contractor-comment-log.ts.
 */
const REF = "../app/lib/job-reference.ts";

test("a placement that outlived its job cannot have its reference re-issued", async () => {
  const { nextJobReferenceNumber } = await import(REF);
  /*
   * The exact dev-estate shape: requests topped out at 1157 while a leftover
   * placement still held 1162. The old ceiling returned 1158 and the placement
   * insert then failed on its primary key — `create_item` 503.
   */
  assert.equal(
    nextJobReferenceNumber([1157, 1162, 1048]),
    1163,
    "the floor must clear the leftover placement, not stop at the request max",
  );
});

test("a bin entry that outlived its job cannot have its reference re-issued", async () => {
  const { nextJobReferenceNumber } = await import(REF);
  /*
   * The other half: the bin's unique key is (organisation, entity_type,
   * entity_id), so a leftover entry made `delete_items` 503 once the reference
   * was re-issued and that job was later deleted.
   */
  assert.equal(nextJobReferenceNumber([1157, 1157, 1301]), 1302);
});

test("with nothing left over, references stay consecutive", async () => {
  const { nextJobReferenceNumber } = await import(REF);
  // No skipping when there is nothing to skip.
  assert.equal(nextJobReferenceNumber([1157, 1157, 1100]), 1158);
});

test("an empty workspace starts at the historical floor, not at 1", async () => {
  const { nextJobReferenceNumber, JOB_REFERENCE_FLOOR } = await import(REF);
  /*
   * null is "this table holds none", which is not zero. The monday import
   * ended at MN-1048, so the first locally created job is MN-1049; starting
   * lower would hand a new job an imported job's number.
   */
  assert.equal(JOB_REFERENCE_FLOOR, 1048);
  assert.equal(nextJobReferenceNumber([null, null, null]), 1049);
  assert.equal(nextJobReferenceNumber([undefined, 0, null]), 1049);
});

test("only a well-formed MN reference counts toward the ceiling", async () => {
  const { jobReferenceNumber } = await import(REF);
  /*
   * `recycle_bin.entity_id` also carries group, column and board-view ids. A
   * loose parse of one of those would inflate the ceiling and skip a block of
   * references for nothing.
   */
  assert.equal(jobReferenceNumber("MN-1162"), 1162);
  assert.equal(jobReferenceNumber(" MN-1162 "), 1162);
  assert.equal(jobReferenceNumber("bin_1f87d7da"), null);
  assert.equal(jobReferenceNumber("group-incoming"), null);
  assert.equal(jobReferenceNumber("MN-"), null);
  assert.equal(jobReferenceNumber("MN-12x"), null);
  assert.equal(jobReferenceNumber(null), null);
});
