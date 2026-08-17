"use client";

/**
 * The column settings modal, and the verb its menu entry uses.
 *
 * Lifted out of `live-board.tsx` whole — not rewritten. That file sat two lines
 * under the 6,000-line ceiling `tests/stage-eight-board-split.test.mjs`
 * enforces, which meant the next person to touch it could not add a line
 * without first doing a split like this one. Deferring off-screen groups
 * needed six.
 *
 * This is the piece that came out because it is genuinely separate: a modal
 * that takes a column, edits its title, width and choice list, and hands the
 * result back through `onSave`. Both functions were already top level and
 * closed over nothing in the board, so the move changes no behaviour — and the
 * modal grows on its own schedule, once per column type the board learns to
 * edit, which is the same reason the view pane left `board-chrome.tsx`.
 */

import { useEffect, useState } from "react";
import { Icon } from "../../components";
import { choiceList } from "./board-format";
import { columnTypeDefinitions, groupColors } from "./board-model";
import type {
  BoardColumnChoice,
  BoardColumnSettings,
  BoardColumnType,
  MaintenanceBoardColumn,
} from "../../lib/types";

export function columnSettingsActionLabel(type: BoardColumnType) {
  if (type === "status" || type === "dropdown") return "Edit labels";
  if (type === "people") return "Edit people";
  if (type === "date") return "Date settings";
  if (type === "timeline") return "Timeline settings";
  if (type === "number") return "Number settings";
  if (type === "files") return "File settings";
  if (type === "checkbox") return "Checkbox settings";
  if (type === "long_text") return "Long text settings";
  if (type === "email") return "Email settings";
  if (type === "phone") return "Phone settings";
  if (type === "link") return "Link settings";
  return "Text settings";
}

export function ColumnSettingsDialog({
  column,
  onClose,
  onSave,
}: {
  column: MaintenanceBoardColumn;
  onClose: () => void;
  onSave: (changes: {
    title?: string;
    settings?: BoardColumnSettings;
    width?: number;
  }) => Promise<void>;
}) {
  const definition =
    columnTypeDefinitions.find((item) => item.type === column.type) ??
    columnTypeDefinitions[2];
  const choiceKey =
    column.type === "people"
      ? "people"
      : column.type === "status" || column.type === "dropdown"
        ? "choices"
        : null;
  const [title, setTitle] = useState(column.title);
  const [width, setWidth] = useState(column.width);
  const [choices, setChoices] = useState<BoardColumnChoice[]>(
    choiceList(column),
  );
  const [newChoice, setNewChoice] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  const addChoice = () => {
    const label = newChoice.trim();
    if (!label) return;
    const idBase = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    setChoices((current) => [
      ...current,
      {
        id: `${idBase || "choice"}-${crypto.randomUUID()}`,
        label,
        color: groupColors[current.length % groupColors.length],
      },
    ]);
    setNewChoice("");
  };

  const submit = async () => {
    const nextTitle = title.trim();
    if (nextTitle.length < 1 || savingSettings) return;
    setSavingSettings(true);
    setError(null);
    try {
      const settings = choiceKey
        ? {
            ...column.settings,
            [choiceKey]: choices,
          }
        : column.settings;
      await onSave({ title: nextTitle, width, settings });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The column settings could not be saved.",
      );
      setSavingSettings(false);
    }
  };

  return (
    <div
      className="column-settings-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={`${column.title} settings`}
    >
      <button
        className="column-settings-dialog__scrim"
        type="button"
        aria-label="Close column settings"
        onClick={onClose}
      />
      <section>
        <header>
          <div>
            <span style={{ background: definition.color }}>
              <Icon name={definition.icon} size={17} />
            </span>
            <div>
              <strong>{columnSettingsActionLabel(column.type)}</strong>
              <small>{definition.description}</small>
            </div>
          </div>
          <button type="button" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="column-settings-dialog__body">
          <label>
            <span>Column name</span>
            <input
              autoFocus
              value={title}
              maxLength={80}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            <span>
              Column width <strong>{width}px</strong>
            </span>
            <input
              type="range"
              min="90"
              max="600"
              step="5"
              value={width}
              onChange={(event) => setWidth(Number(event.target.value))}
            />
          </label>
          {choiceKey ? (
            <div className="column-settings-dialog__choices">
              <span>
                {column.type === "people" ? "People" : "Labels"}
                <small>Change the name or colour used in this column.</small>
              </span>
              <div>
                {choices.map((choice) => (
                  <div key={choice.id}>
                    <input
                      type="color"
                      value={choice.color}
                      aria-label={`Color for ${choice.label}`}
                      onChange={(event) =>
                        setChoices((current) =>
                          current.map((item) =>
                            item.id === choice.id
                              ? { ...item, color: event.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                    <input
                      value={choice.label}
                      aria-label={`Name for ${choice.label}`}
                      onChange={(event) =>
                        setChoices((current) =>
                          current.map((item) =>
                            item.id === choice.id
                              ? { ...item, label: event.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                    <button
                      type="button"
                      aria-label={`Delete ${choice.label}`}
                      disabled={choices.length <= 1}
                      onClick={() =>
                        setChoices((current) =>
                          current.filter((item) => item.id !== choice.id),
                        )
                      }
                    >
                      <Icon name="close" size={15} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="column-settings-dialog__add">
                <input
                  value={newChoice}
                  placeholder={
                    column.type === "people" ? "Add a person" : "Add a label"
                  }
                  onChange={(event) => setNewChoice(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addChoice();
                    }
                  }}
                />
                <button
                  type="button"
                  disabled={!newChoice.trim()}
                  onClick={addChoice}
                >
                  <Icon name="plus" size={15} />
                  Add
                </button>
              </div>
            </div>
          ) : (
            <div className="column-settings-dialog__hint">
              <Icon name={definition.icon} size={20} />
              <div>
                <strong>{definition.label} behaviour is active</strong>
                <span>{definition.description}. Adjust the width above to fit the board.</span>
              </div>
            </div>
          )}
          {error && <p className="column-settings-dialog__error">{error}</p>}
        </div>
        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={!title.trim() || savingSettings}
            onClick={submit}
          >
            {savingSettings ? "Saving…" : "Save settings"}
          </button>
        </footer>
      </section>
    </div>
  );
}
