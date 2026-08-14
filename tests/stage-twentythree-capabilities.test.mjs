/**
 * Stage 23 — every switch in the permission matrix decides something.
 *
 * The matrix has shown sixteen capabilities since it was built, each with a
 * sentence written for the administrator reading it. Four of them read nothing
 * anywhere in the product:
 *
 *   `board.view`   — "open the job, site and documentation boards". Revoking it
 *                    hid the sidebar entry and left `/api/board` and
 *                    `/api/maintenance` answering in full to anyone who typed
 *                    the URL.
 *   `data.export`  — "download boards, sites and reports as CSV". The site CSV
 *                    is the whole register in one file: names, addresses,
 *                    managers, access notes.
 *   `teams.manage` — creating, renaming and archiving teams, and moving people
 *                    between them, was open to every member of the workspace.
 *   `billing.manage` — there is no billing screen. This one cannot be enforced,
 *                    so it is labelled instead.
 *
 * A switch that decides nothing is worse than a missing switch: an
 * administrator turns it off and believes they have withdrawn an ability that
 * nobody ever had.
 *
 * This test is the thing that stops it happening again, and it is deliberately
 * two-sided: a capability marked `unenforced` that gains an enforcement site
 * fails here, and so does one that is NOT marked and has none. The flag cannot
 * rot in either direction.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

async function routeSources(dir = "app/api", found = []) {
  const entries = await readdir(new URL(`../${dir}`, import.meta.url), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await routeSources(path, found);
    else if (entry.name === "route.ts") found.push(await read(path));
  }
  return found;
}

/** The catalogue, read out of the source rather than imported (it is TS). */
async function catalogue() {
  const source = await read("app/lib/permissions.ts");
  const block = source.slice(
    source.indexOf("export const CAPABILITY_CATALOGUE = ["),
    source.indexOf("] as const satisfies readonly CapabilityDefinition[];"),
  );
  return [...block.matchAll(/key: "([a-z_.]+)",[\s\S]*?(?=\n  \{|$)/g)].map((match) => ({
    key: match[1],
    unenforced: /unenforced: true/.test(match[0]),
  }));
}

test("every capability is either enforced or labelled as not yet enforced", async () => {
  const capabilities = await catalogue();
  assert.ok(capabilities.length >= 16, "the catalogue was not parsed");

  const sources = await routeSources();
  const sites = (key) =>
    sources.filter((source) =>
      new RegExp(
        `(requireCapability\\([^)]*|scopedDbWithCapability\\(request, )"${key.replace(".", "\\.")}"`,
      ).test(source),
    ).length;

  const decorative = [];
  const mislabelled = [];
  for (const capability of capabilities) {
    const count = sites(capability.key);
    if (count === 0 && !capability.unenforced) decorative.push(capability.key);
    if (count > 0 && capability.unenforced) mislabelled.push(capability.key);
  }

  assert.deepEqual(
    decorative,
    [],
    `these appear in the matrix and decide nothing:\n  ${decorative.join("\n  ")}`,
  );
  assert.deepEqual(
    mislabelled,
    [],
    `these are marked "not enforced yet" but are enforced — remove the flag:\n  ${mislabelled.join("\n  ")}`,
  );
});

test("the reads that matter are gated, not just the writes", async () => {
  const board = await read("app/api/board/route.ts");
  const jobs = await read("app/api/maintenance/route.ts");
  const csv = await read("app/api/sites/csv/route.ts");

  // Hiding a sidebar entry is a courtesy. This is the boundary.
  assert.match(board, /scopedDbWithCapability\(request, "board\.view"\)/);
  assert.match(jobs, /scopedDbWithCapability\(request, "board\.view"\)/);
  assert.match(csv, /scopedDbWithCapability\(request, "data\.export"\)/);
});

test("the matrix shows which switch does nothing", async () => {
  const roles = await read("app/(app)/portal/views/admin-roles.tsx");
  assert.match(roles, /capability\.unenforced \? \(/);
  assert.match(roles, /Not enforced yet/);
});

/* ------------------------------------------------------------------ */
/* Live                                                                */
/* ------------------------------------------------------------------ */

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE_URL}/api/context`, {
      signal: AbortSignal.timeout(4_000),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

test("withdrawing board.view actually closes the board", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const login = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com",
      password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026",
    }),
  });
  if (!login.ok) {
    t.skip("the seeded owner could not sign in");
    return;
  }
  const cookie = (login.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(";")[0])
    .join("; ");

  const asClient = (path) =>
    fetch(`${BASE_URL}${path}`, {
      headers: { "x-maintsupp-identity": "sample-client@maintsupp.local" },
    });

  // A client holds `board.view` by default, so the board is open to them.
  assert.equal((await asClient("/api/board")).status, 200);

  const setBoardView = (allowed) =>
    fetch(`${BASE_URL}/api/admin/roles`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        changes: [{ role: "client", capability: "board.view", allowed }],
      }),
    });

  const withdrawn = await setBoardView(false);
  assert.equal(withdrawn.status, 200, "the owner may withdraw it");

  try {
    const closed = await asClient("/api/board");
    assert.equal(closed.status, 403, "and the board is then closed");
    const body = await closed.json();
    assert.equal(body.capability, "board.view");
    assert.equal(body.denied, true);

    const jobs = await asClient("/api/maintenance");
    assert.equal(jobs.status, 403, "the job list is the board");
  } finally {
    // Put the matrix back however this ends. A left-behind override is a
    // client who cannot see their own board tomorrow morning.
    await setBoardView(null).catch(() => {});
  }

  assert.equal(
    (await asClient("/api/board")).status,
    200,
    "and restoring the default reopens it",
  );
});
