/**
 * Store Documentation board seed — monday board 1398027719.
 *
 * The second board MAINTSUPP replaces: one row per store, carrying the store's
 * address, its access arrangement and twelve document slots that the Compliance
 * Tracker reads. Structure only — every column, group and option value lives in
 * `monday-board-spec.ts` and is imported from there rather than restated, for
 * the reason set out at the top of that file: the last time board structure was
 * declared in two places the two copies drifted and the board came up with
 * duplicate columns.
 *
 * NO ROWS ARE SEEDED. The board comes up empty on purpose. Store names,
 * addresses, access links and documents are real operational data and arrive
 * through the monday export importer; inventing plausible-looking ones here
 * would put fiction in front of the people who have to trust the register.
 *
 * Mirrors `seedBoardStructure` in `db/init.ts`: raw D1, `INSERT OR IGNORE`
 * throughout, positions taken from the spec's array order. Idempotent, additive
 * and never restores something an admin has deleted.
 */

import type { CompatDatabase } from "./pg-compat";
import {
  storeDocumentationColumns,
  storeDocumentationGroups,
  storeDocumentationOptions,
} from "./monday-board-spec";


/** `board_id` on every columns/groups/options row this seeder writes. */
export const STORE_DOCUMENTATION_BOARD_KEY = "store-documentation";

/**
 * Group colours in the MAINTSUPP palette, keyed by the spec's group key.
 *
 * The spec carries monday's own hex values, which is correct there — they are
 * row data captured verbatim from the source board. This board's four groups
 * are permanent furniture rather than something an import fills in, so they are
 * re-mapped onto the interface palette here instead: teal for the live estate,
 * deep navy for Europe, and two greys that read as inactive. Re-mapped in the
 * seeder rather than in the spec so the capture stays a faithful record of
 * monday, and so a re-import never has to reconcile against edited colours.
 */
const GROUP_COLOURS: Record<string, string> = {
  topics: "#12b5aa",
  europe: "#1b4662",
  closed: "#8d9aa7",
  other: "#667889",
};

/**
 * Seeds the Store Documentation board for one organisation.
 *
 * `boardKey` is a parameter for symmetry with `seedBoardStructure`; nothing is
 * expected to pass anything but the default.
 */
export async function seedStoreDocumentationBoard(
  d1: CompatDatabase,
  organisationId: string,
  boardKey = STORE_DOCUMENTATION_BOARD_KEY,
) {
  // Same id shape as the maintenance board materialised in `db/init.ts`, so a
  // board's row is addressable from its organisation and key alone.
  // Position 1 puts it directly after maintenance in the board switcher, and
  // "SD" follows the "MS" convention — item references read SD-1, SD-2.
  await d1
    .prepare(
      `INSERT INTO boards
         (id, organisation_id, key, name, description, kind, item_noun,
          reference_prefix, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
    )
    .bind(
      `board_${organisationId}_${boardKey}`,
      organisationId,
      boardKey,
      "Store Documentation UK",
      "One row per store: address, access arrangement and the twelve documents the Compliance Tracker reads.",
      "store-documentation",
      "Store",
      "SD",
      1,
    )
    .run();

  for (const [position, column] of storeDocumentationColumns.entries()) {
    await d1
      .prepare(
        `INSERT INTO maintenance_board_columns
           (id, organisation_id, board_id, column_key, title, type, position, width,
            settings, system, visible, pinned, required, summary, option_set_key, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, 1, 0, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        `seed-${organisationId}-${boardKey}-${column.key}`,
        organisationId,
        boardKey,
        column.key,
        column.title,
        column.type,
        position,
        column.width,
        column.system ? 1 : 0,
        column.required ? 1 : 0,
        column.summary ?? null,
        column.optionSetKey ?? null,
        column.description ?? null,
      )
      .run();
  }

  // No `stage_key`. Monday's four groups sort stores by lifecycle and region,
  // not by a workflow state, so nothing here should route an item the way the
  // maintenance board's stage groups do.
  for (const [position, group] of storeDocumentationGroups.entries()) {
    await d1
      .prepare(
        `INSERT INTO maintenance_groups
           (id, organisation_id, board_id, name, color, position, collapsed, archived,
            description, stage_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL)
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        `seed-${organisationId}-${boardKey}-${group.key}`,
        organisationId,
        boardKey,
        group.name,
        GROUP_COLOURS[group.key] ?? group.colour,
        position,
        group.collapsed ? 1 : 0,
        group.description ?? null,
      )
      .run();
  }

  // `maintenance_board_options.column_key` holds the board column key, not the
  // option-set key — that is what the board reads when it renders a chip. The
  // owning column is looked up from the spec so the two cannot drift.
  for (const [optionSetKey, options] of Object.entries(storeDocumentationOptions)) {
    const column = storeDocumentationColumns.find(
      (candidate) => candidate.optionSetKey === optionSetKey,
    );
    if (!column) continue;

    for (const [position, option] of options.entries()) {
      await d1
        .prepare(
          `INSERT INTO maintenance_board_options
             (id, organisation_id, board_id, column_key, value, label, color,
              text_color, active, system, position)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)
         ON CONFLICT DO NOTHING`,
        )
        .bind(
          `seed-${organisationId}-${boardKey}-${column.key}-${position}`,
          organisationId,
          boardKey,
          column.key,
          option.value,
          option.label,
          option.colour,
          option.textColour ?? "#ffffff",
          position,
        )
        .run();
    }
  }

  // Deliberately no `reconcileDuplicateColumns` pass. That helper measures a
  // board against the maintenance spec, so running it here would delete all 24
  // of these columns as strays.
}
