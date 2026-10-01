/*
 * Install the photographs for the menu's own pages — /services, /how-it-works,
 * /pricing, /case-study and /contact.
 *
 *   node scripts/install-page-photos.mjs <folder-with-the-supplied-files>
 *
 * The folder holds the files under the names in the shot list (PLAN below),
 * as .png or .jpg. Anything the folder does not hold is skipped, so the pack
 * can arrive in batches and this script is re-run for each one.
 *
 * Same conventions as `install-assets-v3.mjs`, whose comments say why:
 *   - variants at 480/960/1400 in AVIF and WebP, never upscaled, with the
 *     original's own width added only when it is narrower than the ladder;
 *   - the site path carries a VERSION suffix (`-v1`), because these URLs are
 *     served immutable — a re-shoot needs `-v2`, never an overwrite;
 *   - the manifest entry carries the intrinsic size, so the box is reserved.
 *
 * Unlike that script, the supplied files are 3–4 MB PNGs straight out of an
 * image generator, so the ORIGINAL is re-encoded as a high-quality progressive
 * JPEG rather than copied: it is only ever the last-resort `src` for a browser
 * that understands neither AVIF nor WebP, and 3.7 MB is not a fallback.
 *
 * `asset-widths.ts` is MERGED, not rewritten: every entry already there is kept
 * exactly as it was.
 */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "public/assets/pages");
const MANIFEST = path.join(ROOT, "app/(marketing)/_sections/asset-widths.ts");
const WIDTHS = [480, 960, 1400];
const VERSION = "v1";

/* The shot list, in its order. */
const PLAN = [
  "page-services-hero",
  "page-how-it-works-hero",
  "page-pricing-hero",
  "page-case-study-hero",
  "page-contact-hero",
  "service-reactive",
  "service-planned",
  "service-compliance",
  "service-projects",
  "case-brief",
  "case-work",
  "case-results",
  "trade-cctv",
  "trade-refrigeration",
];

const source = process.argv[2];
if (!source) {
  console.error("usage: node scripts/install-page-photos.mjs <folder>");
  process.exit(1);
}
const supplied = await readdir(source);

const text = await readFile(MANIFEST, "utf8");
const open = text.indexOf("= {", text.indexOf("export const assetWidths")) + 2;
const close = text.lastIndexOf("};");
const manifest = JSON.parse(text.slice(open, close + 1));

await mkdir(PUB, { recursive: true });
let installed = 0;

for (const name of PLAN) {
  const file = supplied.find((entry) => entry.replace(/\.(png|jpe?g)$/i, "") === name);
  if (!file) continue;
  const input = path.join(source, file);
  const meta = await sharp(input).metadata();
  const stem = `${name}-${VERSION}`;
  const original = path.join(PUB, `${stem}.jpg`);
  await sharp(input).jpeg({ quality: 84, progressive: true, mozjpeg: true }).toFile(original);

  const ladder = WIDTHS.filter((width) => width <= meta.width);
  if (meta.width < WIDTHS[WIDTHS.length - 1]) ladder.push(meta.width);
  for (const width of ladder) {
    for (const [ext, options] of [
      ["avif", { quality: 55, effort: 5 }],
      ["webp", { quality: 78 }],
    ]) {
      await sharp(input)
        .resize({ width, withoutEnlargement: true })
        .toFormat(ext, options)
        .toFile(path.join(PUB, `${stem}-${width}.${ext}`));
    }
  }
  manifest[`/assets/pages/${stem}.jpg`] = { widths: ladder, width: meta.width, height: meta.height };
  installed += 1;

  const before = (await stat(input)).size;
  const jpg = (await stat(original)).size;
  const widest = (await stat(path.join(PUB, `${stem}-${ladder[ladder.length - 1]}.webp`))).size;
  console.log(
    `${name.padEnd(24)} ${meta.width}x${meta.height}  ${(before / 1024).toFixed(0)}KB → jpg ${(jpg / 1024).toFixed(0)}KB, widest webp ${(widest / 1024).toFixed(0)}KB  [${ladder.join(", ")}]`,
  );
}

await writeFile(MANIFEST, `${text.slice(0, open)}${JSON.stringify(manifest, null, 2)};\n`);
console.log(`${installed} photograph(s) installed; asset-widths.ts now lists ${Object.keys(manifest).length} assets.`);
