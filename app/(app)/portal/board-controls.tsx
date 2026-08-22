"use client";

/**
 * The board's Sort and Filter panels.
 *
 * Two popovers hanging off the toolbar, and the only place either of these
 * features has a *composite* surface: the header's quick-sort and each column's
 * three-dot menu drive the same state through the same callbacks, so a rule set
 * here and a rule set there cannot disagree. There is one sort and one filter
 * per board, held in live-board.tsx, and these panels are views over it.
 *
 * WHY A SEPARATE FILE. live-board.tsx is held under 6,000 lines by
 * `stage-eight-board-split.test.mjs`, and these are the two largest new pieces
 * of chrome; more usefully, neither reaches into the board's closure. Every
 * input arrives as a prop and every change leaves as a callback, which is what
 * makes them readable on their own.
 *
 * THE INTERACTION MODEL, which is monday's:
 *
 *   · a header click SORTS BY THAT COLUMN ALONE — the fast path, unchanged;
 *   · "Add as a tie-breaker" in a column's menu, or "Add a sort" here, APPENDS
 *     a rule, so ordering by Priority and then by Due Date is expressible;
 *   · priority is shown as 1, 2, 3 beside each rule and on the sorted headers,
 *     because a sort nobody can see the shape of is a sort that gets fought
 *     with rather than used;
 *   · a filter belongs to a column, and the board's rules combine with All or
 *     Any. The global search box is untouched and ANDs with whatever is set —
 *     "where is that job" and "show me this kind of work" are different
 *     questions and the board can be asked both at once.
 */

import { Icon } from "../../components";
import type { BoardDisplayColumn } from "./board-model";
import type { BoardSortRule, SortDirection } from "./board-sort";
import { sortRuleIndex } from "./board-sort";
import {
  operatorArity,
  operatorsFor,
  type BoardFilterRule,
  type BoardFilterState,
} from "./board-filter";
import type { FilterOperator } from "./views/view-model";

export type FilterChoice = { value: string; label: string };

/* ── Sort ────────────────────────────────────────────────────────────────── */

export function BoardSortPanel({
  columns,
  rules,
  onReplace,
  onAdd,
  onFlip,
  onMove,
  onRemove,
  onClear,
  onClose,
}: {
  /** Every column that can be sorted, in board order. */
  columns: BoardDisplayColumn[];
  rules: BoardSortRule[];
  onReplace: (columnId: string, direction: SortDirection) => void;
  onAdd: (columnId: string, direction: SortDirection) => void;
  onFlip: (columnId: string) => void;
  onMove: (columnId: string, delta: -1 | 1) => void;
  onRemove: (columnId: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const byId = new Map(columns.map((entry) => [entry.column.id, entry]));
  const unsorted = columns.filter((entry) => sortRuleIndex(rules, entry.column.id) < 0);

  return (
    <div className="board-rules board-rules--sort" role="dialog" aria-label="Sort the board">
      <header className="board-rules__head">
        <strong>Sort by</strong>
        {rules.length > 1 && (
          <span className="board-rules__hint">
            {rules.length} rules — the first decides, the rest break ties
          </span>
        )}
        <button type="button" aria-label="Close sort" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </header>

      {rules.length === 0 ? (
        <p className="board-rules__empty">
          The board is in its own saved order. Choose a column to sort by.
        </p>
      ) : (
        <ol className="board-rules__list">
          {rules.map((rule, index) => {
            const entry = byId.get(rule.columnId);
            const title = entry?.column.title ?? "Removed column";
            return (
              <li key={rule.columnId} className="board-rules__row">
                <span className="board-rules__rank" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="board-rules__label" title={title}>
                  {index === 0 ? "Sort by" : "then by"} <strong>{title}</strong>
                </span>
                <button
                  type="button"
                  className="board-rules__direction"
                  aria-label={`${title} is sorted ${
                    rule.direction === "asc" ? "ascending" : "descending"
                  } — reverse it`}
                  onClick={() => onFlip(rule.columnId)}
                >
                  <Icon name={rule.direction === "asc" ? "sortAsc" : "sortDesc"} size={13} />
                  {rule.direction === "asc" ? "A → Z" : "Z → A"}
                </button>
                <button
                  type="button"
                  aria-label={`Give ${title} a higher sort priority`}
                  disabled={index === 0}
                  onClick={() => onMove(rule.columnId, -1)}
                >
                  <Icon name="chevron" size={13} />
                </button>
                <button
                  type="button"
                  aria-label={`Give ${title} a lower sort priority`}
                  disabled={index === rules.length - 1}
                  onClick={() => onMove(rule.columnId, 1)}
                >
                  <Icon name="chevron" size={13} />
                </button>
                <button
                  type="button"
                  className="board-rules__remove"
                  aria-label={`Stop sorting by ${title}`}
                  onClick={() => onRemove(rule.columnId)}
                >
                  <Icon name="close" size={13} />
                </button>
              </li>
            );
          })}
        </ol>
      )}

      <div className="board-rules__foot">
        <label>
          <span className="board-rules__foot-label">
            {rules.length ? "Then by" : "Sort by"}
          </span>
          <select
            aria-label={rules.length ? "Add a tie-breaker column" : "Sort by a column"}
            value=""
            onChange={(event) => {
              if (!event.target.value) return;
              // The first choice REPLACES so the panel and a header click agree
              // about what "sort by this" means; every later one APPENDS.
              if (rules.length) onAdd(event.target.value, "asc");
              else onReplace(event.target.value, "asc");
            }}
          >
            <option value="">Choose a column…</option>
            {unsorted.map((entry) => (
              <option key={entry.column.id} value={entry.column.id}>
                {entry.column.title}
              </option>
            ))}
          </select>
        </label>
        {rules.length > 0 && (
          <button type="button" className="board-rules__clear" onClick={onClear}>
            Clear sort
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Filter ──────────────────────────────────────────────────────────────── */

/**
 * One rule's value editor.
 *
 * Which control appears is decided by the OPERATOR's arity and the COLUMN's
 * kind, in that order — `is_empty` takes nothing whatever the column is, and a
 * date column asked "is within the next" wants a number of days rather than a
 * date. Getting that the other way round is how a filter builder ends up
 * offering a date picker for a day count.
 */
function FilterValues({
  rule,
  choices,
  kind,
  onChange,
}: {
  rule: BoardFilterRule;
  choices: FilterChoice[];
  kind: "option" | "text" | "number" | "date";
  onChange: (values: string[]) => void;
}) {
  const arity = operatorArity(rule.operator);
  if (arity === 0) return null;

  if (kind === "option" || (choices.length > 0 && rule.operator.endsWith("any_of"))) {
    const chosen = rule.values.filter(Boolean);
    const remaining = choices.filter((choice) => !chosen.includes(choice.value));
    return (
      <div className="board-rules__values">
        {chosen.map((value) => (
          <span key={value} className="board-rules__chip">
            {choices.find((choice) => choice.value === value)?.label ?? value}
            <button
              type="button"
              aria-label={`Remove ${value} from this filter`}
              onClick={() => onChange(chosen.filter((entry) => entry !== value))}
            >
              <Icon name="close" size={11} />
            </button>
          </span>
        ))}
        <select
          aria-label="Add a value to this filter"
          value=""
          onChange={(event) => {
            if (!event.target.value) return;
            onChange([...chosen, event.target.value]);
          }}
        >
          <option value="">{chosen.length ? "Add another…" : "Choose a value…"}</option>
          {remaining.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  const inputType =
    kind === "number" || rule.operator.startsWith("within_the") ? "number" : "text";
  const placeholder =
    rule.operator === "within_the_last" || rule.operator === "within_the_next"
      ? "days"
      : kind === "date"
        ? "YYYY-MM-DD"
        : "value";

  return (
    <div className="board-rules__values">
      <input
        type={inputType}
        aria-label="Filter value"
        placeholder={placeholder}
        value={rule.values[0] ?? ""}
        onChange={(event) =>
          onChange(arity === 2 ? [event.target.value, rule.values[1] ?? ""] : [event.target.value])
        }
      />
      {arity === 2 && (
        <>
          <span className="board-rules__and">and</span>
          <input
            type={inputType}
            aria-label="Second filter value"
            placeholder={placeholder}
            value={rule.values[1] ?? ""}
            onChange={(event) => onChange([rule.values[0] ?? "", event.target.value])}
          />
        </>
      )}
    </div>
  );
}

export function BoardFilterPanel({
  columns,
  state,
  choicesFor,
  kindFor,
  matched,
  total,
  onJoinChange,
  onRuleChange,
  onRemove,
  onClear,
  onClose,
}: {
  /** Every column a rule may be written against, in board order. */
  columns: BoardDisplayColumn[];
  state: BoardFilterState;
  choicesFor: (entry: BoardDisplayColumn) => FilterChoice[];
  kindFor: (entry: BoardDisplayColumn) => "option" | "text" | "number" | "date";
  matched: number;
  total: number;
  onJoinChange: (join: "and" | "or") => void;
  onRuleChange: (rule: BoardFilterRule) => void;
  onRemove: (columnId: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const byId = new Map(columns.map((entry) => [entry.column.id, entry]));
  const unfiltered = columns.filter(
    (entry) => !state.rules.some((rule) => rule.columnId === entry.column.id),
  );

  return (
    <div className="board-rules board-rules--filter" role="dialog" aria-label="Filter the board">
      <header className="board-rules__head">
        <strong>Filter</strong>
        {state.rules.length > 1 && (
          <span className="board-rules__join" role="group" aria-label="How the rules combine">
            <button
              type="button"
              className={state.join === "and" ? "is-active" : ""}
              aria-pressed={state.join === "and"}
              onClick={() => onJoinChange("and")}
            >
              Match all
            </button>
            <button
              type="button"
              className={state.join === "or" ? "is-active" : ""}
              aria-pressed={state.join === "or"}
              onClick={() => onJoinChange("or")}
            >
              Match any
            </button>
          </span>
        )}
        <button type="button" aria-label="Close filter" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </header>

      {state.rules.length === 0 ? (
        <p className="board-rules__empty">
          No filters. Every row on the board is showing.
        </p>
      ) : (
        <ul className="board-rules__list">
          {state.rules.map((rule) => {
            const entry = byId.get(rule.columnId);
            if (!entry) return null;
            const operators = operatorsFor(entry);
            return (
              <li key={rule.columnId} className="board-rules__row board-rules__row--filter">
                <span className="board-rules__label" title={entry.column.title}>
                  <strong>{entry.column.title}</strong>
                </span>
                <select
                  aria-label={`How to compare ${entry.column.title}`}
                  value={rule.operator}
                  onChange={(event) =>
                    onRuleChange({
                      ...rule,
                      operator: event.target.value as FilterOperator,
                      // Operands rarely survive a change of operator — a day
                      // count is not a date — so they are cleared rather than
                      // reinterpreted into something the reader did not choose.
                      values: [],
                    })
                  }
                >
                  {operators.map((operator) => (
                    <option key={operator.key} value={operator.key}>
                      {operator.label}
                    </option>
                  ))}
                </select>
                <FilterValues
                  rule={rule}
                  kind={kindFor(entry)}
                  choices={choicesFor(entry)}
                  onChange={(values) => onRuleChange({ ...rule, values })}
                />
                <button
                  type="button"
                  className="board-rules__remove"
                  aria-label={`Remove the filter on ${entry.column.title}`}
                  onClick={() => onRemove(rule.columnId)}
                >
                  <Icon name="close" size={13} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="board-rules__foot">
        <label>
          <span className="board-rules__foot-label">Add filter</span>
          <select
            aria-label="Filter by a column"
            value=""
            onChange={(event) => {
              const entry = byId.get(event.target.value);
              if (!entry) return;
              const first = operatorsFor(entry)[0];
              onRuleChange({
                columnId: entry.column.id,
                operator: first.key,
                values: [],
              });
            }}
          >
            <option value="">Choose a column…</option>
            {unfiltered.map((entry) => (
              <option key={entry.column.id} value={entry.column.id}>
                {entry.column.title}
              </option>
            ))}
          </select>
        </label>
        {state.rules.length > 0 && (
          <button type="button" className="board-rules__clear" onClick={onClear}>
            Clear filters
          </button>
        )}
      </div>

      {state.rules.length > 0 && (
        <p className="board-rules__count" aria-live="polite">
          {matched === 0
            ? "No rows match these filters."
            : `Showing ${matched} of ${total} rows.`}
        </p>
      )}
    </div>
  );
}
