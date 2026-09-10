"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Icon } from "../../../components";
import { uploadEvidenceFile } from "../../../lib/client-upload";
import {
  askedPages,
  askedQuestions,
  type PublicQuestion,
} from "../../../lib/form-projection";
import {
  DoneScreen,
  FormBody,
  PageSteps,
  Shell,
  WelcomeScreen,
  pagePayload,
  type PublicFormPayload,
} from "./form-renderer";

/**
 * The page somebody sees when they open a shared form link.
 *
 * WORKS ON EVERY DEVICE, BY DESIGN. The builder that produced this form is
 * desktop-only; the form itself is not, and it is the surface a store manager
 * actually opens — on a phone, standing in front of the broken thing they are
 * reporting. So the layout is single-column at every width, the inputs are
 * 16px (below that iOS zooms on focus and does not zoom back), and nothing here
 * depends on hover.
 *
 * FIVE STATES, NOT ONE. A link can resolve to a form that is open, locked
 * behind a password, waiting for a sign-in, closed, or gone. Each says which,
 * because "this didn't work" is the one answer that generates a phone call.
 *
 * AND, WITHIN "OPEN", A WALK RATHER THAN A SCROLL. A form can be built with a
 * welcome page in front of it and broken into pages; this page honours both.
 * `step` is the whole of that state — -1 for the welcome page, 0..n-1 for the
 * pages — and it is the ONLY thing paging adds to this file, because:
 *
 *   · the answers and the chosen files stay in the single lifted state they
 *     were always in, so unmounting a page's fields loses nothing and the
 *     submit still posts every answer to every page (see the note on the
 *     request body: this file has already been bitten once by a submit that
 *     sent a subset);
 *   · where the pages BREAK comes from the server's payload, and splitting on
 *     it is `askedPages` in form-projection.ts, shared with the builder's
 *     Preview;
 *   · what a page LOOKS like is `FormBody` over `pagePayload`, shared with the
 *     builder's Preview.
 *
 * WHAT LIVES HERE AND WHAT DOES NOT. This file owns everything that talks to
 * the server — the fetch, the gates, the password unlock, the submit and the
 * uploads. What the form LOOKS like lives in `form-renderer.tsx`, shared with
 * the builder's Preview, so the preview an operator checks and the page a
 * submitter opens are one implementation.
 */

type Payload =
  | { state: "open"; form: PublicFormPayload }
  | { state: "locked"; title: string }
  | { state: "login-required"; title: string }
  | { state: "unavailable"; reason: string; title: string; message: string };

export default function PublicForm({ token }: { token: string }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [failed, setFailed] = useState(false);
  /*
   * ONE answers object for the WHOLE form, keyed by question id — never one per
   * page. React unmounts a page's fields when the submitter moves on, so state
   * held inside them would be state thrown away, and the submitter would find
   * page 1 blank on the way back. This is also what makes the final POST
   * complete: it sends this object, not the page in front of the submitter.
   * The chosen files are one list for the same reason, and because the form
   * uploads them all against the one work order the submit creates.
   */
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<File[]>([]);
  /**
   * Which page, or the welcome page.
   *
   * -1 is the welcome page and 0..n-1 are the form's pages. One number rather
   * than an index beside a `showWelcome` boolean, because two pieces of state
   * for one position is two pieces of state that can disagree.
   *
   * NO EFFECT DECIDES THE STARTING STEP, which is the same design the builder's
   * Preview settled on: the welcome branch below asks for `step < 0 &&
   * form.welcome.enabled`, so a form served without a welcome page starts on
   * page 0 with nothing to reconcile. Resetting `step` from an effect once the
   * payload arrived would be a `setState` in an effect — the cascading render
   * the React Compiler's `react-hooks/set-state-in-effect` rule refuses.
   */
  const [step, setStep] = useState(-1);
  const [uploading, setUploading] = useState(0);
  const [password, setPassword] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [state, setState] = useState<"form" | "sending" | "done">("form");
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const [uploadWarning, setUploadWarning] = useState<string | null>(null);

  const load = useMemo(
    () => async () => {
      try {
        const response = await fetch(`/api/forms/${token}`, {
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error("unavailable");
        setPayload((await response.json()) as Payload);
      } catch {
        setFailed(true);
      }
    },
    [token],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * Load the configured webfont — and only then.
   *
   * The Design panel offers Poppins, Figtree, Manrope, Rubik and Roboto, and
   * the public route deliberately loads no shared stylesheet (see the layout:
   * this page is opened on mobile data, in a service corridor). So the font
   * stack resolved to whatever the device happened to have, which meant the
   * picker did nothing on most phones — a control that changed a stored value
   * and nothing a submitter could see.
   *
   * The link is appended once, only when the chosen face is one that needs
   * fetching, so a form left on the default costs no extra request. `display=swap`
   * keeps the text readable while it loads rather than blocking on it.
   */
  useEffect(() => {
    if (payload?.state !== "open") return;
    const face = payload.form.appearance.text.font;
    const FETCHED = ["Poppins", "Figtree", "Manrope", "Rubik", "Roboto"];
    if (!face || !FETCHED.includes(face)) return;

    const id = `pf-font-${face}`;
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(face)}:wght@400;600;700&display=swap`;
    document.head.appendChild(link);
  }, [payload]);

  /*
   * Seed the answers from the server-computed prefills.
   *
   * Only once, and only for fields the submitter has not touched: re-applying
   * on every render would fight the person typing. "Today as default" is
   * computed on the server (see `resolvePrefill`) precisely so the date shown
   * and the date validated come from one clock.
   */
  useEffect(() => {
    if (payload?.state !== "open") return;
    setAnswers((current) => {
      const seeded = { ...current };
      let changed = false;
      for (const question of payload.form.questions) {
        if (question.settings.prefill && seeded[question.id] === undefined) {
          seeded[question.id] = question.settings.prefill;
          changed = true;
        }
      }
      return changed ? seeded : current;
    });
  }, [payload]);

  /*
   * The form, split into the pages a submitter actually walks.
   *
   * Recomputed as the answers change, and it has to be: a page whose every
   * question sits behind a `showIf` is not a page until one of those triggers
   * matches, and it stops being one again if the trigger is un-answered.
   * `askedPages` never returns an empty page, so stepping through this list
   * skips a hollow one in BOTH directions without this file owning any logic
   * for it — the version of that which cannot be got wrong on Back.
   */
  const pages = useMemo<PublicQuestion[][]>(
    () => (payload?.state === "open" ? askedPages(payload.form.questions, answers) : [[]]),
    [payload, answers],
  );

  /*
   * Clamped, not corrected. Answering a trigger can take away the page the
   * submitter is standing on (its questions were conditional on the answer
   * they just changed), and a clamp is the one response to that which cannot
   * leave them on a page that no longer exists.
   */
  const current = Math.min(Math.max(step, 0), pages.length - 1);
  const last = current === pages.length - 1;

  /* Both page moves put the submitter at the top of the new page. Instant
     rather than smooth: this is a page change, not a scroll, and `scrollTo`
     does not consult prefers-reduced-motion. */
  function goTo(next: number) {
    setStep(next);
    window.scrollTo(0, 0);
  }

  /**
   * A required File question with nothing attached, or null.
   *
   * Files are ONE list for the whole form while File questions sit on pages,
   * so this is asked twice with different scopes and both matter:
   *
   *   · with the current page's questions, before leaving it — the point at
   *     which the field the message names is still on screen. The browser
   *     cannot do this one: `FileField` deliberately does not set `required`
   *     on the input (see the note there), so native validation lets Next
   *     through;
   *   · with the WHOLE form's questions, at submit — so a required File
   *     question the submitter somehow got past cannot be stranded on a page
   *     behind them, which is the failure a per-page check on its own has.
   *
   * Scoped through `askedQuestions` in both cases, so a File question whose
   * `showIf` never matched is not required — that is the rule the submit route
   * applies, and refusing a form over a field nobody was shown would be a dead
   * end with no way out of it.
   */
  function fileProblem(scope: PublicQuestion[]) {
    const needsFile = askedQuestions(scope, answers).find(
      (question) => question.type === "File" && question.required,
    );
    if (!needsFile || files.length) return null;
    return `${needsFile.title} is required — please attach at least one photograph or video.`;
  }

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setUnlockError(null);
    const response = await fetch(`/api/forms/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) {
      setUnlockError("That password is not right.");
      return;
    }
    setPassword("");
    await load();
  }

  /**
   * The form's one submit handler — which, on any page but the last, ADVANCES.
   *
   * It is the form's own `onSubmit` and not a separate Next button on purpose:
   * that is what keeps the browser's native validation of the mounted required
   * fields in front of the move. Per page is exactly the right scope for it —
   * the fields on pages the submitter has not reached are not in the document
   * to validate, and the ones behind them were validated on the way through.
   * Pressing Enter in a text field advances for the same reason.
   */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (payload?.state !== "open") return;
    setError(null);

    /*
     * A required File question, checked before the page is left and again
     * before the request is sent, so the submitter is told at the point they
     * can still fix it. The server checks the same thing — this is the
     * courtesy, that is the rule.
     */
    const problem = fileProblem(last ? payload.form.questions : pages[current]);
    if (problem) {
      setError(problem);
      return;
    }

    if (!last) {
      goTo(current + 1);
      return;
    }

    setState("sending");

    /*
     * Every answer is posted, keyed by question id, and the server decides what
     * each one means. The browser used to translate to a fixed seven-field
     * shape, which silently dropped answers to the other twelve questions —
     * so un-hiding a question in the builder produced a field that a submitter
     * filled in and nothing ever stored. Paging does not touch this: `answers`
     * is the whole form's, so a page the submitter left ten minutes ago is in
     * the body exactly as it was.
     */
    try {
      const response = await fetch(`/api/forms/${token}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers, fileCount: files.length }),
      });
      const result = (await response.json()) as {
        request?: { id: string };
        uploadToken?: string | null;
        error?: string;
      };
      if (!response.ok || !result.request) {
        throw new Error(result.error || "Your request could not be submitted.");
      }

      /*
       * The uploads run AFTER the work order exists, because that is what they
       * attach to. A failure here is reported but does not undo the job: a
       * logged request with no photograph is recoverable — the coordinator can
       * ask — whereas throwing away a submitted request is not.
       */
      const failedUploads: string[] = [];
      for (const [index, file] of files.entries()) {
        setUploading(index + 1);
        try {
          await uploadEvidenceFile({
            file,
            requestId: result.request.id,
            uploadToken: result.uploadToken ?? undefined,
            kind: "issue",
          });
        } catch {
          failedUploads.push(file.name);
        }
      }
      setUploading(0);

      setReference(result.request.id);
      setUploadWarning(
        failedUploads.length
          ? `Your request was logged, but ${failedUploads.length} file${failedUploads.length > 1 ? "s" : ""} did not upload (${failedUploads.join(", ")}). Please reply to the confirmation with them attached.`
          : null,
      );
      setState("done");
      setAnswers({});
      setFiles([]);

      const redirect = payload.form.afterSubmission.redirectUrl;
      if (redirect) window.location.href = redirect;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Your request could not be submitted.");
      setState("form");
    }
  }

  if (failed) {
    return (
      <Shell>
        <p className="pf__message">This form could not be found.</p>
      </Shell>
    );
  }
  if (!payload) {
    return (
      <Shell>
        <p className="pf__message">Loading the form…</p>
      </Shell>
    );
  }

  if (payload.state === "unavailable") {
    return (
      <Shell title={payload.title}>
        <p className="pf__message">
          <Icon name="alert" size={18} />
          {payload.message}
        </p>
      </Shell>
    );
  }

  if (payload.state === "login-required") {
    return (
      <Shell title={payload.title}>
        <p className="pf__message">
          <Icon name="shield" size={18} />
          This form is only open to people signed in to this workspace.
        </p>
        <a className="pf__submit" href="/login">
          Sign in
        </a>
      </Shell>
    );
  }

  if (payload.state === "locked") {
    return (
      <Shell title={payload.title}>
        <form className="pf__lock" onSubmit={unlock}>
          <p className="pf__message">
            <Icon name="shield" size={18} />
            This form is password protected.
          </p>
          <label className="pf__field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {unlockError && <p className="pf__error">{unlockError}</p>}
          <button type="submit" className="pf__submit">
            Open the form
          </button>
        </form>
      </Shell>
    );
  }

  const { form } = payload;

  if (state === "done") {
    return (
      <Shell
        title={form.title}
        appearance={form.appearance}
        language={form.language}
        logoAlt={form.logoAlt}
      >
        <DoneScreen
          form={form}
          reference={reference}
          warning={uploadWarning}
          onResubmit={() => {
            setState("form");
            /* A second response starts where the first one did, welcome page
               and all — it is a new submission, not a continuation. */
            setStep(form.welcome.enabled ? -1 : 0);
          }}
        />
      </Shell>
    );
  }

  /*
   * THE WELCOME PAGE. Its own card, drawn by the renderer so the link and the
   * builder's Preview cannot show different ones — including which title it
   * falls back to when the welcome page has none of its own.
   */
  if (step < 0 && form.welcome.enabled) {
    return <WelcomeScreen form={form} onStart={() => goTo(0)} />;
  }

  return (
    <Shell
      title={form.title}
      /*
       * The form's description introduces the FORM, so it belongs to the first
       * page. Repeated above page 3 it reads as a mistake.
       */
      description={current === 0 ? form.description : null}
      appearance={form.appearance}
      language={form.language}
      logoAlt={form.logoAlt}
    >
      <PageSteps
        page={current + 1}
        pages={pages.length}
        /* Back is non-destructive because the answers and the files live here,
           above the fields, and nothing is cleared on the way. */
        onBack={current > 0 ? () => goTo(current - 1) : null}
      />
      <FormBody
        form={pagePayload(form, pages, current)}
        answers={answers}
        onAnswer={(questionId, value) =>
          setAnswers((existing) => ({ ...existing, [questionId]: value }))
        }
        files={files}
        onFiles={setFiles}
        error={error}
        sending={state === "sending"}
        uploading={uploading}
        /* The bar measures the whole form, not the page in front of the
           submitter — see `progressOver`. */
        progressOver={form.questions}
        onSubmit={submit}
      />
    </Shell>
  );
}
