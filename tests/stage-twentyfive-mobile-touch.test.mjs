/**
 * Stage 25 — the three phone defects the pre-launch audit confirmed.
 *
 * All three were reproduced at 390x844 with `mobile: true` and touch emulation
 * on, over CDP, before anything was changed, and re-measured after. The reader
 * they are about is the one the owner was worried about: an engineer holding a
 * phone, standing in a shop, with a job open.
 *
 * ---------------------------------------------------------------------------
 * 1. THE WORKSPACE SWITCHER HAD 15px OF DEAD CONTROL
 *
 * `.portal-sidebar` is `position: fixed; top: 0; bottom: 0` — a flex column
 * pinned to exactly the viewport height — and every child is a shrinkable flex
 * item. `.workspace-switcher` carried `min-height: 55px`, sized when its
 * <select> was an 11px control about 30px tall. The touch-target work then gave
 * `.portal-shell select` a `min-height: 44px` floor at <=768px without resizing
 * the box around it, so the switcher's content needed ~79px in a 55px box, and
 * the column — already out of height at 844px — crushed it to exactly its 55px
 * floor.
 *
 * Measured before: switcher y44->99, its <select> y70->114. The bottom 15px of
 * a 44px control sat underneath `.workspace-identity` (y99->146), which paints
 * over it. Hit-testing down the select's centre line returned the select at
 * y72..96 and `div.workspace-identity` at y102 and y108 — 29px of tappable
 * control out of 44px, 34% of it dead. This is how the owner moves between
 * Sunnamusk UK and Demo Client Ltd.
 *
 * Measured after: switcher y44->123.4, select y70.4->114.4 fully inside it,
 * identity moved down to y123.4, and all nine hit-test samples down the
 * select's centre line return the select. Verified again at 375x667 (iPhone
 * SE), where the column has 177px less room.
 *
 * `flex-shrink: 0` is the fix that matters — it stops the column taking height
 * from the switcher. The raised `min-height` stops the floor being smaller
 * than the thing standing on it. `overflow-y: auto` on the sidebar is the
 * general guard: a column that cannot fit its contents should scroll, not
 * silently compress whichever child is least rigid.
 *
 * ---------------------------------------------------------------------------
 * 2. NOTHING LOCKED PAGE SCROLL BEHIND AN OVERLAY
 *
 * With the job drawer open on /dashboard/jobs — a fixed 390x844 panel at
 * z-index 510 over a z-500 scrim — `body` computed `overflow: visible` and the
 * document was 90,120px tall. Scrolling moved the list behind the drawer, so
 * closing it left the reader ~1,400px from where they started, in a list 107
 * screens long. The nav drawer behaved identically. A full-viewport scrim does
 * not help: it swallows clicks, it does not stop a touch-drag or an inertial
 * fling from reaching the scroller behind it.
 *
 * Measured after: parked at y2400, opened the drawer, `scrollTo(0, 1500)` moved
 * nothing, closed the drawer, back at exactly y2400. Same for the nav drawer at
 * y1800. With BOTH open, closing one left the page still locked and still in
 * place, and only the last close released it — which is why the lock is a
 * counter and not a flag.
 *
 * ---------------------------------------------------------------------------
 * 3. CONTROLS UNDER 16px ZOOMED THE PAGE ON FOCUS
 *
 * iOS Safari zooms the page in when a control under 16px takes focus, and does
 * not zoom back out. Measured before: /request all six fields at 12px and only
 * 41px tall; the create-request modal at 14px; the drawer's update composer at
 * 14px; /invite and /reset at 15px; the contractor page's `completedOn` date
 * input at 13.33px in a 21.3px box; the dashboard chrome selects at 14px; the
 * workspace switcher select at 11px.
 *
 * Measured after: zero controls under 16px on /request, /login, /dashboard,
 * /dashboard/jobs, /dashboard/settings, /dashboard/account, the create-request
 * modal, the drawer's Updates tab, /j/<token>, /invite/<token> and
 * /reset/<token>.
 *
 * Two things are load-bearing in that fix and are asserted below.
 *
 * (a) The board keeps its density. A blanket 16px was only safe because the
 *     board's visible cells are not form controls: measured on /dashboard/jobs
 *     at 390px, everything inside `.live-sheet` is either a checkbox (814) or a
 *     zero-height select behind the custom cell UI (776). `button` is excluded
 *     from the floor for the same reason — a button cannot be typed into, so it
 *     never triggers the zoom, and inflating every button is what would cost
 *     the board its rows.
 *
 * (b) The selector has to out-specify, not just out-order. The obvious
 *     `.portal-shell :is(input, select, textarea)` scores 0-1-1, which only
 *     ties `.form-field :is(...)` and `.account-field input`; and the per-view
 *     stylesheets are imported from their components, so they load after
 *     brand-overrides.css and won every tie. /dashboard/account still measured
 *     13px across all nine fields until the floor was raised to 0-3-1.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const BRAND = "app/brand-overrides.css";
const GLOBALS = "app/globals.css";
const PORTAL = "app/(app)/portal/portal-app.tsx";
const INVITE = "app/(public)/invite/[token]/invite.css";
const JOB_LINK = "app/(public)/j/[token]/job-link.css";

/**
 * Every `@media (max-width: <=768px)` body in a stylesheet, concatenated.
 *
 * Brace-matched rather than regexed to a closing brace: these blocks contain
 * nested rules, and a lazy `[^}]*` match stops at the first inner `}` and would
 * report a rule missing that is plainly there. Blocks at 760px are included
 * because a phone at 390px is inside both, and which of the two a rule lives in
 * is not something these assertions should care about.
 */
function mobileBlocks(css) {
  let out = "";
  const opener = /@media\s*\(max-width:\s*(\d+)px\)\s*\{/g;
  let match;
  while ((match = opener.exec(css))) {
    if (Number(match[1]) > 768) continue;
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < css.length && depth > 0) {
      const char = css[index];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      index += 1;
    }
    out += `\n${css.slice(start, index - 1)}`;
  }
  return out;
}

/** The declaration block for `selector` inside `css`, or null. */
function ruleFor(css, selector) {
  const at = css.indexOf(selector);
  if (at === -1) return null;
  const open = css.indexOf("{", at);
  if (open === -1) return null;
  const close = css.indexOf("}", open);
  return close === -1 ? null : css.slice(open + 1, close);
}

test("the workspace switcher cannot be crushed under its own select", async () => {
  const mobile = mobileBlocks(await read(BRAND));

  const switcher = ruleFor(mobile, ".workspace-switcher {");
  assert.ok(switcher, ".workspace-switcher must be sized inside a <=768px block");

  /*
   * The fix that actually holds. Without this the sidebar column takes the
   * height back and the switcher returns to its floor however large the floor
   * is, which is exactly how the defect was introduced in the first place.
   */
  assert.match(
    switcher,
    /flex-shrink:\s*0/,
    ".workspace-switcher must not be a shrinkable flex item on a phone",
  );

  /*
   * The floor has to clear what stands on it: a 44px select, 8px of padding
   * top and bottom, and the ~16px "Workspace" label with its 2px gap. 78px is
   * what the box measures; anything below 76 puts the select back over the
   * edge and back under `.workspace-identity`.
   */
  const floor = /min-height:\s*(\d+(?:\.\d+)?)px/.exec(switcher);
  assert.ok(floor, ".workspace-switcher needs an explicit mobile min-height");
  assert.ok(
    Number(floor[1]) >= 76,
    `the switcher's mobile min-height must fit a 44px select plus its padding and label; found ${floor[1]}px`,
  );

  /*
   * And the reason it could be crushed at all. At 844px the drawer only just
   * fits; an iPhone SE is 667px.
   */
  const sidebar = ruleFor(mobile, ".portal-sidebar {");
  assert.ok(sidebar, ".portal-sidebar must be addressed inside a <=768px block");
  assert.match(
    sidebar,
    /overflow-y:\s*auto/,
    "the nav column must scroll when it runs out of height, not compress its children",
  );
});

test("the 44px select floor that broke the switcher is still there", async () => {
  // The fix must not have been 'take the touch target back'. Both controls in
  // the switcher row are held to 44px, and the container was resized to suit.
  const mobile = mobileBlocks(await read(BRAND));
  assert.match(mobile, /\.portal-shell select\s*\{[^}]*min-height:\s*44px/);
  assert.match(mobile, /\.workspace-switcher__add/);
});

test("an open overlay locks the page behind it, and gives the position back", async () => {
  const portal = await read(PORTAL);

  assert.match(portal, /function useScrollLock\(active: boolean\)/);

  /*
   * A counter, not a boolean. Two overlays can be open at once — the nav drawer
   * over an open job drawer — and with independent flags whichever closed first
   * would unlock the page while the other was still up, and would restore ITS
   * saved offset over the other's.
   */
  assert.match(portal, /let scrollLockDepth = 0;/);
  assert.match(portal, /scrollLockDepth \+= 1;/);
  assert.match(portal, /scrollLockDepth = Math\.max\(0, scrollLockDepth - 1\);/);
  assert.match(
    portal,
    /if \(scrollLockDepth > 0\) return;/,
    "the page must stay locked while any other overlay is still open",
  );

  // The offset is captured on the first lock and handed back on the last release.
  assert.match(portal, /scrollLockOffset = window\.scrollY;/);
  assert.match(portal, /--scroll-lock-offset/);
  /*
   * `instant` matters: `html` carries `scroll-behavior: smooth`, so a
   * default-behaviour restore would animate ~90,000px back into place.
   */
  assert.match(
    portal,
    /window\.scrollTo\(\{\s*top: scrollLockOffset,\s*left: 0,\s*behavior: "instant"\s*\}\)/,
    "the restore must be instant, or it animates the length of the document",
  );

  // Every overlay this file owns goes through the one counter.
  assert.match(portal, /useScrollLock\(mobileNavOpen\)/);
  assert.match(portal, /useScrollLock\(showCreateRequest\)/);
  assert.match(
    portal,
    /useScrollLock\(true\)/,
    "the job drawer takes the lock for as long as it is mounted",
  );
});

test("the locked page is actually immobile, and does not jump", async () => {
  const locked = ruleFor(await read(GLOBALS), "body.is-scroll-locked {");
  assert.ok(locked, "globals.css must define body.is-scroll-locked");

  /*
   * `position: fixed`, not `overflow: hidden` alone. On iOS Safari — every
   * engineer standing in a shop — `overflow: hidden` on the body is not
   * reliably honoured for touch scrolling; taking the body out of flow is the
   * technique that holds.
   */
  assert.match(locked, /position:\s*fixed/);
  assert.match(locked, /overflow:\s*hidden/);
  // Which resets the scroll position to 0, so the frozen offset comes back as
  // a negative `top` or the page visibly jumps to the top as the drawer opens.
  assert.match(locked, /top:\s*var\(--scroll-lock-offset/);
  assert.match(locked, /width:\s*100%/);
});

test("no control a reader types into is under 16px on a phone", async () => {
  const brand = await read(BRAND);
  const mobile = mobileBlocks(brand);

  const floor =
    /:root\s+:is\(input, select, textarea\):not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)\s*\{([^}]*)\}/.exec(
      mobile,
    );
  assert.ok(
    floor,
    "the <=768px 16px floor for input/select/textarea is missing or has been re-scoped",
  );
  assert.match(floor[1], /font-size:\s*16px/);

  /*
   * Specificity, not order. See the note at the top of this file: 0-1-1 only
   * ties `.account-field input`, and the per-view stylesheets load last.
   * `:root` plus the two `:not([type=...])` clauses is what makes it 0-3-1.
   */
  assert.ok(
    floor[0].startsWith(":root "),
    "the floor must out-specify the per-view stylesheets, not merely follow them",
  );

  /*
   * `button` must stay out of it. A button cannot be typed into, so it never
   * triggers the zoom, and 16px on every button is what would cost the board
   * the row density this project has twice refused to trade away.
   */
  assert.ok(
    !/:is\(button, input, select, textarea\)[^}]*font-size:\s*16px/.test(mobile),
    "buttons must not be swept into the 16px floor — that is the board's density",
  );

  // The public form's fields were 41px as well as 12px.
  assert.match(mobile, /\.form-field :is\(input, select\)[\s\S]{0,80}min-height:\s*44px/);
});

test("the pages reached by a handed-out link are covered too", async () => {
  /*
   * `(public)` deliberately loads no shared stylesheet — the contractor page
   * brings its own 4KB rather than inherit the dashboard's 254KB — so the
   * floor in brand-overrides.css cannot reach these three. Each stylesheet
   * carries its own.
   */
  const invite = await read(INVITE);
  const field = ruleFor(invite, ".invite__field input {");
  assert.ok(field, "invite.css must still size its fields");
  assert.match(field, /font-size:\s*16px/);
  assert.ok(
    !/font-size:\s*15px/.test(field),
    "15px is under the line iOS zooms at — this is also /reset, which @imports this file",
  );

  const jobLink = await read(JOB_LINK);
  /*
   * The defect here was a gap, not a number: `completedOn` is
   * `input[type="date"]`, which matched neither `[type="text"]` nor
   * `:not([type])`, so it fell through to the user agent — 13.33px in a 21.3px
   * box. Written by exclusion now so the next input type added cannot fall
   * through the same gap.
   */
  assert.match(
    jobLink,
    /\.job-link input:not\(\[type="file"\]\):not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)/,
    "the contractor page must size its inputs by exclusion, or a new type falls through",
  );
  assert.ok(
    !/\.job-link input\[type="text"\],\s*\n\s*\.job-link input:not\(\[type\]\)/.test(jobLink),
    "the old type-by-type list left input[type=date] unstyled",
  );
});
