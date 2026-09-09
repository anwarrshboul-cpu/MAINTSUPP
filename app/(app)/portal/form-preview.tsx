"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Icon } from "../../components";
import { projectPublicForm } from "../../lib/form-projection";
import {
  DoneScreen,
  FormBody,
  Shell,
  type PublicFormPayload,
} from "../../(public)/f/[token]/form-renderer";
import type { BuilderForm } from "./form-builder-model";
import { pageIndexById } from "./form-pages";

/**
 * The builder's Preview — the REAL renderer, not a picture of it.
 *
 * It used to frame the public /f/:token route in an iframe. `worker/index.ts`
 * sets `X-Frame-Options: DENY` on every response — deliberately, and that
 * header stays — so the frame was refused on every port and every domain,
 * which is what "localhost refused to connect" actually meant. Weakening the
 * header to make a preview work would have been the wrong trade.
 *
 * Instead the preview mounts the SAME components the public page mounts
 * (`form-renderer.tsx`) over the SAME projection (`projectPublicForm`) with
 * the SAME option substitution the server serves the public route
 * (`form.optionOverrides`, built by `formOptionOverrides` for both endpoints).
 * Every rule — ordering, hidden questions, option visibility, prefills, the
 * appearance block, the after-submission screen — is one implementation, so
 * the preview cannot drift from the link.
 *
 * WHAT SUBMIT DOES HERE. Nothing, on purpose. monday's preview does not
 * create items, and the old iframe's "anything submitted here creates a real
 * request" was a hazard, not a feature. Pressing submit walks the operator to
 * the configured thank-you screen — which is itself part of what they are
 * previewing — and "Submit another" (if enabled) walks back.
 *
 * ── THE WELCOME PAGE AND THE PAGE BREAKS ARE COMPOSED, NOT FORKED ─────────
 *
 * Two things the Settings and Edit panels can now configure are not yet drawn
 * by `form-renderer.tsx`: the welcome page (`features.preSubmissionView`) and
 * multi-page forms (a second `PAGE_BLOCK` in `order`). Rather than copy the
 * renderer and add them — which would be the second implementation this whole
 * module exists to avoid — both are built by COMPOSING what the renderer
 * already exports:
 *
 *   · the welcome page is a `Shell` with the configured heading, message and
 *     start button in it. `Shell` is the same card the form is drawn on, so it
 *     inherits the accent, the background, the font, the logo and the language
 *     without any of that being restated here;
 *   · a page is the SAME `FormBody` handed a payload whose `questions` are that
 *     page's, and whose `submitButtonText` is "Next" until the last one. Every
 *     rule inside `FormBody` — the progress bar, `visibleQuestions` for a
 *     conditional question, the file picker — therefore applies per page, with
 *     nothing re-implemented.
 *
 * `pageIndexById` in `form-pages.ts` is the one function that says where the
 * breaks are, and it is what the public renderer will use when it learns about
 * pages. Until then the link shows every question on one page, in the same
 * order, all of it answerable — see that module's header for why degrading that
 * way was the point of storing a page as a marker rather than as a new field.
 */
export default function FormPreview({ form }: { form: BuilderForm }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<File[]>([]);
  const [done, setDone] = useState(false);
  /** -1 is the welcome page; 0..n-1 are the form's pages. */
  const [step, setStep] = useState(-1);

  const payload = useMemo<PublicFormPayload>(
    () =>
      /*
       * The projection's return names only the fields it computes with, so the
       * appearance block travels as a wider structural type. The public page
       * makes exactly this shape-trust at its fetch boundary; the preview
       * makes it at the projection boundary.
       */
      projectPublicForm(
        form.config,
        { token: "preview", title: form.title, description: form.description },
        form.optionOverrides ?? {},
        /* The browser's clock: a preview has nothing to validate against. */
        new Date(),
      ) as unknown as PublicFormPayload,
    [form],
  );

  const welcome = form.config.features.preSubmissionView;

  /*
   * The projected questions, split by page.
   *
   * Built from the PROJECTION rather than from the configuration, so a hidden
   * question is absent here exactly as it is absent from the link — the page
   * model only supplies the boundaries. A question whose page cannot be
   * determined (one the order never mentioned, which the projection appends)
   * lands on the last page rather than disappearing.
   */
  const pages = useMemo(() => {
    const index = pageIndexById(form.config);
    const count = Math.max(1, ...[...index.values()].map((value) => value + 1));
    const split: PublicFormPayload["questions"][] = Array.from({ length: count }, () => []);
    for (const question of payload.questions) {
      const page = index.get(question.id);
      split[page === undefined ? count - 1 : Math.min(page, count - 1)].push(question);
    }
    /* A page with nothing on it is not shown. The Edit panel warns about one;
       walking a submitter through a blank step would not help either of them. */
    const filled = split.filter((questions) => questions.length > 0);
    return filled.length ? filled : [[]];
  }, [form.config, payload.questions]);

  /*
   * NO EFFECT DECIDES WHERE THE PREVIEW STARTS, and that is deliberate.
   *
   * The obvious version resets `step` from an effect on `welcome.enabled`, so
   * that switching the welcome page on while the preview is open takes you back
   * to it. That is a `setState` in an effect — a cascading render the React
   * Compiler's `react-hooks/set-state-in-effect` rule refuses outright, and the
   * same rule `form-builder.tsx` had to design around for `boardId`.
   *
   * It is not needed. `step` starts at -1 and the welcome branch below asks for
   * `step < 0 && welcome.enabled`, so switching the setting on or off changes
   * what is drawn immediately, with no state to reconcile: before Start, the
   * preview follows the switch; after Start, it does not go backwards, which is
   * what a submitter would experience too.
   */

  /* Prefills show in Preview exactly as they will on the link. */
  useEffect(() => {
    setAnswers((current) => {
      const seeded = { ...current };
      let changed = false;
      for (const question of payload.questions) {
        if (question.settings.prefill && seeded[question.id] === undefined) {
          seeded[question.id] = question.settings.prefill;
          changed = true;
        }
      }
      return changed ? seeded : current;
    });
  }, [payload]);

  const current = Math.min(Math.max(step, 0), pages.length - 1);
  const last = current === pages.length - 1;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!last) {
      setStep(current + 1);
      return;
    }
    setDone(true);
  }

  function restart() {
    setDone(false);
    setAnswers({});
    setFiles([]);
    setStep(welcome.enabled ? -1 : 0);
  }

  /*
   * The access gates do not stop a preview — the operator is here to see the
   * form — but they are stated, because "what does the link do right now" is
   * part of what Preview answers.
   */
  const gates: string[] = [];
  if (!form.active) gates.push("the link is deactivated");
  if (form.hasPassword) gates.push("the link asks for the form password");
  if (form.requireLogin) gates.push("the link requires signing in");

  /*
   * The page's own payload. `submitButtonText` becomes Next on every page but
   * the last, which is the only difference between "a page" and "the form" as
   * far as `FormBody` is concerned.
   */
  const pagePayload: PublicFormPayload = {
    ...payload,
    questions: pages[current],
    submitButtonText: last
      ? payload.submitButtonText
      : `Next — page ${current + 2} of ${pages.length}`,
  };

  return (
    <div className="form-builder__preview-live">
      <p className="form-builder__preview-note">
        <Icon name="alert" size={14} />
        This is a preview — nothing submitted here creates a request.
        {gates.length > 0 && ` Right now ${gates.join(", and ")}.`}
        {pages.length > 1 &&
          ` The link shows all ${pages.length} pages as one page until the public renderer learns about page breaks.`}
      </p>
      {done ? (
        <Shell title={payload.title} appearance={payload.appearance} language={payload.language}>
          <DoneScreen form={payload} reference="" onResubmit={restart} />
        </Shell>
      ) : step < 0 && welcome.enabled ? (
        /*
          THE WELCOME PAGE. Drawn in the same `Shell` as the form, so it is the
          same card, the same accent and the same logo — a welcome page that
          looked like a different product would be worse than none.
        */
        <Shell
          title={welcome.title || payload.title}
          appearance={payload.appearance}
          language={payload.language}
        >
          <div className="pf__done">
            {welcome.description && <p>{welcome.description}</p>}
            <button type="button" className="pf__submit" onClick={() => setStep(0)}>
              {welcome.startButton.text || "Start"}
            </button>
          </div>
        </Shell>
      ) : (
        <Shell
          title={payload.title}
          description={current === 0 ? payload.description : null}
          appearance={payload.appearance}
          language={payload.language}
        >
          {pages.length > 1 && (
            <p className="form-builder__preview-step">
              Page {current + 1} of {pages.length}
              {current > 0 && (
                <button type="button" onClick={() => setStep(current - 1)}>
                  <Icon name="arrow" size={13} />
                  Back
                </button>
              )}
            </p>
          )}
          <FormBody
            form={pagePayload}
            answers={answers}
            onAnswer={(questionId, value) =>
              setAnswers((existing) => ({ ...existing, [questionId]: value }))
            }
            files={files}
            onFiles={setFiles}
            error={null}
            sending={false}
            uploading={0}
            onSubmit={submit}
          />
        </Shell>
      )}
    </div>
  );
}
