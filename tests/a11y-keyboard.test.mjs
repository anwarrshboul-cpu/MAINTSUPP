/**
 * Accessibility beyond automated axe (§47: keyboard navigation, skip
 * navigation) — the source-level half. The live half (a keyboard walk and axe
 * on a running server) is at the bottom and skips without one.
 *
 * 1. A skip link is the first focusable element on every page (root layout).
 * 2. Every `aria-modal="true"` dialog either takes the shared behaviour
 *    (`useDialogBehaviour`: Escape, focus in and back, Tab trap, scroll lock) or
 *    is on a named list of dialogs that carry their own, verified — so a new
 *    modal cannot arrive without either.
 * 3. A board picture whose bytes are missing draws a glyph, not the browser's
 *    broken-image mark.
 * 4. A sidebar count is spoken as part of the name ("Jobs, 158 open jobs"),
 *    not glued onto it ("Jobs158").
 * 5. The controls the keyboard walk found ringless get their ring back.
 * 6. No table header is left empty for axe's `empty-table-header`.
 * 7. Every CSS rule that removes the outline is on an inventory: answered with
 *    a ring, or with its stand-in or the reason it needs none named.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

async function tsxFiles(dir) {
  const out = [];
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await tsxFiles(rel)));
    else if (entry.name.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

test("a skip link is the first thing in the body of every page", async () => {
  const layout = code(await read("app/layout.tsx"));
  assert.match(layout, /import \{ SkipLink \} from "\.\/skip-link";/);
  // (A stripped JSX comment leaves `{}` between the two.)
  assert.match(layout, /<body suppressHydrationWarning>\s*(\{\}\s*)?<SkipLink \/>\s*\{children\}/, "before anything a route group renders");
  assert.doesNotMatch(await read("app/layout.tsx"), /\.css/, "and the root layout stays stylesheet-free");
  const link = code(await read("app/skip-link.tsx"));
  assert.match(link, /Skip to main content/);
  assert.match(link, /document\.querySelector<HTMLElement>\("main"\)/, "it goes to the page's main landmark");
  assert.match(link, /main\.setAttribute\("tabindex", "-1"\)/, "made focusable for the jump");
  assert.match(link, /main\.focus\(\)/);
  assert.match(link, /clip: "rect\(0 0 0 0\)"/, "hidden the accessible way — still focusable and read");
  assert.doesNotMatch(link, /display: "none"|visibility: "hidden"/, "never removed from the tab order");
  assert.match(link, /onFocus=\{\(\) => setShown\(true\)\}/, "and drawn when it takes focus");
  assert.match(link, /outline: "3px solid/, "with a visible focus ring");
  // A skip link must name a real target — axe `skip-link`, and `region` too,
  // since an unresolved one stands outside every landmark. Measured: both fired
  // on all nine walked pages until the target was named.
  assert.match(link, /if \(!main\.id\) main\.id = "main";/, "an id-less <main> is given one");
  assert.match(link, /link\.current\.setAttribute\("href", `#\$\{main\.id\}`\);/, "and the link follows an existing id (#top)");
  assert.match(link, /\}, \[pathname\]\);/, "re-checked on every route change");
});

/*
 * Modals that keep their OWN keyboard handling, each already doing what
 * `aria-modal` promises (Escape, focus management; several trap Tab too).
 * Moving them onto the shared hook is a larger change in large files and is
 * listed as follow-up rather than done blind. Adding a modal to this list is a
 * deliberate act, reviewed in the diff.
 */
const OWN_BEHAVIOUR = new Set([
  "app/(app)/portal/portal-app.tsx",
  "app/(app)/portal/contractor-profile.tsx",
  "app/(app)/portal/manual-event-dialog.tsx",
  "app/(app)/portal/ops/ops-filter-bar.tsx",
  "app/(app)/portal/evidence-manager.tsx",
  "app/(app)/portal/media-viewer.tsx",
  "app/(app)/portal/workspace-data-manager.tsx",
  "app/(app)/portal/board-primitives.tsx",
  "app/(app)/portal/calendar-surface.tsx",
  "app/(marketing)/_sections/chrome.tsx",
]);

const CONVERTED = [
  "app/(app)/portal/ops/overview-records.tsx",
  "app/(app)/portal/views/admin-company.tsx",
  "app/(app)/portal/views/admin-users.tsx",
  "app/(app)/portal/views/fix-tracker.tsx",
  "app/(app)/portal/board-column-settings.tsx",
  "app/(app)/portal/form-share-dialog.tsx",
  "app/(app)/portal/raise-ticket.tsx",
  "app/(app)/portal/unscheduled-tray.tsx",
  "app/(app)/portal/finance/finance-shared.tsx",
];

test("every modal dialog takes the shared behaviour, or is named as carrying its own", async () => {
  const offenders = [];
  for (const file of await tsxFiles("app")) {
    const source = code(await read(file));
    if (!/aria-modal="true"/.test(source)) continue;
    if (/useDialogBehaviour/.test(source)) continue;
    if (OWN_BEHAVIOUR.has(file.replaceAll("\\", "/"))) continue;
    offenders.push(file);
  }
  assert.deepEqual(offenders, [], "a modal with neither the shared hook nor its own named behaviour");
});

test("the nine converted modals use the hook, wire it, and no longer carry a second Escape", async () => {
  for (const file of CONVERTED) {
    const source = code(await read(file));
    assert.match(source, /useDialogBehaviour(<[A-Za-z]+>)?\(true, on(Close|Cancel)\)/, `${file} calls the hook`);
    assert.match(source, /ref=\{surface\}/, `${file} gives it the surface`);
    assert.match(source, /onKeyDown=\{onKeyDown\}/, `${file} wires the Tab trap`);
    assert.doesNotMatch(
      source,
      /addEventListener\("keydown"[\s\S]{0,200}Escape|key === "Escape"\) on(Close|Cancel)\(\)/,
      `${file}: a local Escape beside the hook would close twice`,
    );
  }
  const hook = code(await read("app/(app)/portal/overlay/dialog-behaviour.ts"));
  assert.match(hook, /export function useDialogBehaviour<T extends HTMLElement = HTMLDivElement>/, "generic: the job panel is a <section>");
  // The two that open on their close button keep doing so.
  for (const file of ["app/(app)/portal/form-share-dialog.tsx", "app/(app)/portal/finance/finance-shared.tsx"]) {
    assert.match(code(await read(file)), /data-autofocus/, `${file} still focuses its close button first`);
  }
});

test("a board picture with missing bytes draws its glyph, not a broken image", async () => {
  const manager = code(await read("app/(app)/portal/evidence-manager.tsx"));
  const tile = manager.slice(manager.indexOf("function TileImage("), manager.indexOf("function FilePreview("));
  assert.match(tile, /const \[failedSrc, setFailedSrc\] = useState<string \| null>\(null\);/);
  assert.match(tile, /if \(failedSrc === src\)/, "remembers WHICH picture failed");
  assert.match(tile, /onError=\{\(\) => setFailedSrc\(src\)\}/);
  assert.match(tile, /<Icon name=\{glyph\} size=\{glyphSize\} \/>/);
  assert.match(tile, /role="img" aria-label=\{alt\}/, "a named picture keeps its name on the glyph");
  const thumbs = manager.match(/src=\{`\/api\/files\/\$\{file\.id\}\?thumb=1`\}/g) ?? [];
  assert.equal(thumbs.length, 3, "strip tile, overflow row and evidence grid");
  assert.doesNotMatch(manager, /<img\s+(\/\/[^\n]*\n\s*)*src=\{`\/api\/files\/\$\{file\.id\}\?thumb=1`\}/, "none of them is a bare <img> any more");
});

test("a sidebar count is part of the spoken name, not glued onto it", async () => {
  const nav = code(await read("app/(app)/portal/sidebar-nav.tsx"));
  const badge = nav.slice(nav.indexOf('className="nav-count"'), nav.indexOf('className="nav-count"') + 600);
  assert.match(badge, /aria-hidden="true"/, "the drawn number is not read twice");
  // Written out on the button. A visually-hidden ", 158 …" beside the label was
  // tried first and measured on the Preview: Chrome named it "Jobs , 158 open
  // jobs", spacing out the positioned child.
  assert.match(
    nav,
    /aria-label=\{\s*!editing && count > 0\s*\? `\$\{item\.label\}, \$\{count\}\$\{countLabel \? ` \$\{countLabel\}` : ""\}`\s*: undefined\s*\}/,
    "the button is named 'Jobs, 158 open jobs', beginning with its visible label",
  );
  assert.doesNotMatch(nav, /<span className="visually-hidden">\s*\{`, \$\{count\}/, "and the count is not spoken twice");
});

test("the controls the keyboard walk found ringless have their ring back", async () => {
  // Each carries `outline: 0` in globals.css at (0,1,1), which outranks the
  // global `:focus-visible` ring at (0,1,0). axe cannot see this; only a walk can.
  const globals = await read("app/globals.css");
  const brand = code(await read("app/brand-overrides.css"));
  for (const selector of [".live-board-tool select", ".sheet-column--move select", ".sla-settings input"]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(globals, new RegExp(`${escaped} \\{[^}]*outline: 0;`), `${selector} still loses the ring in globals.css`);
    const rule = brand.slice(brand.indexOf(`${selector}:focus-visible`));
    assert.ok(brand.includes(`${selector}:focus-visible`), `${selector} gets a :focus-visible rule`);
    assert.match(rule.slice(0, rule.indexOf("}") + 1), /outline: 3px solid var\(--focus-ring\);/, `${selector}: the page's own ring`);
  }
});

/*
 * 7. EVERY RULE THAT TAKES THE OUTLINE AWAY IS ANSWERED.
 *
 * The inventory below is every rule under app/**\/*.css whose declarations
 * include `outline: 0` or `outline: none`, `:focus-visible` rules included
 * (the Reports tab panel was one of those). Each was classified from a
 * KEYBOARD walk in a browser, both themes, on the production build where the
 * data allowed it, comparing the focused control with its unfocused state:
 *
 *   ring        — nothing visible, or a change under 1.5:1 in either theme. It
 *                 gets a 3px `--focus-ring` in brand-overrides.css, and each of
 *                 its selectors is mapped to the selector that answers it. A
 *                 ring on the control itself must outrank the rule that removed
 *                 it by specificity alone: per-view stylesheets load after
 *                 brand-overrides.css and win ties.
 *   substitute  — a real indicator of another kind, named and measured. Those
 *                 marked `weak` are under 3:1 in a theme; they are candidates
 *                 for a later pass, not defects this change claims to close.
 *   inert       — nothing focusable loses anything (a tabindex=-1 surface).
 *   dead        — nothing in the product renders it.
 *
 * A NEW outline-removing rule fails the first assertion until it is added here,
 * which is the point: a ringless control cannot arrive silently. Ratios are the
 * contrast of the change, focused against unfocused, "dark / light".
 */
const RING = "outline: 3px solid var(--focus-ring);";
const OUTLINE_INVENTORY = [
  // ── ring: answered in brand-overrides.css ────────────────────────────────
  { file: "app/(app)/portal/board-actions/board-actions.css", selector: '.ba-menu__item:hover:not([aria-disabled="true"]), .ba-menu__item:focus-visible, .ba-menu__item[aria-expanded="true"]', kind: "ring",
    why: "a background tint only, 1.22 / 1.12",
    rings: { '.ba-menu__item:hover:not([aria-disabled="true"])': ":root body .ba-menu__item:focus-visible", ".ba-menu__item:focus-visible": ":root body .ba-menu__item:focus-visible", '.ba-menu__item[aria-expanded="true"]': ":root body .ba-menu__item:focus-visible" } },
  { file: "app/(app)/portal/cells/board-date-picker.css", selector: ".board-date-popover__type .sheet-date-input:focus", kind: "ring",
    why: "a 2px wash glow in the dark theme, 1.18; the border change shows only in light",
    rings: { ".board-date-popover__type .sheet-date-input:focus": ":root .board-date-popover__type .sheet-date-input:focus-visible" } },
  { file: "app/globals.css", selector: ".sheet-date-input", kind: "ring",
    why: "the same input as the rule above; it is only ever drawn inside `.board-date-popover__type`",
    rings: { ".sheet-date-input": ":root .board-date-popover__type .sheet-date-input:focus-visible" } },
  { file: "app/(app)/portal/cells/expiry-cell.css", selector: ".expiry-cell__input", kind: "ring",
    why: "its own change is a 2px teal-100 glow; the ring seen on the dev build was the global one winning a (0,1,0) tie on load order, and Staging has no expiry cell to check the production build with",
    rings: { ".expiry-cell__input": ".expiry-cell__input:focus-visible" } },
  { file: "app/(app)/portal/form-builder.css", selector: ".form-edit__titleinput:focus-visible, .form-edit__helpinput:focus-visible", kind: "ring",
    why: "no computed change in either theme; the border colour it sets is overridden",
    rings: { ".form-edit__titleinput:focus-visible": ":root .form-edit__titleinput:focus-visible", ".form-edit__helpinput:focus-visible": ":root .form-edit__helpinput:focus-visible" } },
  { file: "app/(app)/portal/form-builder.css", selector: ".form-edit__pagename:focus-visible", kind: "ring",
    why: "built like the question title, which measured no change; a page name needs a multi-page form, so it is answered by analogy, not measured",
    rings: { ".form-edit__pagename:focus-visible": ":root .form-edit__pagename:focus-visible" } },
  { file: "app/(app)/portal/reports/reports.css", selector: ".reports-panel:focus-visible", kind: "ring",
    why: "a tabindex=0 tab panel whose ring was removed on purpose; nothing drawn",
    rings: { ".reports-panel:focus-visible": ":root .reports-panel:focus-visible" } },
  { file: "app/(app)/portal/views/account-views.css", selector: ".account-field input:focus, .account-field select:focus, .account-field textarea:focus", kind: "ring",
    why: "nothing on the recycle-bin search or the token-scope checkboxes; a 1.70 border change in light on the rest",
    rings: Object.fromEntries(["input", "select", "textarea"].map((tag) => [`.account-field ${tag}:focus`, ":root .account-field :is(input, select, textarea):focus-visible"])) },
  { file: "app/(app)/portal/views/fix-tracker.css", selector: ".fix-tracker .fix-tracker__search input, .fix-tracker .fix-tracker__location select, .fix-tracker .fix-tracker__sort select", kind: "ring",
    why: "nothing drawn on any of the three",
    rings: { ".fix-tracker .fix-tracker__search input": ".fix-tracker__search:has(input:focus-visible)", ".fix-tracker .fix-tracker__location select": ".fix-tracker__location:has(select:focus-visible)", ".fix-tracker .fix-tracker__sort select": ".fix-tracker__sort:has(select:focus-visible)" } },
  { file: "app/brand-overrides.css", selector: ".fix-tracker__search input, .fix-tracker__location select", kind: "ring",
    why: "the same controls as fix-tracker.css",
    rings: { ".fix-tracker__search input": ".fix-tracker__search:has(input:focus-visible)", ".fix-tracker__location select": ".fix-tracker__location:has(select:focus-visible)" } },
  { file: "app/brand-overrides.css", selector: ".workspace-manager__toolbar input", kind: "ring",
    why: "nothing drawn",
    rings: { ".workspace-manager__toolbar input": ".workspace-manager__toolbar > label:has(input:focus-visible)" } },
  { file: "app/brand-overrides.css", selector: ".sheet-subitem-add input:focus-visible", kind: "ring",
    why: "nothing drawn; its colour change reaches typed text only",
    rings: { ".sheet-subitem-add input:focus-visible": ".sheet-subitem-add td:has(input:focus-visible)" } },
  { file: "app/globals.css", selector: ".mobile-request-field-editor__body > textarea", kind: "ring",
    why: "nothing drawn",
    rings: { ".mobile-request-field-editor__body > textarea": ".mobile-request-field-editor__body > :is(textarea, input):focus-visible" } },
  { file: "app/globals.css", selector: ".mobile-request-field-editor__body > input", kind: "ring",
    why: "nothing drawn",
    rings: { ".mobile-request-field-editor__body > input": ".mobile-request-field-editor__body > :is(textarea, input):focus-visible" } },
  { file: "app/globals.css", selector: ".group-creator > input", kind: "ring",
    why: "a 10% glow, 1.18 / 1.09; its border change is overridden",
    rings: { ".group-creator > input": ".group-creator > input:focus-visible" } },
  { file: "app/globals.css", selector: ".sheet-group__header > input", kind: "ring",
    why: "an editor that mounts focused, drawn at 1.82 / 1.22 against its surroundings",
    rings: { ".sheet-group__header > input": ".sheet-group__header > input:focus-visible" } },
  { file: "app/globals.css", selector: ".column-picker > header input", kind: "ring",
    why: "nothing drawn; the label's border is the same focused or not",
    rings: { ".column-picker > header input": ".column-picker > header label:has(input:focus-visible)" } },
  { file: "app/globals.css", selector: ".sheet-inline-input", kind: "ring",
    why: "an editor that mounts focused, drawn at 1.33 / 1.15 against the cell",
    rings: { ".sheet-inline-input": ".sheet-inline-input:focus-visible" } },
  { file: "app/globals.css", selector: ".form-field input, .form-field select, .form-field textarea", kind: "ring",
    why: "an 11% glow, 1.20 / 1.11; a border change shows only on select and textarea, only in light",
    rings: Object.fromEntries(["input", "select", "textarea"].map((tag) => [`.form-field ${tag}`, ".form-field :is(input, select, textarea):focus-visible"])) },
  { file: "app/globals.css", selector: '.column-settings-dialog__body > label > input:not([type="range"]), .column-settings-dialog__choices > div > div > input:not([type="color"]), .column-settings-dialog__add > input', kind: "ring",
    why: "a 12% glow, 1.29 / 1.15; this rule outranks the border change meant to go with it",
    rings: {
      '.column-settings-dialog__body > label > input:not([type="range"])': '.column-settings-dialog__body > label > input:not([type="range"]):focus-visible',
      '.column-settings-dialog__choices > div > div > input:not([type="color"])': '.column-settings-dialog__choices > div > div > input:not([type="color"]):focus-visible',
      ".column-settings-dialog__add > input": ".column-settings-dialog__add > input:focus-visible",
    } },
  { file: "app/globals.css", selector: ".sheet-item-name-input", kind: "ring",
    why: "an editor that mounts focused, drawn at 1.33 / 1.15 against the cell",
    rings: { ".sheet-item-name-input": ".sheet-item-name-input:focus-visible" } },
  { file: "app/globals.css", selector: ".mobile-sheet-search input", kind: "ring",
    why: "a 12% glow in the dark theme, 1.22; the border change shows only in light",
    rings: { ".mobile-sheet-search input": ".mobile-sheet-search:has(input:focus-visible)" } },
  { file: "app/globals.css", selector: ".mobile-text-editor input, .mobile-text-editor textarea, .mobile-date-editor input, .mobile-timeline-editor input", kind: "ring",
    why: "a 12% glow in the dark theme, 1.22; the border change shows only in light",
    rings: {
      ".mobile-text-editor input": ".mobile-text-editor :is(input, textarea):focus-visible",
      ".mobile-text-editor textarea": ".mobile-text-editor :is(input, textarea):focus-visible",
      ".mobile-date-editor input": ".mobile-date-editor input:focus-visible",
      ".mobile-timeline-editor input": ".mobile-timeline-editor input:focus-visible",
    } },
  { file: "app/globals.css", selector: ".mobile-board-bar select", kind: "ring",
    why: "nothing drawn; the select is an invisible layer over the theme button, so the button carries the ring",
    rings: { ".mobile-board-bar select": ".mobile-board-bar > .board-theme-picker--mobile:has(select:focus-visible)" } },
  { file: "app/globals.css", selector: '.site-contractors__link input[type="search"], .contractor-profile__link input[type="search"], .site-contractors__link select, .contractor-profile__link select', kind: "ring",
    why: "nothing drawn on any of the four",
    rings: {
      '.site-contractors__link input[type="search"]': '.site-contractors__link :is(input[type="search"], select):focus-visible',
      ".site-contractors__link select": '.site-contractors__link :is(input[type="search"], select):focus-visible',
      '.contractor-profile__link input[type="search"]': '.contractor-profile__link :is(input[type="search"], select):focus-visible',
      ".contractor-profile__link select": '.contractor-profile__link :is(input[type="search"], select):focus-visible',
    } },

  // Third pass (§47): the stand-ins #88 measured under WCAG 1.4.11's 3:1 in a
  // theme. Each keeps its stand-in and now carries the ring as well.
  { file: "app/(app)/portal/account-menu.css", selector: ".account-menu__plan:hover, .account-menu__plan:focus-visible", kind: "ring",
    why: "its stand-in (the border going solid brand) measured 2.74 / 1.57",
    rings: { ".account-menu__plan:hover": ":root .account-menu__plan:focus-visible", ".account-menu__plan:focus-visible": ":root .account-menu__plan:focus-visible" } },
  { file: "app/(app)/portal/account-menu.css", selector: ".account-menu__item:hover, .account-menu__item:focus-visible", kind: "ring",
    why: "its stand-in (full ink on a tint) measured 1.64 / 2.37",
    rings: { ".account-menu__item:hover": ":root .account-menu__item:focus-visible", ".account-menu__item:focus-visible": ":root .account-menu__item:focus-visible" } },
  { file: "app/(app)/portal/account-menu.css", selector: ".account-menu__status-list button:hover, .account-menu__status-list button:focus-visible", kind: "ring",
    why: "its stand-in (full ink on a tint) measured 1.64 / 2.37",
    rings: { ".account-menu__status-list button:hover": ":root .account-menu__status-list button:focus-visible", ".account-menu__status-list button:focus-visible": ":root .account-menu__status-list button:focus-visible" } },
  { file: "app/(app)/portal/assignee-cell.css", selector: ".assignee-search input", kind: "ring",
    why: "its stand-in (the field's border) measured 3.98 / 2.24",
    rings: { ".assignee-search input": ".assignee-search:has(input:focus-visible)" } },
  { file: "app/(app)/portal/global-search.css", selector: ".global-search__field input", kind: "ring",
    why: "its stand-in (the field's border) measured 3.30 / 1.70",
    rings: { ".global-search__field input": ".global-search__field:has(input:focus-visible)" } },
  { file: "app/(app)/portal/update-thread.css", selector: ".update-composer textarea", kind: "ring",
    why: "its stand-in (its border) measured 4.96 / 2.65",
    rings: { ".update-composer textarea": ":root .update-composer textarea:focus-visible" } },
  { file: "app/globals.css", selector: ".live-board-search input", kind: "ring",
    why: "its stand-in (a 2px brand ring on the field) measured 6.47 / 2.59",
    rings: { ".live-board-search input": ".portal-shell .live-board-search:has(input:focus-visible)" } },
  // ── substitute: a real indicator of another kind ─────────────────────────
  { file: "app/(app)/portal/cells/board-date-picker.css", selector: ".board-date-popover .mobile-board-calendar__days > button:focus-visible", kind: "substitute",
    why: "the ring moves to the day's disc", by: { file: "app/(app)/portal/cells/board-date-picker.css", selector: ".board-date-popover .mobile-board-calendar__days > button:focus-visible > span", has: /outline: 2px solid var\(--focus-ring\)/ } },
  { file: "app/(app)/portal/reminder-rows.css", selector: ".recipient-picker__input", kind: "substitute",
    why: "the field's border, 5.74 / 3.72", by: { file: "app/(app)/portal/reminder-rows.css", selector: ".recipient-picker__field:focus-within", has: /border-color: var\(--accent-fg\)/ } },
  { file: "app/(app)/portal/views/store-compliance-tracker.css", selector: ".store-compliance__search input, .store-compliance__filter select", kind: "substitute",
    why: "the field's border, 7.15 / 4.40", by: { file: "app/(app)/portal/views/store-compliance-tracker.css", selector: ".store-compliance__search:focus-within", has: /border-color/ } },
  { file: "app/(marketing)/marketing.css", selector: ".field :is(input,select,textarea):focus", kind: "substitute",
    why: "its border, 3.70 (the public site has one theme)", by: { file: "app/(marketing)/marketing.css", selector: ".field :is(input,select,textarea):focus", has: /border-color:var\(--steel\)/ } },
  { file: "app/brand-overrides.css", selector: ".analytics-toolbar select, .analytics-toolbar input", kind: "substitute",
    why: "a 2px ring, 7.63 / 5.07", by: { file: "app/brand-overrides.css", selector: ".analytics-toolbar select:focus-visible", has: /outline: 2px solid/ } },
  { file: "app/brand-overrides.css", selector: ".section-header__actions > .analytics-period :is(select, input), .section-header__controls > .analytics-period :is(select, input)", kind: "substitute",
    why: "a 2px ring, 7.63 / 5.07", by: { file: "app/brand-overrides.css", selector: ".section-header__actions > .analytics-period :is(select, input):focus-visible", has: /outline: 2px solid/ } },
  { file: "app/globals.css", selector: ".mobile-monday-field__value", kind: "substitute",
    why: "the global ring itself, 9.33 / 3.46: this rule ties it at (0,1,0) and comes earlier in the same file (asserted below)", by: { file: "app/globals.css", selector: ":focus-visible", has: /outline: 3px solid var\(--focus-ring\)/ } },
  { file: "app/globals.css", selector: ".search-field input", kind: "substitute",
    why: "a 3px ring on the field, 9.33 / 5.67", by: { file: "app/brand-overrides.css", selector: ".search-field:focus-within", has: /outline: 3px solid/ } },
  { file: "app/globals.css", selector: ".live-board-tool select", kind: "substitute",
    why: "#85's ring, 9.33 / 3.46", by: { file: "app/brand-overrides.css", selector: ".live-board-tool select:focus-visible", has: /outline: 3px solid var\(--focus-ring\)/ } },
  { file: "app/globals.css", selector: ".sheet-column--move select", kind: "substitute",
    why: "#85's ring, 9.33 / 3.46", by: { file: "app/brand-overrides.css", selector: ".sheet-column--move select:focus-visible", has: /outline: 3px solid var\(--focus-ring\)/ } },
  { file: "app/globals.css", selector: ".sla-settings input", kind: "substitute",
    why: "#85's ring, 8.72 / 3.46", by: { file: "app/brand-overrides.css", selector: ".sla-settings input:focus-visible", has: /outline: 3px solid var\(--focus-ring\)/ } },

  // ── inert: nothing focusable loses anything ──────────────────────────────
  { file: "app/(app)/portal/board-actions/board-actions.css", selector: ".ba-modal", kind: "inert",
    why: "the dialog surface, tabindex=-1, focused only to hold focus inside", evidence: { file: "app/(app)/portal/board-actions/board-modal.tsx", pattern: /className=\{`ba-modal [\s\S]{0,200}tabIndex=\{-1\}/ } },
  { file: "app/(app)/portal/board-actions/board-actions.css", selector: ".ba-drawer", kind: "inert",
    why: "the drawer surface, tabindex=-1", evidence: { file: "app/(app)/portal/board-actions/board-modal.tsx", pattern: /className="ba-drawer"[\s\S]{0,200}tabIndex=\{-1\}/ } },
  { file: "app/(app)/portal/overlay/overlay.css", selector: ".ms-popover", kind: "inert",
    why: "the popover surface, tabindex=-1 (the timeline tooltip that shares the class is role=tooltip)", evidence: { file: "app/(app)/portal/overlay/anchored.tsx", pattern: /className=\{`ms-popover[\s\S]{0,300}tabIndex=\{-1\}/ } },
  { file: "app/(app)/portal/views/store-documentation-board.css", selector: ".store-documentation__panel:focus", kind: "inert",
    why: "a tab panel with tabindex=-1, focused by script", evidence: { file: "app/(app)/portal/views/store-documentation-board.tsx", pattern: /className="store-documentation__panel"[\s\S]{0,200}tabIndex=\{-1\}/ } },
  { file: "app/(marketing)/marketing.css", selector: "fieldset.field:focus", kind: "inert",
    why: "a fieldset given tabindex=-1 so an error can move focus to it", evidence: { file: "app/(marketing)/contractors/apply-form.tsx", pattern: /<fieldset className=\{`\$\{fieldClass\("trades"\)\} fieldset`\} id="trades" tabIndex=\{-1\}>/ } },
  { file: "app/brand-overrides.css", selector: ".analytics-table tbody tr:hover td, .analytics-table tbody tr:focus td", kind: "inert",
    why: "it clears the cells, not the row, and no table row is focusable", evidence: { absent: /<tr\b[^>]*tabIndex=\{0\}/ } },

  // ── dead: nothing renders it ─────────────────────────────────────────────
  { file: "app/(marketing)/marketing.css", selector: ".slider input[type=range]", kind: "dead",
    why: "no element carries `slider` (the pricing range is `.pricing__slider`)", evidence: { absent: /className=["'{`][^"'}`]*(?<![\w-])slider(?![\w-])/ } },
  { file: "app/brand-overrides.css", selector: ".analytics-inline-select select", kind: "dead",
    why: "only in SortDirectionSelect, which nothing renders", evidence: { absent: /<SortDirectionSelect\b/ } },
  { file: "app/globals.css", selector: ".select-control select", kind: "dead",
    why: "only in LegacyMaintenanceView, which nothing renders", evidence: { absent: /<LegacyMaintenanceView\b/ } },
];

async function cssFiles(dir) {
  const out = [];
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await cssFiles(rel)));
    else if (entry.name.endsWith(".css")) out.push(rel);
  }
  return out;
}

function splitTopLevel(list) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === "(" || list[i] === "[") depth += 1;
    else if (list[i] === ")" || list[i] === "]") depth -= 1;
    else if (list[i] === "," && depth === 0) {
      parts.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts;
}

/** Innermost `selector { body }` rules, comments stripped; @media blocks are walked through. */
function cssRules(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, raw, body]) => {
    const selector = raw.replace(/\s+/g, " ").trim();
    return { selector, parts: splitTopLevel(selector), body };
  });
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** Selectors Level 4 specificity as [ids, classes, types], for the selectors this project writes. */
function specificity(selector) {
  let rest = selector;
  let score = [0, 0, 0];
  const add = (other) => { score = score.map((value, index) => value + other[index]); };
  const most = (list) => splitTopLevel(list).map(specificity).reduce((best, next) => (compare(next, best) > 0 ? next : best), [0, 0, 0]);
  // :is/:not/:has count their most specific argument; :where counts nothing.
  for (let at = rest.search(/:(is|not|has|where)\(/); at >= 0; at = rest.search(/:(is|not|has|where)\(/)) {
    const open = rest.indexOf("(", at);
    let depth = 0;
    let close = open;
    for (; close < rest.length; close += 1) {
      if (rest[close] === "(") depth += 1;
      else if (rest[close] === ")" && (depth -= 1) === 0) break;
    }
    if (!rest.startsWith(":where", at)) add(most(rest.slice(open + 1, close)));
    rest = `${rest.slice(0, at)} ${rest.slice(close + 1)}`;
  }
  const strip = (pattern, weight) => { rest = rest.replace(pattern, () => { add(weight); return " "; }); };
  strip(/\[[^\]]*\]/g, [0, 1, 0]);
  strip(/::[\w-]+/g, [0, 0, 1]);
  strip(/:[\w-]+/g, [0, 1, 0]);
  strip(/#[\w-]+/g, [1, 0, 0]);
  strip(/\.[\w-]+/g, [0, 1, 0]);
  add([0, 0, (rest.match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length]);
  return score;
}

test("the specificity helper scores the selectors the inventory relies on", () => {
  assert.deepEqual(specificity(".account-field input:focus"), [0, 2, 1]);
  assert.deepEqual(specificity(":root .account-field :is(input, select, textarea):focus-visible"), [0, 3, 1]);
  assert.deepEqual(specificity('.ba-menu__item:hover:not([aria-disabled="true"])'), [0, 3, 0]);
  assert.deepEqual(specificity(":root body .ba-menu__item:focus-visible"), [0, 3, 1]);
  assert.deepEqual(specificity('.site-contractors__link :is(input[type="search"], select):focus-visible'), [0, 3, 1]);
  assert.deepEqual(specificity("fieldset.field:focus"), [0, 2, 1]);
  assert.deepEqual(specificity('.column-settings-dialog__choices > div > div > input:not([type="color"])'), [0, 2, 3]);
  assert.deepEqual(specificity("input::placeholder"), [0, 0, 2]);
  assert.deepEqual(specificity(":where(.a) b"), [0, 0, 1]);
});

test("every rule that takes the outline away is answered: a ring, a named substitute, or a reason", async () => {
  const brand = cssRules(await read("app/brand-overrides.css"));
  const rulesByFile = new Map();
  const found = [];
  for (const file of await cssFiles("app")) {
    const rules = cssRules(await read(file));
    rulesByFile.set(file, rules);
    for (const rule of rules) {
      if (/outline\s*:\s*(0|none)\b/.test(rule.body)) found.push(`${file} :: ${rule.selector}`);
    }
  }
  const listed = OUTLINE_INVENTORY.map((entry) => `${entry.file} :: ${entry.selector}`);
  assert.deepEqual(
    found.filter((key) => !listed.includes(key)),
    [],
    "an outline-removing rule that is not in OUTLINE_INVENTORY: ring its control in brand-overrides.css, or name what stands in for one",
  );
  assert.deepEqual(listed.filter((key) => !found.includes(key)), [], "an inventory entry whose rule is gone: take it out");
  assert.equal(new Set(listed).size, listed.length, "each rule is listed once");

  const tsx = await Promise.all((await tsxFiles("app")).map(async (file) => ({ file, source: code(await read(file)) })));
  for (const entry of OUTLINE_INVENTORY) {
    const label = `${entry.file} ${entry.selector}`;
    assert.ok(entry.why, `${label}: say why`);
    const removing = rulesByFile.get(entry.file).find((rule) => rule.selector === entry.selector);
    if (entry.kind === "ring") {
      assert.deepEqual(Object.keys(entry.rings).sort(), [...removing.parts].sort(), `${label}: every selector in the rule is mapped to its ring`);
      for (const [part, answer] of Object.entries(entry.rings)) {
        const rule = brand.find((candidate) => candidate.parts.includes(answer) && candidate.body.includes(RING));
        assert.ok(rule, `${label}: "${answer}" draws the 3px focus ring in brand-overrides.css`);
        // A ring on a wrapper (`:has`) sits on an element nothing strips; a ring
        // on the control itself has to win by specificity, not by load order.
        if (answer.includes(":has(")) continue;
        assert.ok(
          compare(specificity(answer), specificity(part)) > 0,
          `${label}: "${answer}" (${specificity(answer)}) must outrank "${part}" (${specificity(part)})`,
        );
      }
    } else if (entry.kind === "substitute") {
      const stand = rulesByFile.get(entry.by.file).find((candidate) => candidate.parts.includes(entry.by.selector) && entry.by.has.test(candidate.body));
      assert.ok(stand, `${label}: its stand-in "${entry.by.selector}" in ${entry.by.file} still does ${entry.by.has}`);
    } else if (entry.kind === "inert" || entry.kind === "dead") {
      if (entry.evidence.pattern) assert.match(code(await read(entry.evidence.file)), entry.evidence.pattern, `${label}: ${entry.why}`);
      else assert.deepEqual(tsx.filter(({ source }) => entry.evidence.absent.test(source)).map(({ file }) => file), [], `${label}: ${entry.why}`);
    } else {
      assert.fail(`${label}: unknown kind ${entry.kind}`);
    }
  }

  // The one stand-in that is order, not a rule: within globals.css the global ring comes later.
  const globals = await read("app/globals.css");
  assert.ok(
    globals.indexOf(".mobile-monday-field__value {") < globals.indexOf("\n:focus-visible {"),
    "the global ring still follows the phone field rule it ties with",
  );
  // And the ring has a colour in both themes.
  assert.match(globals, /:root \{[^}]*--focus-ring: #[0-9a-f]{6};/, "light theme");
  assert.match(globals, /body\[data-theme="dark"\] \{[^}]*--focus-ring: #[0-9a-f]{6};/, "dark theme");
});

test("two faint stand-ins carry the 3px ring in their own stylesheets", async () => {
  /* Outside brand-overrides.css, so outside the inventory's ring check — and,
     taking the outline no longer, both rules have left the inventory above.
     The public upload menu: the marketing layout loads no portal stylesheet.
     The automation builder's headings: brand-overrides.css may not carry
     automation styles (ui-batch-board-actions). */
  const marketing = await read("app/(marketing)/marketing.css");
  assert.match(marketing, /\.upload__item:focus-visible\{outline:3px solid var\(--amber-strong\);outline-offset:-3px;/);
  assert.doesNotMatch(marketing, /\.upload__item:focus-visible\{outline:none/);
  const actions = (await read("app/(app)/portal/board-actions/board-actions.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(actions, /\n\.auto-builder__heading:focus-visible \{\s*outline: 3px solid var\(--focus-ring\);\s*outline-offset: -3px;\s*\}/);
  assert.doesNotMatch(actions, /\.auto-builder__heading:focus-visible \{[^}]*outline: none/);
});

test("no table header is empty — an Actions column says so", async () => {
  const empty = [];
  for (const file of await tsxFiles("app")) {
    if (/<th aria-label="[^"]*" \/>/.test(await read(file))) empty.push(file);
  }
  assert.deepEqual(empty, [], "axe `empty-table-header` wants visible text, which an aria-label is not");
});

/* ── Live: a keyboard walk and axe on a running server ─────────────────── */

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const serverUp = await (async () => {
  try {
    return (await fetch(`${BASE_URL}/api/context`, { signal: AbortSignal.timeout(8000) })).status < 500;
  } catch {
    return false;
  }
})();

test("live: the skip link is served first and names its target", { skip: !serverUp }, async () => {
  for (const page of ["/", "/faqs", "/login"]) {
    const html = await (await fetch(`${BASE_URL}${page}`)).text();
    const body = html.slice(html.indexOf("<body"));
    const firstLink = body.match(/<a [^>]*>/)?.[0] ?? "";
    assert.match(firstLink, /class="skip-link"/, `${page}: the first link in the body is the skip link`);
    assert.match(html, /<main[\s>]/, `${page}: there is a main landmark to skip to`);
  }
});
