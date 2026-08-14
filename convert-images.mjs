import sharp from "sharp";
import { readdir, stat, mkdir } from "node:fs/promises";
import path from "node:path";

const SRC = "public/assets/photos";
const OUT = "public/assets/photos";
// Widths that match how the images are actually displayed. The largest source
// is 2400px wide but nothing renders above ~1200 CSS px.
const WIDTHS = [480, 960, 1600];

await mkdir(OUT, { recursive: true });
const files = (await readdir(SRC)).filter((f) => f.endsWith(".jpg"));
let before = 0, after = 0;

for (const file of files) {
  const base = file.replace(/\.jpg$/, "");
  const full = path.join(SRC, file);
  before += (await stat(full)).size;
  const meta = await sharp(full).metadata();

  // Always emit at least one variant. A source narrower than the smallest
  // target still needs a modern format, or it silently falls back to JPG —
  // which is how the three testimonial images were missed first time.
  const targets = WIDTHS.filter((w) => !meta.width || meta.width >= w);
  if (targets.length === 0) targets.push(WIDTHS[0]);

  for (const width of targets) {
    for (const [ext, opts] of [
      ["avif", { quality: 50, effort: 4 }],
      ["webp", { quality: 72 }],
    ]) {
      const target = path.join(OUT, `${base}-${width}.${ext}`);
      await sharp(full).resize({ width, withoutEnlargement: true })[ext](opts).toFile(target);
      after += (await stat(target)).size;
    }
  }
}
console.log(`source jpg: ${(before/1048576).toFixed(2)} MB`);
console.log(`generated:  ${(after/1048576).toFixed(2)} MB across ${WIDTHS.length} widths x 2 formats`);
