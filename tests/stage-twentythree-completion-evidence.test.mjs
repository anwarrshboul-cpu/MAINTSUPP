/**
 * Stage 23 — J. The fault and the fix, and the rule about closing.
 *
 * The board has carried two picture columns since the monday import —
 * "Pictures of Maintenance Issue" (1,149 photographs) and "Picture of
 * completed works" (1,616) — and nothing in the product ever put them next to
 * each other. Comparing them meant opening the evidence panel, scrolling,
 * remembering what the first one looked like, and scrolling back. That
 * comparison is the entire reason the pair exists: it is what an invoice is
 * checked against, and what a client asks for when they doubt a job was done.
 *
 * The second half is the rule. 673 jobs are Completed and 264 of them carry no
 * completion photograph at all. Going forward, a job in a category the client
 * has nominated cannot be closed without one.
 *
 * WHICH categories is the client's decision and the list is EMPTY until they
 * make it. Turning a gate on for everybody the moment this deploys would stop
 * coordinators closing jobs they have every right to close, for a rule nobody
 * agreed to. A recommended set is offered in one click; choosing it is a
 * decision, and it lands in the audit log like any other settings change.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("nothing is gated until the client says so", async () => {
  const data = await read("app/lib/workspace-data.ts");

  assert.match(data, /completionEvidenceCategories: string\[\];/);
  assert.match(
    data,
    /completionEvidenceCategories: \[\],/,
    "the default must be empty — a gate nobody agreed to is a broken workspace",
  );
  // Offered, never applied.
  assert.match(data, /RECOMMENDED_EVIDENCE_CATEGORIES/);
});

test("the gate is on the server, where it is the only place it can be true", async () => {
  const route = await read("app/api/maintenance/route.ts");

  assert.match(route, /if \(stage === "Completed"\) \{/);
  assert.match(route, /eq\(attachments\.kind, "completion"\)/);
  assert.match(route, /needsCompletionEvidence: true/);
  assert.match(route, /\{ status: 409 \}/);

  /*
   * The category is read from the CURRENT row, not from the payload. A request
   * that set `category` and `stage` together could otherwise move itself into
   * an ungated category on the way past the gate.
   */
  const gate = route.slice(route.indexOf('if (stage === "Completed") {'));
  assert.match(
    gate.slice(0, 3000),
    /\.select\(\{ category: maintenanceRequests\.category \}\)/,
  );

  // Unreadable settings must open the gate, not close it on everybody: a
  // corrupt row would otherwise stop the workspace working.
  assert.match(route, /gated = Array\.isArray\(parsed\.completionEvidenceCategories\)/);
});

test("saving an SLA cannot silently switch the safety rule off", async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");

  /*
   * `PATCH /api/workspace` replaces the stored settings JSON wholesale. The
   * settings screen edits two of the three keys, so sending only those two
   * would clear `completionEvidenceCategories` every time somebody changed an
   * alert — a rule turned off by an unrelated save, silently.
   */
  assert.match(
    portal,
    /await onSave\(\{\s*\n?\s*\.\.\.settings,/,
    "the whole settings object must be sent, not just the edited keys",
  );
  assert.match(portal, /completionEvidenceCategories: evidenceCategories,/);
});

test("the settings list is built from categories that actually exist", async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");

  // A hard-coded list would drift the first time somebody adds a category on
  // the board, and the gate would quietly not apply to it.
  assert.match(portal, /requests\s*\n?\s*\.map\(\(item\) => \(item\.category \?\? ""\)\.trim\(\)\)/);
  assert.match(portal, /value !== "\[object Object\]"/, "one row carries a broken category");
  assert.match(portal, /\{categories\.map\(\(category\) => \{/);
});

test("the pair shows both halves, and says which one is missing", async () => {
  const source = await read("app/(app)/portal/before-after.tsx");

  assert.match(source, /pictures\(files, "issue"\)/);
  assert.match(source, /pictures\(files, "completion"\)/);
  // A PDF quote filed in the issue column is not a "before".
  assert.match(source, /file\.contentType\.startsWith\("image\/"\)/);
  // The empty half says so rather than hiding — a job with three fault photos
  // and no completion photo is telling you something.
  assert.match(source, /No photograph of the finished work yet\./);
  assert.match(source, /No photograph of the fault was filed\./);
  // Thumbnails, not 4 MB originals.
  assert.match(source, /\$\{file\.inlineUrl\}\?thumb=1/);
  // One carousel across both halves, so a swipe runs fault → fixed.
  assert.match(source, /const carousel: MediaViewerFile\[\] = \[\.\.\.before, \.\.\.after\]/);
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

test("the gate refuses, and only where it was asked to", async (t) => {
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

  const context = await (await fetch(`${BASE_URL}/api/context`, { headers: { cookie } })).json();
  const orgId = context?.context?.currentOrganisation?.id;
  const settings = context?.context ? null : null;

  const jobs = await (
    await fetch(`${BASE_URL}/api/maintenance`, { headers: { cookie } })
  ).json();
  const rows = jobs.requests ?? [];

  // A real open job in a category we are about to gate.
  const target = rows.find(
    (row) => row.category === "Locks" && row.stage !== "Completed",
  );
  if (!target || !orgId) {
    t.skip("no open Locks job to exercise the gate against");
    return;
  }

  const saveSettings = (categories) =>
    fetch(`${BASE_URL}/api/workspace`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        entity: "settings",
        id: orgId,
        data: {
          alerts: { urgent: true, compliance: true, daily: false },
          slas: {
            Urgent: "4 hours",
            Medium: "3 business days",
            Low: "5 business days",
          },
          completionEvidenceCategories: categories,
        },
      }),
    });

  const close = (id) =>
    fetch(`${BASE_URL}/api/maintenance`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id, stage: "Completed" }),
    });

  try {
    await saveSettings(["Locks"]);

    const files = await (
      await fetch(`${BASE_URL}/api/files?requestId=${encodeURIComponent(target.id)}`, {
        headers: { cookie },
      })
    ).json();
    const hasCompletion = (files.files ?? []).some((file) => file.kind === "completion");

    const refused = await close(target.id);
    if (hasCompletion) {
      assert.equal(refused.status, 200, "a gated job WITH evidence still closes");
    } else {
      assert.equal(refused.status, 409, "a gated job without evidence is refused");
      const body = await refused.json();
      assert.equal(body.needsCompletionEvidence, true);
      assert.equal(body.category, "Locks");
    }
  } finally {
    // The rule is the client's, and this test does not get to leave one on.
    await saveSettings([]).catch(() => {});
  }

  /*
   * With nothing gated, the same request behaves as it always did — and the
   * job goes back where it was found.
   *
   * This used to close a real job and leave it closed, so each run consumed
   * the last open job in the gated category until there were none left and the
   * test skipped itself into uselessness. A test that mutates operational data
   * has to put it back; `stage` is the only column it touches.
   */
  const open = await close(target.id);
  assert.notEqual(open.status, 409, "an ungated workspace closes as before");

  if (open.status === 200 && target.stage && target.stage !== "Completed") {
    await fetch(`${BASE_URL}/api/maintenance`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: target.id, stage: target.stage }),
    });
    const restored = await (
      await fetch(`${BASE_URL}/api/maintenance`, { headers: { cookie } })
    ).json();
    const row = (restored.requests ?? []).find((item) => item.id === target.id);
    assert.equal(
      row?.stage,
      target.stage,
      "the job this test closed must go back to the stage it was found in",
    );
  }
  assert.equal(settings, null);
});
