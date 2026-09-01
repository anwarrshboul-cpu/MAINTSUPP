/**
 * WORKSTREAM 7, official checklist — WHAT A DOCUMENT IS CALLED, WHAT IT LOOKS
 * LIKE, AND WHAT THE CONTROLS ARE NAMED.
 *
 * Four defects the owner found by hand, and the rules that keep them closed.
 *
 *  BUG 3  A rename reached the Documents register and stopped there. The linked
 *         board cell, the evidence strips, the media viewer and the Site
 *         documents list all printed `original_name` straight off the column,
 *         so one document had two names on two screens the same person moves
 *         between. `documentName` in views/document-register.ts is the ONE rule
 *         that decides, and every surface calls it.
 *
 *  BUG 4  Image documents drew a generic grey glyph. They now draw the picture,
 *         through `GET /api/files/[id]?thumb=1` — the app's one authorised
 *         serving path — and NEVER through a new image service or an R2 URL.
 *
 *  BUG 5  `.document-grid` overflowed its own container on every phone width and
 *         was silently CLIPPED, because `.documents-panel` carries
 *         `overflow: hidden`. `1fr` is `minmax(auto, 1fr)` and that `auto` is a
 *         floor; `minmax(0, 1fr)` removes it.
 *
 *  UI     "Upload new version" named the mechanism and not the act, and the
 *         control behind it hand-rolled its own `fetch` instead of going
 *         through the product's uploader — so a phone photograph, the exact
 *         case the owner reported, hit the 900 KB direct-upload ceiling and
 *         failed with a message that named nothing.
 *
 * Source-text tests, like the rest of this suite. The behaviour was measured in
 * a real browser as well: thumbnails and the icon fallback at 1440 and on six
 * phone widths in both themes; a rename propagating to the register, the drawer
 * and a Store Documentation board chip; a 6.6 MB `IMG_7560.png` replacing a
 * document through the multipart path and getting a 3.6 KB WebP derivative.
 *
 * Reads normalise CRLF first — this is a Windows checkout.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

/**
 * Source with block comments removed.
 *
 * Every fix in this pass narrates the defect it removed, and several of those
 * notes QUOTE the old code — `download={file.name}`, `originalName`, `1fr`.
 * A negative assertion that read the prose would fail on the explanation of its
 * own fix. The sibling document-ui test carries the same helper for the same
 * reason.
 */
const stripComments = (text) => {
  let out = "";
  let i = 0;
  for (;;) {
    const open = text.indexOf("/*", i);
    if (open === -1) return out + text.slice(i);
    out += text.slice(i, open);
    const close = text.indexOf("*/", open + 2);
    if (close === -1) return out;
    i = close + 2;
  }
};

const REGISTER = "app/(app)/portal/views/document-register.ts";
const THUMB = "app/(app)/portal/views/document-thumbnail.tsx";
const PORTAL = "app/(app)/portal/portal-app.tsx";
const CELL = "app/(app)/portal/cells/file-cell.tsx";
const CSS = "app/globals.css";

/* ── BUG 3: one rule for the display name ─────────────────────────────────── */

test("BUG 3: `documentName` takes both spellings of the filename", async () => {
  const source = stripComments(await read(REGISTER));
  /*
   * The register calls it `name`; every other shape in the app — an attachment
   * on a job, a board cell's file preview, a version row — calls it
   * `originalName`. Accepting only one is what forced every other surface to
   * print the raw column instead.
   */
  assert.match(source, /export function documentName\(file: \{/);
  assert.match(source, /title\?: string \| null;/);
  assert.match(source, /name\?: string \| null;/);
  assert.match(source, /originalName\?: string \| null;/);
  /* Title first, trimmed; the filename otherwise. Whitespace is not a name. */
  assert.match(source, /const title = file\.title\?\.trim\(\);\s*if \(title\) return title;/);
  assert.match(
    source,
    /return file\.name\?\.trim\(\) \|\| file\.originalName\?\.trim\(\) \|\| "";/,
  );
});

test("BUG 3: every surface that names a document calls the one rule", async () => {
  const surfaces = [
    CELL,
    "app/(app)/portal/evidence-manager.tsx",
    "app/(app)/portal/media-viewer.tsx",
    "app/(app)/portal/before-after.tsx",
    "app/(app)/portal/views/fix-tracker.tsx",
    "app/(app)/portal/sites/site-detail.tsx",
  ];
  for (const surface of surfaces) {
    const source = await read(surface);
    assert.match(
      source,
      /import \{ documentName \} from "[^"]*document-register"/,
      `${surface} must import the shared rule rather than print a column`,
    );
    assert.match(
      stripComments(source),
      /documentName\(/,
      `${surface} imports the rule and must actually use it`,
    );
  }
});

test("BUG 3: the board cell draws the display name and keeps the filename for the glyph", async () => {
  const cell = stripComments(await read(CELL));
  /* The chip's own name, its accessible name, and its remove button. */
  assert.match(cell, /title=\{documentName\(file\)\}/);
  assert.match(cell, /aria-label=\{`Open \$\{title\}: \$\{documentName\(file\)\}/);
  assert.match(cell, /aria-label=\{`Remove \$\{title\}: \$\{documentName\(file\)\}`\}/);
  /* The confirm and the toast name the document, not the upload filename. */
  assert.match(cell, /`Remove \$\{documentName\(file\)\} from \$\{title\}\?/);
  assert.match(cell, /onNotify\?\.\(`\$\{documentName\(file\)\} removed from \$\{title\}\.`\)/);
  /*
   * The TYPE GLYPH still reads the stored filename, and must: a title is prose
   * and has no extension, and R2 stores `application/octet-stream` for plenty
   * of rows, so the extension is a real fallback rather than a tiebreaker.
   */
  assert.match(cell, /const extension = file\.originalName\.split\("\."\)\.pop\(\)/);
});

test("BUG 3: the board payload's title reaches the cell, and an untitled row still decodes", async () => {
  /*
   * `board-compact.ts`, not `board-model.ts`. Carrying a sixth slot through the
   * wire format took `board-model.ts` past the 600-line ceiling that
   * `tests/stage-eight-board-split.test.mjs` enforces, so the format and its
   * decoder were split into their own module. The contract asserted below is
   * unchanged — only its address is.
   */
  const model = stripComments(await read("app/(app)/portal/board-compact.ts"));
  /*
   * `compactBoard` emits a five-element tuple when there is no title and a
   * six-element one when there is — omitted rather than a trailing null,
   * because almost no board attachment has a title and this list is the widest
   * thing the payload sends. The decoder must read slot 6 and normalise the
   * absent case, or the decoded object has two shapes.
   */
  assert.match(
    model,
    /preview\.map\(\(\[id, mime, originalName, byteSize, createdAt, title\]\)/,
  );
  assert.match(model, /title: title \?\? null,/);
  /* And `originalName` still travels — the glyph needs the extension. */
  assert.match(model, /originalName,/);

  const types = stripComments(await read("app/lib/types.ts"));
  assert.match(
    types,
    /export interface MaintenanceBoardFilePreview \{[^}]*title\?: string \| null;/s,
  );

  const cell = stripComments(await read(CELL));
  assert.match(cell, /title: file\.title \?\? null,/);
});

test("BUG 3: the storage filename survives as provenance, and names no download", async () => {
  const drawer = stripComments(await read(PORTAL));
  /*
   * `Content-Disposition` outranks a `download` attribute on a same-origin URL,
   * and `/api/files/[id]` now builds that header from this same display-name
   * rule with the stored extension kept. A client-side download NAME would be a
   * second rule free to disagree with the header — which is the whole defect.
   */
  assert.match(drawer, /download=""/);
  assert.doesNotMatch(drawer, /download=\{file\.name\}/);
  assert.doesNotMatch(drawer, /download=\{version\.originalName\}/);
  const cell = stripComments(await read(CELL));
  assert.match(cell, /download=\{target\.mode === "download" \? "" : undefined\}/);

  /* The version history shows the display name, with the stored file beside it. */
  assert.match(drawer, /<strong>\{documentName\(version\)\}<\/strong>/);
  assert.match(
    drawer,
    /documentName\(version\) !== version\.originalName/,
    "the stored filename is printed only when it differs from the display name",
  );
});

/* ── BUG 4: thumbnails ────────────────────────────────────────────────────── */

test("BUG 4: the thumbnail URL is the authorised route and nothing else", async () => {
  const source = stripComments(await read(REGISTER));
  assert.match(
    source,
    /return `\/api\/files\/\$\{encodeURIComponent\(file\.id\)\}\?thumb=1`;/,
    "one serving path, the same one preview and download use",
  );
  /* No bucket, no object key, no second image service. */
  const thumb = stripComments(await read(THUMB));
  for (const forbidden of [/r2\./i, /objectKey/, /\.r2\.dev/, /amazonaws/i, /next\/image/]) {
    assert.doesNotMatch(thumb, forbidden, "a storage path must never reach the DOM");
  }
  assert.match(thumb, /const src = documentThumbnailUrl\(file\)/);
});

test("BUG 4: the type gate is the SERVER's inline allowlist, not a guess", async () => {
  const source = stripComments(await read(REGISTER));
  /*
   * The image half of `INLINE_SAFE_TYPES` in app/api/files/[id]/route.ts. The
   * other four members of that set — application/pdf and three video types —
   * are inline-safe and are NOT images: pointed at an `<img>` every one of them
   * is a broken-image mark.
   */
  const route = stripComments(await read("app/api/files/[id]/route.ts"));
  const declared = route.slice(
    route.indexOf("const INLINE_SAFE_TYPES"),
    route.indexOf("]);", route.indexOf("const INLINE_SAFE_TYPES")),
  );
  const serverImages = [...declared.matchAll(/"(image\/[a-z]+)"/g)].map((m) => m[1]);
  assert.ok(serverImages.length >= 4, "the server's inline image list was not found");
  for (const type of serverImages) {
    assert.ok(
      source.includes(`"${type}"`),
      `${type} is inline-safe on the server and must be drawable here`,
    );
  }
  for (const notAnImage of ["application/pdf", "video/mp4", "video/webm", "video/quicktime"]) {
    assert.ok(
      !source.includes(`"${notAnImage}"`),
      `${notAnImage} is inline-safe but is not an image and must not reach an <img>`,
    );
  }
  /* A declared non-image type is an ANSWER. Only an opaque type falls through
     to the filename, which is what R2 stores for an emailed certificate. */
  assert.match(source, /if \(type !== "application\/octet-stream"\) return false;/);
});

test("BUG 4: a missing or refused picture is an icon, never a broken image", async () => {
  const thumb = stripComments(await read(THUMB));
  assert.match(thumb, /onError=\{\(\) => setFailed\(true\)\}/);
  assert.match(thumb, /if \(!src \|\| failed\) \{/, "no src and a failed load take one path");
  assert.match(thumb, /<Icon name=\{fallbackIcon\} size=\{fallbackSize\} \/>/);
  /*
   * The register pages and re-sorts in place, so React reuses this node for a
   * different row. Without a reset, one denied picture poisons every document
   * that later lands on the same node.
   */
  assert.match(thumb, /useEffect\(\(\) => setFailed\(false\), \[src\]\)/);
});

test("BUG 4: the picture costs a thumbnail, not a photograph", async () => {
  const thumb = stripComments(await read(THUMB));
  assert.match(thumb, /loading="lazy"/);
  assert.match(thumb, /decoding="async"/);
  assert.match(thumb, /width=\{box\.width\}/);
  assert.match(thumb, /height=\{box\.height\}/);
  /* Empty alt: both call sites print the name in text right beside the box. */
  assert.match(thumb, /alt=""/);

  const css = await read(CSS);
  for (const selector of [".file-name-cell__media > img", ".document-grid__icon > img"]) {
    const block = css.slice(css.indexOf(`${selector} {`));
    assert.ok(css.includes(`${selector} {`), `${selector} must be styled`);
    assert.match(block.slice(0, 220), /object-fit: cover;/, `${selector} must not stretch`);
  }
});

test("BUG 4: the picture uses the box the glyph already had, so nothing grew", async () => {
  const css = await read(CSS);
  /*
   * The table keeps the 29px plate `.file-name-cell > span` already drew, and
   * the card's media box is 54px + 16px beneath it — exactly the 70px the 46px
   * glyph and its 24px gap occupied. A taller media block for the image would
   * have stretched every card in its grid row to match.
   */
  const card = css.slice(css.indexOf(".document-grid__icon {"));
  assert.match(card.slice(0, 260), /width: 54px;/);
  assert.match(card.slice(0, 260), /height: 54px;/);
  assert.match(card.slice(0, 260), /margin-bottom: 16px;/);
  assert.match(card.slice(0, 260), /overflow: hidden;/);

  const row = css.slice(css.indexOf(".file-name-cell__media {"));
  assert.match(row.slice(0, 160), /overflow: hidden;/);

  /* The loading plate is a THEME TOKEN, so both dark paths are right at once. */
  assert.match(css, /\.document-grid__icon\.has-thumb \{\s*background: var\(--line\);/);
  assert.match(css, /\.file-name-cell__media\.has-thumb \{\s*background: var\(--line\);/);
});

test("BUG 4: both register views draw the picture, and the label stays", async () => {
  const portal = stripComments(await read(PORTAL));
  assert.match(portal, /import \{ DocumentThumbnail \} from "\.\/views\/document-thumbnail"/);
  /* The table: thumbnail AND the title beside it. */
  assert.match(
    portal,
    /<DocumentThumbnail\s+file=\{file\}\s+className="file-name-cell__media"\s+fallbackSize=\{17\}\s+box=\{\{ width: 29, height: 29 \}\}\s+\/>\s*<strong>\{documentName\(file\)\}<\/strong>/,
    "the File column keeps its text label beside the picture",
  );
  /* The card: same, with the name underneath. */
  assert.match(
    portal,
    /<DocumentThumbnail\s+file=\{file\}\s+className="document-grid__icon"\s+fallbackSize=\{24\}\s+box=\{\{ width: 54, height: 54 \}\}\s+\/>\s*<strong>\{documentName\(file\)\}<\/strong>/,
  );
});

/* ── BUG 5: the card grid fits the phone it is on ─────────────────────────── */

test("BUG 5: no grid track carries a minimum it cannot honour", async () => {
  const css = stripComments(await read(CSS));
  const grid = css.slice(css.indexOf(".document-grid {"));
  assert.match(
    grid.slice(0, 200),
    /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/,
    "4 x 180px + gaps + padding is 786px, which no phone has",
  );
  /*
   * `1fr` IS `minmax(auto, 1fr)`, and that `auto` is the item's automatic
   * minimum — a floor, not a preference. At 390px the two tracks resolved to
   * 430.9px and 252.5px inside a 364px box.
   */
  assert.match(
    css,
    /grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/,
    "the phone override must not use a bare 1fr either",
  );
  const gridBlock = css.slice(
    css.indexOf(".document-grid {"),
    css.indexOf(".document-grid > button {"),
  );
  assert.doesNotMatch(gridBlock, /minmax\(180px/);
});

test("BUG 5: the fix is width arithmetic, not more hidden overflow", async () => {
  const css = stripComments(await read(CSS));
  /*
   * `.documents-panel { overflow: hidden }` is what CONCEALED this: the grid
   * never produced a scrollbar, so every "is the page overflowing" check said
   * no while the cards were being cut off mid-border. It may stay exactly as it
   * is now that the arithmetic is right; it may not be widened, and no second
   * clip may be added to the grid or the card.
   */
  const grid = css.slice(
    css.indexOf(".document-grid {"),
    css.indexOf(".document-grid__icon {"),
  );
  assert.doesNotMatch(grid, /overflow-x: hidden/);
  assert.doesNotMatch(grid, /margin-right: -/, "no negative-margin hacks");
  /* The wrapping lines break an unbreakable token instead of spilling. */
  assert.match(
    css,
    /\.document-grid > button > span:not\(\.document-grid__icon\) \{[^}]*overflow-wrap: anywhere;/s,
  );
  assert.match(css, /\.document-grid small \{[^}]*overflow-wrap: anywhere;/s);
});

test("BUG 5: no breakpoint was invented for it", async () => {
  /*
   * The fix is two existing declarations, and that is the claim worth holding.
   * A width bug is the easiest thing in the world to paper over with one more
   * media query per phone the owner happens to own, and the next reader would
   * inherit a stack of device-specific pixel values instead of arithmetic that
   * works at every width. `.document-grid` therefore has exactly ONE responsive
   * override — the pre-existing 650px block — and its base rule.
   */
  const css = stripComments(await read(CSS));
  const declarations = [
    ...css.matchAll(/\.document-grid \{[^}]*grid-template-columns:[^;]+;/gs),
  ];
  assert.equal(
    declarations.length,
    2,
    "one base rule and one phone override; a third would be a new breakpoint",
  );
  /* And brand-overrides.css was not dragged into it at all. */
  const before = await read("app/brand-overrides.css");
  assert.doesNotMatch(
    before,
    /\.document-grid[^{]*\{[^}]*grid-template-columns/s,
    "the card grid's width maths lives in one file",
  );
});

/* ── The controls, and the one that could not finish its own job ──────────── */

test("UI: W07-03 is ONE control, and it names the act before the mechanism", async () => {
  const portal = stripComments(await read(PORTAL));
  const label = /Replace file \/ upload new version/g;
  assert.equal(
    (portal.match(label) ?? []).length,
    1,
    "a second replace control would be a second version path",
  );
  /* "Edit details" IS the metadata editor. There is no duplicate. */
  assert.doesNotMatch(portal, /Edit metadata/i);
  assert.match(portal, /Edit details/);
  /* Version History stays its own view. */
  assert.match(portal, /Version history/);
  assert.match(portal, /showVersions \? "Hide history" : "Show history"/);
});

test("UI: a replacement goes through the product's uploader, not a hand-rolled POST", async () => {
  const portal = stripComments(await read(PORTAL));
  const fn = portal.slice(
    portal.indexOf("async function uploadReplacement("),
    portal.indexOf("async function setArchived("),
  );
  assert.ok(fn.length > 0, "uploadReplacement was not found");
  /*
   * `uploadEvidenceFile` is where the 900 KB direct-upload ceiling, the
   * multipart fallback and `offerThumbnail` all live. Hand-rolling the request
   * skipped every one of them: a phone photograph — the case the owner reported
   * — answered 413 with a bare text/plain body carrying no JSON `error`, so the
   * drawer showed its generic fallback message and the operation simply failed.
   */
  assert.match(fn, /await uploadEvidenceFile\(\{/);
  assert.doesNotMatch(fn, /new FormData\(\)/, "no second upload request shape");
  assert.doesNotMatch(fn, /fetch\("\/api\/files"/);
  assert.match(fn, /replaces: file\.id,/);
  /* Filed where the old version was: the anchors and the STORED kind. */
  assert.match(fn, /kind: file\.attachmentKind \?\? "general",/);
  assert.match(fn, /requestId: file\.requestId/);
  assert.match(fn, /columnId: file\.boardColumnId/);
  /* Metadata is NOT re-sent: an absent key carries the predecessor's forward. */
  assert.doesNotMatch(fn, /title:/);
  assert.doesNotMatch(fn, /expiryDate:/);
});

test("UI: the stored kind reaches the client, or a replacement changes what a document IS", async () => {
  const types = stripComments(await read("app/lib/types.ts"));
  assert.match(types, /attachmentKind\?: AttachmentKind;/);
  assert.match(types, /boardColumnId\?: string \| null;/);
  const portal = stripComments(await read(PORTAL));
  /* `kind` on the row is the register's LABEL; this is what the API is told. */
  assert.match(
    portal,
    /attachmentKind:\s*file\.kind === "completion"\s*\? "completion"\s*: file\.kind === "issue"\s*\? "issue"\s*: "general",/,
  );
  assert.match(portal, /boardColumnId: file\.boardColumnId \?\? null,/);
});

test("UI: a refusal cannot outlive the document it was about", async () => {
  const portal = stripComments(await read(PORTAL));
  /*
   * The drawer's `error` is component state and React reused ONE instance for
   * every row the reader opened, so a refused replace on document A left its
   * red banner above document B. `openFile` is a new object after every write
   * while the id is stable, so the key remounts only on a real change of
   * document.
   */
  assert.match(portal, /<FileDetailDrawer\s+key=\{openFile\.id\}/);
  /* And opening the editor clears whatever refusal is on screen. */
  assert.match(portal, /onClick=\{\(\) => \{\s*setError\(null\);\s*setEditing\(true\);\s*\}\}/);
  /* Every action still clears the banner before it starts. */
  const drawer = portal.slice(
    portal.indexOf("function FileDetailDrawer("),
    portal.indexOf("interface CreateRequestDraft"),
  );
  for (const fn of ["saveMetadata", "uploadReplacement", "setArchived", "removeDocument"]) {
    const body = drawer.slice(drawer.indexOf(`function ${fn}(`));
    /*
     * A generous slice on purpose: `removeDocument` puts its `window.confirm`
     * first — the reader must be able to back out before anything is touched —
     * so its `setError(null)` sits after a long confirmation sentence.
     */
    assert.match(
      body.slice(0, 1600),
      /setError\(null\);/,
      `${fn} must clear a stale refusal before it acts`,
    );
  }
});
