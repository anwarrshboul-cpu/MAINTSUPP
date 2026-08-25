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
 * The sort/filter panels are the board's only popovers still rendered inline
 * in the toolbar (everything else portals onto the overlay layer). Rendered
 * inline and anchored `left: 0`, a 520px panel overran the right edge of the
 * viewport at every desktop width measured — Filter reached x=1459 on a 1440
 * screen, 1426 on 1024 — cutting off its own Close button and giving the
 * document a sideways scrollbar. Desktop therefore anchors the panel to the
 * RIGHT edge of its trigger's wrap, whose right edge never passes ~1011px
 * while the sidebar is up.
 */
test("desktop right-anchors the sort/filter panels to their wrap", async () => {
  const css = await read(GLOBALS);
  const media = css.slice(css.lastIndexOf("@media (min-width: 1024px)"));
  const rule = media.slice(media.indexOf(".live-board-rules-wrap .board-rules"));
  assert.ok(rule.length > 40, "the right-anchor block must exist at min-width: 1024px");
  const body = rule.slice(0, rule.indexOf("}"));
  assert.match(body, /left: auto/, "left must stand down so right can anchor");
  assert.match(body, /right: 0/, "the panel hangs from the wrap's right edge");
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
 * width the sidebar is away: up to 1023px, where the desktop right-anchor
 * takes over. This pins the band so it cannot quietly shrink back to phones.
 */
test("the fixed-sheet band covers every sidebar-less width (<=1023px)", async () => {
  const css = await read(BRAND);
  const sheetSel = /\.live-board-toolbar \.live-board-menu,\s*\.live-board-toolbar \.board-rules/;
  const m = css.match(sheetSel);
  assert.ok(m, "the sheet rule must still exist");
  const idx = m.index;
  const before = css.slice(0, idx);
  const media = before.slice(before.lastIndexOf("@media"));
  assert.match(media, /max-width: 1023px/, "the sheet band must run to 1023px, not stop at phones");
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
