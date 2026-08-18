"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { BrandMark, Icon } from "../../../components";
import { uploadEvidenceFile } from "../../../lib/client-upload";

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
 */

type PublicQuestion = {
  id: string;
  type: string;
  title: string;
  description: string | null;
  required: boolean;
  options: Array<{ label: string; value: string }> | null;
  showIf: { questionId: string; equals: string[] } | null;
  settings: {
    display: "Dropdown" | "Vertical" | "Horizontal";
    includeTime: boolean;
    prefill: string;
  };
};

type PublicFormPayload = {
  token: string;
  title: string;
  description: string | null;
  questions: PublicQuestion[];
  appearance: {
    layout: { alignment: string; type: string };
    background: { type: string; value: string | null };
    text: { font: string; size: string; color: string | null };
    logo: { url: string | null; size: string };
    primaryColor: string | null;
    hideBranding: boolean;
    showProgressBar: boolean;
    submitButton: { text: string | null };
  };
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
      const failed: string[] = [];
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
          failed.push(file.name);
        }
      }
      setUploading(0);

      setReference(result.request.id);
      setUploadWarning(
        failed.length
          ? `Your request was logged, but ${failed.length} file${failed.length > 1 ? "s" : ""} did not upload (${failed.join(", ")}). Please reply to the confirmation with them attached.`
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
        <div className="pf__done">
          {form.afterSubmission.showSuccessImage && <Icon name="check" size={34} />}
          <h2>{form.afterSubmission.title || "Thank you!"}</h2>
          <p>
            {form.afterSubmission.description || (
              <>
                Logged as <strong>{reference}</strong>.
              </>
            )}
          </p>
          {uploadWarning && (
            <p className="pf__error" role="alert">
              {uploadWarning}
            </p>
          )}
          {form.afterSubmission.allowResubmit && (
            <button type="button" className="pf__submit" onClick={() => setState("form")}>
              Submit another
            </button>
          )}
        </div>
      </Shell>
    );
  }

  /* A question with a `showIf` only appears once its trigger has been answered. */
  const visible = form.questions.filter((question) => {
    if (!question.showIf) return true;
    return question.showIf.equals.includes(answers[question.showIf.questionId] ?? "");
  });
  const answered = visible.filter((question) => (answers[question.id] ?? "").trim()).length;

  return (
    <Shell title={form.title} description={form.description} appearance={form.appearance} language={form.language}>
      {form.progressBar && (
        <div
          className="pf__progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={visible.length}
          aria-valuenow={answered}
          aria-label="Form progress"
        >
          <span style={{ width: `${visible.length ? (answered / visible.length) * 100 : 0}%` }} />
        </div>
      )}

      <form className="pf__form" onSubmit={submit}>
        {visible.map((question) => (
          <Question
            key={question.id}
            question={question}
            value={answers[question.id] ?? ""}
            onChange={(value) =>
              setAnswers((current) => ({ ...current, [question.id]: value }))
            }
            files={files}
            onFiles={setFiles}
          />
        ))}

        {error && (
          <p className="pf__error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="pf__submit" disabled={state === "sending"}>
          {state === "sending"
            ? uploading
              ? `Uploading ${uploading} of ${files.length}…`
              : "Sending…"
            : form.submitButtonText || "Submit"}
        </button>
      </form>
    </Shell>
  );
}

/**
 * The picker for a File question.
 *
 * Chosen files are held here until the work order exists, because /api/files
 * attaches to a request id and there is no request until the form is submitted.
 * The two-step is invisible to the submitter: pick, submit, and the uploads run
 * against the single-use grant the submit returns.
 *
 * Removal before submitting is deliberate — a phone camera roll makes it very
 * easy to attach the wrong photograph, and a list you cannot correct is worse
 * than no list.
 */
function FileField({
  files,
  onFiles,
  required,
  questionId,
}: {
  files: File[];
  onFiles: (files: File[]) => void;
  required: boolean;
  questionId: string;
}) {
  const inputId = `pf-file-${questionId}`;
  return (
    <div className="pf__files">
      <input
        id={inputId}
        type="file"
        multiple
        accept="image/*,video/*,.pdf"
        className="pf__fileinput"
        /*
         * `required` is NOT set on the input. The submitter may add files
         * across several goes, and the browser would refuse the form whenever
         * the picker itself was empty even though files are already staged.
         * The real check is in `submit`, and again on the server.
         */
        onChange={(event) => {
          const chosen = Array.from(event.target.files ?? []);
          if (chosen.length) onFiles([...files, ...chosen]);
          /* Reset so re-picking the same file fires a change event. */
          event.target.value = "";
        }}
      />
      <label htmlFor={inputId} className="pf__filebtn">
        <Icon name="camera" size={16} />
        {files.length ? "Add more" : "Choose photos or video"}
      </label>
      {required && !files.length && (
        <p className="pf__note">
          <Icon name="alert" size={14} />
          At least one photograph or video is required.
        </p>
      )}
      {files.length > 0 && (
        <ul className="pf__filelist">
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`}>
              <Icon name="paperclip" size={13} />
              <span className="pf__filename">{file.name}</span>
              <span className="pf__filesize">{Math.max(1, Math.round(file.size / 1024))} KB</span>
              <button
                type="button"
                onClick={() => onFiles(files.filter((_, at) => at !== index))}
                aria-label={`Remove ${file.name}`}
              >
                <Icon name="close" size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One question. */
function Question({
  question,
  value,
  onChange,
  files,
  onFiles,
}: {
  question: PublicQuestion;
  value: string;
  onChange: (value: string) => void;
  files: File[];
  onFiles: (files: File[]) => void;
}) {
  const label = (
    <span>
      {question.title}
      {question.required && <em aria-hidden="true"> *</em>}
    </span>
  );

  if (question.type === "SingleSelect") {
    /*
     * "Question display" — monday's Dropdown / Vertical / Horizontal. Laid-out
     * options are radios rather than a styled list, so one arrow-key sweep
     * moves through the group and a screen reader announces "3 of 4"; a div
     * with a click handler gets none of that for free.
     *
     * A radio GROUP cannot use the surrounding <label>: that label would name
     * the group and every option inside it at once. So the laid-out branch is
     * a fieldset with a legend, and only the dropdown keeps the label.
     */
    if (question.settings.display !== "Dropdown") {
      return (
        <fieldset
          className={`pf__field pf__choices pf__choices--${question.settings.display.toLowerCase()}`}
        >
          <legend>{label}</legend>
          {question.description && <small>{question.description}</small>}
          <div className="pf__choicelist">
            {question.options?.map((option) => (
              <label key={option.value} className="pf__choice">
                <input
                  type="radio"
                  name={question.id}
                  value={option.label}
                  required={question.required}
                  checked={value === option.label}
                  onChange={(event) => onChange(event.target.value)}
                />
                <span>{option.label || "—"}</span>
              </label>
            ))}
          </div>
        </fieldset>
      );
    }

    return (
      <label className="pf__field">
        {label}
        {question.description && <small>{question.description}</small>}
        <select
          required={question.required}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="" disabled>
            Choose an option
          </option>
          {question.options?.map((option) => (
            <option key={option.value} value={option.label}>
              {option.label || "—"}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (question.type === "Date") {
    return (
      <label className="pf__field">
        {label}
        {question.description && <small>{question.description}</small>}
        <input
          /* "Include time" turns the day picker into a day-and-time picker. */
          type={question.settings.includeTime ? "datetime-local" : "date"}
          required={question.required}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    );
  }

  if (question.type === "Number") {
    return (
      <label className="pf__field">
        {label}
        {question.description && <small>{question.description}</small>}
        <input
          type="text"
          inputMode="tel"
          required={question.required}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    );
  }

  if (question.type === "File") {
    return (
      <div className="pf__field pf__field--file">
        {label}
        {question.description && <small>{question.description}</small>}
        <FileField
          files={files}
          onFiles={onFiles}
          required={question.required}
          questionId={question.id}
        />
      </div>
    );
  }

  /* ShortText, LongText and anything new default to a text answer. */
  const long = question.type === "LongText" || question.title.toLowerCase().includes("descri");
  return (
    <label className="pf__field">
      {label}
      {question.description && <small>{question.description}</small>}
      {long ? (
        <textarea
          required={question.required}
          rows={4}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          type="text"
          required={question.required}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}

/**
 * The card the form sits on.
 *
 * The appearance settings are applied as inline custom properties rather than
 * as classes, because they are per-form values chosen by an operator — a class
 * cannot carry "#8a2be2". They are scoped to this element, so nothing here can
 * repaint the rest of the page.
 */
/**
 * Form language → a real `lang` and `dir` on the form.
 *
 * The setting used to persist and be read by nothing at all. It cannot invent
 * translations — there is no translation service wired up, and pretending
 * otherwise would be worse than leaving it — but the language a document is
 * written in is not cosmetic even when the words do not change:
 *
 *   · A screen reader picks its voice and pronunciation rules from `lang`.
 *     English prose read by an Arabic voice is unintelligible.
 *   · `dir="rtl"` genuinely re-lays-out the form — labels, the asterisk on a
 *     required field, the file list, the submit button — and the config has
 *     carried a `direction` field all along with nothing reading it.
 *   · Browsers use `lang` for spellcheck, hyphenation and font fallback.
 *
 * The map is small on purpose: exactly the languages the Settings panel
 * offers. An unrecognised value falls back to English rather than guessing.
 */
const LANGUAGE_TAGS: Record<string, { lang: string; dir: "ltr" | "rtl" }> = {
  "English (English)": { lang: "en", dir: "ltr" },
  "Arabic (العربية)": { lang: "ar", dir: "rtl" },
  "French (Français)": { lang: "fr", dir: "ltr" },
  "Spanish (Español)": { lang: "es", dir: "ltr" },
};

function localeFor(language: string | null | undefined) {
  return (language && LANGUAGE_TAGS[language]) || { lang: "en", dir: "ltr" as const };
}

function Shell({
  title,
  description,
  appearance,
  language,
  children,
}: {
  title?: string;
  description?: string | null;
  appearance?: PublicFormPayload["appearance"];
  language?: string | null;
  children: React.ReactNode;
}) {
  const style: React.CSSProperties & Record<string, string> = {} as never;
  if (appearance?.primaryColor) style["--pf-accent"] = appearance.primaryColor;
  if (appearance?.text.color) style["--pf-ink"] = appearance.text.color;
  if (appearance?.background.type === "Color" && appearance.background.value) {
    style["--pf-canvas"] = appearance.background.value;
  }
  if (appearance?.text.font) {
    style["--pf-font"] = `${appearance.text.font}, Inter, system-ui, sans-serif`;
  }

  const align = appearance?.layout.alignment ?? "Center";
  const locale = localeFor(language);

  return (
    <main
      className="pf"
      style={style}
      lang={locale.lang}
      dir={locale.dir}
      data-align={align.toLowerCase()}
      data-size={(appearance?.text.size ?? "Medium").toLowerCase()}
      data-layout={(appearance?.layout.type ?? "CARD").toLowerCase()}
    >
      <div className="pf__card">
        <header className="pf__head">
          {appearance?.logo.url ? (
            /*
             * An operator-supplied URL. Rendered with a plain <img> rather than
             * a framework image component because it is an arbitrary external
             * host that no loader is configured for, and it is decorative —
             * the form's own title carries the meaning.
             */
            // eslint-disable-next-line @next/next/no-img-element
            <img className="pf__logo" src={appearance.logo.url} alt="" />
          ) : (
            <BrandMark compact />
          )}
          {title && <h1>{title}</h1>}
          {description && <p className="pf__lede">{description}</p>}
        </header>
        {children}
      </div>
      {appearance && !appearance.hideBranding && (
        <p className="pf__brand">Powered by MAINTSUPP</p>
      )}
    </main>
  );
}
