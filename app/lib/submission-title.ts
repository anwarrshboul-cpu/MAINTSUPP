/**
 * WHAT A SUBMITTED JOB IS CALLED. One rule, for the server and for the browser.
 *
 * ── WHY THIS IS ITS OWN MODULE ─────────────────────────────────────────────
 *
 * Pure, with no database imports at all, for exactly the reason
 * `app/lib/priority-rules.ts` gives: the raise-a-job dialog SHOWS the derived
 * title back before you submit, so a person typing a two-sentence summary finds
 * out what the board will call it while they can still change it. That preview
 * is a client component, and `submission-service.ts` imports drizzle and the
 * schema — importing it from the browser would drag the database into the
 * client bundle, which `tests/stage-twentytwo-raise-ticket.test.mjs` refuses.
 *
 * So the rule lives here and both sides IMPORT it. It used to be restated in
 * the dialog by hand, with a comment admitting the duplication and a test
 * pinning the two copies together; a shared function is what that test was
 * asking for.
 *
 * ── THE RULE, AND THE THREE IT REPLACES ────────────────────────────────────
 *
 * Three near-copies of `requestTitle` existed and they disagreed about both the
 * separator and the length:
 *
 *   /api/maintenance     split /[.!?\n]/   cap 72, ellipsis at 69
 *   /api/report-job      split /[.!?\n]/   cap 72, ellipsis at 69  (identical)
 *   /api/forms/…/submit  split "\n"        cap 80, ellipsis at 77
 *
 * Neither shape was right alone. Splitting on sentence punctuation turns
 * "Leak. Started yesterday." into the title "Leak", which tells a coordinator
 * nothing; splitting on newlines alone turns a 300-word paragraph into 77
 * characters of the middle of a sentence.
 *
 * So: the first non-empty LINE, and the sentence break decides only where to
 * CUT a line that is too long. A short line survives whole; a long one is cut
 * at a sentence end when there is one inside the budget, and mid-word only when
 * there is not.
 *
 * `SUBMISSION_TITLE_MAX` is the longer of the two former caps. The shorter one
 * was chosen by nothing, and a job title that has to be opened to be read is
 * the failure this whole rule is about.
 */

export const SUBMISSION_TITLE_MAX = 80;
const SUBMISSION_TITLE_ELLIPSIS_AT = SUBMISSION_TITLE_MAX - 3;

/** What a job is called when nothing at all can be derived. */
export const SUBMISSION_TITLE_FALLBACK = "Maintenance request";

/**
 * The shortest cut worth taking at a sentence break.
 *
 * Without a floor, a description opening "Hi. The freezer in the back room has
 * been leaking since Tuesday…" would be titled "Hi." — which is how the
 * first-sentence split failed in the first place. Below this the sentence break
 * is ignored and the line is truncated instead.
 */
const MIN_SENTENCE_TITLE = 12;

/**
 * Renders a job-title TEMPLATE.
 *
 * A submitted form can now name its jobs by template instead of by the first
 * line of whatever the reporter typed — the thing `newItemTitle()` in
 * `board-mutations.ts` was already doing for the board's own "+ New item"
 * without anything else being able to reach it.
 *
 * `{placeholder}` only, and an UNKNOWN placeholder renders as nothing rather
 * than as its own braces: an operator who mistypes `{sight}` should get
 * "Fault — " and go and fix it, not publish a form that shows a client literal
 * curly braces. A template that renders to nothing falls through to the
 * description, so a broken template can never produce an untitled job.
 */
export function renderTitleTemplate(
  template: string,
  values: Record<string, string | null | undefined>,
): string {
  return (
    template
      .replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_match, key: string) => (values[key] ?? "").trim())
      /* Collapse the whitespace an empty placeholder leaves behind, and drop a
         separator left dangling at either end for the same reason. */
      .replace(/\s{2,}/g, " ")
      .replace(/^[\s\-–—·|,:]+|[\s\-–—·|,:]+$/g, "")
      .trim()
      .slice(0, SUBMISSION_TITLE_MAX)
  );
}

/**
 * The title for a submitted job.
 *
 * Order of authority: an explicit title the caller supplied (the board's own
 * create, which requires one, and the public form, which now sends one), then a
 * configured template, then the first line of the description, then the
 * fallback. Nothing here can return an empty string — `title` is NOT NULL on
 * the board and an untitled row is a row nobody can find again.
 */
export function submissionTitle(input: {
  explicit?: string | null;
  template?: string | null;
  templateValues?: Record<string, string | null | undefined>;
  description?: string | null;
  fallback?: string;
}): string {
  const explicit = (input.explicit ?? "").trim();
  if (explicit) return explicit.slice(0, 200);

  const template = (input.template ?? "").trim();
  if (template) {
    const rendered = renderTitleTemplate(template, input.templateValues ?? {});
    if (rendered) return rendered;
  }

  const line =
    (input.description ?? "")
      .split("\n")
      .map((part) => part.trim())
      .find(Boolean) ?? "";
  if (!line) return input.fallback ?? SUBMISSION_TITLE_FALLBACK;
  if (line.length <= SUBMISSION_TITLE_MAX) return line;

  /*
   * Too long. Prefer a sentence end inside the budget — `.`, `!` or `?`
   * followed by whitespace — so the cut lands where a person would have
   * stopped. The match is GREEDY, so it takes the LAST such break rather than
   * the first: taking the first is how "Leak. Started yesterday…" became
   * "Leak".
   */
  const budget = line.slice(0, SUBMISSION_TITLE_MAX);
  const sentence = /^[\s\S]*[.!?](?=\s)/.exec(budget);
  const cut = sentence?.[0]?.trim();
  if (cut && cut.length >= MIN_SENTENCE_TITLE) return cut;
  return `${line.slice(0, SUBMISSION_TITLE_ELLIPSIS_AT).trimEnd()}…`;
}
