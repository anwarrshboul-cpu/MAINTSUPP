/**
 * THE WIDER THEME ENGINE — the owner's decision P, and the third kind of token.
 *
 * WHAT THIS PHASE ADDED, AND THE ONE QUESTION EVERY CANDIDATE HAD TO ANSWER.
 *
 * A colour is a hex and a typeface is a key into a whitelist. A corner style is
 * neither: one name stands for a family of measurements. So `TokenKind` gained
 * `"choice"`, and two tokens arrived on it — `shape.corners` and `surface.depth`.
 * A third, `layout.board_density`, was built and withdrawn before release: set to
 * its tallest option on a Preview it changed the height of 0 rendered elements,
 * because the job board's rows are literals (see `theme-tokens.ts`).
 *
 * The question each candidate axis had to answer was **does the property funnel**,
 * because a control that saves and changes almost nothing is the same fault as a
 * control that changes something and does not save, and this product has shipped
 * both. `theme-tokens.ts` records the measurement that decided it: border-radius
 * 242 of 1,129 declarations read a `var()` and box-shadow 122 of 229, while font-size is 2 of
 * 1,898 and padding 12 of 1,833. That arithmetic is why there is no text-scale and
 * no general spacing control here, and the tests below keep it that way.
 *
 * THREE THINGS THIS FILE EXISTS TO STOP:
 *
 *   1. A choice token that STORES AND EMITS NOTHING. That exact bug shipped once
 *      already: before `TokenKind`, `resolveThemeCss` gated on `parseHex`, so a
 *      font token was saved, audited, echoed back and shown as changed while no
 *      pixel moved. Every kind must be proved to reach the document.
 *   2. A caller's string reaching the `<style>` element. A choice stores a KEY and
 *      the pixels come from the module, exactly as a face stores a key and the
 *      stack comes from the module.
 *   3. An option that quietly breaks an accessibility floor. Nothing here may make
 *      a row shorter than the product already ships, and no token may touch a
 *      font-size, a line-height, a letter-spacing, a font-weight or a padding.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  THEME_TOKEN_CATALOGUE,
  resolveThemeCss,
  resolveThemeFamily,
  themeContrastWarnings,
  themeTokenDefinition,
  tokenOptionKeys,
  validateThemeToken,
} from "../app/lib/theme-tokens.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const decommented = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "");

/** The two choice tokens, the property each is checked through, and its default. */
const CHOICES = [
  ["shape.corners", "--radius-sm", "soft"],
  ["surface.depth", "--shadow-md", "soft"],
];

const choiceTokens = () => THEME_TOKEN_CATALOGUE.filter((token) => token.kind === "choice");

/**
 * Every stylesheet the PORTAL loads, which is `app/**` minus the marketing site.
 *
 * The marketing pages are MAINTSUPP's own brand and carry their own `--r-*` scale
 * (`app/(marketing)/marketing.css`); a workspace's corner choice has no business
 * reaching them, so they are excluded from the adoption count as well as from the
 * engine.
 */
async function portalStylesheets() {
  const found = [];
  const walk = async (dir) => {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "(marketing)") continue;
        await walk(next);
      } else if (entry.name.endsWith(".css")) {
        found.push(next);
      }
    }
  };
  await walk("app");
  return found;
}

/* ================================================================== */
/* It reaches the document                                             */
/* ================================================================== */

test("every choice token EMITS — the silent-drop regression, for the third kind", () => {
  /*
   * THE MOST IMPORTANT ASSERTION IN THIS FILE, and it is the same one
   * `theme-typeface.test.mjs` made for fonts. A token whose value the emitter does
   * not understand is stored, audited, echoed back by GET and shown as changed in
   * the panel while changing nothing at all — and nothing else in the suite would
   * notice.
   */
  for (const token of choiceTokens()) {
    for (const option of token.options) {
      const css = resolveThemeCss({ [token.key]: option.key });
      assert.ok(css.startsWith(":root{"), `${token.key} must emit on :root`);
      for (const property of Object.keys(token.seed.light)) {
        assert.match(
          css,
          new RegExp(`${property}:`),
          `${token.key} = ${option.key} must EMIT ${property}. If this fails the ` +
            "token saves and changes nothing — check the kind gate in resolveThemeCss.",
        );
      }
    }
  }
});

test("a chosen option paints its own measurements, in both blocks", () => {
  const css = resolveThemeCss({ "shape.corners": "sharp" });
  assert.match(css, /--radius-sm:2px/);
  assert.match(css, /--radius:4px/);
  assert.match(css, /--radius-lg:6px/);
  /* Both blocks, because the light and the dark theme share a corner scale and the
     dark selector must not leave the old radius in place on the dark theme. */
  assert.equal(css.split("--radius-sm:2px").length - 1, 2);

  /* Depth is the one that differs by mode: a blue-grey shadow is invisible on a
     dark ground, so each block carries its own ink. */
  const depth = resolveThemeCss({ "surface.depth": "raised" });
  assert.match(depth, /--shadow-md:0 18px 48px rgba\(7, 24, 38, 0\.14\)/);
  assert.match(depth, /--shadow-md:0 20px 50px rgba\(0, 0, 0, 0\.46\)/);
});

test("the default option is what ships, so 'MAINTSUPP default' cannot drift", () => {
  /*
   * The seed is pinned against the stylesheets by
   * `tests/theme-token-foundation.test.mjs`. This pins the other half: the option
   * a workspace can explicitly choose to mean "the MAINTSUPP one" must paint the
   * same values the seed does. Without it, picking the default from the select
   * could repaint the product.
   */
  for (const [key, , defaultOption] of CHOICES) {
    const token = themeTokenDefinition(key);
    for (const mode of ["light", "dark"]) {
      assert.deepStrictEqual(
        token.derive(defaultOption, mode),
        token.seed[mode],
        `${key} = ${defaultOption} must paint exactly what ${key} seeds for ${mode}`,
      );
    }
    assert.equal(token.seedInput, defaultOption, `${key} must open on ${defaultOption}`);
  }
});

test("a workspace that has chosen no surface style emits nothing", () => {
  assert.equal(resolveThemeCss({}), "", "the steady state is still an empty string");
  /* And an unset choice token resolves to its seed rather than to a first option. */
  const family = resolveThemeFamily({}, "light");
  assert.equal(family["--radius-sm"], "8px");
  assert.equal(family["--radius-card"], "15px", "the card rung opens on what the Overview ships");
  assert.equal(family["--shadow-md"], "0 12px 36px rgba(7, 24, 38, 0.09)");
});

/* ================================================================== */
/* Nothing a caller sends reaches the stylesheet                       */
/* ================================================================== */

test("only an option key this module owns is accepted", () => {
  for (const token of choiceTokens()) {
    const allowed = tokenOptionKeys(token);
    assert.ok(allowed.length >= 2, `${token.key} must offer a real choice`);
    for (const key of allowed) {
      assert.equal(validateThemeToken(token.key, key).ok, true, `${token.key}=${key}`);
    }
    /* A MEASUREMENT is not an option key, and this is the whole boundary: a caller
       cannot send pixels, only the name of a set of pixels this file holds. */
    for (const hostile of [
      "8px",
      "0",
      "#12b4a8",
      "soft; --brand-primary: red",
      "soft}:root{--brand-primary:red",
      "url(https://example.test/x.css)",
      "/* */",
      "SOFT",
      "",
    ]) {
      const checked = validateThemeToken(token.key, hostile);
      assert.equal(checked.ok, false, `${token.key} must refuse ${JSON.stringify(hostile)}`);
      assert.match(checked.reason, /must be one of/);
    }
  }
});

test("an unknown option is treated as unset rather than emitted", () => {
  /*
   * The server refuses one on write, so this should be unreachable — but a row
   * written before an option was renamed, or by a future migration, must degrade to
   * the shipped value rather than emit a property with a keyword in it.
   */
  for (const [key, property] of CHOICES) {
    const css = resolveThemeCss({ [key]: "no-such-option" });
    assert.equal(css, "", `${key} must emit nothing for an unknown option`);
    assert.equal(resolveThemeFamily({ [key]: "no-such-option" }, "light")[property],
      themeTokenDefinition(key).seed.light[property]);
  }
});

test("the emitted block never contains a keyword a caller sent", () => {
  const css = resolveThemeCss({
    "shape.corners": "rounded",
    "surface.depth": "flat",
  });
  for (const word of ["rounded", "flat"]) {
    assert.ok(!css.includes(word), `${word} is a key, not a value — it must not be emitted`);
  }
  /* What IS emitted is measurements, and nothing that could close a declaration. */
  assert.ok(!/[<>]/.test(css), "no markup can reach the style element");
  assert.equal(css.split("{").length, 3, "two blocks, and nothing opened a third");
});

/* ================================================================== */
/* The floors this phase may not cross                                 */
/* ================================================================== */

test("no token offers the board's geometry while the board does not read it", async () => {
  /*
   * RE-POINTED from "no option makes a row shorter", which guarded a
   * `layout.board_density` token that was withdrawn before release. The token set
   * `--board-row-height` and its three siblings, which `app/board-metrics.css`
   * reads, but no rendered component carries a class that file styles. The live
   * board is `.live-sheet`, sized by literals per breakpoint, so the control saved
   * and changed nothing: measured on a Preview, 0 elements moved on four screens.
   *
   * So the rule now is the one that would have caught it. A `--board-*` property
   * may be offered only once `.live-sheet` reads it. Until then, none is. If it is
   * ever offered, it may only make rows TALLER: they are already under the 44px
   * touch minimum.
   */
  const offersBoard = choiceTokens().some((token) =>
    token.options.some((option) => Object.keys(option.family.light).some((name) => name.startsWith("--board-"))),
  );
  const css = await read("app/globals.css");
  const liveSheetReadsIt = /\.live-sheet td[^{]*\{[^}]*height: var\(--board-row-height\)/.test(css);
  assert.ok(!offersBoard || liveSheetReadsIt, "a board-height token would change nothing the reader sees");
  assert.equal(themeTokenDefinition("layout.board_density"), null, "withdrawn, not merely hidden");
});

test("no token — of any kind — configures a metric the product sets per surface", async () => {
  /*
   * `theme-typeface.test.mjs` already forbids these property names on a seed, and
   * that test is unchanged and still passes. This is the same rule applied to the
   * place the third kind could smuggle one in: an OPTION's family, which the seed
   * check never sees.
   */
  const FORBIDDEN = /font-size|line-height|letter-spacing|font-weight|padding|margin|gap/;
  for (const token of choiceTokens()) {
    for (const option of token.options) {
      for (const mode of ["light", "dark"]) {
        for (const property of Object.keys(option.family[mode])) {
          assert.ok(
            !FORBIDDEN.test(property),
            `${token.key}/${option.key} sets ${property} — a metric token needs the ` +
              "vibe-token migration behind it, not a switch in front of it",
          );
        }
      }
    }
  }
  /* And the floor itself is still a literal, in the file that owns it. */
  assert.match(
    await read("app/brand-overrides.css"),
    /:root :is\(input, select, textarea\)[^{]*\{\s*\n?\s*font-size: 16px;/,
    "the iOS zoom floor must remain a literal 16px",
  );
});

test("flattening keeps an edge, and rounding stays short of a pill", async () => {
  const depth = themeTokenDefinition("surface.depth");
  for (const option of depth.options) {
    for (const mode of ["light", "dark"]) {
      for (const [property, value] of Object.entries(option.family[mode])) {
        assert.ok(value !== "none" && value !== "0", `${property} must keep some edge`);
        assert.match(value, /^0 \d+px \d+px rgba\((\d+, ){3}0?\.\d+\)$/, `${property} shape`);
      }
    }
  }
  /* No focus ring reads the depth scale, so flattening cannot take a keyboard
     affordance with it. This is the assertion that keeps that true. */
  for (const file of ["app/globals.css", "app/brand-overrides.css"]) {
    const css = await read(file);
    for (const match of css.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
      if (!/:focus/.test(match[1])) continue;
      assert.ok(
        !/var\(--shadow-/.test(match[2]),
        `${file} draws a focus ring from the depth scale — flattening would dim it`,
      );
    }
  }

  const corners = themeTokenDefinition("shape.corners");
  for (const option of corners.options) {
    const largest = Math.max(
      ...Object.values(option.family.light).map((value) => Number.parseInt(value, 10)),
    );
    assert.ok(largest <= 24, `${option.key} rounds to ${largest}px — too close to a pill`);
  }
});

test("a choice token is never measured for contrast", () => {
  /*
   * A keyword has no luminance. Running one through the contrast check would
   * compare a name to a background and report nonsense — and reporting nonsense is
   * how a warning gets taught to be ignored.
   */
  assert.deepStrictEqual(
    themeContrastWarnings({
      "shape.corners": "sharp",
      "surface.depth": "flat",
    }),
    [],
  );
});

/* ================================================================== */
/* The wiring: one write path, one list, one control                   */
/* ================================================================== */

test("the choice tokens reach the surfaces they claim", async () => {
  /*
   * THE OVERVIEW'S CARDS READ THE CARD RUNG. Measured before `--radius-card`
   * existed: `sharp` corners changed 4 of the Overview's 816 visible elements,
   * because its cards and KPI tiles are drawn at 15px, which is none of the
   * scale's three rungs. They read the fourth rung now, and it ships at exactly
   * 15px, so nothing moves until a workspace chooses otherwise.
   */
  const overview = await read("app/(app)/portal/ops/oi-dash.css");
  for (const selector of [".oi-card", ".oi-kpi", ".ov-skeleton"]) {
    assert.match(
      overview,
      new RegExp(`\\.ov-dash\\.oi-dash \\${selector} \\{[^}]*border-radius: var\\(--radius-card\\);`),
      `${selector} must read the card rung`,
    );
  }
  assert.match(await read("app/globals.css"), /--radius-card: 15px;/, "the rung ships at the Overview's 15px");
  /*
   * The radius and depth scales are read widely enough to be worth offering, and
   * this is the assertion that keeps that true. It counts across every portal
   * stylesheet rather than the two big ones, because that is where the adoption
   * actually lives: 60 of the 242 radius references are in globals.css and
   * brand-overrides.css and the rest are in the per-component files.
   *
   * The thresholds are floors under the measurement in `theme-tokens.ts`, not the
   * measurement itself — a count pinned exactly would fail on every unrelated
   * stylesheet edit, and this test is about whether the control still reaches
   * anything, not about a number.
   */
  const portalCss = await portalStylesheets();
  const blob = (await Promise.all(portalCss.map((file) => read(file)))).join("");
  const uses = (needle) => blob.split(needle).length - 1;
  assert.ok(uses("var(--radius") >= 200, `the radius scale is adopted (${uses("var(--radius")})`);
  assert.ok(uses("var(--shadow-") >= 40, `the depth scale is adopted (${uses("var(--shadow-")})`);
});

test("one write path, capability-gated, audited and versioned — for every kind", async () => {
  const route = await read("app/api/theme/route.ts");
  const code = decommented(route);
  /* No second endpoint and no second writer: a choice goes through the same PUT,
     the same `settings.edit` check, the same audit row and the same §38 version as
     a colour. That is the whole reason this phase added a KIND rather than a
     parallel surface-settings route. */
  assert.equal(code.split("writeThemeOverride(").length - 1, 1, "one writer");
  assert.equal(code.split("validateThemeToken(").length - 1, 1, "one validator");
  assert.match(code, /requireCapability\(subject, "settings\.edit"\)/);
  assert.match(code, /recordAudit\(/);
  assert.match(code, /recordConfigVersion\(/);
  /* The options travel from the server, because that is the list the validator
     refuses anything outside. */
  assert.match(code, /token\.kind === "choice"/);
  assert.match(code, /\(token\.options \?\? \[\]\)\.map/);
});

test("the panel offers one list control and says what the surface style does not reach", async () => {
  const panel = await read("app/(app)/portal/views/brand-colours-panel.tsx");
  assert.match(panel, /token\.kind !== "colour" \? \(/, "one control for every kind with a list");
  assert.match(panel, /\(token\.choices \?\? \[\]\)\.map/, "the list comes from the server");
  assert.ok(
    !/type="text"/.test(decommented(panel)),
    "a free-text field would let somebody type a measurement into a theme",
  );
  /* The claim is a promise, so the boundary is on the screen — the same rule the
     chart and typeface phases followed. Matched against the copy with its line
     breaks collapsed, so re-wrapping a paragraph cannot fail a test about words. */
  const copy = panel.replace(/\s+/g, " ");
  assert.match(copy, /anything drawn deliberately round . avatars, status pills . stays round/);
  assert.match(copy, /Neither changes the size of anything you tap or type into\./);
  assert.match(copy, /General spacing is not configurable\./);
  assert.match(copy, /Brand colours, typeface and surface style/);
});

/* ================================================================== */
/* The live half                                                       */
/* ================================================================== */

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";
const OWNER = {
  email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com",
  password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026",
};
const serverUp = await (async () => {
  try {
    const response = await fetch(`${BASE_URL}/api/context`, { signal: AbortSignal.timeout(8000) });
    return response.status < 500;
  } catch {
    return false;
  }
})();

async function call(cookie, pathName, init = {}) {
  const response = await fetch(`${BASE_URL}${pathName}`, {
    ...init,
    headers: { "content-type": "application/json", cookie, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

test("live: a chosen corner style is stored, echoed, stamped and versioned", { skip: !serverUp }, async (t) => {
  const login = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(OWNER),
  });
  if (!login.ok) return t.skip("the seeded owner could not sign in");
  const cookie = (login.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");

  const before = await call(cookie, "/api/theme");
  assert.equal(before.status, 200, JSON.stringify(before.body));
  const asShipped = Object.fromEntries(
    before.body.tokens
      .filter((token) => token.kind === "choice")
      .map((token) => [token.key, token.isDefault ? null : token.value]),
  );

  try {
    const bad = await call(cookie, "/api/theme", {
      method: "PUT",
      body: JSON.stringify({ tokens: { "shape.corners": "8px" } }),
    });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.match(bad.body.error, /must be one of/);

    const saved = await call(cookie, "/api/theme", {
      method: "PUT",
      body: JSON.stringify({ tokens: { "shape.corners": "sharp" } }),
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const corners = saved.body.tokens.find((token) => token.key === "shape.corners");
    assert.equal(corners.value, "sharp");
    assert.equal(corners.isDefault, false);
    assert.ok(corners.choices.some((choice) => choice.key === "rounded"), "the list is served");

    /* The point of the whole phase: it reaches the document. The stamped element is
       server-rendered, so a fresh page request is the only honest way to check. */
    const page = await fetch(`${BASE_URL}/dashboard/jobs`, { headers: { cookie } });
    const html = await page.text();
    assert.match(html, /data-maintsupp-theme/, "the workspace's block must be stamped");
    assert.match(html, /--radius-sm:2px/, "and carry the chosen corner scale");
    assert.match(html, /--radius-card:4px/, "and the card rung moves with it");
    assert.ok(!html.includes(">sharp<"), "the key is never emitted as a value");

    const versions = await call(cookie, "/api/versions?subject=theme&key=tokens&limit=5");
    assert.equal(versions.status, 200, JSON.stringify(versions.body));
    assert.ok(versions.body.versions.length >= 1, "§38 recorded the change");
  } finally {
    /* Back to exactly what this workspace had: a reset for anything it had not
       chosen, and its own value for anything it had. */
    await call(cookie, "/api/theme", { method: "PUT", body: JSON.stringify({ tokens: asShipped }) });
  }
});
