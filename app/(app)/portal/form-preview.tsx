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
 */
export default function FormPreview({ form }: { form: BuilderForm }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<File[]>([]);
  const [done, setDone] = useState(false);

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

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDone(true);
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
        <Shell title={payload.title} appearance={payload.appearance} language={payload.language}>
          <DoneScreen
            form={payload}
            reference=""
            onResubmit={() => {
              setDone(false);
              setAnswers({});
              setFiles([]);
            }}
          />
        </Shell>
      ) : (
        <Shell
          title={payload.title}
          description={payload.description}
          appearance={payload.appearance}
          language={payload.language}
        >
          <FormBody
            form={payload}
            answers={answers}
            onAnswer={(questionId, value) =>
              setAnswers((current) => ({ ...current, [questionId]: value }))
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
