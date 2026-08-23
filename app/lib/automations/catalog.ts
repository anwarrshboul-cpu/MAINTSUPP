/**
 * What a rule can be made of — every trigger and every action the engine
 * knows, with the configuration each one needs and whether it is available in
 * THIS workspace.
 *
 * Pure data with no database and no React in it, so the server route serves
 * it and the builder renders it from the same definitions. A trigger or an
 * action that appears here and is not handled in `engine.ts` / `actions.ts`
 * is a bug the tests catch; one handled there and absent here cannot be
 * chosen and so cannot exist.
 *
 * HONESTY RULE. Nothing is listed that the data model cannot actually carry
 * out. Where monday offers something this board cannot — a second assignee on
 * a one-person column, time tracking, moving an item to a board with
 * different columns — the entry is omitted and the omission is written down
 * in `OMITTED` with its reason, so a reader of the picker and a reader of the
 * code get the same answer. Third-party integrations are listed greyed out
 * with "Requires a connection", because that is what they are: not built, and
 * not pretended.
 */

export type FieldKind =
  /** One of the board's status-type columns (Status, Priority, Engineer…). */
  | "status_column"
  /** A value of the status column named by `dependsOn`. */
  | "status_value"
  /** Any editable column on the board. */
  | "column"
  /** A value for the column named by `dependsOn`; the control follows its type. */
  | "column_value"
  | "date_column"
  | "people_column"
  | "number_column"
  | "group"
  | "person"
  | "text"
  | "long_text"
  | "number"
  | "days"
  | "choice"
  | "email";

export type CatalogField = {
  key: string;
  label: string;
  kind: FieldKind;
  optional?: boolean;
  placeholder?: string;
  /** Another field whose value narrows this one — a status column for its values. */
  dependsOn?: string;
  /** Fixed choices, for `choice`. */
  options?: Array<{ value: string; label: string }>;
  /** What an empty optional field means, for the sentence. */
  anyLabel?: string;
};

export type CatalogEntry = {
  type: string;
  label: string;
  description: string;
  /** A glyph key the builder maps to an inline icon. */
  icon: string;
  group: string;
  fields: CatalogField[];
  available: boolean;
  reason?: string;
};

export type CatalogTrigger = CatalogEntry & {
  /** Evaluated by the sweep rather than raised by a write. */
  timeBased?: boolean;
  /** Fires with no item in hand — only item-less actions may follow it. */
  itemless?: boolean;
};

export type CatalogAction = CatalogEntry & {
  /** Whether the action needs an item to act on. */
  needsItem: boolean;
};

export type AutomationCatalog = {
  triggers: CatalogTrigger[];
  actions: CatalogAction[];
  /** Curated "Most used" shortlists, in order. */
  mostUsedTriggers: string[];
  mostUsedActions: string[];
  /** What was deliberately left out, and why. Shown as a footnote. */
  omitted: Array<{ label: string; reason: string }>;
  /** How time-based rules are actually evaluated. Shown beside them. */
  timeBasedNote: string;
};

export type CatalogEnvironment = {
  /** Whether an email provider is configured (RESEND_API_KEY). */
  emailConfigured: boolean;
};

export const TIME_BASED_NOTE =
  "Time-based rules are checked when the board is opened, at most once every ten minutes.";

const STATUS_COLUMN: CatalogField = {
  key: "column",
  label: "Status column",
  kind: "status_column",
  optional: true,
  anyLabel: "Status",
};

export function buildCatalog(env: CatalogEnvironment): AutomationCatalog {
  const triggers: CatalogTrigger[] = [
    {
      type: "status_changes",
      label: "When status changes",
      description: "A status-type column moves from one value to another.",
      icon: "status",
      group: "Column change",
      fields: [
        STATUS_COLUMN,
        { key: "from", label: "from", kind: "status_value", dependsOn: "column", optional: true, anyLabel: "anything" },
        { key: "to", label: "to", kind: "status_value", dependsOn: "column", optional: true, anyLabel: "anything" },
      ],
      available: true,
    },
    {
      type: "column_changes",
      label: "When a column changes",
      description: "Any change to one column, whatever the value.",
      icon: "column",
      group: "Column change",
      fields: [{ key: "column", label: "Column", kind: "column" }],
      available: true,
    },
    {
      type: "person_assigned",
      label: "When a person is assigned",
      description: "The Assigned To column, or a people column, gains a person.",
      icon: "person",
      group: "Column change",
      fields: [
        { key: "column", label: "People column", kind: "people_column", optional: true, anyLabel: "Assigned To" },
        { key: "person", label: "person", kind: "person", optional: true, dependsOn: "column", anyLabel: "someone" },
      ],
      available: true,
    },
    {
      type: "name_changes",
      label: "When the item name changes",
      description: "The item is renamed.",
      icon: "text",
      group: "Column change",
      fields: [],
      available: true,
    },
    {
      type: "date_arrives",
      label: "When a date arrives",
      description: "A date column reaches today, or a number of days before or after it.",
      icon: "calendar",
      group: "Column change",
      fields: [
        { key: "column", label: "Date column", kind: "date_column" },
        {
          key: "when",
          label: "when",
          kind: "choice",
          options: [
            { value: "on", label: "on the day" },
            { value: "before", label: "days before" },
            { value: "after", label: "days after" },
          ],
        },
        { key: "days", label: "days", kind: "days", optional: true },
      ],
      available: true,
      timeBased: true,
    },
    {
      type: "item_created",
      label: "When an item is created",
      description: "A new item lands on the board, from the board, the form or the drawer.",
      icon: "plus",
      group: "Item moved or changed",
      fields: [],
      available: true,
    },
    {
      type: "item_moved_to_group",
      label: "When an item is moved to a group",
      description: "An item changes group — by drag, by menu, or by another rule.",
      icon: "move",
      group: "Item moved or changed",
      fields: [{ key: "groupId", label: "Group", kind: "group", optional: true, anyLabel: "any group" }],
      available: true,
    },
    {
      type: "update_created",
      label: "When an update is posted",
      description: "Somebody writes an update on the item.",
      icon: "comment",
      group: "Item moved or changed",
      fields: [],
      available: true,
    },
    {
      type: "every_period",
      label: "Every time period",
      description: "Once a day or once a week, the first time the board is opened after the boundary.",
      icon: "repeat",
      group: "Recurring",
      fields: [
        {
          key: "every",
          label: "every",
          kind: "choice",
          options: [
            { value: "day", label: "day" },
            { value: "week", label: "week" },
          ],
        },
      ],
      available: true,
      timeBased: true,
      itemless: true,
    },
    {
      type: "subitem_created",
      label: "When a subitem is created",
      description: "A child item is added under an item.",
      icon: "subitem",
      group: "Subitems",
      fields: [],
      available: true,
    },
    {
      type: "subitem_column_changes",
      label: "When a subitem column changes",
      description: "A column on a subitem changes.",
      icon: "subitem",
      group: "Subitems",
      fields: [{ key: "column", label: "Column", kind: "column", optional: true, anyLabel: "any column" }],
      available: true,
    },
    {
      type: "gmail_received",
      label: "When an email is received in Gmail",
      description: "Requires a Gmail connection. None exists in this workspace.",
      icon: "mail",
      group: "Gmail",
      fields: [],
      available: false,
      reason: "Requires a connection",
    },
    {
      type: "outlook_received",
      label: "When an email is received in Outlook",
      description: "Requires an Outlook connection. None exists in this workspace.",
      icon: "mail",
      group: "Outlook",
      fields: [],
      available: false,
      reason: "Requires a connection",
    },
    {
      type: "slack_message",
      label: "When a message is posted in Slack",
      description: "Requires a Slack connection. None exists in this workspace.",
      icon: "slack",
      group: "Slack",
      fields: [],
      available: false,
      reason: "Requires a connection",
    },
  ];

  const actions: CatalogAction[] = [
    {
      type: "change_column_value",
      label: "Change column value",
      description: "Set a column to a value.",
      icon: "column",
      group: "Most used",
      fields: [
        { key: "column", label: "Column", kind: "column" },
        { key: "value", label: "to", kind: "column_value", dependsOn: "column" },
      ],
      available: true,
      needsItem: true,
    },
    {
      type: "notify_person",
      label: "Notify someone by email",
      description: env.emailConfigured
        ? "Send an email through the workspace's mail provider."
        : "Sends an email. No provider is configured (RESEND_API_KEY), so the message would be logged and skipped.",
      icon: "bell",
      group: "Most used",
      fields: [
        { key: "to", label: "email address", kind: "email" },
        { key: "message", label: "message", kind: "long_text" },
      ],
      available: env.emailConfigured,
      reason: env.emailConfigured ? undefined : "Email delivery is not configured",
      needsItem: false,
    },
    {
      type: "set_date",
      label: "Set date",
      description: "Set a date column to today, or a number of days from today.",
      icon: "calendar",
      group: "Date and time",
      fields: [
        { key: "column", label: "Date column", kind: "date_column" },
        { key: "days", label: "days from today", kind: "days", optional: true },
      ],
      available: true,
      needsItem: true,
    },
    {
      type: "change_status",
      label: "Change status",
      description: "Set a status-type column to a value.",
      icon: "status",
      group: "Most used",
      fields: [
        STATUS_COLUMN,
        { key: "value", label: "to", kind: "status_value", dependsOn: "column" },
      ],
      available: true,
      needsItem: true,
    },
    {
      type: "move_to_group",
      label: "Move item to group",
      description: "Move the item to the end of a group. A group with a stage sets the stage too.",
      icon: "move",
      group: "Most used",
      fields: [{ key: "groupId", label: "Group", kind: "group" }],
      available: true,
      needsItem: true,
    },
    {
      type: "create_subitem",
      label: "Create subitem",
      description: "Add a child item under the item.",
      icon: "subitem",
      group: "Most used",
      fields: [{ key: "title", label: "named", kind: "text", placeholder: "Subitem name" }],
      available: true,
      needsItem: true,
    },
    {
      type: "replace_assignee",
      label: "Replace assignee",
      description: "Set Assigned To to one person.",
      icon: "person",
      group: "Assign",
      fields: [{ key: "person", label: "with", kind: "person" }],
      available: true,
      needsItem: true,
    },
    {
      type: "assign_item_creator",
      label: "Assign item creator",
      description: "Set Assigned To to whoever created the item, when that is known.",
      icon: "person",
      group: "Assign",
      fields: [],
      available: true,
      needsItem: true,
    },
    {
      type: "clear_assignees",
      label: "Clear assignees",
      description: "Empty the Assigned To column.",
      icon: "clear",
      group: "Assign",
      fields: [],
      available: true,
      needsItem: true,
    },
    {
      type: "push_date",
      label: "Push date",
      description: "Move a date column forward by a number of days.",
      icon: "calendar",
      group: "Date and time",
      fields: [
        { key: "column", label: "Date column", kind: "date_column" },
        { key: "days", label: "by days", kind: "days" },
      ],
      available: true,
      needsItem: true,
    },
    {
      type: "slack_notify",
      label: "Notify in Slack",
      description: "Requires a Slack connection. None exists in this workspace.",
      icon: "slack",
      group: "Featured",
      fields: [],
      available: false,
      reason: "Requires a connection",
      needsItem: false,
    },
    {
      type: "teams_notify",
      label: "Notify in Microsoft Teams",
      description: "Requires a Teams connection. None exists in this workspace.",
      icon: "teams",
      group: "Featured",
      fields: [],
      available: false,
      reason: "Requires a connection",
      needsItem: false,
    },
    {
      type: "gmail_send",
      label: "Send an email via Gmail",
      description: "Requires a Gmail connection. None exists in this workspace.",
      icon: "mail",
      group: "Featured",
      fields: [],
      available: false,
      reason: "Requires a connection",
      needsItem: false,
    },
    {
      type: "outlook_send",
      label: "Send an email via Outlook",
      description: "Requires an Outlook connection. None exists in this workspace.",
      icon: "mail",
      group: "Featured",
      fields: [],
      available: false,
      reason: "Requires a connection",
      needsItem: false,
    },
    {
      type: "create_item",
      label: "Create item",
      description: "Add a new item to a group on this board.",
      icon: "plus",
      group: "Item",
      fields: [
        { key: "title", label: "named", kind: "text", placeholder: "Item name" },
        { key: "groupId", label: "in group", kind: "group" },
      ],
      available: true,
      needsItem: false,
    },
    {
      type: "create_update",
      label: "Create update",
      description: "Post an update on the item. {name} is replaced by the item's name.",
      icon: "comment",
      group: "Item",
      fields: [{ key: "body", label: "saying", kind: "long_text", placeholder: "Write an update" }],
      available: true,
      needsItem: true,
    },
    {
      type: "clear_column_value",
      label: "Clear column value",
      description: "Empty a column. Columns the board requires — Status, Priority, Engineer, Name — cannot be cleared.",
      icon: "clear",
      group: "Item",
      fields: [{ key: "column", label: "Column", kind: "column" }],
      available: true,
      needsItem: true,
    },
    {
      type: "archive_item",
      label: "Archive item",
      description: "Move the item to the board's Archived group.",
      icon: "archive",
      group: "Item",
      fields: [],
      available: true,
      needsItem: true,
    },
    {
      type: "delete_item",
      label: "Delete item",
      description: "Send the item to the recycle bin, where it can be restored for 30 days.",
      icon: "trash",
      group: "Item",
      fields: [],
      available: true,
      needsItem: true,
    },
    {
      type: "duplicate_item",
      label: "Duplicate item",
      description: "Copy the item, with its cells and without its files.",
      icon: "copy",
      group: "Item",
      fields: [],
      available: true,
      needsItem: true,
    },
    {
      type: "set_number",
      label: "Set number",
      description: "Set a number column — Cost of Works, or a custom number column.",
      icon: "number",
      group: "Numbers",
      fields: [
        { key: "column", label: "Number column", kind: "number_column" },
        { key: "value", label: "to", kind: "number" },
      ],
      available: true,
      needsItem: true,
    },
    {
      type: "create_group",
      label: "Create group",
      description: "Add a group at the end of the board.",
      icon: "group",
      group: "Boards and groups",
      fields: [{ key: "name", label: "named", kind: "text", placeholder: "Group name" }],
      available: true,
      needsItem: false,
    },
  ];

  return {
    triggers,
    actions,
    mostUsedTriggers: ["status_changes", "item_created", "column_changes", "person_assigned", "date_arrives"],
    mostUsedActions: [
      "change_column_value",
      "notify_person",
      "set_date",
      "change_status",
      "move_to_group",
      "create_subitem",
    ],
    omitted: OMITTED,
    timeBasedNote: TIME_BASED_NOTE,
  };
}

/** Left out on purpose. Each one names the thing the data model lacks. */
export const OMITTED: Array<{ label: string; reason: string }> = [
  {
    label: "Add assignee",
    reason: "Assigned To holds one person per item on this board; use Replace assignee.",
  },
  {
    label: "Set hour to current time / Start or stop time tracking",
    reason: "There is no time-tracking column on this board.",
  },
  {
    label: "Move item to board / Create item in another board",
    reason: "The two boards carry different columns, so an item cannot move between them intact.",
  },
  {
    label: "Duplicate board / Duplicate group",
    reason: "Neither operation exists in this product.",
  },
  {
    label: "AI suggestions",
    reason: "No AI service is connected to this workspace.",
  },
];

/** Lookups by type, for the engine and the validators. */
export function catalogIndex(catalog: AutomationCatalog) {
  return {
    trigger: new Map(catalog.triggers.map((entry) => [entry.type, entry])),
    action: new Map(catalog.actions.map((entry) => [entry.type, entry])),
  };
}

/**
 * Which columns a field kind accepts, by the board's own column types.
 *
 * Shared by the server-side validator and the builder's pickers, so a rule the
 * builder lets you make is one the server accepts, and vice versa.
 */
export const COLUMN_KINDS: Record<
  Extract<FieldKind, "status_column" | "date_column" | "people_column" | "number_column" | "column">,
  readonly string[]
> = {
  status_column: ["status", "dropdown"],
  date_column: ["date"],
  people_column: ["people"],
  number_column: ["number"],
  column: ["status", "dropdown", "text", "long_text", "date", "people", "number", "checkbox", "email", "phone", "link"],
};
