/**
 * THE WORKSPACE LOGO'S BYTES — the one door they leave the private bucket by.
 *
 *   GET — the caller's own workspace's logo, to any member of it.
 *         `?rendition=print` serves the JPEG the documents embed.
 *   PUT — the browser's print JPEG for the current logo (`?rendition=print&v=`),
 *         a derivative like the board's thumbnails. Needs `settings.edit`.
 *
 * WHOSE LOGO. The workspace is `scopedDb`'s — the caller's session, never a
 * parameter — so a member of one workspace cannot ask for another's, and a
 * stranger gets the same 401 every data route gives. `v` is a cache key, not a
 * credential: it is compared with the current logo only to decide whether the
 * answer may be cached for good.
 *
 * WHAT THE BROWSER MAY DO WITH IT. The type served is the one the bytes proved
 * at upload and is always one of three image types; `nosniff` stops a browser
 * second-guessing it, and the same sandboxing CSP `/api/files/[id]` sends means
 * that even an image opened directly can fetch, script and frame nothing.
 * `Cross-Origin-Resource-Policy: same-origin` keeps other sites from embedding a
 * member's logo through their session.
 */

import { ensureDatabase } from "../../../../../db/init";
import {
  LOGO_PRINT_MAX_BYTES,
  LOGO_TYPES,
  inspectPrintRendition,
  printRenditionKey,
} from "../../../../lib/organisation-logo-rules";
import { readOrganisationLogo, recordPrintRendition } from "../../../../lib/organisation-logo";
import { anonymousRefusal, scopedDb } from "../../../../lib/tenant-db";
import { logoBucket, logoEditorScope, storageUnavailable } from "../gate";

export const dynamic = "force-dynamic";

function unavailable(error?: unknown) {
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  return Response.json({ error: "The workspace logo is temporarily unavailable." }, { status: 503 });
}

const notFound = () =>
  Response.json({ error: "This workspace has no logo." }, { status: 404, headers: { "cache-control": "no-store" } });

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const scope = await scopedDb(request);
    const row = await readOrganisationLogo(scope.db, scope.orgId);
    if (!row) return notFound();

    const search = new URL(request.url).searchParams;
    const print = search.get("rendition") === "print";
    /* The print copy exists for the reports only once it is recorded for THIS logo. */
    if (print && !(row.printWidth && row.printHeight)) return notFound();
    const storage = await logoBucket();
    if (!storage) return storageUnavailable();
    const object = await storage.get(print ? printRenditionKey(row.objectKey) : row.objectKey);
    if (!object) return notFound();

    /* Only ever one of the three, whatever the object's metadata says. */
    const type = print
      ? "image/jpeg"
      : (LOGO_TYPES as readonly string[]).includes(row.contentType)
        ? row.contentType
        : "application/octet-stream";
    const current = search.get("v") === row.logoId;
    const headers = new Headers({
      "Content-Type": type,
      "Content-Length": String(object.size),
      "Content-Disposition": `inline; filename="workspace-logo${print ? "-print.jpg" : ""}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      /*
       * A logo id names one set of bytes for ever — a new logo is a new id and a
       * new URL — so the versioned address may be cached as immutable. Anything
       * else (no `v`, or a `v` that is no longer current) must be revalidated,
       * or a removed logo would linger in a browser for a day.
       */
      "Cache-Control": current ? "private, max-age=86400, immutable" : "private, no-cache",
      ETag: `"${row.logoId}${print ? "-print" : ""}"`,
    });
    return new Response(object.body, { status: 200, headers });
  } catch (error) {
    return unavailable(error);
  }
}

export async function PUT(request: Request) {
  try {
    await ensureDatabase();
    const search = new URL(request.url).searchParams;
    if (search.get("rendition") !== "print") {
      return Response.json({ error: "Only the print copy of the logo is written here." }, { status: 400 });
    }
    const gate = await logoEditorScope(request);
    if (gate.denied) return gate.denied;
    const { scope } = gate;

    /* Refused before the body is read when it says it is too large. */
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > LOGO_PRINT_MAX_BYTES) {
      return Response.json({ error: "The print copy of the logo must be 512 KB or smaller." }, { status: 413 });
    }
    const row = await readOrganisationLogo(scope.db, scope.orgId);
    /* For THIS logo only: a copy drawn from a logo that has since been replaced
       must not be filed against the new one. */
    if (!row || search.get("v") !== row.logoId) {
      return Response.json({ error: "The logo has changed since this copy was made." }, { status: 409 });
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    const inspected = inspectPrintRendition(bytes);
    if (!inspected.ok) {
      return Response.json({ error: inspected.error }, { status: inspected.status });
    }
    const storage = await logoBucket();
    if (!storage) return storageUnavailable();
    const printKey = printRenditionKey(row.objectKey);
    await storage.put(printKey, bytes, {
      httpMetadata: { contentType: "image/jpeg" },
      customMetadata: { organisationId: scope.orgId, purpose: "organisation-logo-print", logoId: row.logoId },
    });
    /* Recorded only against the logo it was drawn from. A replace that landed
       between the read above and this write matches no row, and the copy is
       deleted rather than left beside a logo it does not show. */
    if (!(await recordPrintRendition(scope.db, scope.orgId, row.logoId, inspected))) {
      await storage.delete(printKey).catch(() => undefined);
      return Response.json({ error: "The logo has changed since this copy was made." }, { status: 409 });
    }
    return Response.json({ ok: true, width: inspected.width, height: inspected.height });
  } catch (error) {
    return unavailable(error);
  }
}
