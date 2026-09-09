import type { FormQuestion } from "../../../db/monday-board-spec";

/**
 * WOULD THIS FORM ACTUALLY PRODUCE A JOB?
 *
 * The builder can save a form that no submitter can ever get through, and until
 * this module it did so silently. Every rule below is read off
 * `app/api/forms/[token]/submit/route.ts` — the endpoint the public link posts
 * to — and each names the exact refusal a submitter would be handed, because a
 * warning that says "this might not work" is worth less than one that says
 * which sentence the person will read and why.
 *
 * ── THE THREE TRAPS THAT ARE INVISIBLE IN THE EDITOR ───────────────────────
 *
 *  1. REQUIRED IS NOT WHERE YOU THINK IT IS. The submit route enforces
 *     Location, Manager and Contact number *when they are asked*, whatever the
 *     question's own `required` flag says. So a form that shows those three as
 *     optional refuses a blank one with "Location, manager and contact details
 *     are required." — naming fields the form said were optional. The editor
 *     had no way to show that; the checkbox and the truth disagreed.
 *
 *  2. THE DESCRIPTION HAS A FLOOR THE CHECKBOX CANNOT EXPRESS. `description
 *     .length < 10` is refused outright. An unticked Required box on that
 *     question is a promise the server does not keep.
 *
 *  3. LOCATION IS MATCHED AGAINST THE LIVE `sites` REGISTER, not against the
 *     labels stored on the question — `optionOverrides` substitutes them. An
 *     estate with no canonical sites therefore offers a Location list of
 *     nothing and refuses every submission with "Choose a location from the
 *     list.", and the stored 21 monday labels make the editor look fine while
 *     it happens.
 *
 * ── WHY THIS IS A PURE MODULE ──────────────────────────────────────────────
 *
 * Same reason as `app/lib/form-projection.ts`: the only import is a TYPE, so
 * nothing server-only reaches the browser bundle and `tests/form-editor-model
 * .test.mjs` can transpile it to a data: URL and run the rules directly rather
 * than matching source text at them. A warning nobody can execute is a comment.
 */

/** The three the submit route demands whenever they are asked. See trap 1. */
const DEMANDED_WHEN_ASKED: ReadonlyArray<{ id: string; name: string }> = [
  { id: "single_selecty9rcyhe", name: "Location" },
  { id: "short_text64", name: "Manager" },
  { id: "numbertb4g1z46", name: "Contact number" },
];

const LOCATION_ID = "single_selecty9rcyhe";
const DESCRIPTION_ID = "short_text";

export type IntakeWarning = {
  /** Stable, so a list of these can be keyed and dismissed by identity. */
  id: string;
  /**
   * `blocking` means a submission that follows the form's own rules is refused.
   * `warning` means it succeeds but produces a job somebody has to repair.
   *
   * The distinction is the point of the feature: an operator will read one
   * banner, and it has to say which of the two this is.
   */
  level: "blocking" | "warning";
  title: string;
  detail: string;
  /** The question the warning is about, so the card can be highlighted. */
  questionId?: string;
};

export type IntakeInput = {
  config: {
    order: string[];
    questions: FormQuestion[];
  };
  /**
   * Every question id that has somewhere to save an answer — the board's live
   * column ids plus the canonical question ids the submit route handles by
   * name. Built by the caller from `app/(app)/portal/form-bindings.ts`, so this
   * module keeps no second copy of a mapping that already has one home.
   *
   * NULL WHILE THE COLUMNS ARE STILL LOADING, and null suppresses only the
   * binding check below. Every other rule is about the configuration alone and
   * must not go quiet because a second request has not answered yet — a warning
   * that appears a second after the panel does is a warning people learn to
   * distrust.
   */
  boundIds: ReadonlySet<string> | null;
  /** The substitution `/api/board/form` serves, keyed by question id. */
  optionOverrides: Record<string, Array<{ label: string; value: string }>>;
  /**
   * Whether an answer to THIS form becomes a job on THIS board — the server's
   * own `filesIntoThisBoard`. The canonical intake rules above apply only to
   * the job board's form; a generic register's form has no Location column and
   * warning about one would be noise on every section in the workspace.
   */
  filesIntoThisBoard: boolean;
  active: boolean;
  closeAt: string | null;
  responseLimit: number | null;
  responseCount: number;
};

/** Whether a question is asked at all: hidden ones never reach a submitter. */
function asked(question: FormQuestion) {
  return question.visible && question.type !== "PAGE_BLOCK";
}

/** The options a submitter would actually be offered for a question. */
function offeredOptions(
  question: FormQuestion,
  overrides: IntakeInput["optionOverrides"],
): Array<{ label: string; value: string }> {
  const substituted = overrides[question.id];
  if (substituted) return substituted;
  return (question.options ?? [])
    .filter((option) => option.visible && option.active)
    .map((option) => ({ label: option.label, value: option.value }));
}

export function intakeWarnings(input: IntakeInput): IntakeWarning[] {
  const warnings: IntakeWarning[] = [];
  const byId = new Map(input.config.questions.map((question) => [question.id, question]));
  const inOrder = input.config.order
    .map((id) => byId.get(id))
    .filter((question): question is FormQuestion => Boolean(question));
  /* Anything the order forgot is still asked — `projectQuestions` appends it —
     so it must be checked here too, or a warning would depend on bookkeeping a
     submitter never sees. */
  for (const question of input.config.questions) {
    if (!input.config.order.includes(question.id)) inOrder.push(question);
  }
  const askedList = inOrder.filter(asked);
  const askedIds = new Set(askedList.map((question) => question.id));

  /* ── The form asks nothing ──────────────────────────────────────────────── */
  if (!askedList.length) {
    warnings.push({
      id: "no-questions",
      level: "blocking",
      title: "This form asks nothing",
      detail:
        "Every question is hidden, so the link shows a Submit button over an empty page. Show at least one question.",
    });
  }

  /* ── A page with nothing on it ──────────────────────────────────────────── */
  let pageTitle: string | null = null;
  let pageId: string | null = null;
  let pageCount = 0;
  let onPage = 0;
  const flushPage = () => {
    if (pageId && onPage === 0) {
      warnings.push({
        id: `empty-page-${pageId}`,
        level: "warning",
        title: `“${pageTitle || "Page"}” has no questions on it`,
        detail:
          "A page with nothing on it shows a heading and a Next button. Move a question onto it, or remove the page.",
        questionId: pageId,
      });
    }
  };
  for (const entry of inOrder) {
    if (entry.type === "PAGE_BLOCK") {
      flushPage();
      pageId = entry.id;
      pageTitle = entry.title;
      pageCount += 1;
      onPage = 0;
      continue;
    }
    if (entry.visible) onPage += 1;
  }
  /* Only checked for a form that has more than the one page block every
     captured configuration carries — a single implicit page with no questions
     is already reported by `no-questions` above, and saying it twice is worse
     than saying it once. */
  if (pageCount > 1) flushPage();

  /* ── Required, but never asked ──────────────────────────────────────────── */
  for (const question of inOrder) {
    if (question.type === "PAGE_BLOCK") continue;
    if (question.required && !question.visible) {
      warnings.push({
        id: `required-hidden-${question.id}`,
        level: "warning",
        title: `“${question.title}” is required but hidden`,
        detail:
          "A hidden question is never asked, so the Required flag does nothing. Show it, or clear Required so the form says what it means.",
        questionId: question.id,
      });
    }
  }

  /* ── A conditional question that can never appear ───────────────────────── */
  for (const question of askedList) {
    const condition = question.showIf;
    if (!condition) continue;
    const trigger = byId.get(condition.questionId);
    if (!trigger || !askedIds.has(condition.questionId)) {
      warnings.push({
        id: `orphan-condition-${question.id}`,
        level: "blocking",
        title: `“${question.title}” can never appear`,
        detail: trigger
          ? `It is only shown when “${trigger.title}” is answered, and that question is hidden.`
          : "It depends on a question that is no longer on this form.",
        questionId: question.id,
      });
      continue;
    }
    const values = new Set(
      offeredOptions(trigger, input.optionOverrides).flatMap((option) => [
        option.value,
        option.label,
      ]),
    );
    if (values.size && !condition.equals.some((value) => values.has(value))) {
      warnings.push({
        id: `unreachable-condition-${question.id}`,
        level: "warning",
        title: `“${question.title}” waits for an answer nobody can give`,
        detail: `It appears when “${trigger.title}” is ${condition.equals
          .map((value) => `“${value}”`)
          .join(" or ")}, and none of those is an option any more.`,
        questionId: question.id,
      });
    }
  }

  /* ── A question with nowhere to file its answer ─────────────────────────── */
  if (input.boundIds) {
    for (const question of askedList) {
      if (input.boundIds.has(question.id)) continue;
      warnings.push({
        id: `unbound-${question.id}`,
        level: "blocking",
        title: `“${question.title}” has nowhere to save its answer`,
        detail:
          "It is not one of the board's columns any more — the column was probably deleted. The answer is collected and then dropped. Point it at a column, or remove the question.",
        questionId: question.id,
      });
    }
  }

  /* ── The canonical intake rules ─────────────────────────────────────────── */
  if (input.filesIntoThisBoard) {
    const location = byId.get(LOCATION_ID);

    if (!location || !askedIds.has(LOCATION_ID)) {
      warnings.push({
        id: "no-location",
        level: "warning",
        title: "Nothing on this form says where the work is",
        detail:
          "Without a Location question every job it files arrives with no site, so it cannot be routed, will not appear on a site's register, and has to be corrected by hand.",
      });
    } else {
      const options = offeredOptions(location, input.optionOverrides);
      if (!options.length) {
        warnings.push({
          id: "location-empty",
          level: "blocking",
          title: "The Location question offers no locations",
          detail:
            "A location is matched against the workspace's own Sites register, and that register has nothing in it this form may offer. Every submission is refused with “Choose a location from the list.”",
          questionId: LOCATION_ID,
        });
      }
    }

    for (const demanded of DEMANDED_WHEN_ASKED) {
      const question = byId.get(demanded.id);
      if (!question || !askedIds.has(demanded.id) || question.required) continue;
      warnings.push({
        id: `optional-but-demanded-${demanded.id}`,
        level: "blocking",
        title: `“${question.title}” is shown as optional and is not`,
        detail:
          "A job cannot be filed without it: leaving it blank is refused with “Location, manager and contact details are required.” Tick Required so the form says so, or hide the question.",
        questionId: question.id,
      });
    }

    const description = byId.get(DESCRIPTION_ID);
    if (description && askedIds.has(DESCRIPTION_ID) && !description.required) {
      warnings.push({
        id: "description-floor",
        level: "blocking",
        title: `“${description.title}” is shown as optional and is not`,
        detail:
          "An answer shorter than ten characters — a blank one included — is refused with “Please describe the work needed in a little more detail.” Tick Required, or hide the question.",
        questionId: description.id,
      });
    }
  }

  /* ── Whether the link is taking answers at all ──────────────────────────── */
  if (!input.active) {
    warnings.push({
      id: "deactivated",
      level: "warning",
      title: "The link is deactivated",
      detail: "Everything below is saved, and nobody can answer it until the form is activated.",
    });
  }
  if (input.closeAt) {
    const closes = new Date(input.closeAt);
    if (!Number.isNaN(closes.getTime()) && closes.getTime() <= Date.now()) {
      warnings.push({
        id: "closed",
        level: "warning",
        title: "The close date has passed",
        detail: "The link answers with “This form has closed” until the date is moved or cleared.",
      });
    }
  }
  if (input.responseLimit !== null && input.responseCount >= input.responseLimit) {
    warnings.push({
      id: "full",
      level: "warning",
      title: "The response limit has been reached",
      detail: `${input.responseCount} of ${input.responseLimit} responses are in, so the link is refusing new ones.`,
    });
  }

  return warnings;
}

/** The worst level present, for a summary line. Null when there is nothing. */
export function worstLevel(warnings: IntakeWarning[]): IntakeWarning["level"] | null {
  if (warnings.some((warning) => warning.level === "blocking")) return "blocking";
  return warnings.length ? "warning" : null;
}
