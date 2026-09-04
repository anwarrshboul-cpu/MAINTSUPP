import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

/**
 * The file with every comment taken out.
 *
 * Both halves of this batch need it, and for the same reason: what is asserted
 * is what the CODE does and what the READER meets, and a comment is neither.
 * Counting `placement="bottom-end"` over the raw file counts the sentence in
 * the header explaining the choice; searching the raw file for the brand finds
 * the comments recording which capture each tab was rebuilt from, which are
 * deliberately kept.
 *
 * A `//` is only stripped where it starts a line, so one inside a string
 * literal survives.
 */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** The same, read straight from disk. */
const readCode = async (file) => stripComments(await read(file));

const CONTROLS = "app/(app)/portal/board-controls.tsx";
const ANCHORED = "app/(app)/portal/overlay/anchored.tsx";
const OVERLAY_CSS = "app/(app)/portal/overlay/overlay.css";
const PARITY = "app/(app)/portal/views/parity-views.tsx";
const TAB_GLYPH = "app/(app)/portal/board-tab-glyph.tsx";
const GLOBALS = "app/globals.css";

/* ═══════════════════════════════════════════════════════════════════════════
   A — THE SORT POPOVER UNDER THE SIDEBAR
   ═══════════════════════════════════════════════════════════════════════════

   Reported by the owner with a screenshot: opening the board's Sort control
   drew the "Sort by" panel with its left edge behind the dark rail, so the
   heading read "ort by" and the left of the panel was simply not there.

   Two independent causes, and it matters that both are pinned, because fixing
   either alone leaves a defect:

     1. STACKING. `.live-board-toolbar` is `position: relative` with
        `z-index: var(--z-toolbar)` (80), which makes it a stacking context.
        A panel rendered inside it declaring `--z-popover` (1000) is not at
        1000 against the page — it is at the top of an element sitting at 80,
        and `.portal-sidebar` is a `position: fixed` element at
        `--z-sidebar` (410) in the ROOT context. No number written on the
        panel can beat it. That is why a raised z-index is not the fix, and
        why the tests below assert the panel LEFT the toolbar rather than
        assert some larger number.

     2. PLACEMENT. The panel was also PUT where the rail is — hung from the
        right edge of a wrap ~500px into the page, a 520px panel starts at
        about x=-20. Had it won the stacking argument it would have been drawn
        ON TOP of the navigation, which is a different defect, not a fix.

   The cure for both is the one the stylesheet block in brand-overrides.css had
   already named and could not carry out: move the panels onto the shared
   overlay layer (root stacking context, above the rail by the one z scale),
   and clamp the placement to the CONTENT REGION rather than to the window, so
   a panel that would start under the rail is pushed right instead. */

test("A — the sort and filter panels are drawn on the shared overlay layer", async () => {
  const source = await readCode(CONTROLS);

  assert.match(
    source,
    /import \{ AnchoredPopover \} from "\.\/overlay\/anchored"/,
    "the panels must come through the shared primitive, not position themselves",
  );

  // One popover per panel, and neither panel left rendering itself as a bare
  // div at the top of its own return.
  assert.equal(
    (source.match(/<AnchoredPopover/g) ?? []).length,
    2,
    "both Sort and Filter, and only those two",
  );
  assert.doesNotMatch(
    source,
    /return \(\s*<div className="board-rules board-rules--/,
    "a panel returning a bare .board-rules div is rendering inline again",
  );

  /*
   * The dialog role and its name live on the POSITIONED element now. Two
   * nested `role="dialog"` boxes would announce the panel twice, so the inner
   * div keeps only its classes — which is where its skin comes from.
   */
  assert.match(source, /role="dialog"\s*\n\s*label="Sort the board"/);
  assert.match(source, /role="dialog"\s*\n\s*label="Filter the board"/);
  assert.doesNotMatch(
    source,
    /className="board-rules[^"]*"\s+role="dialog"/,
    "the inner panel must not carry a second dialog role",
  );
});

test("A — the panels are bounded to the content region, not to the window", async () => {
  const source = await readCode(CONTROLS);

  assert.match(
    source,
    /const BOARD_CONTENT_REGION = "\.portal-main"/,
    "the region a panel may not leave is the column beside the rail",
  );
  assert.equal(
    (source.match(/bounds=\{BOARD_CONTENT_REGION\}/g) ?? []).length,
    2,
    "both panels must be bounded, or the narrower one still lands under the rail",
  );

  /*
   * `.portal-main` and not a hard-coded rail width: its `margin-left` already
   * tracks the sidebar at every breakpoint (248px, 220px on a narrow desktop,
   * 0 once the rail is off-canvas), so the bound follows the layout instead of
   * having to be kept in step with it by hand.
   */
  const css = await read(GLOBALS);
  assert.match(
    css,
    /\.portal-main \{[^}]*margin-left: 248px/,
    ".portal-main must still be the element offset by the rail's width",
  );
});

test("A — the placement keeps its anchor and its right edge", async () => {
  const source = await readCode(CONTROLS);

  /*
   * `bottom-end` is the same edge the inline-era desktop rule chose — the
   * measurements behind that choice are recorded in audit-s3-panels.test.mjs
   * — so where the panel appears on a wide screen is unchanged by the move.
   */
  assert.equal((source.match(/placement="bottom-end"/g) ?? []).length, 2);

  /*
   * The anchor is the TRIGGER, found from a marker rendered in the trigger's
   * own wrap. It has to be the trigger and not the wrap: `AnchoredPopover`
   * returns focus to the anchor on close, and a <div> is not focusable, so
   * anchoring to the wrap would drop focus onto <body> on every Escape.
   */
  assert.match(source, /function useToolbarAnchor\(\)/);
  assert.match(
    source,
    /closest<HTMLElement>\("\.live-board-rules-wrap"\)/,
    "the marker must resolve its OWN wrap — a document-wide query finds two",
  );
  assert.match(
    source,
    /querySelector<HTMLElement>\('button\[aria-expanded="true"\]'\)/,
    "the open trigger is the anchor",
  );
  assert.equal(
    (source.match(/<span ref=\{markerRef\} hidden/g) ?? []).length,
    2,
    "the marker must take no space in a toolbar row that is already too wide",
  );
});

test("A — the fix is a reposition, not a z-index war", async () => {
  const controls = await readCode(CONTROLS);
  const anchored = await readCode(ANCHORED);

  /*
   * Nothing in either file may write a raw depth. The layer's z comes from
   * `.ms-layer[data-layer]` and the token scale in globals.css; a number
   * written here would be the start of exactly the escalation the sidebar
   * defect invites. (`stage-eight-board-split` polices the same rule across
   * the stylesheets; this is the component half of it.)
   */
  assert.doesNotMatch(controls, /z-?[Ii]ndex/, "no depth written at the call site");
  assert.doesNotMatch(anchored, /zIndex/, "the primitive takes its depth from the layer class");

  // And the horizontal clamp must actually use the bounds. If this reverts to
  // the viewport width the panel is legal again and invisible again.
  assert.match(
    await read(ANCHORED),
    /left = Math\.max\(minX \+ padding, Math\.min\(left, maxX - padding - width\)\)/,
    "the surface is clamped into the region, not into the window",
  );
});

test("A — bounds default to the window, so no existing popover moves", async () => {
  const source = await read(ANCHORED);

  assert.match(source, /function resolveBounds\(/);
  assert.match(
    source,
    /const windowBounds: Bounds = \{ left: 0, right: vw \};\s*\n\s*if \(!selector\) return windowBounds;/,
    "a caller that names no region must compute exactly what it computed before",
  );
  // A region resolved from the anchor, not from the document at large: two
  // boards can be on screen and only one of them is this anchor's.
  assert.match(source, /anchor\?\.closest<HTMLElement>\(selector\)/);

  /*
   * A collapsed region is ignored rather than obeyed. A rail mid-transition or
   * a pane inside a `display: none` ancestor measures 0 or a sliver, and
   * clamping a 520px panel into a sliver would put it off screen — the same
   * class of defect, arrived at from the other direction.
   */
  assert.match(source, /if \(rect\.width <= 0\) return windowBounds;/);
  assert.match(source, /if \(right - left < MIN_BOUNDS_WIDTH\) return windowBounds;/);
});

/*
 * THE JITTER RULE, restated for the new argument.
 *
 * anchored.tsx has twice been bitten by a feedback loop: a value written onto
 * the surface changed the surface's box, the changed box was measured, and the
 * measurement wrote a slightly different value. It was invisible in headless
 * Chromium (overlay scrollbars take no layout width) and invisible in every
 * screenshot, and it cost days.
 *
 * `bounds` is safe from that by construction, and this test says why in a form
 * that breaks if the construction changes: the region is resolved from the
 * ANCHOR and never from the surface, so nothing written back onto the surface
 * can move it. The surface is `position: fixed` inside a zero-sized host on
 * <body> — out of flow — so it cannot resize `.portal-main` either.
 */
test("A — the bounds are a read of something the surface cannot move", async () => {
  const source = await read(ANCHORED);
  const fn = source.slice(
    source.indexOf("function resolveBounds("),
    source.indexOf("/** What the menu's arrow keys walk across. */"),
  );
  assert.ok(fn.length > 100, "resolveBounds must still be there to check");
  assert.doesNotMatch(fn, /surface/, "the bounds must never be measured off the surface");
  assert.doesNotMatch(fn, /scrollHeight|offsetHeight|offsetWidth|clientHeight/);

  // The 2px settle floor is the belt to that argument's braces; it is what
  // makes a one-pixel alternation impossible to run even if one were created.
  assert.match(source, /const SETTLE_EPSILON = 2;/);
});

test("A — the inline-era offsets are stood down for the portalled panel", async () => {
  const css = await read(OVERLAY_CSS);
  const rule = css.slice(css.indexOf(".ms-popover > .board-rules"));
  assert.ok(rule.length > 40, ".board-rules must join the neutralised list");
  const body = rule.slice(0, rule.indexOf("}"));
  assert.match(body, /position: static/, "its own `absolute` must not fight the placement");

  /*
   * And the panel may not be wider than the surface placed for it. The popover
   * is shrink-to-fit around the panel and carries the inline `max-width` — the
   * BOUNDS minus their padding — so without this the panel would keep its
   * 520px and hang back out over the rail the placement just cleared.
   */
  assert.match(
    css,
    /\.ms-popover\.board-rules-layer > \.board-rules \{\s*max-width: 100%;/,
    "the panel must not overflow the surface that was placed for it",
  );
  assert.match(await read(CONTROLS), /className="board-rules-layer"/);
});

/* ═══════════════════════════════════════════════════════════════════════════
   B — THE BRAND IN BOARD AND VIEW COPY
   ═══════════════════════════════════════════════════════════════════════════

   The owner asked for "monday" out of every string a signed-in reader meets on
   the board, its sections and its views. Comments, module names, CSS classes,
   stored ids and import provenance are internal and deliberately untouched —
   the register still keys rows off a monday item id and the importer is still
   called what it is called. What changed is only the words on screen.

   The rendered strings are pinned rather than merely removed, because "no
   monday anywhere in the file" would also be satisfied by deleting the
   sentence, and these sentences carry meaning the reader needs: what the Vibe
   tab is, what the flat table is, and what a form-response count is counted
   from. */

test("B — no rendered board/view copy names the brand", async () => {
  /*
   * The check is deliberately narrow: the code, without its comments, and
   * without the import naming the board-spec module. parity-views.tsx
   * documents itself against the capture each tab was rebuilt from, and those
   * comments are the record of why every tab looks the way it does — losing
   * them to a blanket search-and-replace would cost more than the brand does.
   * The owner asked for the words a reader meets, not for the file.
   */
  const rendered = (await readCode(PARITY))
    .split("\n")
    .filter((line) => !line.trim().startsWith("import "))
    .join("\n");

  assert.doesNotMatch(
    rendered,
    /monday/i,
    "a reader on a board view must not meet the brand name",
  );
});

test("B — the copy that carried the brand still says what it said", async () => {
  const source = await read(PARITY);

  // The flat table is still described as a second, group-free table.
  assert.match(source, /ungrouped — a second table view/);

  // The Vibe tab still declares that it is an app surface rather than a view,
  // and still names the app it stands in for — the whole point of the panel is
  // that it does not pretend to be an app builder.
  assert.match(source, /App view/);
  assert.match(source, /app-style board view/);
  assert.match(source, /15528052/);
  assert.match(source, /no app builder/);

  // The two counts still say what they are counted from.
  assert.match(source, /rows in view that are\s*\n\s*recorded as a form submission/);
  assert.match(source, /in view that are recorded as a form\s*\n\s*submission/);

  // And "done" is still defined, just not as someone else's flag.
  assert.match(source, /the\s*\n\s*board&rsquo;s own done flag/);
});

test("B — the app glyph's accessible name carries no brand", async () => {
  const glyphs = await read(TAB_GLYPH);

  /*
   * A screen-reader user heard "monday app" — the name of a product they are
   * not using, and nothing about the tab in front of them. It is the only mark
   * distinguishing an app tab from a view tab, so it must still HAVE a name;
   * it is now the same wording as the Vibe panel's own pill, so what is heard
   * and what is seen agree.
   */
  assert.match(glyphs, /aria-label="App view"/);
  assert.doesNotMatch(
    glyphs,
    /aria-label="[^"]*monday/i,
    "no brand in an accessible name",
  );
  assert.match(await read(PARITY), /App view/, "the pill and the glyph must agree");
});
