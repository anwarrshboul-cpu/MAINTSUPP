/**
 * What a maintenance request looks like once it leaves the server.
 *
 * Held here rather than in one of the two routes that need it because the list
 * below is a redaction list, and a redaction list that exists twice is one
 * upload token away from leaking. `/api/maintenance` returns rows for the
 * dashboard and `/api/board` returns the rows placed on a board; both go to the
 * browser, so both strip the same fields.
 */
import type { maintenanceRequests } from "../../db/schema";
import type { MaintenanceRequest } from "./types";

export function exposeRequest(
  row: typeof maintenanceRequests.$inferSelect,
): MaintenanceRequest {
  const payload = { ...row } as Record<string, unknown>;
  // A live upload token: anyone holding it can attach files to the job.
  delete payload.publicUploadTokenHash;
  delete payload.publicUploadTokenExpiresAt;
  // Internal bookkeeping the client has no use for.
  delete payload.createdByEmail;
  delete payload.organisationId;
  delete payload.legacyClientId;
  delete payload.createdAt;
  delete payload.updatedAt;
  return payload as unknown as MaintenanceRequest;
}
