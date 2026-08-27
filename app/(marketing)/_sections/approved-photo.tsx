import { assetWidths } from "./asset-widths";

/**
 * One of the approved v3 photographs.
 *
 * WHY THIS IS NOT `PhotoSlot`. That component exists to draw generated artwork
 * while a photograph loads or when one was never supplied, and it addresses
 * files by a slot stem under `/assets/photos`. These images are different on
 * both counts: they are supplied, approved and named by the pack's own README,
 * which gives an explicit site path for every one of them — so the path IS the
 * contract and there is nothing to fall back to. Inventing a slot name for them
 * would mean the README no longer describes where the file went.
 *
 * The original stays the `src`, exactly as supplied. AVIF and WebP variants are
 * offered above it and the browser takes the smallest it understands, which
 * matters: the six audience PNGs are 1.8–2.3 MB each and the widest WebP of the
 * same picture is around 110 KB. `assetWidths` is generated from the files that
 * actually exist, so a srcset never advertises a width that was not written —
 * and never one wider than the original, which would hand the browser a
 * blurrier file than the one it could have had.
 */
export function ApprovedPhoto({
  src,
  alt,
  sizes,
  className = "",
  loading = "lazy",
  objectPosition,
}: {
  /** The site path from the pack's README, e.g. `/assets/audience/…png`. */
  src: string;
  /** Empty string where a caption already says the same thing. */
  alt: string;
  sizes: string;
  className?: string;
  loading?: "lazy" | "eager";
  /**
   * Which part of the picture to keep when `object-fit: cover` has to crop —
   * per PICTURE, so it belongs with the picture's own data rather than in a
   * stylesheet rule per stage. Left undefined the element keeps whatever the
   * stylesheet says, so every existing caller is unaffected.
   */
  objectPosition?: string;
}) {
  /*
   * The size comes from the manifest, not from the caller. Passing one pair of
   * dimensions for a whole section is how step 1 of the workflow — 1240x531
   * where the others are 1672x941 — got squashed into somebody else's ratio.
   * The generated manifest knows each file's own size, so nothing can be
   * declared wrong from a call site.
   */
  const entry = assetWidths[src];
  const widths = entry?.widths ?? [];
  const stem = src.replace(/\.[^.]+$/, "");
  const srcSet = (ext: "avif" | "webp") =>
    widths.map((w) => `${stem}-${w}.${ext} ${w}w`).join(", ");

  return (
    <picture>
      {widths.length > 0 && (
        <>
          <source type="image/avif" srcSet={srcSet("avif")} sizes={sizes} />
          <source type="image/webp" srcSet={srcSet("webp")} sizes={sizes} />
        </>
      )}
      <img
        className={className}
        src={src}
        alt={alt}
        /* The supplied dimensions, so the box is reserved before the bytes
           arrive and nothing below shifts as the section loads. */
        width={entry?.width}
        height={entry?.height}
        sizes={sizes}
        loading={loading}
        decoding="async"
        style={objectPosition ? { objectPosition } : undefined}
      />
    </picture>
  );
}
