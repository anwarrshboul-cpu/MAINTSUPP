"use client";

/**
 * The inline configuration a chosen trigger or action asks for, built from
 * the catalogue's field list and the board's own vocabulary.
 *
 * Each `CatalogField` names a KIND; this maps the kind onto a control that
 * offers only what the board has — its status-type columns, its groups, its
 * people, the registry's chips for a system column — so a rule the builder
 * lets you make is one `validateRule` accepts. The same `COLUMN_KINDS` table
 * decides both.
 */

import { COLUMN_KINDS, type CatalogEntry, type CatalogField } from "../../../lib/automations/catalog";
import type { OptionValues, Vocabulary, VocabularyColumn } from "./automations-data";

export type FieldConfig = Record<string, string>;

export function findColumn(vocabulary: Vocabulary | null, handle: string): VocabularyColumn | null {
  if (!vocabulary || !handle) return null;
  return (
    vocabulary.columns.find((column) => column.handle === handle) ??
    vocabulary.columns.find((column) => column.id === handle) ??
    vocabulary.columns.find((column) => column.system && column.key === handle) ??
    null
  );
}

export function columnsForKind(vocabulary: Vocabulary | null, kind: CatalogField["kind"]): VocabularyColumn[] {
  if (!vocabulary) return [];
  const accepted =
    kind === "status_column" || kind === "date_column" || kind === "people_column" || kind === "number_column" || kind === "column"
      ? COLUMN_KINDS[kind]
      : null;
  if (!accepted) return [];
  return vocabulary.columns.filter((column) => accepted.includes(column.type));
}

/** The values a status-type column offers: the registry for a system column, the column's own choices otherwise. */
export function valuesForColumn(
  column: VocabularyColumn | null,
  options: OptionValues,
): Array<{ value: string; label: string }> {
  if (!column) return [];
  if (column.system && options[column.key]) return options[column.key];
  const choices = [...(column.settings.choices ?? []), ...(column.settings.people ?? [])];
  // A custom choice is stored by its label — that is what the cell holds.
  return choices.map((choice) => ({ value: choice.label, label: choice.label }));
}

/** Blank the fields that hang off a field that just changed. */
export function clearDependents(fields: CatalogField[], changedKey: string, config: FieldConfig): FieldConfig {
  const next = { ...config };
  for (const field of fields) {
    if (field.dependsOn === changedKey) delete next[field.key];
  }
  return next;
}

function Control({
  field,
  entry,
  config,
  vocabulary,
  options,
  people,
  onChange,
}: {
  field: CatalogField;
  entry: CatalogEntry;
  config: FieldConfig;
  vocabulary: Vocabulary | null;
  options: OptionValues;
  people: string[];
  onChange: (key: string, value: string) => void;
}) {
  const id = `auto-field-${entry.type}-${field.key}`;
  const value = config[field.key] ?? "";
  const set = (next: string) => onChange(field.key, next);
  const anyLabel = field.anyLabel ? `(${field.anyLabel})` : "Choose…";

  switch (field.kind) {
    case "status_column":
    case "date_column":
    case "people_column":
    case "number_column":
    case "column": {
      const columns = columnsForKind(vocabulary, field.kind);
      return (
        <select id={id} className="ba-select" value={value} onChange={(event) => set(event.target.value)}>
          <option value="">{field.optional ? anyLabel : "Choose a column…"}</option>
          {columns.map((column) => (
            <option key={column.handle} value={column.handle}>
              {column.title}
            </option>
          ))}
        </select>
      );
    }
    case "status_value": {
      const parent = field.dependsOn ? config[field.dependsOn] ?? "" : "";
      const column = findColumn(vocabulary, parent || "status");
      const values = valuesForColumn(column, options);
      return (
        <select id={id} className="ba-select" value={value} onChange={(event) => set(event.target.value)}>
          <option value="">{field.optional ? anyLabel : "Choose a value…"}</option>
          {values.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    }
    case "column_value": {
      const parent = field.dependsOn ? config[field.dependsOn] ?? "" : "";
      const column = findColumn(vocabulary, parent);
      if (!column) {
        return (
          <input id={id} className="ba-input" disabled placeholder="Choose a column first" value="" readOnly />
        );
      }
      if (column.type === "status" || column.type === "dropdown") {
        const values = valuesForColumn(column, options);
        return (
          <select id={id} className="ba-select" value={value} onChange={(event) => set(event.target.value)}>
            <option value="">Choose a value…</option>
            {values.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        );
      }
      if (column.type === "date") {
        return <input id={id} type="date" className="ba-input" value={value} onChange={(event) => set(event.target.value)} />;
      }
      if (column.type === "number") {
        return <input id={id} type="number" className="ba-input" value={value} onChange={(event) => set(event.target.value)} />;
      }
      if (column.type === "checkbox") {
        return (
          <select id={id} className="ba-select" value={value} onChange={(event) => set(event.target.value)}>
            <option value="">Choose…</option>
            <option value="true">Checked</option>
            <option value="false">Unchecked</option>
          </select>
        );
      }
      if (column.type === "people") {
        return <PersonInput id={id} value={value} people={people} onChange={set} />;
      }
      return (
        <input
          id={id}
          className="ba-input"
          value={value}
          placeholder={field.placeholder ?? "Value"}
          onChange={(event) => set(event.target.value)}
        />
      );
    }
    case "group":
      return (
        <select id={id} className="ba-select" value={value} onChange={(event) => set(event.target.value)}>
          <option value="">{field.optional ? anyLabel : "Choose a group…"}</option>
          {(vocabulary?.groups ?? []).map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
      );
    case "person":
      return <PersonInput id={id} value={value} people={people} onChange={set} placeholder={field.optional ? field.anyLabel : undefined} />;
    case "choice":
      return (
        <select id={id} className="ba-select" value={value} onChange={(event) => set(event.target.value)}>
          <option value="">Choose…</option>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    case "days":
    case "number":
      return (
        <input
          id={id}
          type="number"
          className="ba-input"
          value={value}
          step={field.kind === "days" ? 1 : "any"}
          min={field.kind === "days" ? 0 : undefined}
          placeholder={field.kind === "days" ? "0" : field.placeholder ?? ""}
          onChange={(event) => set(event.target.value)}
        />
      );
    case "email":
      return (
        <input
          id={id}
          type="email"
          className="ba-input"
          value={value}
          placeholder="name@example.com"
          onChange={(event) => set(event.target.value)}
        />
      );
    case "long_text":
      return (
        <textarea
          id={id}
          className="ba-textarea"
          value={value}
          placeholder={field.placeholder ?? ""}
          onChange={(event) => set(event.target.value)}
        />
      );
    default:
      return (
        <input
          id={id}
          className="ba-input"
          value={value}
          placeholder={field.placeholder ?? ""}
          onChange={(event) => set(event.target.value)}
        />
      );
  }
}

function PersonInput({
  id,
  value,
  people,
  onChange,
  placeholder,
}: {
  id: string;
  value: string;
  people: string[];
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <>
      <input
        id={id}
        className="ba-input"
        list={`${id}-people`}
        value={value}
        placeholder={placeholder ?? "Name"}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={`${id}-people`}>
        {people.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </>
  );
}

export function FieldControls({
  entry,
  config,
  vocabulary,
  options,
  people,
  onChange,
}: {
  entry: CatalogEntry;
  config: FieldConfig;
  vocabulary: Vocabulary | null;
  options: OptionValues;
  people: string[];
  onChange: (next: FieldConfig) => void;
}) {
  if (!entry.fields.length) return null;
  return (
    <div className="auto-fields">
      {entry.fields.map((field) => (
        <label key={field.key} className="ba-field auto-field" htmlFor={`auto-field-${entry.type}-${field.key}`}>
          <span>
            {field.label}
            {field.optional ? "" : " *"}
          </span>
          <Control
            field={field}
            entry={entry}
            config={config}
            vocabulary={vocabulary}
            options={options}
            people={people}
            onChange={(key, value) => {
              const next = clearDependents(entry.fields, key, config);
              if (value) next[key] = value;
              else delete next[key];
              onChange(next);
            }}
          />
        </label>
      ))}
    </div>
  );
}
