/**
 * What a `request.fields_changed` activity row says, in words.
 *
 * QA: a job's Activity history read "Owner updated the request details." over
 * and over, although every one of those rows stores WHICH fields moved —
 * `detail.fields` is the `fields` object the PATCH was sent
 * (app/api/maintenance/route.ts), keyed by job field (`priority`, `dueAt`, …).
 * This names them: "updated Priority and Due date."
 *
 * A field the board draws as a column is called by that column's title on THIS
 * board — so a workspace that renamed "Due date" reads its own word — via
 * `columnKeyForField`, the one translation between the two vocabularies. A
 * field with no column (site, job type, parent) has a fixed name below.
 */

import { columnKeyForField } from "./request-fields";

const FIELD_NAMES: Record<string, string> = {
  title: "Name",
  location: "Location",
  description: "Description",
  tier: "Tier",
  engineer: "Engineer",
  priority: "Priority",
  category: "Label",
  status: "Status",
  contractor: "Contractor",
  assignee: "Assignee",
  assigneeUserId: "Assignee",
  requestedAt: "Requested",
  completedAt: "Date completed",
  dueAt: "Due date",
  nextUpdateAt: "Next update",
  requester: "Requester",
  contact: "Contact",
  cost: "Cost",
  approvedBy: "Approved by",
  approvedByUserId: "Approved by",
  invoice: "Invoice",
  siteId: "Site",
  jobTypeId: "Job type",
  parentId: "Parent item",
};

/** "A", "A and B", "A, B and C". */
function listInWords(names: string[]) {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The human name of each changed field, de-duplicated, in the order sent. */
export function changedFieldNames(
  fields: unknown,
  columnTitle: (columnKey: string) => string | null | undefined = () => null,
): string[] {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return [];
  const names: string[] = [];
  for (const field of Object.keys(fields)) {
    const key = columnKeyForField(field);
    const name =
      (key ? columnTitle(key)?.trim() : "") ||
      FIELD_NAMES[field] ||
      field.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** The sentence after the actor's name; the old wording when nothing is known. */
export function fieldsChangedSentence(
  fields: unknown,
  columnTitle?: (columnKey: string) => string | null | undefined,
) {
  const names = changedFieldNames(fields, columnTitle);
  if (!names.length) return "updated the request details.";
  return `updated ${listInWords(names)}.`;
}
