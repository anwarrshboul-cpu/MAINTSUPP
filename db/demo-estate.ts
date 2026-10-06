/**
 * The demo workspace's one UPDATE path, kept OUT of `demo-workspace.ts`.
 *
 * That file promises "additive only — no UPDATE" and its tests hold it to the
 * promise, because its safety rests on it. This module is the deliberate
 * exception the owner asked for on 2026-10-06 (ten sites, five in London, all
 * accurate), and it is written to the same isolation rule: every statement
 * names `DEMO_WORKSPACE_ID` in its WHERE clause and touches `demo-` rows only.
 */

import type { getD1 } from ".";
import {
  DEMO_EXPIRY_OFFSETS,
  DEMO_REQUIREMENTS,
  DEMO_SITE_ORDER,
  DEMO_SITES,
  DEMO_WORKSPACE_ID,
  day,
  siteId,
} from "./demo-workspace";

type D1DatabaseLike = Awaited<ReturnType<typeof getD1>>;

/**
 * THE DEMO ESTATE, BROUGHT INTO LINE (2026-10-06).
 *
 * The owner: "I want to have 10 sites in the UK, five of them in London … these
 * 10 sites have to be reflected on the Store Documentation, on the assets, on
 * the documentation. Everything centralised and accurate."
 *
 * The seeders in `demo-workspace.ts` are INSERT OR IGNORE, so on a workspace that already exists
 * they add the two new sites but cannot rename the two that moved to London.
 * This does the rest, for THIS organisation only (every statement names
 * `DEMO_WORKSPACE_ID` and touches `demo-` rows only):
 *
 *  · each site's name, type, region, address, town, postcode and manager are
 *    set from `DEMO_SITES`, and its position from `DEMO_SITE_ORDER`;
 *  · every certificate's expiry is re-based on today from
 *    `DEMO_EXPIRY_OFFSETS`, so "expires in 14 days" is true on the day this
 *    runs rather than on the day the workspace was first seeded;
 *  · each site gets its Store Documentation row — Store Type, Store Address,
 *    Access Request and the expiry date of every certificate the register
 *    holds — in "Current stores", or "Other" for the warehouse;
 *  · each site is placed in the matching site group.
 *
 * Each site's own asset (`site-unit-…`) follows from `reconcileSiteUnits`,
 * which `ensureSiteUnitsAndGroupOrder` backfills right after this runs.
 */
export async function reconcileDemoEstate(d1: D1DatabaseLike, today: string): Promise<void> {
  const demo = (await d1
    .prepare("SELECT id FROM organisations WHERE id = ? AND status = 'active' LIMIT 1")
    .bind(DEMO_WORKSPACE_ID)
    .first()) as { id?: string } | null;
  if (!demo?.id) return;

  const expiryColumn: Record<string, string> = {
    "Fire Alarm": "fireAlarmExpiry",
    "Fire Extinguisher": "fireExtinguisherExpiry",
    "Emergency Lighting": "emergencyLightingExpiry",
    "Electrical Wiring": "electricalExpiry",
    "PAT Test": "patExpiry",
    "Water Hygiene": "waterHygieneExpiry",
    PLI: "pliExpiry",
  };
  const column = (key: string) => `seed-${DEMO_WORKSPACE_ID}-store-documentation-${key}`;
  const now = new Date().toISOString();

  for (const site of DEMO_SITES) {
    const id = siteId(site.key);
    const exists = (await d1.prepare("SELECT id FROM sites WHERE id = ? AND organisation_id = ? LIMIT 1").bind(id, DEMO_WORKSPACE_ID).first()) as { id?: string } | null;
    if (!exists?.id) continue;
    const position = DEMO_SITE_ORDER.indexOf(site.key);
    await d1
      .prepare(
        `UPDATE sites
            SET name = ?, type = ?, site_type_value = ?, region = ?, address = ?, address_line1 = ?,
                city = ?, postcode = ?, manager = ?, manager_name = ?, position = ?, updated_at = ?
          WHERE id = ? AND organisation_id = ?`,
      )
      .bind(
        site.name, site.type, site.type, site.region, site.address, site.address,
        site.city, site.postcode, site.manager, site.manager, position < 0 ? 99 : position, now,
        id, DEMO_WORKSPACE_ID,
      )
      .run();

    /* Certificates, re-based on today. */
    const offsets = DEMO_EXPIRY_OFFSETS[site.key] ?? [];
    for (const index of DEMO_REQUIREMENTS.keys()) {
      const offset = offsets[index];
      const date = offset === null || offset === undefined ? null : day(today, offset);
      await d1
        .prepare(
          `UPDATE compliance_documents
              SET expiry_date = ?, status = ?, issued_by = ?
            WHERE id = ? AND organisation_id = ?`,
        )
        .bind(
          date,
          /* The seed's own two words; the register derives the band from the date. */
          date === null ? "Missing" : "Compliant",
          date === null ? null : "Demo Compliance Partner",
          `demo-compliance-${site.key}-${index}`,
          DEMO_WORKSPACE_ID,
        )
        .run();
    }

    /* The Store Documentation row. */
    const docId = `demo-storedoc-${site.key}`;
    const group = site.type === "Warehouse" ? "other" : "topics";
    await d1
      .prepare(
        `INSERT OR IGNORE INTO maintenance_requests
           (id, organisation_id, site_id, source, title, description, location, requester, contact,
            category, engineer, tier, priority, stage, status, contractor, assignee, requested_at,
            archived, created_by_email, reference)
         VALUES (?, ?, ?, 'Store Documentation', ?, '', '', '', '', '', '', 0, '', 'Incoming',
                 'Pending Approval', '', '', ?, 0, 'demo@example.com', ?)`,
      )
      .bind(docId, DEMO_WORKSPACE_ID, id, site.name, day(today, -200), `DEMO-SD-${site.key.toUpperCase()}`)
      .run();
    await d1
      .prepare(`UPDATE maintenance_requests SET title = ?, site_id = ? WHERE id = ? AND organisation_id = ?`)
      .bind(site.name, id, docId, DEMO_WORKSPACE_ID)
      .run();
    await d1
      .prepare(
        `INSERT OR IGNORE INTO maintenance_group_items (request_id, organisation_id, board_id, group_id, position)
         VALUES (?, ?, 'store-documentation', ?, ?)`,
      )
      .bind(docId, DEMO_WORKSPACE_ID, `seed-${DEMO_WORKSPACE_ID}-store-documentation-${group}`, position < 0 ? 99 : position)
      .run();
    const cells: Array<[string, string]> = [
      ["storeType", site.type === "Flagship" || site.type === "Store" ? "Inline" : site.type],
      ["storeAddress", `${site.address} ${site.postcode}`],
      ["accessRequest", `${site.key}@example.com`],
    ];
    for (const [index, requirement] of DEMO_REQUIREMENTS.entries()) {
      const offset = offsets[index];
      const key = expiryColumn[requirement];
      if (key) cells.push([key, offset === null || offset === undefined ? "" : day(today, offset)]);
    }
    for (const [key, value] of cells) {
      const cellId = `demo-storedoc-cell-${site.key}-${key}`;
      await d1
        .prepare(
          `INSERT OR IGNORE INTO maintenance_board_cells (id, organisation_id, board_id, request_id, column_id, value)
           SELECT ?, ?, 'store-documentation', ?, c.id, ?
             FROM maintenance_board_columns c
            WHERE c.id = ? AND c.organisation_id = ?`,
        )
        .bind(cellId, DEMO_WORKSPACE_ID, docId, value, column(key), DEMO_WORKSPACE_ID)
        .run();
      await d1
        .prepare(`UPDATE maintenance_board_cells SET value = ?, updated_at = ? WHERE id = ? AND organisation_id = ?`)
        .bind(value, now, cellId, DEMO_WORKSPACE_ID)
        .run();
    }

    /* The site's own asset — the same row `reconcileSiteUnits` keeps in step
       (app/lib/site-units.ts). Written here because the two new sites are
       created after the migration that backfills every other site's. */
    await d1
      .prepare(
        `INSERT OR IGNORE INTO units
           (id, organisation_id, site_id, name, category, kind, status, location_in_site, position, notes)
         VALUES (?, ?, ?, ?, ?, 'equipment', 'Active', ?, ?, ?)`,
      )
      .bind(
        `site-unit-${id}`,
        DEMO_WORKSPACE_ID,
        id,
        `${site.name} — ${site.type}`,
        site.type,
        site.address,
        position < 0 ? 99 : position,
        "The store unit itself. Name, type, location and status follow the site.",
      )
      .run();

    /* The site group: the same two the Store Documentation row sits in. */
    const slug = site.type === "Warehouse" ? "other" : "current-stores";
    await d1
      .prepare(
        `INSERT OR IGNORE INTO site_group_members (id, organisation_id, site_group_id, site_id)
         SELECT ?, ?, g.id, ? FROM site_groups g
          WHERE g.organisation_id = ? AND g.slug = ?
            AND NOT EXISTS (SELECT 1 FROM site_group_members m WHERE m.organisation_id = ? AND m.site_id = ?)`,
      )
      .bind(`sgm-demo-${site.key}`, DEMO_WORKSPACE_ID, id, DEMO_WORKSPACE_ID, slug, DEMO_WORKSPACE_ID, id)
      .run();
  }
}
