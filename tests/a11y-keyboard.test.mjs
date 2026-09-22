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
