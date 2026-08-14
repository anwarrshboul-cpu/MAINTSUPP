/**
 * Column type registry — Stage 3, items N2 and N3.
 *
 * Every board column declares a `type`. This registry is the only place that
 * describes what a type means: how its value is stored, how it is validated,
 * which summary functions apply, and whether it draws its choices from a
 * configurable option set.
 *
 * Adding a column type is a change here and nowhere else. Adding a *column*
 * needs no code at all — it is a row in `maintenance_board_columns`.
 */

export type ColumnTypeKey =
  // Core set — N2. Required for monday parity on the existing board.
  | "text"
  | "long_text"
  | "number"
  | "currency"
  | "single_select"
  | "multi_select"
  | "person"
  | "date"
  | "date_range"
  | "file"
  | "link"
  | "email"
  | "phone"
  | "checkbox"
  | "relation"
  // Extended set — N3.
  | "formula"
  | "mirror"
  | "rating"
  | "progress"
  | "item_id"
  | "created_at"
  | "updated_at"
  | "created_by"
  | "auto_number"
  | "tags"
  | "time_tracking"
  | "dependency"
  | "location"
  | "vote";

export type SummaryFunction =
  | "sum"
  | "average"
  | "min"
  | "max"
  | "count"
  | "median"
  | "battery";

export type ColumnTypeDefinition = {
  key: ColumnTypeKey;
  label: string;
  group: "basic" | "choice" | "people" | "time" | "media" | "computed";
  /** How the cell value is held in `maintenance_board_cells.value`. */
  storage: "string" | "number" | "json" | "boolean";
  /** Computed types are derived at read time and never written by a user. */
  readOnly: boolean;
  /** Choices come from a configurable option set rather than the column. */
  usesOptionSet: boolean;
  summaries: SummaryFunction[];
  /** Types this one may be converted to without discarding the stored value. */
  convertsTo: ColumnTypeKey[];
  describe: string;
};

function define(
  key: ColumnTypeKey,
  label: string,
  group: ColumnTypeDefinition["group"],
  storage: ColumnTypeDefinition["storage"],
  describe: string,
  extra: Partial<ColumnTypeDefinition> = {},
): ColumnTypeDefinition {
  return {
    key,
    label,
    group,
    storage,
    describe,
    readOnly: false,
    usesOptionSet: false,
    summaries: [],
    convertsTo: [],
    ...extra,
  };
}

const DEFINITIONS: ColumnTypeDefinition[] = [
  define("text", "Text", "basic", "string", "A single line of free text.", {
    convertsTo: ["long_text", "link", "email", "phone", "single_select"],
    summaries: ["count"],
  }),
  define("long_text", "Long text", "basic", "string", "Multiple lines, for descriptions.", {
    convertsTo: ["text"],
    summaries: ["count"],
  }),
  define("number", "Number", "basic", "number", "A plain number.", {
    convertsTo: ["currency", "rating", "progress", "text"],
    summaries: ["sum", "average", "min", "max", "count", "median"],
  }),
  define("currency", "Currency", "basic", "number", "Money, stored in pence as an integer.", {
    convertsTo: ["number", "text"],
    summaries: ["sum", "average", "min", "max", "count", "median"],
  }),
  define("single_select", "Status", "choice", "string", "One value from a configurable list.", {
    usesOptionSet: true,
    convertsTo: ["multi_select", "text"],
    summaries: ["count", "battery"],
  }),
  define("multi_select", "Labels", "choice", "json", "Several values from a configurable list.", {
    usesOptionSet: true,
    convertsTo: ["single_select", "tags"],
    summaries: ["count"],
  }),
  define("person", "People", "people", "json", "One or more workspace members.", {
    convertsTo: ["text"],
    summaries: ["count"],
  }),
  define("date", "Date", "time", "string", "A single date, held as ISO yyyy-mm-dd.", {
    convertsTo: ["date_range", "text"],
    summaries: ["min", "max", "count"],
  }),
  define("date_range", "Timeline", "time", "json", "A start and end date.", {
    convertsTo: ["date"],
    summaries: ["count"],
  }),
  define("file", "Files", "media", "json", "Attachments held in R2.", {
    summaries: ["count"],
  }),
  define("link", "Link", "basic", "string", "A URL with optional display text.", {
    convertsTo: ["text"],
    summaries: ["count"],
  }),
  define("email", "Email", "basic", "string", "An email address.", {
    convertsTo: ["text", "link"],
    summaries: ["count"],
  }),
  define(
    "phone",
    "Phone",
    "basic",
    "string",
    "A telephone number. Always stored as text so a leading zero survives.",
    { convertsTo: ["text"], summaries: ["count"] },
  ),
  define("checkbox", "Checkbox", "basic", "boolean", "A yes or no.", {
    convertsTo: ["text"],
    summaries: ["count", "battery"],
  }),
  define("relation", "Connected item", "choice", "json", "A link to a site, unit or contractor.", {
    summaries: ["count"],
  }),

  // Extended — N3
  define("formula", "Formula", "computed", "string", "Derived from other columns.", {
    readOnly: true,
    summaries: ["sum", "average", "min", "max", "count"],
  }),
  define("mirror", "Mirror", "computed", "string", "Shows a value from a connected item.", {
    readOnly: true,
    summaries: ["count"],
  }),
  define("rating", "Rating", "basic", "number", "A score out of a configurable maximum.", {
    convertsTo: ["number"],
    summaries: ["average", "min", "max", "count"],
  }),
  define("progress", "Progress", "basic", "number", "A percentage, shown as a bar.", {
    convertsTo: ["number"],
    summaries: ["average", "battery", "count"],
  }),
  define("item_id", "Item ID", "computed", "string", "The item's reference.", { readOnly: true }),
  define("created_at", "Created", "computed", "string", "When the item was created.", {
    readOnly: true,
    summaries: ["min", "max"],
  }),
  define("updated_at", "Last updated", "computed", "string", "When the item last changed.", {
    readOnly: true,
    summaries: ["min", "max"],
  }),
  define("created_by", "Created by", "computed", "string", "Who raised the item.", {
    readOnly: true,
    summaries: ["count"],
  }),
  define("auto_number", "Auto number", "computed", "number", "A sequential number.", {
    readOnly: true,
    summaries: ["max", "count"],
  }),
  define("tags", "Tags", "choice", "json", "Free-form tags shared across the board.", {
    convertsTo: ["multi_select"],
    summaries: ["count"],
  }),
  define("time_tracking", "Time tracking", "time", "json", "Accumulated time against the item.", {
    summaries: ["sum", "average", "count"],
  }),
  define("dependency", "Dependency", "choice", "json", "Items that must finish first.", {
    summaries: ["count"],
  }),
  define("location", "Location", "basic", "json", "An address with optional coordinates.", {
    convertsTo: ["text"],
    summaries: ["count"],
  }),
  define("vote", "Vote", "people", "json", "Members who have voted for the item.", {
    summaries: ["count"],
  }),
];

const BY_KEY = new Map(DEFINITIONS.map((definition) => [definition.key, definition]));

export function listColumnTypes(): ColumnTypeDefinition[] {
  return DEFINITIONS;
}

export function getColumnType(key: string): ColumnTypeDefinition | null {
  return BY_KEY.get(key as ColumnTypeKey) ?? null;
}

export function isColumnType(key: string): key is ColumnTypeKey {
  return BY_KEY.has(key as ColumnTypeKey);
}

/**
 * Whether a column may be converted from one type to another with its stored
 * values intact. Used by N6 to warn before data is lost.
 */
export function canConvert(from: string, to: string) {
  const source = getColumnType(from);
  if (!source) return false;
  if (from === to) return true;
  return source.convertsTo.includes(to as ColumnTypeKey);
}

export function summariesFor(key: string): SummaryFunction[] {
  return getColumnType(key)?.summaries ?? [];
}

/**
 * Normalises a submitted cell value for storage. Returns null when the value is
 * not acceptable for the type, so the caller can reject rather than write
 * something it cannot read back.
 */
export function normaliseCellValue(type: string, raw: unknown): string | null {
  const definition = getColumnType(type);
  if (!definition) return null;
  if (definition.readOnly) return null;
  if (raw === null || raw === undefined || raw === "") return "";

  switch (definition.storage) {
    case "number": {
      const numeric = typeof raw === "number" ? raw : Number(String(raw).replace(/[^0-9.-]/g, ""));
      if (!Number.isFinite(numeric)) return null;
      // Currency is held in pence so arithmetic never drifts on floats.
      return String(definition.key === "currency" ? Math.round(numeric) : numeric);
    }
    case "boolean":
      return raw === true || raw === "true" || raw === 1 || raw === "1" ? "true" : "false";
    case "json":
      try {
        return typeof raw === "string" ? JSON.stringify(JSON.parse(raw)) : JSON.stringify(raw);
      } catch {
        return null;
      }
    default: {
      const value = String(raw).trim();
      if (definition.key === "date" && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
      if (definition.key === "email" && value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
        return null;
      }
      return value.slice(0, 4000);
    }
  }
}
