/**
 * THE TIER BRIDGE — one small module, because it is one small idea.
 *
 * `maintenance_requests.tier` has been the bare number 1–4 since Stage 1 — the
 * SLA rules key on it — while the option registry (and the monday spec it is
 * seeded from) stores "Tier 1"–"Tier 4" as the option VALUES. Left unmapped,
 * that mismatch broke every tier surface at once: the cell drew the raw digit
 * in an anonymous grey chip, picking "Tier 3" saved `Number("Tier 3")` — NaN —
 * sorting by Tier ranked every row identically, and a Tier filter matched
 * nothing.
 *
 * WHY IT IS HERE RATHER THAN IN live-board.tsx, WHERE IT WAS.
 *
 * live-board.tsx crossed the 5,600-line headroom guard that
 * workstream-seven-official-document-ui.test.mjs holds it under, and that guard
 * exists to keep the file editable rather than to be squeezed past — comments
 * are explicitly not to be trimmed for it. So something had to leave, and this
 * was the honest candidate: a pure function of its arguments, no React, no
 * board state, and its own comment already called it and `tierDigits` "the two
 * helpers ... the one bridge" while the two sat in different files.
 *
 * `tierDigits` itself stays in board-sort.ts, where the comparator that
 * consumes it lives and where a test pins it. This module imports it rather
 * than copying it, so there is still exactly one spelling of the rule.
 */

import type { Option } from "./board-model";
import { tierDigits } from "./board-sort";

/** The option value the tier cell should light up — "3" resolved to "Tier 3". */
export function tierCellValue(tier: string, options: Option[]): string {
  if (options.some((option) => option.value === tier)) return tier;
  return (
    options.find((option) => tierDigits(option.value) === tier)?.value ?? tier
  );
}
