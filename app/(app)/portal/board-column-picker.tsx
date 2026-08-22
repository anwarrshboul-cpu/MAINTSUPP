"use client";

/**
 * The "add a column" menu.
 *
 * Lifted whole out of live-board.tsx, which is held under 6,000 lines by
 * `stage-eight-board-split.test.mjs`. Nothing about it changed: it takes its
 * query, its busy flag and its four callbacks as props and reaches for nothing
 * in the board's closure, which is what made it the next clean seam after the
 * column heading.
 *
 * The two-tier layout is monday's — Essentials and Super useful first, "More
 * columns" behind a disclosure — and the sections come from
 * `columnTypeDefinitions` in board-model.ts rather than being listed again
 * here.
 */

import { useContext, useEffect } from "react";
import { Icon } from "../../components";
import type { BoardColumnType } from "../../lib/types";
import { type ColumnTypeDefinition, columnTypeDefinitions } from "./board-model";
import { MobileBoardContext } from "./board-primitives";

export function ColumnPicker({
  query,
  showMore,
  busy,
  onQueryChange,
  onShowMore,
  onChoose,
  onClose,
}: {
  query: string;
  showMore: boolean;
  busy: boolean;
  onQueryChange: (value: string) => void;
  onShowMore: () => void;
  onChoose: (type: BoardColumnType) => void;
  onClose: () => void;
}) {
  const mobile = useContext(MobileBoardContext);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  const needle = query.trim().toLowerCase();
  const mobilePrimaryTypes: BoardColumnType[] = [
    "status",
    "people",
    "date",
    "text",
    "number",
    "timeline",
    "dropdown",
    "checkbox",
  ];
  const mobilePrimaryDefinitions = mobilePrimaryTypes
    .map((type) => columnTypeDefinitions.find((item) => item.type === type))
    .filter((item): item is ColumnTypeDefinition => Boolean(item));
  const mobileMoreDefinitions = columnTypeDefinitions.filter(
    (item) => !mobilePrimaryTypes.includes(item.type),
  );
  const visibleDefinitions = mobile
    ? showMore
      ? [...mobilePrimaryDefinitions, ...mobileMoreDefinitions]
      : mobilePrimaryDefinitions
    : columnTypeDefinitions.filter(
        (item) =>
          (item.section !== "More columns" || showMore || Boolean(needle)) &&
          (!needle ||
            item.label.toLowerCase().includes(needle) ||
            item.description.toLowerCase().includes(needle)),
      );
  const sections: ColumnTypeDefinition["section"][] = [
    "Essentials",
    "Super useful",
    "More columns",
  ];

  return (
    <div
      className={`column-picker${mobile ? " column-picker--mobile" : ""}`}
      role="dialog"
      aria-label="Add column"
    >
      {mobile ? (
        <header className="column-picker__mobile-header">
          <button
            type="button"
            aria-label="Close column picker"
            onClick={onClose}
          >
            <Icon name="close" size={25} />
          </button>
          <strong>Create new column</strong>
          <span aria-hidden="true" />
        </header>
      ) : (
        <header>
          <label>
            <Icon name="search" size={16} />
            <input
              autoFocus
              type="search"
              value={query}
              placeholder="Search or describe your column"
              onChange={(event) => onQueryChange(event.target.value)}
            />
          </label>
          <button
            type="button"
            aria-label="Close column picker"
            onClick={onClose}
          >
            <Icon name="close" size={17} />
          </button>
        </header>
      )}
      <div className="column-picker__body">
        {(mobile ? ["Essentials" as const] : sections).map((section) => {
          const definitions = visibleDefinitions.filter(
            (item) => mobile || item.section === section,
          );
          if (!definitions.length) return null;
          return (
            <section key={section}>
              {!mobile && <small>{section}</small>}
              <div>
                {definitions.map((definition) => (
                  <button
                    key={definition.type}
                    type="button"
                    disabled={busy}
                    onClick={() => onChoose(definition.type)}
                  >
                    <span style={{ background: definition.color }}>
                      <Icon name={definition.icon} size={mobile ? 23 : 15} />
                    </span>
                    <span>
                      <strong>
                        {mobile && definition.type === "dropdown"
                          ? "Tags"
                          : definition.label === "Numbers"
                            ? "Number"
                            : definition.label}
                      </strong>
                      {!mobile && <small>{definition.description}</small>}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
        {!visibleDefinitions.length && (
          <div className="column-picker__empty">
            No matching column type. Try text, date, people or files.
          </div>
        )}
      </div>
      {!showMore && !needle && (
        <button
          className="column-picker__more"
          type="button"
          onClick={onShowMore}
        >
          More columns
          <Icon name="chevron" size={15} />
        </button>
      )}
    </div>
  );
}
