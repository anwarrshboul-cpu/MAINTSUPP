"use client";

/**
 * The browser's side of the reporting API, in one file.
 *
 * WHY A CLIENT MODULE AND NOT `fetch` AT EACH BUTTON
 *
 * Ten endpoints, eleven controls and one refusal envelope. Spreading the
 * `fetch` calls through the components means eleven slightly different pieces
 * of error handling, of which nine will eventually swallow the server's message
 * and show "Something went wrong" over a 403 that said exactly what was wrong.
 * Every call here comes back as `{ ok: true, data }` or `{ ok: false, error }`
 * with the server's own sentence preserved, and the components render that
 * sentence.
 *
 * TOLERANT OF THE ENVELOPE, STRICT ABOUT THE CONTENT
 *
 * These endpoints are written by another agent in parallel with this screen, so
 * a list may arrive as `[…]` or as `{ documents: […] }`. `unwrapList` accepts
 * both, because a screen that breaks on the wrapper is a screen that breaks on
 * a detail nobody agreed to. What is NOT guessed at is the content: a payload
 * either has the shape the frozen contract describes or it is an error, and
 * nothing here invents a figure to paper over a missing field.
 */

import type {
  CombinedReportPayload,
  DocumentListRow,
  ExportFormat,
  FinalisationBlocker,
  InvoiceStatus,
} from "../../../lib/reporting/contract";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

const JSON_HEADERS = { "content-type": "application/json", accept: "application/json" };

async function call<T>(
  input: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(input, {
      ...init,
      headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
    });
  } catch {
    // A network failure is not a server refusal and must not read as one.
    return {
      ok: false,
      status: 0,
      error: "The workspace could not be reached. Check the connection and try again.",
    };
  }
  const raw = await response.text();
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `The request was refused (${response.status}).`;
    return { ok: false, status: response.status, error: message };
  }
  return { ok: true, data: (body ?? {}) as T };
}

/** `[…]` or `{ key: […] }` — see the header. */
function unwrapList<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === "object") {
    const inner = (body as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner as T[];
  }
  return [];
}

/* ── Who this reader may bill ────────────────────────────────────────────── */

export interface WorkspaceClient {
  id: string;
  name: string;
}

let contextPromise: Promise<WorkspaceClient[]> | null = null;

/**
 * The workspaces this reader may act in, from `/api/context`.
 *
 * Read here rather than passed down as a prop so that wiring the generator into
 * `ReportsView` needs no new props on a component this agent does not own —
 * `portal-app.tsx` is not ours to widen, and a screen that can answer its own
 * question should. `/api/context` is already fetched on this page by
 * `client-capabilities.ts`; this is a second small read of the same endpoint
 * rather than a change to that module's contract, and it is memoised for the
 * same reason that one is: a dozen controls must not become a dozen round
 * trips. A REJECTED promise is dropped rather than cached, so one transient
 * failure does not leave the client selector permanently empty.
 */
export function fetchWorkspaceClients(): Promise<WorkspaceClient[]> {
  if (!contextPromise) {
    contextPromise = fetch("/api/context", { headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error("context unavailable");
        const body = (await response.json()) as {
          context?: {
            organisations?: Array<{ id: string; name: string }>;
            currentOrganisation?: { id: string; name: string };
          };
        };
        const list = body.context?.organisations ?? [];
        if (list.length) return list.map((entry) => ({ id: entry.id, name: entry.name }));
        const current = body.context?.currentOrganisation;
        return current ? [{ id: current.id, name: current.name }] : [];
      })
      .catch((error: unknown) => {
        contextPromise = null;
        throw error;
      });
  }
  return contextPromise;
}

/* ── Billing configuration ───────────────────────────────────────────────── */

/**
 * What the generator prepopulates from.
 *
 * The owner's instruction was "never make the user retype what is already
 * stored", so every field the setup form offers that has a stored default is
 * listed here. Fields are optional because this is read across a version
 * boundary — a settings row written before a column existed comes back without
 * it, and the form must fall back rather than write `undefined` into an
 * invoice.
 */
export interface BillingSettings {
  organisationId?: string;
  clientName?: string;
  billingAddress?: string | null;
  currency?: string;
  vatEnabled?: boolean;
  vatRateBasisPoints?: number;
  vatNumber?: string | null;
  paymentTermsDays?: number | null;
  paymentTerms?: string | null;
  defaultFeePence?: number | null;
  invoiceNumberPrefix?: string | null;
  invoiceSequence?: number | null;
  clientReference?: string | null;
  purchaseOrder?: string | null;
}

export function fetchBillingSettings(): Promise<ApiResult<{ settings: BillingSettings }>> {
  return call<{ settings: BillingSettings }>("/api/reports/settings");
}

/* ── Preview ─────────────────────────────────────────────────────────────── */

export interface PreviewQuestion {
  periodStart: string;
  periodEnd: string;
  preset: string;
  clientId?: string;
}

export interface PreviewResult {
  payload: CombinedReportPayload;
  blockers: FinalisationBlocker[];
  warnings: FinalisationBlocker[];
}

/**
 * Compute a payload. PERSISTS NOTHING — the contract and C1's route both say
 * so, and the Generate Preview control depends on it: the owner's rule is that
 * preview never finalises, and the safest way to keep that true is for the
 * preview path to have no write in it at all.
 */
export async function fetchPreview(
  question: PreviewQuestion,
): Promise<ApiResult<PreviewResult>> {
  const result = await call<Partial<PreviewResult>>("/api/reports/preview", {
    method: "POST",
    body: JSON.stringify(question),
  });
  if (!result.ok) return result;
  if (!result.data.payload) {
    return { ok: false, status: 502, error: "The preview came back without a payload." };
  }
  return {
    ok: true,
    data: {
      payload: result.data.payload,
      blockers: result.data.blockers ?? [],
      warnings: result.data.warnings ?? [],
    },
  };
}

/* ── Documents ───────────────────────────────────────────────────────────── */

export async function fetchDocuments(): Promise<ApiResult<DocumentListRow[]>> {
  const result = await call<unknown>("/api/reports/documents");
  if (!result.ok) return result;
  return { ok: true, data: unwrapList<DocumentListRow>(result.data, "documents") };
}

export interface DocumentDetail {
  document: DocumentListRow & { invoiceId: string };
  payload: CombinedReportPayload;
  blockers: FinalisationBlocker[];
  /** True once the document is Finalised and the payload came from the store. */
  snapshot: boolean;
}

export async function fetchDocument(id: string): Promise<ApiResult<DocumentDetail>> {
  const result = await call<Partial<DocumentDetail>>(
    `/api/reports/documents/${encodeURIComponent(id)}`,
  );
  if (!result.ok) return result;
  if (!result.data.payload || !result.data.document) {
    return { ok: false, status: 502, error: "The document came back incomplete." };
  }
  return {
    ok: true,
    data: {
      document: result.data.document as DocumentDetail["document"],
      payload: result.data.payload,
      blockers: result.data.blockers ?? [],
      snapshot: Boolean(result.data.snapshot),
    },
  };
}

/** The header fields the setup form owns. */
export interface DocumentHeaderInput {
  periodStart?: string;
  periodEnd?: string;
  preset?: string;
  invoiceDate?: string | null;
  dueAt?: string | null;
  purchaseOrder?: string | null;
  clientReference?: string | null;
  internalReference?: string | null;
  paymentTerms?: string | null;
  currency?: string;
  vatEnabled?: boolean;
  vatRateBasisPoints?: number;
  clientNote?: string | null;
  internalNote?: string | null;
}

export function saveDraft(
  input: DocumentHeaderInput & { clientId?: string },
): Promise<ApiResult<{ document?: { invoiceId?: string }; invoiceId?: string }>> {
  return call("/api/reports/documents", { method: "POST", body: JSON.stringify(input) });
}

export function patchDocument(
  id: string,
  input: DocumentHeaderInput,
): Promise<ApiResult<unknown>> {
  return call(`/api/reports/documents/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

/**
 * Include or exclude one site line.
 *
 * `reason` is required by the API when excluding, and the dialog in the
 * generator refuses to submit without one — but the check that matters is the
 * server's, and the audit row (who, when, why) is written there. This is the
 * courtesy copy of that rule; see `app/lib/client-capabilities.ts` for the same
 * distinction stated about capabilities.
 */
export function setLineInclusion(
  id: string,
  input: { lineNo: number; siteId: string | null; included: boolean; reason?: string },
): Promise<ApiResult<unknown>> {
  return call(`/api/reports/documents/${encodeURIComponent(id)}/lines`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function addAdjustment(
  id: string,
  input: { kind: "adjustment" | "credit"; amountPence: number; reason: string },
): Promise<ApiResult<unknown>> {
  return call(`/api/reports/documents/${encodeURIComponent(id)}/adjustments`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export type DocumentAction = "recalculate" | "submit" | "approve" | "finalise" | "void";

export function runDocumentAction(
  id: string,
  action: DocumentAction,
  reason?: string,
): Promise<ApiResult<{ status?: InvoiceStatus; blockers?: FinalisationBlocker[] }>> {
  return call(`/api/reports/documents/${encodeURIComponent(id)}/actions`, {
    method: "POST",
    body: JSON.stringify({ action, reason }),
  });
}

/* ── Exports ─────────────────────────────────────────────────────────────── */

/**
 * The download URL for a saved document.
 *
 * A plain link, so the browser's own download machinery handles it — including
 * the ones a `fetch` + blob dance gets wrong, like a session that expired
 * mid-click (the link shows the sign-in page; the blob dance downloads a file
 * containing the sign-in page).
 */
export function exportUrl(documentId: string, format: ExportFormat): string {
  return `/api/reports/exports?documentId=${encodeURIComponent(documentId)}&format=${format}`;
}

/**
 * Export a preview that has not been saved yet.
 *
 * POSTs the QUESTION — the period and the client — and never the payload. The
 * server recomputes and renders; nothing a browser sends can put a figure in a
 * document. See the header of `app/api/reports/exports/route.ts`.
 */
export async function exportPreview(
  question: PreviewQuestion,
  format: ExportFormat,
): Promise<ApiResult<{ blob: Blob; filename: string }>> {
  let response: Response;
  try {
    response = await fetch("/api/reports/exports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...question, format }),
    });
  } catch {
    return { ok: false, status: 0, error: "The workspace could not be reached." };
  }
  if (!response.ok) {
    const raw = await response.text();
    let message = `The export was refused (${response.status}).`;
    try {
      const parsed = JSON.parse(raw) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      // A non-JSON refusal keeps the generic sentence above.
    }
    return { ok: false, status: response.status, error: message };
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  return {
    ok: true,
    data: { blob: await response.blob(), filename: match?.[1] ?? `report.${format}` },
  };
}

/** Hand a produced blob to the browser as a download, then release it. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next tick rather than immediately: revoking synchronously
  // after `click()` races the download starting in some browsers and produces a
  // zero-byte file.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
