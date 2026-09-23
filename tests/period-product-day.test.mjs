/**
 * THE PERIOD'S "TODAY" IS THE PRODUCT'S DAY, WHOEVER RENDERS IT.
 *
 * React threw #418 ("the server rendered text didn't match the client") on
 * `/dashboard/contractors` and `/dashboard/reports` in Production. Measured on a
 * Preview on 2026-09-23 by moving only the browser's time zone:
 *
 *   · browser's calendar day equal to the server's (UTC): 0 errors, every build;
 *   · browser one day behind:                              #418, every build.
 *
 * The rejected text was the period's end, `1 Oct 2025 – 23 Sep 2026` from the
 * server against `– 22 Sep 2026` in the browser. `resolvePeriod` read "today"
 * from each runtime's LOCAL calendar, and Vercel renders the first paint in UTC.
 * For a UK browser that is the midnight hour of every BST night.
 *
 * The invariant this file holds is the one hydration needs: the SAME instant
 * gives the SAME label in EVERY zone. It is checked by running the shipped
 * `period-model.ts` in child processes with `TZ` set, because a zone cannot be
 * changed inside one Node process. The rest pins what did not change: a UK
 * runtime's answers, and the rolling windows.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

/* The shipped source, transpiled into a temporary directory so a child process
   can import it by path (a data: URL is too long to pass on a command line). */
const dir = await mkdtemp(path.join(os.tmpdir(), "period-day-"));
await writeFile(path.join(dir, "dashboard-meters.mjs"), transpile(await read("app/(app)/portal/dashboard-meters.ts")));
await writeFile(
  path.join(dir, "period-model.mjs"),
  transpile(await read("app/(app)/portal/period-model.ts")).replace(
    /from ["']\.\/dashboard-meters["']/g,
    'from "./dashboard-meters.mjs"',
  ),
);
const modelUrl = pathToFileURL(path.join(dir, "period-model.mjs")).href;
const meters = await import(pathToFileURL(path.join(dir, "dashboard-meters.mjs")).href);
const period = await import(modelUrl);
test.after(() => rm(dir, { recursive: true, force: true }));

/** 23:30 UTC on 22 Sep 2026: already 00:30 on the 23rd in London (BST). */
const BST_MIDNIGHT_HOUR = Date.UTC(2026, 8, 22, 23, 30);
/** 23:30 UTC on 15 Jan 2026: still 23:30 on the 15th in London (GMT). */
const GMT_LATE_EVENING = Date.UTC(2026, 0, 15, 23, 30);

function labelsIn(zone, instant) {
  const script = `
    const period = await import(${JSON.stringify(modelUrl)});
    const out = {};
    for (const token of ["today", "12m", "mtd", "ytd", "week"]) out[token] = period.resolvePeriod(token, ${instant}).label;
    process.stdout.write(JSON.stringify(out));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, TZ: zone },
    encoding: "utf8",
  });
  return JSON.parse(output);
}

test("the same instant gives the same period labels in every zone — the hydration invariant", () => {
  for (const instant of [BST_MIDNIGHT_HOUR, GMT_LATE_EVENING]) {
    const server = labelsIn("UTC", instant);
    for (const zone of ["Europe/London", "America/Los_Angeles", "Asia/Tokyo", "Africa/Cairo"]) {
      assert.deepStrictEqual(labelsIn(zone, instant), server, `${zone} must print what the UTC server prints`);
    }
  }
});

test("it is London's day: the BST midnight hour already belongs to the next date", () => {
  const labels = labelsIn("UTC", BST_MIDNIGHT_HOUR);
  assert.equal(labels.today, "23 Sep 2026", "the server no longer runs an hour behind in summer");
  assert.equal(labels["12m"], "1 Oct 2025 – 23 Sep 2026", "the exact range React rejected");
  assert.equal(labelsIn("UTC", GMT_LATE_EVENING).today, "15 Jan 2026", "in winter London is UTC");
});

test("a UK runtime's answers do not move, and the rolling windows keep the real instant", () => {
  const london = labelsIn("Europe/London", BST_MIDNIGHT_HOUR);
  assert.equal(london.today, "23 Sep 2026", "a UK browser already said this; it still does");
  for (const token of ["7", "30", "90", "all"]) {
    const window = period.resolvePeriod(token, BST_MIDNIGHT_HOUR);
    const rolling = meters.analyticsWindow(token, BST_MIDNIGHT_HOUR);
    assert.equal(window.start, rolling.start, `${token}: the rolling window starts where it always did`);
    if (token !== "all") assert.equal(window.end, rolling.end, `${token}: and ends there too`);
  }
});

test("calendarNow degrades to the instant it was given when there is nothing to convert", () => {
  assert.ok(Number.isNaN(period.calendarNow(Number.NaN)));
  assert.equal(period.calendarNow(Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
  assert.equal(period.PRODUCT_TIME_ZONE, "Europe/London");
});
