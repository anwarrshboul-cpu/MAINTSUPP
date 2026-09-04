/**
 * Which documents were exported, in which format, by whom.
 *
 * WHY RAW SQL AND NOT THE SCHEMA OBJECT
 *
 * `invoice_exports` arrives with the billing schema addendum, which the main
 * agent applies to `db/schema.ts` and `db/init.ts` — files this agent does not
 * own and must not edit. Importing `invoiceExports` from `db/schema` would
 * therefore be an import of something that may not be there yet, which is a
 * build error rather than a missing row. A parameterised `INSERT` through the
 * same D1 handle costs nothing extra: it passes through
 * `db/sqlite-to-postgres.ts` exactly as a Drizzle statement does, so it behaves
 * the same locally and deployed.
 *
 * WHEN C1 PUBLISHES A HELPER, THIS BECOMES A CALL TO IT. The shape below is the
 * addendum's column list verbatim, so the swap is a one-line change.
 *
 * WHY A FAILED HISTORY ROW DOES NOT FAIL THE DOWNLOAD
 *
 * Deliberate, and worth being explicit about because the opposite is often the
 * right answer. The AUTHORITATIVE record of who took a copy of an invoice is
 * the audit event — `report.exported`, written by the route before this is
 * called, through the same `recordAudit()` every other privileged action in
 * this codebase uses. This table is the "Formats" column of the Generated
 * Documents screen: a convenience index, not the audit trail. Refusing a
 * download the caller is entitled to because a convenience index could not be
 * written would be the wrong trade, and it is only safe to make because the
 * real record is written somewhere else first.
 */

import { sql } from "drizzle-orm";
import type { ExportFormat } from "../../../lib/reporting/contract";
import type { ScopedDatabase } from "../../../lib/tenant-db";

export interface ExportHistoryEntry {
  invoiceId: string;
  format: ExportFormat;
  filename: string;
  byteSize: number;
}

export async function recordExportHistory(
  scope: ScopedDatabase,
  entry: ExportHistoryEntry,
): Promise<boolean> {
  try {
    await scope.db.run(sql`
      INSERT INTO invoice_exports
        (id, organisation_id, invoice_id, format, filename, attachment_id, byte_size, actor_email, created_at)
      VALUES (
        ${crypto.randomUUID()},
        ${scope.orgId},
        ${entry.invoiceId},
        ${entry.format},
        ${entry.filename},
        ${null},
        ${entry.byteSize},
        ${scope.identityEmail.toLowerCase()},
        ${new Date().toISOString()}
      )
    `);
    return true;
  } catch (error) {
    // Logged, not thrown. See the header.
    console.error("[/api/reports/exports] export history not recorded", error);
    return false;
  }
}
