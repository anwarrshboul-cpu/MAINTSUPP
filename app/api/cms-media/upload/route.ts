/**
 * Uploading to the website media library — decision K.
 *
 * #78'S ARCHITECTURE, REUSED, NOT A SECOND WEAKER PATH. Every upload is a
 * multipart upload bound to an `upload_sessions` row (`app/lib/upload-sessions.ts`):
 * the server names the key, the exact size and the part plan at `start`, and
 * every later step must match that row and that uploader. On Vercel the browser
 * PUTs each part straight into the PRIVATE `cms-media` bucket on a write-only URL
 * signed for exactly that part (`presignPart`, 15 minutes); locally and on
 * Railway the parts come through `PUT` here. `complete` then runs the shared
 * verification (`assembleVerifiedUpload`): parts listed from the bucket, each
 * part's MD5 against its stored ETag, the assembled size, and the bytes against
 * the declared type. Sizes are the one policy (`upload-policy.ts`).
 *
 * WHO: MAINTSUPP platform staff with a real session — `scope.platformAdmin`, the
 * gate of every website surface — and nobody else. No workspace role, and no
 * public link, can start, feed, finish or cancel a website upload.
 *
 * WHERE: `CMS_BUCKET`, never `BUCKET`. A session is recorded with
 * `target: "cms-media"`, so the daily sweep aborts an abandoned one in this
 * bucket, and this route refuses to touch a session that is not one of its own.
 *
 *   POST {action:"start", originalName, contentType, byteSize, replaces?}
 *   POST {action:"sign-part", key, uploadId, partNumber}
 *   POST {action:"complete", key, uploadId, parts, title?, altText?, width?, height?, durationMs?}
 *   POST {action:"abort", key, uploadId}
 *   PUT  (headers X-Upload-Key / X-Upload-Id / X-Upload-Part)   a proxied part
 *   PUT  ?rendition=<versionId>   the web-sized WebP the browser made of an image
 */

import { ensureDatabase } from "../../../../db/init";
import { auditActor, recordAudit } from "../../../lib/audit";
import {
  DIMENSION_BYTES,
  DISPLAY_RENDITION,
  cleanMediaMeta,
  imageDimensions,
  isMediaId,
  isVersionId,
  mediaFileName,
  mediaObjectKey,
  mediaSizeRefusal,
  mediaTypeFor,
  newMediaId,
  newVersionId,
  titleFromFileName,
} from "../../../lib/cms-media.ts";
import {
  addVersionAndMakeCurrent,
  createMedia,
  nextVersionNo,
  readMedia,
  readVersion,
  setDisplayRendition,
} from "../../../lib/cms-media-repository.ts";
import { cmsBucket, isMissingBucket, MEDIA_STORAGE_UNAVAILABLE, mediaStorageMissing } from "../../../lib/cms-media-storage.ts";
import { SIGNATURE_REFUSAL, signatureMatches } from "../../../lib/file-signature.ts";
import { assembleVerifiedUpload, claimedPartsFrom } from "../../../lib/upload-assembly.ts";
import { maxUploadSize } from "../../../lib/upload-policy.ts";
import {
  MAX_PENDING_UPLOADS_PER_UPLOADER,
  PART_URL_LIFETIME_SECONDS,
  abandonUploadSession,
  claimFinalize,
  createUploadSession,
  directTransport,
  findUploadSession,
  partPlan,
  pendingUploadCount,
  sessionRefusal,
  settleUploadSession,
  type UploadSession,
} from "../../../lib/upload-sessions.ts";
import { anonymousRefusal, scopedDb } from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

const MAX_PART_SIZE = 5 * 1024 * 1024;
/** The browser's rendition is at most 1600px of WebP; a generous ceiling on what one may weigh. */
const MAX_RENDITION_BYTES = 1_500_000;
const KEY_SHAPE = /^cms\/(med_[a-f0-9]{32})\/(mv_[a-f0-9]{32})\/([a-z0-9][a-z0-9._-]{0,99})$/;

function forbidden() {
  return Response.json({ error: "The website is administered by MAINTSUPP platform staff." }, { status: 403 });
}

async function platformScope(request: Request) {
  const scope = await scopedDb(request);
  if (scope.platformAdmin !== true) return null;
  if (!scope.authenticated) return null;
  return scope;
}

type Scope = NonNullable<Awaited<ReturnType<typeof platformScope>>>;

/** The uploader, as #78 names a signed-in one: the user, never an address the request carried. */
const uploaderOf = (scope: Scope) => `user:${scope.session?.user.id ?? scope.identityEmail.toLowerCase()}`;

function failure(error: unknown) {
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  if (isMissingBucket(error)) return Response.json({ error: mediaStorageMissing() }, { status: 503 });
  console.error("[/api/cms-media/upload]", error instanceof Error ? error.message.slice(0, 300) : "error");
  return Response.json({ error: "The file could not be uploaded to the media library." }, { status: 503 });
}

/**
 * The session behind a key: this workspace's row, THIS route's kind of upload
 * (`target: "cms-media"` and a website key), and this caller's. Anything else is
 * the same 404 — a caller learns nothing about another person's upload.
 */
async function sessionFor(scope: Scope, key: string, uploadId: string): Promise<UploadSession | null> {
  if (!KEY_SHAPE.test(key) || !uploadId) return null;
  const session = await findUploadSession(scope.db, { organisationId: scope.orgId, objectKey: key, uploadId });
  return session && session.target === "cms-media" ? session : null;
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const scope = await platformScope(request);
    if (!scope) return forbidden();
    const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return Response.json({ error: "The request body must be a JSON object." }, { status: 400 });
    }
    const storage = await cmsBucket();
    if (!storage) return Response.json({ error: MEDIA_STORAGE_UNAVAILABLE }, { status: 503 });
    const uploader = uploaderOf(scope);
    const action = String(payload.action ?? "");

    if (action === "start") {
      const originalName = String(payload.originalName ?? "").trim().slice(0, 255);
      const byteSize = Number(payload.byteSize);
      const media = mediaTypeFor(originalName, String(payload.contentType ?? ""));
      if (!originalName || !Number.isInteger(byteSize) || byteSize < 1 || !media) {
        return Response.json(
          { error: "The media library takes JPEG, PNG, WebP or GIF images, MP4 or WebM video, and PDFs." },
          { status: 415 },
        );
      }
      const tooLarge = mediaSizeRefusal(media.kind, byteSize);
      if (tooLarge) return Response.json({ error: tooLarge }, { status: 413 });

      /* A REPLACEMENT keeps the asset and its id — every page that uses it shows
         the new file — so it must be the same kind of thing. */
      let mediaId = newMediaId();
      if (payload.replaces !== undefined && payload.replaces !== null && payload.replaces !== "") {
        if (!isMediaId(payload.replaces)) return Response.json({ error: "Name the asset to replace." }, { status: 400 });
        const existing = await readMedia(scope.db, payload.replaces);
        if (!existing) return Response.json({ error: "There is no such asset to replace." }, { status: 404 });
        if (existing.item.kind !== media.kind) {
          return Response.json(
            { error: `This asset is ${existing.item.kind === "image" ? "an image" : `a ${existing.item.kind}`}; it can only be replaced by another.` },
            { status: 409 },
          );
        }
        mediaId = existing.item.id;
      }
      if ((await pendingUploadCount(scope.db, scope.orgId, uploader)) >= MAX_PENDING_UPLOADS_PER_UPLOADER) {
        return Response.json({ error: "Too many uploads are in progress. Let them finish, then try again." }, { status: 429 });
      }

      const versionId = newVersionId();
      const name = mediaFileName(originalName, media.kind);
      const key = mediaObjectKey(mediaId, versionId, name);
      const upload = await storage.createMultipartUpload(key, {
        httpMetadata: { contentType: media.type, contentDisposition: `inline; filename="${name}"` },
        customMetadata: { mediaId, versionId, originalName, contentType: media.type, byteSize: String(byteSize), uploadedBy: scope.identityEmail.toLowerCase() },
      });
      let session: UploadSession;
      try {
        session = await createUploadSession(scope.db, {
          organisationId: scope.orgId,
          fileId: versionId,
          objectKey: upload.key,
          uploadId: upload.uploadId,
          uploader,
          transport: directTransport(upload) ? "direct" : "proxy",
          contentType: media.type,
          originalName,
          byteSize,
          target: "cms-media",
        });
      } catch (error) {
        await upload.abort().catch(() => undefined);
        throw error;
      }
      return Response.json(
        {
          key: upload.key,
          uploadId: upload.uploadId,
          mediaId,
          versionId,
          transport: session.transport,
          partSize: Number(session.partSize),
          partCount: Number(session.partCount),
          expiresAt: session.expiresAt,
        },
        { status: 201 },
      );
    }

    if (action !== "abort" && action !== "sign-part" && action !== "complete") {
      return Response.json({ error: "Unknown upload action." }, { status: 400 });
    }
    const key = String(payload.key ?? "");
    const uploadId = String(payload.uploadId ?? "");
    const session = await sessionFor(scope, key, uploadId);
    /* Built only for a session this route found, so a malformed key or upload
       id is the same 404 as a stranger's, never a driver error. */
    const multipartOf = (found: UploadSession) => storage.resumeMultipartUpload(found.objectKey, found.uploadId);

    if (action === "abort") {
      if (!session || session.uploader !== uploader) return Response.json({ error: "The upload session is invalid." }, { status: 404 });
      if (session.state === "pending" && (await abandonUploadSession(scope.db, session.id, scope.orgId))) {
        await multipartOf(session).abort();
      }
      return Response.json({ aborted: true });
    }

    if (action === "sign-part") {
      const refused = sessionRefusal(session, uploader);
      if (refused || !session) return Response.json({ error: refused?.error }, { status: refused?.status ?? 404 });
      const direct = directTransport(multipartOf(session));
      if (!direct || session.transport !== "direct") {
        return Response.json({ error: "This upload sends its parts through the server.", transport: "proxy" }, { status: 409 });
      }
      const partNumber = Number(payload.partNumber);
      const size = partPlan(Number(session.byteSize), Number(session.partSize)).sizeOf(partNumber);
      if (!size) return Response.json({ error: "That part is not part of this upload." }, { status: 400 });
      return Response.json({ url: direct.presignPart(partNumber, size, PART_URL_LIFETIME_SECONDS), partNumber, size, expiresIn: PART_URL_LIFETIME_SECONDS });
    }

    if (action === "complete") {
      const [, mediaId, versionId] = KEY_SHAPE.exec(key) ?? [];
      /* A repeated `complete` for an upload this caller already finished answers
         with the asset it made, not a second one. */
      if (session && session.uploader === uploader && session.state === "completed") {
        const done = await readMedia(scope.db, mediaId);
        if (done) return Response.json({ item: done.item });
      }
      const refused = sessionRefusal(session, uploader);
      if (refused || !session) return Response.json({ error: refused?.error }, { status: refused?.status ?? 404 });
      if (session.fileId !== versionId) return Response.json({ error: "The upload session is invalid." }, { status: 404 });
      const media = mediaTypeFor(session.originalName, session.contentType);
      if (!media) return Response.json({ error: "The upload session is invalid." }, { status: 400 });
      const meta = cleanMediaMeta({
        ...(payload.title !== undefined ? { title: payload.title } : {}),
        ...(payload.altText !== undefined ? { altText: payload.altText } : {}),
      });
      if (!meta.ok) return Response.json({ error: meta.reason }, { status: 400 });
      if (!(await claimFinalize(scope.db, session.id, scope.orgId))) {
        return Response.json({ error: "This upload is already being finished." }, { status: 409 });
      }

      let settled: "completed" | "failed" = "failed";
      let assembledOk = false;
      try {
        const assembled = await assembleVerifiedUpload({
          storage,
          multipart: multipartOf(session),
          session,
          claimed: claimedPartsFrom(payload.parts),
          maxBytes: maxUploadSize(media.kind === "video"),
          contentType: media.type,
          originalName: session.originalName,
          readBytes: media.kind === "image" ? DIMENSION_BYTES : 0,
          log: "/api/cms-media/upload",
        });
        if (!assembled.ok) return Response.json({ error: assembled.error }, { status: assembled.status });
        assembledOk = true;

        /* An image's size is read from its own header; a video's is what the
           browser's player measured, bounded — there is no video parser here. */
        const measured = media.kind === "image" ? imageDimensions(media.type, assembled.leading) : null;
        const bounded = (value: unknown, max: number) =>
          Number.isInteger(value) && (value as number) > 0 && (value as number) <= max ? (value as number) : null;
        const width = measured?.width ?? (media.kind === "video" ? bounded(payload.width, 8192) : null);
        const height = measured?.height ?? (media.kind === "video" ? bounded(payload.height, 8192) : null);
        const durationMs = media.kind === "video" ? bounded(payload.durationMs, 24 * 60 * 60 * 1000) : null;

        const existing = await readMedia(scope.db, mediaId);
        const actorEmail = scope.identityEmail.toLowerCase();
        if (existing && existing.item.kind !== media.kind) {
          return Response.json({ error: "An asset can only be replaced by the same kind of file." }, { status: 409 });
        }
        if (!existing) {
          await createMedia(scope.db, {
            id: mediaId,
            kind: media.kind,
            title: meta.title ?? titleFromFileName(session.originalName),
            altText: meta.altText ?? null,
            actorEmail,
          });
        }
        const versionNo = await nextVersionNo(scope.db, mediaId);
        await addVersionAndMakeCurrent(
          scope.db,
          {
            id: versionId,
            mediaId,
            versionNo,
            objectKey: key,
            originalName: session.originalName,
            contentType: media.type,
            byteSize: assembled.size,
            width,
            height,
            durationMs,
            displayKey: null,
            displayWidth: null,
            displayHeight: null,
            uploadedByEmail: actorEmail,
          },
          actorEmail,
        );
        await recordAudit({
          db: scope.db,
          organisationId: scope.orgId,
          actor: auditActor(scope),
          action: existing ? "cms_media.replaced" : "cms_media.uploaded",
          entityType: "cms_media",
          entityId: mediaId,
          summary: existing
            ? `Replaced the website media "${existing.item.title}" with ${session.originalName} (version ${versionNo}).`
            : `Uploaded ${session.originalName} to the website media library.`,
          detail: { mediaId, versionId, versionNo, kind: media.kind, contentType: media.type, byteSize: assembled.size, width, height },
          request,
        });
        settled = "completed";
        const saved = await readMedia(scope.db, mediaId);
        return Response.json({ item: saved?.item ?? null, versionId }, { status: 201 });
      } finally {
        /* Nothing of a refused upload stays in the bucket. `assembleVerifiedUpload`
           cleans up its own refusals; this covers a throw after assembly. */
        if (settled !== "completed" && assembledOk) await storage.delete(key).catch(() => undefined);
        await settleUploadSession(scope.db, session.id, scope.orgId, settled).catch(() => undefined);
      }
    }

    return Response.json({ error: "Unknown upload action." }, { status: 400 });
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: Request) {
  try {
    await ensureDatabase();
    const scope = await platformScope(request);
    if (!scope) return forbidden();
    const storage = await cmsBucket();
    if (!storage) return Response.json({ error: MEDIA_STORAGE_UNAVAILABLE }, { status: 503 });

    /*
     * THE WEB-SIZED RENDITION. Made in the browser (there is no image pipeline on
     * the server) and stored beside the original, once: a version that already
     * has one keeps it, because the bytes under a key never change.
     */
    const renditionOf = new URL(request.url).searchParams.get("rendition");
    if (renditionOf !== null) {
      if (!isVersionId(renditionOf)) return Response.json({ error: "Name the version." }, { status: 400 });
      const version = await readVersion(scope.db, renditionOf);
      if (!version) return Response.json({ error: "There is no such version." }, { status: 404 });
      if (!version.contentType.startsWith("image/") || version.contentType === "image/gif") {
        return Response.json({ error: "Only a still image has a web-sized copy." }, { status: 400 });
      }
      if (version.displayKey) return Response.json({ display: version.displayKey, kept: true });
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength < 1 || bytes.byteLength > MAX_RENDITION_BYTES) {
        return Response.json({ error: "The web-sized copy is too large." }, { status: 413 });
      }
      if (!signatureMatches("image/webp", DISPLAY_RENDITION, bytes.subarray(0, 1024))) {
        return Response.json({ error: SIGNATURE_REFUSAL }, { status: 415 });
      }
      const size = imageDimensions("image/webp", bytes);
      if (!size || Math.max(size.width, size.height) > 2048) {
        return Response.json({ error: "The web-sized copy must be a WebP of at most 2048 pixels." }, { status: 400 });
      }
      const key = mediaObjectKey(version.mediaId, version.id, DISPLAY_RENDITION);
      /* Never over the original (`mediaFileName` keeps the two names apart). */
      if (key === version.objectKey) return Response.json({ error: "The web-sized copy cannot replace the original." }, { status: 409 });
      await storage.put(key, bytes, { httpMetadata: { contentType: "image/webp", contentDisposition: `inline; filename="${DISPLAY_RENDITION}"` } });
      await setDisplayRendition(scope.db, version.id, { key, width: size.width, height: size.height });
      return Response.json({ display: key, width: size.width, height: size.height }, { status: 201 });
    }

    /* A PROXIED PART — only where storage cannot sign part URLs (local, Railway). */
    const key = request.headers.get("X-Upload-Key") ?? "";
    const uploadId = request.headers.get("X-Upload-Id") ?? "";
    const partNumber = Number(request.headers.get("X-Upload-Part"));
    const session = await sessionFor(scope, key, uploadId);
    const refused = sessionRefusal(session, uploaderOf(scope));
    if (refused || !session || !Number.isInteger(partNumber) || partNumber < 1) {
      return Response.json({ error: refused?.error ?? "The upload part is invalid." }, { status: refused?.status ?? 400 });
    }
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_PART_SIZE) {
      return Response.json({ error: "Each upload part must be 5 MB or smaller." }, { status: 413 });
    }
    const expected = partPlan(Number(session.byteSize), Number(session.partSize)).sizeOf(partNumber);
    if (!expected || bytes.byteLength !== expected) {
      return Response.json({ error: "That part is not the size this upload planned." }, { status: 400 });
    }
    const part = await storage.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, bytes);
    return Response.json({ part });
  } catch (error) {
    return failure(error);
  }
}
