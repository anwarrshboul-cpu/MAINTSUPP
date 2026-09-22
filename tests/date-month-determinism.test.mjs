/**
 * ONE WORD FOR A MONTH, WHATEVER RUNTIME RENDERS IT.
 *
 * A browser sweep of PRODUCTION on 2026-09-23 found React error #418 — "the
 * server rendered text didn't match the client" — on `/dashboard/contractors`
 * and `/dashboard/reports`, at 1440 and 390, on every build tested back to #90.
 * The cause, measured on one instant:
 *
 *   · Chromium, and Node on a developer machine: `22 Sept 2026`
 *   · Vercel's Node runtime in Production:       `22 Sep 2026`
 *
 * Both were asked for en-GB. CLDR renamed en-GB's abbreviated September from
 * "Sep" to "Sept"; Vercel's bundled ICU predates that. Both screens render a
 * date range in their FIRST paint — the server sends it, the browser hydrates it
 * — so React found two different words in the same text node and threw the tree
 * away. No test in the suite could see it, because the suite's Node agrees with
 * the browser and disagrees with Production.
 *
 * So the month name is no longer ICU's to choose. `SHORT_MONTHS` in
 * `app/lib/format-date.ts` is the product's own table, `formatToParts` puts it
 * where the locale wanted the month, and this file holds the rule:
 *
 *   1. every short form reads the table, so no runtime can answer differently;
 *   2. the table says "Sep" — what Production has always displayed and what the
 *      four hand-written tables elsewhere in the codebase already say, so the
 *      fix changes nothing a user sees;
 *   3. **all five tables agree**, which is the part a future change is most
 *      likely to break: adding "Sept" to one of them would reintroduce exactly
 *      this defect in a different place.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SHORT_MONTHS,
  formatDate,
  formatDayMonth,
  formatLongDate,
  formatMonthShort,
  formatMonthYear,
  formatShortDate,
} from "../app/lib/format-date.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const EXPECTED = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

test("the product's own twelve abbreviations, and September is the one that matters", () => {
  assert.deepEqual([...SHORT_MONTHS], EXPECTED);
  /* Named rather than indexed, so the assertion reads as the decision it is. */
  assert.equal(SHORT_MONTHS[8], "Sep", "Production shows Sep; CLDR's newer en-GB word would change the estate's wording");
});

test("every written form takes its month from the table, not from the host's ICU", () => {
  /* One date, every form. If ICU were still naming the month, one of these would
     say "Sept" on a developer machine and "Sep" on Vercel — which is the defect. */
  assert.equal(formatShortDate("2026-09-22"), "22 Sep 2026");
  assert.equal(formatDayMonth("2026-09-03"), "3 Sep");
  assert.equal(formatMonthShort("2026-09-15"), "Sep");
  /* The long and numeric forms are identical in every English locale, so they are
     left to `Intl` — and pinned here so a future change notices if that stops
     being true. */
  assert.equal(formatLongDate("2026-09-22"), "22 September 2026");
  assert.equal(formatMonthYear("2026-09-22"), "September 2026");
  assert.equal(formatDate("2026-09-22"), "22/09/2026");
  /* Every month, in the form the hydration error was found in. */
  for (const [index, name] of EXPECTED.entries()) {
    const month = String(index + 1).padStart(2, "0");
    assert.equal(formatShortDate(`2026-${month}-05`), `5 ${name} 2026`);
  }
});

test("the substitution keeps the locale's own order and separators", async () => {
  const source = await read("app/lib/format-date.ts");
  /* `formatToParts`, not a string replace: en-GB's day-first order, its comma
     before a time and its separators are still ICU's — only the token ICU
     labelled `month` is ours. */
  assert.match(source, /formatter\(form, timeZone\)\.formatToParts\(when\)/);
  assert.match(source, /part\.type === "month" && name \? name : part\.value/);
  /* And only for the forms that print a month as a NAME. A 2-digit month is a
     number: `22/09/2026` must not become `22/Sep/2026`. */
  assert.match(source, /const SHORT_MONTH_FORMS = new Set<Form>\(\["short", "dayMonth", "monthShort", "shortTime"\]\)/);
  /* A date-only value takes its month from its own string, so no zone can move
     it; a moment reads the month back in the zone the label is rendered in. */
  assert.match(source, /assemble\(form, "UTC", utc, Number\(month\) - 1\)/);
  assert.match(source, /Number\(formatter\("monthNumber", timeZone\)\.format\(when\)\) - 1/);
});

test("all five month tables in the codebase say the same twelve words", async () => {
  /*
   * The four besides `format-date.ts` are hand-written and predate it. They are
   * not consolidated here on purpose — two of them label chart buckets that
   * tests pin by value, and a shared import would be a bigger change than this
   * defect warrants — but they MUST agree, because the defect this file is about
   * is two answers to one question. A fifth table, or a "Sept" in any of them,
   * fails here.
   */
  const TABLES = [
    ["app/(app)/portal/period-model.ts", "SHORT_MONTHS"],
    ["app/lib/dashboard-aggregates.ts", "MONTHS"],
    ["app/lib/overview-aggregates.ts", "MONTH_NAMES"],
    ["app/(app)/portal/finance/finance-landing.tsx", "MONTHS"],
  ];
  for (const [file, name] of TABLES) {
    const source = await read(file);
    const at = source.indexOf(`const ${name} = [`);
    assert.ok(at > 0, `${file} must still hold ${name}`);
    const literal = source.slice(at, source.indexOf("];", at));
    const words = [...literal.matchAll(/"([A-Z][a-z]{2,4})"/g)].map((match) => match[1]);
    assert.deepEqual(words, EXPECTED, `${file}'s ${name} must say the same twelve words as format-date.ts`);
  }
});

test("no sixth table appears without being declared here", async () => {
  /* A new hand-written month table is how this defect comes back. The five are
     named above; anything else naming January in a month list is a finding. */
  const { readdirSync, statSync } = await import("node:fs");
  const declared = new Set([
    "app/lib/format-date.ts",
    "app/(app)/portal/period-model.ts",
    "app/lib/dashboard-aggregates.ts",
    "app/lib/overview-aggregates.ts",
    "app/(app)/portal/finance/finance-landing.tsx",
  ]);
  const walk = (dir) => {
    const out = [];
    for (const entry of readdirSync(path.join(root, dir))) {
      const rel = `${dir}/${entry}`;
      if (statSync(path.join(root, rel)).isDirectory()) out.push(...walk(rel));
      else if (/\.(ts|tsx)$/.test(entry)) out.push(rel);
    }
    return out;
  };
  const offenders = [];
  for (const file of [...walk("app"), ...walk("db")]) {
    if (declared.has(file)) continue;
    const source = await read(file);
    /* A list, not a mention: "Jan" beside "Feb" in the same few characters. */
    if (/"Jan",\s*"Feb"|'Jan',\s*'Feb'/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], "a new month table must be added to the list above and agree with it");
});
