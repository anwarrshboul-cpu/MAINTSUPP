import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const PHOTOS = path.join(root, "public/assets/photos");

test("modern formats exist at every width", async () => {
  const files = await readdir(PHOTOS);
  const jpgs = files.filter((f) => f.endsWith(".jpg"));
  /*
   * Twenty photographs, down from thirty-nine.
   *
   * The rebuild removed the sections that carried the other nineteen — the
   * sector tiles, the testimonial portraits, the trades detail panel and the
   * four service tab photographs — and their files went with them. The floor is
   * what the ten sections actually use, so deleting a photograph that IS in use
   * still fails here.
   */
  assert.ok(jpgs.length >= 20, `expected the page's photographs; found ${jpgs.length}`);

  // 480 is generated for every source. Larger widths only exist where the
  // original is big enough — sources are never upscaled.
  for (const ext of ["avif", "webp"]) {
    const smallest = files.filter((f) => f.endsWith(`-480.${ext}`)).length;
    assert.equal(
      smallest,
      jpgs.length - 0,
      `every photograph needs a 480px ${ext}; found ${smallest} of ${jpgs.length}`,
    );
  }
});

test("the mobile payload is materially smaller than the originals", async () => {
  const files = await readdir(PHOTOS);
  const sum = async (filter) => {
    let total = 0;
    for (const file of files.filter(filter)) {
      total += (await stat(path.join(PHOTOS, file))).size;
    }
    return total;
  };

  const jpg = await sum((f) => f.endsWith(".jpg"));
  const mobileAvif = await sum((f) => f.endsWith("-480.avif"));

  assert.ok(
    mobileAvif < jpg * 0.35,
    `a phone should download well under a third of the JPG weight — got ${(mobileAvif / jpg * 100).toFixed(0)}%`,
  );
});

test("every photograph carries alt text", async () => {
  const source = await read("app/(marketing)/_sections/photo-slot.tsx");
  const files = await readdir(PHOTOS);
  const stems = files
    .filter((f) => f.endsWith(".jpg"))
    .map((f) => f.replace(/\.jpg$/, ""))
    // Not rendered on the page: the OG card, which is kept because it is a
    // social-sharing asset rather than a section's photograph, and is simply
    // not wired into the metadata yet.
    .filter((stem) => stem !== "social-card");

  for (const stem of stems) {
    assert.match(
      source,
      new RegExp(`"${stem}":`),
      `${stem} has no alt text — the old loader used CSS backgrounds and carried none at all`,
    );
  }
});

test("alt text describes the image rather than repeating the heading", async () => {
  const source = await read("app/(marketing)/_sections/photo-slot.tsx");
  const entries = [...source.matchAll(/"([\w-]+)":\s*\n?\s*"([^"]+)"/g)];
  assert.ok(entries.length >= 19, `expected alt text for every slot; found ${entries.length}`);
  for (const [, key, value] of entries) {
    assert.ok(value.length > 12, `alt for ${key} is too short to be useful: "${value}"`);
    assert.ok(
      !/^(image|photo|picture) of/i.test(value),
      `alt for ${key} should not start with "image of"`,
    );
  }
});

test("layout shift is prevented", async () => {
  const source = await read("app/(marketing)/_sections/photo.tsx");
  assert.match(source, /width=\{1600\}/, "explicit dimensions are required");
  assert.match(source, /height=\{1000\}/);
  // The slot reserves its own box via the `.ph` aspect rules, and the artwork
  // fills it from the first paint, so nothing reflows when the photo arrives.
  const css = await read("app/(marketing)/marketing.css");
  assert.match(css, /\.ph\{[^}]*position:relative/, "the slot must establish its own box");
});

test("the loader's original guarantees are preserved", async () => {
  const source = await read("app/(marketing)/_sections/photo.tsx");

  // Never a broken image box: generated artwork sits underneath and stays if
  // the photograph never arrives.
  assert.match(source, /className="ph__art"/, "the artwork fallback must render");
  assert.match(source, /setFailed\(true\)/, "a permanent failure must fall back, not break");
  assert.match(
    source,
    /!\(failed && attempt >= 2\)/,
    "after the last attempt the <img> must be dropped so the artwork shows through",
  );

  // Retries with backoff.
  assert.match(source, /attempt >= 2/, "three attempts, as before");
  assert.match(source, /next \* 800/, "backoff between attempts");

  // Lazy by default, eager only where asked.
  assert.match(source, /loading=\{priority \? "eager" : "lazy"\}/);
});

test("every slot resolves alt text even when the caller omits it", async () => {
  const source = await read("app/(marketing)/_sections/photo.tsx");
  assert.match(
    source,
    /alt=\{alt \?\? altFor\(slot\)\}/,
    "a caller that forgets alt must fall back to the registry, not render an empty string",
  );
});

test("srcset only advertises widths that exist", async () => {
  const source = await read("app/(marketing)/_sections/photo.tsx");
  assert.match(source, /photoWidths\[slot\]/, "widths must come from the generated manifest");

  const manifest = await read("app/(marketing)/_sections/photo-widths.ts");
  const files = await readdir(PHOTOS);
  const parsed = JSON.parse(manifest.slice(manifest.indexOf("{"), manifest.lastIndexOf("}") + 1));
  for (const [stem, widths] of Object.entries(parsed)) {
    for (const width of widths) {
      assert.ok(
        files.includes(`${stem}-${width}.avif`),
        `manifest claims ${stem}-${width}.avif but it does not exist`,
      );
    }
  }
});

test("modern formats are offered before the JPG fallback", async () => {
  const source = await read("app/(marketing)/_sections/photo.tsx");
  const avifAt = source.indexOf('type="image/avif"');
  const webpAt = source.indexOf('type="image/webp"');
  const jpgAt = source.indexOf("}.jpg`");
  assert.ok(avifAt > 0 && webpAt > avifAt, "AVIF must be offered before WebP");
  assert.ok(jpgAt > webpAt, "the JPG is the last resort, not the first choice");
  assert.match(source, /sizes=\{sizes\}/, "a sizes hint is needed or the browser guesses wrong");
});

/**
 * Both checks below scan every section file rather than one of them.
 *
 * They used to read `sections.tsx` alone, which was true when it held all nine
 * sections. The page has since been split across a file per section, so a
 * single-file read would pass while a second eager image sat in a sibling —
 * exactly the regression the second test exists to catch.
 */
const sectionSources = async () => {
  const dir = path.join(root, "app/(marketing)/_sections");
  const files = (await readdir(dir)).filter(
    (file) => file.endsWith(".tsx") && file !== "photo.tsx",
  );
  return Promise.all(
    files.map(async (file) => ({
      file,
      source: await readFile(path.join(dir, file), "utf8"),
    })),
  );
};

test("photographs appear across the page, not just the hero", async () => {
  const sources = await sectionSources();
  const count = sources.reduce(
    (total, { source }) =>
      total +
      (source.match(/<PhotoSlot/g) ?? []).length +
      (source.match(/<ApprovedPhoto/g) ?? []).length,
    0,
  );
  /*
   * Five `<PhotoSlot>` call sites, not six.
   *
   * The count fell because two whole photo grids were deleted, not because a
   * photograph was dropped from a section that still wants one. What matters is
   * the SPREAD, so that is what is checked properly below: the brief names five
   * places a photograph must appear, and each is named here rather than being
   * summed into a number that a single section could satisfy on its own.
   */
  assert.ok(count >= 5, `expected photographs across the page, found ${count}`);

  /*
   * `workflow.tsx` left this list when the approved v3 pack supplied real
   * photographs for all seven stages: it renders `<ApprovedPhoto>` now, which
   * addresses a file by the site path the pack's README gives it and has
   * nothing to fall back to, because there is nothing missing to fall back
   * from. `who-we-help.tsx` joined for the same reason.
   *
   * So the check is "a photograph, by whichever of the two mechanisms suits the
   * section", not "a PhotoSlot" — otherwise adopting the approved pack would
   * read as losing an image.
   */
  const withPhotos = sources
    .filter(({ source }) => source.includes("<PhotoSlot") || source.includes("<ApprovedPhoto"))
    .map(({ file }) => file)
    .sort();
  assert.deepEqual(
    withPhotos,
    [
      "case-study.tsx",
      "hero.tsx",
      "portal.tsx",
      "services.tsx",
      "who-we-help.tsx",
      "workflow.tsx",
    ],
    "hero, trade strip, carousel, case study, dashboard, and the two sections the v3 pack supplies",
  );
});

test("only the hero loads eagerly", async () => {
  const sources = await sectionSources();
  const eager = sources.flatMap(({ file, source }) =>
    (source.match(/^\s*priority$/gm) ?? []).map(() => file),
  );
  assert.deepEqual(
    eager,
    ["hero.tsx"],
    `exactly one image should be eager and it must be the hero — more and the first paint gets slower, not faster. Found: ${eager.join(", ") || "none"}`,
  );
});

test("a slot with no photograph asks for none", async () => {
  /*
   * THE BUG THIS REPLACES. `photo-widths.ts` is generated from the files that
   * are actually on disk, and it is the authority on which slots have a
   * photograph — its own note explains that advertising a width which is not
   * there makes the browser fetch a file that does not exist. The base
   * `<img src>` sat outside that reasoning and was rendered unconditionally.
   *
   * `trade-glazing` and `trade-drainage` had no photograph at the time, so
   * every visit to the home page fetched two missing JPEGs, failed, and retried
   * each of them twice more on a backoff: six 404s per page load, in the
   * visitor's network panel and in the server log, for images nobody was
   * waiting on.
   *
   * Both are supplied now, which does not retire the rule — it is what decides
   * that their photographs ARE requested. The invariant asserted below is the
   * one that matters either way: the manifest is exactly the set of base files
   * on disk, so a slot asks for a photograph precisely when it has one.
   */
  const source = await readFile(
    new URL("../app/(marketing)/_sections/photo.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /const hasPhotograph = widths\.length > 0;/);
  assert.match(
    source,
    /\{hasPhotograph && !\(failed && attempt >= 2\) && \(/,
    "the whole <picture> is skipped, not just the <source> elements",
  );

  const manifest = await readFile(
    new URL("../app/(marketing)/_sections/photo-widths.ts", import.meta.url),
    "utf8",
  );
  const named = new Set([...manifest.matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]));
  const files = (await readdir(new URL("../public/assets/photos", import.meta.url)))
    .filter((f) => /^[^.]+\.jpg$/.test(f))
    .map((f) => f.replace(".jpg", ""));
  assert.deepEqual(
    [...named].sort(),
    files.sort(),
    "the manifest must stay exactly the set of photographs on disk — it is what decides whether a request is made at all",
  );

  /*
   * All eight trade tiles now have a photograph — glazing and drainage were the
   * last two without one, and they were supplied in the approved pack. So the
   * assertion flipped: it used to require those two to request nothing, and now
   * requires every tile to have a picture to request.
   */
  const services = await readFile(
    new URL("../app/(marketing)/_sections/services.tsx", import.meta.url),
    "utf8",
  );
  const slots = [...services.matchAll(/slot: "(trade-[a-z]+)"/g)].map((match) => match[1]);
  assert.equal(slots.length, 8, "the eight faults in the trade strip");
  for (const slot of slots) {
    assert.ok(named.has(slot), `${slot} is a trade tile with no photograph on disk`);
  }
});

/* ============================================== hero: two plates, one hero
 *
 * The hero photograph was replaced with the owner-approved 1916x821 file, and
 * both halves of that job are pinned here: the CACHE half, because this repo
 * has already shipped new bytes at old `immutable` URLs once and served the
 * stale ones for a year; and the CROP half, because the treatment that got
 * replaced looked correct in the source and ate 80% of the picture in the
 * browser, which is a failure no reading of the CSS would have caught.
 *
 * A SECOND PLATE HAS SINCE JOINED IT, AND IT IS ART DIRECTION, NOT RESIZING.
 * 2.33:1 has no framing that survives a 0.47:1 screen: the phone treatment
 * that shipped alongside the desktop one pushed the band to 60% of the hero's
 * HEIGHT and let `object-position` choose which third of the WIDTH to keep, so
 * the plant panel, the second engineer, St Paul's, the London Eye and the
 * access platform were all gone below 620px. That was a workaround for a plate
 * of the wrong shape, and the owner supplied a portrait plate instead —
 * 941x1452 — so the workaround is gone rather than tuned, and what replaced it
 * is pinned below: one `<picture media>` switch, one `--hero-band` value, and
 * nothing cropped on either side of the breakpoint.
 */

const HERO_SLOT = "hero-maintenance-v4";
const HERO_MOBILE_SLOT = "hero-maintenance-mobile-v5";
const HERO_RETIRED = "hero-london-maintenance";
/** The approved source's own pixels. Every number below is derived from these. */
const HERO_W = 1916;
const HERO_H = 821;
/** The approved PORTRAIT source's own pixels, likewise. */
const HERO_M_W = 941;
const HERO_M_H = 1452;
/**
 * The breakpoint, written once.
 *
 * It is a cross-file invariant, not a preference: the stylesheet frames one
 * plate and the `<picture media>` fetches the other, and if the two numbers
 * ever drift the browser is showing a picture the CSS is not describing. Both
 * are checked against this constant rather than against each other, so the
 * failure names the number instead of leaving two files to be compared.
 */
const HERO_BREAKPOINT = 620;

/**
 * sha256 of each approved original, as it sits in the repository.
 *
 * The `.png` beside each plate is a byte-identical copy of the file the owner
 * supplied — that is its entire job, and a digest is the only way to keep the
 * claim true. It also nails down the other half of the cache rule: these paths
 * are served `immutable`, so replacing the CONTENT under either stem is the
 * exact mistake this repo has already made once. A re-shoot gets a new stem and
 * a new digest here; it does not get to reuse an old URL.
 */
const APPROVED_SHA256 = {
  [HERO_SLOT]: "48711bfbabb08d011371aabd8ca396f67ad2fc60e14a57138757d4a4ad494d2f",
  [HERO_MOBILE_SLOT]: "048e133b90c459c51536c4cd40c4499a5303fea015504dc8b4b48370ecc078d4",
};

test("the hero photograph is the versioned file, and the retired one is asked for by nobody", async () => {
  const hero = await read("app/(marketing)/_sections/hero.tsx");
  assert.match(hero, new RegExp(`slot="${HERO_SLOT}"`), "the hero renders the versioned slot");

  /*
   * THE CACHE TRAP. `/assets/photos/*` is served
   * `Cache-Control: public, max-age=31536000, immutable`. `immutable` tells a
   * browser never to revalidate, so replacing the CONTENT of a variant at its
   * existing PATH serves the old bytes to every returning visitor and a hard
   * refresh does not reliably defeat it. The stem carries the version for that
   * reason, and every derived URL inherits it. A re-shoot needs a new suffix,
   * not a quiet overwrite of these files — which is what this asserts: no
   * section may reference the retired stem, so not one of its URLs is ever
   * requested, and its bytes on disk are free to stay exactly as they are.
   */
  const sources = await sectionSources();
  const stillAsking = sources
    .filter(
      ({ source }) =>
        source.includes(`slot="${HERO_RETIRED}"`) ||
        source.includes(`/assets/photos/${HERO_RETIRED}`),
    )
    .map(({ file }) => file);
  assert.deepEqual(stillAsking, [], `${HERO_RETIRED} is retired — nothing may request its URLs`);
  /* Naming it in a comment or keeping its alt-text entry is fine and wanted:
     the registry is the guarantee that no slot reaches the page undescribed,
     and an entry costs nothing. Rendering it is what is forbidden. */

  /*
   * `sizes` is not decoration on a full-bleed background. PhotoSlot's default
   * hint is written for the section tiles — `(min-width: 1024px) 620px` — and
   * under it the browser picked a variant about a third of the width the hero
   * actually paints and upscaled it across the fold.
   */
  assert.match(hero, /sizes="100vw"/, "the hero paints at the full viewport width, so say so");
  assert.match(hero, new RegExp(`w=\\{${HERO_W}\\}`), "the artwork is drawn at the photograph's own shape");
  assert.match(hero, new RegExp(`h=\\{${HERO_H}\\}`));
});

test("the phone gets a different photograph, chosen by the browser and not by JavaScript", async () => {
  const hero = await read("app/(marketing)/_sections/hero.tsx");

  /*
   * ART DIRECTION IS A `media` ATTRIBUTE, AND NOTHING ELSE WILL DO.
   *
   * `srcset`/`sizes` answers "how many pixels of this picture" and cannot help
   * a plate whose SHAPE is wrong for the screen — which is the whole problem
   * on a phone. `<source media>` answers "which picture", the browser resolves
   * it before it opens a socket, and exactly one of the two files is fetched.
   *
   * The two alternatives are both worse and both are ruled out here. A second
   * <Hero> behind a viewport check duplicates the copy, the CTAs and the
   * proof points, so they drift; and any JS width test runs after the browser
   * has already started downloading the wrong picture, which is the download
   * this exists to prevent.
   */
  assert.match(
    hero,
    new RegExp(`narrow=\\{\\{\\s*slot: "${HERO_MOBILE_SLOT}",\\s*media: "\\(max-width: ${HERO_BREAKPOINT}px\\)"`),
    "the hero hands the phone plate to <picture> behind a media query",
  );
  assert.doesNotMatch(
    hero,
    /matchMedia\(\s*["'`]\(max-width|innerWidth|useMediaQuery/,
    "the plate must be picked by the browser's own source selection, not by measuring the viewport in JS",
  );

  const heroSlotCount = (hero.match(/<PhotoSlot/g) ?? []).length;
  assert.equal(heroSlotCount, 1, "one hero, one slot — a second component is a second copy of the copy");

  const photo = await read("app/(marketing)/_sections/photo.tsx");

  /*
   * ORDER IS THE MECHANISM. A browser walks the `<source>` list once and stops
   * at the first entry whose `media` matches and whose `type` it can decode.
   * So the media-gated plate has to come FIRST or it can never win: put it
   * after the unconditional AVIF and every phone downloads the desktop file.
   */
  const gated = photo.indexOf("media={narrow.media}");
  const ungated = photo.indexOf('<source type="image/avif" srcSet={srcSet("avif")}');
  assert.ok(gated > 0, "photo.tsx must emit a media-gated <source>");
  assert.ok(ungated > 0, "photo.tsx must still emit the unconditional wide <source>");
  assert.ok(
    gated < ungated,
    "the media-gated plate must precede the unconditional one, or the browser never reaches it",
  );

  /*
   * NEITHER PLATE MAY BE ADVERTISED TO THE OTHER'S WIDTHS. Each `<source>`
   * builds its srcset from ITS OWN stem's manifest entry — a shared ladder
   * would put desktop rungs in the phone's srcset, and a phone on a wide DPR
   * would fetch a 1916px file the media query was supposed to have excluded.
   */
  assert.match(
    photo,
    /srcSet=\{ladder\(narrow\.slot, "avif"\)\}/,
    "the narrow <source> must advertise the narrow stem's widths",
  );
  assert.match(
    photo,
    /srcSet=\{ladder\(narrow\.slot, "webp"\)\}/,
  );
  assert.match(
    photo,
    /const srcSet = \(ext: "avif" \| "webp"\) => ladder\(slot, ext\);/,
    "and the wide <source> must advertise the wide stem's",
  );

  /* A stem with no manifest entry has no files on disk either — the same rule
     the wide plate has always been under, applied to the narrow one. */
  assert.match(photo, /const narrowWidths = narrow \? photoWidths\[narrow\.slot\] \?\? \[\] : \[\];/);
  assert.match(photo, /const hasNarrow = narrowWidths\.length > 0;/);
  assert.match(
    photo,
    /\{narrow && hasNarrow && \(/,
    "no manifest entry, no <source> — advertising a file that is not there is a 404 per visit",
  );

  /* And the prop is optional, so every other caller renders exactly what it
     always did. Five call sites, one of them the hero. */
  const sources = await sectionSources();
  const withNarrow = sources.filter(({ source }) => source.includes("narrow={{")).map(({ file }) => file);
  assert.deepEqual(withNarrow, ["hero.tsx"], "only the hero is art-directed; the rest are untouched");
});

test("both approved originals are on disk byte for byte, under stems nobody has fetched before", async () => {
  /*
   * Provenance and the cache rule are the same assertion from two sides. The
   * digest proves the `.png` is the file the owner approved; the stem proves
   * no returning visitor is holding different bytes at the same URL under
   * `Cache-Control: immutable`. Change the picture and BOTH have to change.
   */
  for (const [stem, expected] of Object.entries(APPROVED_SHA256)) {
    const bytes = await readFile(path.join(PHOTOS, `${stem}.png`));
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.equal(
      digest,
      expected,
      `${stem}.png is not the approved file — new bytes need a new stem, not a new hash under the old one`,
    );

    /* PNG IHDR: width and height are big-endian at bytes 16 and 20. Read from
       the file rather than trusted from a note, so a re-crop cannot slip in. */
    const [w, h] = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    const shape = stem === HERO_SLOT ? [HERO_W, HERO_H] : [HERO_M_W, HERO_M_H];
    assert.deepEqual([w, h], shape, `${stem}.png is ${w}x${h}, not the approved ${shape.join("x")}`);
  }

  /* Landscape and portrait — which is the reason there are two of them at all.
     If a future edit points the phone at a plate wider than it is tall, the
     crop problem is back and this is where it shows up. */
  assert.ok(HERO_W / HERO_H > 2, "the wide plate is a landscape band");
  assert.ok(HERO_M_W / HERO_M_H < 1, "the phone plate is portrait, or it cannot fill a portrait screen");
});

test("the phone plate ships a phone ladder, and no desktop rung is in it", async () => {
  const files = await readdir(PHOTOS);
  assert.ok(files.includes(`${HERO_MOBILE_SLOT}.png`), "the approved original, byte for byte");
  assert.ok(files.includes(`${HERO_MOBILE_SLOT}.jpg`), "the base the <img src> falls back to");

  const manifest = await read("app/(marketing)/_sections/photo-widths.ts");
  const entry = manifest.match(new RegExp(`"${HERO_MOBILE_SLOT}": \\[([^\\]]*)\\]`));
  assert.ok(entry, `${HERO_MOBILE_SLOT} must be in the generated manifest`);
  const widths = entry[1].split(",").map((n) => Number(n.trim())).filter(Boolean);
  assert.deepEqual(widths, [480, 720, HERO_M_W], "480 and 720 plus the source's own width");

  for (const width of widths) {
    for (const ext of ["avif", "webp"]) {
      assert.ok(
        files.includes(`${HERO_MOBILE_SLOT}-${width}.${ext}`),
        `${HERO_MOBILE_SLOT}-${width}.${ext} is missing`,
      );
    }
  }

  /*
   * THE LADDER IS THE OTHER HALF OF "NEITHER PLATE IS ADVERTISED TO THE
   * OTHER'S WIDTHS". This file is only ever fetched below 620px, where the
   * widest realistic request is a 430px viewport at DPR 3 = 1290 device px —
   * and the source is 941, so 941 is the cap. A 1600 or 1916 rung here would
   * be an upscale of a phone plate shipped to a phone: the single heaviest
   * mistake available on this page.
   */
  assert.equal(Math.max(...widths), HERO_M_W, "the top rung is the source's own width, never an upscale");
  const wide = (manifest.match(new RegExp(`"${HERO_SLOT}": \\[([^\\]]*)\\]`)))[1]
    .split(",").map((n) => Number(n.trim())).filter(Boolean);
  assert.ok(
    Math.max(...wide) > Math.max(...widths),
    "the desktop plate still carries the wide rungs; the phone one must not",
  );
  for (const width of widths) {
    assert.ok(width <= 1024, `${width}px is a desktop rung on a plate only phones can receive`);
  }

  /* Different stems, therefore disjoint URLs — which is what makes "one plate
     per visit" true at the network layer rather than only in the markup. */
  const urls = (stem, ws) => ws.flatMap((w) => [`${stem}-${w}.avif`, `${stem}-${w}.webp`]);
  const shared = urls(HERO_SLOT, wide).filter((u) => urls(HERO_MOBILE_SLOT, widths).includes(u));
  assert.deepEqual(shared, [], "the two plates may not share a single derived URL");
});

test("the hero photograph ships an original that matches the approved file, and a full ladder", async () => {
  const files = await readdir(PHOTOS);

  /* The byte-identical provenance copy: what shipped can be proved to be what
     was approved. The `.jpg` beside it is the last-resort `<img src>` the
     component addresses and the base the manifest invariant counts. */
  assert.ok(files.includes(`${HERO_SLOT}.png`), "the approved original, byte for byte");
  assert.ok(files.includes(`${HERO_SLOT}.jpg`), "the base the <img src> falls back to");

  const manifest = await read("app/(marketing)/_sections/photo-widths.ts");
  const entry = manifest.match(new RegExp(`"${HERO_SLOT}": \\[([^\\]]*)\\]`));
  assert.ok(entry, `${HERO_SLOT} must be in the generated manifest`);
  const widths = entry[1].split(",").map((n) => Number(n.trim())).filter(Boolean);
  assert.deepEqual(widths, [480, 960, 1600, HERO_W], "480/960/1600 plus the source's own width");

  /*
   * The top rung is the source's own width, not 1600. The `<source>` elements
   * beat the `<img src>` in every browser that understands AVIF or WebP, so
   * the full-size original behind them is unreachable — and at a 1440px
   * viewport this hero paints the picture about 1633 CSS px wide, which makes
   * a 1600 rung an upscale of the widest thing on the page.
   */
  for (const width of widths) {
    for (const ext of ["avif", "webp"]) {
      assert.ok(files.includes(`${HERO_SLOT}-${width}.${ext}`), `${HERO_SLOT}-${width}.${ext} is missing`);
    }
  }
});

test("the hero crop is a band, and no edit can quietly go back to eating the picture", async () => {
  const css = (await read("app/(marketing)/marketing.css")).replace(/\r\n/g, "\n");

  /*
   * WHAT WENT WRONG BEFORE, IN NUMBERS. The photograph is 2.33:1 and the hero
   * is 889px tall at 1440 and 977px at 320. `object-fit:cover` on a box that
   * shape scales the picture by its HEIGHT and pushes the width out over both
   * sides — measured in the browser: 69.4% of the width survived at 1440,
   * 42.5% at 768, 20.0% at 390 and 14.0% at 320, with the engineers cut off
   * one edge and the access platform off the other at every width.
   *
   * The fix gives the picture a box of its own shape, bottom-anchored, so
   * nothing is cropped. `--hero-band` is the whole treatment in one number and
   * the arithmetic is exact: a band of ratio 1916/N shows 821/N of the width.
   * The assertions below are that arithmetic, not a copy of the stylesheet.
   */
  const bandRatio = (block) => {
    const found = block.match(/--hero-band:\s*(\d+)\s*\/\s*(\d+)/);
    assert.ok(found, "--hero-band must be declared");
    return { w: Number(found[1]), h: Number(found[2]) };
  };
  /** The share of the picture's width a band of this ratio leaves visible. */
  const visible = ({ h }) => HERO_H / h;

  const base = bandRatio(css.slice(css.indexOf(".hero{--hero-band")));
  assert.equal(base.w, HERO_W);
  assert.equal(base.h, HERO_H, "at any other height the wide layouts start cropping again");
  assert.equal(visible(base), 1, "desktop and tablet show the whole frame");

  /* The band box: the picture's shape, pinned to the foot of the hero, and the
     artwork fallback given the identical box so a failed photograph degrades
     to the same shape rather than to a rectangle in the middle of the fold. */
  const band = css.match(
    /\.hero__media \.ph > picture,\s*\n\.hero__media \.ph > \.ph__art\{([^}]*)\}/,
  );
  assert.ok(band, "the band rule must cover both the <picture> and the artwork");
  assert.match(band[1], /top:auto/);
  assert.match(band[1], /bottom:0/);
  assert.match(band[1], /height:auto/);
  assert.match(band[1], /aspect-ratio:var\(--hero-band\)/);

  /*
   * `background-position` on an `<img>` does nothing at all. The rule this
   * replaced set it and carried a comment claiming it held the framing on
   * every width; the property it named could not move the picture by a pixel,
   * and the framing it claimed to hold was never held.
   */
  assert.doesNotMatch(
    css,
    /\.hero[^{\n]*\.ph__img\{[^}]*background-position/,
    "an <img> ignores background-position — the framing lever is object-position",
  );
  assert.match(css, /\.hero \.ph__img\{[^}]*object-position:25% bottom/);

  /*
   * PHONES, WHERE THERE IS NOTHING LEFT TO WORK AROUND.
   *
   * The rule that used to sit here was a workaround and it is asserted GONE,
   * not tuned. It pushed the band to 60% of the HERO'S height with
   * `aspect-ratio:auto`, which made `cover` scale by height again and let
   * `object-position:25% bottom` pick which third of the WIDTH to keep — the
   * plant panel, the second engineer, St Paul's, the London Eye and the access
   * platform were all outside the frame below 620px, on the shipped build.
   *
   * The phone gets its own portrait plate now, so the same band rule above
   * does the whole job with one number changed. The arithmetic is the same
   * arithmetic: a band of the plate's OWN ratio is the tallest box that still
   * shows all of it, because cover makes the axes reciprocal — taller and the
   * width goes; shorter and the height goes. So `visible === 1` is asserted on
   * BOTH sides of the breakpoint, and it is the same assertion, not a weaker
   * one for the small screens.
   */
  /* The block is found by what it CONTAINS, not by where it sits: another
     section may open a 620px query above this one at any time. */
  const phoneBlocks = [...css.matchAll(
    new RegExp(`@media\\s*\\(max-width:\\s*${HERO_BREAKPOINT}px\\)\\s*\\{([\\s\\S]*?)\\n\\}`, "g"),
  )]
    .map((match) => match[1])
    .filter((body) => body.includes("--hero-band"));
  assert.equal(phoneBlocks.length, 1, "exactly one phone block may own the hero band");
  const [phoneBlock] = phoneBlocks;

  /* The phone band is the phone plate's own pixels, so nothing is cropped
     there either — measured in the browser at 430/390/375/360/320: the panel,
     both engineers, the rooftop, the skyline, St Paul's, the London Eye and
     the boom lift are all in frame at every one of them. */
  const phone = bandRatio(phoneBlock);
  assert.equal(phone.w, HERO_M_W, "the phone band must be the phone plate's own width");
  assert.equal(phone.h, HERO_M_H, "…and its own height, or cover starts cropping again");
  assert.equal(HERO_M_H / phone.h, 1, "a phone shows the whole frame, exactly as a desktop does");
  assert.ok(
    phone.h > phone.w,
    "the phone band must be portrait — a landscape band on a portrait screen is the bug this replaced",
  );

  /*
   * THE WORKAROUND, BY NAME, SO IT CANNOT COME BACK QUIETLY. Each of these
   * would restore height-driven cover on a phone, and with it the crop.
   */
  assert.doesNotMatch(
    phoneBlock,
    /aspect-ratio:\s*auto/,
    "the phone band must be driven by the ratio, not released from it",
  );
  assert.doesNotMatch(
    phoneBlock,
    /height:\s*\d+%/,
    "a share-of-the-hero band is the old workaround — the plate's own ratio is the treatment now",
  );
  assert.doesNotMatch(
    phoneBlock,
    /\.hero__media \.ph > picture/,
    "the phone must reuse the band rule above, not redeclare one — a second layout is how the two drift",
  );

  /* The base band rule is what the phone block leans on, so it has to survive
     above the breakpoint AND be the thing still doing the work below it. */
  assert.match(band[1], /aspect-ratio:var\(--hero-band\)/, "one rule, parameterised, on both sides");
  assert.match(band[1], /mask-image:linear-gradient/, "faded at the top into the painted sky");
  assert.match(
    css.slice(css.indexOf(".hero{--hero-band")),
    /^\.hero\{--hero-band:1916\/821\}/,
    "the desktop band is declared outside any query, so it is what every width above 620 gets",
  );

  /* `object-position` is the framing lever and it is inert at a band of the
     plate's own ratio — there is nothing to crop. It stays declared because it
     is the only lever that works if `--hero-band` is ever made taller than the
     plate, and because an `<img>` ignores the `background-position` that used
     to be written here. */
  assert.match(css, /\.hero \.ph__img\{[^}]*object-position:25% bottom/);

  /*
   * THE CROSS-FILE INVARIANT. The stylesheet frames one plate and `<picture>`
   * fetches the other; if the breakpoints drift the browser is showing a
   * picture the CSS is not describing, and nothing else in this suite would
   * notice.
   */
  const hero = await read("app/(marketing)/_sections/hero.tsx");
  assert.match(
    hero,
    new RegExp(`media: "\\(max-width: ${HERO_BREAKPOINT}px\\)"`),
    `the <picture> switch and the CSS band must both turn at ${HERO_BREAKPOINT}px`,
  );
});

test("the hero copy carries its own contrast, so the scrim does not have to crush the picture", async () => {
  const css = (await read("app/(marketing)/marketing.css")).replace(/\r\n/g, "\n");

  /*
   * A single wide blur dims a line without ever getting dark directly under a
   * stroke, which is why the old treatment had to reach for a 77%-94% opaque
   * scrim on phones — over this photograph that would have left about a sixth
   * of it visible. A tight near-opaque layer plus a symmetric halo puts the
   * contrast where the letters are and nowhere else. Measured against the
   * pixels a glyph actually sits on, every string clears AA at 320 through
   * 1440 with the picture no darker than the photographer left it.
   */
  for (const selector of [".hero__lede", ".hero__pills li"]) {
    const rule = css.match(new RegExp(`\\n${selector.replace(/[.]/g, "\\.")}\\{([^}]*)\\}`));
    assert.ok(rule, `${selector} must still be declared`);
    const shadows = rule[1].match(/text-shadow:([^;}]*)/);
    assert.ok(shadows, `${selector} needs a text-shadow over a photograph`);
    assert.ok(
      shadows[1].split(",").length >= 3,
      `${selector} needs the tight layer as well as the wash — found: ${shadows[1]}`,
    );
    assert.match(shadows[1], /0 1px 2px rgba\(4,15,26,\.9\d?\)/, "a near-opaque layer right under the glyph");
  }

  /* And the scrim must stay a wash, not a blanket: nothing in the hero's own
     rules may paint the photograph out. */
  const scrims = [...css.matchAll(/\.hero__scrim\{[^}]*\}/g)].map((m) => m[0]);
  assert.ok(scrims.length >= 2, "a wide scrim and a narrow one");
  for (const scrim of scrims) {
    for (const alpha of scrim.match(/rgba\([\d,]+,\.(\d+)\)/g) ?? []) {
      const value = Number(`0.${alpha.match(/\.(\d+)\)$/)[1]}`);
      assert.ok(
        value <= 0.75,
        `${alpha} in the scrim — above .75 the engineers and the plant go invisible, which is the point of the photograph`,
      );
    }
  }
});
