/*
 * Install the owner-supplied portal screenshots (v2) behind the landing page's
 * four dashboard tabs.
 *
 *   node scripts/install-dashboard-v2.mjs ["<folder holding the four PNGs>"]
 *
 * The first set were mock-ups drawn before the product existed — "Active
 * units", "Store #104 – Manchester", figures nobody could produce on request.
 * These four are captures of the real portal on the MAINTSUPP Demo workspace,
 * with the one live client's name already blanked out in the supplied files.
 *
 * NEW STEMS, NOT NEW BYTES UNDER OLD ONES. `/assets/photos/*` is served
 * `Cache-Control: public, max-age=31536000, immutable`, so overwriting
 * `dashboard-jobs-960.avif` in place would keep serving the mock-up to every
 * returning visitor. Each tab gets a `-v2` stem, so every URL it asks for is one
 * no browser has cached. The mock-up files are removed rather than left behind:
 * they showed invented operational data, and nothing on the page asks for them.
 *
 * THE SAME TWO ORIGINALS THE HERO SHIPS, FOR THE SAME REASONS.
 *   - `<stem>.png` is a byte-identical copy of the supplied file — provenance,
 *     pinned by digest in `tests/landing-dashboard-v2.test.mjs`.
 *   - `<stem>.jpg` is the last-resort `<img src>` `photo.tsx` addresses, and the
 *     base file the manifest invariant in `stage-twelve-images` counts.
 *
 * The ladder tops out at the source's own 1672px rather than 1600: the stage is
 * up to 1240 CSS px wide, so a 2x screen asks for more than either, and the
 * widest rung should be the whole original rather than a slightly smaller copy
 * of it. These are UI captures, not photographs, so they are encoded a notch
 * higher than the photo ladders and with full-resolution chroma — 4:2:0 smears
 * the teal and red figures on the dark panels.
 */
import { copyFile, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SRC = process.argv[2] ?? "D:/study/anwar website/landing page new pictures";
const OUT = path.join(ROOT, "public/assets/photos");
const MANIFEST = path.join(ROOT, "app/(marketing)/_sections/photo-widths.ts");

/* Matched by looking at each file, not by its name alone: `reports.png` is the
   portal's "Spend & reporting" screen, which is what the Spend tab shows. */
const PLAN = [
  ["overview.png", "dashboard-overview-v2"],
  ["jobs.png", "dashboard-jobs-v2"],
  ["compliance.png", "dashboard-compliance-v2"],
  ["reports.png", "dashboard-spend-v2"],
];
const RETIRED = ["dashboard-overview", "dashboard-jobs", "dashboard-compliance", "dashboard-spend"];

/** The shape `portal.tsx` and `.dashshot__stage` are both written for. */
const SHAPE = [1672, 941];
const WIDTHS = [480, 960, 1600];

const kb = async (file) => `${((await stat(file)).size / 1024).toFixed(0)}KB`;
const ladder = {};

for (const [file, stem] of PLAN) {
  const source = path.join(SRC, file);
  const meta = await sharp(source).metadata();
  if (meta.width !== SHAPE[0] || meta.height !== SHAPE[1]) {
    throw new Error(`${file} is ${meta.width}x${meta.height}; the dashboard stage is ${SHAPE.join("x")}`);
  }

  await copyFile(source, path.join(OUT, `${stem}.png`));

  const base = path.join(OUT, `${stem}.jpg`);
  await sharp(source).jpeg({ quality: 86, mozjpeg: true, chromaSubsampling: "4:4:4" }).toFile(base);

  const widths = [...WIDTHS.filter((width) => width < meta.width), meta.width];
  for (const width of widths) {
    for (const [ext, options] of [
      ["avif", { quality: 62, effort: 6, chromaSubsampling: "4:4:4" }],
      ["webp", { quality: 84, smartSubsample: true }],
    ]) {
      const out = path.join(OUT, `${stem}-${width}.${ext}`);
      await sharp(source)
        .resize({ width, withoutEnlargement: true, kernel: "lanczos3" })
        .toFormat(ext, options)
        .toFile(out);
    }
  }
  ladder[stem] = widths;

  const sizes = await Promise.all(
    widths.map(async (w) => `${w}: ${await kb(path.join(OUT, `${stem}-${w}.avif`))}`),
  );
  console.log(`${file.padEnd(15)} → ${stem}  jpg ${await kb(base)}  avif ${sizes.join(", ")}`);
}

/* Retire the mock-ups: the base file and every rung derived from it. The match
   is exact — `<stem>.jpg` or `<stem>-<digits>.<ext>` — so the `-v2` files
   written above can never be caught by it. */
const files = await readdir(OUT);
for (const stem of RETIRED) {
  const own = new RegExp(`^${stem}(?:-\\d+)?\\.(?:jpg|avif|webp)$`);
  for (const file of files.filter((name) => own.test(name))) {
    await rm(path.join(OUT, file));
  }
}

/* The manifest is generated and alphabetically ordered; rewrite its object in
   the same JSON shape so it still reads as generated afterwards. */
const manifest = await readFile(MANIFEST, "utf8");
const open = manifest.indexOf("{", manifest.indexOf("photoWidths"));
const close = manifest.lastIndexOf("}");
const entries = JSON.parse(manifest.slice(open, close + 1));
for (const stem of RETIRED) delete entries[stem];
Object.assign(entries, ladder);
const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : 1)));
await writeFile(
  MANIFEST,
  manifest.slice(0, open) + JSON.stringify(sorted, null, 2) + manifest.slice(close + 1),
  "utf8",
);
console.log("\nphoto-widths.ts updated; retired:", RETIRED.join(", "));
