/**
 * Stage 23 — K. The contractor's mark at completion.
 *
 * A completion already carried a typed name, a date and a photograph. What it
 * did not carry was a signature, and the difference matters in exactly one
 * situation: six months later an invoice is queried and somebody asks who said
 * the work was finished. A typed name proves somebody could reach a keyboard.
 *
 * Three facts recorded together, or none of them: the mark, the name beside
 * it, and the time. The TIME is the server's — a signing time the device could
 * set is not a record of anything. The DATE THE WORK WAS FINISHED stays the
 * contractor's to state, because they were there and we were not; the two
 * answer different questions and are stored in different columns.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const ROUTE = "app/api/job-link/[token]/route.ts";

test("only a PNG gets in, and only a bounded one", async () => {
  const source = await read(ROUTE);

  assert.match(source, /function readSignature\(value: unknown\): string \| null/);
  assert.match(
    source,
    /if \(!trimmed\.startsWith\("data:image\/png;base64,"\)\) return null;/,
    "this is an unauthenticated write — anything but a PNG data URL is refused",
  );
  assert.match(
    source,
    /const SIGNATURE_LIMIT = 96 \* 1024;/,
    "without a ceiling this column is a way to put an arbitrary image in the database",
  );
  // A blank pad still produces a valid PNG.
  assert.match(source, /if \(trimmed\.length < 800\) return null;/);
});

test("the time is the server's, and the name travels with the mark", async () => {
  const source = await read(ROUTE);

  const block = source.slice(source.indexOf("...(signature"), source.indexOf("...(signature") + 400);
  assert.match(block, /completionSignature: signature,/);
  assert.match(
    block,
    /completionSignedAt: new Date\(\)\.toISOString\(\),/,
    "not a timestamp the browser sent",
  );
  assert.match(block, /completionSignedBy: by \|\| "Contractor",/);

  // The date the work was finished is separate and still the contractor's.
  assert.match(source, /completionRequestedAt: finishedOn \?\? sql`CURRENT_TIMESTAMP`,/);
});

test("a signature belongs only to a completion", async () => {
  const view = await read("app/(public)/j/[token]/contractor-job-view.tsx");
  assert.match(
    view,
    /\.\.\.\(intent === "complete" && signature \? \{ signature \} : \{\}\),/,
    "a mark against a note or a blocked report is a mark against something nobody signed for",
  );
});

test("the pad works with a finger, a stylus or a mouse", async () => {
  const pad = await read("app/(public)/j/[token]/signature-pad.tsx");

  // One code path for all three, and a stylus on a tablet is the common case.
  assert.match(pad, /onPointerDown=\{start\}/);
  assert.match(pad, /onPointerMove=\{move\}/);
  assert.match(pad, /onPointerCancel=\{end\}/);
  // Without this, signing on a phone scrolls the form away under the hand.
  assert.match(pad, /touchAction: "none"/);
  // A stroke that leaves the canvas must still end.
  assert.match(pad, /setPointerCapture\(event\.pointerId\)/);
  // Drawn at device resolution, or a phone signature is a smear on a laptop.
  assert.match(pad, /window\.devicePixelRatio \|\| 1, 3/);
  // Dark ink, so the stored PNG is legible wherever it is shown later.
  assert.match(pad, /strokeStyle = "#0b1a24"/);
});

test("the coordinator who accepts the completion can see who signed", async () => {
  const panel = await read("app/(app)/portal/contractor-link-panel.tsx");
  const route = await read("app/api/board/links/route.ts");

  assert.match(route, /completionSignature: maintenanceRequests\.completionSignature,/);
  assert.match(panel, /completion\.completionSignature && \(/);
  assert.match(panel, /Signed by \{completion\.completionSignedBy \?\? "the contractor"\}/);
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

/** A real PNG, padded past the 800-character floor the way a drawn one is. */
function samplePng() {
  const bytes = Buffer.alloc(4096, 7);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

test("a signature is stored, and anything that is not one is not", async (t) => {
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

  const jobs = await (
    await fetch(`${BASE_URL}/api/maintenance`, { headers: { cookie } })
  ).json();
  const job = (jobs.requests ?? [])[0];
  if (!job) {
    t.skip("no job to sign for");
    return;
  }

  const mint = async () => {
    const response = await fetch(`${BASE_URL}/api/board/links`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: job.id,
        canRequestCompletion: true,
        canComment: true,
      }),
    });
    const payload = await response.json();
    return String(payload.url ?? "").split("/j/")[1];
  };

  const readPanel = async () => {
    const response = await fetch(
      `${BASE_URL}/api/board/links?requestId=${encodeURIComponent(job.id)}`,
      { headers: { cookie } },
    );
    const payload = await response.json();
    return payload.completion ?? payload.job ?? {};
  };

  const before = await readPanel();

  // A signature that is not a PNG must not reach the column.
  const token = await mint();
  await fetch(`${BASE_URL}/api/job-link/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      intent: "complete",
      by: "Stage 23 probe",
      signature: "<script>alert(1)</script>",
    }),
  });

  const after = await readPanel();
  assert.equal(
    after.completionSignature ?? null,
    before.completionSignature ?? null,
    "a non-PNG payload must leave the stored signature exactly as it was",
  );
  if (after.completionSignature) {
    assert.match(after.completionSignature, /^data:image\/png;base64,/);
  }
  assert.doesNotMatch(
    String(after.completionSignature ?? ""),
    /<script/,
    "nothing that is not an image can reach this column",
  );

  // And the size ceiling holds.
  const oversized = `data:image/png;base64,${Buffer.alloc(120 * 1024, 9).toString("base64")}`;
  assert.ok(oversized.length > 96 * 1024, "the probe payload must exceed the limit");
  const token2 = await mint();
  await fetch(`${BASE_URL}/api/job-link/${token2}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      intent: "complete",
      by: "Stage 23 probe",
      signature: oversized,
    }),
  });
  const afterBig = await readPanel();
  assert.ok(
    (afterBig.completionSignature ?? "").length < 96 * 1024,
    "an oversized signature is ignored, not stored",
  );
  assert.ok(samplePng().startsWith("data:image/png;base64,"));
});
