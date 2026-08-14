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
    (total, { source }) => total + (source.match(/<PhotoSlot/g) ?? []).length,
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

  const withPhotos = sources
    .filter(({ source }) => source.includes("<PhotoSlot"))
    .map(({ file }) => file)
    .sort();
  assert.deepEqual(
    withPhotos,
    ["case-study.tsx", "hero.tsx", "portal.tsx", "services.tsx", "workflow.tsx"],
    "the brief's five image-bearing sections: hero, trade strip, carousel, case study, dashboard",
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
