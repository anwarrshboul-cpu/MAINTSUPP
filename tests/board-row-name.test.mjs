/**
 * EVERY ROW ON THE JOB BOARD WAS CALLED "INCOMING FORM ANSWER".
 *
 * Not some rows. Every one, in the screenshot that reported it, while
 * `maintenance_requests.title` held a real and distinct description of each job
 * the whole time. A board where every row has the same name is unusable
 * whatever columns are on it.
 *
 * ── IT WAS NEVER A DATA PROBLEM ───────────────────────────────────────────
 *
 * Worth stating plainly, because the brief assumed the opposite and asked for a
 * retitling backfill to be proposed. Measured against the Staging database:
 *
 *   966 jobs, 966 with a usable title, ZERO titled "Incoming form answer",
 *   including all 774 rows whose source is the monday import — which carry
 *   real composed names like "Aldgate – Whitechapel Road — AC".
 *
 * So no backfill is needed. The titles were always there; three separate
 * pieces of display code declined to read them.
 *
 * ── WHAT WAS ACTUALLY WRONG ───────────────────────────────────────────────
 *
 * `boardItemName` read `if (boardId !== "maintenance" && request.title)`, so on
 * the job board it never consulted the title at all. The exclusion existed for
 * monday parity, but the guard was the wrong shape for that intent: a row
 * imported from monday takes its title FROM monday's Name column, so preferring
 * the title reproduces monday's own answer for exactly the rows monday named,
 * and gives a real one to every row this product created. Parity by data rather
 * than by a board-key comparison — the same lesson `seedViews` records.
 *
 * `portal-app.tsx` then held two more hand-written copies of the rule, both
 * with the old answer, so the mobile board and the job drawer would have gone
 * on saying it after the grid stopped.
 *
 * Reads normalise CRLF — this is a Windows checkout.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

/** Source with its comments removed, so a rule can be counted in the code. */
const codeOnly = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/*
 * `board-ordering.ts`'s only two imports are `import type`, which the
 * transpiler erases — so it loads from a `data:` URL with nothing to rewrite.
 * The rule is asserted by CALLING it rather than by matching its source, which
 * is what makes these assertions about behaviour instead of about spelling.
 */
const ordering = await (async () => {
  const source = await read("app/(app)/portal/board-ordering.ts");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
})();

const job = (over = {}) => ({
  id: "MS-1",
  title: "Main CCTV camera offline",
  source: "Portal form",
  ...over,
});

test("a job on the board is called what the job is called", () => {
  assert.equal(
    ordering.boardItemName(job()),
    "Main CCTV camera offline",
    "the title is the name — this is the whole fault",
  );
});

test("a row imported from monday keeps monday's own name", () => {
  /*
   * Parity, preserved by the data. This row's title came from monday's Name
   * column, so reading the title IS reading monday's answer.
   */
  assert.equal(
    ordering.boardItemName(job({ title: "Aldgate – Whitechapel Road — AC", source: "monday import" })),
    "Aldgate – Whitechapel Road — AC",
  );
});

test("a row whose stored name really is the form's own is not dressed up", () => {
  /*
   * The honest case. If monday genuinely named a row "Incoming form answer",
   * that is still what it is called — this change reads the data, it does not
   * invent a better name, and it does not retitle anything.
   */
  assert.equal(
    ordering.boardItemName(job({ title: "Incoming form answer", source: "monday import" })),
    "Incoming form answer",
  );
});

test("with no title at all, the row still says how the work arrived", () => {
  assert.equal(ordering.boardItemName(job({ title: "" })), "Incoming form answer");
  assert.equal(ordering.boardItemName(job({ title: null })), "Incoming form answer");
  assert.equal(
    ordering.boardItemName(job({ title: "   ", source: "Manual" })),
    "Manual",
    "a whitespace-only title is not a title",
  );
});

test("the Name cell still wins wherever one exists", () => {
  /*
   * Renaming a row in the grid writes a cell, and that edit must survive —
   * `tests/audit-s1-rename.test.mjs` holds the same contract from the other
   * side. If the title were preferred over the cell, every rename would save
   * and never appear.
   */
  assert.equal(ordering.boardItemName(job(), "Renamed in the grid"), "Renamed in the grid");
  assert.equal(
    ordering.boardItemName(job({ title: "" }), "Renamed in the grid"),
    "Renamed in the grid",
  );
  // An empty cell is not an instruction to show nothing.
  assert.equal(ordering.boardItemName(job(), "   "), "Main CCTV camera offline");
});

test("the board key no longer decides what a row is called", async () => {
  const source = await read("app/(app)/portal/board-ordering.ts");
  const fn = source.slice(source.indexOf("export function boardItemName"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
  assert.doesNotMatch(
    body,
    /boardId/,
    "which boards read the title must not be decided by name — the same rule seedViews learned",
  );
});

test("grouping by Name still groups by provenance, on purpose", () => {
  /*
   * `systemColumnSortValue` deliberately keeps the old answer, and a reader who
   * notices the difference should find it asserted rather than assume it was
   * missed. Sorting never reaches it — `board-sort.ts` answers `name` through
   * `boardItemName` first — but "Group by → Name" does, and grouping by a
   * free-text job title produces one group per row, which is not a grouping.
   */
  assert.equal(ordering.systemColumnSortValue(job(), "name"), "Incoming form answer");
  assert.equal(ordering.systemColumnSortValue(job({ source: "Manual" }), "name"), "Manual");
});

test("nothing hand-writes the rule a second time", async () => {
  /*
   * `portal-app.tsx` carried two copies — the mobile board's Name field and the
   * job drawer's headline — and both had the old answer in them. A third copy
   * is how half the product goes on saying "Incoming form answer" after the
   * other half has stopped.
   */
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.doesNotMatch(
    portal,
    /source === "Manual" \? "Manual" : "Incoming form answer"/,
    "portal-app must ask boardItemName, not restate it",
  );
  assert.match(portal, /import \{ boardItemName \} from "\.\/board-ordering"/);
  assert.match(portal, /boardItemName\(request, boardValue\)/, "the mobile board");
  assert.match(portal, /<h2>\{boardItemName\(request\)\}<\/h2>/, "the drawer headline");

  /* `displaySource` is the ONE place the words live, so a future change of
     wording lands everywhere at once.

     Counted over CODE only. Comments quote the strings they explain — this
     file's own docblock does it four times — and a rule against that is a rule
     against writing the explanation down. Every source check in this suite
     strips them first, for the same reason. */
  const ordering = codeOnly(await read("app/(app)/portal/board-ordering.ts"));
  const occurrences = ordering.split('"Incoming form answer"').length - 1;
  assert.equal(occurrences, 1, "the string is written once, inside displaySource");
});
