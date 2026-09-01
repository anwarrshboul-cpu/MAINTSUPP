/**
 * The last three official W7 criteria: W07-06, W07-09 and W07-11.
 *
 * All three were PARTIAL for related reasons, and the shape of each is worth
 * stating because it is the shape the assertions guard.
 *
 * W07-06 — the UI confirmed a permanent delete and the API did not care. A role
 * holding `board.edit` could destroy a document and every earlier version of
 * it, while `/api/trash` had required `data.delete` for a permanent purge all
 * along and documents that `data.delete` is deliberately withheld from `admin`.
 * Worse, deleting the head of a lineage destroyed ONLY the head: the superseded
 * rows survived with `is_current = 0`, which no surface reads, so their bytes
 * and metadata were orphaned where nothing could ever list them again — while
 * the confirm dialog promised "its N versions go with it".
 *
 * W07-09 and W07-11 were one defect wearing two labels. The register asked for
 * `/api/files?limit=100`, and `/api/files` clamps `limit` to 100, so it held at
 * most a hundred documents however many existed. Every figure derived from that
 * array — the tiles, the "showing" sentence, the CSV — was `min(real, 100)`
 * while looking like a count, and the search and the five filters ran over the
 * same truncated array, so "across all documents" was not true either. The
 * endpoint has carried `page`, `offset` and a COUNTed `total` since W7; the
 * caller simply never adopted them.
 *
 * Source assertions for the decisions, then the real thing against a running
 * dev server, skipped cleanly when nothing answers.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER_EMAIL = "owner@maintsupp.com";
const OWNER_PASSWORD = process.env.MAINTSUPP_OWNER_PASSWORD ?? "Sunnamusk-Owner-2026";
const RESERVED = new Set(["MN-1049"]);
const PAGE_SIZE = 25;

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const codeOnly = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ------------------------------------------------------------------ */
/* W07-06 — source                                                     */
/* ------------------------------------------------------------------ */

test("W07-06 permanent delete requires data.delete, the platform's own purge permission", async () => {
  const route = codeOnly(await source("app/api/files/[id]/route.ts"));
  /*
   * Bounded to the DELETE handler alone. Sliced to end-of-file it swallowed
   * PUT, which writes a WebP thumbnail and legitimately requires board.edit —
   * so the assertion below would have been reading the wrong handler.
   */
  const fromDelete = route.slice(route.indexOf("export async function DELETE"));
  const nextExport = fromDelete.indexOf("export async function", 1);
  const del = nextExport === -1 ? fromDelete : fromDelete.slice(0, nextExport);
  assert.match(
    del,
    /scopedDbWithCapability\(request, "data\.delete"\)/,
    "destroying a document and its history is a purge, not an edit",
  );
  assert.doesNotMatch(
    del,
    /scopedDbWithCapability\(request, "board\.edit"\)/,
    "board.edit must not be able to permanently destroy file bytes",
  );
  // The precedent this follows, so the two cannot drift apart.
  const trash = codeOnly(await source("app/api/trash/route.ts"));
  assert.match(
    trash,
    /scopedDbWithCapability\(request, "data\.delete"\)/,
    "the trash purge is the model; if it changes, this rule should be revisited with it",
  );
});

test("W07-06 a refusal offers the non-destructive route instead of just saying no", async () => {
  const route = await source("app/api/files/[id]/route.ts");
  assert.match(
    route,
    /archiveInstead/,
    "a role that cannot purge can still archive, and the refusal should say so",
  );
  assert.match(
    route,
    /Archive it instead to take it off the register without losing it/,
    "the message names the alternative rather than only the missing permission",
  );
});

test("W07-06 deleting the head takes the lineage, not just the current row", async () => {
  const route = codeOnly(await source("app/api/files/[id]/route.ts"));
  /*
   * Bounded to the DELETE handler alone. Sliced to end-of-file it swallowed
   * PUT, which writes a WebP thumbnail and legitimately requires board.edit —
   * so the assertion below would have been reading the wrong handler.
   */
  const fromDelete = route.slice(route.indexOf("export async function DELETE"));
  const nextExport = fromDelete.indexOf("export async function", 1);
  const del = nextExport === -1 ? fromDelete : fromDelete.slice(0, nextExport);
  assert.match(
    del,
    /rootDocumentId/,
    "the lineage is what is being destroyed, so the lineage is what must be selected",
  );
  assert.match(
    del,
    /releaseComplianceLinks/,
    "a compliance record must not be left pointing at bytes that no longer exist",
  );
  assert.match(
    del,
    /\.thumb/,
    "every version's derivative goes too, or R2 keeps orphans nothing can reach",
  );
});

/* ------------------------------------------------------------------ */
/* W07-09 / W07-11 — source                                            */
/* ------------------------------------------------------------------ */

test("W07-09 the register reads every page, not the first hundred", async () => {
  const portal = codeOnly(await source("app/(app)/portal/portal-app.tsx"));
  assert.doesNotMatch(
    portal,
    /\/api\/files\?limit=100&archived=all/,
    "the bare hundred-row fetch is the defect: it made every total min(real, 100)",
  );
  assert.match(
    portal,
    /DOCUMENT_WALK_MAX_PAGES/,
    "the walk is bounded...",
  );
  assert.match(
    portal,
    /setDocumentsTruncated/,
    "...and the bound is reported, because a total that is quietly short is the same lie",
  );
});

test("W07-11 the page is explicit, and the total is the matching set", async () => {
  const portal = codeOnly(await source("app/(app)/portal/portal-app.tsx"));
  assert.match(portal, /DOCUMENT_PAGE_SIZE/, "an explicit page size, not a default");
  assert.match(portal, /documentPageRange\(/, "one derivation for page, pageCount and range");
  assert.match(
    portal,
    /const pageRows = filtered\.slice\(/,
    "the table renders a page OF the matching set",
  );
  // The tiles and the export must keep reading the whole matching set.
  assert.match(
    portal,
    /downloadFileRegister\(filtered, today\)/,
    "the CSV exports every matching row, not the page on screen",
  );
});

test("W07-11 a new question starts at its first page", async () => {
  const portal = codeOnly(await source("app/(app)/portal/portal-app.tsx"));
  assert.match(portal, /questionRef/, "changing search or a filter must not strand a reader");
  assert.match(portal, /setPage\(1\)/);
  const register = await source("app/(app)/portal/views/document-register.ts");
  assert.match(
    register,
    /Math\.min\(Math\.max\(Math\.floor\(input\.page\), 1\), pageCount\)/,
    "and the page is clamped as well, so even a stale number cannot land out of range",
  );
});

/* ------------------------------------------------------------------ */
/* Live                                                                */
/* ------------------------------------------------------------------ */

let serverUp = null;
async function serverIsUp() {
  if (serverUp !== null) return serverUp;
  try {
    // Any reply means up, including a 5xx: a busy local D1 is not an absent
    // server, and treating it as one silently skips every assertion below.
    await fetch(`${BASE_URL}/api/board?compact=1`, { signal: AbortSignal.timeout(30000) });
    serverUp = true;
  } catch {
    serverUp = false;
  }
  return serverUp;
}
async function signIn() {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
  });
  const cookie = (response.headers.getSetCookie?.() ?? []).find((value) =>
    value.startsWith("maintsupp_session="),
  );
  return cookie ? cookie.split(";")[0] : null;
}

test("live: W07-11 a match that exists only beyond page one is still found", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signIn();
  if (!session) {
    t.skip("could not sign in as the seeded owner");
    return;
  }
  const H = { Cookie: session };
  const workspace = await (await fetch(`${BASE_URL}/api/workspace`, { headers: H })).json();
  const contractor = (workspace.workspace?.contractors ?? [])[0];
  if (!contractor) {
    t.skip("no contractor to anchor a document to");
    return;
  }

  const tag = `ZW711${Date.now()}`;
  const made = [];
  const upload = async (name, title, extra = {}) => {
    const form = new FormData();
    form.set("file", new File(["x"], `${name}.txt`, { type: "text/plain" }));
    form.set("kind", "general");
    form.set("contractorId", contractor.id);
    form.set("title", title);
    for (const [k, v] of Object.entries(extra)) form.set(k, v);
    const r = await fetch(`${BASE_URL}/api/files`, { method: "POST", body: form, headers: H });
    const b = await r.json().catch(() => ({}));
    if (b.file?.id) made.push(b.file.id);
    assert.ok(!RESERVED.has(b.file?.requestId ?? ""), "must never touch a reserved job");
    return b.file;
  };

  try {
    // The target goes in FIRST so the newest-first order pushes it off page one,
    // and carries a word and a type nothing else in the estate uses.
    const target = await upload(`${tag}-target`, `${tag} needle`, { documentType: `${tag}TYPE` });
    for (let i = 0; i < PAGE_SIZE + 2; i += 1) {
      await upload(`${tag}-decoy-${i}`, `${tag} decoy ${i}`);
    }

    const list = async (qs) =>
      (await (await fetch(`${BASE_URL}/api/files?${qs}`, { headers: H })).json()) ?? {};

    const first = await list(`limit=${PAGE_SIZE}&page=1&archived=all`);
    assert.ok(
      !(first.files ?? []).some((f) => f.id === target.id),
      "the fixture is wrong if the target is on page one — nothing would be proved",
    );

    const searched = await list(
      `limit=${PAGE_SIZE}&page=1&q=${encodeURIComponent(`${tag} needle`)}&archived=all`,
    );
    assert.ok(
      (searched.files ?? []).some((f) => f.id === target.id),
      "a search from page one must reach a document that is not on page one",
    );
    assert.equal(Number(searched.total), 1, "the total is the matching count, not the page length");

    const byType = await list(
      `limit=${PAGE_SIZE}&page=1&documentType=${encodeURIComponent(`${tag}TYPE`)}&archived=all`,
    );
    assert.ok(
      (byType.files ?? []).some((f) => f.id === target.id),
      "a structured filter must reach beyond page one too",
    );
    assert.equal(Number(byType.total), 1);

    // Another tenant must not see any of it.
    const foreign = await (
      await fetch(`${BASE_URL}/api/files?limit=100&archived=all`, {
        headers: { "x-maintsupp-identity": "admin@demo-client-ltd.test.maintsupp.com" },
      })
    ).json();
    assert.ok(
      !(foreign.files ?? []).some((f) => (f.originalName ?? "").includes(tag)),
      "no cross-org row may appear in another tenant's register",
    );
  } finally {
    /*
     * Swept by LISTING, not only by the ids we remember, and retried.
     *
     * A single pass over `made` failed on a busy local D1: three deletes came
     * back non-200 and the run then reported residue, which is a true statement
     * about the database and a false one about the code. Re-reading the
     * register and deleting whatever still carries the tag also catches a row
     * this test did not create the id for — a lineage head takes its
     * predecessors with it, so the id list and the surviving rows are not the
     * same set.
     */
    const remaining = async () => {
      const page = await (
        await fetch(`${BASE_URL}/api/files?limit=100&archived=all`, { headers: H })
      ).json();
      return (page.files ?? []).filter((row) => (row.originalName ?? "").includes(tag));
    };
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const stragglers = attempt === 0 ? made.map((id) => ({ id })) : await remaining();
      if (!stragglers.length) break;
      for (const row of stragglers) {
        await fetch(`${BASE_URL}/api/files/${row.id}`, { method: "DELETE", headers: H });
      }
    }
    assert.equal((await remaining()).length, 0, "QA residue must be zero");
  }
});

test("live: W07-09 creating and removing a document moves the total by one", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signIn();
  if (!session) {
    t.skip("could not sign in as the seeded owner");
    return;
  }
  const H = { Cookie: session };
  const workspace = await (await fetch(`${BASE_URL}/api/workspace`, { headers: H })).json();
  const contractor = (workspace.workspace?.contractors ?? [])[0];
  if (!contractor) {
    t.skip("no contractor to anchor a document to");
    return;
  }
  const total = async () =>
    Number(
      (await (await fetch(`${BASE_URL}/api/files?limit=1&page=1`, { headers: H })).json())
        .total ?? 0,
    );

  const before = await total();
  const form = new FormData();
  const tag = `ZW709${Date.now()}`;
  form.set("file", new File(["x"], `${tag}.txt`, { type: "text/plain" }));
  form.set("kind", "general");
  form.set("contractorId", contractor.id);
  form.set("title", `${tag} delta`);
  const created = await (
    await fetch(`${BASE_URL}/api/files`, { method: "POST", body: form, headers: H })
  ).json();
  assert.ok(created.file?.id, "upload failed");

  try {
    assert.equal(await total(), before + 1, "a new document is one more document");
    await fetch(`${BASE_URL}/api/files/${created.file.id}`, {
      method: "PATCH",
      headers: { ...H, "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    assert.equal(
      await total(),
      before,
      "archiving takes it out of the live register, so the live total returns",
    );
    await fetch(`${BASE_URL}/api/files/${created.file.id}`, {
      method: "PATCH",
      headers: { ...H, "content-type": "application/json" },
      body: JSON.stringify({ archived: false }),
    });
    assert.equal(await total(), before + 1, "restoring puts it back");
  } finally {
    await fetch(`${BASE_URL}/api/files/${created.file.id}`, { method: "DELETE", headers: H });
    assert.equal(await total(), before, "and a permanent delete reconciles to where we started");
  }
});
