"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import type { Ref } from "react";

/*
 * The restore below must happen after React has written the new `type` and
 * before the browser paints, or the caret is visibly somewhere else for a
 * frame. That is `useLayoutEffect`, which React warns about when a component is
 * rendered on the server — and this one is. Picking the effect by environment
 * is the usual answer: on the server neither effect runs at all.
 */
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * A password field with a show/hide control — the two on the invitation page,
 * and the two on the reset page.
 *
 * IT LIVES HERE, ONE LEVEL ABOVE BOTH ROUTES, because Vite reads `[` and `]` as
 * glob syntax: an import that crosses `invite/[token]/` from another route does
 * not resolve, so the reset page could not have reached it in its old home. The
 * same constraint already put `reset.css` a level up. One implementation rather
 * than two is the point — a second copy is how two password fields end up with
 * different keyboard behaviour and different accessible names.
 *
 * UNCONTROLLED, ON PURPOSE. React keeps a controlled input's `value` ATTRIBUTE
 * in step with what is typed, so a controlled password field writes the
 * password into the page's markup, where anything that reads the DOM — an
 * extension, a CSS attribute selector, a copy of `outerHTML` in a bug report —
 * can see it. The value lives only in the input's own `value` property here,
 * and the form reads it from the ref at the moment it submits.
 *
 * What the toggle changes is `type`, and nothing else: not the value, not the
 * `autocomplete="new-password"` hint a password manager looks for. The form
 * switches both fields back to hidden before it submits, so a manager watching
 * the submission sees password fields as it always has.
 *
 * THE BROWSER THROWS THE CARET AWAY WHEN `type` CHANGES, and this file used to
 * claim otherwise. Measured in Chromium: type "abcdef123456", put the caret
 * after "abcdef", press the eye, and `selectionStart` is 0 — the next character
 * typed lands at the FRONT of the password. Preventing `mousedown` keeps focus
 * in the field, which is why the jump was easy to miss: the field is still
 * live, so the damage only shows on the next keystroke. Keyboard activation had
 * it too, and it is worse there, because the eye is how somebody checking their
 * typing looks at it mid-word.
 *
 * So the selection is carried across the change by hand: read it as the toggle
 * is pressed, and put it back once React has written the new `type`. The whole
 * range is restored, not just a collapsed caret, so a selected run of
 * characters is still selected afterwards — and the field only takes focus back
 * if it had it, leaving keyboard users on the button they just pressed.
 *
 * The button is a real `<button type="button">`: Enter and Space work, it never
 * submits the form, and its accessible name says what pressing it will do.
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
  const carried = useRef<
    { start: number; end: number; direction: "forward" | "backward" | "none"; focused: boolean } | null
  >(null);

  /*
   * The field is found by its own `id` rather than through a second ref. The
   * caller owns the ref this input carries — it is how the form reads the
   * password at submit — and wrapping it to slip another one underneath means
   * writing to somebody else's ref from a callback, which is exactly what the
   * compiler rules refuse. The id is already required here, and it is what
   * `htmlFor` and `aria-controls` point at, so it identifies this one input.
   */
  const fieldNode = () =>
    typeof document === "undefined" ? null : (document.getElementById(id) as HTMLInputElement | null);

  function press() {
    const node = fieldNode();
    carried.current = null;
    if (node) {
      try {
        const { selectionStart, selectionEnd, selectionDirection } = node;
        if (selectionStart !== null && selectionEnd !== null) {
          carried.current = {
            start: selectionStart,
            end: selectionEnd,
            direction: selectionDirection ?? "none",
            focused: document.activeElement === node,
          };
        }
      } catch {
        /* Selection is not readable on every input in every browser. Losing
           the position is the old behaviour, not a reason to fail the click. */
      }
    }
    onToggle();
  }

  useBrowserLayoutEffect(() => {
    const node = fieldNode();
    const saved = carried.current;
    carried.current = null;
    if (!node || !saved) return;

    const restore = () => {
      try {
        /* Only take focus back if the field had it: pressing the control with
           the keyboard should leave the reader on the control. */
        if (saved.focused && document.activeElement !== node) node.focus({ preventScroll: true });
        node.setSelectionRange(saved.start, saved.end, saved.direction);
      } catch {
        /* A browser that refuses the range leaves the caret where it put it. */
      }
    };

    /*
     * TWICE, AND THE SECOND ONE IS THE ONE THAT HOLDS. Chromium clears the
     * selection AFTER the `type` change rather than during it: measured here,
     * a restore made synchronously in this effect is itself undone, and the
     * caret ends at 0 anyway. A restore on the next frame survives. The
     * synchronous one stays because it is what the first paint draws, so the
     * caret is never seen somewhere else.
     */
    restore();
    const frame = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(frame);
  }, [shown, id]);

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
          onClick={press}
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
