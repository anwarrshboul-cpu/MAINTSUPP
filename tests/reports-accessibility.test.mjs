/**
 * The two axe findings on /dashboard/reports, fixed 2026-09-25.
 *
 * 1. `color-contrast` on `.report-schedules__primary` ("New schedule"): a literal
 *    white label on the brand teal measured 2.58:1 in both themes. The label now
 *    takes `--on-brand-primary`, the ink paired with the brand fill, as every
 *    `.primary-button` does — derived per brand, so a workspace's own primary
 *    keeps a readable label.
 * 2. `heading-order` on the first insight panel: the Reports widget grid sits
 *    directly under the page's `<h1>Reports</h1>`, and each panel's `<h3>` skipped
 *    a level. Panels are `<h2>`, styled exactly as the `<h3>` was (measured: same
 *    computed font, size, weight, line height, colour and margins in both themes).
 *    The panel's one other use, the Compliance page's Expiry timeline, is a peer of
 *    that page's "Portfolio" h2, so h2 is the right level there too.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const decommented = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

test("the schedules' primary button labels its fill with the paired ink, not a literal", async () => {
  const css = decommented(await read("app/(app)/portal/ops/report-schedules.css"));
  const rule = /\.report-schedules__primary \{([^}]*)\}/.exec(css);
  assert.ok(rule, "the rule exists");
  assert.match(rule[1], /background: var\(--brand-primary\) !important;/);
  assert.match(rule[1], /color: var\(--on-brand-primary\) !important;/, "the label is the brand's paired ink");
  assert.match(rule[1], /--control-own-fg: var\(--on-brand-primary\);/, "and the dark button rule reads the same");
  assert.doesNotMatch(rule[1], /#fff|#ffffff|\bwhite\b/i, "no one-theme literal");
  const globals = await read("app/globals.css");
  assert.match(globals, /--on-brand-primary:/, "the token exists");
});

test("insight panels are h2, directly under the Reports page's h1", async () => {
  const insights = decommented(await read("app/(app)/portal/dashboard-insights.tsx"));
  const panel = insights.slice(insights.indexOf("export function InsightPanel"), insights.indexOf("</header>", insights.indexOf("export function InsightPanel")));
  assert.match(panel, /<h2>\{named\}<\/h2>/);
  assert.doesNotMatch(panel, /<h3>/, "an h3 here skips a level under the page's h1");
  const portal = await read("app/(app)/portal/portal-app.tsx");
  const heading = portal.indexOf('<section className="analytics-page-heading">');
  assert.ok(heading > 0);
  assert.match(portal.slice(heading, heading + 1200), /<h1>Reports<\/h1>/, "the level the panels sit under");
  const css = await read("app/brand-overrides.css");
  assert.match(css, /\.insight-panel__head h2 \{\s*margin: 0;\s*font-size: 16px;\s*\}/, "the look is unchanged");
  assert.doesNotMatch(css, /\.insight-panel__head h3/, "no rule left styling the old level");
});
