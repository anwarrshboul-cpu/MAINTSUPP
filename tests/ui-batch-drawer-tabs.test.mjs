/**
 * UI batch — the item drawer's tab bar.
 *
 * The owner's screenshot showed five tabs jammed edge to edge in their strip:
 * `padding: 0px 15px`, so no vertical padding at all, `gap: 0`, and a 40px
 * button inside a 46px strip — three pixels of air above and below the active
 * pill and none between one tab and the next. The frame read as if it were
 * clamped onto the word.
 *
 * What is pinned here is the breathing room, not a look:
 *
 *   - real padding on BOTH axes, so the pill is never drawn against the text;
 *   - a 44px minimum height — the touch target, not a decoration;
 *   - a gap between tabs, and the same gap as the strip's own padding;
 *   - one rounded pill, one radius, one border width for every tab, active or
 *     not, so an inactive tab has the same hit area as the active one and the
 *     row does not jump when the selection moves;
 *   - labels centred on both axes and never wrapped mid-word, with the strip
 *     scrolling instead — "Contractor link" has to stay readable at 320px.
 *
 * `.detail-drawer__tabs` is written six times in globals.css. Three of those
 * copies carry metrics, and the LAST one wins on a phone; the test reads all
 * of them so a stale copy cannot sit there contradicting the live one.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const GLOBALS = "app/globals.css";
const PORTAL = "app/(app)/portal/portal-app.tsx";

/** Every rule body in `css` whose selector list matches `selector`. */
function rules(css, selector) {
  const out = [];
  const needle = new RegExp(`(^|[},;/*\\s])${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`, "g");
  for (const hit of css.matchAll(needle)) {
    const open = css.indexOf("{", hit.index);
    const close = css.indexOf("}", open);
    out.push(css.slice(open + 1, close));
  }
  return out;
}

const px = (body, property) => {
  const hit = new RegExp(`(?:^|;|\\n)\\s*${property}\\s*:\\s*([^;]+);`).exec(body);
  return hit ? hit[1].trim() : null;
};

test("every tab rule pads on both axes — none of them is 0 vertical", async () => {
  const css = await read(GLOBALS);
  const buttons = rules(css, ".detail-drawer__tabs > button");
  assert.ok(buttons.length >= 3, `expected the button rule in several places, found ${buttons.length}`);

  let padded = 0;
  for (const body of buttons) {
    const padding = px(body, "padding");
    if (!padding) continue;
    padded += 1;
    const parts = padding.split(/\s+/);
    const top = parts[0];
    assert.notEqual(
      top,
      "0",
      `a tab still declares "padding: ${padding}". Zero vertical padding is what put the active frame on the word.`,
    );
    assert.notEqual(top, "0px", `a tab still declares "padding: ${padding}".`);
    assert.match(top, /^\d+px$/, `a tab's vertical padding should be a pixel value, got "${padding}"`);
    assert.ok(
      Number.parseInt(top, 10) >= 6,
      `a tab pads only ${top} vertically; the strip needs at least 6px of it.`,
    );
  }
  assert.ok(padded >= 3, `expected padding on at least three copies of the rule, found ${padded}`);
});

test("the phone's tabs are a 44px target with one radius and one border", async () => {
  const css = await read(GLOBALS);
  const buttons = rules(css, ".detail-drawer__tabs > button").filter((body) => px(body, "min-height"));

  assert.ok(buttons.length >= 3, "the button's min-height should be stated in every copy that sets metrics");
  for (const body of buttons) {
    const minHeight = Number.parseInt(px(body, "min-height"), 10);
    assert.ok(
      minHeight >= 44,
      `a tab's min-height is ${minHeight}px. 44 is the comfortable target; anything under it is the old 40.`,
    );
  }

  // The two phone copies that draw the pill agree on its shape.
  const pills = buttons.filter((body) => px(body, "border-radius"));
  assert.ok(pills.length >= 2, "the pill's radius should be declared alongside its border");
  const radii = new Set(pills.map((body) => px(body, "border-radius")));
  assert.equal(radii.size, 1, `the tabs disagree about their radius: ${[...radii].join(" vs ")}`);
  assert.equal([...radii][0], "10px");

  // An inactive tab is bordered too — transparently — so it keeps the same box.
  const bordered = pills.filter((body) => px(body, "border"));
  assert.ok(bordered.length >= 2, "each pill copy states its resting border");
  for (const body of bordered) {
    assert.equal(
      px(body, "border"),
      "2px solid transparent",
      "an inactive tab keeps the active tab's border width, drawn transparent, so the row cannot shift on selection",
    );
  }
});

test("the strip gaps its tabs and pads itself by the same amount", async () => {
  const css = await read(GLOBALS);
  const strips = rules(css, ".detail-drawer__tabs").filter((body) => px(body, "gap"));
  assert.ok(strips.length >= 2, `expected the strip's gap in several copies, found ${strips.length}`);

  for (const body of strips) {
    const gap = px(body, "gap");
    assert.notEqual(gap, "0", 'the strip still declares "gap: 0" — the tabs would touch');
    assert.equal(gap, "6px", `the strip's gap is "${gap}"; the batch settled on 6px`);
  }

  const padded = rules(css, ".detail-drawer__tabs").filter((body) => px(body, "padding") === "6px");
  assert.ok(
    padded.length >= 3,
    "the strip pads itself by the same 6px it puts between tabs, in each phone copy",
  );

  const rounded = rules(css, ".detail-drawer__tabs").filter((body) => px(body, "border-radius"));
  for (const body of rounded) {
    assert.equal(px(body, "border-radius"), "14px", "the strip's own corner stays outside the pill's");
  }
});

test("labels are centred on both axes and the strip scrolls rather than wrapping", async () => {
  const css = await read(GLOBALS);
  const buttons = rules(css, ".detail-drawer__tabs > button");

  const centred = buttons.filter(
    (body) => px(body, "justify-content") === "center" && px(body, "align-items") === "center",
  );
  assert.ok(
    centred.length >= 3,
    `only ${centred.length} copies centre the label on both axes; every copy that lays the button out must`,
  );

  // nowrap lives on the base rule and is never overridden.
  assert.ok(
    buttons.some((body) => px(body, "white-space") === "nowrap"),
    "a long label must not wrap mid-word; the strip scrolls instead",
  );
  assert.ok(
    !buttons.some((body) => px(body, "white-space") === "normal"),
    "no copy may re-enable wrapping",
  );

  const strips = rules(css, ".detail-drawer__tabs");
  assert.ok(
    strips.some((body) => px(body, "overflow-x") === "auto"),
    'the strip keeps "overflow-x: auto" so "Contractor link" is reachable at 320px',
  );
});

test("no copy of the rule is left saying the old numbers", async () => {
  const css = await read(GLOBALS);
  for (const body of rules(css, ".detail-drawer__tabs > button")) {
    assert.notEqual(px(body, "padding"), "0 15px", "a stale copy still carries the flush 0/15 padding");
    assert.notEqual(px(body, "min-height"), "40px", "a stale copy still carries the old 40px target");
  }
  for (const body of rules(css, ".detail-drawer__tabs")) {
    assert.notEqual(px(body, "min-height"), "46px", "a stale copy still carries the old 46px strip");
    assert.notEqual(px(body, "padding"), "3px", "a stale copy still carries the old 3px strip padding");
  }
});

test("the dark theme states the selected tab's colour outside any media query", async () => {
  const css = await read(GLOBALS);
  // The board's dark rules are the LAST `body[data-theme="dark"]` block — the
  // native-nesting one, not the palette at the top of the file.
  const at = css.lastIndexOf('body[data-theme="dark"] {');
  assert.ok(at > 0);
  const dark = css.slice(at);
  const active = rules(dark, ".detail-drawer__tabs > button.is-active")[0];
  assert.ok(
    active,
    "the dark theme must restate the selected tab's colour. The base rule paints it " +
      "#182c36 for a white strip; with no correction here, every screen wider than " +
      "760px drew the selected label at 1.11:1 on the dark drawer.",
  );
  assert.ok(px(active, "color"), "the rule exists to set a colour");

  // And it must not be inside a media query, or the desktop falls back again.
  // Comments are stripped first: this file's prose mentions @media by name.
  const bare = dark.replace(/\/\*[\s\S]*?\*\//g, "");
  const upTo = bare.slice(0, bare.indexOf(".detail-drawer__tabs > button.is-active"));
  const opened = (upTo.match(/@media/g) || []).length;
  const closedAfter = upTo.split("@media").slice(1).filter((chunk) => {
    let depth = 0;
    for (const ch of chunk) {
      if (ch === "{") depth += 1;
      else if (ch === "}") { depth -= 1; if (depth === 0) return true; }
    }
    return false;
  }).length;
  assert.equal(
    opened,
    closedAfter,
    "the dark selected-tab rule sits inside a media query; it has to apply at every width",
  );
});

test("the drawer still offers its five sections, from the same nav", async () => {
  const portal = await read(PORTAL);
  const nav = portal.slice(
    portal.indexOf('<nav className="detail-drawer__tabs"'),
    portal.indexOf("</nav>", portal.indexOf('<nav className="detail-drawer__tabs"')),
  );
  assert.ok(nav.length > 0, "the tab strip is still a <nav className=\"detail-drawer__tabs\">");
  for (const label of ["Columns", "Updates / ", "Files", "Activity Log", "Contractor link"]) {
    assert.ok(nav.includes(label), `the drawer must still offer "${label}"`);
  }
  // Five buttons, no more: the strip is a tab bar, not a toolbar.
  assert.equal((nav.match(/<button/g) || []).length, 5);
});
