import type { FormQuestion } from "../../db/monday-board-spec";

/**
 * Turning a stored form configuration into the questions a submitter sees.
 *
 * WHY THIS IS A SEPARATE, PURE MODULE
 *
 * Two callers need exactly this answer and they run in different places:
 *
 *   · the server, in `app/lib/form-config.ts`, when it answers
 *     `GET /api/forms/:token` for the real public form;
 *   · the BROWSER, in the form builder's Preview, which has the configuration
 *     already and must show precisely what the public form will show.
 *
 * `form-config.ts` cannot be imported by a client component — it pulls in
 * drizzle, the schema and the password hasher — so before this module existed
 * the only way to preview was to frame the real route. That does not work:
 * `worker/index.ts` sets `X-Frame-Options: DENY` on every response, on the
 * deliberate reasoning that "this app has no embeddable surface, and
 * clickjacking a board that can delete rows is not a trade worth making". The
 * iframe was refused by policy, on every port and every domain, which is what
 * "localhost refused to connect" actually meant.
 *
 * Weakening that header to make a preview work would be the wrong trade. So the
 * RULES move here instead — ordering, visibility, option filtering, option
 * order, prefill — and both sides compute the same answer from them. One
 * implementation, so Preview and the public form cannot drift.
 *
 * Everything in this file is pure: no I/O, no database, no `Date.now()` that
 * the caller has not supplied. The only import is a TYPE, which erases at
 * build time, so nothing server-only is dragged into the browser bundle.
 */

export type PublicQuestion = {
  id: string;
  type: FormQuestion["type"];
  title: string;
  description: string | null;
  required: boolean;
  options: Array<{ label: string; value: string }> | null;
  showIf: { questionId: string; equals: string[] } | null;
  settings: {
    display: "Dropdown" | "Vertical" | "Horizontal";
    includeTime: boolean;
    /** The value the field opens with, already computed. Empty means none. */
    prefill: string;
  };
};

/**
 * The options in the order the form should offer them.
 *
 * "Custom" is monday's word for "the order they are stored in" and is the
 * default, so this is a no-op unless somebody chose alphabetical. Sorted with
 * `en-GB` collation rather than by code point, so accented store names land
 * where a reader expects rather than after Z.
 */
export function orderOptions(
  options: Array<{ label: string; value: string }> | null,
  order: "Custom" | "Alphabetical",
) {
  if (!options || order !== "Alphabetical") return options;
  return [...options].sort((left, right) => left.label.localeCompare(right.label, "en-GB"));
}

/**
 * What the field opens with.
 *
 * "Today as default" is computed from the `now` the CALLER supplies, and that
 * indirection is the point: the server passes its own clock so the date shown
 * and the date validated cannot disagree across midnight, and the preview
 * passes the browser's, because a preview has nothing to validate against.
 *
 * `defaultCurrentDate` wins over `defaultAnswer` for a date question — a form
 * configured with both is asking for today, and the fixed date is stale
 * configuration.
 */
export function resolvePrefill(question: FormQuestion, now: Date) {
  const settings = question.settings;
  if (!settings) return "";

  if ((question.type === "Date" || question.type === "DateRange") && settings.defaultCurrentDate) {
    /*
     * Rendered as the value an `<input type="date">` expects. `toISOString`
     * would be UTC and would show yesterday to anyone west of Greenwich in the
     * evening, so the parts are read in the supplied clock's own zone instead.
     */
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    if (settings.includeTime) {
      const hour = String(now.getHours()).padStart(2, "0");
      const minute = String(now.getMinutes()).padStart(2, "0");
      return `${year}-${month}-${day}T${hour}:${minute}`;
    }
    return `${year}-${month}-${day}`;
  }

  return typeof settings.defaultAnswer === "string" ? settings.defaultAnswer : "";
}

/**
 * The questions a submitter is asked, in the order they are asked.
 *
 * WHAT IS DROPPED, AND WHY IT MATTERS
 *
 *  · Hidden questions. `visible: false` on monday means the submitter never
 *    sees the question; sending it and hiding it in CSS would publish the
 *    board's internal columns — "Cost of Works", "Approved by" — to anyone who
 *    opened dev tools on a public link.
 *  · The page block, which is a container rather than a question.
 *  · Deactivated and hidden OPTIONS, per question. A retired store must not be
 *    selectable, and monday retires a label by flag rather than by deleting it.
 *
 * Order is monday's `sortedQuestionsList` first, then anything the order forgot
 * appended rather than dropped — a question added to `questions` but never
 * added to `order` should still be asked, not silently lost.
 */
export function projectQuestions(
  config: { order: string[]; questions: FormQuestion[] },
  /** Options to substitute, per question id. See the note in `form-config`. */
  optionOverrides: Record<string, Array<{ label: string; value: string }>> = {},
  now: Date = new Date(),
): PublicQuestion[] {
  const byId = new Map(config.questions.map((question) => [question.id, question]));

  const ordered: FormQuestion[] = [];
  for (const id of config.order) {
    const question = byId.get(id);
    if (question) {
      ordered.push(question);
      byId.delete(id);
    }
  }
  for (const remaining of byId.values()) ordered.push(remaining);

  return ordered
    .filter((question) => question.visible && question.type !== "PAGE_BLOCK")
    .map<PublicQuestion>((question) => ({
      id: question.id,
      type: question.type,
      title: question.title,
      description: question.description,
      required: question.required,
      options: orderOptions(
        optionOverrides[question.id] ??
          question.options
            ?.filter((option) => option.visible && option.active)
            .map((option) => ({ label: option.label, value: option.value })) ??
          null,
        question.settings?.optionsOrder ?? "Custom",
      ),
      showIf: question.showIf,
      settings: {
        display: question.settings?.display ?? "Dropdown",
        includeTime: question.settings?.includeTime === true,
        prefill: resolvePrefill(question, now),
      },
    }));
}

/**
 * Which questions are actually ASKED, given the answers so far.
 *
 * A conditional question is only asked once its trigger matches, and the
 * SUBMIT route applies the same rule — validating a question the submitter
 * never saw would refuse a form over an invisible field. Shared for the same
 * reason as everything else here: two implementations of "is this asked" is
 * one implementation too many.
 */
export function askedQuestions(
  questions: PublicQuestion[],
  answers: Record<string, string>,
) {
  return questions.filter((question) => {
    if (!question.showIf) return true;
    return question.showIf.equals.includes(answers[question.showIf.questionId] ?? "");
  });
}
