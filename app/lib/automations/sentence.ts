/**
 * The sentence a rule is shown as — "When status changes to Completed, move
 * item to Done".
 *
 * Composed from the rule's two configs and a resolver that turns ids into the
 * names a person knows them by. The server composes it with database lookups
 * when a rule is saved; the builder composes it live from the board it has in
 * hand. Same function, so the preview and the saved name cannot disagree.
 */

import { configNumber, configString } from "./types";

export type SentenceResolver = {
  column(key: string): string;
  group(id: string): string;
  option(column: string, value: string): string;
  person(id: string): string;
};

export const PLAIN_RESOLVER: SentenceResolver = {
  column: (key) => key,
  group: (id) => id,
  option: (_column, value) => value,
  person: (id) => id,
};

function lower(text: string) {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

export function triggerSentence(
  type: string,
  config: Record<string, unknown>,
  resolve: SentenceResolver = PLAIN_RESOLVER,
): string {
  const column = configString(config, "column");
  switch (type) {
    case "status_changes": {
      const name = column ? resolve.column(column) : "Status";
      const from = configString(config, "from");
      const to = configString(config, "to");
      const key = column || "status";
      const tail =
        from && to
          ? ` from ${resolve.option(key, from)} to ${resolve.option(key, to)}`
          : to
            ? ` to ${resolve.option(key, to)}`
            : from
              ? ` from ${resolve.option(key, from)}`
              : "";
      return `When ${lower(name)} changes${tail}`;
    }
    case "column_changes":
      return `When ${column ? resolve.column(column) : "a column"} changes`;
    case "person_assigned": {
      const person = configString(config, "person");
      const name = column ? resolve.column(column) : "Assigned To";
      return person
        ? `When ${resolve.person(person)} is assigned in ${name}`
        : `When a person is assigned in ${name}`;
    }
    case "name_changes":
      return "When the item name changes";
    case "date_arrives": {
      const name = column ? resolve.column(column) : "a date";
      const when = configString(config, "when") || "on";
      const days = configNumber(config, "days") ?? 0;
      if (when === "before" && days > 0) return `${days} day${days === 1 ? "" : "s"} before ${name} arrives`;
      if (when === "after" && days > 0) return `${days} day${days === 1 ? "" : "s"} after ${name} arrives`;
      return `When ${name} arrives`;
    }
    case "item_created":
      return "When an item is created";
    case "item_moved_to_group": {
      const groupId = configString(config, "groupId");
      return groupId
        ? `When an item is moved to ${resolve.group(groupId)}`
        : "When an item is moved to any group";
    }
    case "update_created":
      return "When an update is posted";
    case "every_period": {
      const every = configString(config, "every") || "day";
      return every === "week" ? "Every week" : "Every day";
    }
    case "subitem_created":
      return "When a subitem is created";
    case "subitem_column_changes":
      return column
        ? `When ${resolve.column(column)} changes on a subitem`
        : "When a subitem column changes";
    default:
      return `When ${type.replaceAll("_", " ")}`;
  }
}

export function actionSentence(
  type: string,
  config: Record<string, unknown>,
  resolve: SentenceResolver = PLAIN_RESOLVER,
): string {
  const column = configString(config, "column");
  const value = configString(config, "value");
  switch (type) {
    case "change_column_value":
      return `set ${column ? resolve.column(column) : "a column"} to ${
        value ? resolve.option(column, value) : "…"
      }`;
    case "change_status":
      return `change ${column ? lower(resolve.column(column)) : "status"} to ${
        value ? resolve.option(column || "status", value) : "…"
      }`;
    case "notify_person":
      return `notify ${configString(config, "to") || "someone"} by email`;
    case "set_date": {
      const days = configNumber(config, "days") ?? 0;
      const name = column ? resolve.column(column) : "a date";
      return days
        ? `set ${name} to ${days} day${days === 1 ? "" : "s"} from today`
        : `set ${name} to today`;
    }
    case "push_date": {
      const days = configNumber(config, "days") ?? 0;
      return `push ${column ? resolve.column(column) : "a date"} by ${days} day${days === 1 ? "" : "s"}`;
    }
    case "move_to_group": {
      const groupId = configString(config, "groupId");
      return `move item to ${groupId ? resolve.group(groupId) : "…"}`;
    }
    case "create_subitem":
      return `create subitem "${configString(config, "title") || "…"}"`;
    case "replace_assignee": {
      const person = configString(config, "person");
      return `assign ${person ? resolve.person(person) : "…"}`;
    }
    case "assign_item_creator":
      return "assign the item's creator";
    case "clear_assignees":
      return "clear assignees";
    case "create_item": {
      const groupId = configString(config, "groupId");
      return `create item "${configString(config, "title") || "…"}"${
        groupId ? ` in ${resolve.group(groupId)}` : ""
      }`;
    }
    case "create_update":
      return `post an update "${configString(config, "body").slice(0, 60) || "…"}"`;
    case "clear_column_value":
      return `clear ${column ? resolve.column(column) : "a column"}`;
    case "archive_item":
      return "archive item";
    case "delete_item":
      return "delete item";
    case "duplicate_item":
      return "duplicate item";
    case "set_number":
      return `set ${column ? resolve.column(column) : "a number"} to ${value || "…"}`;
    case "create_group":
      return `create group "${configString(config, "name") || "…"}"`;
    default:
      return type.replaceAll("_", " ");
  }
}

export function composeSentence(
  triggerType: string,
  triggerConfig: Record<string, unknown>,
  actionType: string,
  actionConfig: Record<string, unknown>,
  resolve: SentenceResolver = PLAIN_RESOLVER,
): string {
  return `${triggerSentence(triggerType, triggerConfig, resolve)}, ${actionSentence(
    actionType,
    actionConfig,
    resolve,
  )}`;
}
