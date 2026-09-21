/**
 * §23 — a job's stage and status history, trustworthy going forward.
 *
 * The rule that decides what counts as a transition is CALLED. The claim that
 * matters most — every door records — is pinned door by door, because a door
 * that forgets is exactly how a history stops being trustworthy. The owner's
 * other rule, "nothing reconstructed by inference", is pinned as the absence of
 * any backfill. The live half walks one job through four doors.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const ts = (await import("typescript")).default;
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function fnSource(source, name) {
  const start = source.search(new RegExp(`(export )?(async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} has moved; fix this test`);
  return source.slice(start, source.indexOf("\n}\n", start) + 2).replace(/^export /, "");
}

async function loadDiff() {
  const source = await read("app/lib/job-status-history.ts");
  const js = ts.transpileModule(`${fnSource(source, "value")}\n${fnSource(source, "statusChangesBetween")}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function("FIELDS", `${js}; return statusChangesBetween;`)(["stage", "status"]);
}

test("a transition is a field that changed; a new job's first state has no 'from'", async () => {
  const diff = await loadDiff();
  assert.deepEqual(diff("MN-1", null, { stage: "Incoming", status: "Pending Approval" }), [
    { requestId: "MN-1", field: "stage", from: null, to: "Incoming" },
    { requestId: "MN-1", field: "status", from: null, to: "Pending Approval" },
  ]);
  assert.deepEqual(
    diff("MN-1", { stage: "Incoming", status: "Pending Approval" }, { stage: "Booked", status: "Job Scheduled" }),
    [
      { requestId: "MN-1", field: "stage", from: "Incoming", to: "Booked" },
      { requestId: "MN-1", field: "status", from: "Pending Approval", to: "Job Scheduled" },
    ],
  );
  assert.deepEqual(diff("MN-1", { stage: "Booked", status: "A" }, { stage: "Booked", status: "B" }), [
    { requestId: "MN-1", field: "status", from: "A", to: "B" },
  ], "an unchanged field is not a transition");
  assert.deepEqual(diff("MN-1", { stage: " Booked ", status: "A" }, { stage: "Booked", status: "A" }), [], "whitespace is not a change");
  assert.deepEqual(diff("MN-1", { stage: "Booked" }, null), [], "no row after, nothing recorded");
});

test("every door that moves a job records it, under its own name", async () => {
  const doors = [
    ["app/lib/submission-service.ts", /source: `created:\$\{input\.source\}`/],
    ["app/lib/board-mutations.ts", /source: "board\.create"/],
    ["app/lib/board-mutations.ts", /source: "board\.duplicate"/],
    ["app/lib/board-mutations.ts", /source = archive \? "board\.archive" : "board\.move"/],
    ["app/api/maintenance/route.ts", /source: "job\.edit"/],
    ["app/api/board/route.ts", /source: "board\.move"/],
    ["app/api/board/route.ts", /source: "board\.group_deleted"/],
    ["app/api/board/items/route.ts", /source: "board\.bulk"/],
    ["app/lib/automations/actions.ts", /source: "automation"/],
    ["app/api/options/route.ts", /source: "options\.reassign"/],
    ["app/api/import/route.ts", /source: "import"/],
  ];
  for (const [path, pattern] of doors) {
    const source = code(await read(path));
    assert.match(source, pattern, `${path} must record its transitions`);
    assert.match(source, /recordJobStatusChanges\(/);
  }
  /* The automation's moves are named as the automation's, not the board's. */
  const actions = code(await read("app/lib/automations/actions.ts"));
  assert.equal((actions.match(/\[item\.id\], (false|true), "automation"\)/g) ?? []).length, 2);
});

test("the drawer's stage change sent with a note is recorded even though the activity row is the note", async () => {
  const route = code(await read("app/api/maintenance/route.ts"));
  assert.match(route, /changes: statusChangesBetween\(id, before, updated\)/);
  /* owner-part-five still pins the activity row as the note — untouched. */
  assert.match(route, /action: note\s*\? "request\.note_added"/);
});

test("nothing is reconstructed by inference: no backfill, and the UI says where the record begins", async () => {
  const init = code(await read("db/init.ts"));
  const stage = init.slice(init.indexOf("async function ensureJobStatusHistory"), init.indexOf("\n}\n", init.indexOf("async function ensureJobStatusHistory")));
  assert.match(stage, /CREATE TABLE IF NOT EXISTS job_status_history/);
  assert.doesNotMatch(stage, /INSERT|UPDATE|SELECT/, "the migration creates; it does not fill");
  assert.doesNotMatch(init, /INSERT INTO job_status_history/);
  const ui = await read("app/(app)/portal/status-history.tsx");
  assert.match(ui, /Recorded from \{sinceLabel\}\. Changes before then appear in the activity history below as they were logged at the time\./);
  const lib = await read("app/lib/job-status-history.ts");
  assert.match(lib, /export const STATUS_HISTORY_SINCE = "\d{4}-\d{2}-\d{2}";/);
});

test("status_changed_at is finally written, and a failed history write never fails the change", async () => {
  const lib = code(await read("app/lib/job-status-history.ts"));
  assert.match(lib, /set status_changed_at = \$\{stamp\}/);
  assert.match(lib, /catch \(error\) \{\s*console\.error\("\[job-status-history\]/);
});

/* ================================================================== */
/* The live half                                                        */
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

async function call(cookie, path, init = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { accept: "application/json", "content-type": "application/json", cookie, ...(init.headers ?? {}) },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

test("live: one job through four doors, every transition recorded", { skip: !serverUp }, async (t) => {
  const login = await fetch(`${BASE_URL}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(OWNER) });
  if (!login.ok) return t.skip("the seeded owner could not sign in");
  const cookie = (login.headers.getSetCookie?.() ?? []).map((v) => v.split(";")[0]).join("; ");

  const created = await call(cookie, "/api/board/items", {
    method: "POST",
    body: JSON.stringify({ board: "maintenance", title: `P23-QA history ${Date.now()}` }),
  });
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
  const id = created.body.request?.id ?? created.body.item?.requestId ?? created.body.id;
  assert.ok(id, JSON.stringify(created.body).slice(0, 200));

  const history = async () => (await call(cookie, `/api/maintenance?id=${encodeURIComponent(id)}`)).body;
  const first = await history();
  assert.ok(first.statusHistorySince, "the day the record begins is returned");
  assert.ok(first.statusHistory.some((e) => e.field === "stage" && e.from === null), "created: its first stage, with no 'from'");

  const moved = await call(cookie, "/api/maintenance", { method: "PATCH", body: JSON.stringify({ id, stage: "Booked" }) });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const second = await history();
  const stageMove = second.statusHistory.find((e) => e.field === "stage" && e.to === "Booked");
  assert.ok(stageMove, "the stage change is recorded");
  assert.equal(stageMove.source, "job.edit");
  assert.equal(stageMove.actorEmail, OWNER.email);
  assert.ok(stageMove.from && stageMove.from !== "Booked", "with where it came from");

  const withNote = await call(cookie, "/api/maintenance", { method: "PATCH", body: JSON.stringify({ id, stage: "Attention", note: "P23-QA note" }) });
  assert.equal(withNote.status, 200, JSON.stringify(withNote.body));
  const third = await history();
  assert.ok(
    third.statusHistory.some((e) => e.field === "stage" && e.from === "Booked" && e.to === "Attention"),
    "a stage change sent with a note is still a stage change",
  );

  const bulk = await call(cookie, "/api/board/items", { method: "PATCH", body: JSON.stringify({ board: "maintenance", itemIds: [id], status: "P23-QA status" }) });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
  const fourth = await history();
  const bulkMove = fourth.statusHistory.find((e) => e.field === "status" && e.to === "P23-QA status");
  assert.ok(bulkMove && bulkMove.source === "board.bulk", "the bulk edit is recorded under its own name");

  /* Newest first. */
  const times = fourth.statusHistory.map((e) => e.createdAt);
  assert.deepEqual([...times].sort().reverse(), times);
});
