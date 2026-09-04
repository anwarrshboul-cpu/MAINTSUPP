"use client";

/**
 * W11 — ADDING AND ADJUSTING A CALENDAR ITEM BY HAND.
 *
 * "We must also be able to add and adjust additional calendar items manually."
 * This is that form: a title, one date or a range, an optional site and an
 * optional note, plus Archive and Remove on an item that already exists.
 *
 * ── WHY A DIALOG AND NOT AN INLINE EDITOR ────────────────────────────────
 *
 * Same reasoning `CalendarDateDialog` next door already carries, and it is
 * stronger here because this form CREATES a record rather than moving one: it
 * names what it is about to write, it cannot be dismissed by a stray click on
 * the grid behind it, and it is the whole answer for somebody on a keyboard, a
 * screen reader or a phone. Drag is the convenience; this is the method.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────
 *
 * NO TIME OF DAY. `calendar_events.all_day` defaults to 1 and nothing on this
 * calendar renders a time — `event.time` is "" for every event the product can
 * produce, and the reasoning is written at length beside `calendarTimeOfDay`.
 * A time field here would be a value a person typed that no surface shows.
 *
 * NO STATUS, NO PRIORITY, NO ASSIGNEE. Every one of those would make a manual
 * item look more like a job, which is the single thing this feature must not
 * do. A note is a note.
 *
 * NO HARD DELETE. "Remove" is the route's soft delete; the row keeps its dates
 * and its note and `restoreManualEvent` brings it back. Nothing in this product
 * hard-deletes something a person typed.
 */

import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../components";
import type { ManualCalendarItem } from "./calendar-model";
import type { ManualEventDraft } from "./manual-event-client";
import "./manual-event-dialog.css";

export type ManualEventSite = { id: string; name: string };

export function ManualEventDialog({
  item,
  defaultDay,
  sites,
  onCancel,
  onSave,
  onArchive,
  onDelete,
}: {
  /** The item being edited, or null when this is a new one. */
  item: ManualCalendarItem | null;
  /** The day the reader was looking at. A new item starts there. */
  defaultDay: string;
  sites: ManualEventSite[];
  onCancel: () => void;
  onSave: (draft: ManualEventDraft) => Promise<void>;
  onArchive: (archived: boolean) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const titleId = useId();
  const [title, setTitle] = useState(item?.title ?? "");
  const [startsOn, setStartsOn] = useState(item?.startsOn ?? defaultDay);
  /*
   * A RANGE IS OPT-IN. The end box is empty for a single-day item, because the
   * column's meaning is "NULL is one day" and pre-filling it with the start
   * would make every item look like a range the reader had chosen.
   */
  const [endsOn, setEndsOn] = useState(item?.endsOn ?? "");
  const [siteId, setSiteId] = useState(item?.siteId ?? "");
  const [notes, setNotes] = useState(item?.notes ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  /*
   * Focus lands on the title, not on the dialog. A modal that focuses its own
   * container makes a screen reader announce the heading and then say nothing
   * about what to do; the first field is the answer to "what now".
   */
  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    setError("");
    try {
      await work();
    } catch (caught) {
      /* The server's own sentence — see `ManualEventError`. */
      setError(
        caught instanceof Error ? caught.message : "That change could not be saved.",
      );
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run("save", async () => {
      const trimmed = title.trim();
      if (!trimmed) {
        /*
         * Refused here as well as by the route. Not duplication for its own
         * sake: a round trip to be told the obvious is a round trip, and the
         * route still refuses it because a browser is not a validator.
         */
        throw new Error("A title is required.");
      }
      if (!startsOn) throw new Error("A start date is required.");
      if (endsOn && endsOn < startsOn) {
        throw new Error("The end date cannot be before the start date.");
      }
      await onSave({
        title: trimmed,
        startsOn,
        /* "" is not a date and must not be sent as one. `null` is the route's
           spelling of "no end date", and it is what clears an existing one. */
        endsOn: endsOn || null,
        siteId: siteId || null,
        notes: notes.trim() || null,
      });
    });

  return (
    <div
      className="manual-event-dialog__scrim"
      role="presentation"
      onKeyDown={(pressed) => {
        if (pressed.key === "Escape") onCancel();
      }}
    >
      <div
        className="manual-event-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId}>{item ? "Edit calendar item" : "Add a calendar item"}</h2>
        <p className="manual-event-dialog__lede">
          {/*
            The sentence says what this record IS, because the one confusion
            worth pre-empting is that this creates work. It does not.
          */}
          A note on the operations calendar. It is not a job, and nothing counts
          it as one.
        </p>

        <label className="manual-event-dialog__field">
          <span>Title</span>
          <input
            ref={firstFieldRef}
            type="text"
            maxLength={160}
            value={title}
            onChange={(changed) => setTitle(changed.target.value)}
            placeholder="Area manager visit"
          />
        </label>

        <div className="manual-event-dialog__dates">
          <label className="manual-event-dialog__field">
            <span>Date</span>
            <input
              type="date"
              value={startsOn}
              onChange={(changed) => setStartsOn(changed.target.value)}
            />
          </label>
          <label className="manual-event-dialog__field">
            <span>Ends (optional)</span>
            <input
              type="date"
              value={endsOn}
              min={startsOn || undefined}
              onChange={(changed) => setEndsOn(changed.target.value)}
            />
          </label>
        </div>

        <label className="manual-event-dialog__field">
          <span>Site (optional)</span>
          <select value={siteId} onChange={(changed) => setSiteId(changed.target.value)}>
            {/* An item need not be about a site, so "no site" is a real choice
                and the first one, not an empty row somebody has to notice. */}
            <option value="">No site</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
        </label>

        <label className="manual-event-dialog__field">
          <span>Notes (optional)</span>
          <textarea
            rows={3}
            maxLength={2000}
            value={notes}
            onChange={(changed) => setNotes(changed.target.value)}
          />
        </label>

        {error ? (
          <p className="manual-event-dialog__error" role="alert">
            <Icon name="alert" size={15} />
            <span>{error}</span>
          </p>
        ) : null}

        <div className="manual-event-dialog__actions">
          {item ? (
            <div className="manual-event-dialog__destructive">
              {/*
                ARCHIVE AND REMOVE ARE BOTH OFFERED, because they are different
                intentions: a past item somebody wants off the calendar, and a
                mistake. Offering only one makes the other destructive.
              */}
              <button
                type="button"
                className="secondary-button"
                disabled={busy !== null}
                onClick={() => run("archive", () => onArchive(!item.archived))}
              >
                {item.archived ? "Restore to calendar" : "Archive"}
              </button>
              {confirmingDelete ? (
                <button
                  type="button"
                  className="secondary-button manual-event-dialog__confirm"
                  disabled={busy !== null}
                  onClick={() => run("delete", onDelete)}
                >
                  {busy === "delete" ? "Removing…" : "Yes, remove it"}
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary-button manual-event-dialog__danger"
                  disabled={busy !== null}
                  onClick={() => setConfirmingDelete(true)}
                >
                  Remove
                </button>
              )}
            </div>
          ) : (
            <span />
          )}
          <div className="manual-event-dialog__confirmations">
            <button type="button" className="secondary-button" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={busy !== null || !title.trim() || !startsOn}
              onClick={save}
            >
              {busy === "save" ? "Saving…" : item ? "Save item" : "Add item"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
