"use client";

/**
 * DocumentThumbnail — an image document drawn as the picture it is.
 *
 * WHY THIS FILE EXISTS. The Documents register drew `<Icon name="document" />`
 * for every row and every card, so a workspace whose register is mostly site
 * photographs — the common case; most of what is filed here is evidence, not
 * certificates — showed forty identical grey glyphs and made the reader open
 * each one to find out which picture it was. The bytes to answer that were
 * already being served, through a route that already existed.
 *
 * THREE RULES, AND THEY ARE THE WHOLE COMPONENT.
 *
 * 1. ONE AUTHORISED PATH. The `src` is always `GET /api/files/<id>?thumb=1`,
 *    built by `documentThumbnailUrl` and by nothing else. That route resolves
 *    the caller through `scopedDb`, scopes the row by `organisation_id` — so
 *    another workspace's document is a plain 404, the same answer as an id that
 *    never existed — honours a contractor's job token for that job only, and
 *    ships `X-Content-Type-Options: nosniff` with a `default-src 'none'; …
 *    sandbox` CSP. No bucket URL, no object key, no second image service.
 *
 * 2. A MISSING PICTURE IS AN ICON, NEVER A BROKEN IMAGE. `onError` is the
 *    whole fallback: a denied cross-org read, a row whose bytes are gone, a
 *    HEIC no desktop browser decodes, a `.jpg` the server refuses to serve
 *    inline because its stored type is `application/octet-stream` — all of them
 *    land on the same handler and all of them draw the type glyph the register
 *    drew before. The image is not rendered at all until it has decoded, so a
 *    reader never sees the browser's own broken-file mark.
 *
 * 3. IT COSTS A THUMBNAIL, NOT A PHOTOGRAPH. `?thumb=1` serves the 96px WebP
 *    derivative when one exists — written by `offerThumbnail` in
 *    `app/lib/client-upload.ts` on upload, and by
 *    `db/monday-export/generate-thumbnails.mjs` for the imported rows — and the
 *    original when it does not, which is heavier but never broken.
 *    `loading="lazy"` keeps the twenty-five rows below the fold from being
 *    fetched at all, `decoding="async"` keeps the decode off the paint, and the
 *    box is sized in CSS with `object-fit: cover` so a 4284x5712 camera JPEG
 *    cannot distort a row or a card.
 *
 *    OPTIMISATION PATH, not built here: the route can only answer with the
 *    original when no `.thumb` exists, because workerd has no image pipeline —
 *    `PUT /api/files/[id]` exists precisely so a derivative can be made outside
 *    the Worker and stored beside the original. The remaining win is to run
 *    `generate-thumbnails.mjs` over the rows imported before that endpoint
 *    existed, or to call `offerThumbnail` again for a row served without one.
 *    Neither changes this component.
 */

import { useEffect, useState } from "react";
import { Icon, type IconName } from "../../../components";
import { documentThumbnailUrl } from "./document-register";

export function DocumentThumbnail({
  file,
  className,
  fallbackIcon = "document",
  fallbackSize = 24,
  /**
   * The rendered box, in CSS pixels, sent as `width`/`height` so the browser
   * reserves the space before the bytes arrive and the row cannot jump.
   * The picture is still fitted by CSS; these are the intrinsic hints.
   */
  box,
}: {
  file: {
    id: string;
    contentType?: string | null;
    name?: string | null;
    originalName?: string | null;
  };
  className: string;
  fallbackIcon?: IconName;
  fallbackSize?: number;
  box: { width: number; height: number };
}) {
  const src = documentThumbnailUrl(file);
  const [failed, setFailed] = useState(false);

  /*
   * A new document in the same slot starts again.
   *
   * The register pages and re-sorts in place, so React reuses this element for
   * a different row. Without this, one denied or missing picture would poison
   * every document that later landed on the same node — the reader would see a
   * glyph for a photograph that is perfectly readable.
   */
  useEffect(() => setFailed(false), [src]);

  if (!src || failed) {
    return (
      <span className={className} aria-hidden="true">
        <Icon name={fallbackIcon} size={fallbackSize} />
      </span>
    );
  }

  return (
    <span className={`${className} has-thumb`}>
      {/*
        WHY A PLAIN <img> AND NOT `next/image`.

        `next/image` would proxy these through the image optimiser, which means
        a second service holding an authenticated, per-organisation URL and
        caching what it gets back. The bytes are private to a workspace; they
        are served by one authorised route and they stay on it.

        This paragraph is deliberately NOT an eslint directive. It used to begin
        `eslint-disable-next-line @next/next/no-img-element — …`, and ESLint
        reads everything after the rule name as more comma-separated RULE NAMES
        — across line breaks. So "`next/image` would proxy these through the
        image optimiser", "which means a second service holding an
        authenticated" and "per-organisation URL and caching what it gets"
        were each reported as an unknown rule: three errors in the baseline,
        from an explanation. The working directive is the one line below.
      */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        /*
         * EMPTY ALT, DELIBERATELY. Every caller draws the document's name in
         * text immediately beside this box — the table's `<strong>` and the
         * card's title — so a described thumbnail would make a screen reader
         * announce the same document twice. The picture is decoration for a
         * label that is already there.
         */
        alt=""
        width={box.width}
        height={box.height}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
    </span>
  );
}
