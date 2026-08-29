import assert from "node:assert/strict";
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

/* ================================================================ hero v4
 *
 * The hero photograph was replaced with the owner-approved 1916x821 file, and
 * both halves of that job are pinned here: the CACHE half, because this repo
 * has already shipped new bytes at old `immutable` URLs once and served the
 * stale ones for a year; and the CROP half, because the treatment that got
 * replaced looked correct in the source and ate 80% of the picture in the
 * browser, which is a failure no reading of the CSS would have caught.
 */

const HERO_SLOT = "hero-maintenance-v4";
const HERO_RETIRED = "hero-london-maintenance";
/** The approved source's own pixels. Every number below is derived from these. */
const HERO_W = 1916;
const HERO_H = 821;

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
   * PHONES, AND BOTH WAYS OF GETTING THIS WRONG.
   *
   * At the picture's own ratio the band is 167px tall at 390 and sits at page
   * y 783 — below the fold, a photograph nobody sees. Made taller by a ratio of
   * the WIDTH it reached 58% of the picture, which is the number the brief
   * asked for and still looked wrong: 285px of an 838px hero, so more than half
   * the hero was flat navy and it read as an image that had failed to load.
   *
   * Cover makes height and width reciprocal, so the two failure modes sit at
   * opposite ends of one dial: too little height reads as empty, too little
   * width goes back to the middle-of-the-skyline crop with no people in it.
   * Both ends are bounded here, and the band is a share of the HERO'S height
   * rather than of the viewport's width — the hero grows as the headline wraps
   * (838px at 390, 977px at 320), so a width-derived band is thinnest exactly
   * where the hero is tallest.
   */
  /* The block is found by what it CONTAINS, not by where it sits: another
     section may open a 620px query above this one at any time. */
  const phoneBlocks = [...css.matchAll(/@media\s*\(max-width:\s*620px\)\s*\{([\s\S]*?)\n\}/g)]
    .map((match) => match[1])
    .filter((body) => body.includes(".hero__media .ph > picture"));
  assert.equal(phoneBlocks.length, 1, "exactly one phone block may own the hero band");
  const [phoneBlock] = phoneBlocks;

  const fill = phoneBlock.match(/height:\s*(\d+)%/);
  assert.ok(fill, "the phone band must take a share of the hero's height");
  const pct = Number(fill[1]);
  assert.ok(pct >= 50, `the band fills ${pct}% of the hero — under half reads as a page with no photograph on it`);
  assert.ok(pct <= 70, `the band fills ${pct}% of the hero — past this the width collapses back to the eaten crop`);

  /* A share of the height only means anything if the ratio stops driving the
     box, and the picture must still be anchored to the hero's foot. */
  assert.match(phoneBlock, /aspect-ratio:auto/, "the desktop ratio must not also be setting the height");
  assert.match(phoneBlock, /bottom:0/, "anchored to the hero's foot");
  assert.match(phoneBlock, /top:auto/);
  assert.match(phoneBlock, /mask-image:linear-gradient/, "and faded at the top into the painted sky");

  /* The framing lever, which is what keeps the people in frame once height is
     cropping the width again. */
  assert.match(css, /\.hero \.ph__img\{[^}]*object-position:25% bottom/);
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
