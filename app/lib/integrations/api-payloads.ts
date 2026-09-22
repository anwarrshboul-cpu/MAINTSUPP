/**
 * §35 — what `/api/v1` publishes about a record. ALLOWLISTS, not redaction
 * lists: a field added to a table tomorrow is not published until somebody
 * decides it should be. (Jobs reuse `exposeRequest`, the portal's own shape.)
 */

import type { sites } from "../../../db/schema";

/** A site as a machine integration sees it: where it is and what it is — no
    access instructions, contacts, landlord or billing. */
export function exposeSite(row: typeof sites.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    code: row.code ?? null,
    type: row.siteTypeValue ?? row.type ?? null,
    region: row.region ?? null,
    lifecycle: row.lifecycle ?? null,
    status: row.status ?? null,
    address: row.address ?? null,
    city: row.city ?? null,
    postcode: row.postcode ?? null,
    country: row.country ?? null,
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
  };
}
