/**
 * PRE-W14 PHASE 1 — the four targeted UI changes, pinned.
 *
 * Each of these replaced a specific reported defect, and each defect is the
 * kind that comes back the moment somebody edits nearby code for an unrelated
 * reason. The assertions therefore pin the CONTRACT — "a thumbnail is not a
 * link", "the widths do not live only in the header row" — rather than the
 * spelling of any one line, so a refactor that keeps the behaviour keeps the
 * test.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

/* Comments describe the bug; they must not be mistaken for the code that fixed
   it. Every assertion below runs against the source with comments removed. */
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ------------------------------------------------------------------ 1A */

test("1A: a submitted photo on the public job link opens in the page, not away from it", async () => {
  const source = codeOnly(await read("app/(public)/j/[token]/contractor-job-view.tsx"));

  assert.doesNotMatch(
    source,
    /<a\s[^>]*href=\{photo\./,
    "a thumbnail must not be an anchor to the file — that is the defect: it navigates the contractor off a page holding an unsaved note, name and signature",
  );
  assert.doesNotMatch(
    source,
    /target="_blank"[\s\S]{0,200}photo\.thumbUrl/,
    "no thumbnail may open a new tab",
  );
  assert.match(
    source,
    /<button[\s\S]{0,300}onClick=\{\(\) => setOpenId\(photo\.id\)\}/,
    "tapping a thumbnail must set the open picture, in this page's own state",
  );
  assert.match(
    source,
    /<MediaViewer/,
    "it must be THE viewer, not a second implementation that can drift from the portal's",
  );
  assert.match(
    source,
    /from "\.\.\/\.\.\/\.\.\/\(app\)\/portal\/media-viewer"/,
    "imported from the one place it is defined",
  );
  assert.doesNotMatch(
    source,
    /<MediaViewer[^>]*[\s\S]{0,400}?onDelete=/,
    "nobody holding a public job link may delete evidence from it",
  );
});

test("1A: the job-link payload carries what the viewer captions with", async () => {
  const source = codeOnly(await read("app/api/job-link/[token]/route.ts"));
  for (const field of ["title", "byteSize", "createdAt"]) {
    assert.ok(
      new RegExp(`${field}: attachments\\.${field}`).test(source),
      `the photo payload must select ${field}, or the viewer captions a renamed file with the wrong name or an empty size`,
    );
  }
  assert.match(
    source,
    /downloadUrl: `\/api\/files\/\$\{photo\.id\}\?download=1&token=\$\{carried\}`/,
    "the download URL is composed once here, beside the other two, so the token convention stays in one function",
  );
});

test("1A: closing the viewer with Back does not leave the page", async () => {
  const source = codeOnly(await read("app/(app)/portal/media-viewer.tsx"));
  assert.match(source, /window\.history\.pushState\(/, "opening must push an entry for Back to spend");
  assert.match(source, /addEventListener\("popstate"/, "Back must be heard");
  assert.match(
    source,
    /if \(!closedByPop\) window\.history\.back\(\);/,
    "closing any other way must spend the entry, or Back needs two presses to leave the page",
  );
  assert.match(
    source,
    /onCloseRef\.current = onClose;/,
    "the history effect reads onClose through a ref so an inline arrow cannot push a second entry per render",
  );
});

/* ------------------------------------------------------------------ 1B */

test("1B: the phone board draws one column header row, not one per group", async () => {
  const board = codeOnly(await read("app/(app)/portal/live-board.tsx"));
  assert.match(
    board,
    /<MobileBoardStickyHeader[\s\S]{0,200}active=\{isMobile\}/,
    "the single header row is mounted above the canvas and is a phone-only surface",
  );
  assert.match(
    board,
    /columns=\{visibleBoardColumns\}/,
    "it must read the same column array the grid draws, so a column added, removed, renamed or reordered moves with it",
  );

  const css = await read("app/globals.css");
  const block = css.slice(css.indexOf("ONE COLUMN HEADER ROW ON A PHONE"));
  assert.match(
    block,
    /\.sheet-group \.live-sheet > thead \{[^}]*clip-path: inset\(50%\)/,
    "the per-group header rows must be visually hidden, NOT display:none — that would take every column name out of the accessibility tree",
  );
  assert.doesNotMatch(
    block,
    /\.sheet-group \.live-sheet > thead \{[^}]*display: none/,
    "display:none on a thead is an accessibility regression, not a layout fix",
  );
});

test("1B: hiding the header row cannot collapse a fixed-layout grid", async () => {
  const header = codeOnly(await read("app/(app)/portal/board-mobile-header.tsx"));
  assert.match(
    header,
    /<colgroup>/,
    "widths must live in a colgroup: `.live-sheet` is table-layout:fixed and takes its widths from the first row, which is the row being hidden",
  );
  assert.match(
    header,
    /displayedBoardColumnWidth\(entry\.column, mobile\)/,
    "the colgroup must use the one width rule, not a second copy of it",
  );

  const board = codeOnly(await read("app/(app)/portal/live-board.tsx"));
  assert.match(
    board,
    /<BoardColumnWidths columns=\{visibleBoardColumns\} mobile=\{isMobile\} \/>/,
    "every group table needs the widths, at every viewport",
  );
});

test("1B: the sticky row names the group under it, in the frozen cell", async () => {
  const header = codeOnly(await read("app/(app)/portal/board-mobile-header.tsx"));
  assert.match(
    header,
    /entry\.kind === "system" && entry\.key === "name"/,
    "the group name belongs in the column that is frozen to the left edge, chosen by identity — not at index 0, which is only the Items column until somebody reorders",
  );
  assert.match(
    header,
    /naming \? current\.name : entry\.column\.title/,
    "one cell carries the group name; every other cell carries its column's own title",
  );
  assert.match(
    header,
    /"sheet-column--name board-mobile-head__group"/,
    "it must carry the class the stylesheet freezes, or it scrolls off the left edge",
  );
  assert.match(
    header,
    /getBoundingClientRect\(\)\.bottom/,
    "the current group is the last one whose top has passed the BOTTOM of the sticky row — judging against the scroller's top names a group for the 38px it spends hidden behind the row",
  );
});

test("1B: the phone header borrows the board's theming instead of restating it", async () => {
  const css = await read("app/globals.css");
  const block = css.slice(css.indexOf("ONE COLUMN HEADER ROW ON A PHONE"));
  /* The row's table carries `.live-sheet`, so the themed rules for
     `.live-sheet th` already paint it in both themes. Restating a literal here
     is how the dark phone board ends up with a near-white header row. */
  const cells = block.match(/\.board-mobile-head[^{]*\{[^}]*\}/g) ?? [];
  for (const rule of cells) {
    assert.doesNotMatch(
      rule,
      /(?:color|background)\s*:\s*#[0-9a-fA-F]{3,8}\s*;/,
      `a literal colour in "${rule.split("{")[0].trim()}" — the header must inherit .live-sheet's themed rules, and only a token or var() may appear here`,
    );
  }
  assert.match(
    block,
    /\.board-mobile-head__group > span \{[\s\S]*?color: var\(--group-color, inherit\)/,
    "the group's own colour is data, not theme, and goes on the span where nothing else is competing for it",
  );
});

test("1B: the phone board keeps to the agreed breakpoints", async () => {
  const css = await read("app/globals.css");
  const block = css.slice(css.indexOf("ONE COLUMN HEADER ROW ON A PHONE"));
  for (const query of block.match(/@media[^{]+/g) ?? []) {
    const width = Number(query.match(/(\d+)px/)?.[1]);
    assert.ok(
      width === 760,
      `${query.trim()} — the phone board's boundary is 760px, the one every other board rule uses`,
    );
  }
});

/* ------------------------------------------------------------------ 1D */

test("1D: the landing page shows contact details at the top on a phone", async () => {
  const css = await read("app/(marketing)/marketing.css");
  assert.doesNotMatch(
    css,
    /@media\(max-width:680px\)\{\.utility__contact\{display:none\}\}/,
    "hiding the number and the address on a phone is the defect — they were reachable only by scrolling the whole page to the footer",
  );
  assert.match(
    css,
    /\.utility__contact\{flex:1 1 100%/,
    "contact takes its own row so the bar wraps instead of dropping half of itself",
  );
  assert.match(css, /\.utility__label\{display:none\}/, "the label is drawn on a phone only");

  const chrome = codeOnly(await read("app/(marketing)/_sections/chrome.tsx"));
  assert.match(chrome, /<span className="utility__label">Contact Us<\/span>/);
  assert.match(chrome, /href="tel:\+447852224644"/, "the real number, not an invented one");
  assert.match(chrome, /href="mailto:info@maintsupp\.com"/, "the real address, not an invented one");
  for (const kept of ['href="/portal"', 'href="#report"']) {
    assert.ok(chrome.includes(kept), `${kept} must survive — the bar gained a row, it did not lose one`);
  }
});

test("1D: the marketing breakpoint set did not grow to buy the contact row", async () => {
  const css = await read("app/(marketing)/marketing.css");
  const widths = new Set(
    (css.match(/@media[^{]*?\((?:min|max)-width:\s*(\d+)px\)/g) ?? []).map((q) =>
      Number(q.match(/(\d+)px/)[1]),
    ),
  );
  assert.ok(widths.size <= 28, `${widths.size} distinct breakpoints; the cap is 28`);
  assert.ok(widths.has(680), "the contact row reuses the width the hide rule already used");
});
