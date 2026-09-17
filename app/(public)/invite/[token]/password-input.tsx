"use client";

import type { Ref } from "react";

/**
 * A password field with a show/hide control — the invitation page's two.
 *
 * UNCONTROLLED, ON PURPOSE. React keeps a controlled input's `value` ATTRIBUTE
 * in step with what is typed, so a controlled password field writes the
 * password into the page's markup, where anything that reads the DOM — an
 * extension, a CSS attribute selector, a copy of `outerHTML` in a bug report —
 * can see it. The value lives only in the input's own `value` property here,
 * and the form reads it from the ref at the moment it submits.
 *
 * What the toggle changes is `type`, and nothing else. Switching between
 * `password` and `text` does not touch the value, the caret or the
 * `autocomplete="new-password"` hint a password manager looks for; the form
 * switches both fields back to hidden before it submits, so a manager watching
 * the submission sees password fields as it always has.
 *
 * The button is a real `<button type="button">`: Enter and Space work, it never
 * submits the form, and its accessible name says what pressing it will do.
 * `onMouseDown` is prevented so a click leaves focus — and the caret — in the
 * field the person is typing into.
 */
export function PasswordInput({
  id,
  name,
  label,
  revealLabel,
  shown,
  onToggle,
  disabled,
  inputRef,
  describedBy,
  children,
}: {
  id: string;
  name: string;
  label: string;
  /** What the control reveals, for its accessible name: "password". */
  revealLabel: string;
  shown: boolean;
  onToggle: () => void;
  disabled: boolean;
  inputRef: Ref<HTMLInputElement>;
  describedBy?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="invite__field">
      <label htmlFor={id}>{label}</label>
      <div className="invite__password">
        <input
          ref={inputRef}
          id={id}
          name={name}
          type={shown ? "text" : "password"}
          autoComplete="new-password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          required
          disabled={disabled}
          defaultValue=""
          aria-describedby={describedBy}
        />
        <button
          type="button"
          className="invite__reveal"
          data-shown={shown ? "true" : "false"}
          aria-label={`${shown ? "Hide" : "Show"} ${revealLabel}`}
          aria-controls={id}
          title={`${shown ? "Hide" : "Show"} ${revealLabel}`}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onToggle}
        >
          {shown ? <EyeClosed /> : <EyeOpen />}
        </button>
      </div>
      {children}
    </div>
  );
}

function EyeOpen() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeClosed() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 3l18 18" />
      <path d="M10.6 5.6A10.6 10.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17.4 17.4 0 0 1-3.1 3.9" />
      <path d="M6.4 6.9C3.9 8.6 2.5 12 2.5 12s3.5 6.5 9.5 6.5a9.6 9.6 0 0 0 4.4-1.1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}
