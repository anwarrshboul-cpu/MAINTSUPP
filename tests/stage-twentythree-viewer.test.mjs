import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const VIEWER = "app/(app)/portal/media-viewer.tsx";
const VIEWER_CSS = "app/(app)/portal/media-viewer.css";
const MANAGER = "app/(app)/portal/evidence-manager.tsx";
const BOARD_CELL = "app/(app)/portal/cells/board-file-cell.tsx";

/**
 * Stage 23 — opening a photograph, the way monday opens one.
 *
 * The complaint was about a phone: "revise the mobile view, specially when you
 * open a comment or a photo". What was there was a modal card — a light panel
 * inset from the edges of the screen with the picture squeezed inside it, no
 * swipe, no zoom, and `src` pointed at the original, so tapping one of the
 * 4 MB camera JPEGs on this estate showed a grey box for as long as the
 * download took.
 *
 * These tests pin the four decisions that are easy to undo by accident:
 * the surface is full-screen and dark, the thumbnail is painted before the
 * original, a file that is not a picture never reaches an `<img>`, and the
 * viewer can be driven and left by keyboard alone.
 *
 * The data-backed tests read the local D1 file directly. It is a development
 * artefact, so they skip rather than fail when it is absent — the same bargain
 * `stage-thirteen-css-split` and `stage-twentytwo-fix-tracker` make.
 */

const D1 =
  ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/faaf2b0445ab934c3aac48ddf0cdfade8f9bac050be98993748742cdd2cb05fb.sqlite";

async function openBoardDatabase() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null; // Older Node without the built-in driver.
  }
  try {
    return new DatabaseSync(path.join(root, D1), { readOnly: true });
  } catch {
    return null; // No seeded development database on this machine.
  }
}

/* ── 1. Full-screen, not a card ─────────────────────────────────────────── */

test("the viewer is a full-screen dark surface, not an inset modal", async () => {
  const css = await read(VIEWER_CSS);

  assert.match(
    css,
    /\.mv-root \{[^}]*position: fixed;[^}]*inset: 0;/s,
    "the root must cover the viewport, not sit inset from it",
  );
  // The old viewer's stage was `#e8edef` on a `#f4f6f7` panel. A lightbox is
  // dark because the photograph is the light in it.
  assert.match(
    css,
    /\.mv-root \{[^}]*background: #04080b;/s,
    "the surface must be dark, and opaque — the panel behind must not read through it",
  );
  assert.doesNotMatch(
    css,
    /\.mv-root[^{]*\{[^}]*inset: \d+px/s,
    "nothing in this viewer may be inset from the edges of the screen",
  );
});

test("the old inset viewer markup is gone from the evidence manager", async () => {
  const manager = await read(MANAGER);

  for (const dead of [
    "evidence-viewer__scrim",
    "evidence-viewer__stage",
    "evidence-viewer__previous",
    "evidence-viewer__next",
    "evidence-viewer__document",
  ]) {
    assert.doesNotMatch(
      manager,
      new RegExp(dead),
      `${dead} belonged to the modal card the full-screen viewer replaced`,
    );
  }
  assert.match(
    manager,
    /<MediaViewer\b/,
    "the evidence manager must open the shared viewer",
  );
});

/* ── 2. The thumbnail first, the original second ────────────────────────── */

test("a picture paints its 96px derivative before the original arrives", async () => {
  const viewer = await read(VIEWER);

  assert.match(
    viewer,
    /function thumbUrl\(inlineUrl: string\) \{\s*return `\$\{inlineUrl\}\$\{inlineUrl\.includes\("\?"\) \? "&" : "\?"\}thumb=1`;/,
    "the thumbnail URL must be built from the inline URL, query-safe",
  );
  assert.match(
    viewer,
    /className=\{`mv-image mv-image--thumb\$\{fullLoaded \? " is-hidden" : ""\}`\}\s*src=\{thumbUrl\(file\.inlineUrl\)\}/,
    "the derivative is drawn first and hidden once the original has decoded",
  );
  assert.match(
    viewer,
    /onLoad=\{\(\) => setFullLoaded\(true\)\}/,
    "the swap must be driven by the original's load event, not by a timer",
  );

  // The grid behind the viewer had the same fault: 155px tiles pointed at
  // full-size originals.
  const manager = await read(MANAGER);
  assert.match(
    manager,
    /src=\{`\/api\/files\/\$\{file\.id\}\?thumb=1`\}/,
    "the evidence grid must draw thumbnails, not originals",
  );
});

test("both neighbours are mounted, so a swipe has somewhere to go", async () => {
  const viewer = await read(VIEWER);
  assert.match(
    viewer,
    /\[index - 1, index, index \+ 1\]/,
    "the track carries the previous, current and next file",
  );
});

/* ── 3. A file that is not a picture never reaches an <img> ─────────────── */

test("non-images are routed away from the image viewer", async () => {
  const viewer = await read(VIEWER);

  assert.match(
    viewer,
    /export function isViewableMedia\(contentType: string\) \{\s*return contentType\.startsWith\("image\/"\) \|\| contentType\.startsWith\("video\/"\);/,
    "only pictures and video may be shown on the stage",
  );
  assert.match(
    viewer,
    /if \(file\.contentType === "application\/pdf"\) \{\s*return \{ mode: "tab", href: file\.inlineUrl \};/,
    "a PDF opens in its own tab, where the browser's reader can page it",
  );
  assert.match(
    viewer,
    /return \{ mode: "download", href: file\.downloadUrl \};/,
    "anything else downloads",
  );
});

test("the viewer can only page through pictures and video", async () => {
  const manager = await read(MANAGER);
  assert.match(
    manager,
    /visibleFiles\.filter\(\(file\) => isViewableMedia\(file\.contentType\)\)/,
    "a swipe must never land on a Word document rendered as a broken image",
  );
  assert.match(
    manager,
    /const target = openTargetFor\(file\);/,
    "the grid must route a tap by the file's type",
  );
});

test("a file with no picture of its own keeps its own glyph", async () => {
  const viewer = await read(VIEWER);
  for (const [type, glyph] of [
    ["application/pdf", "document"],
    ["spreadsheet", "grid"],
    ["zip", "folder"],
  ]) {
    assert.ok(
      new RegExp(`${type}[\\s\\S]{0,120}return "${glyph}"`).test(viewer),
      `${type} must not fall back to the generic square`,
    );
  }
});

/* ── 4. Touch: swipe, pinch, double-tap ─────────────────────────────────── */

test("the stage handles pointers itself and takes the gestures from the browser", async () => {
  const viewer = await read(VIEWER);
  const css = await read(VIEWER_CSS);

  for (const handler of [
    "onPointerDown={handlePointerDown}",
    "onPointerMove={handlePointerMove}",
    "onPointerUp={handlePointerUp}",
    "onPointerCancel={handlePointerCancel}",
  ]) {
    assert.ok(viewer.includes(handler), `the stage needs ${handler}`);
  }
  assert.match(
    css,
    /\.mv-stage \{[^}]*touch-action: none;/s,
    "a native page pinch over the top of the viewer's own pinch is the worst thing a phone lightbox can do",
  );
  assert.match(
    viewer,
    /Math\.hypot\(first\.x - second\.x, first\.y - second\.y\)/,
    "two fingers must be measured against each other for pinch",
  );
  assert.match(
    viewer,
    /now - gesture\.lastTapAt < DOUBLE_TAP_WINDOW/,
    "double-tap zoom",
  );
  assert.match(
    viewer,
    /gesture\.axis === "x" && Math\.abs\(x\) > SWIPE_DISTANCE/,
    "a horizontal swipe changes the picture",
  );
});

test("the counter reads position out of total", async () => {
  const viewer = await read(VIEWER);
  assert.match(
    viewer,
    /\{index \+ 1\} of \{files\.length\}/,
    'monday reads "3 of 7"',
  );
  assert.match(
    viewer,
    /className="mv-counter" aria-live="polite"/,
    "the count must be announced when it changes, not only drawn",
  );
});

/* ── 5. Keyboard and focus ──────────────────────────────────────────────── */

test("Esc closes, the arrows navigate, and focus comes back out", async () => {
  const viewer = await read(VIEWER);

  assert.match(viewer, /if \(event\.key === "Escape"\)/, "Esc must close");
  assert.match(
    viewer,
    /event\.stopImmediatePropagation\(\);/,
    "one press closes one surface: the manager underneath listens for Esc too",
  );
  assert.match(viewer, /event\.key === "ArrowLeft"/, "left arrow");
  assert.match(viewer, /event\.key === "ArrowRight"/, "right arrow");
  assert.match(
    viewer,
    /const previous = document\.activeElement as HTMLElement \| null;[\s\S]{0,400}previous\.focus\(\)/,
    "focus must be restored to whatever opened the viewer",
  );
  assert.match(
    viewer,
    /if \(event\.key !== "Tab"\) return;/,
    "Tab must not walk out of a modal surface",
  );
  assert.match(
    viewer,
    /role="dialog"\s*aria-modal="true"/,
    "the surface must announce itself as a modal dialog",
  );
});

test("the manager stands down while the viewer is open", async () => {
  const manager = await read(MANAGER);
  assert.match(
    manager,
    /if \(event\.key === "Escape" && !viewerId\) onClose\(\);/,
    "the panel underneath must not also close on the press that closed the viewer",
  );
});

/* ── 6. Touch targets and reduced motion ────────────────────────────────── */

test("every control clears the 44px touch minimum", async () => {
  const css = await read(VIEWER_CSS);
  assert.match(
    css,
    /\.mv-button \{[^}]*min-width: 44px;[^}]*min-height: 44px;/s,
    "44px is the figure both Apple and WCAG 2.5.5 use, and what the responsive audit measures",
  );
  assert.match(
    css,
    /\.mv-arrow \{[^}]*width: 48px;[^}]*height: 48px;/s,
    "the desktop arrows were 42x52 — under on the axis a thumb misses",
  );
});

test("prefers-reduced-motion turns off the movement, not the viewer", async () => {
  const css = await read(VIEWER_CSS);
  const block = css.match(
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/,
  );
  assert.ok(block, "the viewer must answer prefers-reduced-motion");
  assert.match(block[0], /\.mv-track,/, "the paging slide is decoration");
  assert.match(block[0], /animation: none;/, "so is the spinner");
});

/* ── 7. The board cell on a phone ───────────────────────────────────────── */

test("the hover card is for a mouse, and a tap does not summon it", async () => {
  const manager = await read(MANAGER);

  assert.doesNotMatch(
    manager,
    /onMouseEnter=\{\(\) => setHovered\(true\)\}/,
    "a phone synthesises mouseenter from a tap, and no pointer-out ever follows",
  );
  assert.match(
    manager,
    /if \(event\.pointerType === "mouse"\) setHovered\(true\);/,
    "pointerType is the only reliable way to tell a finger from a mouse",
  );
});

test("a file cell says which column it belongs to", async () => {
  const cell = await read(BOARD_CELL);
  assert.match(
    cell,
    /columnTitle\?: string;/,
    "a row carries two photo columns; both announced themselves as '3 files'",
  );
  assert.match(cell, /columnTitle=\{columnTitle\}/, "and it must be passed on");
});

/* ── 8. Against the estate's own files ──────────────────────────────────── */

test("the routing matters: this estate stores files that are not pictures", async () => {
  const database = await openBoardDatabase();
  if (!database) return;

  const rows = database
    .prepare("select content_type, count(*) as total from attachments group by 1")
    .all();
  database.close();

  const total = rows.reduce((sum, row) => sum + row.total, 0);
  const pictures = rows
    .filter((row) => /^(image|video)\//.test(row.content_type))
    .reduce((sum, row) => sum + row.total, 0);
  const documents = total - pictures;

  assert.ok(total > 2000, `expected the real attachment set, found ${total}`);
  assert.ok(
    documents > 100,
    `${documents} files are not pictures — each one is a broken <img> if the viewer takes it`,
  );
});

test("navigation matters: work orders carry many pictures each", async () => {
  const database = await openBoardDatabase();
  if (!database) return;

  const [busiest] = database
    .prepare(
      `select request_id, count(*) as total from attachments
       where content_type like 'image/%' and request_id is not null
       group by 1 order by total desc limit 1`,
    )
    .all();
  database.close();

  assert.ok(
    busiest && busiest.total > 5,
    "a viewer with no way between pictures is a viewer for a single-photo estate",
  );
});
