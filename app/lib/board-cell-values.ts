/**
 * What may be written into a board cell, by column type.
 *
 * Extracted from `PATCH /api/board` (`update_cell`) so the automation engine
 * stores a custom-column value through exactly the validation the board's own
 * editor goes through — a date is `yyyy-mm-dd`, a number is a number, a
 * checkbox is "true" or nothing. One normaliser, two callers.
 */

import type { BoardColumnType } from "./types";

export const BOARD_COLUMN_TYPES = new Set<BoardColumnType>([
  "status",
  "dropdown",
  "text",
  "long_text",
  "date",
  "people",
  "number",
  "files",
  "timeline",
  "checkbox",
  "email",
  "phone",
  "link",
  "subitems",
]);

export const BOARD_DATE_ICON_IDS = new Set([
  "clock-green",
  "notice-green",
  "check-green",
  "arrow-green",
  "help-green",
  "clock-red",
  "warning-red",
  "back-red",
  "close-red",
  "bolt-blue",
  "warning-orange",
  "rocket-blue",
  "smile-grey",
  "important-grey",
]);

function trimString(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * The ONE thing a system column may store as a cell: the marker and the time
 * of day a date column draws beside the job's own date. It carries no date of
 * its own, so it cannot shadow the field. Returns null for anything else.
 */
export function dateDecorationValue(type: BoardColumnType, value: unknown): string | null {
  if (type !== "date") return null;
  const text = trimString(value, 200);
  if (!text) return "";
  if (!text.startsWith("{")) return null;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  // A decoration must NOT carry a date. That is the field's, and a cell holding
  // one is precisely the shadow the guard exists to prevent.
  if (trimString(record.date, 10)) return null;
  const time = trimString(record.time, 5);
  const icon = trimString(record.icon, 40);
  if (time && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error("Choose a valid time.");
  }
  if (icon && !BOARD_DATE_ICON_IDS.has(icon)) {
    throw new Error("Choose a valid date icon.");
  }
  return time || icon ? JSON.stringify({ time, icon }) : "";
}

/** Normalises a value for storage in a custom column's cell. Throws when unreadable. */
export function normalizeBoardCellValue(type: BoardColumnType, value: unknown): string {
  if (type === "files") return "";
  if (type === "checkbox") {
    return value === true || value === "true" ? "true" : "";
  }
  if (type === "number") {
    const text = trimString(typeof value === "number" ? String(value) : value, 100);
    if (!text) return "";
    const number = Number(text.replaceAll(",", ""));
    if (!Number.isFinite(number)) throw new Error("Enter a valid number.");
    return String(number);
  }
  if (type === "date") {
    const text = trimString(value, 500);
    if (!text) return "";
    if (text.startsWith("{")) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error("Choose a valid date.");
      }
      const date = trimString(record.date, 10);
      const time = trimString(record.time, 5);
      const icon = trimString(record.icon, 40);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error("Choose a valid date.");
      }
      if (time && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
        throw new Error("Choose a valid time.");
      }
      if (icon && !BOARD_DATE_ICON_IDS.has(icon)) {
        throw new Error("Choose a valid date icon.");
      }
      return JSON.stringify({ date, time, icon });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      throw new Error("Choose a valid date.");
    }
    return text;
  }
  if (type === "timeline") {
    const record =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : typeof value === "string"
          ? (JSON.parse(value || "{}") as Record<string, unknown>)
          : {};
    const start = trimString(record.start, 10);
    const end = trimString(record.end, 10);
    if (
      (start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) ||
      (end && !/^\d{4}-\d{2}-\d{2}$/.test(end))
    ) {
      throw new Error("Choose valid timeline dates.");
    }
    return start || end ? JSON.stringify({ start, end }) : "";
  }
  return trimString(value, type === "long_text" ? 5000 : 1000);
}

/** The `yyyy-mm-dd` a date cell holds, whichever of its two shapes it is in. */
export function dateOfCell(value: string | null | undefined): string {
  if (!value) return "";
  if (value.startsWith("{")) {
    try {
      const record = JSON.parse(value) as { date?: unknown };
      return typeof record.date === "string" ? record.date.slice(0, 10) : "";
    } catch {
      return "";
    }
  }
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : "";
}
