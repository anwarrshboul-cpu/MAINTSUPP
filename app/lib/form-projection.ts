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
  /**
   * The 0-based page this question is on.
   *
   * THE WHOLE OF WHAT PAGINATION COSTS THE PAYLOAD — one integer per question.
   *
   * A page is stored as a `PAGE_BLOCK` marker inside `order` (see
   * app/(app)/portal/form-pages.ts for why it is a marker and not a
   * `config.pages` array), and the projection drops those markers, so before
   * this field the served payload carried no page information at all and the
   * public link had no way to know where a form broke. It showed every page as
   * one long scroll.
   *
   * WHY AN INDEX PER QUESTION AND NOT AN ARRAY OF PAGES. `questions` is the
   * flat list four other things already read: the prefill seeding, the
   * required-File check, the progress bar and `askedQuestions` (which the
   * submit route mirrors). Nesting it would have rewritten all four and left
   * the same question reachable by two paths that could disagree. An index
   * leaves the flat list exactly as it was and lets `askedPages()` below do
   * the grouping, once, for both mounts.
   *
   * The number is the RAW boundary count, not a compacted one, so it means the
   * same thing as `pagesOf()` position in the builder's page model — which is
   * what `tests/form-editor-model.test.mjs` runs both modules to prove. A page
   * left empty because every question on it is hidden therefore leaves a gap
   * in these numbers; `askedPages` closes it, because emptiness depends on the
   * answers so far and can only be decided at render time.
   */
  page: number;
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
 *  · The page block, which is a container rather than a question. Where it
 *    STOOD is not dropped: it becomes the `page` index on every question
 *    after it, which is how the public link draws a multi-page form.
 *  · Deactivated and hidden OPTIONS, per question. A retired store must not be
 *    selectable, and monday retires a label by flag rather than by deleting it.
 *
 * Order is monday's `sortedQuestionsList` first, then anything the order forgot
 * appended rather than dropped — a question added to `questions` but never
 * added to `order` should still be asked, not silently lost.
 */
type PagedConfig = { order: string[]; questions: FormQuestion[] };

/**
 * The stored entries in the order the form is drawn in — PAGE BLOCKS INCLUDED.
 *
 * Two repairs, and both matter more than they look:
 *
 *   · an id in `order` with no question behind it is dropped, and an id listed
 *     twice is taken once, because that is what a delete and a bad merge leave
 *     behind and neither may become a gap; and
 *   · a question `order` never mentions is APPENDED rather than lost — one
 *     added by a migration, or by an older build, is still asked.
 *
 * Extracted because `projectQuestions` and `pageIndexById` must walk the SAME
 * array: a question that ordered one way and paged another would be drawn on a
 * page it does not belong to.
 *
 * `form-pages.ts` carries the builder-side twin of this repair, and the two
 * cannot be collapsed into one: both modules are transpiled and executed from
 * a `data:` URL by the suite, and a `data:` module has no base URL to resolve a
 * relative runtime import against, so neither may import the other in either
 * direction. `tests/form-editor-model.test.mjs` runs both over the same
 * configurations and fails the day they disagree.
 */
export function orderedEntries(config: PagedConfig): FormQuestion[] {
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
  return ordered;
}

/**
 * Question id -> the 0-based page it is on.
 *
 * The one function that says where a form breaks. It used to live in the
 * builder's `form-pages.ts` with a single caller — the Preview — and a note
 * saying it was "what the public page's own paging will use when the renderer
 * learns about pages". It learned; so it moved here, to the module the server
 * and the browser both already import, and `projectQuestions` stamps its
 * answer onto every question it publishes.
 */
export function pageIndexById(config: PagedConfig): Map<string, number> {
  const index = new Map<string, number>();
  let page = 0;
  let started = false;
  for (const entry of orderedEntries(config)) {
    if (entry.type === "PAGE_BLOCK") {
      /* The first break opens page 0 rather than advancing past it: every
         captured configuration begins with one, and counting it as a boundary
         would leave page 0 permanently empty. */
      if (started) page += 1;
      started = true;
      continue;
    }
    started = true;
    index.set(entry.id, page);
  }
  return index;
}

export function projectQuestions(
  config: PagedConfig,
  /** Options to substitute, per question id. See the note in `form-config`. */
  optionOverrides: Record<string, Array<{ label: string; value: string }>> = {},
  now: Date = new Date(),
): PublicQuestion[] {
  const ordered = orderedEntries(config);
  const pageOf = pageIndexById(config);

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
      /* Zero is the honest fallback: a question the page walk never reached is
         one `order` never mentioned, and `orderedEntries` appends it. */
      page: pageOf.get(question.id) ?? 0,
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
  welcome: WelcomePage;
  /**
   * What the logo SAYS, for somebody who cannot see it.
   *
   * `accessibility.logoAltText` has been in the stored configuration since the
   * monday import, and the Design panel has been writing it, but the payload
   * never carried it and `Shell` hard-coded `alt=""`. A logo is very often the
   * only thing on a form that names the organisation, and "image" is what a
   * screen reader says instead. Null means decorative, which is the correct
   * answer for the MAINTSUPP mark and for an operator who left it blank.
   */
  logoAlt: string | null;
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
 * The welcome page — the screen before the first question.
 *
 * Named rather than left as `unknown`, which is what `features` used to hand
 * the projection. The public renderer draws it now, so the payload's shape is
 * a contract two mounts depend on, and `unknown` would have made every read of
 * it a cast.
 */
export type WelcomePage = {
  enabled: boolean;
  title: string | null;
  description: string | null;
  startButton: { text: string | null };
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
    preSubmissionView: WelcomePage;
    afterSubmissionView: {
      title: string | null;
      description: string | null;
      allowResubmit: boolean;
      showSuccessImage: boolean;
      redirectAfterSubmission: { enabled: boolean; redirectUrl: string | null };
    };
  };
  accessibility: { language: string | null; logoAltText: string | null };
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
    logoAlt: config.accessibility.logoAltText,
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

/**
 * The form as a submitter WALKS it: one entry per page, in order, and no empty
 * ones.
 *
 * Shared by the public link and the builder's Preview for the same reason
 * everything else here is shared — two implementations of "where does this
 * form break" is one too many, and the two mounts have to agree about a page
 * count they both print on a button ("Next - page 2 of 3").
 *
 * WHY AN EMPTY PAGE IS NOT A PAGE. Two ways one arises, and they need
 * different treatment:
 *
 *   · every question on it is HIDDEN. Those never reach the payload at all, so
 *     the page simply has no questions here and drops out — and the `page`
 *     numbers keep their gap, which is why this groups by key and sorts rather
 *     than indexing an array of a fixed length;
 *   · every question on it is behind a `showIf` that the answers so far do not
 *     satisfy. That can change with the next keystroke, so it cannot be
 *     decided in the projection: it is decided here, against the answers, and
 *     the page returns the moment its trigger matches.
 *
 * Because the result never CONTAINS an empty page, a caller stepping through
 * it skips one in both directions without owning any logic for that — which is
 * the only version of "skip the blank step" that cannot be got wrong on Back.
 *
 * The questions handed back are the page's WHOLE list, not the asked subset:
 * `FormBody` applies `showIf` itself, per field, and that stays the one place
 * it happens.
 */
export function askedPages(
  questions: PublicQuestion[],
  answers: Record<string, string>,
): PublicQuestion[][] {
  const groups = new Map<number, PublicQuestion[]>();
  for (const question of questions) {
    const group = groups.get(question.page);
    if (group) group.push(question);
    else groups.set(question.page, [question]);
  }

  const pages = [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, group]) => group)
    .filter((group) => askedQuestions(group, answers).length > 0);

  /* A form with no questions at all still has one page, so the caller has
     somewhere to draw the submit button rather than nothing. */
  return pages.length ? pages : [[]];
}
