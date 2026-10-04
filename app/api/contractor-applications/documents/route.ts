import { and, eq } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { contractorApplications } from "../../../../db/schema";
import { WEBSITE_LEADS_WORKSPACE_ID } from "../../../../db/website-leads-workspace";
import { SIGNATURE_BYTES, SIGNATURE_REFUSAL, signatureMatches } from "../../../lib/file-signature";
import { anonymousRefusal, scopedDb } from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

/**
 * /api/contractor-applications/documents (2026-10-04) — insurance and
 * certificates attached to a contractor application.
 *
 *   POST  multipart { token, file } — the applicant, right after submitting,
 *         with the one-hour key the application answered with. Nobody else
 *         can attach anything: no key, no write.
 *   GET   ?application=<id>&doc=<id> — MAINTSUPP staff only (platform admins),
 *         from the Applications inbox. Always a download, never rendered.
 *
 * Files stay private in the bucket under the Website Leads workspace and are
 * served only through this route.
 */

const MAX_DOCUMENTS = 6;
/* The direct upload ceiling every other door keeps (`DIRECT_UPLOAD_LIMIT`):
   the form downsizes photographs before sending, so this is a PDF's limit. */
const MAX_BYTES = 900 * 1024;
const ALLOWED = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

type StoredDocument = { id: string; key: string; name: string; type: string; size: number; uploadedAt: string };

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function bucket() {
  const { env } = await import("cloudflare:workers");
  return (env as unknown as { BUCKET?: R2Bucket }).BUCKET;
}

function readDocuments(value: string | null | undefined): StoredDocument[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? (parsed as StoredDocument[]) : [];
  } catch {
    return [];
  }
}

function cleanName(name: string) {
  const cleaned = name.replace(/[^\w.\- ]+/g, "").replace(/\s+/g, "-").slice(-80);
  return cleaned || "document";
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const form = await request.formData().catch(() => null);
    const token = String(form?.get("token") ?? "").trim();
    const file = form?.get("file");
    if (!/^[a-f0-9]{64}$/.test(token) || !(file instanceof File)) {
      return Response.json({ error: "That upload could not be accepted." }, { status: 400 });
    }
    const { db } = await scopedDb(request, { allowAnonymous: true });
    const [application] = await db
      .select()
      .from(contractorApplications)
      .where(
        and(
          eq(contractorApplications.uploadTokenHash, await sha256Hex(token)),
          eq(contractorApplications.organisationId, WEBSITE_LEADS_WORKSPACE_ID),
        ),
      )
      .limit(1);
    if (!application || !application.uploadTokenExpiresAt || new Date(application.uploadTokenExpiresAt).getTime() < Date.now()) {
      return Response.json(
        { error: "This upload link has expired. Reply to our confirmation email with the document instead." },
        { status: 403 },
      );
    }
    const documents = readDocuments(application.documents);
    if (documents.length >= MAX_DOCUMENTS) {
      return Response.json({ error: `Up to ${MAX_DOCUMENTS} documents can be attached.` }, { status: 409 });
    }
    const type = (file.type || "").toLowerCase();
    if (!ALLOWED.has(type)) {
      return Response.json({ error: "Attach a PDF or a photo (JPG or PNG)." }, { status: 415 });
    }
    if (file.size > MAX_BYTES) {
      return Response.json(
        { error: "That file is over 900 KB. Reply to our confirmation email with it instead." },
        { status: 413 },
      );
    }
    const bytes = await file.arrayBuffer();
    if (!signatureMatches(type, file.name, new Uint8Array(bytes, 0, Math.min(bytes.byteLength, SIGNATURE_BYTES)))) {
      return Response.json({ error: SIGNATURE_REFUSAL }, { status: 415 });
    }
    const storage = await bucket();
    if (!storage) return Response.json({ error: "File storage is unavailable." }, { status: 503 });

    const id = crypto.randomUUID();
    const name = cleanName(file.name);
    const key = `${WEBSITE_LEADS_WORKSPACE_ID}/contractor-applications/${application.id}/${id}-${name}`;
    await storage.put(key, bytes, {
      httpMetadata: { contentType: type, contentDisposition: `attachment; filename="${name}"` },
      customMetadata: { applicationId: application.id },
    });
    const next: StoredDocument[] = [
      ...documents,
      { id, key, name, type, size: file.size, uploadedAt: new Date().toISOString() },
    ];
    await db
      .update(contractorApplications)
      .set({ documents: JSON.stringify(next) })
      .where(eq(contractorApplications.id, application.id));
    return Response.json({ ok: true, document: { id, name, size: file.size } }, { status: 201 });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    console.error("[contractor-applications/documents] upload failed", error instanceof Error ? error.message : error);
    return Response.json({ error: "The document could not be uploaded. Please try again." }, { status: 503 });
  }
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const scope = await scopedDb(request);
    /* A real session as well as platform staff: a demo identity is never enough. */
    if (!scope.platformAdmin || !scope.authenticated) {
      return Response.json({ error: "Only MAINTSUPP staff can open application documents." }, { status: 403 });
    }
    const url = new URL(request.url);
    const applicationId = url.searchParams.get("application") ?? "";
    const documentId = url.searchParams.get("doc") ?? "";
    const [application] = await scope.db
      .select()
      .from(contractorApplications)
      .where(eq(contractorApplications.id, applicationId))
      .limit(1);
    const document = readDocuments(application?.documents).find((entry) => entry.id === documentId);
    if (!application || !document) return Response.json({ error: "Document not found." }, { status: 404 });
    const storage = await bucket();
    const object = storage ? await storage.get(document.key) : null;
    if (!object) return Response.json({ error: "Document not found." }, { status: 404 });
    return new Response(object.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${document.name}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json({ error: "The document could not be opened right now." }, { status: 503 });
  }
}
