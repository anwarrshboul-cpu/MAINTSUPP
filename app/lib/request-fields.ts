/**
 * The editable fields of a job, normalised from an untrusted `fields` object.
 *
 * Extracted from `PATCH /api/maintenance`, whose `{ id, fields }` form is what
 * the board, the drawer, the calendar and the Fix Tracker all call to change a
 * job's own columns. The automation engine changes the same columns when a
 * rule fires, and it must apply the same trimming, the same length caps and
 * the same "an empty string does not blank a required field" rule — so the
 * rule lives here once, and both callers read it.
 *
 * Deliberately excludes `parentId`: re-parenting needs three database checks
 * (see the route) and is not something a rule does.
 */

import type { maintenanceRequests } from "../../db/schema";

export type RequestFieldValues = Partial<typeof maintenanceRequests.$inferInsert>;

function trimString(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function requestTitle(description: string) {
  return description.split(/[\n.]/)[0].trim().slice(0, 120) || description.slice(0, 120);
}

/** An ISO instant, `null` to clear, or `undefined` when unreadable. */
export function optionalIsoDate(value: unknown): string | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const parsed = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00.000Z` : trimmed,
  );
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Turns a caller's `fields` into column values. Unknown keys are ignored;
 * malformed values are dropped rather than rejected, exactly as the route has
 * always behaved. `updatedAt` is the caller's to set.
 */
export function requestFieldValues(fields: Record<string, unknown>): RequestFieldValues {
  const values: RequestFieldValues = {};

  if (fields.source === "Portal form" || fields.source === "Manual") {
    values.source = fields.source;
  }
  if (typeof fields.description === "string") {
    const description = trimString(fields.description, 1200);
    if (description) {
      values.description = description;
      values.title = requestTitle(description);
    }
  }
  if (typeof fields.location === "string") {
    const location = trimString(fields.location, 160);
    if (location) values.location = location;
  }
  if (typeof fields.requester === "string") {
    const requester = trimString(fields.requester, 120);
    if (requester) values.requester = requester;
  }
  if (typeof fields.contact === "string") {
    const contact = trimString(fields.contact, 80);
    if (contact) values.contact = contact;
  }
  if (typeof fields.category === "string") {
    const category = trimString(fields.category, 80);
    if (category) values.category = category;
  }
  if (typeof fields.engineer === "string") {
    const engineer = trimString(fields.engineer, 80);
    if (engineer) values.engineer = engineer;
  }
  if (typeof fields.priority === "string") {
    const priority = trimString(fields.priority, 80);
    if (priority) values.priority = priority;
  }
  if (typeof fields.status === "string") {
    const status = trimString(fields.status, 100);
    if (status) values.status = status;
  }
  if (
    typeof fields.tier === "number" &&
    Number.isInteger(fields.tier) &&
    fields.tier >= 1 &&
    fields.tier <= 20
  ) {
    values.tier = fields.tier;
  }
  if (typeof fields.contractor === "string" || fields.contractor === null) {
    values.contractor = trimString(fields.contractor, 120) || null;
  }
  if (typeof fields.assignee === "string" || fields.assignee === null) {
    values.assignee = trimString(fields.assignee, 120) || null;
  }
  if (typeof fields.approvedBy === "string" || fields.approvedBy === null) {
    values.approvedBy = trimString(fields.approvedBy, 120) || null;
  }
  if (typeof fields.invoice === "string" || fields.invoice === null) {
    values.invoice = trimString(fields.invoice, 160) || null;
  }
  if (typeof fields.formUrl === "string" || fields.formUrl === null) {
    values.formUrl = trimString(fields.formUrl, 600) || null;
  }
  if (typeof fields.title === "string") {
    const title = trimString(fields.title, 200);
    if (title) values.title = title;
  }
  if (typeof fields.cost === "number" && Number.isFinite(fields.cost)) {
    values.cost = Math.max(0, fields.cost);
  } else if (fields.cost === null || fields.cost === "") {
    values.cost = null;
  }

  for (const key of ["requestedAt", "completedAt", "dueAt", "nextUpdateAt"] as const) {
    if (!(key in fields)) continue;
    const value = optionalIsoDate(fields[key]);
    if (value === undefined) continue;
    if (key === "requestedAt") {
      if (value) values.requestedAt = value;
    } else {
      values[key] = value;
    }
  }

  return values;
}

/**
 * What a board column key reads from or writes to on the job row.
 *
 * The board draws system columns from `maintenance_requests` fields by key —
 * `status` is the Status chip, `dueDate` is `due_at`, `label` is `category`.
 * The automation engine names columns by the same keys the board does, so a
 * rule reads "When Status changes" rather than "When status_changed", and
 * this is the one translation table between the two vocabularies.
 */
export const SYSTEM_FIELD_BY_KEY = {
  name: { field: "title", type: "text" },
  location: { field: "location", type: "text" },
  description: { field: "description", type: "long_text" },
  tier: { field: "tier", type: "dropdown" },
  engineer: { field: "engineer", type: "status" },
  priority: { field: "priority", type: "status" },
  label: { field: "category", type: "status" },
  status: { field: "status", type: "status" },
  contractor: { field: "contractor", type: "text" },
  assignee: { field: "assignee", type: "people" },
  requested: { field: "requestedAt", type: "date" },
  completed: { field: "completedAt", type: "date" },
  dueDate: { field: "dueAt", type: "date" },
  nextUpdate: { field: "nextUpdateAt", type: "date" },
  requester: { field: "requester", type: "text" },
  cost: { field: "cost", type: "number" },
  approvedBy: { field: "approvedBy", type: "text" },
  invoice: { field: "invoice", type: "text" },
} as const satisfies Record<string, { field: keyof RequestFieldValues; type: string }>;

export type SystemColumnKey = keyof typeof SYSTEM_FIELD_BY_KEY;

export function isSystemColumnKey(key: string): key is SystemColumnKey {
  return Object.prototype.hasOwnProperty.call(SYSTEM_FIELD_BY_KEY, key);
}

/** The column key a job field is drawn under, or null for a field the board does not show. */
export function columnKeyForField(field: string): SystemColumnKey | null {
  for (const [key, entry] of Object.entries(SYSTEM_FIELD_BY_KEY)) {
    if (entry.field === field) return key as SystemColumnKey;
  }
  return null;
}

/** A field's value as the board would show it in a trigger: a string or "". */
export function fieldAsText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}
