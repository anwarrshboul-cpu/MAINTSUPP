"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { BrandMark, Icon } from "../../../components";

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
  const [password, setPassword] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [state, setState] = useState<"form" | "sending" | "done">("form");
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState("");

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
        body: JSON.stringify({ answers }),
      });
      const result = (await response.json()) as { request?: { id: string }; error?: string };
      if (!response.ok || !result.request) {
        throw new Error(result.error || "Your request could not be submitted.");
      }
      setReference(result.request.id);
      setState("done");
      setAnswers({});

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
      <Shell title={form.title} appearance={form.appearance}>
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
    <Shell title={form.title} description={form.description} appearance={form.appearance}>
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
          />
        ))}

        {error && (
          <p className="pf__error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="pf__submit" disabled={state === "sending"}>
          {state === "sending" ? "Sending…" : form.submitButtonText || "Submit"}
        </button>
      </form>
    </Shell>
  );
}

/**
 * One question.
 *
 * File questions are rendered but NOT wired to an upload. The public submit
 * route creates the job and returns; attaching evidence needs an upload grant
 * that an anonymous submitter does not hold. Saying so on the field is better
 * than a control that silently drops what somebody attached.
 */
function Question({
  question,
  value,
  onChange,
}: {
  question: PublicQuestion;
  value: string;
  onChange: (value: string) => void;
}) {
  const label = (
    <span>
      {question.title}
      {question.required && <em aria-hidden="true"> *</em>}
    </span>
  );

  if (question.type === "SingleSelect") {
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
          type="date"
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
        <p className="pf__note">
          <Icon name="paperclip" size={14} />
          Photographs are collected after the request is logged — the coordinator will
          reply with an upload link.
        </p>
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
function Shell({
  title,
  description,
  appearance,
  children,
}: {
  title?: string;
  description?: string | null;
  appearance?: PublicFormPayload["appearance"];
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

  return (
    <main
      className="pf"
      style={style}
      data-align={align.toLowerCase()}
      data-size={(appearance?.text.size ?? "Medium").toLowerCase()}
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
