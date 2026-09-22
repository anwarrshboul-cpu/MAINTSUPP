/**
 * A website media file, served to the public — decision K.
 *
 * `/media/<mediaId>/<versionId>/<name>` is the ONLY way into the `cms-media`
 * bucket from outside. The bucket itself is private and cannot be listed;
 * this route reads exactly one key, built from three segments that are each
 * checked against their own shape first (`keyFromMediaPath`), from the
 * website's bucket (`CMS_BUCKET`) and never from the customers' one.
 *
 * NO DATABASE, NO SESSION, AND THAT IS WHAT MAKES IT CACHEABLE. The bytes under
 * a key never change — a replacement is a new version, and so a new key — so
 * the answer is the same for everyone for ever: `public, max-age=31536000,
 * immutable` for browsers, a day at Vercel's edge (`CDN-Cache-Control`), after
 * which a deleted file is gone from the edge too. After the first request a file
 * is served without this function waking at all.
 *
 * WHAT THE BROWSER MAY DO WITH IT: draw it, play it, read it — nothing else.
 * The Content-Type comes from the allowlist (never echoed from storage
 * unchecked), `nosniff` stops a browser guessing past it, and the same
 * sandboxing CSP as `/api/files/[id]` means even a PDF opened directly cannot
 * script or act as this origin. Video answers byte ranges, so it seeks.
 */

import {
  DISPLAY_RENDITION,
  MEDIA_CACHE_CONTROL,
  MEDIA_CDN_CACHE_CONTROL,
  MEDIA_RESPONSE_CSP,
  SERVABLE_MEDIA_TYPES,
  keyFromMediaPath,
} from "../../../../lib/cms-media.ts";
import { cmsBucket, isMissingBucket } from "../../../../lib/cms-media-storage.ts";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ mediaId: string; versionId: string; name: string }> };

/** Not found, and not cached: a key that exists later must not be shadowed by this answer. */
function notFound() {
  return new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function parseRange(value: string | null, size: number) {
  const match = value?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(size - Number(match[2]), 0);
  const end = match[1] ? Math.min(match[2] ? Number(match[2]) : size - 1, size - 1) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end, length: end - start + 1 };
}

async function serve(request: Request, context: Params, withBody: boolean) {
  const { mediaId, versionId, name } = await context.params;
  const key = keyFromMediaPath(mediaId, versionId, name);
  if (!key) return notFound();
  try {
    const storage = await cmsBucket();
    if (!storage) return notFound();
    const head = await storage.head(key);
    if (!head) return notFound();
    const stored = (head.httpMetadata?.contentType ?? "").toLowerCase();
    const type = name === DISPLAY_RENDITION ? "image/webp" : stored;
    if (!SERVABLE_MEDIA_TYPES.has(type)) return notFound();

    const range = type.startsWith("video/") ? parseRange(request.headers.get("range"), head.size) : null;
    const headers = new Headers({
      "Content-Type": type,
      "Content-Disposition": `inline; filename="${name}"`,
      "Content-Security-Policy": MEDIA_RESPONSE_CSP,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": MEDIA_CACHE_CONTROL,
      "CDN-Cache-Control": MEDIA_CDN_CACHE_CONTROL,
      "Accept-Ranges": type.startsWith("video/") ? "bytes" : "none",
      "Content-Length": String(range?.length ?? head.size),
      /* Only this app's pages draw these; another site may not embed them as its own. */
      "Cross-Origin-Resource-Policy": "same-site",
    });
    if (range) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${head.size}`);
    if (!withBody) return new Response(null, { status: range ? 206 : 200, headers });

    const object = await storage.get(key, range ? { range: { offset: range.start, length: range.length } } : undefined);
    if (!object) return notFound();
    return new Response(object.body as ReadableStream, { status: range ? 206 : 200, headers });
  } catch (error) {
    console.error("[/media]", isMissingBucket(error) ? "the website media bucket does not exist" : error instanceof Error ? error.message.slice(0, 200) : "error");
    return new Response("Media is temporarily unavailable", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}

export async function GET(request: Request, context: Params) {
  return serve(request, context, true);
}

export async function HEAD(request: Request, context: Params) {
  return serve(request, context, false);
}
