/**
 * FINISHING A MULTIPART UPLOAD — the verification #78 established, as one
 * function any bucket can use.
 *
 * `app/api/files/multipart/route.ts` runs this same sequence inline, between the
 * steps that belong to a document (anchors, lineage, the review queue), and is
 * deliberately not rewritten here. The website media library (decision K) needs
 * the sequence without the document, against its own bucket, so it lives here
 * once instead of being typed out a second time:
 *
 *   1. WHICH PARTS — on a direct upload the parts never passed through this
 *      server, so the BUCKET is asked (ListParts) and must hold exactly the parts
 *      `start` planned (`partsMatchPlan`);
 *   2. WHAT EACH PART HOLDS — each part's stored ETag must equal the MD5 the
 *      browser declared for the bytes it sent. Measured on Supabase Storage: a
 *      part URL honoured an unsigned `x-amz-copy-source` and filled the part with
 *      ANOTHER object's bytes; such a part carries the source's MD5, which nobody
 *      can declare without already holding the source;
 *   3. ASSEMBLY — with the bucket's own size limit reported as what it is;
 *   4. THE ASSEMBLED SIZE — equal to the size `start` agreed, and within the one
 *      size policy;
 *   5. WHAT THE BYTES ARE — the first bytes read back and checked against the type
 *      the file claims (`signatureMatches`).
 * Any failure cleans up after itself: parts never assembled are aborted, an
 * assembled object that failed a check is deleted. Nothing a refused upload sent
 * stays in the bucket.
 */

import { partPlan, partsMatchPlan, directTransport, type UploadSession } from "./upload-sessions.ts";
import { SIGNATURE_BYTES, SIGNATURE_REFUSAL, signatureMatches } from "./file-signature.ts";

type Storage = R2Bucket;
type Multipart = ReturnType<R2Bucket["resumeMultipartUpload"]>;

export type ClaimedPart = { partNumber: number; etag: string };

/**
 * The part list a browser sends with `complete`, cleaned — its etags kept
 * EXACTLY as sent. A proxied part's etag is the storage driver's own opaque
 * token, handed back to it at assembly, and some drivers' tokens are
 * case-sensitive: measured on Miniflare's R2, a lower-cased etag is "one or more
 * of the specified parts could not be found". Only the direct path's MD5
 * comparison is case-insensitive, and it lower-cases both sides itself.
 */
export function claimedPartsFrom(value: unknown): ClaimedPart[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((part) => {
      const record = (part ?? {}) as Record<string, unknown>;
      return { partNumber: Number(record.partNumber), etag: String(record.etag ?? "").trim() };
    })
    .filter((part) => Number.isInteger(part.partNumber) && part.partNumber > 0 && part.etag.length > 0);
}

export type AssemblyResult =
  | { ok: true; size: number; leading: Uint8Array }
  | { ok: false; status: number; error: string };

/**
 * Assemble and verify the upload `session` describes. `readBytes` is how much of
 * the start of the file to hand back (at least `SIGNATURE_BYTES`), for a caller
 * that reads more than the signature from it — image dimensions, for one.
 */
export async function assembleVerifiedUpload(input: {
  storage: Storage;
  multipart: Multipart;
  session: UploadSession;
  claimed: ClaimedPart[];
  maxBytes: number;
  contentType: string;
  originalName: string;
  readBytes?: number;
  log: string;
}): Promise<AssemblyResult> {
  const { storage, multipart, session, claimed } = input;
  const key = session.objectKey;
  const plan = partPlan(Number(session.byteSize), Number(session.partSize));
  const refuse = async (status: number, error: string, assembled: boolean): Promise<AssemblyResult> => {
    if (assembled) await storage.delete(key).catch(() => undefined);
    else await multipart.abort().catch(() => undefined);
    return { ok: false, status, error };
  };

  let parts: ClaimedPart[];
  const direct = session.transport === "direct" ? directTransport(multipart) : null;
  if (direct) {
    const listed = await direct.listParts();
    if (!partsMatchPlan(listed, plan)) {
      console.error(`[${input.log}] parts do not match the plan`, {
        planned: plan.partCount,
        listed: listed.map((part) => [part.partNumber, part.size]),
      });
      return refuse(400, "Part of the file did not arrive. Start the upload again.", false);
    }
    const declared = new Map(claimed.map((part) => [part.partNumber, part.etag.toLowerCase()]));
    if (!listed.every((part) => declared.get(part.partNumber) === part.etag.toLowerCase())) {
      console.error(`[${input.log}] part contents do not match what was sent`, { planned: plan.partCount, declared: declared.size });
      return refuse(400, "The file's parts do not match what was sent. Start the upload again.", false);
    }
    parts = listed.map(({ partNumber, etag }) => ({ partNumber, etag }));
  } else {
    /* Proxied parts DID pass through the route's PUT, where each was checked
       against the same plan; their etags came back from the bucket there. */
    parts = claimed;
    if (!parts.length || parts.length > 100 || parts.length !== plan.partCount) {
      return refuse(400, "The uploaded file parts are incomplete.", false);
    }
  }

  try {
    await multipart.complete(parts);
  } catch (error) {
    if (error instanceof Error && /EntityTooLarge|too large|maximum allowed size/i.test(error.message)) {
      return refuse(413, "The file store refused a file this large.", false);
    }
    await multipart.abort().catch(() => undefined);
    throw error;
  }

  const head = await storage.head(key);
  const size = head?.size ?? -1;
  if (size !== Number(session.byteSize) || size > input.maxBytes) {
    return refuse(400, "The completed file size could not be verified.", true);
  }

  const length = Math.max(SIGNATURE_BYTES, input.readBytes ?? 0);
  const sample = await storage.get(key, { range: { offset: 0, length: Math.min(length, size) } });
  const leading = sample ? new Uint8Array(await new Response(sample.body as ReadableStream).arrayBuffer()) : new Uint8Array(0);
  if (!signatureMatches(input.contentType, input.originalName, leading.subarray(0, SIGNATURE_BYTES))) {
    return refuse(415, SIGNATURE_REFUSAL, true);
  }
  return { ok: true, size, leading };
}
