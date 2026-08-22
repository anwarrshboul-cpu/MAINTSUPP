"use client";

/**
 * Board cell components — the editors rendered inside a board row.
 *
 * Extracted from live-board.tsx (Stage 8, item H1). Each is a leaf component:
 * it receives a value and a change handler and owns no board state, which is
 * what makes the set safe to move together.
 */
import {
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Icon } from "../../components";
import { chipStyle } from "./chip-ink";
import type {
  BoardOptionColumn,
} from "../../lib/types";
import {
  BoardDateIcon,
  BoardDateMetadata,
  Option,
  boardDateIconOptions,
} from "./board-model";
import {
  boardCalendarDays,
  boardCalendarMonth,
  boardCalendarMonthLabel,
  boardDateValue,
  dateInputValue,
  formatBoardTime,
  formatFullBoardDate,
  formatMobileBoardDate,
  parseBoardDateMetadata,
  relativeDayLabel,
  serializeBoardDateMetadata,
  shiftBoardCalendarMonth,
  todayBoardDate,
} from "./board-format";
import {
  MobileBoardContext,
  MobileCellSheet,
  useRevealBoardPopover,
} from "./board-primitives";
export function ItemNameEditor({
  value,
  onSave,
}: {
  value: string;
  onSave: (value: string) => void;
}) {
  const mobile = useContext(MobileBoardContext);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (!next) {
      setDraft(value);
      return;
    }
    if (next !== value) onSave(next);
  };

  const closeMobileEditor = () => {
    if (
      draft.trim() !== value &&
      !window.confirm("Discard the new item name?")
    ) {
      return;
    }
    setDraft(value);
    setEditing(false);
  };

  if (editing && !mobile) {
    return (
      <input
        className="sheet-item-name-input"
        autoFocus
        value={draft}
        aria-label={`Rename item ${value}`}
        maxLength={120}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <>
      <button
        className="sheet-item-name"
        type="button"
        title="Click to rename item"
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
      >
        <strong>{value}</strong>
      </button>
      {editing && mobile && (
        <MobileCellSheet
          title="Rename item"
          subtitle="Edit the item name"
          onClose={closeMobileEditor}
          className="mobile-text-sheet"
          footer={
            <>
              <button type="button" onClick={closeMobileEditor}>
                Cancel
              </button>
              <button className="primary-button" type="button" onClick={commit}>
                Save name
              </button>
            </>
          }
        >
          <label className="mobile-text-editor">
            <span>Item name</span>
            <input
              value={draft}
              maxLength={120}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commit();
              }}
            />
          </label>
        </MobileCellSheet>
      )}
    </>
  );
}

export function OptionCell({
  title,
  value,
  options,
  onChange,
  columns = 1,
  mobileKind = "labels",
  editableColumn,
  onCreateOption,
  onUpdateOption,
  onDeleteOption,
}: {
  title: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  columns?: number;
  mobileKind?: "labels" | "people";
  editableColumn?: BoardOptionColumn;
  onCreateOption?: (
    columnKey: BoardOptionColumn,
    label: string,
    color: string,
  ) => Promise<void>;
  onUpdateOption?: (
    optionId: string,
    changes: { label?: string; color?: string; active?: boolean },
  ) => Promise<void>;
  onDeleteOption?: (optionId: string) => Promise<void>;
}) {
  const mobile = useContext(MobileBoardContext);
  const [open, setOpen] = useState(false);
  const [editingLabels, setEditingLabels] = useState(false);
  const [search, setSearch] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newColor, setNewColor] = useState("#579bfc");
  const [working, setWorking] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const selected =
    options.find((option) => option.value === value) ??
    (value
      ? { value, color: "#a9b4bb", text: "#ffffff" }
      : { value: "", label: "—", color: "#d0d3d5", text: "#ffffff" });

  useRevealBoardPopover(open && !mobile, ref, editingLabels);

  useEffect(() => {
    if (!open || mobile) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        setOpen(false);
        setEditingLabels(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [mobile, open]);

  const closeEditor = () => {
    setOpen(false);
    setEditingLabels(false);
    setSearch("");
  };

  const visibleOptions = options.filter(
    (option) =>
      (option.active !== false || option.value === value) &&
      (option.label ?? option.value)
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );

  const runChange = async (
    key: string,
    action: () => Promise<void>,
  ) => {
    setWorking(key);
    setEditorError(null);
    try {
      await action();
    } catch (caught) {
      setEditorError(
        caught instanceof Error ? caught.message : "The label could not be saved.",
      );
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="sheet-option-cell" ref={ref}>
      <button
        type="button"
        /*
         * An empty cell has no data colour, so it is design and takes the
         * theme's neutral chip. Anything with a value keeps monday's ground and
         * gets a label colour measured against it — white was hard-coded here,
         * which is 2.21:1 on the green "Done" and 1.90:1 on the amber "Working
         * on it".
         */
        style={
          selected.value
            ? chipStyle(selected.color, selected.text)
            : {
                background: "var(--chip-neutral-bg)",
                color: "var(--chip-neutral-fg)",
              }
        }
        onClick={() => {
          if (open) {
            setOpen(false);
            setEditingLabels(false);
          } else {
            setOpen(true);
            setSearch("");
          }
        }}
        title={selected.label ?? selected.value}
      >
        {selected.label ?? selected.value}
      </button>
      {open && !mobile && !editingLabels && (
        <div
          className={`sheet-option-popover${
            columns > 1 ? " sheet-option-popover--wide" : ""
          }`}
          style={{ "--option-columns": columns } as CSSProperties}
        >
          <div className="sheet-option-grid">
            {options
              .filter((option) => option.active !== false || option.value === value)
              .map((option) => (
              <button
                key={option.value || "empty"}
                type="button"
                style={chipStyle(option.color, option.text)}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                {option.label ?? option.value}
              </button>
              ))}
          </div>
          {editableColumn && (
            <button
              className="sheet-option-edit"
              type="button"
              onClick={() => setEditingLabels(true)}
            >
              <Icon name="settings" size={15} />
              Edit labels
            </button>
          )}
        </div>
      )}
      {open && !mobile && editingLabels && editableColumn && (
        <div className="sheet-option-popover sheet-label-editor">
          <header>
            <button type="button" onClick={() => setEditingLabels(false)}>
              ‹
            </button>
            <strong>Edit labels</strong>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setEditingLabels(false);
              }}
            >
              <Icon name="close" size={15} />
            </button>
          </header>
          <div className="sheet-label-editor__list">
            {options.map((option) => (
              <div
                className={option.active === false ? "is-inactive" : ""}
                key={`${option.id ?? option.value}-${option.label}-${option.color}-${option.active}`}
              >
                <input
                  type="color"
                  aria-label={`Color for ${option.label ?? option.value}`}
                  value={option.color}
                  disabled={!option.id || working === option.id}
                  onChange={(event) => {
                    if (!option.id || !onUpdateOption) return;
                    runChange(option.id, () =>
                      onUpdateOption(option.id!, { color: event.target.value }),
                    );
                  }}
                />
                <input
                  defaultValue={option.label ?? option.value}
                  aria-label={`Label name for ${option.label ?? option.value}`}
                  disabled={!option.id || working === option.id}
                  onBlur={(event) => {
                    const label = event.currentTarget.value.trim();
                    if (
                      !option.id ||
                      !onUpdateOption ||
                      !label ||
                      label === (option.label ?? option.value)
                    ) return;
                    runChange(option.id, () =>
                      onUpdateOption(option.id!, { label }),
                    );
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
                <button
                  type="button"
                  disabled={!option.id || working === option.id}
                  title={option.active === false ? "Activate label" : "Deactivate label"}
                  onClick={() => {
                    if (!option.id || !onUpdateOption) return;
                    runChange(option.id, () =>
                      onUpdateOption(option.id!, { active: option.active === false }),
                    );
                  }}
                >
                  {option.active === false ? "On" : "Off"}
                </button>
                <button
                  type="button"
                  className="is-danger"
                  disabled={!option.id || option.system || working === option.id}
                  title={option.system ? "Default labels can be deactivated" : "Delete label"}
                  onClick={() => {
                    if (!option.id || !onDeleteOption) return;
                    runChange(option.id, () => onDeleteOption(option.id!));
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="sheet-label-editor__new">
            <input
              type="color"
              aria-label="New label color"
              value={newColor}
              onChange={(event) => setNewColor(event.target.value)}
            />
            <input
              value={newLabel}
              placeholder="+ New label"
              onChange={(event) => setNewLabel(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  newLabel.trim() &&
                  onCreateOption
                ) {
                  runChange("new", async () => {
                    await onCreateOption(editableColumn, newLabel.trim(), newColor);
                    setNewLabel("");
                  });
                }
              }}
            />
            <button
              type="button"
              disabled={!newLabel.trim() || working === "new"}
              onClick={() => {
                if (!onCreateOption) return;
                runChange("new", async () => {
                  await onCreateOption(editableColumn, newLabel.trim(), newColor);
                  setNewLabel("");
                });
              }}
            >
              Add
            </button>
          </div>
          {editorError && <small className="sheet-label-editor__error">{editorError}</small>}
        </div>
      )}
      {open && mobile && (
        <MobileCellSheet
          title={editingLabels ? `Edit ${title}` : title}
          subtitle={
            editingLabels
              ? "Manage the options available on this board"
              : value
                ? `Current: ${selected.label ?? selected.value}`
                : "No value selected"
          }
          onClose={closeEditor}
          className="mobile-choice-sheet"
          footer={
            editingLabels ? (
              <>
                <button type="button" onClick={() => setEditingLabels(false)}>
                  Back
                </button>
                <button className="primary-button" type="button" onClick={closeEditor}>
                  Done
                </button>
              </>
            ) : editableColumn ? (
              <button className="primary-button mobile-sheet-wide-action" type="button" onClick={() => setEditingLabels(true)}>
                <Icon name="settings" size={16} />
                Edit options
              </button>
            ) : undefined
          }
        >
          {!editingLabels ? (
            <>
              <label className="mobile-sheet-search">
                <Icon name="search" size={17} />
                <input
                  type="search"
                  value={search}
                  placeholder={mobileKind === "people" ? "Search people" : "Search options"}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <div className={`mobile-choice-list mobile-choice-list--${mobileKind}`}>
                {visibleOptions.map((option) => (
                  <button
                    key={option.value || "empty"}
                    type="button"
                    className={option.value === value ? "is-selected" : ""}
                    onClick={() => {
                      onChange(option.value);
                      closeEditor();
                    }}
                  >
                    <span style={{ background: option.color }}>
                      {mobileKind === "people" && option.value
                        ? option.value
                            .split(/\s+/)
                            .slice(0, 2)
                            .map((part) => part[0])
                            .join("")
                            .toUpperCase()
                        : ""}
                    </span>
                    <strong>{option.label ?? option.value}</strong>
                    {option.value === value && <Icon name="check" size={18} />}
                  </button>
                ))}
                {!visibleOptions.length && (
                  <p className="mobile-choice-empty">No matching options.</p>
                )}
              </div>
            </>
          ) : editableColumn ? (
            <div className="mobile-option-manager">
              <div className="mobile-option-manager__list">
                {options.map((option) => (
                  <div
                    className={option.active === false ? "is-inactive" : ""}
                    key={`${option.id ?? option.value}-${option.label}-${option.color}-${option.active}`}
                  >
                    <input
                      type="color"
                      aria-label={`Color for ${option.label ?? option.value}`}
                      value={option.color}
                      disabled={!option.id || working === option.id}
                      onChange={(event) => {
                        if (!option.id || !onUpdateOption) return;
                        void runChange(option.id, () =>
                          onUpdateOption(option.id!, { color: event.target.value }),
                        );
                      }}
                    />
                    <input
                      defaultValue={option.label ?? option.value}
                      aria-label={`Label name for ${option.label ?? option.value}`}
                      disabled={!option.id || working === option.id}
                      onBlur={(event) => {
                        const label = event.currentTarget.value.trim();
                        if (!option.id || !onUpdateOption || !label || label === (option.label ?? option.value)) return;
                        void runChange(option.id, () => onUpdateOption(option.id!, { label }));
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                    />
                    <button
                      type="button"
                      disabled={!option.id || working === option.id}
                      aria-label={option.active === false ? `Activate ${option.label ?? option.value}` : `Deactivate ${option.label ?? option.value}`}
                      onClick={() => {
                        if (!option.id || !onUpdateOption) return;
                        void runChange(option.id, () =>
                          onUpdateOption(option.id!, { active: option.active === false }),
                        );
                      }}
                    >
                      {option.active === false ? "On" : "Off"}
                    </button>
                    <button
                      type="button"
                      className="is-danger"
                      disabled={!option.id || option.system || working === option.id}
                      aria-label={`Delete ${option.label ?? option.value}`}
                      onClick={() => {
                        if (!option.id || !onDeleteOption) return;
                        void runChange(option.id, () => onDeleteOption(option.id!));
                      }}
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
                  placeholder="New option"
                  onChange={(event) => setNewLabel(event.target.value)}
                />
                <button
                  type="button"
                  disabled={!newLabel.trim() || working === "new"}
                  onClick={() => {
                    if (!onCreateOption) return;
                    void runChange("new", async () => {
                      await onCreateOption(editableColumn, newLabel.trim(), newColor);
                      setNewLabel("");
                    });
                  }}
                >
                  Add
                </button>
              </div>
              {editorError && <p className="mobile-sheet-error">{editorError}</p>}
            </div>
          ) : null}
        </MobileCellSheet>
      )}
    </div>
  );
}

export function InlineTextCell({
  title,
  value,
  onSave,
  emptyLabel = "Add value",
  inputMode,
  multiline = false,
}: {
  title: string;
  value: string;
  onSave: (value: string) => void;
  emptyLabel?: string;
  inputMode?: "text" | "decimal" | "email" | "tel" | "url";
  multiline?: boolean;
}) {
  const mobile = useContext(MobileBoardContext);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next !== value) onSave(next);
  };

  const closeMobileEditor = () => {
    if (
      draft.trim() !== value &&
      !window.confirm("Discard the unsaved change in this cell?")
    ) {
      return;
    }
    setDraft(value);
    setEditing(false);
  };

  if (editing && !mobile) {
    return (
      <input
        className="sheet-inline-input"
        autoFocus
        value={draft}
        inputMode={inputMode}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <>
      <button
        className={`sheet-inline-value${value ? "" : " is-empty"}`}
        type="button"
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        title={value || emptyLabel}
      >
        {value || emptyLabel}
      </button>
      {editing && mobile && (
        <MobileCellSheet
          title={title}
          subtitle="Edit this value"
          onClose={closeMobileEditor}
          className="mobile-text-sheet"
          footer={
            <>
              <button type="button" onClick={closeMobileEditor}>
                Cancel
              </button>
              <button className="primary-button" type="button" onClick={commit}>
                Save
              </button>
            </>
          }
        >
          <label className="mobile-text-editor">
            <span>{title}</span>
            {multiline ? (
              <textarea
                rows={7}
                value={draft}
                placeholder={emptyLabel}
                onChange={(event) => setDraft(event.target.value)}
              />
            ) : (
              <input
                value={draft}
                inputMode={inputMode}
                placeholder={emptyLabel}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commit();
                }}
              />
            )}
          </label>
        </MobileCellSheet>
      )}
    </>
  );
}

export function DateStatusIcon({
  value,
  compact = false,
}: {
  value: BoardDateIcon;
  compact?: boolean;
}) {
  const option = boardDateIconOptions.find((item) => item.id === value);
  if (!option) return null;
  return (
    <span
      className={`board-date-status-icon${compact ? " is-compact" : ""}`}
      style={{ color: option.color }}
      title={option.label}
      aria-label={option.label}
    >
      {option.icon ? (
        <Icon name={option.icon} size={compact ? 15 : 22} />
      ) : (
        <b aria-hidden="true">{option.glyph}</b>
      )}
    </span>
  );
}

export function MobileBoardCalendar({
  month,
  onMonthChange,
  onSelect,
  selectedStart,
  selectedEnd,
  mode,
  weekStartsOn,
  yearFirst = false,
}: {
  month: string;
  onMonthChange: (value: string) => void;
  onSelect: (value: string) => void;
  selectedStart?: string;
  selectedEnd?: string;
  mode: "single" | "range";
  weekStartsOn: 0 | 1;
  yearFirst?: boolean;
}) {
  const weekdays =
    weekStartsOn === 1
      ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
      : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = boardCalendarDays(month, weekStartsOn);
  const today = todayBoardDate();

  return (
    <div
      className={`mobile-board-calendar mobile-board-calendar--${mode}`}
      aria-label={boardCalendarMonthLabel(month)}
    >
      <div className="mobile-board-calendar__month">
        <strong>{boardCalendarMonthLabel(month, yearFirst)}</strong>
        <span>
          <button
            className="is-previous"
            type="button"
            aria-label="Previous month"
            onClick={() => onMonthChange(shiftBoardCalendarMonth(month, -1))}
          >
            <Icon name="chevron" size={22} />
          </button>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => onMonthChange(shiftBoardCalendarMonth(month, 1))}
          >
            <Icon name="chevron" size={22} />
          </button>
        </span>
      </div>
      <div className="mobile-board-calendar__weekdays" aria-hidden="true">
        {weekdays.map((weekday) => (
          <span key={weekday}>{weekday}</span>
        ))}
      </div>
      <div className="mobile-board-calendar__days">
        {days.map((date, index) => {
          if (!date) {
            return <span key={`empty-${index}`} aria-hidden="true" />;
          }
          const isStart = date === selectedStart;
          const isEnd = mode === "range" && date === selectedEnd;
          const inRange = Boolean(
            mode === "range" &&
              selectedStart &&
              selectedEnd &&
              date >= selectedStart &&
              date <= selectedEnd,
          );
          const classNames = [
            isStart ? "is-range-start" : "",
            isEnd ? "is-range-end" : "",
            inRange ? "is-in-range" : "",
            mode === "single" && isStart ? "is-selected" : "",
            date === today ? "is-today" : "",
            index % 7 === 0 ? "is-week-start" : "",
            index % 7 === 6 ? "is-week-end" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={date}
              className={classNames}
              type="button"
              aria-label={formatFullBoardDate(date)}
              aria-pressed={isStart || isEnd}
              onClick={() => onSelect(date)}
            >
              <span>{Number(date.slice(8))}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function DateCell({
  title,
  clearable = true,
  value,
  metadataValue,
  onSave,
}: {
  title: string;
  clearable?: boolean;
  value: string | null | undefined;
  metadataValue?: string | null;
  onSave: (value: string | null, metadataValue: string) => void;
}) {
  const mobile = useContext(MobileBoardContext);
  const currentDate = dateInputValue(value);
  const currentMetadata = parseBoardDateMetadata(
    metadataValue ?? value,
    currentDate,
  );
  const [open, setOpen] = useState(false);
  const [draftDate, setDraftDate] = useState(currentMetadata.date);
  const [draftTime, setDraftTime] = useState(currentMetadata.time);
  const [draftIcon, setDraftIcon] = useState<BoardDateIcon | "">(
    currentMetadata.icon,
  );
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(
    boardCalendarMonth(currentMetadata.date),
  );
  const timeInputRef = useRef<HTMLInputElement>(null);

  const openEditor = () => {
    const next = parseBoardDateMetadata(metadataValue ?? value, currentDate);
    /*
     * The DATE comes from `value` — the field, or the cell on a workspace
     * column — and the time and marker from the metadata beside it.
     *
     * `next.date` would be the same thing on a workspace column, where the
     * metadata IS the value. On a system column it can be a date left in an old
     * decoration cell, and opening the picker on a day the board is not showing
     * is how somebody saves the wrong one. Decorations written from here carry
     * no date at all; this is what makes the ones written before that harmless.
     */
    setDraftDate(currentDate || next.date);
    setDraftTime(next.time);
    setDraftIcon(next.icon);
    setIconPickerOpen(false);
    setCalendarMonth(boardCalendarMonth(currentDate || next.date));
    setOpen(true);
  };

  const saveDraft = () => {
    if (!draftDate) {
      if (clearable) {
        onSave(null, "");
        setOpen(false);
      }
      return;
    }
    const metadata = {
      date: draftDate,
      time: draftTime,
      icon: draftIcon,
    } satisfies BoardDateMetadata;
    onSave(boardDateValue(metadata), serializeBoardDateMetadata(metadata));
    setOpen(false);
  };

  const showTimePicker = () => {
    const input = timeInputRef.current;
    if (!input) return;
    try {
      input.showPicker();
    } catch {
      input.focus();
      input.click();
    }
  };

  if (mobile) {
    return (
      <>
        <button
          className={`sheet-date-button${currentDate ? "" : " is-empty"}`}
          type="button"
          aria-label={`Edit ${title}: ${formatMobileBoardDate(value, metadataValue)}`}
          onClick={openEditor}
        >
          <span>{formatMobileBoardDate(value, metadataValue)}</span>
          {currentMetadata.icon && (
            <DateStatusIcon value={currentMetadata.icon} compact />
          )}
        </button>
        {open && (
          <MobileCellSheet
            title={title}
            onClose={() => setOpen(false)}
            className="mobile-date-sheet"
            closeFirst
            headerAction={
              <button
                className="primary-button mobile-date-sheet__save"
                type="button"
                disabled={!draftDate && !clearable}
                onClick={saveDraft}
              >
                Save
              </button>
            }
          >
            <div className="mobile-date-sheet__options">
              <div className="mobile-date-sheet__chips">
                <div className="mobile-date-sheet__chip is-date">
                  <button
                    type="button"
                    onClick={() =>
                      setCalendarMonth(boardCalendarMonth(draftDate))
                    }
                  >
                    {draftIcon && (
                      <DateStatusIcon value={draftIcon} compact />
                    )}
                    <span>
                      {draftDate
                        ? `Date: ${formatFullBoardDate(draftDate)}`
                        : "Date"}
                    </span>
                  </button>
                  {clearable && draftDate && (
                    <button
                      className="mobile-date-sheet__chip-clear"
                      type="button"
                      aria-label="Clear date"
                      onClick={() => setDraftDate("")}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  )}
                </div>

                <button
                  className="mobile-date-sheet__chip"
                  type="button"
                  onClick={() => {
                    if (draftTime) setDraftTime("");
                    else showTimePicker();
                  }}
                >
                  {draftTime ? formatBoardTime(draftTime) : "Add time"}
                </button>

                <button
                  className="mobile-date-sheet__chip"
                  type="button"
                  aria-expanded={iconPickerOpen}
                  onClick={() => setIconPickerOpen((current) => !current)}
                >
                  {draftIcon ? (
                    <>
                      <DateStatusIcon value={draftIcon} compact />
                      <span>Icon</span>
                    </>
                  ) : (
                    "Add icon"
                  )}
                </button>
                <input
                  ref={timeInputRef}
                  className="mobile-date-sheet__native-picker"
                  type="time"
                  value={draftTime}
                  aria-label="Choose time"
                  onChange={(event) => setDraftTime(event.target.value)}
                />
              </div>

              {iconPickerOpen && (
                <div className="mobile-date-icon-picker" role="listbox" aria-label="Date icon">
                  {boardDateIconOptions.map((option) => (
                    <button
                      key={option.id}
                      className={draftIcon === option.id ? "is-selected" : ""}
                      type="button"
                      role="option"
                      aria-label={option.label}
                      aria-selected={draftIcon === option.id}
                      onClick={() =>
                        setDraftIcon((current) =>
                          current === option.id ? "" : option.id,
                        )
                      }
                    >
                      <DateStatusIcon value={option.id} />
                    </button>
                  ))}
                </div>
              )}
              <MobileBoardCalendar
                month={calendarMonth}
                mode="single"
                weekStartsOn={1}
                yearFirst
                selectedStart={draftDate}
                onMonthChange={setCalendarMonth}
                onSelect={setDraftDate}
              />
            </div>
          </MobileCellSheet>
        )}
      </>
    );
  }

  /*
   * The date, and how far away it is.
   *
   * A bare `<input type="date">` renders "12/03/2026" and leaves the reader to
   * work out whether that has happened. `relativeDayLabel` answers it for the
   * fortnight either side and returns null beyond that, where the date is the
   * better answer anyway — so a distant date is unchanged and today's job says
   * so. The input is untouched: same class, same change handler, same saves.
   */
  const relative = relativeDayLabel(currentDate, new Date());

  return (
    <span className="sheet-date">
      <input
        className="sheet-date-input"
        type="date"
        /*
         * The column name IS the label. Without it every date box on the board
         * is an unnamed form control — 36 of them on the jobs board alone, and
         * axe rates that critical: a screen reader announces "date entry, blank"
         * thirty-six times with nothing to tell them apart. The mobile branch
         * above already names itself this way.
         */
        aria-label={title}
        value={currentDate}
        onChange={(event) => {
          const date = event.target.value;
          if (!date) {
            onSave(null, "");
            return;
          }
          const metadata = { ...currentMetadata, date };
          onSave(boardDateValue(metadata), serializeBoardDateMetadata(metadata));
        }}
      />
      {/* aria-hidden: the input already announces its own value, and a screen
          reader does not need "12 March 2026, In 3 days". */}
      {relative && (
        <span className="sheet-date__relative" aria-hidden="true">
          {relative}
        </span>
      )}
    </span>
  );
}

export function TimelineCell({
  title,
  preserveStartOnClear = false,
  start,
  end,
  onSave,
}: {
  title: string;
  preserveStartOnClear?: boolean;
  start: string | null | undefined;
  end: string | null | undefined;
  onSave: (start: string | null, end: string | null) => void;
}) {
  const mobile = useContext(MobileBoardContext);
  const [open, setOpen] = useState(false);
  const [draftStart, setDraftStart] = useState(dateInputValue(start));
  const [draftEnd, setDraftEnd] = useState(dateInputValue(end));
  const [calendarMonth, setCalendarMonth] = useState(
    boardCalendarMonth(start || end),
  );
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useRevealBoardPopover(open && !mobile, ref);

  useEffect(() => {
    if (!open || mobile) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [mobile, open]);

  const label =
    draftStart && draftEnd
      ? `${draftStart.slice(5)} → ${draftEnd.slice(5)}`
      : draftStart || draftEnd || "Set dates";

  const saveTimeline = () => {
    const endToSave = mobile && draftStart && !draftEnd ? draftStart : draftEnd;
    if (draftStart && endToSave && endToSave < draftStart) {
      setError("The end date must be on or after the start date.");
      return;
    }
    onSave(draftStart || null, endToSave || null);
    setError(null);
    setOpen(false);
  };

  const selectTimelineDate = (date: string) => {
    if (!draftStart || draftEnd) {
      setDraftStart(date);
      setDraftEnd("");
    } else if (date < draftStart) {
      setDraftEnd(draftStart);
      setDraftStart(date);
    } else {
      setDraftEnd(date);
    }
    setError(null);
  };

  return (
    <div className="sheet-timeline" ref={ref}>
      <button
        type="button"
        onClick={() => {
          const nextStart = dateInputValue(start);
          const nextEnd = dateInputValue(end);
          setDraftStart(nextStart);
          setDraftEnd(nextEnd);
          setCalendarMonth(boardCalendarMonth(nextStart || nextEnd));
          setError(null);
          setOpen((current) => !current);
        }}
      >
        <span>{label}</span>
      </button>
      {open && !mobile && (
        <div className="sheet-timeline-popover">
          <strong>Set timeline</strong>
          <label>
            Start date
            <input
              type="date"
              value={draftStart}
              onChange={(event) => setDraftStart(event.target.value)}
            />
          </label>
          <label>
            End date
            <input
              type="date"
              value={draftEnd}
              onChange={(event) => setDraftEnd(event.target.value)}
            />
          </label>
          <button
            className="primary-button"
            type="button"
            onClick={saveTimeline}
          >
            Save dates
          </button>
          {error && <small className="mobile-sheet-error">{error}</small>}
        </div>
      )}
      {open && mobile && (
        <MobileCellSheet
          title={title}
          onClose={() => setOpen(false)}
          className="mobile-date-sheet mobile-timeline-sheet"
          closeFirst
          headerAction={
            <button
              className="primary-button mobile-date-sheet__save"
              type="button"
              onClick={saveTimeline}
            >
              Save
            </button>
          }
        >
          <div className="mobile-timeline-calendar">
            <button
              className="mobile-timeline-calendar__clear"
              type="button"
              onClick={() => {
                const nextStart = preserveStartOnClear
                  ? dateInputValue(start)
                  : "";
                setDraftStart(nextStart);
                setDraftEnd("");
                setCalendarMonth(boardCalendarMonth(nextStart));
                setError(null);
              }}
            >
              Clear
            </button>
            <MobileBoardCalendar
              month={calendarMonth}
              mode="range"
              weekStartsOn={0}
              selectedStart={draftStart}
              selectedEnd={draftEnd}
              onMonthChange={setCalendarMonth}
              onSelect={selectTimelineDate}
            />
            {error && <p className="mobile-sheet-error">{error}</p>}
          </div>
        </MobileCellSheet>
      )}
    </div>
  );
}
