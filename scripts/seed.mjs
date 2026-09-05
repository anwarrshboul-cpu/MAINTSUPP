/**
 * The five commands Module 3 §5 names, as one entry point.
 *
 *   npm run seed                      wipe + seed + write seed/expected-values.json
 *   npm run seed:purge                delete every row where is_seed = 1
 *   npm run seed:verify               reconcile, print the table, exit 1 on a mismatch
 *   npm run seed:cron                 run the reminder cron once against seeded data
 *   npm run seed:travel -- --days=+30 rebuild the estate as it would be in 30 days
 *
 * ── WHY THIS DRIVES THE HTTP API AND DOES NOT OPEN THE DATABASE ───────────
 *
 * `scripts/clean-test-accounts.mjs` opens the Miniflare sqlite file directly,
 * and that is right for what it does — a one-off tidy-up with no application
 * logic in it. This is the opposite case. The seed run has to build reminders
 * through `cascadeFromDefaults`, classify jobs through `job_status_map`, and
 * reconcile through the product's own queries; a script that opened the file
 * would need a second copy of all of it, and the second copy is exactly what
 * §4 says makes a harness worthless.
 *
 * Driving the running server also means the numbers are produced by THE CODE
 * THAT SERVES THE PRODUCT, on the database that deployment is actually pointed
 * at — Miniflare's SQLite locally, Supabase Postgres deployed — with no branch
 * anywhere for which one it is.
 *
 * ── THE GUARDS ARE NOT HERE ──────────────────────────────────────────────
 *
 * This file checks nothing. `EMAIL_MODE` and the two production checks are
 * enforced by `/api/admin/seed`, which is where they cannot be skipped by
 * running a different script. What this prints is the server's refusal, in the
 * server's own words.
 *
 * ── WRITING seed/expected-values.json ────────────────────────────────────
 *
 * §4 asks the seed to emit the expected aggregates to a file. The server cannot
 * write one: Vercel's filesystem is read-only apart from a scratch directory
 * that is not shared between invocations. So the route RETURNS them and this
 * script writes the file locally, which puts it where §4 wants it without
 * pretending the server has a disk.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const BASE = (process.env.SEED_BASE_URL ?? "http://localhost:5173").replace(/\/$/, "");

/**
 * The identity the request is made as.
 *
 * `/api/admin/seed` requires `settings.edit`, which in a signed-in deployment
 * means a real session cookie. Locally the demo role switcher stands in, which
 * is what `SEED_COOKIE` defaults to; against a preview deployment, export the
 * portal's session cookie into `SEED_COOKIE` instead. There is deliberately no
 * way to bypass the capability check from here.
 */
const COOKIE = process.env.SEED_COOKIE ?? "maintsupp_demo_role=super_admin";

function flag(name) {
  const prefixed = `--${name}=`;
  const hit = process.argv.find((argument) => argument.startsWith(prefixed));
  return hit ? hit.slice(prefixed.length) : null;
}

function has(name) {
  return process.argv.includes(`--${name}`);
}

async function call(pathname, init = {}) {
  let response;
  try {
    response = await fetch(`${BASE}${pathname}`, {
      ...init,
      headers: { accept: "application/json", cookie: COOKIE, ...(init.headers ?? {}) },
    });
  } catch (error) {
    console.error(`\nCould not reach ${BASE}${pathname}.`);
    console.error("Start the portal first (npm run dev), or set SEED_BASE_URL.");
    console.error(String(error?.message ?? error));
    process.exit(2);
  }
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text.slice(0, 500) };
  }
  return { status: response.status, body };
}

/** A refusal, printed the way the server explained it. */
function reportRefusal(body) {
  console.error(`\n  ${body.error ?? "Refused."}`);
  if (body.reason) console.error(`  ${body.reason}`);
  for (const check of body.checks ?? []) {
    console.error(
      `    [${check.name}] ${check.passed ? "passed" : "REFUSED"} — read "${check.observed}"`,
    );
    if (!check.passed) console.error(`      ${check.reason}`);
  }
  if (body.observed) {
    console.error(`    observed: ${JSON.stringify(body.observed)}`);
  }
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : `${text}${" ".repeat(width - text.length)}`;
}

function padStart(value, width) {
  const text = String(value);
  return text.length >= width ? text : `${" ".repeat(width - text.length)}${text}`;
}

/** §4.2's table, in a terminal: Metric | Expected | Actual | Difference | Result. */
function printReport(report) {
  console.log("");
  console.log(
    `  ${pad("METRIC", 52)}${padStart("EXPECTED", 10)}${padStart("ACTUAL", 10)}${padStart("DIFF", 8)}  RESULT`,
  );
  console.log(`  ${"-".repeat(88)}`);
  let section = null;
  for (const row of report.rows) {
    if (row.section !== section) {
      section = row.section;
      console.log(`\n  ${section}`);
    }
    const result =
      row.status === "pass" ? "pass" : row.status === "fail" ? "FAIL" : "not measured";
    console.log(
      `  ${pad(row.metric.slice(0, 50), 52)}` +
        `${padStart(row.expected ?? "—", 10)}` +
        `${padStart(row.actual ?? "—", 10)}` +
        `${padStart(row.difference === null ? "—" : row.difference, 8)}  ${result}`,
    );
    if (row.status === "fail") {
      console.log(`      query: ${row.query}`);
      if (row.expectedIds?.length) {
        console.log(`      expected records: ${row.expectedIds.slice(0, 10).join(", ")}`);
      }
      if (row.actualIds?.length) {
        console.log(`      actual records:   ${row.actualIds.slice(0, 10).join(", ")}`);
      }
    }
  }
  console.log(`\n  ${"-".repeat(88)}`);
  console.log(
    `  ${report.passed} passing, ${report.failed} failing, ${report.notMeasured} not measured` +
      ` — pass rate ${report.passRate === null ? "n/a" : `${report.passRate}%`}`,
  );
  console.log(`  measured against ${report.today}, batch ${report.seedBatchId}\n`);
}

async function runSeed({ days } = {}) {
  const payload = { action: "seed" };
  if (typeof days === "number" && Number.isFinite(days)) payload.days = days;
  const today = flag("today");
  if (today) payload.today = today;

  const { status, body } = await call("/api/admin/seed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (status !== 200) {
    reportRefusal(body);
    process.exit(1);
  }

  const result = body.result;
  console.log(`\n  Seeded batch ${result.seedBatchId} for ${result.today}.`);
  console.log(`  Organisation ${result.organisationId}, EMAIL_MODE=${result.emailMode}.`);
  console.log("\n  Deleted first:");
  for (const entry of result.deleted) {
    if (entry.rows > 0) console.log(`    ${pad(entry.table, 26)} ${padStart(entry.rows, 6)}`);
  }
  console.log("\n  Inserted:");
  for (const entry of result.inserted) {
    console.log(`    ${pad(entry.table, 26)} ${padStart(entry.rows, 6)}`);
  }
  console.log(
    `\n  Storage: ${result.storage.objectsWritten} objects. ${result.storage.note}`,
  );
  for (const warning of result.warnings ?? []) console.log(`\n  ! ${warning}`);

  /*
   * §4's file. Written under `seed/` at the repository root — not under
   * `app/`, which is served, and not under `db/`, which another workstream
   * owns. Deterministic by construction, so re-running overwrites it with
   * identical bytes and a diff stays empty.
   */
  const directory = path.join(root, "seed");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "expected-values.json");
  await writeFile(file, `${JSON.stringify(body.expected, null, 2)}\n`, "utf8");
  console.log(`\n  Expected values written to ${path.relative(root, file)}\n`);
}

async function runPurge() {
  const { status, body } = await call("/api/admin/seed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "purge" }),
  });
  if (status !== 200) {
    reportRefusal(body);
    process.exit(1);
  }
  console.log(`\n  Purged ${body.result.totalRows} rows from ${body.result.organisationId}.`);
  for (const entry of body.result.deleted) {
    console.log(`    ${pad(entry.table, 26)} ${padStart(entry.rows, 6)}`);
  }
  console.log(
    `  ${body.result.storage.objectsDeleted} objects removed. ${body.result.storage.note}\n`,
  );
}

async function runVerify() {
  const payload = { action: "verify" };
  const today = flag("today");
  if (today) payload.today = today;
  const days = flag("days");
  if (days !== null) payload.days = Number(days);

  const { status, body } = await call("/api/admin/seed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (status !== 200 && status !== 409) {
    reportRefusal(body);
    process.exit(1);
  }

  printReport(body.report);

  if (!body.report.seeded) {
    console.error("  Nothing is seeded. Run `npm run seed` first.\n");
    process.exit(1);
  }

  /* §5 wires this into CI, so the exit code is the whole contract. */
  process.exit(body.report.failed > 0 ? 1 : 0);
}

/**
 * `seed:cron` — one pass of the real dispatcher.
 *
 * `/api/cron/reminders` and not a second loop written here, for the reason its
 * own header gives: a second place that decides whether mail leaves the
 * building is a second place to get it wrong. It needs `CRON_SECRET`, which is
 * the same credential the scheduler uses.
 */
async function runCron() {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error(
      "\n  CRON_SECRET is unset, and /api/cron/reminders will answer 503 without it." +
        "\n  Set it in the environment this script runs in, matching the server's.\n",
    );
    process.exit(1);
  }
  const { status, body } = await call("/api/cron/reminders", {
    method: "POST",
    headers: { "x-cron-secret": secret },
  });
  if (status !== 200) {
    reportRefusal(body);
    process.exit(1);
  }
  console.log(`\n  ${JSON.stringify(body, null, 2)}\n`);
  console.log(
    "  Every send in this product goes through sendNotification, which owns the\n" +
      "  EMAIL_MODE kill switch and writes notification_log. Check that log: in\n" +
      "  sink or log mode nothing reached a real address.\n",
  );
}

/**
 * `seed:travel --days=+30` — the estate as it would be in thirty days.
 *
 * REBUILDING at a later `today`, not adding thirty to every stored date. The
 * second would move the certificates and the clock together and change nothing;
 * the first is what crosses a band boundary, which is the whole point — seed,
 * jump forward, run the cron, confirm the right reminders fired and only those.
 */
async function runTravel() {
  const raw = flag("days");
  const days = Number(raw);
  if (raw === null || !Number.isFinite(days)) {
    console.error("\n  Usage: npm run seed:travel -- --days=+30\n");
    process.exit(1);
  }
  console.log(`\n  Rebuilding the seeded estate as it would be ${days} days from today.`);
  await runSeed({ days });
  console.log(
    "  Now run `npm run seed:cron`, then `npm run seed:verify -- --days=" +
      `${days}\` to check the right subset fired.\n`,
  );
}

const command = (process.argv[2] ?? "seed").replace(/^--/, "");

switch (command) {
  case "seed":
    await runSeed(has("days") ? { days: Number(flag("days")) } : {});
    break;
  case "purge":
    await runPurge();
    break;
  case "verify":
    await runVerify();
    break;
  case "cron":
    await runCron();
    break;
  case "travel":
    await runTravel();
    break;
  default:
    console.error(`\n  Unknown command "${command}". One of: seed, purge, verify, cron, travel.\n`);
    process.exit(1);
}
