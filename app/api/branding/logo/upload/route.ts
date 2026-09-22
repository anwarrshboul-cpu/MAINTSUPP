/**
 * A LOGO OVER 900 KB — sent in parts, on the #78 direct-upload path.
 *
 * Not a new way of uploading: the same protocol, the same session table and
 * the same checks `/api/files/multipart` uses for documents, with the logo's
 * own authority and its own ending.
 *
 *   start      — `settings.edit`; the declaration is judged (type, extension,
 *                size) and the SERVER names the key under this workspace's
 *                `branding/logo/` prefix. An `upload_sessions` row binds the
 *                upload to this person, this workspace, this key, this exact
 *                size and its part plan (`app/lib/upload-sessions.ts`).
 *   sign-part  — on storage that can sign part URLs (S3 — Supabase Storage
 *                deployed), one write-only URL for one part at its planned size,
 *                for fifteen minutes. The browser PUTs the part straight into
 *                the PRIVATE bucket; no read, list or delete is possible with it.
 *   PUT        — elsewhere (Miniflare R2 locally, the filesystem on Railway) the
 *                part comes through here instead, refused before its bytes are
 *                read unless the session is this caller's and still pending.
 *   complete   — once, by a conditional claim. The parts are listed FROM THE
 *                BUCKET and each stored MD5 must equal the MD5 the browser
 *                declared for what it sent (a part URL can be made to copy
 *                another object's bytes — see the note in the documents route);
 *                the object is assembled, read back whole, and put through the
 *                same `inspectLogo` the small path uses. Only then does it
 *                become the workspace's logo. Anything that fails leaves nothing
 *                in the bucket.
 *   abort      — only the caller that wins pending → aborted cancels it.
 *
 * The daily cron's `expireUploadSessions` sweeps an abandoned logo upload
 * exactly as it sweeps an abandoned document: the sessions are the same rows.
 */

import { ensureDatabase } from "../../../../../db/init";
import {
  LOGO_MAX_BYTES,
  declaredLogoType,
  inspectLogo,
  isLogoKeyOf,
  logoDeclarationRefusal,
  logoObjectKey,
} from "../../../../lib/organisation-logo-rules";
import { adoptOrganisationLogo, describeLogo, readOrganisationLogo } from "../../../../lib/organisation-logo";
import {
  MAX_PENDING_UPLOADS_PER_UPLOADER,
  PART_URL_LIFETIME_SECONDS,
  UPLOAD_PART_SIZE,
  abandonUploadSession,
  claimFinalize,
  createUploadSession,
  directTransport,
  findUploadSession,
  partPlan,
  partsMatchPlan,
  pendingUploadCount,
  sessionRefusal,
  settleUploadSession,
  uploaderKey,
} from "../../../../lib/upload-sessions";
import { anonymousRefusal, type ScopedDatabase } from "../../../../lib/tenant-db";
import { logoBucket, logoEditorScope, storageUnavailable } from "../gate";

export const dynamic = "force-dynamic";

function failure(error: unknown) {
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  const detail =
    process.env.NODE_ENV === "development" && error instanceof Error ? ` ${error.message}` : "";
  return Response.json({ error: `The logo could not be uploaded.${detail}` }, { status: 503 });
}

/** The uploader, from the grant that authorised the call — a signed-in editor. */
function uploaderOf(scope: ScopedDatabase) {
  return uploaderKey({
    via: "capability",
    tokenId: null,
    uploadToken: "",
    userId: scope.session?.user.id ?? null,
    authenticated: scope.authenticated,
    actorEmail: scope.identityEmail,
  });
}

const invalidSession = () => Response.json({ error: "The upload session is invalid." }, { status: 400 });

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const parsed = (await request.json().catch(() => null)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Response.json({ error: "The request body must be a JSON object." }, { status: 400 });
    }
    const payload = parsed as Record<string, unknown>;
    const action = String(payload.action ?? "");

    const gate = await logoEditorScope(request);
    if (gate.denied) return gate.denied;
    const { scope } = gate;
    const { db, orgId } = scope;
    const uploader = await uploaderOf(scope);
    const storage = await logoBucket();
    if (!storage) return storageUnavailable();

    if (action === "start") {
      const originalName = String(payload.originalName ?? "").trim().slice(0, 255);
      const contentType = String(payload.contentType ?? "").trim().toLowerCase();
      const byteSize = Number(payload.byteSize);
      const refused = logoDeclarationRefusal(contentType, originalName, byteSize);
      if (refused || !originalName) {
        return Response.json(
          { error: refused?.error ?? "Choose a logo to upload." },
          { status: refused?.status ?? 400 },
        );
      }
      if ((await pendingUploadCount(db, orgId, uploader)) >= MAX_PENDING_UPLOADS_PER_UPLOADER) {
        return Response.json(
          { error: "Too many uploads are in progress. Let them finish, then try again." },
          { status: 429 },
        );
      }
      const type = declaredLogoType(contentType, originalName)!;
      const logoId = crypto.randomUUID();
      const key = logoObjectKey(orgId, logoId, type);
      const upload = await storage.createMultipartUpload(key, {
        httpMetadata: { contentType: type, contentDisposition: `inline; filename="workspace-logo"` },
        customMetadata: {
          organisationId: orgId,
          purpose: "organisation-logo",
          logoId,
          originalName,
          byteSize: String(byteSize),
          uploadedBy: scope.identityEmail,
        },
      });
      let session;
      try {
        session = await createUploadSession(db, {
          organisationId: orgId,
          fileId: logoId,
          objectKey: upload.key,
          uploadId: upload.uploadId,
          uploader,
          transport: directTransport(upload) ? "direct" : "proxy",
          contentType: type,
          originalName,
          byteSize,
        });
      } catch (error) {
        await upload.abort().catch(() => undefined);
        throw error;
      }
      return Response.json(
        {
          key: upload.key,
          uploadId: upload.uploadId,
          logoId,
          transport: session.transport,
          partSize: Number(session.partSize),
          partCount: Number(session.partCount),
          expiresAt: session.expiresAt,
        },
        { status: 201 },
      );
    }

    const key = String(payload.key ?? "");
    const uploadId = String(payload.uploadId ?? "");
    if (!uploadId || !isLogoKeyOf(orgId, key)) return invalidSession();
    const multipart = storage.resumeMultipartUpload(key, uploadId);
    const session = await findUploadSession(db, { organisationId: orgId, objectKey: key, uploadId });

    if (action === "abort") {
      if (!session || session.uploader !== uploader) {
        return Response.json({ error: "The upload session is invalid." }, { status: 404 });
      }
      if (session.state === "pending" && (await abandonUploadSession(db, session.id, orgId))) {
        await multipart.abort();
      }
      return Response.json({ aborted: true });
    }

    if (action === "sign-part") {
      const refused = sessionRefusal(session, uploader);
      if (refused || !session) {
        return Response.json({ error: refused?.error }, { status: refused?.status ?? 404 });
      }
      const direct = directTransport(multipart);
      if (!direct || session.transport !== "direct") {
        return Response.json(
          { error: "This upload sends its parts through the server.", transport: "proxy" },
          { status: 409 },
        );
      }
      const partNumber = Number(payload.partNumber);
      const size = partPlan(Number(session.byteSize), Number(session.partSize)).sizeOf(partNumber);
      if (!size) {
        return Response.json({ error: "That part is not part of this upload." }, { status: 400 });
      }
      return Response.json({
        url: direct.presignPart(partNumber, size, PART_URL_LIFETIME_SECONDS),
        partNumber,
        size,
        expiresIn: PART_URL_LIFETIME_SECONDS,
      });
    }

    if (action === "complete") {
      /* A repeated `complete` for an upload this caller already finished answers
         with the logo it made, not a second one. */
      if (session && session.uploader === uploader && session.state === "completed") {
        const current = await readOrganisationLogo(db, orgId);
        if (current && current.objectKey === key) {
          return Response.json({ canEdit: true, logo: describeLogo(current) });
        }
      }
      const refused = sessionRefusal(session, uploader);
      if (refused || !session) {
        return Response.json({ error: refused?.error }, { status: refused?.status ?? 404 });
      }
      if (!(await claimFinalize(db, session.id, orgId))) {
        return Response.json({ error: "This upload is already being finished." }, { status: 409 });
      }
      let settled: "completed" | "failed" = "failed";
      let assembled = false;
      try {
        const plan = partPlan(Number(session.byteSize), Number(session.partSize));
        /*
         * The etag AS SENT. It is lowercased only where it is compared as an MD5
         * (the direct path below); on the proxied path it is handed back to the
         * storage driver, and Miniflare's R2 etags are case-sensitive base64url —
         * lowercasing them made `complete` answer "parts could not be found".
         */
        const claimed = Array.isArray(payload.parts)
          ? payload.parts
              .map((part) => {
                const value = part as Record<string, unknown>;
                return {
                  partNumber: Number(value.partNumber),
                  etag: String(value.etag ?? "").trim(),
                };
              })
              .filter((part) => Number.isInteger(part.partNumber) && part.partNumber > 0 && part.etag.length > 0)
          : [];
        const direct = session.transport === "direct" ? directTransport(multipart) : null;
        let parts: Array<{ partNumber: number; etag: string }>;
        if (direct) {
          /* WHICH PARTS, measured by the bucket — the browser's list is not evidence. */
          const listed = await direct.listParts();
          if (!partsMatchPlan(listed, plan)) {
            return Response.json({ error: "Part of the logo did not arrive. Start the upload again." }, { status: 400 });
          }
          /* WHAT EACH PART HOLDS: the stored MD5 must be the one the browser declared. */
          const declared = new Map(claimed.map((part) => [part.partNumber, part.etag.toLowerCase()]));
          if (!listed.every((part) => declared.get(part.partNumber) === part.etag.toLowerCase())) {
            return Response.json(
              { error: "The logo's parts do not match what was sent. Start the upload again." },
              { status: 400 },
            );
          }
          parts = listed.map(({ partNumber, etag }) => ({ partNumber, etag }));
        } else {
          parts = claimed;
          if (!parts.length || parts.length !== plan.partCount) {
            return Response.json({ error: "The uploaded logo parts are incomplete." }, { status: 400 });
          }
        }
        try {
          await multipart.complete(parts);
          assembled = true;
        } catch (error) {
          if (error instanceof Error && /EntityTooLarge|too large|maximum allowed size/i.test(error.message)) {
            return Response.json(
              { error: "The file store refused a file this large. Ask your administrator to raise the storage file-size limit." },
              { status: 413 },
            );
          }
          throw error;
        }

        /*
         * THE WHOLE FILE, READ BACK. A logo is at most 2 MB, so the assembled
         * object is read in full and judged exactly as the small path judges an
         * upload: size, type, signature and dimensions. Its bytes never passed
         * through this server on the way in, so this is the first time they are
         * seen at all.
         */
        const object = await storage.get(key);
        const bytes = object ? new Uint8Array(await new Response(object.body as ReadableStream).arrayBuffer()) : null;
        if (!bytes || bytes.byteLength !== Number(session.byteSize) || bytes.byteLength > LOGO_MAX_BYTES) {
          return Response.json({ error: "The uploaded logo's size could not be verified." }, { status: 400 });
        }
        const inspected = inspectLogo(session.contentType, session.originalName, bytes);
        if (!inspected.ok) {
          return Response.json({ error: inspected.error }, { status: inspected.status });
        }

        const row = await adoptOrganisationLogo({
          db,
          storage,
          organisationId: orgId,
          logo: {
            logoId: session.fileId,
            objectKey: key,
            contentType: inspected.type,
            byteSize: inspected.byteSize,
            width: inspected.width,
            height: inspected.height,
            originalName: session.originalName,
          },
          scope,
          request,
          multipart: true,
        });
        settled = "completed";
        return Response.json({ canEdit: true, logo: describeLogo(row) }, { status: 201 });
      } finally {
        /* NOTHING OF A FAILED UPLOAD STAYS IN THE BUCKET, whatever failed. */
        if (settled !== "completed") {
          if (assembled) await storage.delete(key).catch(() => undefined);
          else await multipart.abort().catch(() => undefined);
        }
        await settleUploadSession(db, session.id, orgId, settled).catch(() => undefined);
      }
    }

    return Response.json({ error: "Unknown upload action." }, { status: 400 });
  } catch (error) {
    return failure(error);
  }
}

/** A proxied part (Miniflare R2 locally, the filesystem on Railway). */
export async function PUT(request: Request) {
  try {
    await ensureDatabase();
    const key = request.headers.get("X-Upload-Key") ?? "";
    const uploadId = request.headers.get("X-Upload-Id") ?? "";
    const partNumber = Number(request.headers.get("X-Upload-Part"));
    const gate = await logoEditorScope(request);
    if (gate.denied) return gate.denied;
    const { scope } = gate;
    if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1 || !isLogoKeyOf(scope.orgId, key)) {
      return Response.json({ error: "The upload part is invalid." }, { status: 400 });
    }
    /* The same session rule as every POST action, before a byte is read. */
    const session = await findUploadSession(scope.db, { organisationId: scope.orgId, objectKey: key, uploadId });
    const refused = sessionRefusal(session, await uploaderOf(scope));
    if (refused || !session) {
      return Response.json({ error: refused?.error }, { status: refused?.status ?? 404 });
    }
    const bytes = await request.arrayBuffer();
    const expected = partPlan(Number(session.byteSize), Number(session.partSize)).sizeOf(partNumber);
    if (!expected || bytes.byteLength !== expected || bytes.byteLength > UPLOAD_PART_SIZE) {
      return Response.json({ error: "That part is not the size this upload planned." }, { status: 400 });
    }
    const storage = await logoBucket();
    if (!storage) return storageUnavailable();
    const part = await storage.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, bytes);
    return Response.json({ part });
  } catch (error) {
    return failure(error);
  }
}
