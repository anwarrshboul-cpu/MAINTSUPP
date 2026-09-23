/**
 * Phase 5 — the charts follow the brand.
 *
 * WHAT WAS ACTUALLY WRONG, because it was not what the shipped sentence said.
 *
 * `views/brand-colours-panel.tsx` told every administrator that "charts and meters
 * keep the MAINTSUPP palette for now — they are drawn from their own colour set,
 * which is not yet configurable here." The second half of that was already false:
 * the live Operations dashboards are almost entirely `var()`-driven and have been.
 * `oi-dash.tsx` discards the hexes its own API sends it and repaints from
 * `var(--accent-*)`; `dashboard-insights.tsx` already reads `var(--brand-fill)` and
 * four `var(--status-*)`.
 *
 * The real fault was one level down. Those `--accent-*` and `--ov-*` properties were
 * DECLARED BY `.ov-dash` ITSELF, and a CSS custom property resolves from the nearest
 * ancestor that declares it — so the `:root` block `resolveThemeCss` emits could
 * never reach inside the island. Specificity and document order have nothing to do
 * with it; proximity decides, and `.ov-dash` is nearer than `:root` for everything
 * in a dashboard.
 *
 * So the fix is a set of names the island does NOT declare. `--chart-*` lives on
 * `:root`, the island references it, and the override lands. Most of this file
 * exists to keep that property true, because it is invisible: somebody adding
 * `--chart-primary: #xxxxxx` to `ov-dash.css` for a quick fix would silently
 * disconnect every chart from the brand again, and nothing would look wrong.
 *
 * THE OTHER HALF IS THAT IT IS MODE-INDEPENDENT.
 *
 * The island is dark in both document themes (`color-scheme: dark`, its own
 * grounds). A light-theme value solved against `MODE_GROUND.light` (`#ffffff`)
 * would be measured against the wrong ground there — the real ground inside is
 * `#102630`, which is `MODE_GROUND.dark` and also `--ov-card` exactly. So
 * `deriveChartRung` takes no `mode` at all, and `globals.css` declares `--chart-*`
 * once with no dark counterpart. `--rail-*` already works this way for the same
 * reason, in `deriveChromeFamily`'s own words: "the rail is always a dark surface".
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { contrastRatio } from "../app/(app)/portal/chip-ink.ts";
import {
  AA_FILL,
  MODE_GROUND,
  deriveChartRung,
} from "../app/lib/theme-colour.ts";
import {
  THEME_TOKEN_CATALOGUE,
  resolveThemeCss,
  themeContrastWarnings,
} from "../app/lib/theme-tokens.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const decommented = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "");

/** The six rungs, and which catalogue token owns each. */
const CHART_RUNGS = [
  ["--chart-primary", "brand.primary", "#12b4a8"],
  ["--chart-info", "accent.info", "#38bdf8"],
  ["--chart-success", "status.success", "#25d98b"],
  ["--chart-warning", "status.warning", "#ffd447"],
  ["--chart-danger", "status.danger", "#ff4d5e"],
  ["--chart-attention", "status.attention", "#ff8a3d"],
];

/** The four stylesheets of the always-dark island. */
const ISLAND = [
  "app/(app)/portal/ops/ov-dash.css",
  "app/(app)/portal/ops/oi-dash.css",
  "app/(app)/portal/ops/cp-dash.css",
  "app/(app)/portal/ops/rp-dash.css",
];

/** The declarations inside the block beginning on `line`. Brace-counting, because
    `globals.css` is 17,000 lines of nested at-rules and a regex picks the wrong
    closing brace — the same scan `theme-token-foundation` uses. */
function blockAt(css, startLine) {
  const lines = css.split("\n");
  let depth = 0;
  const collected = [];
  for (let i = startLine - 1; i < lines.length; i += 1) {
    depth += (lines[i].match(/\{/g) ?? []).length;
    depth -= (lines[i].match(/\}/g) ?? []).length;
    collected.push(lines[i]);
    if (depth === 0 && collected.length > 1) break;
  }
  const body = decommented(collected.join("\n"));
  const out = {};
  for (const match of body.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out[match[1]] = match[2].trim();
  }
  return out;
}

async function paletteBlocks() {
  const css = await read("app/globals.css");
  const lines = css.split("\n");
  const lightLine = lines.findIndex((line) => /^:root\s*\{/.test(line)) + 1;
  const darkLine =
    lines.findIndex((line) => /^:root:not\(\[data-theme="light"\]\)/.test(line)) + 1;
  assert.ok(lightLine > 0 && darkLine > 0, "both palette blocks must be findable");
  return { light: blockAt(css, lightLine), dark: blockAt(css, darkLine) };
}

/* ------------------------------------------------------------------ */
/* The declarations                                                    */
/* ------------------------------------------------------------------ */

test("every chart rung is declared on the bare :root, and only there", async () => {
  const { light, dark } = await paletteBlocks();
  for (const [property, , hex] of CHART_RUNGS) {
    assert.equal(
      light[property],
      hex,
      `${property} must be declared on the bare :root as ${hex} — that is where an ` +
        "override can reach it, and where the island resolves it from",
    );
    assert.equal(
      dark[property],
      undefined,
      `${property} must NOT be restated in the dark block. The island is dark in ` +
        "both themes, so a second value would be solved against the wrong ground " +
        "— exactly the invariance --rail-* keeps for the navigation rail.",
    );
  }
});

test("the island declares no chart rung, which is the whole mechanism", async () => {
  /*
   * THE ONE THAT MATTERS MOST, and the one a reader cannot see by looking.
   *
   * A custom property resolves from the NEAREST declaring ancestor. The moment any
   * of these four stylesheets declares `--chart-primary` for itself, the `:root`
   * override stops reaching the charts and every dashboard silently goes back to a
   * fixed palette. Nothing would look broken; the brand would just quietly stop at
   * the edge of a chart, which is the bug this phase fixed.
   */
  for (const file of ISLAND) {
    const css = decommented(await read(file));
    for (const [property] of CHART_RUNGS) {
      assert.ok(
        !new RegExp(`${property}\\s*:`).test(css),
        `${file} declares ${property}. It must only ever REFERENCE it: a property ` +
          "declared here resolves from here, and the :root override can never win " +
          "— proximity decides, not specificity or order.",
      );
    }
  }
});

test("every chart rung the island reads is one globals.css declares", async () => {
  /*
   * The mirror of the rule above. `tests/overview-components.test.mjs` already
   * enforces this shape for `overview.css`; a `var()` naming nothing renders as
   * nothing, which on a chart series is an invisible bar.
   */
  const { light } = await paletteBlocks();
  for (const file of ISLAND) {
    const css = await read(file);
    for (const match of css.matchAll(/var\((--chart-[a-z-]+)\)/g)) {
      assert.ok(
        light[match[1]] !== undefined,
        `${file} reads ${match[1]}, which globals.css does not declare`,
      );
    }
  }
});

test("the four dashboards' accents follow the theme", async () => {
  /* One assertion per surface, so a failure names the dashboard that regressed
     rather than a line number. The per-token pins live in each dashboard's own
     `*-dash-ui` test, which also checks the seed behind each reference. */
  const expected = [
    ["app/(app)/portal/ops/ov-dash.css", ["--ov-teal", "--ov-orange", "--ov-amber", "--ov-blue", "--ov-green", "--ov-red"]],
    ["app/(app)/portal/ops/oi-dash.css", ["--accent-primary", "--accent-amber", "--accent-critical", "--accent-blue", "--accent-green", "--accent-orange"]],
    ["app/(app)/portal/ops/cp-dash.css", ["--cp-compliant", "--cp-expiring", "--cp-expired", "--cp-missing", "--cp-due-30", "--cp-due-60", "--cp-due-90"]],
    ["app/(app)/portal/ops/rp-dash.css", ["--rp-total", "--rp-reactive", "--rp-planned", "--rp-bar", "--rp-weekly", "--rp-fortnightly", "--rp-monthly"]],
  ];
  for (const [file, tokens] of expected) {
    const css = await read(file);
    for (const token of tokens) {
      assert.match(
        css,
        new RegExp(`\\${token}: var\\((--chart-[a-z-]+|--brand-[a-z-]+)\\);`),
        `${file}: ${token} must reference a theme token, not carry a literal`,
      );
    }
  }
});

/* ------------------------------------------------------------------ */
/* The derivation                                                      */
/* ------------------------------------------------------------------ */

test("deriveChartRung takes no mode, and cannot be given one", async () => {
  /*
   * Deliberately not `(name, base, mode)`. The island is dark in both themes, so
   * there is no mode to take — and a signature that accepted one would invite a
   * caller to pass the document's, which is the exact mistake that would ship a
   * chart measuring as compliant against a ground it is not drawn on.
   */
  assert.equal(deriveChartRung.length, 2, "name and base, and nothing else");

  const source = await read("app/lib/theme-colour.ts");
  const body = source.slice(source.indexOf("export function deriveChartRung"));
  const fn = body.slice(0, body.indexOf("\n}"));
  assert.match(
    fn,
    /MODE_GROUND\.dark/,
    "it must solve against the dark ground explicitly, not against MODE_GROUND[mode]",
  );
  /* Comments stripped first: the body's own note explains why there is no mode, and
     an assertion that could not tell the explanation from the code would be
     unfixable. */
  assert.ok(
    !/\bmode\b/.test(decommented(fn)),
    "and must not read a mode — a signature that accepted one would invite a caller " +
      "to pass the document's, which is the mistake that ships a chart measured " +
      "against a ground it is not drawn on",
  );
});

test("a chart rung clears the 3:1 a graphical object needs, for every hue", async () => {
  /*
   * `AA_FILL`, not `AA_TEXT`. A series is a graphical object (WCAG SC 1.4.11), and
   * it is not carrying the meaning alone: `dashboard-insights.tsx` states every
   * chart is drawn "always with a legend and direct labels rather than colour
   * alone", `ops-tokens.css` says legibility on a bar "is carried by structure",
   * and `tests/stage-eighteen-insights.test.mjs` pins that. Solving a series at
   * 4.5:1 would drag every hue toward the extremes and make adjacent series HARDER
   * to tell apart, which is the opposite of what a chart needs.
   *
   * Swept over 216 hues, the same grid `theme-token-foundation` uses.
   */
  let solved = 0;
  for (let r = 0; r <= 255; r += 51) {
    for (let g = 0; g <= 255; g += 51) {
      for (let b = 0; b <= 255; b += 51) {
        const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
        const value = deriveChartRung("primary", hex)["--chart-primary"];
        const ratio = contrastRatio(value, MODE_GROUND.dark);
        assert.ok(
          ratio >= AA_FILL - 0.005,
          `${hex} derives ${value}, which is ${ratio.toFixed(2)}:1 on the dark ` +
            `ground — under the ${AA_FILL}:1 a filled series needs`,
        );
        if (value.toLowerCase() !== hex.toLowerCase()) solved += 1;
      }
    }
  }
  assert.ok(solved > 0, "a solver that never moves a colour is not solving anything");
});

test("the shipped palette is already clear, so nothing moves by default", () => {
  /*
   * The property that makes this phase invisible to every existing workspace: each
   * shipped base already clears 3:1 on the dark ground with room — 4.83:1 for
   * danger, 11:1 for warning — so `solveForContrast` returns it untouched and the
   * seeded value IS the literal the island carried before.
   */
  for (const [property, , hex] of CHART_RUNGS) {
    const derived = deriveChartRung(property.replace("--chart-", ""), hex)[property];
    assert.equal(
      derived.toLowerCase(),
      hex.toLowerCase(),
      `${hex} should already clear ${AA_FILL}:1 on ${MODE_GROUND.dark} and be ` +
        "returned unchanged, so a workspace that has chosen nothing sees no change",
    );
    assert.ok(contrastRatio(hex, MODE_GROUND.dark) >= AA_FILL);
  }
});

test("a chart rung has no text rung, because a series carries no text", () => {
  /*
   * `-fg` and `-wash` are for text and for a tinted ground. A series has neither:
   * where a number does sit ON a slice, the ink is measured against that slice by
   * `chipInk`, which is the audited function for a ground that comes from data.
   *
   * This is not only tidiness. `themeContrastWarnings` measures every `*-fg`
   * against its matching `*-wash`, so inventing those rungs for six new tokens
   * would add thirty-six pairs to a sweep whose warning rate is asserted to stay
   * under 5%.
   */
  for (const [, , hex] of CHART_RUNGS) {
    const family = deriveChartRung("primary", hex);
    assert.deepStrictEqual(Object.keys(family), ["--chart-primary"], "one rung, exactly");
  }
});

/* ------------------------------------------------------------------ */
/* The catalogue                                                       */
/* ------------------------------------------------------------------ */

test("every brand and status token derives its chart rung too", () => {
  /*
   * The join that makes one colour choice reach both the badge and the series. A
   * token that derived a status family and no chart rung would recolour a chip and
   * leave the chart behind, which is the half-feature this phase removed.
   */
  for (const [property, key] of CHART_RUNGS) {
    const token = THEME_TOKEN_CATALOGUE.find((entry) => entry.key === key);
    assert.ok(token, `${key} must be in the catalogue`);
    for (const mode of ["light", "dark"]) {
      const family = token.derive("#7c3aed", mode);
      assert.ok(
        family[property],
        `${key} must derive ${property} in ${mode} mode, or a brand change stops ` +
          "at the chart's edge",
      );
    }
    /* And mode-independently: the same chosen colour must give the same series
       colour whichever theme the document is in. */
    assert.equal(
      token.derive("#7c3aed", "light")[property],
      token.derive("#7c3aed", "dark")[property],
      `${key} must derive the same ${property} in both modes — the island is dark ` +
        "in both, so two values would mean one of them is measured wrongly",
    );
  }
});

test("status.attention closes the gap the catalogue had", async () => {
  /*
   * `globals.css` has shipped the whole `--status-orange` family since the palette
   * was approved, and fourteen places read it through `var()` — "reactive work",
   * "missing certificate", the 30-day due band. It was the one shipped status hue a
   * workspace could not set, and nothing but an omission made it so.
   */
  const token = THEME_TOKEN_CATALOGUE.find((entry) => entry.key === "status.attention");
  assert.ok(token, "status.attention must be in the catalogue");
  assert.equal(token.group, "Status", "it belongs beside the other four");
  assert.equal(token.seedInput, "#ff8a3d");

  const { light, dark } = await paletteBlocks();
  const resolvedDark = { ...light, ...dark };
  for (const [property, seeded] of Object.entries(token.seed.dark)) {
    assert.equal(
      seeded,
      resolvedDark[property],
      `status.attention seeds ${property} as ${seeded}, but globals.css ships ` +
        `${resolvedDark[property]}`,
    );
  }

  /* The uses it makes configurable. Counted rather than asserted as a number, so
     the message says what changed if somebody removes one. */
  let uses = 0;
  for (const file of [
    "app/globals.css",
    ...ISLAND,
    "app/(app)/portal/dashboard-insights.tsx",
  ]) {
    uses += (await read(file)).split("var(--status-orange").length - 1;
  }
  assert.ok(uses >= 1, "something must read --status-orange, or the token is decorative");
});

test("the catalogue is eleven tokens, and none names a ground", () => {
  /*
   * RE-POINTED TWICE, and the convention is the point rather than the number.
   *
   * Six to eight: the typeface phase added `type.body` and `type.display`.
   * Eight to eleven: the surface phase added `shape.corners`, `surface.depth` and
   * `layout.board_density`. The list is still pinned IN FULL rather than by length
   * alone, for the reason it was pinned in the first place — a token added without
   * a deliberate change here is a token nobody chose to offer — and the ground is
   * still not among them.
   */
  assert.equal(THEME_TOKEN_CATALOGUE.length, 11);
  assert.deepStrictEqual(
    THEME_TOKEN_CATALOGUE.map((token) => token.key),
    [
      "brand.primary",
      "accent.info",
      "status.success",
      "status.warning",
      "status.danger",
      "status.attention",
      "type.body",
      "type.display",
      "shape.corners",
      "surface.depth",
      "layout.board_density",
    ],
  );
  /*
   * Surfaces and text stay out, and the reason is in `theme-tokens.ts`: "a
   * background is the ground, so a bad choice does not degrade one control, it
   * makes the product unreadable and takes the theme editor down with it." It is
   * sharper now than before this phase — `MODE_GROUND.dark` is `#102630`, which is
   * also `--ov-card`, and EVERY chart rung is solved against it. Make the ground
   * configurable and every solve in the product becomes wrong.
   */
  for (const token of THEME_TOKEN_CATALOGUE) {
    for (const mode of ["light", "dark"]) {
      for (const property of Object.keys(token.seed[mode])) {
        assert.ok(
          !/^--(background|text|ov-card|ov-bg|ov-frame)/.test(property),
          `${token.key} seeds ${property}, which is a ground or an ink`,
        );
      }
    }
  }
});

/* ------------------------------------------------------------------ */
/* End to end                                                          */
/* ------------------------------------------------------------------ */

test("a brand override reaches the charts", () => {
  /*
   * The feature, in one assertion. Before this phase the emitted CSS carried no
   * chart property at all, so a workspace could set its primary colour and watch
   * every donut stay teal.
   */
  const css = resolveThemeCss({ "brand.primary": "#7c3aed" });
  assert.match(css, /--chart-primary:/, "the emitted CSS must carry the chart rung");
  /* `:root{` with no space — `resolveThemeCss` emits minified rules, so this is
     matched literally rather than with a formatting-tolerant pattern. */
  assert.ok(css.startsWith(":root{"), "on :root, where the island resolves it from");

  /* And it is the same value in both blocks, so the island cannot pick up two. */
  const values = [...css.matchAll(/--chart-primary:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(values.length >= 1);
  assert.equal(new Set(values).size, 1, `--chart-primary emitted as ${values.join(" / ")}`);
});

test("a workspace that has changed nothing still emits no CSS", () => {
  /* Unchanged by this phase, and worth re-asserting here: the whole mechanism rests
     on the absence of a row meaning the shipped product. */
  assert.equal(resolveThemeCss({}), "");
  assert.deepStrictEqual(themeContrastWarnings({}), []);
});

test("the six new rungs did not make the contrast validator noisy", () => {
  /*
   * `theme-token-foundation` asserts the warning rate over 1,331 colours stays
   * under 5%. Chart rungs contribute nothing to it — they have no `-fg`/`-wash`
   * pair — and this checks the default and the house colour stay silent, which is
   * the property that stops people learning to dismiss the warning.
   */
  assert.deepStrictEqual(themeContrastWarnings({ "brand.primary": "#12b4a8" }), []);
  assert.deepStrictEqual(themeContrastWarnings({ "status.attention": "#ff8a3d" }), []);
});

/* ------------------------------------------------------------------ */
/* What deliberately does NOT follow                                   */
/* ------------------------------------------------------------------ */

test("an absence is never a brand colour", async () => {
  /*
   * `--cp-other` ("no date recorded") and `--rp-less-often` ("rarely") stay
   * literals, and `overview-meters.ts` states the rule: an absence must "never be a
   * colour that could pass for a real category". A brand-derived grey is a
   * contradiction in terms — and if a workspace chose grey as its brand, the two
   * would become indistinguishable.
   */
  const cp = await read("app/(app)/portal/ops/cp-dash.css");
  assert.match(cp, /--cp-other: #64707b;/);
  const rp = await read("app/(app)/portal/ops/rp-dash.css");
  assert.match(rp, /--rp-less-often: #64707b;/);
});

test("the two area washes stay literals, because rgba(var(--x)) is not CSS", async () => {
  /*
   * A custom property cannot be interpolated into a colour function's channels, so
   * `rgba(var(--chart-primary), 0.35)` is simply invalid. `rp-dash.css`'s own
   * comment already records that the shared `AreaTrend` derives its wash from the
   * line colour instead, so these two are declared for completeness and read by
   * nothing — which is why this is a note rather than a defect.
   */
  const rp = await read("app/(app)/portal/ops/rp-dash.css");
  assert.match(rp, /--rp-area-top: rgba\(18, 180, 168, 0\.35\);/);
  assert.match(rp, /--rp-area-bottom: rgba\(18, 180, 168, 0\.03\);/);
});

test("the falling-delta ink stays fixed, because its test asserts a failure", async () => {
  /*
   * `tests/rp-dash-ui.test.mjs` asserts `--rp-down` clears 4.5:1 on TWO grounds and
   * that `#ff4d5e` FAILS on one of them. A derived value cannot be held to an
   * assertion half of which asserts a failure, so this one is a deliberate literal
   * rather than an oversight.
   */
  const rp = await read("app/(app)/portal/ops/rp-dash.css");
  assert.match(rp, /--rp-down: #ff6b77;/);
  const pin = await read("tests/rp-dash-ui.test.mjs");
  assert.match(pin, /--rp-down: \(#\[0-9a-f\]\{6\}\)/, "and its own contrast pin still stands");
});

test("the screen's claim about what follows is true, and names what does not", async () => {
  /*
   * The sentence that started this phase said charts were "not yet configurable
   * here". Replacing a false claim with a vaguer one would be no better, so the new
   * sentence names the exclusions: the greys that mean "not recorded", and the
   * graded teal scales. Pinned, because a claim on a settings screen is a promise.
   */
  const panel = await read("app/(app)/portal/views/brand-colours-panel.tsx");
  assert.match(panel, /The dashboard charts follow these colours too\./);
  assert.match(panel, /not recorded/, "the exclusions must be named, not implied");
  assert.ok(
    !/which is not yet configurable here/.test(panel),
    "the old claim must be gone, not merely contradicted elsewhere",
  );
  /* And the reasoning is kept rather than the old sentence silently deleted. */
  assert.match(panel, /THIS SENTENCE USED TO SAY THE OPPOSITE/);
});

test("the module header no longer says chart palettes are out of scope", async () => {
  const source = await read("app/lib/theme-tokens.ts");
  assert.ok(
    !/chart palettes are likewise out of scope/.test(source),
    "that sentence was the scope this phase changed",
  );
  assert.match(source, /CHART PALETTES ARE NO LONGER OUT OF SCOPE/);
  /* Surfaces and text are still out, and must still say so. */
  assert.match(source, /Surfaces \(`--background-\*`\) and text \(`--text-\*`\) are NOT configurable/);
});

test("the stale 30-second cache claim is corrected where it was written", async () => {
  /*
   * `app/(app)/layout.tsx` said the theme read "is cached per isolate for 30 seconds
   * by `theme-repository.ts`". That cache was removed after deployed QA proved it
   * wrong — a write invalidated one serverless instance while the read landed on
   * another — and `theme-token-foundation` now asserts its absence. A comment that
   * describes a mechanism the tests forbid is worse than no comment.
   */
  const layout = await read("app/(app)/layout.tsx");
  assert.ok(
    !/is cached per isolate for 30 seconds/.test(layout),
    "the claim must be corrected, not left standing",
  );
  assert.match(layout, /THE COST, AND A CORRECTION/);
  const repository = await read("app/lib/theme-repository.ts");
  assert.ok(
    !/setTimeout|CACHE_MS/.test(repository),
    "and the cache must still be absent, which is what makes the correction true",
  );
});
