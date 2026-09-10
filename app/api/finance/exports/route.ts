/**
 * `/api/finance/exports` — §15.6's mapped CSV for Xero, QuickBooks and Sage.
 *
 * "An API integration can come later, but the export must exist or your
 * bookkeeper does everything twice." This is a CSV and it does not pretend to
 * be anything else: no credential, no upload, no claim of an integration. The
 * field mapping for each of the three is written out in `exports.ts` beside the
 * header list it produces.
 *
 * EVERY CELL IS NEUTRALISED. A value beginning `=`, `+`, `-` or `@` is a
 * formula to a spreadsheet, and a supplier name is attacker-controlled text as
 * far as this route is concerned. `csvCell` prefixes those, and
 * `tests/module-five-finance-analytics.test.mjs` pins it.
 */

import { financeBadRequest, financeUnavailable, guardFinance } from "../../../lib/finance/access";
import { loadExportInvoices } from "../../../lib/finance/analytics";
import {
  EXPORT_FORMATS,
  accountingExport,
  csvDownload,
  isExportFormat,
  safeFilename,
} from "../../../lib/finance/exports";
import { auditActor, recordAudit } from "../../../lib/audit";

export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  try {
    /*
     * `data.export`, not `board.view`. An accounting export is the whole ledger
     * leaving the product in a file, which is a different act from reading a
     * page of it — and it is the capability the rest of this product already
     * uses for exactly that.
     */
    const guard = await guardFinance(request, "ledger.read");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;

    const params = new URL(request.url).searchParams;
    const format = params.get("format") ?? "xero";
    if (!isExportFormat(format)) {
      return financeBadRequest(`Ask for one of: ${EXPORT_FORMATS.join(", ")}.`);
    }
    const direction = params.get("direction");
    if (direction && direction !== "payable" && direction !== "receivable") {
      return financeBadRequest("direction must be payable or receivable.");
    }
    const from = params.get("from");
    const to = params.get("to");
    for (const [name, value] of [["from", from], ["to", to]] as const) {
      if (value && !DAY.test(value)) return financeBadRequest(`${name} must be YYYY-MM-DD.`);
    }

    const rows = await loadExportInvoices(db, orgId, {
      direction: direction === "receivable" ? "receivable" : direction === "payable" ? "payable" : undefined,
      from,
      to,
    });
    const { headers, csv } = accountingExport(format, rows);

    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor(guard.scope),
      action: "finance.exported",
      entityType: "finance_export",
      entityId: format,
      summary: `Exported ${rows.length} invoice${rows.length === 1 ? "" : "s"} for ${format}.`,
      detail: { format, direction: direction ?? "all", from, to, rows: rows.length },
      request,
    });

    /*
     * The count and the headers travel in the response headers so a caller that
     * wants to report "412 rows exported" does not have to parse the file it
     * just downloaded.
     */
    const response = csvDownload(
      safeFilename(`maintsupp-${format}-${new Date().toISOString().slice(0, 10)}.csv`),
      csv,
    );
    response.headers.set("x-maintsupp-rows", String(rows.length));
    response.headers.set("x-maintsupp-columns", String(headers.length));
    return response;
  } catch (error) {
    return financeUnavailable(error, "The accounting export could not be produced.");
  }
}
