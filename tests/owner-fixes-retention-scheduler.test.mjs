/**
 * W2-A — THE THIRTY-DAY RETENTION SWEEP, ON A TIMER.
 *
 * The bin has always expired entries after thirty days and has always had a
 * purge that honours it. What it never had was anything to RUN that purge
 * unattended: `maybeSweepRecycleBin` fires on roughly one call in ten to
 * /api/trash, so the honest description of the old behaviour was "the bin
 * empties when somebody opens it" — which for a workspace nobody visits means
 * never.
 *
 * WHAT THESE TESTS ARE ACTUALLY GUARDING.
 *
 * Not "does a cron exist". Three things that would each be quietly destructive:
 *
 *   1. The scheduler must reuse the ONE purge path. A second implementation of
 *      "destroy this for good" would drift from the first, and the things it
 *      would drift on are section bundles, R2 objects and the restore contract.
 *   2. It must FAIL CLOSED. A destructive endpoint whose auth degrades to "open"
 *      when a variable is missing is worse than no endpoint at all.
 *   3. The boundary must be the boundary. 29 days survives, 30 is due, and a
 *      restored entry is not merely skipped — it is gone from the bin, so there
 *      is nothing left to purge.
 *
 * WHY THE ARITHMETIC IS RE-DERIVED RATHER THAN IMPORTED.
 *
 * `app/lib/recycle-bin.ts` reaches `../../db`, a directory import that Node's
 * resolver rejects outside the bundler, so this suite cannot call `expiryFrom`
 * directly — the same reason every existing retention test in this repo
 * (stage-twentythree-trash, w2-section-recycle) pins it from source. So the
 * formula is pinned here AND exercised: the boundary test below re-derives the
 * expiry with the pinned formula and applies the pinned comparison, which means
 * a change to either goes red rather than silently passing.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const read = async (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

const BIN = "app/lib/recycle-bin.ts";
const CRON = "app/api/cron/retention/route.ts";
const BUILD = "vercel/build-output.mjs";
const BASE = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";

/* ── 1. The boundary ──────────────────────────────────────────────────────── */

test("the retention formula is still thirty days, derived in one place", async () => {
  const bin = await read(BIN);
  assert.match(bin, /export const RETENTION_DAYS = 30;/);
  assert.match(
    bin,
    /export function expiryFrom\(deletedAt: string\) \{\s*\n\s*return new Date\(new Date\(deletedAt\)\.getTime\(\) \+ RETENTION_DAYS \* DAY_MS\)\.toISOString\(\);/,
    "expiry must stay derived from RETENTION_DAYS rather than written twice",
  );
});

test("29 days survives, 30 days is due — at the exact comparison the sweep makes", async () => {
  const bin = await read(BIN);

  /*
   * The sweep's own predicate, pinned so this test cannot pass while the real
   * one changes: `lte(recycleBin.expiresAt, nowIso())`.
   */
  const sweep = bin.slice(bin.indexOf("export async function sweepRecycleBin"));
  assert.match(
    sweep,
    /where\(lte\(recycleBin\.expiresAt, nowIso\(\)\)\)/,
    "the sweep must select rows whose expiry has passed",
  );

  const DAY_MS = 24 * 60 * 60 * 1000;
  const RETENTION_DAYS = 30;
  // The pinned formula, re-derived.
  const expiryFrom = (deletedAt) =>
    new Date(new Date(deletedAt).getTime() + RETENTION_DAYS * DAY_MS).toISOString();

  const now = new Date("2026-09-04T11:00:00.000Z");
  const nowIso = now.toISOString();
  const deletedDaysAgo = (days) =>
    new Date(now.getTime() - days * DAY_MS).toISOString();

  // The comparison is a STRING comparison on ISO-8601 UTC, which is why it is
  // safe: fixed-width, zero-padded, always 'Z', so lexicographic order is
  // chronological order. A local-time or non-padded format would break it.
  const isDue = (deletedAt) => expiryFrom(deletedAt) <= nowIso;

  assert.equal(isDue(deletedDaysAgo(29)), false, "a 29-day-old entry must remain");
  assert.equal(isDue(deletedDaysAgo(30)), true, "a 30-day-old entry must be due");
  assert.equal(isDue(deletedDaysAgo(31)), true, "and anything older still");
  // The exact edge: due the instant it turns thirty days old, not a day later.
  assert.equal(
    isDue(new Date(now.getTime() - 30 * DAY_MS).toISOString()),
    true,
    "the boundary is inclusive — lte, not lt",
  );
  assert.equal(
    isDue(new Date(now.getTime() - 30 * DAY_MS + 1000).toISOString()),
    false,
    "one second short of thirty days is not yet due",
  );
});

test("retention is timezone-safe: every stamp it compares is ISO UTC", async () => {
  const bin = await read(BIN);
  assert.match(
    bin,
    /export function nowIso\(\) \{\s*\n\s*return new Date\(\)\.toISOString\(\);/,
    "the sweep's clock must be UTC ISO",
  );
  /*
   * `toISOString` is always UTC with a 'Z'. A `toLocaleString`, a `getFullYear`
   * assembly or a `slice` of a local stamp would put the boundary on the
   * server's timezone, so an entry would expire at a different real instant in
   * London and in the deployment region.
   */
  const sweep = bin.slice(bin.indexOf("export async function sweepRecycleBin"));
  for (const forbidden of ["toLocaleString", "toLocaleDateString", "getTimezoneOffset"]) {
    assert.ok(
      !sweep.includes(forbidden),
      `the sweep must not consult local time (${forbidden})`,
    );
  }
});

test("a restored entry cannot be purged, because its bin row is gone", async () => {
  const bin = await read(BIN);
  const restore = bin.slice(
    bin.indexOf("export async function restoreFromBin"),
    bin.indexOf("export async function", bin.indexOf("export async function restoreFromBin") + 10),
  );
  assert.ok(restore.length > 0, "restoreFromBin must exist");
  assert.match(
    restore,
    /db\.delete\(recycleBin\)\.where\(eq\(recycleBin\.id, entry\.id\)\)/,
    "restore must remove the bin entry",
  );
  /*
   * This is the whole of the "a restored section must no longer purge"
   * requirement, and it is structural rather than a flag the sweep has to
   * remember to check: the sweep's only source of work is `recycle_bin`, so an
   * entry that is not there cannot be selected, whatever its old expiry was.
   */
  const sweep = bin.slice(bin.indexOf("export async function sweepRecycleBin"));
  assert.match(sweep, /\.from\(recycleBin\)/);
  assert.ok(
    !/maintenance_requests|from\(maintenanceRequests\)/.test(sweep),
    "the sweep must find its work in the bin, never by scanning the entities",
  );
});

/* ── 2. One purge path ────────────────────────────────────────────────────── */

test("the scheduler reuses the canonical sweep and purge, and implements neither", async () => {
  const cron = await read(CRON);

  assert.match(cron, /import \{[\s\S]*?sweepRecycleBin,[\s\S]*?\} from "\.\.\/\.\.\/\.\.\/lib\/recycle-bin"/);
  assert.match(cron, /import \{ purgeFor \} from "\.\.\/\.\.\/trash\/route"/);
  assert.match(cron, /sweepRecycleBin\(db, purge\)/);

  /*
   * The failure this prevents is not hypothetical: section bundles, R2 object
   * deletion and the "leave the bin row if the purge declined" rule all live in
   * that one path. A scheduler that deleted rows itself would look correct in
   * review and lose files.
   */
  for (const forbidden of [
    "delete(recycleBin)",
    "delete(maintenanceRequests)",
    "DELETE FROM",
  ]) {
    assert.ok(
      !cron.includes(forbidden),
      `the scheduler must not destroy anything itself (${forbidden})`,
    );
  }
});

test("the sweep is bounded, and says so rather than looping until empty", async () => {
  const cron = await read(CRON);
  assert.match(cron, /MAX_PASSES = \d+/, "the scheduler must cap its passes");
  assert.match(
    cron,
    /more: !drained/,
    "it must report whether work remains rather than implying it finished",
  );
});

/* ── 3. It fails closed ───────────────────────────────────────────────────── */

test("a missing CRON_SECRET disables the endpoint instead of opening it", async () => {
  const cron = await read(CRON);
  const authorise = cron.slice(cron.indexOf("function authorise"));
  assert.match(
    authorise,
    /if \(!expected\) \{/,
    "an unset secret must be handled explicitly",
  );
  assert.match(authorise, /status: 503/, "and must refuse");
  /*
   * The ordering matters as much as the check. If the secret were compared
   * before the "is it configured" branch, an empty expected value would match
   * an empty provided one and the endpoint would be open to a bare request.
   */
  assert.ok(
    authorise.indexOf("if (!expected)") < authorise.indexOf("secretMatches"),
    "the unset check must come before the comparison",
  );
});

test("the secret comparison is constant-time and folds in the length", async () => {
  const cron = await read(CRON);
  const fn = cron.slice(
    cron.indexOf("function secretMatches"),
    cron.indexOf("function authorise"),
  );
  assert.ok(fn.length > 0, "secretMatches must exist");
  assert.match(
    fn,
    /let difference = provided\.length \^ expected\.length;/,
    "a length mismatch must be folded in, not returned on",
  );
  assert.ok(
    !/return false/.test(fn),
    "no early exit — that is what leaks the matching prefix",
  );
  assert.match(fn, /return difference === 0;/);

  /*
   * Behavioural check of the same function, re-derived. Out-of-range
   * charCodeAt returns NaN and `NaN ^ x === x`, which would have made a short
   * candidate match a long secret; the implementation substitutes 0.
   */
  const secretMatches = (provided, expected) => {
    let difference = provided.length ^ expected.length;
    const length = Math.max(provided.length, expected.length);
    for (let index = 0; index < length; index += 1) {
      const left = index < provided.length ? provided.charCodeAt(index) : 0;
      const right = index < expected.length ? expected.charCodeAt(index) : 0;
      difference |= left ^ right;
    }
    return difference === 0;
  };
  assert.equal(secretMatches("s3cret", "s3cret"), true);
  assert.equal(secretMatches("s3cre", "s3cret"), false, "a prefix must not match");
  assert.equal(secretMatches("s3cretX", "s3cret"), false);
  assert.equal(secretMatches("", "s3cret"), false, "nor must an empty candidate");
  assert.equal(secretMatches("S3cret", "s3cret"), false, "case matters");
});

/* ── 4. What it does NOT claim ────────────────────────────────────────────── */

test("the cron is declared, and documented as Production-only", async () => {
  const build = await read(BUILD);
  assert.match(
    build,
    /crons: \[\{ path: "\/api\/cron\/retention", schedule: "[^"]+" \}\]/,
    "the schedule must be in the prebuilt output config",
  );
  /*
   * The honesty requirement, pinned. Vercel runs crons against PRODUCTION
   * deployments only, and the portal ships to Preview — so declaring this does
   * not make it fire on the Preview the owner reviews. Anyone reading the file
   * must be told that before they trust it.
   */
  assert.match(build, /PRODUCTION deployments only/i);
  assert.match(build, /CRON_SECRET/);

  /*
   * Comment prose wraps, so the block is flattened before matching — a pin that
   * depends on where a line happens to break is a pin that goes red on a
   * reflow and teaches people to delete it.
   */
  const trash = (await read("app/api/trash/route.ts"))
    .replace(/^\s*\*\s?/gm, "")
    .replace(/\s+/g, " ");
  assert.match(
    trash,
    /opportunistic sweep above remains the only thing actually emptying the bin/,
    "the opportunistic sweep must be documented as still load-bearing until Production",
  );
  assert.match(
    trash,
    /only FIRES on a Production deployment/,
    "and the route must say when the scheduler actually runs",
  );
});

/* ── 5. Live, if a dev server is answering ────────────────────────────────── */

test("live: the endpoint refuses when the deployment has no secret", async (t) => {
  let response;
  try {
    response = await fetch(`${BASE}/api/cron/retention`, { method: "POST" });
  } catch {
    t.skip(`no dev server on ${BASE}`);
    return;
  }
  /*
   * 503 on this dev box, where CRON_SECRET is unset. If someone runs the suite
   * against a deployment that HAS the variable, an unauthenticated call must
   * still be refused — 401 — and must never be 200.
   */
  assert.ok(
    [401, 503].includes(response.status),
    `an unauthenticated sweep must be refused, got ${response.status}`,
  );
  const body = await response.json();
  assert.ok(!body.ok, "and must not report a successful sweep");
  assert.equal(body.swept, undefined, "nor how much it purged");
});
