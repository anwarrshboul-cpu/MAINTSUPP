/**
 * Board formatters — pure value helpers for cells, dates and summaries.
 *
 * Extracted from live-board.tsx (Stage 8, item H1). Every function here is
 * pure: same input, same output, no state and no DOM. That is what makes them
 * safe to move and worth testing directly.
 */
import type {
  BoardColumnChoice,
  BoardColumnType,
  MaintenanceBoardColumn,
} from "../../lib/types";
import { dateOnlyValue } from "../../lib/expiry-status";
import {
  type BoardDateIcon,
  type BoardDateMetadata,
  type ColumnKey,
  boardDateIconIds,
  mobileSystemColumnDefaultWidths,
  systemColumnDefaultWidths,
} from "./board-model";

export function customCellKey(requestId: string, columnId: string) {
  return `${requestId}::${columnId}`;
}

export function choiceList(column: MaintenanceBoardColumn) {
  return column.type === "people"
    ? column.settings.people ?? []
    : column.settings.choices ?? [];
}

/**
 * The choice a cell value refers to.
 *
 * Picking an option in the grid writes the choice's `id`, so that is tried
 * first. An imported cell holds the label instead — monday exports "Kiosk", not
 * "kiosk", and choice ids are slugified on the way in — so a label match is the
 * fallback. Without it every one of the 31 imported Store Type cells resolved
 * to nothing and the column rendered a dash beside a value the database
 * plainly held.
 *
 * Case-insensitive, because the two spellings differ only by case by
 * construction.
 */
export function findChoice(
  choices: BoardColumnChoice[],
  value: string,
): BoardColumnChoice | undefined {
  if (!value) return undefined;
  const byId = choices.find((choice) => choice.id === value);
  if (byId) return byId;
  const needle = value.trim().toLowerCase();
  return choices.find(
    (choice) =>
      choice.label.trim().toLowerCase() === needle ||
      choice.id.toLowerCase() === needle,
  );
}

/**
 * The `YYYY-MM-DD` inside a stored date value, in all three shapes the board
 * writes them.
 *
 * The body moved to `dateOnlyValue` in app/lib/expiry-status.ts, which the
 * server-side compliance derivation also calls. Same function, one definition:
 * the board grid and the compliance screens have to agree about what a date
 * column says, including which malformed values count as no date at all.
 */
export function rawDateInputValue(value: string | null | undefined) {
  return dateOnlyValue(value);
}

export function parseBoardDateMetadata(
  value: string | null | undefined,
  fallbackDate = "",
): BoardDateMetadata {
  const fallback = rawDateInputValue(fallbackDate);
  if (!value) return { date: fallback, time: "", icon: "" };
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) {
    return {
      date: rawDateInputValue(trimmed) || fallback,
      time: "",
      icon: "",
    };
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const date =
      typeof parsed.date === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)
        ? parsed.date
        : fallback;
    const time =
      typeof parsed.time === "string" &&
      /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(parsed.time)
        ? parsed.time
        : "";
    const icon =
      typeof parsed.icon === "string" &&
      boardDateIconIds.has(parsed.icon as BoardDateIcon)
        ? (parsed.icon as BoardDateIcon)
        : "";
    return { date, time, icon };
  } catch {
    return { date: fallback, time: "", icon: "" };
  }
}

export function serializeBoardDateMetadata(value: BoardDateMetadata) {
  if (!value.date) return "";
  return JSON.stringify(value);
}

export function boardDateValue(value: BoardDateMetadata) {
  if (!value.date) return null;
  return value.time
    ? `${value.date}T${value.time}:00.000Z`
    : value.date;
}

export function formatBoardTime(value: string) {
  if (!value) return "";
  const [hourValue, minute] = value.split(":").map(Number);
  const suffix = hourValue >= 12 ? "PM" : "AM";
  const hour = hourValue % 12 || 12;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${suffix}`;
}

export function formatMobileBoardDate(
  value: string | null | undefined,
  metadataValue?: string | null,
) {
  const date = rawDateInputValue(value);
  if (!date) return "—";
  const metadata = parseBoardDateMetadata(metadataValue, date);
  const [year, month, day] = date.split("-").map(Number);
  const label = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
  return metadata.time ? `${label}, ${formatBoardTime(metadata.time)}` : label;
}

export function formatFullBoardDate(value: string) {
  const date = rawDateInputValue(value);
  if (!date) return "Choose date";
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function todayBoardDate() {
  const now = new Date();
  return [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function boardCalendarMonth(value?: string | null) {
  const date = dateInputValue(value) || todayBoardDate();
  return `${date.slice(0, 7)}-01`;
}

export function shiftBoardCalendarMonth(value: string, amount: number) {
  const [year, month] = value.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + amount, 1));
  return `${shifted.getUTCFullYear()}-${String(
    shifted.getUTCMonth() + 1,
  ).padStart(2, "0")}-01`;
}

export function boardCalendarMonthLabel(value: string, yearFirst = false) {
  const [year, month] = value.split("-").map(Number);
  const monthLabel = new Intl.DateTimeFormat("en-US", {
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
  return yearFirst ? `${year} ${monthLabel}` : `${monthLabel} ${year}`;
}

export function boardCalendarDays(value: string, weekStartsOn: 0 | 1) {
  const [year, month] = value.split("-").map(Number);
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const leading = (firstWeekday - weekStartsOn + 7) % 7;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const total = Math.ceil((leading + daysInMonth) / 7) * 7;
  return Array.from({ length: total }, (_, index) => {
    const day = index - leading + 1;
    if (day < 1 || day > daysInMonth) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(
      2,
      "0",
    )}`;
  });
}

export function customCellDisplay(column: MaintenanceBoardColumn, value: string) {
  if (!value) return "";
  if (
    column.type === "status" ||
    column.type === "dropdown" ||
    column.type === "people"
  ) {
    return findChoice(choiceList(column), value)?.label ?? value;
  }
  if (column.type === "checkbox") return value === "true" ? "Yes" : "No";
  if (column.type === "date") {
    const metadata = parseBoardDateMetadata(value);
    return metadata.date
      ? `${metadata.date}${metadata.time ? ` ${metadata.time}` : ""}`
      : "";
  }
  if (column.type === "timeline") {
    try {
      const timeline = JSON.parse(value) as { start?: string; end?: string };
      return [timeline.start, timeline.end].filter(Boolean).join(" to ");
    } catch {
      return value;
    }
  }
  return value;
}

export function serializeCustomCellValue(
  type: BoardColumnType,
  value: string | boolean | { start: string; end: string },
) {
  if (type === "checkbox") return value === true || value === "true" ? "true" : "";
  if (type === "timeline" && typeof value === "object") {
    return value.start || value.end ? JSON.stringify(value) : "";
  }
  return String(value ?? "").trim();
}

export function dateInputValue(value: string | null | undefined) {
  return rawDateInputValue(value);
}

export const centeredBoardColumnTypes = new Set<BoardColumnType>([
  "text",
  "long_text",
  "number",
  "email",
  "phone",
  "link",
]);

export function shouldCenterBoardCell(
  column: MaintenanceBoardColumn,
  key?: ColumnKey,
) {
  return key !== "name" && centeredBoardColumnTypes.has(column.type);
}

export function displayedBoardColumnWidth(
  column: MaintenanceBoardColumn,
  mobile: boolean,
) {
  if (!mobile || !column.system || !column.key) return column.width;
  const systemKey = column.key as ColumnKey;
  const desktopDefault = systemColumnDefaultWidths.get(systemKey);
  const mobileDefault = mobileSystemColumnDefaultWidths[systemKey];
  return mobileDefault && column.width === desktopDefault
    ? mobileDefault
    : column.width;
}

export function compactNumber(value: number) {
  return new Intl.NumberFormat("en-GB", {
    maximumFractionDigits: 2,
  }).format(value);
}

export function summaryDate(value: string) {
  const date = dateInputValue(value);
  if (!date) return "";
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function dateRangeSummary(values: Array<string | null | undefined>) {
  const dates = values
    .map((value) => dateInputValue(value))
    .filter(Boolean)
    .sort();
  if (!dates.length) return "No dates";
  const first = dates[0];
  const last = dates.at(-1)!;
  return first === last
    ? summaryDate(first)
    : `${summaryDate(first)} – ${summaryDate(last)}`;
}

export function filledSummary(values: Array<unknown>) {
  const filled = values.filter((value) => {
    if (value === null || value === undefined) return false;
    return String(value).trim().length > 0;
  }).length;
  return `${filled} filled`;
}


/**
 * A date as its distance from today — "Today", "In 3 days", "5 days ago".
 *
 * WHAT THIS CLOSES. The Store Documentation expiry cells have carried a
 * temporal read since Stage 15 ("Expires today", "Due soon", "Expired"), and
 * the maintenance date columns have carried none: Date Requested, Date
 * Completed and Next Update all rendered a bare `<input type="date">`, so
 * `12/03/2026` sat there and the reader did the subtraction. On Next Update in
 * particular — the column that drives the chase — the whole value of the cell
 * is whether it is behind you.
 *
 * BOUNDED TO A FORTNIGHT EITHER WAY, deliberately. Past that the relative form
 * stops helping and starts obscuring: "in 94 days" is arithmetic nobody wants
 * to run backwards, and the date is the better answer. Outside the window this
 * returns null and the cell shows the date alone.
 *
 * `now` is a parameter rather than a call to the clock so that every cell in
 * one render agrees about today, and so this is testable without freezing time.
 */
export function relativeDayLabel(value: string | null | undefined, now: Date): string | null {
  const date = dateInputValue(value);
  if (!date) return null;
  const target = new Date(`${date}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;

  // Compared at local midnight on both sides: an afternoon "today" and a
  // morning "today" are the same day, and a timestamp must not read as
  // tomorrow because it carries a time.
  const startOfDay = (input: Date) =>
    new Date(input.getFullYear(), input.getMonth(), input.getDate()).getTime();
  const days = Math.round((startOfDay(target) - startOfDay(now)) / 86_400_000);

  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  if (days > 1 && days <= 14) return `In ${days} days`;
  if (days < -1 && days >= -14) return `${Math.abs(days)} days ago`;
  return null;
}
