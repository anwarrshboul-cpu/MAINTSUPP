/**
 * Stage 23 — L. What an engineer needs before they arrive.
 *
 * The thing this replaces is a WhatsApp message: how do I get in, who do I ask
 * for, where do I park, when does the unit open, what happened last time. The
 * columns for all of it have existed on `sites` since the register was built —
 * `access_method`, `access_contact`, `access_notes`, `opening_hours`,
 * `parking_notes`, `key_alarm_notes`, `out_of_hours_contact` — and none of it
 * was ever served to the one person who needs it.
 *
 * TWO KINDS OF FIELD, and the difference is the whole design.
 *
 * Most are typed by a coordinator and are, today, empty on all 31 sites. The
 * pack says "Not recorded yet" in plain words rather than drawing a blank that
 * reads like the answer is "nothing" — recorded and unrecorded are different
 * states and must not look the same.
 *
 * "Previous access problems" is the other kind: nobody types it, it is counted
 * from the site's own job history, and it is the only part populated on day
 * one. A field nobody maintains is an empty field; 744 jobs already hold the
 * answer.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const ROUTE = "app/api/job-link/[token]/route.ts";
const PACK = "app/(public)/j/[token]/arrival-pack.tsx";

test("a contractor gets the arrival detail and nothing beyond it", async () => {
  const source = await read(ROUTE);

  for (const field of [
    "accessMethod",
    "accessContact",
    "accessNotes",
    "openingHours",
    "parkingNotes",
    "keyAlarmNotes",
    "outOfHoursContact",
    "managerPhone",
  ]) {
    assert.ok(source.includes(`sites.${field}`), `the pack must carry ${field}`);
  }

  /*
   * And deliberately NOT the commercial terms. A contractor has no business
   * with the lease, the rent review, the service charge or the site's budget,
   * and all four live one column away from the ones above.
   */
  const select = source.slice(
    source.indexOf("const [site] = job.siteId"),
    source.indexOf("const accessTrouble"),
  );
  for (const forbidden of [
    "leaseStart",
    "leaseEnd",
    "breakClause",
    "rentReview",
    "serviceChargePence",
    "annualBudgetPence",
  ]) {
    assert.ok(
      !select.includes(forbidden),
      `${forbidden} must never reach a public job link`,
    );
  }
});

test("past access problems are counted, not typed", async () => {
  const source = await read(ROUTE);

  assert.match(source, /const accessTrouble = job\.siteId/);
  // Scoped to this site and this tenant, and binned jobs excluded.
  assert.match(source, /eq\(maintenanceRequests\.siteId, job\.siteId\)/);
  assert.match(source, /isNull\(maintenanceRequests\.deletedAt\)/);
  // Read from what the job history already records.
  assert.match(source, /blockedReason.*LIKE '%access%'/s);
  assert.match(source, /completionNote.*LIKE '%no access%'/s);
  assert.match(source, /\.limit\(4\)/, "the four most recent, not a wall of history");
});

test("recorded and unrecorded do not look the same", async () => {
  const pack = await read(PACK);

  assert.match(pack, /value \|\| "Not recorded yet"/);
  assert.match(pack, /className=\{value \? "" : "is-missing"\}/);
  // The summary counts what is actually there rather than claiming a number.
  assert.match(pack, /\.filter\(\(value\) => value && value\.trim\(\)\)\.length/);
  assert.match(pack, /"Nothing recorded yet"/);
  // And says so plainly when the whole site is blank.
  assert.match(pack, /Nobody has filled in this site&rsquo;s access details yet\./);
});

test("the reader is holding a phone, standing outside", async () => {
  const pack = await read(PACK);
  const css = await read("app/(public)/j/[token]/job-link.css");

  // A number they can dial, and plain text when it is not a number.
  assert.match(pack, /href=\{`tel:\$\{digits\}`\}/);
  assert.match(pack, /digits\.length >= 7/);
  // A portal that swallows the job link would leave them no way back.
  assert.match(pack, /href=\{pack\.accessUrl\}\s*\n?\s*target="_blank"/);
  // Pressed with a glove on.
  assert.match(css, /\.arrival__toggle \{[\s\S]*?min-height: 56px;/);
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

test("the pack reaches a real job link", async (t) => {
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
  const job = (jobs.requests ?? []).find((row) => row.siteId);
  if (!job) {
    t.skip("no job with a site to read a pack for");
    return;
  }

  const link = await (
    await fetch(`${BASE_URL}/api/board/links`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ requestId: job.id }),
    })
  ).json();
  const token = String(link.url ?? "").split("/j/")[1];
  assert.ok(token, "a link must be issued");

  const payload = await (await fetch(`${BASE_URL}/api/job-link/${token}`)).json();
  const arrival = payload?.site?.arrival;
  assert.ok(arrival, "a job link carries its site's arrival pack");

  for (const key of [
    "accessMethod",
    "accessNotes",
    "openingHours",
    "parking",
    "keysAndAlarm",
    "managerPhone",
    "outOfHours",
    "pastAccessProblems",
  ]) {
    assert.ok(key in arrival, `the pack must carry ${key}`);
  }
  assert.ok(Array.isArray(arrival.pastAccessProblems));

  // Nothing commercial, ever.
  const serialised = JSON.stringify(payload);
  for (const forbidden of ["leaseEnd", "rentReview", "serviceCharge", "annualBudget"]) {
    assert.doesNotMatch(
      serialised,
      new RegExp(forbidden, "i"),
      `${forbidden} must not appear in a public job link payload`,
    );
  }
});
