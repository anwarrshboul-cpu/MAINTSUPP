/**
 * Owner Part 6 — the Timeline cell says how long the range is.
 *
 * WHAT WAS MISSING. The column drew `08-20 → 08-23` and stopped there: no year,
 * no month name, and no length. The duration is the question the column is
 * opened to answer, and reading it off that strip is arithmetic across a month
 * boundary done in the reader's head.
 *
 * The arithmetic itself is `timelineSummary` in
 * `app/(app)/portal/timeline-duration.ts` — pure, so it is tested directly
 * here. The rest is source pins on decisions a unit test cannot show.
 *
 * Browser-verified 2026-09-04 on the running dev board, at 1440/1280/1024/768/
 * 430/390/320: the card appears on hover AND on focus, carries Start / End /
 * Duration, is wired by `aria-describedby`, does not flicker or drift while the
 * pointer is still, stands down when the editor opens, and is replaced on the
 * phone by a duration line inside the sheet a tap already opens. Zero console
 * errors, zero horizontal overflow. Two QA rows (created and binned by exact
 * id) covered the edges: a job with no end date read "No end date set, so there
 * is no duration yet." with no number invented, and a one-day job read
 * "1 day" rather than "0 days".
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/*
 * WHY THIS FILE RESOLVES ITS OWN IMPORTS.
 *
 * `timelineSummary` is tested by RUNNING it, which is the only kind of
 * assertion that survives a reformat — and the product's own modules import
 * each other without a file extension, which the bundler resolves and Node's
 * ESM resolver does not. Borrowed verbatim from
 * `w2-store-documentation-instance.test.mjs`, including its narrowness: it only
 * rewrites a RELATIVE specifier with no extension, and only when a `.ts`/`.tsx`
 * file is actually sitting there, so it cannot redirect a package import or
 * invent a module.
 */
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier) && context.parentURL) {
      const base = dirname(fileURLToPath(context.parentURL));
      for (const extension of [".ts", ".tsx", "/index.ts"]) {
        const candidate = resolvePath(base, specifier + extension);
        if (existsSync(candidate)) return next(pathToFileURL(candidate).href, context);
      }
    }
    return next(specifier, context);
  },
});

const here = new URL("../", import.meta.url).href;
const { timelineSummary, timelineSummaryText } = await import(
  `${here}app/(app)/portal/timeline-duration.ts`
);

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const codeOnly = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ------------------------------------------------------------------ */
/* The arithmetic                                                      */
/* ------------------------------------------------------------------ */

test("a range is counted inclusively, the way a diary is", () => {
  const summary = timelineSummary("2026-08-20", "2026-08-23");
  assert.equal(summary.days, 4);
  assert.equal(summary.durationLabel, "4 days");
  assert.equal(summary.note, null);
  // The dates are shown in the board's own en-GB short form, not re-derived.
  assert.equal(summary.startLabel, "20 Aug 2026");
  assert.equal(summary.endLabel, "23 Aug 2026");
});

test("a single-day job is 1 day, never 0", () => {
  const summary = timelineSummary("2026-08-20", "2026-08-20");
  assert.equal(summary.days, 1);
  assert.equal(summary.durationLabel, "1 day", "the singular, and not a zero");
});

test("a month boundary and a leap day are counted, not approximated", () => {
  assert.equal(timelineSummary("2026-01-30", "2026-02-02").days, 4);
  // 2028 is a leap year: 28 Feb, 29 Feb, 1 Mar.
  assert.equal(timelineSummary("2028-02-28", "2028-03-01").days, 3);
  // A whole non-leap year, inclusive of both ends.
  assert.equal(timelineSummary("2026-01-01", "2026-12-31").days, 365);
});

test("a missing date says which one is missing, and invents nothing", () => {
  const noEnd = timelineSummary("2026-08-20", null);
  assert.equal(noEnd.startLabel, "20 Aug 2026");
  assert.equal(noEnd.endLabel, null);
  assert.equal(noEnd.durationLabel, null, "a duration must not be guessed from one date");
  assert.match(noEnd.note, /No end date set/);

  const noStart = timelineSummary("", "2026-08-23");
  assert.equal(noStart.startLabel, null);
  assert.equal(noStart.endLabel, "23 Aug 2026");
  assert.equal(noStart.durationLabel, null);
  assert.match(noStart.note, /No start date set/);

  const neither = timelineSummary(null, undefined);
  assert.equal(neither.empty, true);
  assert.match(neither.note, /No dates set/);
});

test("nothing ever renders NaN, an Invalid Date, or an undefined", () => {
  for (const [start, end] of [
    ["not-a-date", "2026-08-23"],
    ["2026-08-20", "rubbish"],
    ["", ""],
    [null, null],
    ["2026-13-45", "2026-99-99"],
  ]) {
    const summary = timelineSummary(start, end);
    const text = timelineSummaryText(summary);
    assert.doesNotMatch(text, /NaN|Invalid Date|undefined|null/, `for ${start} → ${end}`);
    assert.doesNotMatch(
      String(summary.durationLabel ?? ""),
      /NaN/,
      "a duration is a number of days or it is absent",
    );
  }
});

test("an end before its start is reported, not turned into a negative duration", () => {
  const summary = timelineSummary("2026-08-23", "2026-08-20");
  assert.equal(summary.durationLabel, null);
  assert.equal(summary.days, null);
  assert.match(summary.note, /end date is before the start date/i);
  // Both dates are still shown, because both are what the job holds.
  assert.equal(summary.startLabel, "23 Aug 2026");
  assert.equal(summary.endLabel, "20 Aug 2026");
});

test("a date carrying a time is read as its day, not shifted by a zone", () => {
  // `dateInputValue` is the board's own reader; the point of routing through it
  // is that the tooltip and the cell can never disagree about which day it is.
  const summary = timelineSummary("2026-08-20T23:30:00.000Z", "2026-08-21T00:15:00.000Z");
  assert.equal(summary.startLabel, "20 Aug 2026");
  assert.equal(summary.endLabel, "21 Aug 2026");
  assert.equal(summary.days, 2);
});

test("the sentence form carries the same facts as the card", () => {
  assert.equal(
    timelineSummaryText(timelineSummary("2026-08-20", "2026-08-23")),
    "Starts 20 Aug 2026, ends 23 Aug 2026, 4 days.",
  );
  assert.match(
    timelineSummaryText(timelineSummary("2026-08-20", null)),
    /^Starts 20 Aug 2026, no end date\. No end date set/,
  );
  assert.match(timelineSummaryText(timelineSummary(null, null)), /No dates set/);
});

/* ------------------------------------------------------------------ */
/* The decisions a unit test cannot show                               */
/* ------------------------------------------------------------------ */

test("the tooltip reuses the shared overlay primitives, and positions nothing itself", async () => {
  const tip = codeOnly(await source("app/(app)/portal/timeline-tooltip.tsx"));
  assert.match(tip, /import \{ LayerPortal, useAnchoredPosition \} from "\.\/overlay\/anchored"/);
  // The known jitter trap: anchored.tsx measures its own scrollbar, and a
  // second implementation measuring rects beside it is how the feedback loop
  // gets built. There is no measurement in this file at all.
  assert.doesNotMatch(
    tip,
    /getBoundingClientRect|clientWidth|offsetWidth|position: "fixed"/,
    "the tooltip must not measure or position anything of its own",
  );
});

test("focus shows the card, and the fact survives without it", async () => {
  const tip = await source("app/(app)/portal/timeline-tooltip.tsx");
  assert.match(tip, /onFocus=\{\(\) => setShowing\(true\)\}/, "keyboard focus must show the duration");
  assert.match(tip, /onBlur=\{\(\) => setShowing\(false\)\}/);
  assert.match(tip, /onMouseEnter=\{\(\) => setShowing\(true\)\}/);
  assert.match(tip, /aria-describedby=\{open \? tipId : undefined\}/);
  assert.match(tip, /role="tooltip"/);
  // A native title carrying the same sentence is the floor: it survives a
  // portal that did not mount and it is what a browser reads when nothing else
  // does.
  assert.match(tip, /title=\{sentence\}/);
});

test("a touch board gets the duration outright, because it has no hover", async () => {
  const tip = codeOnly(await source("app/(app)/portal/timeline-tooltip.tsx"));
  assert.match(tip, /const open = showing && !mobile;/, "no hover card on a phone");
  const cells = codeOnly(await source("app/(app)/portal/board-cells.tsx"));
  assert.match(
    cells,
    /<TimelineDurationLine start=\{start\} end=\{end\} \/>/,
    "the mobile sheet must state the duration itself",
  );
});

test("the tooltip cannot steal the pointer from the cell it describes", async () => {
  // A hover card drawn under the cursor takes the button's own `mouseleave`
  // and the pair flickers.
  const css = await source("app/(app)/portal/timeline-tooltip.css");
  assert.match(css, /\.ms-popover\.timeline-tip \{[^}]*pointer-events: none;/s);
});

test("the underlying dates are unchanged — this is a reading, not a write", async () => {
  const tip = codeOnly(await source("app/(app)/portal/timeline-tooltip.tsx"));
  assert.doesNotMatch(tip, /onSave|fetch\(|PATCH/, "the tooltip must never write");
  const duration = codeOnly(await source("app/(app)/portal/timeline-duration.ts"));
  assert.match(
    duration,
    /import \{ dateInputValue \} from "\.\/board-format"/,
    "both dates must be read by the board's own reader, so the card and the cell agree",
  );
  assert.match(
    duration,
    /import \{ formatShortDate \} from "\.\.\/\.\.\/lib\/format-date"/,
    "and rendered in the product's single en-GB form",
  );
});

test("clicking still opens the timeline editor, and the card stands down", async () => {
  const tip = await source("app/(app)/portal/timeline-tooltip.tsx");
  assert.match(
    tip,
    /onClick=\{\(\) => \{[\s\S]{0,400}setShowing\(false\);[\s\S]{0,200}onOpenEditor\(\);/,
    "opening the editor must hide the card explaining it",
  );
  const cells = codeOnly(await source("app/(app)/portal/board-cells.tsx"));
  assert.match(cells, /<TimelineRangeButton/, "the cell renders the strip through the tooltip component");
  assert.match(
    cells,
    /onOpenEditor=\{\(\) => \{[\s\S]{0,600}setOpen\(\(current\) => !current\);/,
    "and still toggles its own editor",
  );
});
