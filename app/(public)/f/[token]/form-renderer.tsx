"use client";

import type { FormEvent } from "react";
import { BrandMark, Icon } from "../../../components";
import {
  askedQuestions,
  type PublicQuestion,
  type WelcomePage,
} from "../../../lib/form-projection";
import publicFormCss from "./public-form.css?url";

/**
 * THE form renderer — the one implementation of what a submitter sees.
 *
 * Two surfaces mount this and they must never drift:
 *
 *   · the public /f/:token page, for the person the link was sent to;
 *   · the builder's Preview, which renders the SAME components in the browser
 *     from the configuration being edited.
 *
 * Preview used to frame the public route in an iframe, which `worker/index.ts`
 * refuses wholesale with `X-Frame-Options: DENY` — that header is deliberate
 * and stays. Sharing the components is the fix that needs no security trade:
 * there is nothing to frame when the renderer itself is importable.
 *
 * Everything here is presentational. Fetching, the availability gates, the
 * password unlock and the real submit live in `public-form.tsx`; the preview
 * substitutes its own harmless handlers. Nothing in this module may import
 * anything server-only — `form-projection.ts` is pure, and the rest of what
 * this file takes from it is type-only and erases.
 *
 * WHAT A MULTI-PAGE FORM ADDS HERE, AND WHAT IT DELIBERATELY DOES NOT. A page
 * is not a new layout: it is the SAME `FormBody` over one page's questions
 * (`pagePayload` builds that), with `PageSteps` above it and the welcome
 * screen in front. Which page a submitter is on, and what happens when they
 * press the button, stay with the two mounts — because on the link that button
 * eventually POSTs and in Preview it never does. Everything a submitter can
 * SEE is here, once, so the two cannot drift; the page count printed on the
 * button is the case in point, and it used to be written out at each mount.
 */

export type PublicFormPayload = {
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
  /** The screen before the first question. Drawn by `WelcomeScreen`. */
  welcome: WelcomePage;
  /** `accessibility.logoAltText` — what the logo says out loud. */
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
 * The stylesheet, carried by the renderer itself so every mount is styled.
 *
 * React 19 hoists a precedenced stylesheet link into the head and dedupes it
 * by href, so the public page (which also links it) and the builder's Preview
 * each cost one fetch at most. The builder therefore needs no import of its
 * own — mounting the renderer is enough.
 */
function RendererStyles() {
  return <link rel="stylesheet" href={publicFormCss} precedence="default" />;
}

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
export const LANGUAGE_TAGS: Record<string, { lang: string; dir: "ltr" | "rtl" }> = {
  "English (English)": { lang: "en", dir: "ltr" },
  "Arabic (العربية)": { lang: "ar", dir: "rtl" },
  "French (Français)": { lang: "fr", dir: "ltr" },
  "Spanish (Español)": { lang: "es", dir: "ltr" },
};

export function localeFor(language: string | null | undefined) {
  return (language && LANGUAGE_TAGS[language]) || { lang: "en", dir: "ltr" as const };
}

/**
 * The card the form sits on.
 *
 * The appearance settings are applied as inline custom properties rather than
 * as classes, because they are per-form values chosen by an operator — a class
 * cannot carry "#8a2be2". They are scoped to this element, so nothing here can
 * repaint the rest of the page (or, in Preview, the builder around it).
 */
export function Shell({
  title,
  description,
  appearance,
  language,
  logoAlt,
  children,
}: {
  title?: string;
  description?: string | null;
  appearance?: PublicFormPayload["appearance"];
  language?: string | null;
  logoAlt?: string | null;
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
      <RendererStyles />
      <div className="pf__card">
        <header className="pf__head">
          {appearance?.logo.url ? (
            /*
             * An operator-supplied URL. Rendered with a plain <img> rather than
             * a framework image component because it is an arbitrary external
             * host that no loader is configured for.
             *
             * The `alt` is the operator's own `accessibility.logoAltText`. An
             * empty one is not a shortcoming — a mark beside a heading that
             * already names the organisation IS decorative, and `alt=""` is how
             * that is said to a screen reader. What was wrong was hard-coding
             * it: the Design panel has collected this sentence since the monday
             * import and nothing read it, so a form whose logo was the only
             * thing naming the client announced itself as "image".
             */
            // eslint-disable-next-line @next/next/no-img-element
            <img className="pf__logo" src={appearance.logo.url} alt={logoAlt ?? ""} />
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

/**
 * The picker for a File question.
 *
 * Chosen files are held in the caller's state until the work order exists,
 * because /api/files attaches to a request id and there is no request until
 * the form is submitted. The two-step is invisible to the submitter: pick,
 * submit, and the uploads run against the single-use grant the submit returns.
 * (In Preview the same component runs and the files simply never leave the
 * browser — there is nothing to upload to.)
 *
 * Removal before submitting is deliberate — a phone camera roll makes it very
 * easy to attach the wrong photograph, and a list you cannot correct is worse
 * than no list.
 */
export function FileField({
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
         * The real check is in the submit handler, and again on the server.
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
export function Question({
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
 * A question with a `showIf` only appears once its trigger has been answered.
 *
 * One line, because it used to be a second copy of `askedQuestions` — same
 * filter, same fallback, written out twice. That was harmless while nothing
 * else read it; it stopped being harmless when `askedPages` began deciding
 * whether a PAGE is empty by the same rule. Two copies of "is this asked"
 * would let a page be judged worth showing and then render nothing on it.
 * The name stays: out here the rule is about what is VISIBLE, and the callers
 * read better for it.
 */
export const visibleQuestions = askedQuestions;

/**
 * The payload for ONE page: the same form, narrowed to that page's questions.
 *
 * The whole of what "a page" means to `FormBody`, and the reason it needed no
 * other change. `submitButtonText` is the only other difference — a page that
 * is not the last one says where it is going, because a button that says
 * "Submit" and does not submit is the worst thing a paginated form can do.
 *
 * Shared, and this is the sharpest case for it: the public link and the
 * builder's Preview each print this page count on a button, and each used to
 * build the sentence itself. A form that said "Next - page 2 of 3" in the
 * builder and something else on the link would be a defect nobody could see
 * without opening both.
 */
export function pagePayload(
  form: PublicFormPayload,
  pages: PublicQuestion[][],
  index: number,
): PublicFormPayload {
  const last = index >= pages.length - 1;
  return {
    ...form,
    questions: pages[index] ?? [],
    submitButtonText: last
      ? form.submitButtonText
      : `Next — page ${index + 2} of ${pages.length}`,
  };
}

/**
 * Where the submitter is, and the way back.
 *
 * Nothing at all on a single-page form — the overwhelming majority — which is
 * decided HERE rather than at each mount, so neither can forget it.
 *
 * Back is a button and not a link because there is no history entry to go to:
 * the pages are one mounted component and the answers live above it, which is
 * what makes going back non-destructive. `onBack` is null on the first page.
 */
export function PageSteps({
  page,
  pages,
  onBack,
}: {
  /** 1-based, as a submitter counts them. */
  page: number;
  pages: number;
  onBack: (() => void) | null;
}) {
  if (pages < 2) return null;
  return (
    <p className="pf__steps">
      <span>
        Page {page} of {pages}
      </span>
      {onBack && (
        <button type="button" onClick={onBack}>
          <Icon name="arrow" size={13} />
          Back
        </button>
      )}
    </p>
  );
}

/**
 * The welcome page, card and all.
 *
 * The one component here that draws its own `Shell`, deliberately: which title
 * it shows is a rule (`welcome.title`, falling back to the form's own), and
 * that rule is exactly the sort of detail that drifts when two mounts each
 * wrap their own card around it. Everything else — the accent, the background,
 * the font, the logo, the language and its direction — comes free from being
 * the same card the form is drawn on. A welcome page that looked like a
 * different product would be worse than none.
 */
export function WelcomeScreen({
  form,
  onStart,
}: {
  form: PublicFormPayload;
  onStart: () => void;
}) {
  return (
    <Shell
      title={form.welcome.title || form.title}
      appearance={form.appearance}
      language={form.language}
      logoAlt={form.logoAlt}
    >
      <div className="pf__welcome">
        {form.welcome.description && <p>{form.welcome.description}</p>}
        <button type="button" className="pf__submit" onClick={onStart}>
          {form.welcome.startButton.text || "Start"}
        </button>
      </div>
    </Shell>
  );
}

/**
 * The fillable form — progress bar, questions, error line and submit button.
 *
 * Controlled by the caller: the public page owns real answers and a real
 * submit; the preview owns throwaway answers and a submit that only shows the
 * thank-you screen. Neither owns a second copy of the layout.
 */
export function FormBody({
  form,
  answers,
  onAnswer,
  files,
  onFiles,
  error,
  sending,
  uploading,
  progressOver,
  onSubmit,
}: {
  form: PublicFormPayload;
  answers: Record<string, string>;
  onAnswer: (questionId: string, value: string) => void;
  files: File[];
  onFiles: (files: File[]) => void;
  error: string | null;
  sending: boolean;
  /** 1-based index of the file currently uploading, or 0. */
  uploading: number;
  /**
   * The questions the progress bar measures, when they are not the ones being
   * drawn. A paginated form passes the WHOLE form's list: a bar that filled up
   * and then reset to nothing on page 2 would be reporting progress through the
   * page, which is not what anybody wants to know from it.
   */
  progressOver?: PublicQuestion[];
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const visible = visibleQuestions(form.questions, answers);
  const tracked = visibleQuestions(progressOver ?? form.questions, answers);
  const answered = tracked.filter((question) => (answers[question.id] ?? "").trim()).length;

  return (
    <>
      {form.progressBar && (
        <div
          className="pf__progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={tracked.length}
          aria-valuenow={answered}
          aria-label="Form progress"
        >
          <span style={{ width: `${tracked.length ? (answered / tracked.length) * 100 : 0}%` }} />
        </div>
      )}

      <form className="pf__form" onSubmit={onSubmit}>
        {visible.map((question) => (
          <Question
            key={question.id}
            question={question}
            value={answers[question.id] ?? ""}
            onChange={(value) => onAnswer(question.id, value)}
            files={files}
            onFiles={onFiles}
          />
        ))}

        {error && (
          <p className="pf__error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="pf__submit" disabled={sending}>
          {sending
            ? uploading
              ? `Uploading ${uploading} of ${files.length}…`
              : "Sending…"
            : form.submitButtonText || "Submit"}
        </button>
      </form>
    </>
  );
}

/** The after-submission screen, exactly as the settings configure it. */
export function DoneScreen({
  form,
  reference,
  warning,
  onResubmit,
}: {
  form: PublicFormPayload;
  /** The created work order's id, or empty (Preview creates nothing). */
  reference: string;
  warning?: string | null;
  onResubmit: () => void;
}) {
  return (
    <div className="pf__done">
      {form.afterSubmission.showSuccessImage && <Icon name="check" size={34} />}
      <h2>{form.afterSubmission.title || "Thank you!"}</h2>
      <p>
        {form.afterSubmission.description ||
          (reference ? (
            <>
              Logged as <strong>{reference}</strong>.
            </>
          ) : (
            "Your request was received."
          ))}
      </p>
      {warning && (
        <p className="pf__error" role="alert">
          {warning}
        </p>
      )}
      {form.afterSubmission.allowResubmit && (
        <button type="button" className="pf__submit" onClick={onResubmit}>
          Submit another
        </button>
      )}
    </div>
  );
}
