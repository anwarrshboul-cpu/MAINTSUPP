/**
 * `/api/reports/exports` — the Word, PDF and Excel files, and the only way to
 * get one.
 *
 * THE RULE THIS ROUTE EXISTS TO KEEP
 *
 * It never accepts a payload from the browser. A `CombinedReportPayload` posted
 * by a client would let anyone produce a MAINTSUPP-branded invoice for any
 * amount, correctly formatted, with a real invoice number on it — so the only
 * two sources of a payload here are the workspace's own endpoints:
 *
 *   - `documentId` → `GET /api/reports/documents/:id`, which returns the stored
 *     SNAPSHOT once a document is Finalised and a fresh computation before. That
 *     is the whole point of the snapshot: an invoice issued in February must not
 *     be restated by a fee changed in March, and getting the payload from that
 *     endpoint means the exporter inherits the rule rather than reimplementing
 *     it.
 *   - no `documentId` → `POST /api/reports/preview`, which computes from the
 *     database for a period the caller names. The caller chooses the QUESTION;
 *     the server decides every ANSWER.
 *
 * Fetching over HTTP rather than importing C1's engine is deliberate. The
 * export inherits that endpoint's permission check, its finals-only narrowing
 * for a reader without `board.edit`, and its snapshot behaviour, in one place —
 * and a rule added there later applies here with no second edit. The subrequest
 * is same-origin and carries the caller's own cookie, so it can never see more
 * than the caller can.
 *
 * PERMISSION
 *
 * `data.export` — "Download boards, sites and reports as CSV" in the capability
 * catalogue, which is the capability that already means "may take a file away".
 * A Viewer holds it by default, which is exactly the owner's stated rule: a
 * Viewer downloads permitted finals and cannot edit or finalise. The narrowing
 * to permitted finals is not re-implemented here — it comes back with the
 * document, or does not.
 *
 * NO DELIVERY. There is no email, no share link, no webhook and no upload to
 * anywhere. The file is produced, recorded and returned to the person who asked
 * for it, and that is the whole of it.
 */

import { EXPORT_FORMATS, exportFilename, isDocumentKind } from "../../../lib/reporting/contract";
import type {
  CombinedReportPayload,
  DocumentKind,
  ExportFormat,
} from "../../../lib/reporting/contract";
import { auditActor, recordAudit } from "../../../lib/audit";
import { IDENTITY_HEADER } from "../../../lib/tenant-access";
import { anonymousRefusal, scopedDbWithCapability } from "../../../lib/tenant-db";
import type { ScopedDatabase } from "../../../lib/tenant-db";
import { DOCX_CONTENT_TYPE, renderDocx } from "../../../lib/exports/docx";
import { PDF_CONTENT_TYPE, renderPdf } from "../../../lib/exports/pdf";
import { XLSX_CONTENT_TYPE, renderXlsx } from "../../../lib/exports/xlsx";
import { recordExportHistory } from "./history";

export const dynamic = "force-dynamic";

/* ── Refusals, in the shapes this codebase already uses ──────────────────── */

function unavailable(error?: unknown) {
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  console.error("[/api/reports/exports]", error);
  return Response.json(
    { error: "The document could not be exported." },
    { status: 503 },
  );
}

function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400 });
}

/* ── Input ───────────────────────────────────────────────────────────────── */

function isFormat(value: unknown): value is ExportFormat {
  return (
    typeof value === "string" &&
    (EXPORT_FORMATS as readonly string[]).includes(value)
  );
}

function text(value: unknown, max = 120): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Which document is being downloaded.
 *
 * BACKWARD-TOLERANT ON PURPOSE. A caller that says nothing gets `combined`,
 * which is byte-for-byte the file this route produced before the Report and
 * Invoice tabs existed — including its filename. An unrecognised value is
 * treated the same way rather than refused: the kind selects sections from a
 * payload the SERVER computed, so a bad one can only ever ask for a document
 * this workspace was already entitled to, and answering 400 would break every
 * bookmarked download link the moment the vocabulary grows.
 */
function documentKind(value: unknown): DocumentKind {
  return isDocumentKind(value) ? value : "combined";
}

/* ── Renderers ───────────────────────────────────────────────────────────── */

/**
 * The one place a format maps to a writer.
 *
 * All three take the same `CombinedReportPayload` and the same `DocumentKind`,
 * and none of them is passed anything else — not the request, not the scope,
 * not a database handle. That is the contract's central rule expressed as a
 * function signature: a renderer physically cannot ask a different question
 * than the other two.
 *
 * The kind joined the signature when the screen split into a Report tab and an
 * Invoice tab. It is not a second question — it selects sections from the one
 * payload, through `sectionsFor` in `document-model.ts`, which is the same gate
 * all three walk. A renderer still cannot compute a figure of its own.
 */
const RENDERERS: Record<
  ExportFormat,
  {
    render: (payload: CombinedReportPayload, kind: DocumentKind) => Uint8Array;
    contentType: string;
  }
> = {
  docx: { render: renderDocx, contentType: DOCX_CONTENT_TYPE },
  pdf: { render: renderPdf, contentType: PDF_CONTENT_TYPE },
  xlsx: { render: renderXlsx, contentType: XLSX_CONTENT_TYPE },
};

/* ── Getting the payload, from the workspace and never from the caller ───── */

interface PayloadSource {
  payload: CombinedReportPayload;
  invoiceId: string | null;
}

/**
 * Forward the caller's identity, and nothing else.
 *
 * Only `cookie`, `authorization` and the non-production identity header are
 * copied. Copying the whole header set would carry `content-length`,
 * `content-type` and `accept-encoding` from the outer request into a subrequest
 * with a different body, which is a class of bug that presents as an
 * intermittent truncated read.
 *
 * ── WHY `x-maintsupp-identity` IS IN THAT LIST ─────────────────────────────
 *
 * The header above says the subrequest "can never see more than the caller
 * can". That was only true while the caller's identity lived in the cookie. In
 * development it need not: `IDENTITY_HEADER` in `app/lib/tenant-access.ts` is a
 * deliberate affordance so a test or a `curl` proof can act as somebody without
 * signing in, and dropping it here did not make the subrequest anonymous in the
 * safe sense — an anonymous request in development resolves to the seeded super
 * admin of EVERY organisation.
 *
 * Proven against this server before the header was added: a Demo Client Ltd
 * admin, answered 404 by `GET /api/reports/documents/<id>` as they should be,
 * was handed the whole of Sunnamusk UK's finalised invoice MS-00001 as a PDF by
 * this route — filename, invoice number, £2,040.00 total and all. Production
 * was never exposed (`demoIdentityAllowed()` is false there, and a real caller's
 * identity is in the forwarded cookie), but the export path must not be the one
 * door in this feature where the identity is quietly weaker than at the front.
 */
function forwardedHeaders(request: Request, extra: Record<string, string> = {}) {
  const headers = new Headers({ accept: "application/json", ...extra });
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  const authorization = request.headers.get("authorization");
  if (authorization) headers.set("authorization", authorization);
  const identity = request.headers.get(IDENTITY_HEADER);
  if (identity) headers.set(IDENTITY_HEADER, identity);
  return headers;
}

async function readDocumentPayload(
  request: Request,
  documentId: string,
): Promise<PayloadSource | Response> {
  const target = new URL(`/api/reports/documents/${encodeURIComponent(documentId)}`, request.url);
  const response = await fetch(target, { headers: forwardedHeaders(request) });
  if (!response.ok) {
    // The document endpoint's own refusal, passed straight through: a 403 for a
    // draft a Viewer may not see must stay a 403 and must not become a 503.
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  }
  const answer = (await response.json()) as {
    payload?: CombinedReportPayload;
    document?: { invoiceId?: string };
  };
  if (!answer.payload) {
    return unavailable(new Error("The document endpoint returned no payload."));
  }
  return { payload: answer.payload, invoiceId: answer.document?.invoiceId ?? documentId };
}

async function readPreviewPayload(
  request: Request,
  question: Record<string, unknown>,
): Promise<PayloadSource | Response> {
  const target = new URL("/api/reports/preview", request.url);
  const response = await fetch(target, {
    method: "POST",
    headers: forwardedHeaders(request, { "content-type": "application/json" }),
    body: JSON.stringify(question),
  });
  if (!response.ok) {
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  }
  const answer = (await response.json()) as { payload?: CombinedReportPayload };
  if (!answer.payload) {
    return unavailable(new Error("The preview endpoint returned no payload."));
  }
  return { payload: answer.payload, invoiceId: answer.payload.invoice.invoiceId };
}

/* ── Producing the file ──────────────────────────────────────────────────── */

async function produce(
  request: Request,
  scope: ScopedDatabase,
  source: PayloadSource,
  format: ExportFormat,
  kind: DocumentKind,
): Promise<Response> {
  const { payload, invoiceId } = source;
  const renderer = RENDERERS[format];
  const filename = exportFilename({
    clientName: payload.invoice.clientName,
    periodStart: payload.period.start,
    periodEnd: payload.period.end,
    invoiceNumber: payload.invoice.invoiceNumber,
    format,
    kind,
  });
  const bytes = renderer.render(payload, kind);

  // The audit event first, and unconditionally — it is the record that somebody
  // took a copy of this invoice. See the header of `./history`.
  await recordAudit({
    db: scope.db,
    request,
    organisationId: scope.orgId,
    actor: auditActor(scope),
    action: "report.exported",
    entityType: "invoice",
    entityId: invoiceId,
    summary: `Exported the ${kind} document ${payload.invoice.invoiceNumber ?? "(draft)"} for ${payload.invoice.clientName} as ${format.toUpperCase()}.`,
    detail: {
      format,
      kind,
      filename,
      byteSize: bytes.length,
      periodStart: payload.period.start,
      periodEnd: payload.period.end,
      status: payload.invoice.status,
    },
  });

  if (invoiceId) {
    await recordExportHistory(scope, {
      invoiceId,
      format,
      filename,
      byteSize: bytes.length,
    });
  }

  // `exportFilename` sanitises to `[A-Za-z0-9_.-]`, so the quoted form is
  // sufficient and no RFC 5987 `filename*` is needed. That is a property of the
  // contract's sanitiser rather than an assumption about the data: a client
  // called "Smith & Co. (UK)/EU" cannot reach this header intact.
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": renderer.contentType,
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(bytes.length),
      // A generated invoice is never cacheable: the same URL produces a
      // different document the moment a line is excluded.
      "cache-control": "no-store",
      "x-maintsupp-export-format": format,
      "x-maintsupp-export-kind": kind,
    },
  });
}

/* ── GET — the download links on the Generated Documents screen ──────────── */

export async function GET(request: Request): Promise<Response> {
  try {
    const { denied, scope } = await scopedDbWithCapability(request, "data.export");
    if (denied) return denied;

    const url = new URL(request.url);
    const format = url.searchParams.get("format");
    if (!isFormat(format)) {
      return badRequest(`Ask for one of ${EXPORT_FORMATS.join(", ")}.`);
    }
    const documentId = text(url.searchParams.get("documentId"), 64);
    if (!documentId) {
      return badRequest("A saved document is needed to download a file. Save the draft first.");
    }

    const source = await readDocumentPayload(request, documentId);
    if (source instanceof Response) return source;
    return await produce(request, scope, source, format, documentKind(url.searchParams.get("kind")));
  } catch (error) {
    return unavailable(error);
  }
}

/* ── POST — the generator's export buttons, saved or not ─────────────────── */

export async function POST(request: Request): Promise<Response> {
  try {
    const { denied, scope } = await scopedDbWithCapability(request, "data.export");
    if (denied) return denied;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const format = body["format"];
    if (!isFormat(format)) {
      return badRequest(`Ask for one of ${EXPORT_FORMATS.join(", ")}.`);
    }

    const documentId = text(body["documentId"], 64);
    const source = documentId
      ? await readDocumentPayload(request, documentId)
      : await readPreviewPayload(request, {
          // Exactly the fields the preview endpoint takes, and nothing that
          // could carry a figure. A `payload` in the body is ignored on
          // purpose — see the header.
          periodStart: text(body["periodStart"], 10),
          periodEnd: text(body["periodEnd"], 10),
          preset: text(body["preset"], 32),
          clientId: text(body["clientId"], 64),
        });
    if (source instanceof Response) return source;
    return await produce(request, scope, source, format, documentKind(body["kind"]));
  } catch (error) {
    return unavailable(error);
  }
}
