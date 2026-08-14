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

import type { getD1 } from ".";
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
 * A column's stored `settings` blob.
 *
 * A dropdown column renders from `settings.choices` — that is what the grid's
 * choice cell reads — while the option rows written further down are what the
 * option-set screens read. Both come from the same spec array, because seeding
 * only the latter left Store Type showing a dash on every store whose value
 * was already recorded.
 *
 * Choice ids are the lower-cased value, matching how the board API slugifies an
 * id it is handed. Imported cells hold the label instead, which the grid
 * resolves case-insensitively.
 */
function columnSettings(type: string, optionSetKey?: string | null) {
  if (type !== "dropdown" && type !== "status") return "{}";
  const options = optionSetKey ? storeDocumentationOptions[optionSetKey] : undefined;
  if (!options?.length) return "{}";
  return JSON.stringify({
    choices: options.map((option) => ({
      id: option.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
      label: option.label,
      color: option.colour,
      textColor: option.textColour ?? "#ffffff",
    })),
  });
}

/**
 * Seeds the Store Documentation board for one organisation.
 *
 * `boardKey` is a parameter for symmetry with `seedBoardStructure`; nothing is
 * expected to pass anything but the default.
 */
export async function seedStoreDocumentationBoard(
  d1: Awaited<ReturnType<typeof getD1>>,
  organisationId: string,
  boardKey = STORE_DOCUMENTATION_BOARD_KEY,
) {
  // Same id shape as the maintenance board materialised in `db/init.ts`, so a
  // board's row is addressable from its organisation and key alone.
  // Position 1 puts it directly after maintenance in the board switcher, and
  // "SD" follows the "MS" convention — item references read SD-1, SD-2.
  await d1
    .prepare(
      `INSERT OR IGNORE INTO boards
         (id, organisation_id, key, name, description, kind, item_noun,
          reference_prefix, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        `INSERT OR IGNORE INTO maintenance_board_columns
           (id, organisation_id, board_id, column_key, title, type, position, width,
            settings, system, visible, pinned, required, summary, option_set_key, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)`,
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
        columnSettings(column.type, column.optionSetKey),
        column.system ? 1 : 0,
        column.required ? 1 : 0,
        column.summary ?? null,
        column.optionSetKey ?? null,
        column.description ?? null,
      )
      .run();

    /*
     * The first column was seeded as "Store"; monday's header reads "Name".
     *
     * `INSERT OR IGNORE` cannot correct a row that already exists, so a board
     * seeded before the spec was fixed keeps the old header forever. Guarded
     * on the stored title still being exactly the value this seeder used to
     * write, and on the column being `system`, so an admin who has renamed it
     * to something of their own choosing keeps that name. Anything other than
     * the specific historic mistake is left alone.
     */
    if (column.key === "name" && column.title !== "Store") {
      await d1
        .prepare(
          `UPDATE maintenance_board_columns
              SET title = ?
            WHERE organisation_id = ? AND board_id = ? AND column_key = 'name'
              AND title = 'Store' AND system = 1`,
        )
        .bind(column.title, organisationId, boardKey)
        .run();
    }

    /*
     * Boards seeded before the settings blob was written carry an empty one,
     * and the `INSERT OR IGNORE` above will not correct them. Guarded on the
     * stored value still being exactly `{}` — an unconfigured column — so an
     * admin who has renamed or recoloured a label keeps that edit. Deliberately
     * not also guarded on `system`: Store Type is not a system column, and the
     * empty blob is the signal that matters.
     */
    const settings = columnSettings(column.type, column.optionSetKey);
    if (settings !== "{}") {
      await d1
        .prepare(
          `UPDATE maintenance_board_columns
              SET settings = ?
            WHERE organisation_id = ? AND board_id = ? AND column_key = ?
              AND TRIM(COALESCE(settings, '')) IN ('', '{}')`,
        )
        .bind(settings, organisationId, boardKey, column.key)
        .run();
    }
  }

  // No `stage_key`. Monday's four groups sort stores by lifecycle and region,
  // not by a workflow state, so nothing here should route an item the way the
  // maintenance board's stage groups do.
  for (const [position, group] of storeDocumentationGroups.entries()) {
    await d1
      .prepare(
        `INSERT OR IGNORE INTO maintenance_groups
           (id, organisation_id, board_id, name, color, position, collapsed, archived,
            description, stage_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL)`,
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
          `INSERT OR IGNORE INTO maintenance_board_options
             (id, organisation_id, board_id, column_key, value, label, color,
              text_color, active, system, position)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`,
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
