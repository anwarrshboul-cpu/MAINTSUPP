/**
 * Stage 31 — monday-parity attachment cells.
 *
 * THE RULES THIS FILE EXISTS TO HOLD
 *
 *  1. EVERY THUMBNAIL IS ITS OWN FILE. Hovering tile 2 previews file 2 —
 *     nothing anywhere may fall back to files[0], and every action (open,
 *     download, delete) targets the exact file it was invoked on.
 *
 *  2. THE "+N" LIST IS EXACTLY THE HIDDEN FILES. Matched by id against the
 *     visible tiles, never sliced by index, and ordered by the SAME
 *     (createdAt, id) comparator the board payload uses — so the strip and
 *     the list cannot disagree about who is hidden.
 *
 *  3. THE LARGE PREVIEW IS NEVER A BLOWN-UP CROP. Tiles use the 96px WebP
 *     derivative; the card uses the original at its own aspect ratio; new
 *     uploads get a derivative made client-side, best-effort.
 *
 * Source-text tests, like the rest of the suite. The behaviour itself was
 * verified in a real browser (five distinct images: per-tile hover, +N list,
 * hidden/visible deletes redistributing live, open/download/delete on exact
 * files, dark theme, touch).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
/* The fixes narrate the failure they removed, so negative assertions must not
   trip on their own explanation. */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const MANAGER = "app/(app)/portal/evidence-manager.tsx";

/* ── 1. Per-file identity ────────────────────────────────────────────────── */

test("each tile opens a card for its OWN file", async () => {
  const manager = await read(MANAGER);
  /* The tile map hands ITS file to the opener… */
  assert.match(
    manager,
    /preview\.slice\(0, visibleTiles\)\.map\(\(file\) => \(\s*<span\s+className="sheet-file-cell__media-tile"/,
    "tiles are rendered per preview entry",
  );
  assert.match(
    manager,
    /openAt\(event\.currentTarget, \{ target: "file", file \}\)/,
    "a tile's hover carries the tile's own file",
  );
  /* …and the card renders only that identity — never a files[0] fallback. */
  const component = stripComments(
    manager.slice(manager.indexOf("export function FileHoverPreview")),
  );
  assert.doesNotMatch(
    component,
    /files\[0\]/,
    "nothing in the cell may fall back to the first file",
  );
  assert.match(component, /hover\?\.target === "file" \? hover\.file : null/);
});

test("every action targets the exact file it was invoked on", async () => {
  const manager = await read(MANAGER);
  const act = manager.slice(manager.indexOf("const fileAct"), manager.indexOf("const visibleIds"));
  assert.match(act, /const inlineUrl = `\/api\/files\/\$\{file\.id\}`/);
  assert.match(act, /`\/api\/files\/\$\{file\.id\}\?download=1`/);
  /*
   * The confirm names the file it was invoked on — still the point of this
   * assertion — but by the name the rest of the product uses for it.
   *
   * It used to pin `file.originalName`, which was right while nothing could
   * rename a document. W07-02 can: `documentName` in
   * app/(app)/portal/views/document-register.ts is the one rule that decides
   * what a document is called (the title when somebody set one, the stored
   * filename otherwise), and a dialog offering to destroy "IMG_7560.jpeg"
   * when every surface around it says "Highcross completion photo" is asking
   * about a document the reader cannot identify. `documentName(file)` still
   * reads THIS file's own identity, which is what rule 1 of this file is for.
   */
  assert.match(act, /window\.confirm\(`Delete \$\{documentName\(file\)\}/);
  assert.doesNotMatch(act, /\$\{file\.originalName\}\? This cannot be undone/);
  assert.match(act, /maintsupp:refresh-board/, "delete repaints the board, no reload");
  assert.doesNotMatch(manager, /window\.location\.reload/);
});

/* ── 2. The overflow list ────────────────────────────────────────────────── */

test("the +N list holds exactly the hidden files, in strip order", async () => {
  const manager = await read(MANAGER);
  /* Hidden = not visible, matched by id — an index slice could repeat a file. */
  assert.match(
    manager,
    /const visibleIds = new Set\(preview\.slice\(0, visibleTiles\)\.map\(\(file\) => file\.id\)\)/,
  );
  assert.match(manager, /allFiles\?\.filter\(\(file\) => !visibleIds\.has\(file\.id\)\)/);
  /* One comparator, stated once, used for the fetch — (createdAt, id). */
  assert.match(manager, /function stripOrder\(/);
  assert.match(manager, /\.sort\(stripOrder\)/);
  /* The cache dies when the strip changes, so the list never goes stale. */
  assert.match(manager, /const stripSignature = `\$\{count\}:\$\{preview\.map\(\(file\) => file\.id\)\.join\(","\)\}`/);
});

test("the board payload merges kind-filed and column-filed rows into one order", async () => {
  const route = await read("app/api/board/route.ts");
  /* The kind union gained the id tiebreak… */
  assert.match(route, /\.orderBy\(asc\(attachments\.createdAt\), asc\(attachments\.id\)\)/);
  /* …and mixed cells are re-sorted and re-capped, not appended. */
  const merge = route.slice(route.indexOf("const mixed = new Set"));
  assert.match(merge.slice(0, 1600), /entry\.preview\.sort\(/);
  assert.match(merge.slice(0, 1700), /Math\.min\(entry\.preview\.length, 4\)/);

  const files = await read("app/api/files/route.ts");
  /*
   * Still newest-first with the id tiebreak, but the call is now a conditional
   * spread: a version history reads OLDEST first, because v1 to v4 is the order
   * the versions happened in and the order a person reads a document's story.
   * The tiebreak matters more than it did — with paging, an unstable order means
   * page 2 can repeat a row from page 1 and drop another entirely.
   */
  assert.match(
    files,
    /\[desc\(attachments\.createdAt\), desc\(attachments\.id\)\]/,
    "the file index needs the same tiebreak or same-second batches reorder per query",
  );
  assert.match(
    files,
    /\[asc\(attachments\.versionNo\), asc\(attachments\.id\)\]/,
    "and a version history must read oldest-first, by version number",
  );
});

/* ── 3. Derivatives and the large preview ────────────────────────────────── */

test("tiles use the derivative; the card and list never blow up a crop", async () => {
  const manager = await read(MANAGER);
  const component = manager.slice(manager.indexOf("export function FileHoverPreview"));
  /* Strip tiles and overflow rows: ?thumb=1. The card pane: the original. */
  const cardPane = component.slice(
    component.indexOf('className="sheet-file-hover__preview"'),
    component.indexOf('className="sheet-file-hover__more"'),
  );
  assert.match(cardPane, /src=\{`\/api\/files\/\$\{hoveredFile\.id\}`\}/);
  assert.doesNotMatch(cardPane, /thumb=1/, "the large preview must never be the 96px centre-crop");
  /* Video: metadata only until the person presses play. */
  assert.match(cardPane, /preload="metadata"/);
  assert.match(cardPane, /controls/);
  assert.doesNotMatch(cardPane, /autoPlay/i);
});

test("a fresh upload gets a client-made WebP derivative, best-effort", async () => {
  const upload = await read("app/lib/client-upload.ts");
  assert.match(upload, /async function offerThumbnail/);
  /* Same recipe as the offline script: 96px, centre-crop cover, WebP. */
  assert.match(upload, /const THUMBNAIL_EDGE = 96/);
  assert.match(upload, /toBlob\(resolve, "image\/webp", 0\.72\)/);
  /* Best-effort is load-bearing: no failure here may fail the upload. */
  assert.match(upload, /if \(!blob \|\| !blob\.type\.includes\("webp"\) \|\| blob\.size > 512 \* 1024\) return;/);
  const fn = upload.slice(upload.indexOf("async function offerThumbnail"));
  assert.match(fn.slice(0, 2400), /catch \{/, "a missing derivative costs bytes, never correctness");
});

test("both stored objects are served immutable — ids are never rewritten", async () => {
  const route = stripComments(await read("app/api/files/[id]/route.ts"));
  assert.match(route, /headers\.set\("Cache-Control", "private, max-age=86400, immutable"\)/);
  assert.doesNotMatch(route, /max-age=300/, "the five-minute refetch of originals is gone");
});

/* ── 4. The floating surfaces ────────────────────────────────────────────── */

test("the overflow list is a portalled, positioned surface in both themes", async () => {
  const css = await read("app/globals.css");
  const block = css.slice(css.indexOf(".sheet-file-overflow {"));
  assert.match(block.slice(0, 500), /position: fixed;/);
  assert.match(block.slice(0, 500), /z-index: var\(--z-dropdown\);/);
  /* Flip anchor: above by default, below when the row is near the top. */
  assert.match(css, /\.sheet-file-overflow:not\(\.is-below\) \{\s*transform: translateY\(-100%\);/);
  /* Dark parity in BOTH dark paths — the OS preference and the toggle.
     (`\r?\n`, because a CRLF checkout must not turn this into a no-op.) */
  assert.match(
    css,
    /\.sheet-file-hover__preview,\r?\n\s*\.sheet-file-overflow,/,
    "the globals dark block lists the overflow surface",
  );
  const brand = await read("app/brand-overrides.css");
  assert.match(brand, /\.sheet-file-overflow,/, "the data-theme dark list includes the overflow surface");
  /* And the deferred-group containment escape hatch names it. */
  const visibility = await read("app/(app)/portal/board-visibility.css");
  assert.match(visibility, /\.sheet-file-overflow,\s*\n?\s*\.sheet-file-menu\s*\n?\s*\)/);
});

/* ── 5. The per-file "…" menu ────────────────────────────────────────────── */

test("every '…' opens the menu for its OWN file, and every verb acts on it", async () => {
  const manager = await read(MANAGER);
  /* The card's corner "…" carries the card's file… */
  assert.match(manager, /toggleMenuAt\(event\.currentTarget, hoveredFile\)/);
  /* …and each overflow row's "…" carries that row's file. */
  const rows = manager.slice(manager.indexOf("hiddenFiles.map"));
  assert.match(rows.slice(0, 1600), /toggleMenuAt\(event\.currentTarget, file\)/);
  /* Toggling is by id — the same "…" closes its own menu, nothing else's. */
  assert.match(manager, /if \(menu\?\.file\.id === file\.id\) \{\s*setMenu\(null\);/);
  /* The verbs read the menu's file, never an index, never files[0]. */
  const menuBlock = manager.slice(manager.indexOf('className="sheet-file-menu"'));
  assert.match(menuBlock, /const chosen = menu\.file;\s*setMenu\(null\);\s*fileAct\(chosen, "open"\)/);
  assert.match(menuBlock, /const chosen = menu\.file;\s*setMenu\(null\);\s*fileAct\(chosen, "download"\)/);
  assert.match(menuBlock, /const chosen = menu\.file;\s*setMenu\(null\);\s*fileAct\(chosen, "delete"\)/);
  /* Only real verbs: monday's versioning/updates/extract have no backend here. */
  assert.doesNotMatch(menuBlock, /file versions|Post updates|Extract data/i);
  /* The menu is a fixed, portalled surface, styled in BOTH dark paths. */
  const css = await read("app/globals.css");
  const menuCss = css.slice(css.indexOf(".sheet-file-menu {"));
  assert.match(menuCss.slice(0, 400), /position: fixed;/);
  assert.match(css, /\.sheet-file-overflow,\r?\n\s*\.sheet-file-menu,/, "the media-query dark list names the menu");
  const brand = await read("app/brand-overrides.css");
  assert.match(brand, /\.sheet-file-menu,/, "the data-theme dark list names the menu");
});

/* ── 6. monday's visible-thumbnail rule — measured, not assumed ──────────── */

test("the strip fits tiles to its measured width and folds the rest into +N", async () => {
  const manager = await read(MANAGER);
  /* One shared observer feeds every strip its width, live during a resize. */
  assert.match(manager, /new ResizeObserver/);
  assert.match(manager, /stripCallbacks\.get\(entry\.target\)\?\.\(entry\.contentRect\.width\)/);
  /* The rule: fit plainly, else reserve the badge's slot and fold behind it. */
  assert.match(manager, /Math\.floor\(\(stripWidth \+ TILE_GAP\) \/ tileSpan\)/);
  assert.match(manager, /Math\.floor\(\(stripWidth - BADGE_RESERVE \+ TILE_GAP\) \/ tileSpan\)/);
  assert.match(manager, /const badgeCount = count - visibleTiles/);
  assert.match(manager, /\+\{badgeCount\}/);
  /* Touch parity: a tap opens the tile's own surface, not the manage panel. */
  assert.match(manager, /event\.pointerType !== "mouse"/);
  assert.match(manager, /touchTapRef\.current = true;\s*openAt\(event\.currentTarget, \{ target: "file", file \}\)/);
  assert.match(manager, /touchTapRef\.current = true;\s*openAt\(event\.currentTarget, \{ target: "overflow" \}\)/);
});
