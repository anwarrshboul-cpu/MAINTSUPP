/*
 * The landing page's four portal screenshots — v2.
 *
 * The Client portal section showed four drawn mock-ups: "Active units",
 * "Store #104 – Manchester", a 2025 date range, and a sidebar the product never
 * had. They were replaced with captures of the real portal supplied by the
 * owner, and every half of that job is pinned here:
 *
 *   - PROVENANCE: the `.png` beside each stem is the supplied file, by digest.
 *   - CACHE: new bytes live under new stems. `/assets/photos/*` is served
 *     `immutable`, so new content at an old URL is invisible to every returning
 *     visitor — and nothing may ask for the retired stems again.
 *   - SHAPE: the captures are 1672x941, which is exactly the box the stage and
 *     the component were built for, so nothing is stretched or cropped.
 *   - SHARPNESS: the stage is up to 1240 CSS px wide, and the component's
 *     default `sizes` (620px) made a 1x desktop fetch the 960 rung and upscale
 *     it. The portal passes its real width now.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const PHOTOS = path.join(root, "public/assets/photos");
const SECTIONS = path.join(root, "app/(marketing)/_sections");

/** Tab order, as the section renders it. */
const TABS = [
  ["overview", "dashboard-overview-v2"],
  ["jobs", "dashboard-jobs-v2"],
  ["compliance", "dashboard-compliance-v2"],
  ["spend", "dashboard-spend-v2"],
];
const RETIRED = ["dashboard-overview", "dashboard-jobs", "dashboard-compliance", "dashboard-spend"];
const SHAPE = [1672, 941];
const LADDER = [480, 960, 1600, 1672];

/** sha256 of each supplied capture, as copied into the repository. */
const SUPPLIED_SHA256 = {
  "dashboard-overview-v2": "54b5f48776c1246a1b19a89d13cd17b29eda668dfb82adb526e8f56e52605f42",
  "dashboard-jobs-v2": "2b2220b5c28a38dd62ccaaf7bf4774eb42dc96f6d1951459420f35777f3861d2",
  "dashboard-compliance-v2": "ede67de3643ab3739cc976ba7f2298f64e73b5f5197c8dead2cee1b912bd9d42",
  "dashboard-spend-v2": "97addc16a4b671ab3d5b13b2f84b7df9afd0262102ebb4b1f49a379a83bccdd7",
};

test("each portal tab shows its v2 capture, in tab order", async () => {
  const portal = await read("app/(marketing)/_sections/portal.tsx");
  const pairs = [...portal.matchAll(/view: "(\w+)",[\s\S]*?slot: "([\w-]+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(pairs, TABS);
});

test("nothing on the marketing site asks for a retired mock-up", async () => {
  const files = (await readdir(SECTIONS)).filter((file) => /\.tsx?$/.test(file));
  for (const file of files) {
    const source = await readFile(path.join(SECTIONS, file), "utf8");
    for (const stem of RETIRED) {
      /* A retired stem is only ever a prefix of its v2 successor, so the match
         is on the whole quoted name or the whole URL segment. */
      assert.ok(!source.includes(`"${stem}"`), `${file} still names ${stem}`);
      assert.ok(
        !new RegExp(`/assets/photos/${stem}[-.](?!v2)`).test(source),
        `${file} still addresses ${stem}'s files`,
      );
    }
  }

  /* And the files are gone, so a stale reference would fall back to the
     artwork rather than quietly bring the mock-up back. */
  const onDisk = await readdir(PHOTOS);
  for (const stem of RETIRED) {
    const own = new RegExp(`^${stem}(?:-\\d+)?\\.(?:jpg|png|avif|webp)$`);
    assert.deepEqual(onDisk.filter((name) => own.test(name)), [], `${stem} files remain on disk`);
  }
});

test("the supplied captures are on disk byte for byte, at the stage's own shape", async () => {
  for (const [stem, expected] of Object.entries(SUPPLIED_SHA256)) {
    const bytes = await readFile(path.join(PHOTOS, `${stem}.png`));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      expected,
      `${stem}.png is not the supplied file — new bytes need a new stem, not a new hash under this one`,
    );
    /* PNG IHDR: width and height are big-endian at bytes 16 and 20. */
    assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], SHAPE, `${stem}.png shape`);
  }

  /* The component draws its fallback at this shape and the stage reserves this
     box. All three agreeing is what "no stretching, no cropping" means. */
  const portal = await read("app/(marketing)/_sections/portal.tsx");
  assert.match(portal, new RegExp(`w=\\{${SHAPE[0]}\\}`));
  assert.match(portal, new RegExp(`h=\\{${SHAPE[1]}\\}`));
  const css = await read("app/(marketing)/marketing.css");
  assert.match(css, new RegExp(`\\.dashshot__stage\\{[^}]*aspect-ratio:${SHAPE[0]}/${SHAPE[1]}`));
});

test("every capture ships a full ladder topped by its own width", async () => {
  const manifest = await read("app/(marketing)/_sections/photo-widths.ts");
  const parsed = JSON.parse(manifest.slice(manifest.indexOf("{"), manifest.lastIndexOf("}") + 1));
  const files = await readdir(PHOTOS);

  for (const [, stem] of TABS) {
    assert.deepEqual(parsed[stem], LADDER, `${stem} ladder`);
    assert.ok(files.includes(`${stem}.jpg`), `${stem}.jpg is the <img src> fallback`);
    for (const width of LADDER) {
      for (const ext of ["avif", "webp"]) {
        assert.ok(files.includes(`${stem}-${width}.${ext}`), `${stem}-${width}.${ext} is missing`);
      }
    }
  }
  for (const stem of RETIRED) {
    assert.equal(parsed[stem], undefined, `the manifest still lists ${stem}`);
  }
});

test("the portal tells the browser how wide the stage really is", async () => {
  const portal = await read("app/(marketing)/_sections/portal.tsx");
  const hint = portal.match(/sizes="([^"]+)"/);
  assert.ok(hint, "without a sizes hint PhotoSlot's 620px default applies and a 1x desktop upscales the 960 rung");
  /* `.wrap` is 1320 wide with 40px padding a side, so the stage tops out at 1240. */
  assert.match(hint[1], /\(min-width: 1320px\) 1240px/);
  assert.doesNotMatch(hint[1], /620px/);

  const css = await read("app/(marketing)/marketing.css");
  assert.match(css, /--wrap:1320px/, "the sizes hint is derived from this width");
  assert.match(css, /\.wrap\{[^}]*padding-inline:clamp\(20px,4vw,40px\)/, "and from this padding");
});

test("each tab describes its own screen, and says the data is sample data", async () => {
  const portal = await read("app/(marketing)/_sections/portal.tsx");
  const alts = [...portal.matchAll(/^\s{4}alt: "([^"]+)"/gm)].map((m) => m[1]);
  assert.equal(alts.length, TABS.length);
  assert.equal(new Set(alts).size, alts.length, "four tabs, four different descriptions");
  for (const alt of alts) {
    assert.match(alt, /\bsample\b/, `"${alt}" should say the figures are sample data`);
  }

  const registry = await read("app/(marketing)/_sections/photo-slot.tsx");
  for (const [, stem] of TABS) {
    assert.match(registry, new RegExp(`"${stem}":`), `${stem} needs a registry entry behind the tab's own alt`);
  }
});
