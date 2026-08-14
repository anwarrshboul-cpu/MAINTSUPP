import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

/**
 * These tests read the built output, so they need `npm run build` first —
 * which is what `npm test` does. Without a build they skip rather than fail,
 * so running a single suite in isolation stays useful.
 */
async function builtCss() {
  try {
    const files = await readdir(path.join(root, "dist/client/assets"));
    return files.filter((f) => f.endsWith(".css"));
  } catch {
    return null;
  }
}

async function sizeOf(file) {
  const info = await stat(path.join(root, "dist/client/assets", file));
  return info.size;
}

test("each area loads its own stylesheet", async () => {
  const css = await builtCss();
  if (!css) return; // not built

  for (const expected of ["marketing", "globals", "brand-overrides", "job-link"]) {
    assert.ok(
      css.some((file) => file.startsWith(`${expected}-`)),
      `expected a separate ${expected} stylesheet, found: ${css.join(", ")}`,
    );
  }
});

test("the marketing stylesheet stays small", async () => {
  const css = await builtCss();
  if (!css) return;

  const marketing = css.find((file) => file.startsWith("marketing-"));
  const size = await sizeOf(marketing);
  /*
   * The ceiling was 20KB while the marketing site ran on an interim design.
   * The owner then supplied the original landing page and asked for it exactly;
   * its design system is roughly 70KB of source CSS, so 20KB was no longer a
   * budget, it was a veto on the brief.
   *
   * What this still protects is the reason the split exists at all: the
   * marketing pages must not drag in the dashboard's stylesheet. That bundle is
   * 192KB, so the check is that marketing stays well under half of it — enough
   * headroom for the ported system, not enough to hide a re-merge.
   */
  assert.ok(
    size < 80 * 1024,
    `marketing CSS is ${(size / 1024).toFixed(1)}KB. It was 256.9KB when everything shared one bundle, and the ported design system is about 60KB; anything over 80KB means something else has crept in.`,
  );

  const globals = css.find((file) => file.startsWith("globals-"));
  if (globals) {
    assert.ok(
      size < (await sizeOf(globals)) / 2,
      "the marketing bundle must stay well under half the dashboard's — if it approaches it, the two have been re-merged",
    );
  }
});

test("the contractor page carries almost no CSS", async () => {
  const css = await builtCss();
  if (!css) return;

  const jobLink = css.find((file) => file.startsWith("job-link-"));
  const size = await sizeOf(jobLink);
  assert.ok(
    size < 8 * 1024,
    `the contractor stylesheet is ${(size / 1024).toFixed(1)}KB. This page is opened on mobile data in a service corridor — keep it under 8KB.`,
  );
});

test("stylesheets are imported as URLs, not side effects", async () => {
  // A bare `import "./x.css"` gets merged into the shared entry chunk, which is
  // how everything ended up in one 256KB file. `?url` plus an explicit <link>
  // keeps each area's CSS separate.
  for (const [layout, sheets] of [
    ["app/(marketing)/layout.tsx", ["marketing.css"]],
    ["app/(app)/layout.tsx", ["globals.css", "brand-overrides.css"]],
    ["app/(public)/j/[token]/page.tsx", ["job-link.css"]],
  ]) {
    const source = await read(layout);
    for (const sheet of sheets) {
      assert.match(
        source,
        new RegExp(`${sheet.replace(".", "\\.")}\\?url`),
        `${layout} must import ${sheet} with ?url`,
      );
    }
    assert.match(source, /<link rel="stylesheet"/, `${layout} must emit its own link tag`);
  }
});

test("no layout imports a stylesheet it does not need", async () => {
  const marketing = await read("app/(marketing)/layout.tsx");
  assert.doesNotMatch(marketing, /globals\.css\?url/);
  assert.doesNotMatch(marketing, /brand-overrides\.css\?url/);

  const publicLayout = await read("app/(public)/layout.tsx");
  assert.doesNotMatch(
    publicLayout,
    /\.css/,
    "the public layout must load no shared stylesheet at all",
  );

  const rootLayout = await read("app/layout.tsx");
  assert.doesNotMatch(rootLayout, /\.css/, "the root layout must stay stylesheet-free");
});

test("the contractor page is outside the app group", async () => {
  // It inherited 254KB of dashboard CSS while it sat under (app).
  const publicLayout = await read("app/(public)/layout.tsx");
  assert.match(publicLayout, /service corridor/, "the reasoning must be recorded");

  const page = await read("app/(public)/j/[token]/page.tsx");
  assert.match(page, /robots: \{ index: false/, "it must still be unindexed");
});

test("css code splitting is enabled deliberately", async () => {
  const config = await read("vite.config.ts");
  assert.match(config, /cssCodeSplit: true/);
  assert.match(
    config,
    /downloaded the dashboard/,
    "the reason must be recorded — it is not obvious from the setting alone",
  );
});

test("board geometry matches the monday grid it replaces", async () => {
  const css = await read("app/board-metrics.css");
  // Uniform vertical rhythm — the board previously mixed 30/32/36/38/39px.
  assert.match(css, /--board-row-height: 36px/);
  assert.match(css, /--board-header-height: 36px/);
  assert.match(css, /--board-group-header-height: 40px/);
  // Two icon sizes only, not the seven the board had.
  assert.match(css, /--board-icon-cell: 16px/);
  assert.match(css, /--board-icon-toolbar: 20px/);
});

test("board metrics carry no colour of their own", async () => {
  const css = await read("app/board-metrics.css");
  // Dimensions may be copied; the palette may not. Any colour must come from a
  // MAINTSUPP custom property.
  const literals = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(
    literals,
    [],
    `board-metrics.css must contain no hex colours, found: ${literals.join(", ")}`,
  );
  assert.match(css, /COLOUR IS NOT COPIED/, "the boundary must be stated");
});

test("fixed row heights are released on mobile", async () => {
  const css = await read("app/board-metrics.css");
  const mobile = css.slice(css.indexOf("@media (max-width: 767px)"));
  assert.match(mobile, /height: auto/, "a card layout cannot use a fixed row height");
  assert.match(mobile, /min-height: 44px/, "rows must stay tappable");
});

test("seeded column widths follow monday's per-type defaults", async () => {
  const seed = await read("db/monday-board-spec.ts");
  const expect = { name: 300, status: 175, priority: 135, cost: 135, timeline: 200 };
  for (const [key, width] of Object.entries(expect)) {
    const block = seed.slice(seed.indexOf(`key: "${key}"`));
    assert.match(
      block.slice(0, 300),
      new RegExp(`width: ${width}`),
      `${key} should be ${width}px to match the source board`,
    );
  }
});
