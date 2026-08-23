/**
 * UI batch — the contractor job page (/j/<token>), pinned.
 *
 * Two things from the review. The file pickers and the typed inputs ran past
 * the right edge of their card, and the form offered two ways to send the
 * same thing ("Send this update" beside "Mark work complete"). The first is
 * a box-model fix; the second is one Submit.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
/* JSX and block comments out, so a label that survives only in a comment
   explaining its removal does not read as a label. */
const stripComments = (source) =>
  source.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const VIEW = "app/(public)/j/[token]/contractor-job-view.tsx";
const CSS = "app/(public)/j/[token]/job-link.css";
const ROUTE = "app/api/job-link/[token]/route.ts";

test("every control on the contractor page is border-box, so 100% means 100%", async () => {
  const css = await read(CSS);
  /*
   * The public route group loads no reset, so the page was content-box: a
   * `width: 100%` input plus its own padding and border ran 22–26px past the
   * card on every width. The box model is the fix, not a narrower width.
   */
  assert.match(css, /\.job-link,\s*\.job-link \*,\s*\.job-link \*::before,\s*\.job-link \*::after \{\s*box-sizing: border-box;/);
  assert.match(css, /\.job-link input\[type="file"\] \{[^}]*max-width: 100%;/);
  assert.match(css, /\.job-link__card \{\s*min-width: 0;\s*max-width: 100%;\s*overflow-wrap: anywhere;/);
  assert.match(css, /\.job-link__uploads li \{\s*overflow-wrap: anywhere;/, "a long filename wraps rather than widening the card");
});

test("one Submit, and it carries everything the two buttons used to", async () => {
  const view = stripComments(await read(VIEW));
  assert.ok(!view.includes("Send this update"), "the separate note action is gone");
  assert.ok(!view.includes("Mark work complete"), "renamed");
  assert.match(view, /onClick=\{\(\) => void submit\(\)\}\s*>\s*Submit\s*<\/button>/, "the single primary action");
  assert.equal((view.match(/className="job-link__primary"/g) ?? []).length, 2, "Submit, and the Send inside the blocked panel");

  /* Completion when the link allows it; the note path when it only allows comments. */
  assert.match(view, /if \(data\.permissions\.canRequestCompletion\) \{[\s\S]{0,600}await send\("complete"\);/);
  assert.match(view, /await send\("note"\);\s*\}/);
  /* The payload of a completion still carries the note, the date and the signature. */
  const body = view.slice(view.indexOf("body: JSON.stringify({"), view.indexOf("body: JSON.stringify({") + 500);
  assert.match(body, /intent,\s*note,\s*by: name,\s*completedOn,/);
  assert.match(body, /\.\.\.\(intent === "complete" && signature \? \{ signature \} : \{\}\),/);

  /* The evidence rule is enforced — on the page first, and by the server regardless. */
  assert.match(view, /Please upload a photo of the completed work before marking this done\./);
  const route = await read(ROUTE);
  assert.match(route, /Please upload a photo of the completed work before marking this done\./);
  /* And the server folds the note and the date into the comment on completion. */
  assert.match(route, /completionUpdate\(note, finishedOn\)/);

  /* The failure path is separate and unchanged. */
  assert.match(view, /I could not complete this/);
  assert.match(view, /void send\("blocked"\)/);
});
