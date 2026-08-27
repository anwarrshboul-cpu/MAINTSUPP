import type { getDb } from "../../db";
import { listOptionValues } from "./options-repository";
import { listRetailSites } from "./sites-repository";
import {
  CANONICAL_OPTION_SETS,
  LOCATION_QUESTION_ID,
  applyOptionPreferences,
} from "./form-projection";
import type { StoredFormConfig } from "./form-config";

type Database = Awaited<ReturnType<typeof getDb>>;

/*
 * WHICH questions are canonical, and to what:
 *
 *   · Location (`single_selecty9rcyhe`) → the `sites` table. The submit route
 *     resolves the answer against `sites.name`, so an option that is not a
 *     site is an option that can never be submitted.
 *   · Engineer Required (`single_select`) → option set `engineer_required`.
 *   · Priority (titled "Status" on the form, id `status`) → option set
 *     `priority`. The board's chips, the raise-ticket panel and the options
 *     admin all read the same set, which is what keeps
 *     Form Builder = Public Form = Board chips = Backend one list.
 *
 * The ids live in `form-projection.ts` (pure) so the builder's option editor
 * can share them in the browser. The form keeps ONLY presentation preferences
 * — per-option order and visibility, stored in the question's own `options`
 * array and applied by `applyOptionPreferences` — never a second copy of the
 * options themselves.
 */

/**
 * Every option substitution the public form (and the builder's Preview) needs,
 * keyed by question id.
 *
 * ONE function, called by both `/api/forms/[token]` and `/api/board/form`, so
 * the preview an operator checks and the form a submitter opens cannot be
 * offered different lists — the acceptance rule this file exists for.
 */
export async function formOptionOverrides(
  db: Database,
  organisationId: string,
  config: StoredFormConfig,
): Promise<Record<string, Array<{ label: string; value: string }>>> {
  const overrides: Record<string, Array<{ label: string; value: string }>> = {};
  const questionById = new Map(config.questions.map((question) => [question.id, question]));

  /*
   * Open retail sites only. An archived site keeps its jobs and its history,
   * but a closed store must not be offered to a submitter — the whole point of
   * archiving from the Location editor is that it leaves the form.
   *
   * `active` alone stopped being enough once the register became the client's
   * real estate: the office and the two warehouses are open, canonical
   * locations, and offering "Warehouse 2" to somebody reporting a leak in a
   * shop is not a location list. `listRetailSites` is the one definition of
   * what belongs in a picker, shared with the board's Location column.
   */
  const estate = await listRetailSites(db, organisationId);
  if (estate.length) {
    overrides[LOCATION_QUESTION_ID] = applyOptionPreferences(
      questionById.get(LOCATION_QUESTION_ID)?.options ?? null,
      /* `value` is the site NAME — the identity the submit route resolves. */
      estate.map((site) => ({ label: site.name, value: site.name })),
    );
  }

  for (const [questionId, setKey] of Object.entries(CANONICAL_OPTION_SETS)) {
    const values = await listOptionValues(db, organisationId, setKey);
    const live = values
      .filter((entry) => entry.active)
      .map((entry) => ({ label: entry.label, value: entry.value }));
    if (live.length) {
      overrides[questionId] = applyOptionPreferences(
        questionById.get(questionId)?.options ?? null,
        live,
      );
    }
  }

  return overrides;
}
