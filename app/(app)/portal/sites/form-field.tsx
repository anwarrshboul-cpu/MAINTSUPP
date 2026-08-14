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
}) {
  const describedBy = hint ? `${id}-hint` : undefined;

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
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
      )}

      {hint ? (
        <p id={describedBy} className="form-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
