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
import {
  CALENDAR_ITEM_TYPES,
  calendarItemType,
  isKnownCalendarItemType,
  type CalendarItemType,
} from "./calendar-item-types";
import {
  ReminderRows,
  persistReminderDrafts,
  reminderDraftsProblem,
  reminderScopeFor,
  useReminderDrafts,
} from "./reminder-rows";
import { fetchManualEvents } from "./manual-event-client";
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
  /*
   * RESOLVING WITH THE CREATED ITEM IS OPTIONAL, AND IT IS THE FAST PATH.
   *
   * A new record's reminders cannot be written until the record has an id —
   * `/api/reminders` is keyed on `subjectType` + `subjectId` — so this dialog
   * needs to learn the id its save produced. A caller that returns the created
   * item hands it over directly. A caller that returns nothing (which is what
   * `saveManual` on the calendar surface does today) is not left broken: the
   * dialog falls back to identifying the new row by diffing the item list
   * around the save, which is slower and is why the return value is worth
   * having. `Promise<void>` still satisfies this type, so no caller breaks.
   */
  onSave: (draft: ManualEventDraft) => Promise<{ id?: string | null } | void | null>;
  onArchive: (archived: boolean) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const titleId = useId();
  /*
   * STEP ONE IS THE TYPE, and it is a step inside this dialog rather than a
   * popover of its own.
   *
   * The brief asks for a chooser offering Note / Planned visit / Certificate,
   * with "a back arrow to change type before any data is entered". Both of
   * those are what a two-step dialog IS, and building them as a separate
   * anchored surface would have meant a second modal vocabulary, a second
   * focus trap, and an anchor element that the empty-cell trigger does not
   * have. Here the chooser inherits this dialog's Escape handling, its focus
   * management and its keyboard order for nothing.
   *
   * An EXISTING item skips the step: its type is already decided, and being
   * asked to re-pick it before every edit would be a question with one answer.
   * A row saved before this existed carries `'Manual'`, which
   * `isKnownCalendarItemType` reports as unknown — those open on the chooser
   * so the first edit is where they acquire a real type, rather than being
   * silently relabelled behind the reader's back.
   */
  const [chosenType, setChosenType] = useState<CalendarItemType | null>(() =>
    item && isKnownCalendarItemType(item.category) ? calendarItemType(item.category) : null,
  );
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
  const firstChoiceRef = useRef<HTMLButtonElement | null>(null);

  /*
   * THE REMINDERS ON THIS RECORD.
   *
   * The hook is called UNCONDITIONALLY, above the chooser's early return,
   * because that return is inside a component and hooks may not sit behind it
   * — the same discipline the focus effect below is written to. `enabled` is
   * what actually defers the work until a type has been chosen, so nothing is
   * fetched while the reader is still deciding what they are adding.
   *
   * The scope decides the ladder: a Certificate arrives with the 90/60/30/14 +
   * expiry + overdue cascade, a Planned visit with one step the day before,
   * and a Note with nothing, which is what the brief asks for.
   */
  const reminderScope = reminderScopeFor(chosenType?.key ?? "Note");
  const reminders = useReminderDrafts({
    scope: reminderScope,
    subjectId: item?.id ?? null,
    anchorDate: startsOn,
    enabled: chosenType !== null,
  });

  /*
   * Focus lands on the first thing worth doing, and it does so on EVERY STEP.
   *
   * A modal that focuses its own container makes a screen reader announce the
   * heading and then say nothing about what to do; the first control is the
   * answer to "what now" — the first type on the chooser, the title field on
   * the form.
   *
   * `[chosenType]`, NOT `[]`, and that dependency is the whole bug it fixes.
   * With an empty array this ran once at mount, while the chooser was on
   * screen and `firstFieldRef` was still null. Picking a type then unmounted
   * the button holding focus without moving it anywhere, so focus fell to
   * `document.body` — outside the scrim, which is where the Escape handler
   * lives. The dialog became uncloseable by keyboard the moment a type was
   * chosen, and stayed that way until something inside it was clicked.
   */
  useEffect(() => {
    const target = chosenType ? firstFieldRef.current : firstChoiceRef.current;
    target?.focus();
  }, [chosenType]);

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
      /*
       * A MALFORMED RECIPIENT BLOCKS THE SAVE, which the brief asks for in as
       * many words. Checked before anything is written so the record and its
       * cascade never disagree about whether the edit went through — and
       * checked again by the route, because a browser is not a validator.
       */
      const badRecipient = reminderDraftsProblem(reminders.rows);
      if (badRecipient) throw new Error(badRecipient);

      /*
       * AN EXISTING RECORD'S REMINDERS ARE WRITTEN FIRST.
       *
       * `onSave` closes this dialog, so anything awaited after it runs in an
       * unmounted component and its failure has nowhere to be shown. Writing
       * the cascade first means a reminder the server refuses stops the whole
       * edit with the reason on screen, rather than saving the item and
       * losing the refusal.
       */
      if (item) {
        await persistReminderDrafts({
          scope: reminderScope,
          subjectId: item.id,
          anchorDate: startsOn,
          rows: reminders.rows,
          baseline: reminders.baseline,
        });
      }

      /* A new record's cascade needs the id the save is about to mint, so the
         ids that exist BEFORE it are noted — see `createdItemId`. */
      const before = !item && reminders.rows.length ? await existingItemIds() : null;

      const saved = await onSave({
        title: trimmed,
        startsOn,
        /* "" is not a date and must not be sent as one. `null` is the route's
           spelling of "no end date", and it is what clears an existing one. */
        endsOn: endsOn || null,
        siteId: siteId || null,
        notes: notes.trim() || null,
        /*
         * The type, written to the column that has always been there.
         *
         * `type.colour` goes with it as the DEFAULT swatch rather than a
         * chosen one: it is what makes a visit read as a visit on a grid full
         * of teal, and the person can still change it later without this
         * overwriting them, because an edit that does not touch the type
         * sends the value already on the row.
         */
        category: type.key,
        colour: item?.colour ?? type.colour,
      });

      if (!item && reminders.rows.length) {
        const created =
          (saved && typeof saved === "object" && typeof saved.id === "string"
            ? saved.id
            : null) ?? (await createdItemId(before, trimmed, startsOn, type.key));
        if (!created) {
          /*
           * Deliberately loud. Reminders that were configured and not written
           * are exactly the silent misconfiguration the preview panel exists
           * to prevent, so it is said rather than swallowed — the record
           * itself is safely saved, and re-opening it offers the ladder again.
           */
          throw new Error(
            "The item was saved, but its reminders could not be attached to it. Open the item again to set them.",
          );
        }
        await persistReminderDrafts({
          scope: reminderScope,
          subjectId: created,
          anchorDate: startsOn,
          rows: reminders.rows,
          baseline: [],
        });
      }
    });

  /*
   * THE TYPE CHOOSER — step one, and the whole dialog until a type is picked.
   *
   * Returned early rather than rendered above the form, so that a reader on a
   * screen reader or a phone is not handed a form and a question about the
   * form at the same time. Three buttons, in the order the vocabulary lists
   * them, each saying what it is for in one line.
   */
  if (!chosenType) {
    return (
      <div
        className="manual-event-dialog__scrim"
        role="presentation"
        onKeyDown={(pressed) => {
          if (pressed.key === "Escape") onCancel();
        }}
      >
        <div
          className="manual-event-dialog manual-event-dialog--chooser"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
        >
          <h2 id={titleId}>What are you adding?</h2>
          <p className="manual-event-dialog__lede">
            On {defaultDay}. None of these is a job, and nothing counts one as
            work.
          </p>
          <ul className="manual-event-dialog__types">
            {CALENDAR_ITEM_TYPES.map((option, index) => (
              <li key={option.key}>
                <button
                  type="button"
                  /* Held rather than focused inline: a callback ref that
                     called `.focus()` would re-steal focus on every render,
                     including one caused by the reader tabbing away. */
                  ref={index === 0 ? firstChoiceRef : undefined}
                  onClick={() => setChosenType(option)}
                >
                  <span
                    className="manual-event-dialog__typeicon"
                    style={{ background: option.colour }}
                    aria-hidden="true"
                  >
                    <Icon name={option.icon} size={16} />
                  </span>
                  <span>
                    <strong>{option.label}</strong>
                    <em>{option.description}</em>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="manual-event-dialog__actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  const type = chosenType;

  return (
    <div
      className="manual-event-dialog__scrim"
      role="presentation"
      onKeyDown={(pressed) => {
        if (pressed.key === "Escape") onCancel();
      }}
    >
      <div
        /* Wider than the chooser and than the sibling date dialog, because a
           reminder row carries three controls on one line and 520px puts them
           on three. The bottom sheet under 640px ignores both numbers. */
        className="manual-event-dialog manual-event-dialog--form"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId}>
          {item ? `Edit ${type.label.toLowerCase()}` : `Add a ${type.label.toLowerCase()}`}
        </h2>
        {/*
          THE BACK ARROW, and only while the type is still free to change.
          A saved item's type is not re-picked here: changing what an existing
          record IS is a different act from editing it, and offering it beside
          the title would make it look like a field.
        */}
        {!item && (
          <button
            type="button"
            className="manual-event-dialog__back"
            onClick={() => setChosenType(null)}
          >
            <Icon name="arrow" size={14} />
            Change type
          </button>
        )}
        <p className="manual-event-dialog__lede">
          {/*
            The sentence says what this record IS, because the one confusion
            worth pre-empting is that this creates work. It does not.
          */}
          {type.description} It is not a job, and nothing counts it as one.
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
            {/* The date's MEANING differs by type — a visit happens on it, a
                certificate expires on it — so the label is the type's. */}
            <span>{type.dateLabel}</span>
            <input
              type="date"
              value={startsOn}
              onChange={(changed) => setStartsOn(changed.target.value)}
            />
          </label>
          {/* A certificate has one date. Offering "ends on" beside an expiry
              date invites somebody to record a range that means nothing. */}
          {type.endDateLabel && (
            <label className="manual-event-dialog__field">
              <span>{type.endDateLabel} (optional)</span>
              <input
                type="date"
                value={endsOn}
                min={startsOn || undefined}
                onChange={(changed) => setEndsOn(changed.target.value)}
              />
            </label>
          )}
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
          {/*
            One column, three meanings. `calendar_events.notes` is free text
            and each type has a different thing worth writing in it — a memo, a
            scope of works and access, a certificate reference and its
            remedials. The label and the placeholder say which, rather than
            three columns saying it in the schema for a form that would then
            have to hide two of them.
          */}
          <span>{type.notesLabel} (optional)</span>
          <textarea
            rows={3}
            maxLength={2000}
            value={notes}
            placeholder={type.notesHint}
            onChange={(changed) => setNotes(changed.target.value)}
          />
        </label>

        {/*
          THE REMINDERS, LAST BUT NOT OPTIONAL.
          Below the fields they depend on — every row is an offset from the
          date above, so a panel that sat above the date field would spend its
          first render telling the reader to scroll down and choose one.
        */}
        <ReminderRows
          scope={reminderScope}
          anchorDate={startsOn}
          rows={reminders.rows}
          onChange={reminders.setRows}
          disabled={busy !== null}
          loading={reminders.loading}
          loadError={reminders.error}
          recordTitle={title.trim() || type.label}
          siteName={sites.find((site) => site.id === siteId)?.name ?? null}
        />

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

/**
 * The ids on the calendar right now.
 *
 * Only read when a NEW record is about to be saved with reminders on it — see
 * the note on `onSave`. It is one extra request on one path, and it buys the
 * difference between a cascade that attaches itself to the right row and one
 * that is silently dropped by a caller that returns nothing.
 */
async function existingItemIds(): Promise<Set<string>> {
  try {
    const events = await fetchManualEvents({ archived: true });
    return new Set(events.map((event) => event.id));
  } catch {
    /* A failure here costs the fast path, not the save. The caller falls back
       to reporting that the reminders could not be attached. */
    return new Set();
  }
}

/**
 * The id the save just minted, found by diffing the list around it.
 *
 * The id must be NEW and the row must match what was written, so a colleague
 * creating something else at the same moment cannot be mistaken for this
 * save. Returns null rather than guessing between two equally good matches:
 * attaching a compliance cascade to the wrong record silently is worse than
 * saying it could not be attached at all.
 */
async function createdItemId(
  before: Set<string> | null,
  title: string,
  startsOn: string,
  category: string,
): Promise<string | null> {
  if (!before) return null;
  try {
    const events = await fetchManualEvents({ archived: true });
    const candidates = events.filter(
      (event) =>
        !before.has(event.id) &&
        event.title === title &&
        event.startsOn === startsOn &&
        event.category === category,
    );
    return candidates.length === 1 ? candidates[0].id : null;
  } catch {
    return null;
  }
}
