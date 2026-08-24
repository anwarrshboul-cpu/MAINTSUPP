/**
 * UI batch — the item drawer: its tab strip, and the frame its content sits in.
 *
 * ROUND ONE was the tab strip. The owner's screenshot showed five tabs jammed
 * edge to edge: `padding: 0px 15px`, so no vertical padding at all, `gap: 0`,
 * and a 40px button inside a 46px strip. The frame read as if it were clamped
 * onto the word.
 *
 * ROUND TWO is the panel underneath them, and the same tabs again.
 *
 *   - `.drawer-section` measured `padding: 18px 0 0`, `border-width: 1px 0 0`,
 *     `border-radius: 0` — a dark surface with a hairline along its TOP edge and
 *     nothing on the other three. Activity History ran from one side of the
 *     phone to the other with the timeline dots ON the left edge, "17 events"
 *     jammed into the right corner, and the slab passing under the Add update /
 *     Advance request bar. It is a panel; it had no frame.
 *   - The tabs reached 44px and 10/18 padding, which was the right direction
 *     and not far enough, and only the DARK active pill was re-branded teal.
 *     The light one was still monday's #244bf3 on #eef0ff.
 *
 * WHERE THE SHIPPED NUMBERS LIVE. globals.css writes `.detail-drawer__tabs` six
 * times over and `.drawer-section` three; brand-overrides.css loads after it
 * (app/(app)/layout.tsx) and is where the drawer's frame and its pills are now
 * described, once each. So this file asks globals.css only that no stale copy
 * has come back saying the old numbers, and asks brand-overrides.css what the
 * drawer actually looks like.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const GLOBALS = "app/globals.css";
const BRAND = "app/brand-overrides.css";
const PORTAL = "app/(app)/portal/portal-app.tsx";

/** Comments in these files carry braces, colour literals and the word @media. */
const uncomment = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Every rule in a stylesheet as `{ chain, selector, body }`, brace-matched so a
 * rule inside `@media` or inside a nested `body[data-theme]` block is found the
 * same way a top-level one is. A flat regex reports the nested ones as absent,
 * which is how a rule can be obviously there and still not be tested.
 */
function eachRule(css, visit, chain = []) {
  let index = 0;
  let start = 0;
  while (index < css.length) {
    const char = css[index];
    if (char === "{") {
      const selector = css.slice(start, index).trim();
      let depth = 1;
      let end = index + 1;
      while (end < css.length && depth > 0) {
        if (css[end] === "{") depth += 1;
        else if (css[end] === "}") depth -= 1;
        end += 1;
      }
      const body = css.slice(index + 1, end - 1);
      const nextChain = [...chain, selector];
      visit({ chain: nextChain, selector, body });
      eachRule(body, visit, nextChain);
      index = end;
      start = end;
      continue;
    }
    if (char === "}" || char === ";") {
      index += 1;
      start = index;
      continue;
    }
    index += 1;
  }
}

/** Rules whose selector LIST contains `selector` as one of its members. */
function rulesFor(css, selector) {
  const out = [];
  eachRule(uncomment(css), (rule) => {
    if (rule.selector.startsWith("@")) return;
    const members = rule.selector.split(",").map((one) => one.replace(/\s+/g, " ").trim());
    if (!members.includes(selector)) return;
    const media = rule.chain.slice(0, -1).find((link) => link.startsWith("@media")) ?? "";
    out.push({ body: rule.body, media, selector: rule.selector });
  });
  return out;
}

/** One declaration out of a rule body, trimmed, or null. */
const decl = (body, property) => {
  const hit = new RegExp(`(?:^|;|\\n)\\s*${property}\\s*:\\s*([^;}]+)`).exec(body);
  return hit ? hit[1].trim() : null;
};

/** The four sides of a padding/margin shorthand, in px, or null if not px. */
function sides(shorthand) {
  const parts = shorthand.split(/\s+/);
  const [top, right = top, bottom = top, left = right] = parts;
  const px = (value) => (/^\d+px$/.test(value) ? Number.parseInt(value, 10) : /^0$/.test(value) ? 0 : null);
  return { top: px(top), right: px(right), bottom: px(bottom), left: px(left) };
}

const phone = (rule) => /max-width:\s*76\dpx/.test(rule.media);

/* ------------------------------------------------------------------ */
/* The frame                                                           */
/* ------------------------------------------------------------------ */

test("the content panel is padded on all four sides, not just the top", async () => {
  const brand = await read(BRAND);
  const panels = rulesFor(brand, ".detail-drawer__body > .drawer-section").filter((rule) =>
    decl(rule.body, "padding"),
  );
  assert.ok(
    panels.length >= 2,
    `the panel's padding should be stated for the drawer and again for the phone, found ${panels.length}`,
  );

  for (const rule of panels) {
    const padding = decl(rule.body, "padding");
    const box = sides(padding);
    for (const [side, value] of Object.entries(box)) {
      assert.notEqual(
        value,
        null,
        `the panel's ${side} padding is "${padding}" — every side has to be a pixel value`,
      );
      assert.ok(
        value >= 14,
        `the panel pads ${value}px on its ${side}. It measured "18px 0 0" before this batch — ` +
          "zero on three sides is how the timeline dots ended up on the edge of the screen.",
      );
    }
  }
});

test("the panel is a framed card: one radius, a border all the way round, a surface", async () => {
  const brand = await read(BRAND);
  const [base] = rulesFor(brand, ".detail-drawer__body > .drawer-section");
  assert.ok(base, "the drawer's panel must be described in brand-overrides.css");

  const radius = decl(base.body, "border-radius");
  assert.match(radius, /^\d+px$/, `the panel's radius is "${radius}"`);
  assert.ok(
    Number.parseInt(radius, 10) >= 10,
    `the panel's radius is ${radius}; it was 0 and read as a slab, not a card`,
  );

  // The shorthand, so all four edges are set at once and none can be left off.
  const border = decl(base.body, "border");
  assert.ok(border, "the panel states `border`, not `border-top` — the top rule alone was the defect");
  assert.match(
    border,
    /^\d+px solid var\(--[a-z0-9-]+\)$/,
    `the panel's border is "${border}"; it should be a width, solid, and a token`,
  );

  const background = decl(base.body, "background");
  assert.match(
    background,
    /^var\(--[a-z0-9-]+\)$/,
    `the panel's surface is "${background}"; a literal here paints the same in both themes`,
  );

  // Dark restates the surface deliberately: the blanket `:is(…, .drawer-section,
  // …)` at the top of the file is more specific than the rule above and would
  // otherwise put its own literals back on all four sides.
  const dark = rulesFor(brand, 'body[data-theme="dark"] .detail-drawer__body > .drawer-section');
  assert.equal(dark.length, 1, "dark must restate the card's surface exactly once");
  assert.match(decl(dark[0].body, "background"), /^var\(--[a-z0-9-]+\)$/);
  assert.match(decl(dark[0].body, "border-color"), /^var\(--[a-z0-9-]+\)$/);
});

test("the drawer body clears the sticky action bar and insets the card", async () => {
  const brand = await read(BRAND);
  const bodies = rulesFor(brand, ".detail-drawer__body").filter((rule) => decl(rule.body, "padding"));
  assert.ok(bodies.length >= 2, "the body pads itself for the drawer and again for the phone");

  for (const rule of bodies) {
    const box = sides(decl(rule.body, "padding"));
    assert.ok(
      box.bottom >= 28,
      `the drawer body's bottom padding is ${box.bottom}px. It IS the clearance — the body is the ` +
        "scroll container, so this is the whole of the gap between the last card and Advance request.",
    );
    assert.ok(
      box.left >= 16 && box.right >= 16,
      `the drawer body's gutter is ${box.left}/${box.right}px; the card sat 14px from the edge before`,
    );
    assert.ok(box.top >= 14, `the drawer body's top padding is ${box.top}px`);
  }
});

test("the Activity History timeline is measured from the card, and its ink follows the theme", async () => {
  const brand = await read(BRAND);
  const [row] = rulesFor(brand, ".detail-drawer__body .activity-timeline > div");
  assert.ok(row, "the timeline's rows must be spaced against the card's content box");
  const box = sides(decl(row.body, "padding"));
  assert.ok(
    box.left >= 22,
    `the timeline row indents ${box.left}px, which is where the text starts relative to its dot`,
  );

  // The dot's ring masks the rule behind it, so it has to BE the card's colour.
  // It was the literal `white`, which is the card in exactly one theme.
  const ring = rulesFor(brand, ".detail-drawer__body .activity-dot");
  assert.ok(ring.length >= 1, "the dot's ring must be repainted; `border: 2px solid white` is in globals.css");
  for (const rule of [...ring, ...rulesFor(brand, 'body[data-theme="dark"] .detail-drawer__body .activity-dot')]) {
    assert.match(
      decl(rule.body, "border-color"),
      /^var\(--[a-z0-9-]+\)$/,
      "the ring takes the card's own surface token",
    );
  }

  // And the inks axe was failing on, in the panel this batch reframed.
  const inks = rulesFor(brand, ".detail-drawer__body .activity-timeline p");
  assert.ok(inks.length >= 1, ".activity-timeline p was #4d616f — 2.35:1 on the dark card, 24 nodes");
  assert.match(decl(inks[0].body, "color"), /^var\(--[a-z0-9-]+\)$/);

  const labels = rulesFor(brand, ".detail-drawer__body .drawer-label");
  assert.ok(labels.length >= 1, ".drawer-label was #70828e — 3.8:1 dark and 3.98:1 light, on every tab");
  assert.match(decl(labels[0].body, "color"), /^var\(--[a-z0-9-]+\)$/);
});

test('the "N events" count is the same size as the heading it sits beside', async () => {
  const brand = await read(BRAND);
  const counts = rulesFor(brand, ".detail-drawer__body .drawer-section__title > span:last-child");
  assert.ok(counts.length >= 2, "the count is stated for the drawer and again for the phone");

  const onPhone = counts.find(phone);
  assert.ok(onPhone, "the phone copy is the one that matters: `.drawer-label` is bumped to 11px there");
  assert.equal(
    decl(onPhone.body, "font-size"),
    "11px",
    "the label is 11px on a phone and the count was left at 8px, so the two did not share a line box",
  );

  const globals = await read(GLOBALS);
  const label = rulesFor(globals, ".drawer-label").find(phone);
  assert.ok(label, "globals.css must still bump the label on a phone");
  assert.equal(
    decl(label.body, "font-size"),
    decl(onPhone.body, "font-size"),
    "the heading and its count have to be the same size, or centring them cannot align them",
  );
});

/* ------------------------------------------------------------------ */
/* The tabs                                                            */
/* ------------------------------------------------------------------ */

test("the phone's tabs have more room than round one gave them", async () => {
  const brand = await read(BRAND);
  const buttons = rulesFor(brand, ".detail-drawer__tabs > button").filter(phone);
  assert.equal(buttons.length, 1, "the phone's pill is described once");
  const [pill] = buttons;

  const minHeight = Number.parseInt(decl(pill.body, "min-height"), 10);
  assert.ok(minHeight >= 46, `a tab is ${minHeight}px tall; round one reached 44 and it was not enough`);
  assert.ok(minHeight <= 56, `a tab is ${minHeight}px tall — the brief said modestly more, not giant`);

  const box = sides(decl(pill.body, "padding"));
  assert.ok(box.top >= 11 && box.bottom >= 11, `a tab pads ${box.top}px vertically; round one had 10`);
  assert.ok(box.left >= 20 && box.right >= 20, `a tab pads ${box.left}px horizontally; round one had 18`);
  assert.ok(box.left <= 28, `a tab pads ${box.left}px horizontally, which is giant, not modest`);

  const radius = Number.parseInt(decl(pill.body, "border-radius"), 10);
  assert.ok(radius >= 12, `the pill's radius is ${radius}px; it should read as a rounded control`);

  // An inactive tab is bordered too — transparently — so it keeps the same box
  // and the row cannot shift by four pixels when the selection moves.
  assert.equal(decl(pill.body, "border"), "2px solid transparent");

  const minWidth = Number.parseInt(decl(pill.body, "min-width"), 10);
  assert.ok(minWidth >= 106, `"Files" needs the same target as "Activity Log"; the floor is ${minWidth}px`);
});

test("the strip separates its pills by more than it insets them", async () => {
  const brand = await read(BRAND);
  const strips = rulesFor(brand, ".detail-drawer__tabs").filter(phone);
  assert.equal(strips.length, 1, "the phone's strip is described once");
  const [strip] = strips;

  const gap = Number.parseInt(decl(strip.body, "gap"), 10);
  const inset = sides(decl(strip.body, "padding")).top;
  assert.ok(gap >= 8, `the strip gaps its tabs by ${gap}px; round one had 6`);
  assert.ok(
    gap >= inset,
    `the strip insets by ${inset}px and gaps by ${gap}px. A row of pills has to be separated by at ` +
      "least as much as it is inset, or it reads as one segmented block.",
  );

  const minHeight = Number.parseInt(decl(strip.body, "min-height"), 10);
  const pill = rulesFor(brand, ".detail-drawer__tabs > button").filter(phone)[0];
  const pillHeight = Number.parseInt(decl(pill.body, "min-height"), 10);
  assert.ok(
    minHeight >= pillHeight + inset * 2,
    `the strip is ${minHeight}px around a ${pillHeight}px pill inset ${inset}px — the pill would be clipped`,
  );

  assert.match(decl(strip.body, "border-radius"), /^\d+px$/);
  assert.ok(
    Number.parseInt(decl(strip.body, "border-radius"), 10) > Number.parseInt(decl(pill.body, "border-radius"), 10),
    "the strip's own corner stays outside the pill's",
  );
  assert.match(decl(strip.body, "background"), /^var\(--[a-z0-9-]+\)$/, "the strip's ground is a token");
});

test("the selected pill is on the MAINTSUPP accent in BOTH themes, not monday's blue", async () => {
  const brand = await read(BRAND);
  const active = rulesFor(brand, ".detail-drawer__tabs > button.is-active").filter(phone);
  const activeDark = rulesFor(brand, 'body[data-theme="dark"] .detail-drawer__tabs > button.is-active').filter(phone);

  assert.ok(active.length >= 1, "the phone's selected pill must be described here");
  assert.ok(
    activeDark.length >= 1,
    "and restated for dark — an earlier teal pass left a dark-only rule in this file that outranks it",
  );

  for (const rule of [...active, ...activeDark]) {
    for (const property of ["border-color", "background", "color"]) {
      const value = decl(rule.body, property);
      assert.ok(value, `the selected pill must state its ${property}`);
      assert.match(
        value,
        /^var\(--[a-z0-9-]+\)$/,
        `the selected pill's ${property} is "${value}". A literal is a colour for ONE theme, and ` +
          "writing it twice is how the light pill stayed monday-blue while the dark one went teal.",
      );
    }
  }

  // Whatever else changes, monday's palette must not be what the drawer's tabs
  // are drawn in. #244bf3/#eef0ff was the light pill; #0073ea was the underline.
  const drawerRules = [
    ...rulesFor(brand, ".detail-drawer__tabs > button.is-active"),
    ...rulesFor(brand, 'body[data-theme="dark"] .detail-drawer__tabs > button.is-active'),
    ...rulesFor(brand, ".detail-drawer__tabs > button.is-active::after"),
    ...rulesFor(brand, ".detail-drawer__tabs"),
    ...rulesFor(brand, ".detail-drawer__tabs > button"),
  ];
  for (const rule of drawerRules) {
    for (const blue of ["#244bf3", "#eef0ff", "#0073ea", "#7180ff", "#31354c"]) {
      assert.doesNotMatch(rule.body, new RegExp(blue, "i"), `${blue} is monday's, not ours`);
    }
  }
});

test("the wide drawer keeps its underline bar, on the accent rather than monday's blue", async () => {
  const brand = await read(BRAND);
  const underline = rulesFor(brand, ".detail-drawer__tabs > button.is-active::after").filter(
    (rule) => !phone(rule),
  );
  assert.equal(underline.length, 1, "the desktop underline is re-branded once, outside any phone query");
  assert.match(
    decl(underline[0].body, "background"),
    /^var\(--[a-z0-9-]+\)$/,
    "the underline was #0073ea — monday's blue, in a product whose accent is teal",
  );

  const wide = rulesFor(brand, ".detail-drawer__tabs > button").filter((rule) => !phone(rule));
  assert.equal(wide.length, 1);
  const minHeight = Number.parseInt(decl(wide[0].body, "min-height"), 10);
  assert.ok(minHeight >= 52, `the wide drawer's tabs are ${minHeight}px; they were 49`);
  const box = sides(decl(wide[0].body, "padding"));
  assert.ok(box.top >= 11 && box.left >= 16, `the wide drawer's tabs pad ${box.top}/${box.left}px; they were 9/14`);
});

/* ------------------------------------------------------------------ */
/* globals.css: nothing stale, nothing contradicting                   */
/* ------------------------------------------------------------------ */

test("every tab rule in globals pads on both axes — none of them is 0 vertical", async () => {
  const css = await read(GLOBALS);
  const buttons = rulesFor(css, ".detail-drawer__tabs > button");
  assert.ok(buttons.length >= 3, `expected the button rule in several places, found ${buttons.length}`);

  let padded = 0;
  for (const rule of buttons) {
    const padding = decl(rule.body, "padding");
    if (!padding) continue;
    padded += 1;
    const top = sides(padding).top;
    assert.notEqual(top, 0, `a tab still declares "padding: ${padding}". Zero vertical padding is what put the active frame on the word.`);
    assert.notEqual(top, null, `a tab's vertical padding should be a pixel value, got "${padding}"`);
    assert.ok(top >= 6, `a tab pads only ${top}px vertically; the strip needs at least 6px of it.`);
  }
  assert.ok(padded >= 3, `expected padding on at least three copies of the rule, found ${padded}`);
});

test("no copy of the rule is left saying the old numbers", async () => {
  const css = await read(GLOBALS);
  for (const rule of rulesFor(css, ".detail-drawer__tabs > button")) {
    assert.notEqual(decl(rule.body, "padding"), "0 15px", "a stale copy still carries the flush 0/15 padding");
    assert.notEqual(decl(rule.body, "min-height"), "40px", "a stale copy still carries the old 40px target");
  }
  for (const rule of rulesFor(css, ".detail-drawer__tabs")) {
    assert.notEqual(decl(rule.body, "min-height"), "46px", "a stale copy still carries the old 46px strip");
    assert.notEqual(decl(rule.body, "padding"), "3px", "a stale copy still carries the old 3px strip padding");
  }
  for (const rule of rulesFor(css, ".detail-drawer__tabs > button").filter((one) => decl(one.body, "min-height"))) {
    const minHeight = Number.parseInt(decl(rule.body, "min-height"), 10);
    assert.ok(minHeight >= 44, `a tab's min-height is ${minHeight}px; 44 is the floor globals may state`);
  }
});

test("labels are centred on both axes and the strip scrolls rather than wrapping", async () => {
  const css = await read(GLOBALS);
  const buttons = rulesFor(css, ".detail-drawer__tabs > button");

  const centred = buttons.filter(
    (rule) => decl(rule.body, "justify-content") === "center" && decl(rule.body, "align-items") === "center",
  );
  assert.ok(
    centred.length >= 3,
    `only ${centred.length} copies centre the label on both axes; every copy that lays the button out must`,
  );

  // nowrap lives on the base rule and is never overridden, here or in brand.
  assert.ok(
    buttons.some((rule) => decl(rule.body, "white-space") === "nowrap"),
    "a long label must not wrap mid-word; the strip scrolls instead",
  );
  const brand = await read(BRAND);
  for (const rule of [...buttons, ...rulesFor(brand, ".detail-drawer__tabs > button")]) {
    assert.notEqual(decl(rule.body, "white-space"), "normal", "no copy may re-enable wrapping");
  }

  assert.ok(
    rulesFor(css, ".detail-drawer__tabs").some((rule) => decl(rule.body, "overflow-x") === "auto"),
    'the strip keeps "overflow-x: auto" so "Contractor link" is reachable at 320px',
  );
  for (const rule of rulesFor(brand, ".detail-drawer__tabs")) {
    assert.notEqual(decl(rule.body, "overflow-x"), "hidden", "the override must not take the scroll away");
  }
});

test("the dark theme states the selected tab's colour outside any media query", async () => {
  const css = await read(GLOBALS);
  // The board's dark rules are the LAST `body[data-theme="dark"]` block — the
  // native-nesting one, not the palette at the top of the file.
  const at = css.lastIndexOf('body[data-theme="dark"] {');
  assert.ok(at > 0);
  const dark = css.slice(at);
  const [active] = rulesFor(dark, ".detail-drawer__tabs > button.is-active");
  assert.ok(
    active,
    "the dark theme must restate the selected tab's colour. The base rule paints it " +
      "#182c36 for a white strip; with no correction here, every screen wider than " +
      "760px drew the selected label at 1.11:1 on the dark drawer.",
  );
  assert.ok(decl(active.body, "color"), "the rule exists to set a colour");
  assert.equal(active.media, "", "the dark selected-tab rule has to apply at every width");
});

/* ------------------------------------------------------------------ */
/* The markup the whole thing hangs off                                */
/* ------------------------------------------------------------------ */

test("the drawer still offers its five sections, from the same nav", async () => {
  const portal = await read(PORTAL);
  const nav = portal.slice(
    portal.indexOf('<nav className="detail-drawer__tabs"'),
    portal.indexOf("</nav>", portal.indexOf('<nav className="detail-drawer__tabs"')),
  );
  assert.ok(nav.length > 0, 'the tab strip is still a <nav className="detail-drawer__tabs">');
  for (const label of ["Columns", "Updates / ", "Files", "Activity Log", "Contractor link"]) {
    assert.ok(nav.includes(label), `the drawer must still offer "${label}"`);
  }
  // Five buttons, no more: the strip is a tab bar, not a toolbar.
  assert.equal((nav.match(/<button/g) || []).length, 5);
});

test("every tab still renders into the shell the frame is drawn on", async () => {
  const portal = await read(PORTAL);
  // Files, Updates, Activity Log and Contractor link are `.drawer-section`s and
  // therefore share the card. The phone's Columns pane is `.mobile-monday-columns`
  // — a list of controls, each already bordered — and deliberately does not.
  for (const tab of ["files", "updates", "activity", "link"]) {
    assert.ok(
      new RegExp(`className=\\{\`drawer-section\\$\\{[\\s\\S]{0,120}activeTab === "${tab}"`).test(portal),
      `the ${tab} tab must still be a .drawer-section, or it loses the frame`,
    );
  }
  assert.match(portal, /<MobileMondayColumns/, "the phone's Columns pane is its own component");
});
