/**
 * THE TRADE A JOB NEEDS — a controlled field, not a free-text one (decision O).
 *
 * The dimension already exists and is already controlled at the REGISTER: the
 * `engineer_required` option set, which `db/init.ts` seeds and describes as
 * "Trade or engineer requirement", which the board mirrors as a status column,
 * which `/api/options` renames, reassigns and counts usage for, and which the
 * Overview meters and `tradeBreakdown` already read as the job's trade. Several
 * screens already call it a trade in words. So decision O does not invent a
 * second field beside it — an invented `trade` column would leave two answers
 * to one question and split every existing job's history between them.
 *
 * WHAT WAS MISSING IS THE CONTROL. `PATCH /api/maintenance` and the automation
 * engine only ever TRIMMED the value: `{ fields: { engineer: "plumberr" } }`
 * wrote "plumberr" into the column every dashboard groups by, and no screen in
 * the product would ever offer it again. That is the "uncontrolled arbitrary
 * string" the owner ruled out, and this module is the rule that stops it.
 *
 * THE RULE, and the one exception that keeps it usable:
 *
 *   - a NEW value must be one of this workspace's ACTIVE trades;
 *   - clearing it is allowed — a job may not know its trade yet;
 *   - a value the row ALREADY holds is allowed to stay. Imported jobs carry
 *     trades nobody configured ("Plummer" is monday's own spelling), and
 *     refusing them would mean a coordinator could not edit the site or the
 *     due date of an old job without first fixing a value they may not be able
 *     to fix. The same rule `resolveJobTypeWrite` applies to a deactivated job
 *     type, for the same reason.
 *
 * The refusal names where the list is edited, as `validateOption` does for a
 * site's fields, because a person who cannot see how to add a trade will type
 * one into whatever field will take it.
 */

import { isConfiguredValue, listActiveOptionValues } from "./options-repository";
import type { getDb } from "../../db";

type Database = Awaited<ReturnType<typeof getDb>>;

/** The option set that holds a workspace's trades. */
export const TRADE_OPTION_SET = "engineer_required";

/** What the product calls this dimension. */
export const TRADE_LABEL = "Trade";

/** The board column and job field the trade is stored on. */
export const TRADE_FIELD = "engineer";

export function tradeRefusal(value: string) {
  return `"${value}" is not one of this workspace's trades. Choose an existing trade, or add it to the Trade list on the board first.`;
}

/**
 * Whether this write may set the trade. `current` is the value the row already
 * holds; `null`/`undefined` for a job being created.
 */
export async function tradeWriteRefusal(
  db: Database,
  organisationId: string,
  candidate: unknown,
  current: string | null | undefined,
): Promise<string | null> {
  if (typeof candidate !== "string") return null;
  const value = candidate.trim();
  if (!value) return null;
  if (value === (current ?? "").trim()) return null;
  if (await isConfiguredValue(db, organisationId, TRADE_OPTION_SET, value)) return null;
  return tradeRefusal(value);
}

/** This workspace's trades, in the order the register holds them. */
export async function listTrades(db: Database, organisationId: string) {
  const values = await listActiveOptionValues(db, organisationId, TRADE_OPTION_SET);
  return values.map((row) => ({ value: row.value, label: row.label, colourHex: row.colourHex }));
}
