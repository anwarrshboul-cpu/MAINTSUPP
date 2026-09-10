"use client";

import type { OptionChoice } from "./site-types";

export type FieldOption = { value: string; label: string };

/**
 * One labelled control, used by both the site and asset editors.
 *
 * Every input carries a real `<label>`, help text is wired through
 * `aria-describedby`, and selects render the configured options rather than a
 * hardcoded list — an inactive value stays visible only while it is the one
 * currently saved, so an existing record never silently loses its value.
 */
export function FormField({
  id,
  label,
  value,
  onChange,
  type = "text",
  hint,
  required,
  multiline,
  options,
  placeholder,
  min,
  max,
  step,
  problem,
  onBlur,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  hint?: string;
  required?: boolean;
  multiline?: boolean;
  options?: Array<OptionChoice | FieldOption>;
  placeholder?: string;
  /*
   * W05-01 — the bounds of a numeric field, on the control itself.
   *
   * Added for the coordinates, which are the first fields here that have a real
   * range: latitude is -90..90 and longitude -180..180, and the route refuses
   * anything outside them. Putting the same figures on the input means the
   * browser says so before the round trip, a phone offers a numeric keypad, and
   * a screen reader announces the range with the field — rather than the user
   * learning it from a 400. `step` exists for the same reason: the default is
   * 1, which makes a decimal degree an invalid value.
   */
  min?: number;
  max?: number;
  step?: string;
  /**
   * 2H/2K — something wrong with what is currently typed, or null.
   *
   * ADVISORY, NOT BLOCKING, and the distinction is the whole reason this is a
   * separate prop from `required`. The first field to use it is the postcode:
   * an unrecognisable postcode is still SAVED, because this product has sites
   * outside the UK and refusing the save would make the form harder to finish
   * than the spreadsheet it replaces. What it must not do is stay silent — a
   * typo in a postcode is invisible until somebody tries to use it.
   *
   * Wired to `aria-invalid` and into `aria-describedby` ALONGSIDE the hint
   * rather than instead of it, so a screen reader gets the rule and the problem
   * in one pass. `role="status"` rather than `alert`: this is a hint about the
   * field being edited, not an interruption.
   */
  problem?: string | null;
  /**
   * Called when the control loses focus.
   *
   * Added for the postcode, which canonicalises on blur rather than on change:
   * rewriting a value on every keystroke fights the person typing it. Only the
   * text input carries it — a select has no half-typed state to tidy, and a
   * textarea's content is prose.
   */
  onBlur?: () => void;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const problemId = problem ? `${id}-problem` : undefined;
  /* Both, in reading order. `undefined` when neither exists, because an empty
     `aria-describedby` points at nothing and some readers announce that. */
  const describedBy = [hintId, problemId].filter(Boolean).join(" ") || undefined;

  const choices = (options ?? [])
    .map((option) => ({
      value: option.value,
      label: option.label,
      active: "active" in option ? option.active : true,
    }))
    .filter((option) => option.active || option.value === value);

  return (
    <div className="form-field">
      <label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>

      {options ? (
        <select
          id={id}
          value={value}
          required={required}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Choose one</option>
          {choices.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : multiline ? (
        <textarea
          id={id}
          rows={3}
          value={value}
          required={required}
          placeholder={placeholder}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={id}
          type={type}
          value={value}
          required={required}
          placeholder={placeholder}
          min={min}
          max={max}
          step={step}
          aria-describedby={describedBy}
          aria-invalid={problem ? true : undefined}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
        />
      )}

      {hint ? (
        <p id={hintId} className="form-hint">
          {hint}
        </p>
      ) : null}

      {problem ? (
        <p id={problemId} className="form-hint form-hint--problem" role="status">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
