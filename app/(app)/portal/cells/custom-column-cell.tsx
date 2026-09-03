"use client";

/**
 * The generic custom-column cell, and the choice cell it delegates to.
 *
 * Lifted out of live-board.tsx whole and unchanged. Both are prop-driven
 * leaves: `CustomColumnCell` dispatches on `column.type` to the right editor
 * and closes over no board state, and `CustomChoiceCell` — its only caller is
 * `CustomColumnCell` below, which is why it is not exported — holds nothing but
 * its own popover state. Neither reads a module-level value from live-board, so
 * the move is behaviour-neutral by construction rather than by inspection.
 *
 * WHY THEY ARE HERE. live-board.tsx is held under 6,000 lines by
 * `tests/stage-eight-board-split.test.mjs`, and it had reached 5,996 of them —
 * three lines of headroom, which is not enough to fix a bug in. A file that
 * cannot be edited is worse than a long one: the first-paint defect on Store
 * Documentation went unfixed for exactly that reason. These 568 lines are the
 * cleanest thing in the file to move, and the cells folder is where the board's
 * leaf cells already live.
 */

import { useContext, useEffect, useRef, useState } from "react";
import { Icon } from "../../../components";
import { chipStyle } from "../chip-ink";
import type {
  BoardColumnChoice,
  BoardColumnSettings,
  MaintenanceBoardColumn,
  MaintenanceBoardFilePreview,
} from "../../../lib/types";
import { FileHoverPreview } from "../evidence-manager";
import { ExpiryCell } from "./expiry-cell";
import { FileCell, boardFileCellFiles } from "./file-cell";
import { choiceList, findChoice } from "../board-format";
import {
  MobileBoardContext,
  MobileCellSheet,
  useRevealBoardPopover,
} from "../board-primitives";
import { DateCell, InlineTextCell, TimelineCell } from "../board-cells";

export function CustomColumnCell({
  storeDocumentation,
  column,
  value,
  fileCount,
  filePreview,
  requestId,
  onChange,
  onUpdateSettings,
  onOpenFiles,
}: {
  /**
   * Whether this cell is on a COMPLIANCE REGISTER — the canonical Store
   * Documentation board, or a Documents-template section's own.
   *
   * It was `boardId: string`, compared against the literal
   * "store-documentation" twice below. An instance's key is `sec-…`, so on a
   * section's own compliance register every date column rendered as a bare
   * date instead of an expiry with its RAG state, and every document column
   * fell back to the maintenance hover preview instead of per-file chips —
   * the two things that make the board a compliance register at all.
   */
  storeDocumentation: boolean;
  column: MaintenanceBoardColumn;
  value: string;
  fileCount: number;
  /** First few files in this cell, for the tiles. */
  filePreview: MaintenanceBoardFilePreview[];
  requestId: string;
  onChange: (
    value: string | boolean | { start: string; end: string },
  ) => void;
  onUpdateSettings: (settings: BoardColumnSettings) => Promise<void>;
  onOpenFiles: () => void;
}) {
  if (
    column.type === "status" ||
    column.type === "dropdown" ||
    column.type === "people"
  ) {
    return (
      <CustomChoiceCell
        column={column}
        value={value}
        onChange={onChange}
        onUpdateSettings={onUpdateSettings}
      />
    );
  }
  if (column.type === "date") {
    /*
     * On the Store Documentation board every date column is a certificate
     * expiry, so it renders with its RAG state rather than as a bare date. A
     * date sitting in a cell tells you nothing; "expired 147 days ago" is the
     * whole reason the column exists. Maintenance keeps the plain date cell.
     */
    if (storeDocumentation) {
      return (
        <ExpiryCell
          title={column.title}
          value={value}
          metadataValue={value}
          onSave={(_next, metadata) => onChange(metadata)}
        />
      );
    }
    return (
      <DateCell
        title={column.title}
        value={value}
        metadataValue={value}
        onSave={(_next, metadata) => onChange(metadata)}
      />
    );
  }
  if (column.type === "timeline") {
    let timeline: { start?: string; end?: string } = {};
    try {
      timeline = value ? (JSON.parse(value) as typeof timeline) : {};
    } catch {
      timeline = {};
    }
    return (
      <TimelineCell
        title={column.title}
        start={timeline.start}
        end={timeline.end}
        onSave={(start, end) =>
          onChange({ start: start ?? "", end: end ?? "" })
        }
      />
    );
  }
  if (column.type === "checkbox") {
    return (
      <label className="sheet-custom-checkbox">
        <input
          type="checkbox"
          checked={value === "true"}
          aria-label={column.title}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span><Icon name="check" size={13} /></span>
      </label>
    );
  }
  if (column.type === "files") {
    /*
     * The twelve document columns are what the Store Documentation board is
     * for, so they get real per-file chips. Maintenance keeps the hover preview
     * it has always had — changing it was not asked for and board parity tests
     * pin its behaviour.
     */
    if (storeDocumentation) {
      return (
        <FileCell
          title={column.title}
          requestId={requestId}
          columnId={column.id}
          // The real documents, not `[]`. See `boardFileCellFiles`: with no
          // files the cell drew one anonymous digit per certificate. All
          // twelve columns now draw chips — the `column.key === "rams"`
          // special case is gone, because `summary` in the board spec is the
          // group-footer aggregation ("battery", "min", "sum"), never a cell
          // renderer, and monday types all twelve columns identically.
          files={boardFileCellFiles(filePreview)}
          count={fileCount}
          onSave={() => {
            // Counts live in the board snapshot, so a new or removed document
            // has to come back through the board rather than be patched here.
            window.dispatchEvent(new Event("maintsupp:refresh-board"));
          }}
          onOpen={onOpenFiles}
        />
      );
    }
    /* Every maintenance file column takes THIS path, not the `case
       "issuePictures"` blocks below — which is why the photo columns drew a
       paperclip and a number instead of the photographs. */
    return (
      <FileHoverPreview
        requestId={requestId}
        columnId={column.id}
        mondayMediaStyle
        count={fileCount}
        preview={filePreview}
        onOpen={onOpenFiles}
      />
    );
  }
  return (
    <InlineTextCell
      title={column.title}
      value={value}
      emptyLabel="Add value"
      multiline={column.type === "long_text"}
      inputMode={
        column.type === "number"
          ? "decimal"
          : column.type === "email"
            ? "email"
            : column.type === "phone"
              ? "tel"
              : column.type === "link"
                ? "url"
                : "text"
      }
      onSave={onChange}
    />
  );
}


function CustomChoiceCell({
  column,
  value,
  onChange,
  onUpdateSettings,
}: {
  column: MaintenanceBoardColumn;
  value: string;
  onChange: (value: string) => void;
  onUpdateSettings: (settings: BoardColumnSettings) => Promise<void>;
}) {
  const mobile = useContext(MobileBoardContext);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newColor, setNewColor] = useState("#579bfc");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const choices = choiceList(column);
  const selected = findChoice(choices, value);
  const settingsKey = column.type === "people" ? "people" : "choices";

  useRevealBoardPopover(open && !mobile, ref, editing);

  useEffect(() => {
    if (!open || mobile) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        setOpen(false);
        setEditing(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [mobile, open]);

  const closeEditor = () => {
    setOpen(false);
    setEditing(false);
    setSearch("");
  };

  const visibleChoices = choices.filter((choice) =>
    choice.label.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const saveChoices = async (nextChoices: BoardColumnChoice[]) => {
    setWorking(true);
    setError(null);
    try {
      await onUpdateSettings({
        ...column.settings,
        [settingsKey]: nextChoices,
      });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The options could not be saved.",
      );
    } finally {
      setWorking(false);
    }
  };

  const addChoice = async () => {
    const label = newLabel.trim();
    if (!label || working) return;
    const idBase = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const id = `${idBase || "choice"}-${crypto.randomUUID()}`;
    await saveChoices([...choices, { id, label, color: newColor }]);
    setNewLabel("");
  };

  return (
    <div className="sheet-option-cell sheet-custom-choice" ref={ref}>
      <button
        type="button"
        /*
         * Two different problems, so two different answers.
         *
         * EMPTY: no option is selected, so there is no data colour and the
         * chip is pure design — it belongs to the theme and goes through the
         * neutral-chip tokens. The literal pair it replaces (#8a979f on
         * #eef1f3, 2.64:1) was the same in light and dark and failed in both,
         * on 2,229 cells.
         *
         * FILLED: the ground is monday's colour for that label and must not
         * move. Only the label colour is ours to choose, and `chipInk` keeps
         * the stored one whenever it is legible on that exact ground.
         */
        style={
          selected
            ? chipStyle(selected.color, selected.textColor)
            : {
                background: "var(--chip-neutral-bg)",
                color: "var(--chip-neutral-fg)",
              }
        }
        onClick={() => {
          setOpen((current) => !current);
          setEditing(false);
          setSearch("");
        }}
      >
        {selected?.label ?? "—"}
      </button>
      {open && !mobile && !editing && (
        <div className="sheet-option-popover">
          <div className="sheet-option-grid">
            <button
              type="button"
              className="sheet-option-clear"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              Clear value
            </button>
            {choices.map((choice) => (
              <button
                key={choice.id}
                type="button"
                style={chipStyle(choice.color, choice.textColor)}
                onClick={() => {
                  onChange(choice.id);
                  setOpen(false);
                }}
              >
                {choice.label}
              </button>
            ))}
          </div>
          <button
            className="sheet-option-edit"
            type="button"
            onClick={() => setEditing(true)}
          >
            <Icon name="settings" size={15} />
            {column.type === "people" ? "Edit people" : "Edit labels"}
          </button>
        </div>
      )}
      {open && !mobile && editing && (
        <div className="sheet-option-popover sheet-label-editor">
          <header>
            <button type="button" onClick={() => setEditing(false)}>‹</button>
            <strong>
              {column.type === "people" ? "Edit people" : "Edit labels"}
            </strong>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setEditing(false);
              }}
            >
              <Icon name="close" size={15} />
            </button>
          </header>
          <div className="sheet-label-editor__list">
            {choices.map((choice) => (
              <div key={`${choice.id}-${choice.label}-${choice.color}`}>
                <input
                  type="color"
                  aria-label={`Color for ${choice.label}`}
                  value={choice.color}
                  disabled={working}
                  onChange={(event) =>
                    saveChoices(
                      choices.map((item) =>
                        item.id === choice.id
                          ? { ...item, color: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
                <input
                  defaultValue={choice.label}
                  aria-label={`Name for ${choice.label}`}
                  disabled={working}
                  onBlur={(event) => {
                    const label = event.currentTarget.value.trim();
                    if (!label || label === choice.label) return;
                    saveChoices(
                      choices.map((item) =>
                        item.id === choice.id ? { ...item, label } : item,
                      ),
                    );
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
                <button
                  type="button"
                  className="is-danger"
                  disabled={working}
                  title="Delete option"
                  onClick={() =>
                    saveChoices(
                      choices.filter((item) => item.id !== choice.id),
                    )
                  }
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="sheet-label-editor__new">
            <input
              type="color"
              aria-label="New option color"
              value={newColor}
              onChange={(event) => setNewColor(event.target.value)}
            />
            <input
              value={newLabel}
              placeholder="+ New option"
              onChange={(event) => setNewLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addChoice();
              }}
            />
            <button
              type="button"
              disabled={!newLabel.trim() || working}
              onClick={addChoice}
            >
              Add
            </button>
          </div>
          {error && (
            <small className="sheet-label-editor__error">{error}</small>
          )}
        </div>
      )}
      {open && mobile && (
        <MobileCellSheet
          title={editing ? `Edit ${column.title}` : column.title}
          subtitle={
            editing
              ? "Changes are saved to this board"
              : selected
                ? `Current: ${selected.label}`
                : "No value selected"
          }
          onClose={closeEditor}
          className="mobile-choice-sheet"
          footer={
            editing ? (
              <>
                <button type="button" onClick={() => setEditing(false)}>
                  Back
                </button>
                <button className="primary-button" type="button" onClick={closeEditor}>
                  Done
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    onChange("");
                    closeEditor();
                  }}
                >
                  Clear
                </button>
                <button className="primary-button" type="button" onClick={() => setEditing(true)}>
                  {column.type === "people" ? "Manage people" : "Manage labels"}
                </button>
              </>
            )
          }
        >
          {!editing ? (
            <>
              <label className="mobile-sheet-search">
                <Icon name="search" size={17} />
                <input
                  type="search"
                  value={search}
                  placeholder={column.type === "people" ? "Search people" : "Search options"}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <div
                className={`mobile-choice-list${
                  column.type === "people" ? " mobile-choice-list--people" : ""
                }`}
              >
                {visibleChoices.map((choice) => (
                  <button
                    key={choice.id}
                    type="button"
                    className={choice.id === value ? "is-selected" : ""}
                    onClick={() => {
                      onChange(choice.id);
                      closeEditor();
                    }}
                  >
                    <span style={{ background: choice.color }}>
                      {column.type === "people"
                        ? choice.label
                            .split(/\s+/)
                            .slice(0, 2)
                            .map((part) => part[0])
                            .join("")
                            .toUpperCase()
                        : ""}
                    </span>
                    <strong>{choice.label}</strong>
                    {choice.id === value && <Icon name="check" size={18} />}
                  </button>
                ))}
                {!visibleChoices.length && (
                  <p className="mobile-choice-empty">No matching options.</p>
                )}
              </div>
            </>
          ) : (
            <div className="mobile-option-manager">
              <div className="mobile-option-manager__list">
                {choices.map((choice) => (
                  <div key={`${choice.id}-${choice.label}-${choice.color}`}>
                    <input
                      type="color"
                      aria-label={`Color for ${choice.label}`}
                      value={choice.color}
                      disabled={working}
                      onChange={(event) =>
                        void saveChoices(
                          choices.map((item) =>
                            item.id === choice.id
                              ? { ...item, color: event.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                    <input
                      defaultValue={choice.label}
                      aria-label={`Name for ${choice.label}`}
                      disabled={working}
                      onBlur={(event) => {
                        const label = event.currentTarget.value.trim();
                        if (!label || label === choice.label) return;
                        void saveChoices(
                          choices.map((item) =>
                            item.id === choice.id ? { ...item, label } : item,
                          ),
                        );
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                    />
                    <button
                      type="button"
                      aria-label={`Delete ${choice.label}`}
                      disabled={working || choices.length <= 1}
                      onClick={() =>
                        void saveChoices(
                          choices.filter((item) => item.id !== choice.id),
                        )
                      }
                    >
                      <Icon name="close" size={16} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="mobile-option-manager__new">
                <input
                  type="color"
                  aria-label="New option color"
                  value={newColor}
                  onChange={(event) => setNewColor(event.target.value)}
                />
                <input
                  value={newLabel}
                  placeholder={column.type === "people" ? "New person" : "New label"}
                  onChange={(event) => setNewLabel(event.target.value)}
                />
                <button type="button" disabled={!newLabel.trim() || working} onClick={() => void addChoice()}>
                  Add
                </button>
              </div>
              {error && <p className="mobile-sheet-error">{error}</p>}
            </div>
          )}
        </MobileCellSheet>
      )}
    </div>
  );
}
