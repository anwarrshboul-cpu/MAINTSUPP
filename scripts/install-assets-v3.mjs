/*
 * Install the approved v3 image pack into the repository.
 *
 * The README in the pack gives an explicit "Site path" for every file, and that
 * is what is honoured here — the originals land at exactly those paths. The
 * responsive variants are generated FROM those originals, never from a
 * re-encode of a re-encode, and only at widths the layout actually requests.
 *
 * The six audience PNGs are 1.8–2.3 MB each — 12 MB for one section — so
 * variants are not a nicety here. AVIF and WebP are written at 480/960/1400,
 * and the original stays in place as the last-resort src.
 */
import { mkdir, copyFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const SRC = "D:/study/anwar website/MAINTSUPP-image-assets-v3/asset-package";
const PUB = "D:/study/anwar website/MAINTSUPP/public/assets";
const WIDTHS = [480, 960, 1400];

/* Straight from the README's "Site path" column, checked against the files on
   disk — the extension in the plan is always the one the supplied file
   actually carries, not the one the README's Filename column claims.

   Steps 2-7 were re-shot: the supplied files are now full-bleed PNGs. The
   .webp copies they replace had blurred filler strips down the left and right
   edges, which is what made the pictures look letterboxed inside the frame.
   The originals of those .webp files are deleted from public/assets/workflow;
   their derived -480/-960/-1400 variants keep the same names and are simply
   overwritten by this run. Step 1 was already clean and stays a .jpg. */
const PLAN = [
  ["who-we-help/who-we-help-retail-chains.png", "audience/who-we-help-retail-chains.png"],
  ["who-we-help/who-we-help-shopping-centre-kiosks.png", "audience/who-we-help-shopping-centre-kiosks.png"],
  ["who-we-help/who-we-help-franchise-groups.png", "audience/who-we-help-franchise-groups.png"],
  ["who-we-help/who-we-help-clinics-wellness.png", "audience/who-we-help-clinics-wellness.png"],
  ["who-we-help/who-we-help-gyms-studios.png", "audience/who-we-help-gyms-studios.png"],
  ["who-we-help/who-we-help-commercial-offices.png", "audience/who-we-help-commercial-offices.png"],
  ["how-it-works/how-it-works-01-report-full.jpg", "workflow/how-it-works-01-report-full.jpg"],
  ["how-it-works/how-it-works-02-triage-full.png", "workflow/how-it-works-02-triage-full.png"],
  ["how-it-works/how-it-works-03-approve-full.png", "workflow/how-it-works-03-approve-full.png"],
  ["how-it-works/how-it-works-04-assign-full.png", "workflow/how-it-works-04-assign-full.png"],
  ["how-it-works/how-it-works-05-attend-full.png", "workflow/how-it-works-05-attend-full.png"],
  ["how-it-works/how-it-works-06-verify-full.png", "workflow/how-it-works-06-verify-full.png"],
  ["how-it-works/how-it-works-07-reporting-full.png", "workflow/how-it-works-07-reporting-full.png"],
];

const manifest = {};
let originals = 0;
let variants = 0;

for (const [from, to] of PLAN) {
  const source = path.join(SRC, from);
  const target = path.join(PUB, to);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
  originals += 1;

  const image = sharp(source);
  const meta = await image.metadata();
  const stem = to.replace(/\.[^.]+$/, "");
  const made = [];

  /*
   * Never upscale: a 1240px original has no honest 1400px variant, and
   * advertising one in a srcset makes the browser fetch a blurrier file than
   * the original it could have had.
   *
   * But dropping the too-wide width is not enough on its own. The <source>
   * elements win over the <img> src whenever the browser understands AVIF or
   * WebP, so the ORIGINAL is never reached — which left workflow step 1
   * (1240x531) topping out at its 960 variant inside a 1240px box while its
   * neighbours were served 1400. Where the ladder stops short of the file's
   * own width, the file's own width is added, so the widest variant is always
   * at least as good as the original it stands in for.
   *
   * Only where the source is NARROWER than the top of the ladder, mind. A
   * 1672px original already has its 1400 rung, close enough to the 1240px box
   * that a third full-size encode of every audience card would be bytes for
   * nothing.
   */
  const ladder = WIDTHS.filter((width) => width <= meta.width);
  if (meta.width < WIDTHS[WIDTHS.length - 1]) ladder.push(meta.width);

  for (const width of ladder) {
    for (const [ext, options] of [
      ["avif", { quality: 55, effort: 5 }],
      ["webp", { quality: 78 }],
    ]) {
      const out = path.join(PUB, `${stem}-${width}.${ext}`);
      await sharp(source)
        .resize({ width, withoutEnlargement: true })
        .toFormat(ext, options)
        .toFile(out);
      variants += 1;
    }
    made.push(width);
  }
  /*
   * The intrinsic size travels with the widths. Step 1 of the workflow is
   * 1240x531 where every other supplied image is about 1672x941 — hard-coding
   * one ratio for all of them squashed that picture, which is exactly the
   * distortion the brief forbids.
   */
  manifest[`/assets/${to}`] = { widths: made, width: meta.width, height: meta.height };

  const before = (await stat(source)).size;
  const after = made.length
    ? (await stat(path.join(PUB, `${stem}-${made[made.length - 1]}.webp`))).size
    : before;
  console.log(
    `${to.padEnd(52)} ${meta.width}x${meta.height}  ${(before / 1024).toFixed(0)}KB` +
      (made.length ? ` → widest webp ${(after / 1024).toFixed(0)}KB  [${made.join(", ")}]` : "  (no variants)"),
  );
}

await writeFile(
  "D:/study/anwar website/MAINTSUPP/app/(marketing)/_sections/asset-widths.ts",
  `/**
 * Which rendered widths exist for each approved v3 asset.
 *
 * Generated by scripts/install-assets-v3.mjs from the supplied originals — do
 * not edit by hand. Sources are never upscaled, so an image narrower than a
 * listed width simply has no variant at it; advertising one would make the
 * browser fetch a blurrier file than the original it could have had.
 */
export type AssetEntry = {
  /** Rendered widths that actually exist, for the srcset. */
  widths: number[];
  /** The supplied original's own size, so the box reserved matches the picture. */
  width: number;
  height: number;
};

export const assetWidths: Record<string, AssetEntry> = ${JSON.stringify(manifest, null, 2)};
`,
  "utf8",
);

console.log(`\n${originals} originals installed, ${variants} variants generated.`);
