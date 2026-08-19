"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Icon } from "../../../components";
import { uploadEvidenceFile } from "../../../lib/client-upload";
import {
  DoneScreen,
  FormBody,
  Shell,
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
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<File[]>([]);
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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (payload?.state !== "open") return;
    setError(null);

    /*
     * A required File question, checked before the request is sent so the
     * submitter is told at the point they can still fix it. The server checks
     * the same thing — this is the courtesy, that is the rule.
     */
    const needsFile = payload.form.questions.find(
      (question) => question.type === "File" && question.required,
    );
    if (needsFile && !files.length) {
      setError(`${needsFile.title} is required — please attach at least one photograph or video.`);
      return;
    }

    setState("sending");

    /*
     * Every answer is posted, keyed by question id, and the server decides what
     * each one means. The browser used to translate to a fixed seven-field
     * shape, which silently dropped answers to the other twelve questions —
     * so un-hiding a question in the builder produced a field that a submitter
     * filled in and nothing ever stored.
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
      <Shell title={form.title} appearance={form.appearance} language={form.language}>
        <DoneScreen
          form={form}
          reference={reference}
          warning={uploadWarning}
          onResubmit={() => setState("form")}
        />
      </Shell>
    );
  }

  return (
    <Shell title={form.title} description={form.description} appearance={form.appearance} language={form.language}>
      <FormBody
        form={form}
        answers={answers}
        onAnswer={(questionId, value) =>
          setAnswers((current) => ({ ...current, [questionId]: value }))
        }
        files={files}
        onFiles={setFiles}
        error={error}
        sending={state === "sending"}
        uploading={uploading}
        onSubmit={submit}
      />
    </Shell>
  );
}
