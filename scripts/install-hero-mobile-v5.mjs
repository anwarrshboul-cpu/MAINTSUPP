/*
 * Install the owner-approved MOBILE hero photograph (v5) into the repository.
 *
 * WHY THERE IS A SECOND HERO FILE AT ALL. `hero-maintenance-v4` is 1916x821 —
 * 2.33:1 — and a phone viewport is about 0.47:1. No single framing of a
 * landscape plate that shape survives a portrait screen: the treatment it
 * shipped under cropped the picture to a third of its width on a phone and put
 * neither the plant panel, nor St Paul's, nor the access platform in frame.
 * The owner shot a portrait plate for phones instead — 941x1452, 0.648:1, with
 * a tall clean dusk sky for the headline to sit on and every subject in the
 * lower half — and this script installs it beside the desktop one. Neither
 * replaces the other; `<picture media>` in `photo.tsx` picks between them.
 *
 * THE CACHE RULE, WHICH IS WHY THE STEM CARRIES A VERSION. `/assets/photos/*`
 * is served `Cache-Control: public, max-age=31536000, immutable`, and
 * `immutable` tells a browser never to revalidate — the last time this repo
 * replaced variant CONTENT at unchanged variant PATHS, returning visitors were
 * served the stale bytes and a hard refresh did not reliably defeat it. So the
 * mobile plate gets a stem of its own, `hero-maintenance-mobile-v5`, and every
 * derived URL under it is one nobody has ever fetched.
 *
 * TWO ORIGINALS, DELIBERATELY — the same pair `install-hero-v4.mjs` writes:
 *   - `.png` is a BYTE-IDENTICAL copy of the approved source, so `sha256sum`
 *     proves what shipped is what was approved.
 *   - `.jpg` is encoded from it, because `photo.tsx` addresses a slot's
 *     last-resort `<img src>` as `<slot>.jpg` and `stage-twelve-images.test.mjs`
 *     pins the manifest to exactly the set of `.jpg` base files on disk.
 *
 * A PHONE LADDER, NOT A DESKTOP ONE. The desktop plate tops out at its own
 * 1916px because it paints ~1633 CSS px wide at a 1440 viewport. This one is
 * only ever fetched below 620px, where the widest realistic request is a 430px
 * viewport at DPR 3 = 1290 device px — and the source is 941, so 941 is the
 * cap and there is no point shipping a rung above it. 480 covers DPR 1 and the
 * test that requires a 480 rung for every photograph; 720 is 360@2x and 240@3x.
 */
import { copyFile, mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const SRC = "D:/study/anwar website/MAINTSUPP-image-assets-v3/maintsupp_mobile_hero_shorter_sky (1).png";
const OUT = "D:/study/anwar website/MAINTSUPP/public/assets/photos";
const STEM = "hero-maintenance-mobile-v5";
const WIDTHS = [480, 720];

await mkdir(OUT, { recursive: true });

const meta = await sharp(SRC).metadata();
console.log(
  `source ${meta.width}x${meta.height} ${meta.format} ratio ${(meta.width / meta.height).toFixed(4)} (${((await stat(SRC)).size / 1024).toFixed(0)}KB)`,
);

/* 1. The provenance copy — bytes in, bytes out, no re-encode anywhere near it. */
const target = path.join(OUT, `${STEM}.png`);
await copyFile(SRC, target);

const sha = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
const [a, b] = [await sha(SRC), await sha(target)];
if (a !== b) throw new Error(`provenance copy is not byte-identical: ${a} != ${b}`);
console.log(`sha256 source == repo asset: ${a}`);

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
    console.log(`  ${path.basename(file).padEnd(40)} ${((await stat(file)).size / 1024).toFixed(0)}KB`);
  }
}

console.log(`\n${STEM}: png + jpg originals, ${ladder.length * 2} variants at [${ladder.join(", ")}]`);
console.log("now run: node generate-photo-manifest.mjs");
