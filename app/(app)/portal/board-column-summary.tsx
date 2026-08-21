"use client";

/**
 * The group footer's summary row — one cell per column, monday's own strip.
 *
 * Lifted out of `live-board.tsx` whole, unchanged. That file is held under
 * 6,000 lines by `stage-eight-board-split`, and it was two lines short of the
 * ceiling; this is the largest thing in it that is genuinely self-contained,
 * taking every input it needs as a prop and reaching for nothing in the board's
 * closure.
 *
 * It reads two ways round, which is the only thing worth knowing before
 * editing it. A CUSTOM column summarises by the column's TYPE, because all it
 * has is a bag of cell strings. A SYSTEM column summarises by its KEY, because
 * the value lives on the request and each one means something different — a
 * pile of dates is a range, a pile of costs is a total, a pile of statuses is a
 * distribution bar.
 */

import { useContext, type CSSProperties } from "react";
import { SummaryDistribution } from "./cells/summary-distribution";
import { MobileBoardContext } from "./board-primitives";
import {
  type BoardDisplayColumn,
  type Option,
  groupColors,
} from "./board-model";
import {
  choiceList,
  compactNumber,
  customCellKey,
  dateRangeSummary,
  displayedBoardColumnWidth,
  filledSummary,
  summaryDate,
} from "./board-format";
import { stickyZIndex, type StickyColumn } from "./board-pinning";
import type { BoardOptionColumn, MaintenanceRequest } from "../../lib/types";
/**
 * The stored summary choice, if the column carries one.
 *
 * `maintenance_board_columns.summary` has been written and server-validated
 * since Stage 1 — the seed itself sets "battery" on Status and Priority, "sum"
 * on Cost of Works and "min"/"max" on the two dates — and the board payload
 * never returned it, so this strip has always drawn whatever the column's TYPE
 * or KEY implies and ignored what anybody actually chose.
 *
 * The default behaviour below is unchanged and is what runs when no choice is
 * stored, which is every column on a board nobody has configured. This only
 * takes over when a choice exists, which is what makes the "Summarise by"
 * control in the column menu mean something.
 */
function numericValues(
  entry: BoardDisplayColumn,
  rows: MaintenanceRequest[],
  customCells: Record<string, string>,
  customFileCounts: Record<string, number>,
): number[] {
  const readOne = (request: MaintenanceRequest): number | null => {
    if (entry.kind === "custom") {
      const raw = customCells[customCellKey(request.id, entry.column.id)] ?? "";
      if (entry.column.type === "files") {
        return customFileCounts[customCellKey(request.id, entry.column.id)] ?? 0;
      }
      const parsed = Number(raw.replaceAll(",", ""));
      return Number.isFinite(parsed) ? parsed : null;
    }
    switch (entry.key) {
      case "cost":
        return request.cost ?? null;
      case "tier":
        return request.tier ?? null;
      case "files":
        return request.attachmentCount;
      case "completedPictures":
        return request.completedAttachmentCount ?? 0;
      case "issuePictures":
        return (
          request.issueAttachmentCount ??
          Math.max(
            request.attachmentCount -
              (request.completedAttachmentCount ?? 0) -
              (request.generalAttachmentCount ?? 0),
            0,
          )
        );
      default:
        return null;
    }
  };
  return rows
    .map(readOne)
    .filter((value): value is number => value !== null && Number.isFinite(value));
}

/** The dates a column holds, as `YYYY-MM-DD`, for min/max over a date column. */
function dateValues(
  entry: BoardDisplayColumn,
  rows: MaintenanceRequest[],
  customCells: Record<string, string>,
): string[] {
  const readOne = (request: MaintenanceRequest): string | null => {
    if (entry.kind === "custom") {
      return customCells[customCellKey(request.id, entry.column.id)] ?? null;
    }
    switch (entry.key) {
      case "requested":
        return request.requestedAt;
      case "completed":
        return request.completedAt ?? null;
      case "nextUpdate":
        return request.nextUpdateAt ?? null;
      case "dueDate":
      case "timeline":
        return request.dueAt ?? null;
      default:
        return null;
    }
  };
  return rows
    .map(readOne)
    .map((value) => (value ? summaryDate(value) : ""))
    .filter(Boolean);
}

/** What the chosen summary prints, or null to fall through to the default. */
function chosenSummaryText(
  entry: BoardDisplayColumn,
  rows: MaintenanceRequest[],
  customCells: Record<string, string>,
  customFileCounts: Record<string, number>,
): string | null {
  const summary = entry.column.summary;
  // "battery" is a distribution bar rather than a line of text, and it is what
  // the default already draws for every option-backed column, so it falls
  // through rather than being reimplemented here.
  if (!summary || summary === "battery") return null;

  if (summary === "count") {
    const filled =
      entry.kind === "custom"
        ? rows.filter((request) =>
            (customCells[customCellKey(request.id, entry.column.id)] ?? "").trim(),
          ).length
        : numericValues(entry, rows, customCells, customFileCounts).length ||
          dateValues(entry, rows, customCells).length;
    return `${filled} filled`;
  }

  const dates = dateValues(entry, rows, customCells);
  if (dates.length && (summary === "min" || summary === "max")) {
    const sorted = [...dates].sort();
    return summary === "min"
      ? `Earliest ${sorted[0]}`
      : `Latest ${sorted[sorted.length - 1]}`;
  }

  const numbers = numericValues(entry, rows, customCells, customFileCounts);
  // A chosen summary with nothing to summarise says so rather than printing a
  // zero, which would read as a real total of nothing.
  if (!numbers.length) return "No values";

  switch (summary) {
    case "sum":
      return `Total ${compactNumber(numbers.reduce((total, value) => total + value, 0))}`;
    case "average":
      return `Average ${compactNumber(
        numbers.reduce((total, value) => total + value, 0) / numbers.length,
      )}`;
    case "min":
      return `Lowest ${compactNumber(Math.min(...numbers))}`;
    case "max":
      return `Highest ${compactNumber(Math.max(...numbers))}`;
    case "median": {
      const sorted = [...numbers].sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2 === 0
          ? (sorted[middle - 1] + sorted[middle]) / 2
          : sorted[middle];
      return `Median ${compactNumber(median)}`;
    }
    default:
      return null;
  }
}

export default function BoardColumnSummary({
  entry,
  rows,
  optionSets,
  assigneeOptions,
  customCells,
  customFileCounts,
  sticky,
}: {
  entry: BoardDisplayColumn;
  rows: MaintenanceRequest[];
  optionSets: Record<BoardOptionColumn, Option[]>;
  assigneeOptions: Option[];
  customCells: Record<string, string>;
  customFileCounts: Record<string, number>;
  /** Where this column is frozen, when it is — see board-pinning.ts. */
  sticky?: StickyColumn;
}) {
  const column = entry.column;
  const mobile = useContext(MobileBoardContext);
  const displayedWidth = displayedBoardColumnWidth(column, mobile);
  const style: CSSProperties = {
    width: displayedWidth,
    minWidth: displayedWidth,
    maxWidth: displayedWidth,
  };
  if (sticky) {
    style.left = sticky.left;
    style.zIndex = stickyZIndex(sticky.order, false);
  }
  const className =
    `sheet-summary-cell sheet-summary-cell--${column.type}` +
    (column.pinned === true ? " is-pinned-column" : "");

  /*
   * An explicitly chosen summary wins over the one this column's type implies.
   * Everything below is the default and is what runs when nothing is stored,
   * which is every column on a board nobody has configured.
   */
  const chosen = chosenSummaryText(entry, rows, customCells, customFileCounts);
  if (chosen !== null) {
    return (
      <td className={className} style={style}>
        <span className="sheet-summary-text">{chosen}</span>
      </td>
    );
  }

  if (entry.kind === "custom") {
    const values = rows.map(
      (request) =>
        customCells[customCellKey(request.id, column.id)] ?? "",
    );
    if (column.type === "files") {
      const total = rows.reduce(
        (sum, request) =>
          sum +
          (customFileCounts[customCellKey(request.id, column.id)] ?? 0),
        0,
      );
      return (
        <td className={className} style={style}>
          <span className="sheet-summary-text">{total} files</span>
        </td>
      );
    }
    if (column.type === "number") {
      const total = values.reduce((sum, value) => {
        const number = Number(value.replaceAll(",", ""));
        return Number.isFinite(number) ? sum + number : sum;
      }, 0);
      return (
        <td className={className} style={style}>
          <span className="sheet-summary-text">Total {compactNumber(total)}</span>
        </td>
      );
    }
    if (column.type === "date") {
      return (
        <td className={className} style={style}>
          <span className="sheet-summary-text">{dateRangeSummary(values)}</span>
        </td>
      );
    }
    if (column.type === "timeline") {
      const dates = values.flatMap((value) => {
        try {
          const timeline = JSON.parse(value) as {
            start?: string;
            end?: string;
          };
          return [timeline.start, timeline.end];
        } catch {
          return [];
        }
      });
      return (
        <td className={className} style={style}>
          <span className="sheet-summary-text">{dateRangeSummary(dates)}</span>
        </td>
      );
    }
    if (column.type === "checkbox") {
      const checked = values.filter((value) => value === "true").length;
      return (
        <td className={className} style={style}>
          <span className="sheet-summary-text">
            {checked} / {rows.length} checked
          </span>
        </td>
      );
    }
    if (
      column.type === "status" ||
      column.type === "dropdown" ||
      column.type === "people"
    ) {
      const choices = choiceList(column).map((choice) => ({
        value: choice.id,
        label: choice.label,
        color: choice.color,
      }));
      return (
        <td className={className} style={style}>
          <SummaryDistribution values={values} options={choices} />
        </td>
      );
    }
    return (
      <td className={className} style={style}>
        <span className="sheet-summary-text">{filledSummary(values)}</span>
      </td>
    );
  }

  const key = entry.key;
  if (
    key === "tier" ||
    key === "engineer" ||
    key === "priority" ||
    key === "label" ||
    key === "status"
  ) {
    const optionKey = key as BoardOptionColumn;
    const values = rows.map((request) => {
      if (key === "tier") return String(request.tier);
      if (key === "engineer") return request.engineer;
      if (key === "priority") return request.priority;
      if (key === "label") return request.category;
      return request.status;
    });
    return (
      <td className={className} style={style}>
        <SummaryDistribution values={values} options={optionSets[optionKey]} />
      </td>
    );
  }
  if (key === "assignee" || key === "approvedBy") {
    const values = rows.map((request) =>
      key === "assignee"
        ? request.assignee ?? ""
        : request.approvedBy ?? "",
    );
    return (
      <td className={className} style={style}>
        <SummaryDistribution values={values} options={assigneeOptions} />
      </td>
    );
  }
  if (key === "storeLocation") {
    const locationOptions = Array.from(
      new Set(rows.map((request) => request.location).filter(Boolean)),
    ).map((value, index) => ({
      value,
      color: groupColors[index % groupColors.length],
    }));
    return (
      <td className={className} style={style}>
        <SummaryDistribution
          values={rows.map((request) => request.location)}
          options={locationOptions}
        />
      </td>
    );
  }
  if (key === "move") {
    return (
      <td className={className} style={style}>
        <span className="sheet-summary-text">
          {rows.length} {rows.length === 1 ? "item" : "items"}
        </span>
      </td>
    );
  }
  if (key === "requested" || key === "completed" || key === "nextUpdate") {
    const values = rows.map((request) =>
      key === "requested"
        ? request.requestedAt
        : key === "completed"
          ? request.completedAt
          : request.nextUpdateAt,
    );
    return (
      <td className={className} style={style}>
        <span className="sheet-summary-text">{dateRangeSummary(values)}</span>
      </td>
    );
  }
  if (key === "timeline") {
    return (
      <td className={className} style={style}>
        <span className="sheet-summary-text">
          {dateRangeSummary(
            rows.flatMap((request) => [request.requestedAt, request.dueAt]),
          )}
        </span>
      </td>
    );
  }
  if (
    key === "issuePictures" ||
    key === "completedPictures" ||
    key === "files"
  ) {
    const total = rows.reduce((sum, request) => {
      if (key === "issuePictures") {
        return (
          sum +
          (request.issueAttachmentCount ??
            Math.max(
              request.attachmentCount -
                (request.completedAttachmentCount ?? 0) -
                (request.generalAttachmentCount ?? 0),
              0,
            ))
        );
      }
      if (key === "completedPictures") {
        return sum + (request.completedAttachmentCount ?? 0);
      }
      return sum + request.attachmentCount;
    }, 0);
    return (
      <td className={className} style={style}>
        <span className="sheet-summary-text">{total} files</span>
      </td>
    );
  }
  if (key === "cost") {
    const total = rows.reduce((sum, request) => sum + (request.cost ?? 0), 0);
    const formatted = new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: "GBP",
      maximumFractionDigits: 2,
    }).format(total);
    return (
      <td className={className} style={style}>
        <span className="sheet-summary-text">Total {formatted}</span>
      </td>
    );
  }

  const values = rows.map((request) => {
    switch (key) {
      case "location":
        return request.location;
      case "description":
        return request.description;
      case "contractor":
        return request.contractor;
      case "requester":
        return request.requester;
      case "invoice":
        return request.invoice;
      case "number":
        return request.contact;
      case "formView":
        return request.formUrl;
      default:
        return request.title;
    }
  });
  return (
    <td className={className} style={style}>
      <span className="sheet-summary-text">{filledSummary(values)}</span>
    </td>
  );
}
