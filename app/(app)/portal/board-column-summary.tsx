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
} from "./board-format";
import type { BoardOptionColumn, MaintenanceRequest } from "../../lib/types";
export default function BoardColumnSummary({
  entry,
  rows,
  optionSets,
  assigneeOptions,
  customCells,
  customFileCounts,
}: {
  entry: BoardDisplayColumn;
  rows: MaintenanceRequest[];
  optionSets: Record<BoardOptionColumn, Option[]>;
  assigneeOptions: Option[];
  customCells: Record<string, string>;
  customFileCounts: Record<string, number>;
}) {
  const column = entry.column;
  const mobile = useContext(MobileBoardContext);
  const displayedWidth = displayedBoardColumnWidth(column, mobile);
  const style: CSSProperties = {
    width: displayedWidth,
    minWidth: displayedWidth,
    maxWidth: displayedWidth,
  };
  const className = `sheet-summary-cell sheet-summary-cell--${column.type}`;

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
