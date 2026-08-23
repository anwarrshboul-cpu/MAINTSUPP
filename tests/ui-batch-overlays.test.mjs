/**
 * UI batch — the shared overlay layer.
 *
 * Three things this pins, each of which went wrong once:
 *
 *   1. The z-index scale. It is ONE ordered set of tiers in globals.css, by
 *      role. The old scale put dropdowns (200) under the top bar (300), which
 *      is how a menu hung off a toolbar was painted behind the sticky header,
 *      and sixty-odd raw numbers were scattered through the stylesheets each
 *      chosen to beat whichever number was last in the way. The tiers and
 *      their ORDER are asserted; the old names survive only as aliases.
 *
 *   2. The primitive. `overlay/anchored.tsx` is the contract the board chrome
 *      codes against, so its exports and their shapes are pinned by name.
 *
 *   3. No new raw numbers. Every `z-index` at or above 10 in the stylesheets
 *      this batch owns must be a token or a calc over one — the allowlist
 *      below is the exceptions, each with its reason, and it is meant to be
 *      shortened rather than grown.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const GLOBALS = "app/globals.css";
const ANCHORED = "app/(app)/portal/overlay/anchored.tsx";
const OVERLAY_CSS = "app/(app)/portal/overlay/overlay.css";

/** The stylesheets this batch owns, and so holds to the token rule. */
const OWNED_CSS = [
  GLOBALS,
  "app/brand-overrides.css",
  "app/(app)/portal/board-visibility.css",
  "app/(app)/portal/account-menu.css",
  "app/(app)/portal/views/account-views.css",
  "app/(app)/portal/views/store-documentation-board.css",
  OVERLAY_CSS,
];

/**
 * Raw numbers that may stay, with the reason. Empty on purpose: every raw
 * value at or above 10 has been mapped to a tier. Add to this only with a
 * reason a reviewer would accept, and prefer a token.
 */
const RAW_ALLOWLIST = [];

/** The `:root` token block, as `name → value` text. */
async function tokens() {
  const css = await read(GLOBALS);
  const start = css.indexOf("--z-base:");
  assert.ok(start > 0, "globals.css must declare the layer scale starting at --z-base");
  const block = css.slice(start, css.indexOf("}", start));
  const map = new Map();
  for (const [, name, value] of block.matchAll(/--(z-[\w-]+):\s*([^;]+);/g)) {
    map.set(name, value.trim());
  }
  return map;
}

/** A tier's number, following aliases. */
function resolve(map, name) {
  const raw = map.get(name);
  assert.ok(raw !== undefined, `--${name} must be declared`);
  const alias = raw.match(/^var\(--(z-[\w-]+)\)$/);
  return alias ? resolve(map, alias[1]) : Number(raw);
}

test("the layer scale is one ordered set of tiers", async () => {
  const map = await tokens();
  const order = [
    "z-base",
    "z-sticky",
    "z-toolbar",
    "z-topbar",
    "z-sidebar-backdrop",
    "z-sidebar",
    "z-popover",
    "z-submenu",
    "z-drawer-backdrop",
    "z-drawer",
    "z-modal-backdrop",
    "z-modal",
    "z-popover-raised",
    "z-viewer",
    "z-toast",
  ];
  const values = order.map((name) => resolve(map, name));
  for (let index = 1; index < values.length; index += 1) {
    assert.ok(
      values[index] > values[index - 1],
      `--${order[index]} (${values[index]}) must sit above --${order[index - 1]} (${values[index - 1]})`,
    );
  }
  // The relationships the bug reports were about, stated directly.
  assert.ok(resolve(map, "z-popover") > resolve(map, "z-topbar"), "a popover paints over the top bar");
  assert.ok(resolve(map, "z-topbar") > resolve(map, "z-toolbar"), "the top bar paints over a toolbar");
  assert.ok(resolve(map, "z-toolbar") > resolve(map, "z-sticky"), "a toolbar paints over a sticky header");
  assert.ok(resolve(map, "z-modal") > resolve(map, "z-drawer"), "a modal paints over a drawer");
  assert.ok(resolve(map, "z-drawer") > resolve(map, "z-popover"), "a drawer paints over a stray popover");
  assert.equal(Math.max(...values), resolve(map, "z-toast"), "the toast is the top of the scale");
});

test("the names the stylesheets grew up with are aliases of the tiers they meant", async () => {
  const map = await tokens();
  assert.equal(map.get("z-dropdown"), "var(--z-popover)");
  assert.equal(map.get("z-notifications"), "var(--z-popover)");
  assert.equal(map.get("z-sheet-backdrop"), "var(--z-modal-backdrop)");
  assert.equal(map.get("z-sheet"), "var(--z-modal)");
  assert.equal(map.get("z-dialog"), "var(--z-modal)");
});

test("the primitive exports the contract the board chrome codes against", async () => {
  const source = await read(ANCHORED);
  assert.match(source, /export function LayerPortal\(\{\s*children,\s*layer,?\s*\}/);
  assert.match(
    source,
    /"popover"\s*\|\s*"submenu"\s*\|\s*"drawer"\s*\|\s*"modal"\s*\|\s*"toast"\s*\|\s*"popover-raised"/,
  );
  assert.match(source, /export function useAnchoredPosition\(args: \{/);
  assert.match(source, /anchorRef: RefObject<HTMLElement \| null>;/);
  assert.match(
    source,
    /"bottom-start"\s*\|\s*"bottom-end"\s*\|\s*"top-start"\s*\|\s*"top-end"\s*\|\s*"right-start"\s*\|\s*"left-start"/,
  );
  assert.match(source, /export function AnchoredPopover\(props: \{/);
  assert.match(source, /onClose: \(\) => void;/);
  assert.match(source, /restoreFocus\?: boolean;/);
  assert.match(source, /initialFocus\?: "first" \| "none";/);
  assert.match(source, /export \{ useBodyScrollLock \} from "\.\/scroll-lock";/);

  // Portalled into ONE host on <body>, created on demand, and SSR-safe.
  assert.match(source, /const HOST_ID = "maintsupp-layers";/);
  assert.match(source, /document\.body\.appendChild\(host\)/);
  assert.match(source, /if \(!host\) return <><\/>;/, "nothing renders before mount");
  // Marked so the board's own click-away listener treats a layer as inside.
  assert.match(source, /data-board-popover=""/);

  // Positioned from the anchor's CURRENT rect, in viewport coordinates, and
  // re-measured on resize, scroll (capture) and size changes.
  assert.match(source, /anchor\.getBoundingClientRect\(\)/);
  assert.match(source, /position: "fixed"/);
  assert.match(source, /window\.addEventListener\("scroll", measure, true\)/);
  assert.match(source, /new ResizeObserver\(/);
  // Flips, clamps and caps.
  assert.match(source, /wantedHeight > spaceBelow && spaceAbove > spaceBelow/);
  assert.match(source, /maxHeight: Math\.round\(maxHeight\)/);

  // Dismissal spares a layer opened AFTER this one — a submenu.
  assert.match(source, /Node\.DOCUMENT_POSITION_FOLLOWING/);
  // Roving focus for menus.
  assert.match(source, /\["ArrowDown", "ArrowUp", "Home", "End"\]/);
});

test("the layer wrapper takes its depth from the tiers, per role", async () => {
  const css = await read(OVERLAY_CSS);
  assert.match(css, /\.ms-layer \{[^}]*z-index: var\(--z-popover\);/);
  assert.match(css, /\.ms-layer\[data-layer="submenu"\] \{\s*z-index: var\(--z-submenu\);/);
  assert.match(css, /\.ms-layer\[data-layer="popover-raised"\] \{\s*z-index: var\(--z-popover-raised\);/);
  assert.match(css, /\.ms-layer\[data-layer="drawer"\] \{\s*z-index: var\(--z-drawer\);/);
  assert.match(css, /\.ms-layer\[data-layer="modal"\] \{\s*z-index: var\(--z-modal\);/);
  assert.match(css, /\.ms-layer\[data-layer="toast"\] \{\s*z-index: var\(--z-toast\);/);
});

test("no raw z-index at or above 10 outside the token block", async () => {
  const offenders = [];
  for (const file of OWNED_CSS) {
    const css = await read(file);
    const lines = css.split(/\r?\n/);
    lines.forEach((line, index) => {
      const match = line.match(/^\s*z-index:\s*(-?\d+)(\s*!important)?\s*;/);
      if (!match) return;
      const value = Number(match[1]);
      if (Math.abs(value) < 10) return;
      const key = `${file}:${index + 1}`;
      if (RAW_ALLOWLIST.some((entry) => entry.file === file && entry.value === value)) return;
      offenders.push(`${key} → z-index: ${match[1]}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "every z-index of 10 or more must be a tier token (or a calc over one)",
  );
});

test("the surfaces this batch moved onto the layer no longer anchor themselves", async () => {
  const menuCss = await read("app/(app)/portal/account-menu.css");
  const panel = menuCss.slice(menuCss.indexOf(".account-menu__panel {"));
  const body = panel.slice(0, panel.indexOf("}"));
  assert.doesNotMatch(body, /position:\s*(absolute|fixed)/, "the avatar panel is positioned by the hook");
  assert.doesNotMatch(menuCss, /bottom: 8px/, "the phone's bottom-sheet offset was the bug");

  const menu = await read("app/(app)/portal/account-menu.tsx");
  assert.match(menu, /useAnchoredPosition\(\{\s*open,\s*anchorRef: triggerRef,/);
  assert.match(menu, /<LayerPortal layer="popover">/);

  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(portal, /<AnchoredPopover\s+open=\{notificationsOpen\}/);
  const globals = await read(GLOBALS);
  assert.doesNotMatch(
    globals,
    /\.notification-panel \{\s*position: absolute;/,
    "the notifications panel is positioned by the hook",
  );

  const board = await read("app/(app)/portal/live-board.tsx");
  assert.match(board, /<AnchoredPopover\s+open=\{menuOpen\}\s+anchorRef=\{moreRef\}/, "the row menu");
  assert.match(board, /<AnchoredPopover\s+open=\{hideOpen\}/, "the Hide columns panel");
  assert.match(board, /<GroupActionMenu\s+open=\{groupMenuId === group\.id\}/, "the group menu");
  assert.doesNotMatch(board, /useBoardMenuFit/, "the offsetParent-based fitter is retired from the board");
});
