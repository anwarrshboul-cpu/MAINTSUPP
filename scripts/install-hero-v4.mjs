/*
 * Install the owner-approved hero photograph (v4) into the repository.
 *
 * WHY THIS IS A SCRIPT AND NOT `convert-images.mjs`. That one walks every
 * `.jpg` in `public/assets/photos` and rewrites every derived variant it finds,
 * under the variants' EXISTING filenames. Those URLs are served
 * `Cache-Control: public, max-age=31536000, immutable`, and `immutable` tells a
 * browser never to revalidate — the last time this repo replaced variant
 * CONTENT at unchanged variant PATHS, returning visitors were served the stale
 * bytes out of disk cache and a hard refresh did not reliably defeat it. So the
 * new hero gets a new stem, `hero-maintenance-v4`, and therefore a whole set of
 * URLs nobody has ever fetched. `hero-london-maintenance*` is left exactly as
 * it is on disk: untouched bytes at untouched paths, referenced by nothing.
 *
 * TWO ORIGINALS, DELIBERATELY.
 *   - `hero-maintenance-v4.png` is a BYTE-IDENTICAL copy of the approved
 *     source. It is the provenance record: `sha256sum` matches the file the
 *     owner supplied, so what shipped can always be proved to be what was
 *     approved.
 *   - `hero-maintenance-v4.jpg` is encoded from it, because `photo.tsx`
 *     addresses a slot's last-resort `<img src>` as `<slot>.jpg`, and because
 *     `stage-twelve-images.test.mjs` pins the manifest to exactly the set of
 *     `.jpg` base files on disk. In practice neither original is ever fetched:
 *     the AVIF and WebP `<source>` elements win in every browser that
 *     understands them.
 *
 * The ladder tops out at the source's own width rather than at 1600. This is a
 * FULL-BLEED background: at a 1440px viewport the hero paints the picture about
 * 1633 CSS px wide, so a 1600 rung is already an upscale, and the `<source>`
 * elements mean the full-size original standing behind them is unreachable.
 */
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const SRC = "D:/study/anwar website/MAINTSUPP-image-assets-v3/hero section background image.png";
const OUT = "D:/study/anwar website/MAINTSUPP/public/assets/photos";
const STEM = "hero-maintenance-v4";
const WIDTHS = [480, 960, 1600];

await mkdir(OUT, { recursive: true });

const meta = await sharp(SRC).metadata();
console.log(`source ${meta.width}x${meta.height} ${meta.format} (${((await stat(SRC)).size / 1024).toFixed(0)}KB)`);

/* 1. The provenance copy — bytes in, bytes out, no re-encode anywhere near it. */
await copyFile(SRC, path.join(OUT, `${STEM}.png`));

/* 2. The `.jpg` base the component and the manifest invariant expect. */
await sharp(SRC).jpeg({ quality: 84, mozjpeg: true }).toFile(path.join(OUT, `${STEM}.jpg`));

/* 3. The responsive ladder. Never upscale; add the source's own width when the
 *    ladder stops short of it, so the widest variant is at least as good as the
 *    original it stands in for. */
const ladder = WIDTHS.filter((width) => width <= meta.width);
if (meta.width > WIDTHS[WIDTHS.length - 1]) ladder.push(meta.width);

for (const width of ladder) {
  for (const [ext, options] of [
    ["avif", { quality: 50, effort: 5 }],
    ["webp", { quality: 74 }],
  ]) {
    const file = path.join(OUT, `${STEM}-${width}.${ext}`);
    await sharp(SRC).resize({ width, withoutEnlargement: true }).toFormat(ext, options).toFile(file);
    console.log(`  ${path.basename(file).padEnd(34)} ${((await stat(file)).size / 1024).toFixed(0)}KB`);
  }
}

console.log(`\n${STEM}: png + jpg originals, ${ladder.length * 2} variants at [${ladder.join(", ")}]`);
console.log("now run: node generate-photo-manifest.mjs");
