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

/**
 * The Location question, by monday's column id.
 *
 * Exported from HERE — the pure module — because the builder's option editor
 * needs it in the browser, and `form-config` (which re-exports it for the
 * server routes) cannot be imported by a client component. It is the one
 * question whose options are the live `sites` register rather than anything
 * captured or stored.
 */
export const LOCATION_QUESTION_ID = "single_selecty9rcyhe";

/**
 * Form questions whose options live in the canonical option registry
 * (`option_values`), keyed by monday column id → option set key. See
 * `formOptionOverrides` in app/lib/form-options.ts for the server half.
 */
export const CANONICAL_OPTION_SETS: Record<string, string> = {
  single_select: "engineer_required",
  status: "priority",
};

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
 * Form-level preferences applied over a CANONICAL option list.
 *
 * Locations, Priority and Engineer options are owned by their registers — the
 * `sites` table and `option_values` — and the form must never keep a
 * disconnected copy: an option a submitter can pick has to exist canonically
 * or the submission bounces. What the form MAY own is presentation: which of
 * the canonical options it shows, and in what order. Those preferences live in
 * the question's stored `options` array, and this merges the two:
 *
 *   · ORDER comes from the stored array — matched entries first, in stored
 *     order; canonical options the form has never seen append after, so a
 *     newly added site or priority appears rather than vanishing.
 *   · VISIBILITY comes from the stored flags — an entry marked hidden or
 *     inactive is withheld from the form (the canonical record is untouched).
 *   · EXISTENCE and LABELS come from the canonical list — a stored entry whose
 *     option no longer exists is dropped, and a canonical rename shows its new
 *     label whatever the mirror recorded.
 *
 * Matching is tolerant of history: the captured monday configuration stored
 * monday's numeric option ids in `value`, while mirrors the builder writes use
 * the canonical value — so a stored entry claims a live option by value or by
 * label, whichever connects.
 */
export function mergeOptionStates(
  stored: FormQuestion["options"],
  live: Array<{ label: string; value: string }>,
): Array<{ label: string; value: string; hidden: boolean }> {
  if (!stored?.length) return live.map((option) => ({ ...option, hidden: false }));

  const remaining = new Map(live.map((option) => [option.value, option]));
  const claim = (entry: { label: string; value: string }) => {
    for (const key of [entry.value, entry.label]) {
      const direct = remaining.get(key);
      if (direct) {
        remaining.delete(key);
        return direct;
      }
      for (const [value, option] of remaining) {
        if (option.label === key) {
          remaining.delete(value);
          return option;
        }
      }
    }
    return null;
  };

  const ordered: Array<{ label: string; value: string; hidden: boolean }> = [];
  for (const entry of stored) {
    const match = claim(entry);
    /* A matched-but-hidden entry stays claimed, so it does not re-append. */
    if (match) ordered.push({ ...match, hidden: !(entry.visible && entry.active) });
  }
  for (const option of remaining.values()) ordered.push({ ...option, hidden: false });
  return ordered;
}

/** The submitter's view of the merge: hidden entries withheld entirely. */
export function applyOptionPreferences(
  stored: FormQuestion["options"],
  live: Array<{ label: string; value: string }>,
): Array<{ label: string; value: string }> {
  return mergeOptionStates(stored, live)
    .filter((option) => !option.hidden)
    .map(({ label, value }) => ({ label, value }));
}

/**
 * The whole public payload, computed from the configuration alone.
 *
 * Pure, and shared for the same reason `projectQuestions` is: the server
 * builds this to answer `GET /api/forms/:token`, and the builder's Preview
 * builds it IN THE BROWSER from the configuration it is editing. One
 * implementation is what makes "Preview shows what the link shows" a property
 * of the code rather than a hope.
 */
export type ProjectedPublicForm = {
  token: string;
  title: string;
  description: string | null;
  questions: PublicQuestion[];
  appearance: FormConfigLike["appearance"];
  welcome: FormConfigLike["features"]["preSubmissionView"];
  afterSubmission: {
    title: string | null;
    description: string | null;
    allowResubmit: boolean;
    showSuccessImage: boolean;
    redirectUrl: string | null;
  };
  progressBar: boolean;
  submitButtonText: string | null;
  language: string | null;
};

/**
 * The slice of a stored config this module needs. Structural, so the real
 * `StoredFormConfig` satisfies it without this file importing anything from
 * the server side. Type-only, so still pure.
 */
type FormConfigLike = {
  order: string[];
  questions: FormQuestion[];
  appearance: {
    showProgressBar: boolean;
    submitButton: { text: string | null };
  };
  features: {
    preSubmissionView: unknown;
    afterSubmissionView: {
      title: string | null;
      description: string | null;
      allowResubmit: boolean;
      showSuccessImage: boolean;
      redirectAfterSubmission: { enabled: boolean; redirectUrl: string | null };
    };
  };
  accessibility: { language: string | null };
};

export function projectPublicForm(
  config: FormConfigLike,
  identity: { token: string; title: string; description: string | null },
  optionOverrides: Record<string, Array<{ label: string; value: string }>> = {},
  now: Date = new Date(),
): ProjectedPublicForm {
  const questions = projectQuestions(config, optionOverrides, now);
  return {
    token: identity.token,
    title: identity.title,
    description: identity.description,
    questions,
    appearance: config.appearance,
    welcome: config.features.preSubmissionView,
    afterSubmission: {
      title: config.features.afterSubmissionView.title,
      description: config.features.afterSubmissionView.description,
      allowResubmit: config.features.afterSubmissionView.allowResubmit,
      showSuccessImage: config.features.afterSubmissionView.showSuccessImage,
      redirectUrl: config.features.afterSubmissionView.redirectAfterSubmission.enabled
        ? config.features.afterSubmissionView.redirectAfterSubmission.redirectUrl
        : null,
    },
    progressBar: config.appearance.showProgressBar,
    submitButtonText: config.appearance.submitButton.text,
    language: config.accessibility.language,
  };
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
