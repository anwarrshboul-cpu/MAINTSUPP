"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Icon } from "../../components";
import { askedPages, projectPublicForm } from "../../lib/form-projection";
import {
  DoneScreen,
  FormBody,
  PageSteps,
  Shell,
  WelcomeScreen,
  pagePayload,
  type PublicFormPayload,
} from "../../(public)/f/[token]/form-renderer";
import type { BuilderForm } from "./form-builder-model";

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
 * ── THE WELCOME PAGE AND THE PAGE BREAKS ARE SHARED, NOT FORKED ───────────
 *
 * Both were previewed here before the public renderer could draw them, and the
 * note in this component used to say so on screen: "the link shows all N pages
 * as one page until the public renderer learns about page breaks". It has
 * learnt, so the sentence is gone and so is everything this file used to own
 * about pages:
 *
 *   · WHERE the form breaks is `askedPages` in app/lib/form-projection.ts,
 *     over the `page` index the projection stamps on every question. The
 *     public link calls the same function over the same payload, which is what
 *     makes "page 2 of 3" here and "page 2 of 3" there the same claim rather
 *     than two claims that happen to agree today;
 *   · WHAT a page looks like is `pagePayload` and `FormBody`, and what the
 *     welcome page looks like is `WelcomeScreen` — both exported by the
 *     renderer, so the accent, the background, the font, the logo, the alt
 *     text, the language and its direction are inherited rather than restated.
 *
 * What is left here is the only part that legitimately differs: which step the
 * operator is on, and the fact that pressing the button walks them forward
 * instead of POSTing anything.
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

  /* Read off the PROJECTION, not the configuration, so the preview's welcome
     page is the one the link is served rather than one derived beside it. */
  const welcome = payload.welcome;

  /*
   * The projected questions, split into the pages a submitter walks.
   *
   * `askedPages` does the whole split, and it is the function the public link
   * calls: from the projection (so a hidden question is absent here exactly as
   * it is absent from the link), over the `page` index the projection stamped,
   * dropping a page with nothing left on it — including one whose every
   * question is behind a `showIf` these answers do not satisfy. The Edit panel
   * warns about an empty page; walking a submitter through a blank step would
   * not help either of them.
   */
  const pages = useMemo(
    () => askedPages(payload.questions, answers),
    [payload.questions, answers],
  );

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

  return (
    <div className="form-builder__preview-live">
      <p className="form-builder__preview-note">
        <Icon name="alert" size={14} />
        This is a preview — nothing submitted here creates a request.
        {gates.length > 0 && ` Right now ${gates.join(", and ")}.`}
      </p>
      {done ? (
        <Shell
          title={payload.title}
          appearance={payload.appearance}
          language={payload.language}
          logoAlt={payload.logoAlt}
        >
          <DoneScreen form={payload} reference="" onResubmit={restart} />
        </Shell>
      ) : step < 0 && welcome.enabled ? (
        /* THE WELCOME PAGE, drawn by the renderer — card, heading fallback and
           start button — so the operator is previewing the screen itself. */
        <WelcomeScreen form={payload} onStart={() => setStep(0)} />
      ) : (
        <Shell
          title={payload.title}
          description={current === 0 ? payload.description : null}
          appearance={payload.appearance}
          language={payload.language}
          logoAlt={payload.logoAlt}
        >
          <PageSteps
            page={current + 1}
            pages={pages.length}
            onBack={current > 0 ? () => setStep(current - 1) : null}
          />
          <FormBody
            form={pagePayload(payload, pages, current)}
            answers={answers}
            onAnswer={(questionId, value) =>
              setAnswers((existing) => ({ ...existing, [questionId]: value }))
            }
            files={files}
            onFiles={setFiles}
            error={null}
            sending={false}
            uploading={0}
            /* The bar measures the whole form, not the page in front of the
               operator — the link's does too. */
            progressOver={payload.questions}
            onSubmit={submit}
          />
        </Shell>
      )}
    </div>
  );
}
