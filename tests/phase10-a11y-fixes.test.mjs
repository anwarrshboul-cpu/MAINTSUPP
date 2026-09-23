import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CHIP_INK_LIGHT, chipInk, contrastRatio } from "../app/(app)/portal/chip-ink.ts";

/**
 * PHASE 10 (§77) — WHAT THE PRODUCTION SWEEP FOUND, PINNED.
 *
 * A read-only axe and crawl pass over the apex found these; each fix is held
 * here so it cannot quietly come back. Where a pin is about a colour, the value
 * is read out of the stylesheet that paints it and the ratio recomputed, the way
 * `stage-twentysix-contrast.test.mjs` does for globals.css — a hex written into
 * this file would be a second copy of the palette, and the drift between copies
 * is the failure being guarded.
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

/** Source with comments removed, so a pin matches code and never a note about it. */
const code = (source) =>
  source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

/** A custom property's literal value, as declared in `css`. */
function token(css, name) {
  const match = css.match(new RegExp(`${name.replace(/[-]/g, "\\-")}\\s*:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(match, `${name} must be declared as a hex literal`);
  return match[1];
}

const hex = (value) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
const toHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
/** `color-mix(in srgb, a p, b)` — p of `a`, the rest `b`. */
const mix = (a, b, p) => toHex(hex(a).map((v, i) => v * p + hex(b)[i] * (1 - p)));

const AA = 4.5;

test("the brand colour pickers are named by their token", async () => {
  const panel = code(await read("app/(app)/portal/views/brand-colours-panel.tsx"));
  const picker = panel.slice(panel.indexOf('type="color"') - 200, panel.indexOf('type="color"'));
  assert.match(picker, /aria-label=\{token\.label\}/, "an <input type=color> inside an empty label names nothing");
});

test("the account page's back link has a name when only its arrow shows", async () => {
  const shell = code(await read("app/(app)/portal/views/account-shell.tsx"));
  assert.match(shell, /className="account-topbar__back" href="\/dashboard" aria-label="Back to workspace"/);
});

test("the legal and FAQ eyebrow uses the teal that reads on white", async () => {
  const css = await read("app/(marketing)/marketing.css");
  const rule = code(css).match(/\.m-eyebrow\s*\{[^}]*\}/)[0];
  assert.match(rule, /color:\s*var\(--teal-text\)/);
  const ratio = contrastRatio(token(css, "--teal-text"), "#ffffff");
  assert.ok(ratio >= AA, `--teal-text on white is ${ratio.toFixed(2)}:1`);
});

test("an overview pill's ink clears AA on its own wash, default palette and a 3:1 workspace colour", async () => {
  const dash = await read("app/(app)/portal/ops/oi-dash.css");
  const globals = await read("app/globals.css");
  const rule = code(dash).match(/\.ov-dash\.oi-dash \.oi-pill\s*\{[^}]*\}/)[0];
  assert.match(rule, /color:\s*color-mix\(in srgb, var\(--oi-pill\) 70%, var\(--text-primary\)\)/);
  assert.match(rule, /background:\s*color-mix\(in srgb, var\(--oi-pill\) 10%, transparent\)/, "the ratio below assumes this wash");

  const card = token(dash, "--ov-card");
  const text = token(dash, "--text-primary");
  const accents = {
    danger: token(globals, "--chart-danger"),
    muted: token(dash, "--text-tertiary"),
    primary: token(globals, "--chart-primary"),
    // The floor `deriveChartRung` guarantees a workspace colour: 3:1 on the card.
    "a 3:1 workspace red": "#e0454f",
  };
  assert.ok(contrastRatio(accents["a 3:1 workspace red"], card) >= 3, "the stand-in must sit on the 3:1 floor");
  for (const [name, accent] of Object.entries(accents)) {
    const ground = mix(accent, card, 0.1);
    const ratio = contrastRatio(mix(accent, text, 0.7), ground);
    assert.ok(ratio >= AA, `${name} pill reads ${ratio.toFixed(2)}:1`);
  }
});

test("the account avatar's initials take the ink that belongs to its fill", async () => {
  const css = code(await read("app/(app)/portal/account-menu.css"));
  assert.match(css, /\.account-menu__trigger \.avatar\s*\{[^}]*color:\s*var\(--account-avatar-ink, var\(--on-brand-solid\)\)/);
  const menu = code(await read("app/(app)/portal/account-menu.tsx"));
  assert.match(menu, /"--account-avatar-ink": chipInk\(snapshot\.profile\.avatarColour, CHIP_INK_LIGHT\)/);

  const globals = await read("app/globals.css");
  const teal = token(globals, "--brand-primary");
  // White on the default teal is the 2.58:1 the sweep measured; chipInk refuses it.
  assert.ok(contrastRatio(CHIP_INK_LIGHT, teal) < AA);
  assert.ok(contrastRatio(chipInk(teal, CHIP_INK_LIGHT), teal) >= AA);
  assert.ok(contrastRatio(token(globals, "--on-brand-primary"), teal) >= AA, "the fallback ink on the fallback fill");
});

test("the platform table's sideways scroll is reachable from the keyboard", async () => {
  const overview = code(await read("app/(app)/admin/platform-overview.tsx"));
  assert.match(overview, /className="platform-table-wrap" tabIndex=\{0\} role="region" aria-label="Client workspaces"/);
});

test("the in-portal request form asks for a session before it draws", async () => {
  const page = code(await read("app/(app)/request/page.tsx"));
  assert.doesNotMatch(page, /"use client"/, "the guard has to run on the server");
  assert.match(page, /await requirePageSession\("\/request"\)/);
  assert.match(page, /return <RequestForm \/>/);
  const form = await read("app/(app)/request/request-form.tsx");
  assert.match(form, /^"use client";/);
  assert.match(code(form), /export function RequestForm\(\)/);
});

test("an unknown address gets a real 404 page", async () => {
  const page = code(await read("app/not-found.tsx"));
  assert.match(page, /<NotFoundTitle title="Page not found \| MAINTSUPP" \/>/);
  // vinext builds a boundary page's head from the layouts only: an export here would be dead.
  assert.doesNotMatch(page, /export const metadata/);
  assert.match(page, /<Link className="btn btn--primary" href="\/">/);
  /*
   * Re-pointed 2026-09-23 (dashboard §9 item 42): the root not-found still has
   * no group layout to bring the styles, so it still brings them itself — but
   * through the client component `NotFoundStyles`, because a `<link>` written in
   * this server component rode every route's payload and preloaded the
   * marketing stylesheet on the whole portal. The contract is the same; its home
   * moved one file.
   */
  assert.match(page, /<NotFoundStyles \/>/, "the root not-found has no group layout to bring the styles");
  assert.doesNotMatch(page, /<link rel="stylesheet"/, "a stylesheet link here becomes a preload on every route");
  const styles = await read("app/not-found-styles.tsx");
  assert.match(styles, /^"use client";/, "only a client reference keeps the link out of every page's payload");
  assert.match(code(styles), /marketing\.css\?url/);
  assert.match(code(styles), /<link rel="stylesheet" href=\{marketingCss\} \/>/);
  const title = code(await read("app/not-found-title.tsx"));
  assert.match(title, /document\.title = title;/);
});

test("the portal module switches are named by their module", async () => {
  const panel = code(await read("app/(app)/portal/views/portal-modules-panel.tsx"));
  assert.match(panel, /aria-label=\{module\.label\}\s*id=\{`pm-\$\{module\.key\}`\}/);
});

test("the sign-in tab says MAINTSUPP once", async () => {
  const login = code(await read("app/(app)/login/page.tsx"));
  assert.match(login, /title: "Sign in",/);
  const layout = code(await read("app/layout.tsx"));
  assert.match(layout, /template: "%s \| MAINTSUPP"/, "the template is what adds the brand");
});

test("every dashboard section's tab title is the sidebar's own label", async () => {
  const route = code(await read("app/(app)/dashboard/[[...section]]/page.tsx"));
  assert.match(route, /export async function generateMetadata\(/);
  const portal = await read("app/(app)/portal/portal-app.tsx");
  const meta = portal.slice(portal.indexOf("const sectionMeta: Record<"));
  const labels = new Map(
    [...meta.slice(0, 9000).matchAll(/\n  "?([a-z-]+)"?: \{\s*\n\s*label: "([^"]+)"/g)].map(([, key, label]) => [key, label]),
  );
  const table = route.slice(route.indexOf("const titles"), route.indexOf("export async function generateMetadata"));
  const titles = [...table.matchAll(/\n  "?([a-z-]+)"?: "([^"]+)",/g)];
  assert.ok(titles.length >= 15, `only ${titles.length} titles parsed`);
  for (const [, section, title] of titles) {
    assert.equal(title, labels.get(section), `${section}'s tab title must be its sidebar label`);
  }
  // Every section a dashboard URL can resolve to has a title.
  const routes = route.slice(route.indexOf("const routes"), route.indexOf("const titles"));
  for (const [, section] of routes.matchAll(/: "([a-z-]+)",/g)) {
    assert.ok(titles.some(([, key]) => key === section), `${section} has no tab title`);
  }
});

test("the marketing landmarks and heading order", async () => {
  const chrome = code(await read("app/(marketing)/_sections/chrome.tsx"));
  assert.match(chrome, /<aside className="utility" aria-label="Contact and quick links">/);
  assert.match(chrome, /<footer className="ftr">\s*<h2 className="vh">Site information<\/h2>/);
  assert.match(chrome, /<div className="cookie is-on" id="cookie" role="region" aria-label="Cookie notice">/);
  const report = code(await read("app/(marketing)/_sections/report-job.tsx"));
  assert.match(report, /<div className="qj reveal">/);
  assert.doesNotMatch(report, /<aside/, "the report form is the section's content, not a complementary landmark inside <main>");
  const request = code(await read("app/(app)/request/request-form.tsx"));
  assert.doesNotMatch(request, /<aside/);
});

/* ------------------------------------------------------------------ */
/* Live                                                                */
/* ------------------------------------------------------------------ */

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const serverUp = await (async () => {
  try {
    const response = await fetch(`${BASE_URL}/api/context`, { signal: AbortSignal.timeout(8000) });
    return response.status < 500;
  } catch {
    return false;
  }
})();

test("live: a 404 is still a 404, now with a language and a title", { skip: !serverUp && `no dev server on ${BASE_URL}` }, async () => {
  const response = await fetch(`${BASE_URL}/definitely-missing-phase10`, { redirect: "manual" });
  assert.equal(response.status, 404);
  const html = await response.text();
  assert.match(html, /<html lang="en"/);
  assert.equal((html.match(/<title>/g) ?? []).length, 1, "one title element; the client sets its text");
  assert.match(html, /This page does not exist/);
  assert.match(html, /<meta content="noindex" name="robots"/);
});

test("live: signed out, /request is sent to sign in and back", { skip: !serverUp && `no dev server on ${BASE_URL}` }, async () => {
  const response = await fetch(`${BASE_URL}/request`, { redirect: "manual" });
  assert.ok([303, 307, 308].includes(response.status), `status ${response.status}`);
  assert.match(response.headers.get("location") ?? "", /\/login\?next=%2Frequest/);
});
