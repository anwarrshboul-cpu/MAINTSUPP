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
 * A plain calendar DAY, `null` to clear, or `undefined` when unreadable.
 *
 * Deliberately NOT `optionalIsoDate`. That one turns a date into a UTC instant,
 * which is right for `requested_at` and `due_at` — moments something happened
 * or must happen by — and wrong for a scheduled visit. A visit booked for the
 * twentieth is the twentieth; storing it as `2026-09-20T00:00:00.000Z` makes it
 * the nineteenth for a reader west of Greenwich, and the calendar draws its
 * chip on the wrong cell. `app/lib/reporting/period.ts` makes the same
 * distinction at length for the same reason.
 *
 * So this accepts `YYYY-MM-DD` and takes the leading ten characters of a longer
 * stamp rather than parsing it, because the stamp names one calendar day and no
 * timezone is consulted to find out which.
 */
export function optionalIsoDay(value: unknown): string | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const day = value.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  /* Reject 2026-13-40 rather than storing it. */
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 10) === day ? day : undefined;
}

/** `HH:MM`, `null` to clear, or `undefined` when unreadable. */
export function optionalClockTime(value: unknown): string | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const time = value.trim().slice(0, 5);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : undefined;
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
  /*
   * Naming an assignee also UN-NAMES the person the job was linked to.
   *
   * `assignee` is free text and stays free text — it is the record of who the
   * job was given to. Beside it, `assignee_user_id` is the account that name
   * refers to, and it is only ever set by a caller that named an ACCOUNT: the
   * route resolves it, against this organisation's memberships, immediately
   * after this function returns.
   *
   * So a write that carries only the name clears the id, exactly as
   * `contractorLinkValues` clears `contractor_id` when the contractor's name
   * changes. Leaving the previous id behind would leave a job counted against a
   * person it no longer names, for ever and invisibly — and that is not
   * hypothetical here: the automation engine's "Replace assignee" and "Clear
   * assignees" actions call this function with a NAME and nothing else, and an
   * unattended rule is exactly where a stale link would never be noticed.
   *
   * `assigneeUserId` itself is deliberately NOT coerced here. Like `siteId` and
   * `parentId` it needs a database read scoped to the caller's organisation,
   * which this module has neither of — and the automation engine calls this
   * function with no reference validation of its own, so coercing it would hand
   * an unattended rule the power to assign a job to another tenant's user.
   */
  if (typeof fields.assignee === "string" || fields.assignee === null) {
    values.assignee = trimString(fields.assignee, 120) || null;
    values.assigneeUserId = null;
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

  /*
   * The scheduling fields, as calendar DAYS.
   *
   * These are the hybrid visit model's storage: a planned visit attached to a
   * job keeps its schedule HERE, on the job, and the calendar renders it from
   * this rather than from a second row. Without this loop the route accepted
   * `scheduledDate`, answered 200 and stored nothing — which is worse than
   * refusing, because the caller is told it worked.
   */
  for (const key of ["scheduledDate", "targetCompletionDate"] as const) {
    if (!(key in fields)) continue;
    const value = optionalIsoDay(fields[key]);
    if (value === undefined) continue;
    values[key] = value;
  }
  if ("scheduledTime" in fields) {
    const value = optionalClockTime(fields.scheduledTime);
    if (value !== undefined) values.scheduledTime = value;
  }

  return values;
}

/**
 * Which of a caller's `fields` this module would silently throw away.
 *
 * `requestFieldValues` DROPS anything malformed, and for the automation engine
 * that is right: a rule firing with a value the column cannot hold should not
 * take the run down. For a person's PATCH it is not. Sending
 * `{ tier: "abc" }` was answered 200 with the row unchanged — the caller was
 * told the edit succeeded and it had not happened, which is the one answer an
 * API must never give. Worse, a payload of several fields where one was
 * malformed wrote the others and stayed silent about the rest.
 *
 * So validation lives HERE, beside the coercion it mirrors, and the route
 * refuses the whole payload before writing any of it. The engine keeps calling
 * `requestFieldValues` and keeps its own behaviour.
 *
 * A key that is ABSENT is not a problem, and a key this build does not know is
 * still ignored rather than refused — both are how every existing client
 * already talks to this route. Only a key that is PRESENT holding a value the
 * field cannot take is reported.
 */
export function invalidRequestFields(fields: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const has = (key: string) => Object.prototype.hasOwnProperty.call(fields, key);
  const note = (key: string, expected: string) =>
    problems.push(`${key} must be ${expected}.`);

  if (has("source") && fields.source !== "Portal form" && fields.source !== "Manual") {
    note("source", '"Portal form" or "Manual"');
  }

  const text: Array<[string, string]> = [
    ["description", "text"],
    ["location", "text"],
    ["requester", "text"],
    ["contact", "text"],
    ["category", "text"],
    ["engineer", "text"],
    ["priority", "text"],
    ["status", "text"],
    ["title", "text"],
  ];
  for (const [key, expected] of text) {
    if (has(key) && typeof fields[key] !== "string") note(key, expected);
  }

  // Nullable text: the null is how a caller clears it.
  for (const key of ["contractor", "assignee", "approvedBy", "invoice", "formUrl"]) {
    if (has(key) && typeof fields[key] !== "string" && fields[key] !== null) {
      note(key, "text or null");
    }
  }

  if (has("tier")) {
    const tier = fields.tier;
    if (
      typeof tier !== "number" ||
      !Number.isInteger(tier) ||
      tier < 1 ||
      tier > 20
    ) {
      note("tier", "a whole number between 1 and 20");
    }
  }

  if (has("cost")) {
    const cost = fields.cost;
    const clears = cost === null || cost === "";
    if (!clears && (typeof cost !== "number" || !Number.isFinite(cost))) {
      note("cost", "a number, or null to clear it");
    }
  }

  for (const key of ["requestedAt", "completedAt", "dueAt", "nextUpdateAt"]) {
    if (has(key) && optionalIsoDate(fields[key]) === undefined) {
      note(key, "a date, or null to clear it");
    }
  }

  for (const key of ["scheduledDate", "targetCompletionDate"]) {
    if (has(key) && optionalIsoDay(fields[key]) === undefined) {
      note(key, "a calendar day as YYYY-MM-DD, or null to clear it");
    }
  }
  if (has("scheduledTime") && optionalClockTime(fields.scheduledTime) === undefined) {
    note("scheduledTime", "a time as HH:MM, or null to clear it");
  }

  if (has("parentId") && typeof fields.parentId !== "string" && fields.parentId !== null) {
    note("parentId", "an item id or null");
  }

  /*
   * `assigneeUserId` is shape-checked here and RESOLVED in the route, exactly as
   * `parentId` above and `siteId` below, and for the same reason: deciding
   * whether a user id names somebody in THIS organisation needs a database read
   * this module cannot make. `null` is how an assignment is cleared.
   */
  if (
    has("assigneeUserId") &&
    typeof fields.assigneeUserId !== "string" &&
    fields.assigneeUserId !== null
  ) {
    note("assigneeUserId", "a workspace member's user id, or null to unassign");
  }

  /*
   * `siteId` is shape-checked here and RESOLVED in the route, exactly as
   * `parentId` above and for the same reason: attaching a job to a site needs a
   * database read scoped to the caller's organisation, and this module has
   * neither a database nor an organisation.
   *
   * So `requestFieldValues` does NOT coerce it and `site` is NOT in
   * SYSTEM_FIELD_BY_KEY. Both omissions are load-bearing: the automation engine
   * calls `requestFieldValues` with no reference validation of its own, so
   * either addition would hand an unattended rule the power to move a job onto
   * another tenant's site, at scale.
   *
   * `null` is how a job is detached. A report whose site nobody has recognised
   * yet is honestly site-less, and that is a state the product now has.
   */
  if (has("siteId") && typeof fields.siteId !== "string" && fields.siteId !== null) {
    note("siteId", "a site id, or null to leave the job unattached");
  }

  return problems;
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
