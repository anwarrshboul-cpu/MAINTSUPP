"use client";

import * as React from "react";
import { Icon, type IconName } from "../../components";

/**
 * The three controls every builder surface is made of.
 *
 * MOVED HERE, NOT REWRITTEN. They lived at the top of `form-builder-panels.tsx`
 * and were private to it, which was fine while there were three panels in one
 * file. The Edit surface has since grown a Content rail with pages, an
 * insertion control, per-question move controls and a field picker, and it is
 * its own file now — so `DraftInput` was about to be either imported from a
 * component file that also draws two other panels, or copied. A copy of the
 * focus fix below is the thing to avoid: it is subtle, it was found in a
 * browser, and a second copy would drift out of it silently.
 */

/**
 * A text-ish input that can actually be typed into.
 *
 * THE BUG THIS EXISTS TO FIX. Typing one character into any of these fields
 * lost focus, so a value had to be entered one character per click. The cause
 * was not remounting and not the list identity — the question cards are keyed
 * by stable monday column ids and React reconciles them in place. It was
 * `disabled={busy}`:
 *
 *     keystroke → patch() → setBusy(true) → React commits disabled={true}
 *     → the user agent BLURS the disabled control → PATCH resolves
 *     → setBusy(false) → the input is re-enabled, and nothing re-focuses it
 *
 * Disabling a focused form control blurs it; there is no way to keep the caret.
 * So `busy` no longer disables anything the caret can live in — it is surfaced
 * with `aria-busy` on the panel instead, which announces the state without
 * stealing focus.
 *
 * The second half of the fix is this component holding a LOCAL draft. The value
 * used to be bound straight to server state, which lags a round trip, so the
 * character you typed visibly vanished and reappeared and the caret jumped to
 * the end. The draft is authoritative while the field has focus; the server
 * value re-seeds it only when it changes from outside.
 *
 * Committing on blur (and on Enter) rather than per keystroke also fixes a
 * third problem that was invisible until you look at the API: the Redirect URL
 * field validates `http(s)://` server-side, so typing "h", "ht", "htt" raised a
 * refusal on EVERY keystroke and the field could never be filled in. Same for
 * the response limit, where an empty box posts 0 and is refused.
 */
export function DraftInput({
  value,
  onCommit,
  busy,
  ...rest
}: {
  value: string;
  onCommit: (next: string) => void;
  busy: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [draft, setDraft] = React.useState(value);
  const focused = React.useRef(false);

  /*
   * Re-seed from the server only when this field is NOT being edited. Without
   * the guard, an unrelated PATCH landing mid-word would overwrite what the
   * person is halfway through typing.
   */
  React.useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  return (
    <input
      {...rest}
      value={draft}
      aria-busy={busy || undefined}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        focused.current = false;
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          (event.target as HTMLInputElement).blur();
        }
        if (event.key === "Escape") {
          setDraft(value);
          (event.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/**
 * The multi-line twin of `DraftInput`, for the two places a form's own prose is
 * edited — the welcome page's message and the confirmation screen's.
 *
 * Same draft-and-commit-on-blur rule and the same reason for it. Enter is NOT
 * a commit here, because Enter is a newline in a paragraph; Escape still
 * abandons the edit, and blur still saves it.
 */
export function DraftArea({
  value,
  onCommit,
  busy,
  ...rest
}: {
  value: string;
  onCommit: (next: string) => void;
  busy: boolean;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">) {
  const [draft, setDraft] = React.useState(value);
  const focused = React.useRef(false);

  React.useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  return (
    <textarea
      {...rest}
      value={draft}
      aria-busy={busy || undefined}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        focused.current = false;
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setDraft(value);
          (event.target as HTMLTextAreaElement).blur();
        }
      }}
    />
  );
}

export function Switch({
  label,
  hint,
  checked,
  onChange,
  busy,
  badge,
  note,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  busy: boolean;
  badge?: string;
  /** Shown when a toggle records intent that this build cannot yet act on. */
  note?: string;
}) {
  return (
    <label className="form-panel__row">
      <div>
        <strong>
          {label}
          {badge && <em className="form-panel__badge">{badge}</em>}
        </strong>
        {hint && <span>{hint}</span>}
        {note && <span className="form-panel__note">{note}</span>}
      </div>
      <input
        type="checkbox"
        className="form-switch"
        checked={checked}
        disabled={busy}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

export function Section({
  icon,
  title,
  children,
}: {
  icon: IconName;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="form-panel__section">
      <h3>
        <Icon name={icon} size={15} /> {title}
      </h3>
      <div className="form-panel__body">{children}</div>
    </section>
  );
}
