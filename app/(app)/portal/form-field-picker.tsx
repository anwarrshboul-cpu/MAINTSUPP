"use client";

import * as React from "react";
import {
  CANONICAL_QUESTION_BY_COLUMN_KEY,
  columnForQuestion,
  questionIdForColumn,
  type BuilderColumn,
} from "./form-bindings";

/**
 * THE ONE FIELD PICKER.
 *
 * Choosing which of the board's columns a question fills happens in three
 * places and used to happen in none: the insertion control between two
 * questions, the "Add a question" button at the end of a page, and the binding
 * row on a question's own card. Three copies of a `<select>` over the same list
 * is three places to forget that a system column cannot take a derived
 * question, three places to forget that a column already on the form must not
 * be offered twice, and three chances for one of them to key its options by
 * label. This is that control, once.
 *
 * ── WHAT MAKES IT A BINDING AND NOT A LABEL ────────────────────────────────
 *
 * Every option's `value` is the COLUMN'S ID. Not its title, not its index in
 * the list — see the header of `form-bindings.ts` for why both of those file
 * answers into the wrong column the first time somebody edits the board. The
 * caller is handed the whole column back, and `questionIdForColumn` decides
 * what the question's id becomes: monday's canonical id where the submit route
 * reads the answer by name, the column's own row id otherwise, because that is
 * the cell the answer lands in.
 *
 * ── WHY EVERY COLUMN IS LISTED, INCLUDING THE ONES ALREADY ASKED ───────────
 *
 * The Content panel's job is to say what this board CAN ask, and a list that
 * silently omits the columns already on the form cannot answer "why isn't Cost
 * of Works on here?" — the honest answer is "it is, further down". So they are
 * all here, in the board's own column order, in two groups: the ones that are
 * not on the form yet, and the ones that are. The second group is disabled for
 * selection rather than hidden, so the reason is visible.
 *
 * A SYSTEM column is a special case with a real cause: its value is a field on
 * `maintenance_requests` written by the routes that own that record, so there
 * is no cell for a derived answer to land in and `deriveFormQuestions` refuses
 * one. It is offerable only where a canonical question already claims it — the
 * submit route writes those seven fields by hand — and otherwise appears
 * disabled with the reason attached, rather than being quietly missing.
 */

/** How a column type reads in a menu. Kept short: this sits after a title. */
const TYPE_LABELS: Readonly<Record<string, string>> = {
  text: "text",
  long_text: "long text",
  longtext: "long text",
  status: "status",
  dropdown: "dropdown",
  single_select: "dropdown",
  date: "date",
  timeline: "timeline",
  files: "files",
  file: "files",
  people: "person",
  person: "person",
  number: "number",
  numbers: "number",
  phone: "phone",
  rating: "rating",
  subitems: "sub-items",
  link: "link",
  email: "email",
  checkbox: "checkbox",
};

export type FieldPickerProps = {
  /** Every live column of the target board, in the board's own order. */
  columns: readonly BuilderColumn[];
  /** The question ids already on the form, so a column is not offered twice. */
  usedQuestionIds: ReadonlySet<string>;
  /**
   * The question this picker is re-binding, if any. Its own column stays
   * selectable — otherwise the control would open showing a value it refuses
   * to accept back.
   */
  currentQuestionId?: string | null;
  onPick: (column: BuilderColumn) => void;
  busy: boolean;
  /** The accessible name. Required: an unlabelled select is an unusable one. */
  label: string;
  /** Shown as the empty first option. */
  placeholder?: string;
  className?: string;
  /** Rendered beside the select — the Add button, on the insertion control. */
  children?: React.ReactNode;
};

export function FormFieldPicker({
  columns,
  usedQuestionIds,
  currentQuestionId = null,
  onPick,
  busy,
  label,
  placeholder = "Choose a column…",
  className,
  children,
}: FieldPickerProps) {
  const selectId = React.useId();
  const current = currentQuestionId
    ? columnForQuestion(currentQuestionId, columns)
    : null;

  const available: BuilderColumn[] = [];
  const taken: BuilderColumn[] = [];
  for (const column of columns) {
    const questionId = questionIdForColumn(column);
    if (questionId === currentQuestionId || !usedQuestionIds.has(questionId)) {
      available.push(column);
    } else {
      taken.push(column);
    }
  }

  /* A system column with no canonical question has nowhere to put an answer.
     Offered, disabled, with the reason — see the header. */
  const offerable = (column: BuilderColumn) =>
    !column.system || Boolean(CANONICAL_QUESTION_BY_COLUMN_KEY[column.key]);

  const describe = (column: BuilderColumn) => {
    const type = TYPE_LABELS[column.type] ?? column.type;
    if (!offerable(column)) return `${column.title} — ${type}, filled by the system`;
    return `${column.title} — ${type}`;
  };

  return (
    <div className={className ? `form-picker ${className}` : "form-picker"}>
      <label className="form-picker__label" htmlFor={selectId}>
        {label}
      </label>
      <select
        id={selectId}
        className="form-picker__select"
        value={current?.id ?? ""}
        disabled={busy || !columns.length}
        onChange={(event) => {
          const column = columns.find((entry) => entry.id === event.target.value);
          if (column) onPick(column);
        }}
      >
        <option value="">{columns.length ? placeholder : "Loading the board's columns…"}</option>
        {available.length > 0 && (
          <optgroup label="Not on the form yet">
            {available.map((column) => (
              <option key={column.id} value={column.id} disabled={!offerable(column)}>
                {describe(column)}
              </option>
            ))}
          </optgroup>
        )}
        {taken.length > 0 && (
          <optgroup label="Already on the form">
            {taken.map((column) => (
              <option key={column.id} value={column.id} disabled>
                {describe(column)}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {children}
    </div>
  );
}

/** The question ids a configuration already uses. The picker's second input. */
export function usedQuestionIds(questions: ReadonlyArray<{ id: string }>) {
  return new Set(questions.map((question) => question.id));
}
