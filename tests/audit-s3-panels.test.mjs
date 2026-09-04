import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const GLOBALS = "app/globals.css";
const BRAND = "app/brand-overrides.css";

/**
 * RE-POINTED, W2C — THE PANELS ARE NO LONGER INLINE, AND THIS RULE IS NOW THE
 * SKIN RATHER THAN THE PLACEMENT.
 *
 * When this test was written the sort/filter panels were the board's only
 * popovers still rendered inline in the toolbar. Anchored `left: 0`, a 520px
 * panel overran the right edge of the viewport at every desktop width measured
 * — Filter reached x=1459 on a 1440 screen, 1426 on 1024 — cutting off its own
 * Close button and giving the document a sideways scrollbar, so desktop hung
 * the panel from the RIGHT edge of its trigger's wrap instead.
 *
 * That was the whole of what a stylesheet could do, and the brand-overrides
 * block below says so in as many words ("the proper cure is to move them onto
 * that same layer"). The panels are now drawn through `AnchoredPopover`, which
 * portals them onto the shared layer and places them in JS against the
 * anchor's live rect — so the declarations below no longer decide where the
 * panel goes, and are stood down by `.ms-popover > .board-rules` in
 * overlay/overlay.css.
 *
 * THE PIN IS KEPT AND MOVED, NOT DELETED. Two reasons. The first is that the
 * right-edge intent it records is the placement the popover asks for
 * (`bottom-end`), so this is still the sentence explaining why the panel hangs
 * where it does — asserted directly in `w2-overlay-and-copy.test.mjs`. The
 * second is that the class still carries the panel's ground, border, shadow
 * and both themes' colours, so deleting the rule to tidy up would take the
 * skin with it. What this test now proves is that the inline-era geometry
 * cannot come back to life unnoticed: while the rule is still here, the
 * neutraliser has to be here too.
 */
test("desktop right-anchors the sort/filter panels to their wrap", async () => {
  const css = await read(GLOBALS);
  const media = css.slice(css.lastIndexOf("@media (min-width: 1024px)"));
  const rule = media.slice(media.indexOf(".live-board-rules-wrap .board-rules"));
  assert.ok(rule.length > 40, "the right-anchor block must exist at min-width: 1024px");
  const body = rule.slice(0, rule.indexOf("}"));
  assert.match(body, /left: auto/, "left must stand down so right can anchor");
  assert.match(body, /right: 0/, "the panel hangs from the wrap's right edge");

  // …and while that rule stands, the layer must go on overriding it, or a
  // portalled panel would try to obey an ancestor it no longer has.
  const overlay = await read("app/(app)/portal/overlay/overlay.css");
  assert.match(
    overlay,
    /\.ms-popover > \.board-rules[^{]*\{[^}]*position: static/,
    "the inline-era offsets must be stood down for the portalled panel",
  );
});

/**
 * "THE MENU THAT TOOK THE PAGE WITH IT" (brand-overrides.css): opening a
 * toolbar panel flips the toolbar's overflow-x from `auto` to `visible` so
 * the panel is not clipped, which un-clips the whole 1,072px control rail,
 * pushes the document wide, and resets the rail's scroll position. The cure
 * — keep the rail clipping and let the panel escape as a fixed sheet — was
 * first shipped at max-width: 768px on the claim that above 768 "the rail
 * all but fits". Measured at 900 and 800 it does not (panel a third off the
 * right edge, 175px document scroll), so the sheet band must cover every
 * width the sidebar is away: through 1024px, where the desktop right-anchor
 * takes over. 1024 rather than 1023 because the breakpoints are an agreed
 * set (stage-five and stage-six pin it), and the boundary is better resolved
 * as the sheet. This pins the band so it cannot quietly shrink back to phones.
 */
test("the fixed-sheet band covers every sidebar-less width (<=1024px)", async () => {
  /*
   * RE-POINTED, W2C. `.board-rules` is in this selector for history now: the
   * sort and filter panels went onto the shared overlay layer, so they are no
   * longer descendants of `.live-board-toolbar` and no rule naming one can
   * reach them. `.live-board-menu` — the toolbar's other inline menus, drawn
   * from live-board.tsx — did not move, and every word of the block below is
   * still live for it. The band stays pinned for the surfaces that still need
   * it; where the two panels went instead is pinned in
   * `w2-overlay-and-copy.test.mjs`.
   */
  const css = await read(BRAND);
  const sheetSel = /\.live-board-toolbar \.live-board-menu,\s*\.live-board-toolbar \.board-rules/;
  const m = css.match(sheetSel);
  assert.ok(m, "the sheet rule must still exist");
  const idx = m.index;
  const before = css.slice(0, idx);
  const media = before.slice(before.lastIndexOf("@media"));
  assert.match(media, /max-width: 1024px/, "the sheet band must run to 1024px, not stop at phones");
  const sheet = css.slice(idx, idx + 400);
  assert.match(sheet, /position: fixed/, "the panel escapes the clipping rail by being fixed");
  const band = css.slice(before.lastIndexOf("@media"), idx);
  assert.match(
    band,
    /\.live-board-toolbar:has\(\.live-board-menu, \.board-rules\)\s*\{\s*overflow-x: auto/,
    "inside the band the rail must keep clipping while a panel is open",
  );
});

/**
 * The desktop half of the same guard, unchanged from before this audit: while
 * a panel is open the toolbar must NOT clip (the panel is absolute inside it),
 * and while nothing is open it must scroll. Both halves live in globals.css;
 * losing either brings back a clipped dropdown or a permanently overflowing
 * rail.
 */
test("the toolbar's :has() escape pair survives", async () => {
  const css = await read(GLOBALS);
  assert.match(
    css,
    /\.live-board-toolbar:not\(:has\(\.live-board-menu, \.board-rules\)\)\s*\{\s*overflow-x: auto/,
    "closed toolbar scrolls",
  );
  assert.match(
    css,
    /\.live-board-toolbar:has\(\.live-board-menu, \.board-rules\)\s*\{\s*overflow: visible/,
    "open toolbar must not clip its own panel on desktop",
  );
});

/*
 * Un-clipping the toolbar so the dropdown survives is what let the toolbar's
 * own width reach the page: between roughly 1024 and 1370 that row is wider
 * than the viewport and normally scrolls inside itself, so opening Sort or
 * Filter gave the whole document a horizontal scrollbar. Measured with a
 * panel open: controls reached x=1339 on a 1280 screen, x=1311 on a 1024 one.
 *
 * `clip` is load-bearing and not interchangeable with `hidden`: `hidden` makes
 * the page a scroll container, which changes what `position: sticky` resolves
 * against. And the selector must NOT nest one :has() inside another — that is
 * invalid, the whole rule is dropped, and the fix silently does nothing. It
 * did exactly that until the browser was asked why.
 */
test("the page clips its own sideways spill while a board panel is open", async () => {
  const css = await read(GLOBALS);
  const rule = css.match(
    /@media \(min-width: 1024px\) \{\s*body:has\(([^)]*)\) \{\s*overflow-x: clip;/,
  );
  assert.ok(rule, "the page-level clip for an open board panel must exist");
  assert.ok(
    !rule[1].includes(":has("),
    ":has() cannot be nested inside :has() — the rule would be dropped as invalid",
  );
  assert.match(rule[1], /\.live-board-toolbar \.board-rules/);
});
