/*
 * Install the approved Glazing and Drainage photographs into the trade strip.
 *
 * These two tiles were the last drawing generated artwork — the pack had no
 * photograph for either, so `PhotoSlot` fell through to `toolArt`. They are
 * supplied now, and this puts them through EXACTLY the pipeline the other six
 * trade photographs use, because the brief asks for the same presentation and
 * the surest way to get it is the same mechanism:
 *
 *   public/assets/photos/trade-<slot>.jpg        the base src
 *   public/assets/photos/trade-<slot>-480.avif   the variants PhotoSlot offers
 *   public/assets/photos/trade-<slot>-480.webp
 *   photo-widths.ts:  "trade-<slot>": [480]
 *
 * ON THE SHAPE. The other six base files are 520x520 squares; these two are
 * kept at their supplied 3:4 (1086x1448 downscaled to 520x693). The tile is
 * `aspect-ratio: 3/4` with `background-size: cover`, so a square source is
 * cropped top and bottom to fit and a 3:4 source is not cropped at all. Both
 * display identically; supplying 3:4 means the photograph the client approved
 * is the photograph on screen, rather than a crop of it that this script chose.
 *
 * Downscale only — 1086 wide to 520 and 480 — so nothing is upscaled, and the
 * JPEG quality is set to land in the same 39–49 KB band as its neighbours
 * rather than at a default that would make these two conspicuously heavier.
 */
import { mkdir, stat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const SRC = "D:/study/anwar website/MAINTSUPP-image-assets-v3/asset-package";
const OUT = "D:/study/anwar website/MAINTSUPP/public/assets/photos";
const MANIFEST = "D:/study/anwar website/MAINTSUPP/app/(marketing)/_sections/photo-widths.ts";

/* Confirmed by looking at both files, not by trusting the names: glazing.png is
   a technician fitting a commercial storefront glass panel, drainage.png is a
   technician clearing a floor drain with a drain-snake reel. */
const PLAN = [
  ["glazing.png", "trade-glazing"],
  ["drainage.png", "trade-drainage"],
];

/** The single width the other six trade photographs publish. */
const WIDTH = 480;
/** What their base files are scaled to. */
const BASE_WIDTH = 520;

await mkdir(OUT, { recursive: true });

for (const [file, slot] of PLAN) {
  const source = path.join(SRC, file);
  const meta = await sharp(source).metadata();
  if (meta.width < BASE_WIDTH) throw new Error(`${file} is narrower than ${BASE_WIDTH}px — refusing to upscale`);

  const base = path.join(OUT, `${slot}.jpg`);
  await sharp(source)
    .resize({ width: BASE_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(base);

  for (const [ext, options] of [
    ["avif", { quality: 55, effort: 5 }],
    ["webp", { quality: 78 }],
  ]) {
    await sharp(source)
      .resize({ width: WIDTH, withoutEnlargement: true })
      .toFormat(ext, options)
      .toFile(path.join(OUT, `${slot}-${WIDTH}.${ext}`));
  }

  const out = await sharp(base).metadata();
  console.log(
    `${file.padEnd(14)} ${meta.width}x${meta.height} → ${slot}.jpg ${out.width}x${out.height} ` +
      `(${((await stat(base)).size / 1024).toFixed(0)}KB) + ${WIDTH}px avif/webp`,
  );
}

/* The manifest is generated elsewhere and alphabetically ordered, so the two
   entries are spliced in rather than appended — a file that claims to be
   generated should still look generated afterwards. */
let manifest = await readFile(MANIFEST, "utf8");
for (const [, slot] of PLAN) {
  if (manifest.includes(`"${slot}"`)) continue;
  const entry = `  "${slot}": [\n    ${WIDTH}\n  ],\n`;
  const keys = [...manifest.matchAll(/^ {2}"([^"]+)":/gm)];
  const after = keys.find((match) => match[1] > slot);
  const at = after ? after.index : manifest.lastIndexOf("};");
  manifest = manifest.slice(0, at) + entry + manifest.slice(at);
}
await writeFile(MANIFEST, manifest, "utf8");
console.log("\nphoto-widths.ts updated.");
