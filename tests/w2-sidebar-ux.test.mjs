/**
 * W2 — the sidebar's two reported defects: the support card, and the workspace
 * dropdown.
 *
 * ---------------------------------------------------------------------------
 * 1. "NEED A HAND?" WAS FURNITURE, NOT CONTENT
 *
 * The card carried `margin-top: auto` as the last flex item of the rail column,
 * which made it permanent chrome: it sat between the scrolling nav and the
 * profile block on every screen and every route, whether or not the reader had
 * scrolled anywhere near the end of their own navigation.
 *
 * Measured in Chromium at 1440x900 before the fix: `.portal-nav` was a 472px
 * scroll window onto an 839px list, the card took 59px directly under it and
 * the profile block another 50px — so a promotional panel and a footer between
 * them owned 109px of a 900px rail, permanently, and the nav's last row
 * ("Customise sidebar") was sliced in half against the card's top edge. That
 * clipping is what reads on a screenshot as the card floating over the
 * navigation.
 *
 * The fix is structural rather than cosmetic: ONE scroll region — `.sidebar-
 * scroll` — holds the nav and the card, in that order, so the card is the last
 * block of the scrollable content and is reached only by scrolling to the
 * bottom. The tests below pin the three things that can quietly undo it:
 * the auto margin coming back, the nav becoming a scroller again inside the
 * region (two nested scrollers is the double-scrollbar trap), and the card or
 * the region acquiring `position: fixed | sticky`.
 *
 * ---------------------------------------------------------------------------
 * 2. THE WORKSPACE PICKER'S OPEN LIST WAS WHITE ON WHITE
 *
 * `.workspace-switcher__copy select` is `background: transparent; color:
 * var(--rail-fg)` — correct on the rail's dark card, and wrong the moment the
 * platform draws the menu. Measured in Chromium at 1440x900 with the light
 * theme selected: `option { color: rgb(234, 243, 246); background-color:
 * rgba(0, 0, 0, 0) }`, i.e. near-white ink on the popup's own light ground,
 * 1.0:1. Only the hovered row was legible, because that one is painted by the
 * platform's highlight and not by this stylesheet — which is exactly the
 * reported symptom, one readable option and one invisible one.
 *
 * `color-scheme: dark` on `.portal-sidebar` is necessary, was already there,
 * and is not sufficient: it fixes the popup's furniture while the UA's own
 * `option` background still resolves against the ROOT colour scheme. The
 * remaining half is to state the option colours, which is what
 * `.theme-toggle select option` in globals.css has always done for the same
 * reason. Both halves are pinned here, together, because either one alone
 * looks like a complete fix and is not.
 *
 * These are static assertions: they run with no browser and no server and they
 * fail on the cause. The ratios quoted come from the token values themselves
 * and are recomputed below, so a token edit that breaks them fails here rather
 * than on somebody's screen.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const GLOBALS = "app/globals.css";
const BRAND = "app/brand-overrides.css";
const PORTAL = "app/(app)/portal/portal-app.tsx";

/**
 * Comments in these files hold braces and colour literals. Strip them — and
 * normalise the line endings, because brand-overrides.css is CRLF while
 * globals.css is LF and there is no `.gitattributes` to make them agree. A
 * multi-line selector list matched against an LF pattern silently misses in
 * one of the two files, which is a test that passes for the wrong reason.
 */
const strip = (css) => css.replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Every rule in a stylesheet, nested ones included, as
 * `{ selector, declarations }`. Brace-matched rather than regexed: the sheets
 * use `@media` and CSS nesting, and a flat regex reports a nested rule as
 * absent — which is how a rule can be obviously present and still not found.
 */
function rulesOf(css) {
  const found = [];
  const walk = (source) => {
    let index = 0;
    let start = 0;
    while (index < source.length) {
      const char = source[index];
      if (char === "{") {
        const selector = source.slice(start, index).trim();
        let depth = 1;
        let end = index + 1;
        while (end < source.length && depth > 0) {
          if (source[end] === "{") depth += 1;
          else if (source[end] === "}") depth -= 1;
          end += 1;
        }
        const body = source.slice(index + 1, end - 1);
        found.push({ selector, declarations: body });
        walk(body);
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
  };
  walk(strip(css));
  return found;
}

/** The declarations of the rule whose selector list is exactly `selector`. */
function ruleFor(css, selector) {
  const wanted = selector.replace(/\s+/g, " ").trim();
  const hit = rulesOf(css).find(
    (rule) => rule.selector.replace(/\s+/g, " ").trim() === wanted,
  );
  return hit ? hit.declarations : null;
}

/** Every `@media` block whose condition mentions a max-width at or below px. */
function mobileBlocks(css, px = 768) {
  const source = strip(css);
  let out = "";
  const pattern = /@media[^{]*max-width:\s*(\d+)px[^{]*\{/g;
  let match;
  while ((match = pattern.exec(source))) {
    if (Number(match[1]) > px) continue;
    let depth = 1;
    let end = pattern.lastIndex;
    while (end < source.length && depth > 0) {
      if (source[end] === "{") depth += 1;
      else if (source[end] === "}") depth -= 1;
      end += 1;
    }
    out += source.slice(pattern.lastIndex, end - 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Contrast, computed from the tokens rather than quoted from a comment
// ---------------------------------------------------------------------------

const channels = (value) => {
  let hex = value.trim().replace("#", "");
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
};

const luminance = (rgb) => {
  const [r, g, b] = rgb.map((raw) => {
    const channel = raw / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : Math.pow((channel + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrastRatio = (a, b) => {
  const one = luminance(channels(a));
  const two = luminance(channels(b));
  const [high, low] = one > two ? [one, two] : [two, one];
  return (high + 0.05) / (low + 0.05);
};

/** The `--rail-*` custom properties, read off the bare `:root` in globals.css. */
async function railTokens() {
  const source = strip(await read(GLOBALS));
  const tokens = {};
  for (const [, name, value] of source.matchAll(/(--rail-[a-z-]+):\s*([^;]+);/g)) {
    if (!(name in tokens)) tokens[name] = value.trim();
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// 1. The support card is the end of the navigation, not a fixture above it
// ---------------------------------------------------------------------------

test("the support card is inside the rail's scroll region, after the nav", async () => {
  const portal = await read(PORTAL);

  const region = portal.indexOf('<div className="sidebar-scroll">');
  assert.notEqual(region, -1, "the rail must have one scroll region for the nav");

  const nav = portal.indexOf("<SidebarNav", region);
  const help = portal.indexOf('<div className="sidebar-help">', region);
  const profile = portal.indexOf('<div className="sidebar-profile">', region);

  assert.ok(nav > region, "<SidebarNav> belongs inside the scroll region");
  assert.ok(help > nav, "the support card comes AFTER the nav — it is its end");

  /*
   * And the region closes before the profile block. The profile is the rail's
   * footer and keeps its accepted behaviour; putting it inside the scroller
   * would take the signed-in identity off the screen, which was never the
   * defect.
   */
  const closes = portal.indexOf("\n        </div>", help);
  assert.ok(closes > help, "the scroll region must close after the support card");
  assert.ok(
    profile > closes,
    "the profile footer stays OUTSIDE the scroll region — it is the rail's footer",
  );
});

test("the card no longer takes the rail's free height with an auto margin", async () => {
  const globals = await read(GLOBALS);
  const brand = await read(BRAND);

  const help = ruleFor(globals, ".sidebar-help");
  assert.ok(help, ".sidebar-help must still be laid out in globals.css");
  assert.doesNotMatch(
    help,
    /margin-top:\s*auto/,
    "`margin-top: auto` is what made the card permanent chrome — as the last " +
      "flex item it ate the column's free height and parked itself above the " +
      "profile block on every screen",
  );
  assert.match(
    help,
    /margin-top:\s*\d+(\.\d+)?px/,
    "it needs a real margin instead, so it sits under the last nav row",
  );

  // The same trap one level in: inside `.sidebar-scroll` an auto margin would
  // pin the card to the bottom of the scroll viewport whenever the nav is
  // short enough to fit, which is the identical defect in a smaller box.
  for (const [name, sheet] of [["globals.css", globals], ["brand-overrides.css", brand]]) {
    for (const [, block] of strip(sheet).matchAll(/\.sidebar-help[^{}]*\{([^}]*)\}/g)) {
      assert.doesNotMatch(
        block,
        /margin-top:\s*auto/,
        `${name}: no copy of the card rule may bring the auto margin back`,
      );
    }
  }
});

test("nothing in the rail is fixed or sticky over the navigation", async () => {
  const globals = strip(await read(GLOBALS));
  const brand = strip(await read(BRAND));

  /*
   * `.portal-sidebar` itself is `position: fixed` and must stay that way — it
   * is the rail. What must never be fixed or sticky is anything INSIDE it,
   * because that is how a panel comes to float over the nav rows instead of
   * scrolling with them.
   */
  const inside = /\.(sidebar-help|sidebar-help__icon|sidebar-scroll|portal-nav)\b[^{}]*\{([^}]*)\}/g;
  for (const [name, sheet] of [["globals.css", globals], ["brand-overrides.css", brand]]) {
    for (const [selector, , block] of sheet.matchAll(inside)) {
      assert.doesNotMatch(
        block,
        /position:\s*(fixed|sticky)/,
        `${name}: ${selector.trim().split("\n")[0]} must scroll with the nav, not float over it`,
      );
    }
  }
});

test("the rail has exactly one scroll container, and the nav is not it", async () => {
  const globals = await read(GLOBALS);
  const brand = await read(BRAND);

  const region = ruleFor(globals, ".sidebar-scroll");
  assert.ok(region, ".sidebar-scroll must be declared in globals.css");
  assert.match(region, /overflow-y:\s*auto/, "the region is the rail's scroller");

  /*
   * `min-height: 0` is the half that is easy to drop and impossible to see.
   * `.portal-sidebar` is a fixed-height flex column and a flex item's automatic
   * minimum size is its content, so without this the region refuses to shrink
   * below the full height of the nav list and pushes the profile footer off the
   * bottom of a short viewport instead of scrolling.
   */
  assert.match(
    region,
    /min-height:\s*0/,
    "without min-height: 0 the region cannot shrink and the footer is pushed off a short screen",
  );
  assert.match(region, /flex:\s*1 1 auto/, "the region takes the rail's spare height");
  assert.match(
    region,
    /overscroll-behavior:\s*contain/,
    "flicking past the end of the nav must not scroll the board behind it",
  );

  /*
   * And the nav must NOT be a scroller of its own. This is the double-scrollbar
   * trap: two nested scroll containers means the outer one takes the wheel
   * gesture and the inner list can never be scrolled to its own end. There are
   * two copies of the blanket `.portal-nav` rule — globals.css and the verbatim
   * copy at the head of brand-overrides.css, which loads last and wins — so
   * both are checked; fixing one alone has historically done nothing.
   */
  for (const [name, sheet] of [["globals.css", globals], ["brand-overrides.css", brand]]) {
    for (const [, block] of strip(sheet).matchAll(/\.portal-nav\s*\{([^}]*)\}/g)) {
      assert.doesNotMatch(
        block,
        /overflow-y:\s*(auto|scroll)/,
        `${name}: .portal-nav must hand its height to .sidebar-scroll, not scroll itself`,
      );
    }
  }
});

test("the region's siblings cannot be compressed to buy it room", async () => {
  const globals = await read(GLOBALS);

  /*
   * The compression defect this prevents is documented and was real: the
   * workspace picker was squeezed to its min-height on a short viewport while
   * its own 44px <select> kept full size and spilled out of the box, under
   * `.workspace-identity`, which then swallowed 15px of the control's taps.
   * The brand block, the picker, the identity line and the profile footer are
   * all fixed furniture; the one element allowed to give is the one that
   * scrolls.
   */
  const guard = ruleFor(globals, ".portal-sidebar > *:not(.sidebar-scroll)");
  assert.ok(
    guard,
    "everything in the rail except the scroll region must be flex-shrink: 0",
  );
  assert.match(guard, /flex-shrink:\s*0/);

  const help = ruleFor(globals, ".sidebar-help");
  assert.match(
    help,
    /flex-shrink:\s*0/,
    "the card is the end of a scroller, not a compressible gap above the footer",
  );
});

test("on a phone the whole rail scrolls as one thing", async () => {
  const mobile = mobileBlocks(await read(BRAND));

  /*
   * Below 768px `.portal-sidebar` is the scroller (stage 25 — an iPhone SE is
   * 667px and the drawer does not fit). A scrolling `.sidebar-scroll` inside a
   * scrolling `.portal-sidebar` is the same nested-scroller trap in a 568px
   * drawer, so the region hands its height up exactly as `.portal-nav` hands
   * its height to the region.
   */
  const region = ruleFor(mobile, ".sidebar-scroll");
  assert.ok(region, ".sidebar-scroll must be addressed inside a <=768px block");
  assert.match(
    region,
    /overflow-y:\s*visible/,
    "the region must not be a second scroller inside the scrolling drawer",
  );
  assert.match(
    region,
    /flex:\s*none/,
    "a region that no longer scrolls cannot be allowed to shrink — it would clip the nav",
  );

  const nav = ruleFor(mobile, ".portal-nav");
  assert.ok(nav, ".portal-nav must still be addressed inside a <=768px block");
  assert.match(nav, /overflow-y:\s*visible/);
});

// ---------------------------------------------------------------------------
// 2. The workspace dropdown, in every state
// ---------------------------------------------------------------------------

test("the rail's open <select> menus state their own colours", async () => {
  const brand = strip(await read(BRAND));

  /*
   * The platform draws these rows. Nothing is inherited into them, and an
   * option with no author background computes to `rgba(0, 0, 0, 0)` over a
   * popup ground painted for the ROOT colour scheme — which is how near-white
   * `--rail-fg` came to sit on a white menu at 1.0:1.
   */
  const options = ruleFor(
    brand,
    ".portal-sidebar .workspace-switcher__copy select option,\n.portal-sidebar .sidebar-profile__copy select option",
  );
  assert.ok(
    options,
    "both rail <select>s must state option colours — the workspace picker AND Testing access",
  );
  assert.match(options, /background:\s*var\(--rail-bg-raised\)/);
  assert.match(options, /color:\s*var\(--rail-fg\)/);

  /*
   * Two class selectors deep on purpose. `body[data-theme="dark"] select
   * option` further up this file is (0,1,3); a one-class rule would lose to it
   * and the rail's menus would be decided by the theme in one direction and by
   * this rule in the other.
   */
  assert.ok(
    /\.portal-sidebar\s+\.workspace-switcher__copy\s+select\s+option/.test(brand),
    "the rule must outrank the blanket dark-theme option rule, hence .portal-sidebar in front",
  );

  const checked = ruleFor(
    brand,
    ".portal-sidebar .workspace-switcher__copy select option:checked,\n.portal-sidebar .sidebar-profile__copy select option:checked",
  );
  assert.ok(checked, "the current workspace must be stated, not left to the platform");
  assert.match(checked, /background:\s*var\(--rail-active-bg\)/);
  assert.match(checked, /color:\s*var\(--rail-active-fg\)/);

  const disabled = ruleFor(
    brand,
    ".portal-sidebar .workspace-switcher__copy select option:disabled,\n.portal-sidebar .sidebar-profile__copy select option:disabled",
  );
  assert.ok(disabled, "an option that cannot be chosen still has to be readable");
  assert.match(disabled, /color:\s*var\(--rail-fg-muted\)/);

  /*
   * The trigger while the context is loading or a switch is in flight. The
   * browser's default disabled treatment fades the text, which took the name
   * of the client whose data is on screen to roughly 2:1 on the rail's card.
   */
  const busy = ruleFor(brand, ".workspace-switcher__copy select:disabled");
  assert.ok(busy, "the trigger must stay readable while the switch is in flight");
  assert.match(busy, /color:\s*var\(--rail-fg-muted\)/);
  assert.match(busy, /opacity:\s*1/);
});

test("the two halves of the dropdown fix are both present", async () => {
  /*
   * Either half looks like a complete fix on its own and is not.
   *
   * `color-scheme: dark` tells the browser to draw the popup's own furniture —
   * its ground, its scrollbar, its border — for a dark surface. It does not
   * decide the option rows, because the UA's option background resolves
   * against the root scheme, which is `light` whenever the reader has chosen
   * the light theme. The option rules decide the rows and cannot reach the
   * furniture. Removing either one reopens the defect on one of the two
   * surfaces, so both are asserted here in one place with that reason.
   */
  const globals = strip(await read(GLOBALS));
  const brand = strip(await read(BRAND));

  // The rail's LAYOUT rule, not the blanket colour copy of the same selector
  // near the top of the sheet — there are two, and only one of them is the one
  // that owns the rail's surface.
  const rail = rulesOf(globals).find(
    (rule) =>
      rule.selector === ".portal-sidebar" && /position:\s*fixed/.test(rule.declarations),
  );
  assert.ok(rail, "the rail's layout rule must exist");
  assert.match(
    rail.declarations,
    /color-scheme:\s*dark/,
    "half one: the popup's own furniture follows the rail, not the page",
  );
  assert.match(
    brand,
    /select option\s*\{[^}]*background:\s*var\(--rail-bg-raised\)/,
    "half two: the option rows are painted by this stylesheet, not by the UA",
  );
});

test("every state of the workspace picker clears WCAG AA on the rail", async () => {
  const tokens = await railTokens();

  /** The card the picker sits on: --rail-card-bg is white at 6% over the rail. */
  const alpha = 0.06;
  const railBg = channels(tokens["--rail-bg"]);
  const card =
    "#" +
    [255, 255, 255]
      .map((white, index) =>
        Math.round(white * alpha + railBg[index] * (1 - alpha))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("");

  const states = [
    ["trigger, resting", tokens["--rail-fg"], card],
    ["trigger, busy", tokens["--rail-fg-muted"], card],
    ["option, normal", tokens["--rail-fg"], tokens["--rail-bg-raised"]],
    ["option, selected", tokens["--rail-active-fg"], tokens["--rail-active-bg"]],
    ["option, disabled", tokens["--rail-fg-muted"], tokens["--rail-bg-raised"]],
    ["focus ring on the card", tokens["--rail-accent"], card],
    ["Testing access trigger", tokens["--rail-accent"], tokens["--rail-control-bg"]],
  ];

  const failures = [];
  for (const [name, ink, ground] of states) {
    const ratio = contrastRatio(ink, ground);
    // 4.5 is AA for body text; these all clear 7 (AAA) and are asserted at 4.5
    // so a legitimate palette adjustment is not blocked by a decimal.
    if (ratio < 4.5) failures.push(`${name}: ${ratio.toFixed(2)}:1`);
  }
  assert.deepEqual(
    failures,
    [],
    "the reported defect measured 1.0:1 — near-white ink on the platform's own light menu",
  );

  // The hovered row is painted by the platform's highlight and was the only
  // legible state before the fix; it is not ours to assert. What IS ours is
  // that the ground behind every other row is opaque, because a translucent
  // card token would let the popup's light ground show through and put the
  // failure straight back.
  assert.doesNotMatch(
    tokens["--rail-bg-raised"],
    /rgba|hsla/,
    "the option ground must be opaque or the popup's own ground shows through",
  );
});
