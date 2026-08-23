"use client";

/**
 * The two small settings dialogs behind Board options › Settings: rename
 * the board, and change what it calls an item. Both write through
 * `PATCH /api/board/settings`, which holds `settings.edit`; a caller the
 * route would refuse sees the reason here rather than a form that fails.
 *
 * The form's state sits in `SettingsForm`, mounted only while the dialog is
 * open, so it starts from the current value every time without an effect.
 */

import { useState } from "react";
import { BoardModal } from "./board-modal";

async function patchSettings(boardId: string, changes: Record<string, string>) {
  const response = await fetch("/api/board/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ board: boardId, ...changes }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    board?: { name: string; itemNoun: string };
  };
  if (!response.ok || !payload.board) throw new Error(payload.error || "The change could not be saved.");
  return payload.board;
}

function SettingsForm({
  onClose,
  label,
  hint,
  initial,
  maxLength,
  canEdit,
  onSave,
}: {
  onClose: () => void;
  label: string;
  hint: string;
  initial: string;
  maxLength: number;
  canEdit: boolean | null;
  onSave: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const denied = canEdit === false;

  return (
    <form
      className="ba-modal__body ba-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (denied || !value.trim()) return;
        setBusy(true);
        setError(null);
        void onSave(value.trim())
          .then(onClose)
          .catch((cause) => setError(cause instanceof Error ? cause.message : "The change could not be saved."))
          .finally(() => setBusy(false));
      }}
    >
      <label className="ba-field">
        <span>{label}</span>
        <input
          className="ba-input"
          value={value}
          maxLength={maxLength}
          disabled={denied}
          data-autofocus
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <p className="ba-hint">{hint}</p>
      {denied && (
        <p className="ba-error" role="note">
          Only roles with the settings.edit permission can change this.
        </p>
      )}
      {error && (
        <p className="ba-error" role="alert">
          {error}
        </p>
      )}
      <div className="ba-modal__foot" style={{ padding: 0, border: 0 }}>
        <button type="button" className="ba-btn ba-btn--quiet" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="ba-btn ba-btn--primary" disabled={denied || busy || !value.trim() || value.trim() === initial}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function SettingsDialog({
  open,
  onClose,
  title,
  titleId,
  ...form
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  titleId: string;
  label: string;
  hint: string;
  initial: string;
  maxLength: number;
  canEdit: boolean | null;
  onSave: (value: string) => Promise<void>;
}) {
  return (
    <BoardModal open={open} onClose={onClose} title={title} titleId={titleId} size="sm">
      <SettingsForm onClose={onClose} {...form} />
    </BoardModal>
  );
}

export function RenameBoardDialog({
  open,
  onClose,
  boardId,
  currentName,
  canEdit,
  onRenamed,
}: {
  open: boolean;
  onClose: () => void;
  boardId: string;
  currentName: string;
  canEdit: boolean | null;
  onRenamed: (name: string) => void;
}) {
  return (
    <SettingsDialog
      open={open}
      onClose={onClose}
      title="Rename board"
      titleId="ba-rename-title"
      label="Board name"
      hint="Everyone in the workspace sees this name in the sidebar and the header."
      initial={currentName}
      maxLength={80}
      canEdit={canEdit}
      onSave={async (name) => {
        const board = await patchSettings(boardId, { name });
        onRenamed(board.name);
      }}
    />
  );
}

export function TerminologyDialog({
  open,
  onClose,
  boardId,
  currentNoun,
  canEdit,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  boardId: string;
  currentNoun: string;
  canEdit: boolean | null;
  onChanged: (itemNoun: string) => void;
}) {
  return (
    <SettingsDialog
      open={open}
      onClose={onClose}
      title="Change item terminology"
      titleId="ba-terminology-title"
      label="What an item is called"
      hint='For example "job", "ticket" or "document". Used wherever the board talks about its rows.'
      initial={currentNoun}
      maxLength={30}
      canEdit={canEdit}
      onSave={async (itemNoun) => {
        const board = await patchSettings(boardId, { itemNoun });
        onChanged(board.itemNoun);
      }}
    />
  );
}
