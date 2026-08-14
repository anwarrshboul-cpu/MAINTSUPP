"use client";

import { useMemo, useState } from "react";
import { Icon } from "../../../components";
import {
  type BoardItem,
  type FilterOperator,
  type FilterRule,
  type FilterSet,
  FILTER_OPERATORS,
  formatMoney,
  groupBy,
} from "./view-model";

/* ── Chart — P6 ──────────────────────────────────────────────────────────── */

type Measure = "count" | "cost";

const GROUPABLE = [
  { field: "status", label: "Status" },
  { field: "priority", label: "Priority" },
  { field: "category", label: "Label" },
  { field: "engineer", label: "Engineer" },
  { field: "contractor", label: "Contractor" },
  { field: "siteId", label: "Site" },
];

/**
 * Bar chart rendered as sized divs rather than a charting library — it keeps
 * the board bundle small and stays readable at 320px, where a canvas chart
 * usually does not.
 */
export function ChartView({ items, palette }: { items: BoardItem[]; palette: Record<string, string> }) {
  const [field, setField] = useState("status");
  const [measure, setMeasure] = useState<Measure>("count");

  const rows = useMemo(() => {
    const buckets = groupBy(items, field);
    const computed = [...buckets.entries()].map(([label, bucket]) => ({
      label,
      value:
        measure === "count"
          ? bucket.length
          : bucket.reduce((total, item) => total + (item.cost ?? 0), 0),
    }));
    return computed.sort((a, b) => b.value - a.value).slice(0, 20);
  }, [items, field, measure]);

  const peak = rows.reduce((max, row) => Math.max(max, row.value), 0) || 1;

  return (
    <div className="chart-view">
      <div className="chart-view__controls">
        <label>
          Group by
          <select value={field} onChange={(event) => setField(event.target.value)}>
            {GROUPABLE.map((option) => (
              <option key={option.field} value={option.field}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Measure
          <select
            value={measure}
            onChange={(event) => setMeasure(event.target.value as Measure)}
          >
            <option value="count">Number of items</option>
            <option value="cost">Total cost</option>
          </select>
        </label>
      </div>

      {rows.length === 0 ? (
        <p className="view-empty">Nothing to chart with the current filters.</p>
      ) : (
        <ul className="chart-view__bars">
          {rows.map((row) => (
            <li key={row.label}>
              <span className="chart-view__label" title={row.label}>
                {row.label}
              </span>
              <span className="chart-view__track">
                <span
                  className="chart-view__bar"
                  style={{
                    width: `${Math.max(2, (row.value / peak) * 100)}%`,
                    background: palette[row.label] ?? "var(--teal)",
                  }}
                />
              </span>
              <strong className="chart-view__value">
                {measure === "cost" ? formatMoney(row.value) : row.value}
              </strong>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── Filter builder — P9 ─────────────────────────────────────────────────── */

const FILTERABLE = [
  { field: "status", label: "Status", kind: "text" },
  { field: "priority", label: "Priority", kind: "text" },
  { field: "category", label: "Label", kind: "text" },
  { field: "engineer", label: "Engineer", kind: "text" },
  { field: "contractor", label: "Contractor", kind: "text" },
  { field: "assignee", label: "Assigned to", kind: "text" },
  { field: "title", label: "Job", kind: "text" },
  { field: "cost", label: "Cost", kind: "number" },
  { field: "requestedAt", label: "Date requested", kind: "date" },
  { field: "dueAt", label: "Due", kind: "date" },
  { field: "completedAt", label: "Date completed", kind: "date" },
  { field: "nextUpdateAt", label: "Next update", kind: "date" },
];

function operatorsFor(kind: string) {
  return FILTER_OPERATORS.filter(
    (operator) => operator.appliesTo === "any" || operator.appliesTo === kind,
  );
}

export function FilterBuilder({
  value,
  onChange,
  onClose,
}: {
  value: FilterSet;
  onChange: (next: FilterSet) => void;
  onClose?: () => void;
}) {
  function update(index: number, patch: Partial<FilterRule>) {
    const rules = value.rules.map((rule, position) =>
      position === index ? { ...rule, ...patch } : rule,
    );
    onChange({ ...value, rules });
  }

  function addRule() {
    onChange({
      ...value,
      rules: [...value.rules, { field: "status", operator: "any_of", values: [""] }],
    });
  }

  function removeRule(index: number) {
    onChange({ ...value, rules: value.rules.filter((_, position) => position !== index) });
  }

  return (
    <div className="filter-builder" role="group" aria-label="Filter builder">
      <header className="filter-builder__head">
        <strong>Filters</strong>
        <label className="filter-builder__conjunction">
          Match
          <select
            value={value.conjunction}
            onChange={(event) =>
              onChange({ ...value, conjunction: event.target.value as "and" | "or" })
            }
          >
            <option value="and">all conditions</option>
            <option value="or">any condition</option>
          </select>
        </label>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close filters">
            <Icon name="close" size={16} />
          </button>
        )}
      </header>

      {value.rules.length === 0 && (
        <p className="filter-builder__empty">No filters. Everything is shown.</p>
      )}

      <ul className="filter-builder__rules">
        {value.rules.map((rule, index) => {
          const field = FILTERABLE.find((entry) => entry.field === rule.field);
          const operators = operatorsFor(field?.kind ?? "text");
          const arity =
            FILTER_OPERATORS.find((entry) => entry.key === rule.operator)?.arity ?? 1;

          return (
            <li key={index}>
              <select
                aria-label="Field"
                value={rule.field}
                onChange={(event) => update(index, { field: event.target.value })}
              >
                {FILTERABLE.map((entry) => (
                  <option key={entry.field} value={entry.field}>
                    {entry.label}
                  </option>
                ))}
              </select>

              <select
                aria-label="Condition"
                value={rule.operator}
                onChange={(event) =>
                  update(index, { operator: event.target.value as FilterOperator })
                }
              >
                {operators.map((operator) => (
                  <option key={operator.key} value={operator.key}>
                    {operator.label}
                  </option>
                ))}
              </select>

              {arity >= 1 && (
                <input
                  aria-label="Value"
                  value={rule.values[0] ?? ""}
                  onChange={(event) =>
                    update(index, { values: [event.target.value, rule.values[1] ?? ""] })
                  }
                />
              )}
              {arity === 2 && (
                <input
                  aria-label="Second value"
                  value={rule.values[1] ?? ""}
                  onChange={(event) =>
                    update(index, { values: [rule.values[0] ?? "", event.target.value] })
                  }
                />
              )}

              <button
                type="button"
                onClick={() => removeRule(index)}
                aria-label="Remove this condition"
              >
                <Icon name="close" size={15} />
              </button>
            </li>
          );
        })}
      </ul>

      <div className="filter-builder__actions">
        <button type="button" onClick={addRule}>
          <Icon name="plus" size={15} /> Add condition
        </button>
        {value.rules.length > 0 && (
          <button
            type="button"
            onClick={() => onChange({ ...value, rules: [] })}
            className="filter-builder__clear"
          >
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}
