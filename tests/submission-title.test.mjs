/**
 * THE TITLE RULE, RUN RATHER THAN PINNED.
 *
 * Three near-copies of `requestTitle` existed — `/api/maintenance` and
 * `/api/report-job` splitting on `[.!?\n]` at 72 characters, and
 * `/api/forms/[token]/submit` splitting on `\n` at 80 — plus a fourth
 * hand-written copy in the raise-a-job dialog so it could preview the result.
 * Every one of them was protected by an `assert.match` against its own source
 * text, and none of them was ever EXECUTED by a test.
 *
 * They are one function now, `submissionTitle` in app/lib/submission-title.ts,
 * and this file runs it. The module imports nothing at all — deliberately, so
 * the raise-a-job dialog can hold the same function the five intake doors call
 * without dragging drizzle into the client bundle — which is also what lets a
 * test import it with no database in front of it.
 *
 * Reads normalise CRLF: line endings in this repo are PER FILE and there is no
 * `.gitattributes`.
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

const titleModule = await (async () => {
  const source = await read("app/lib/submission-title.ts");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
})();

const { SUBMISSION_TITLE_MAX, renderTitleTemplate, submissionTitle } = titleModule;

/* ── 1. The rule ───────────────────────────────────────────────────────── */

test("a short first line survives whole, punctuation and all", () => {
  /*
   * THE DEFECT IN THE OLD SENTENCE SPLIT. `/api/maintenance` split on the first
   * `.`, so this description was titled "Leak" — four characters, identical on
   * every leak in the workspace, and useless to a coordinator scanning a board.
   */
  assert.equal(
    submissionTitle({ description: "Leak. Started yesterday in the back room." }),
    "Leak. Started yesterday in the back room.",
  );
});

test("only the first line is used — the rest of the description is not a title", () => {
  assert.equal(
    submissionTitle({ description: "Shutter jammed\nWill not close at all\nStaff cannot lock up" }),
    "Shutter jammed",
  );
});

test("leading blank lines are skipped rather than producing an empty title", () => {
  assert.equal(submissionTitle({ description: "\n\n  Freezer is warm  \nsince Monday" }), "Freezer is warm");
});

test("a long first line is cut at a sentence end inside the budget, not mid-word", () => {
  const line =
    "The walk-in freezer has failed overnight. All the stock in it is at risk and " +
    "we cannot open the shop until somebody has looked at it.";
  const title = submissionTitle({ description: line });
  assert.equal(title, "The walk-in freezer has failed overnight.");
  assert.ok(title.length <= SUBMISSION_TITLE_MAX);
  assert.ok(!title.endsWith("…"), "a clean sentence break needs no ellipsis");
});

test("the LAST sentence break inside the budget wins, not the first", () => {
  /*
   * Taking the first is exactly how "Leak. Started yesterday" became "Leak".
   * Greedy is what makes the cut land as late as it usefully can.
   */
  const line =
    "Water leak. Ceiling tiles are down in the corridor. Customers are being kept out " +
    "of that half of the shop until it is made safe again.";
  assert.equal(
    submissionTitle({ description: line }),
    "Water leak. Ceiling tiles are down in the corridor.",
  );
});

test("a very short sentence break is ignored — 'Hi.' is not a job title", () => {
  const line =
    "Hi. The condenser unit on the roof has been rattling for three days and now it " +
    "has started tripping the breaker every couple of hours.";
  const title = submissionTitle({ description: line });
  assert.notEqual(title, "Hi.");
  assert.ok(title.endsWith("…"), `a line with no usable break is truncated: ${title}`);
  assert.ok(title.length <= SUBMISSION_TITLE_MAX);
});

test("a long line with no punctuation at all is truncated with an ellipsis", () => {
  const line = "a".repeat(200);
  const title = submissionTitle({ description: line });
  assert.equal(title.length, SUBMISSION_TITLE_MAX - 3 + 1, "77 characters plus the ellipsis");
  assert.ok(title.endsWith("…"));
});

test("nothing usable falls back rather than producing an untitled row", () => {
  /* `title` is NOT NULL on the board, and an untitled row is a row nobody can
     find again. */
  assert.equal(submissionTitle({ description: "" }), "Maintenance request");
  assert.equal(submissionTitle({ description: "   \n  \n " }), "Maintenance request");
  assert.equal(submissionTitle({}), "Maintenance request");
  assert.equal(submissionTitle({ description: null }), "Maintenance request");
});

/* ── 2. The order of authority ─────────────────────────────────────────── */

test("an explicit title beats everything else", () => {
  assert.equal(
    submissionTitle({
      explicit: "Replace the shutter motor",
      template: "{category} at {site}",
      templateValues: { category: "Doors", site: "Aldgate" },
      description: "Something else entirely",
    }),
    "Replace the shutter motor",
  );
});

test("a template beats the description", () => {
  assert.equal(
    submissionTitle({
      template: "{category} — {site}",
      templateValues: { category: "Plumbing & leaks", site: "Aldgate" },
      description: "Water coming through the ceiling",
    }),
    "Plumbing & leaks — Aldgate",
  );
});

test("a template that renders to nothing falls through to the description", () => {
  /* A mistyped template must never produce an untitled job. */
  assert.equal(
    submissionTitle({
      template: "{sight}",
      templateValues: { site: "Aldgate" },
      description: "Water coming through the ceiling",
    }),
    "Water coming through the ceiling",
  );
});

/* ── 3. The template renderer ──────────────────────────────────────────── */

test("an unknown placeholder renders as nothing, never as its own braces", () => {
  assert.equal(renderTitleTemplate("{sight} fault", { site: "Aldgate" }), "fault");
});

test("an empty placeholder does not leave a dangling separator", () => {
  assert.equal(renderTitleTemplate("{category} — {site}", { category: "Glazing" }), "Glazing");
  assert.equal(renderTitleTemplate("{category} — {site}", { site: "Aldgate" }), "Aldgate");
});

test("a rendered template is capped like every other title", () => {
  const long = renderTitleTemplate("{site}", { site: "x".repeat(300) });
  assert.equal(long.length, SUBMISSION_TITLE_MAX);
});

/* ── 4. The public form's own defect ───────────────────────────────────── */

test("the P-code blob no longer decides what a website report is called", async () => {
  /*
   * THE MEASURED DEFECT. `app/(marketing)/_sections/report-job.tsx` assembles a
   * five-line description whose FIRST line is the urgency band, so every report
   * the public form has ever filed was titled
   * "[P1] Critical, site unsafe or cannot trade" — the same words on every P1 in
   * the workspace, naming the urgency and never the fault.
   *
   * The blob is deliberately unchanged; the page now sends a `title` alongside
   * it. Both halves are asserted: the derivation would still produce the P-code
   * line, and the page no longer relies on the derivation.
   */
  const blob = [
    "[P1] Critical, site unsafe or cannot trade",
    "Water is coming through the ceiling above the till.",
    "Site address: 12 High Street, E1 6AN",
    "Preferred access: after 6pm",
    "Reported by A Manager · manager@example.com",
  ].join("\n");
  assert.equal(
    submissionTitle({ description: blob }),
    "[P1] Critical, site unsafe or cannot trade",
    "the derived title is still the P-code line — which is why the page sends one",
  );

  const page = await read("app/(marketing)/_sections/report-job.tsx");
  assert.match(
    page,
    /const title = \[category, summary \|\| "fault reported from the website"\]/,
    "the page must name the job from the category and the reporter's own sentence",
  );
  assert.match(page, /\n {10}title,\n/, "and must send it with the submission");
  assert.match(
    page,
    /`\[\$\{urgency\}\] \$\{chosen\?\.label\.replace\(\/\^P\\d — \/, ""\) \?\? ""\}`/,
    "while the P-code stays at the top of the description, where triage reads it",
  );
});

/* ── 5. One rule, not four ─────────────────────────────────────────────── */

test("no intake path carries a title rule of its own any more", async () => {
  for (const file of [
    "app/api/maintenance/route.ts",
    "app/api/report-job/route.ts",
    "app/api/forms/[token]/submit/route.ts",
    "app/api/board/items/route.ts",
    "app/(app)/portal/raise-ticket.tsx",
  ]) {
    const source = await read(file);
    assert.doesNotMatch(
      source,
      /function requestTitle\(/,
      `${file} must not keep a private copy of the title rule`,
    );
    assert.doesNotMatch(
      source,
      /\.slice\(0, 69\)|\.slice\(0, 77\)/,
      `${file} must not restate the truncation`,
    );
  }
});

test("the rule module stays free of anything a browser cannot hold", async () => {
  const source = await read("app/lib/submission-title.ts");
  for (const forbidden of [/from "drizzle-orm"/, /db\/schema/, /from "\.\/tenant-db"/]) {
    assert.doesNotMatch(
      source,
      forbidden,
      "the raise-a-job dialog imports this — a server-only import breaks the client bundle",
    );
  }
});
