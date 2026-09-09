"use client";

import * as React from "react";
import type { FormQuestion } from "../../../db/monday-board-spec";
import { Icon } from "../../components";
import { DraftInput } from "./form-builder-controls";
import { FormFieldPicker } from "./form-field-picker";
import { columnForQuestion, type BuilderColumn } from "./form-bindings";
import { questionGlyph, type BuilderForm } from "./form-builder-model";
import { FormQuestionOptionsEditor } from "./form-options-editor";
import type { OrderSlot } from "./form-pages";
import type { IntakeWarning } from "./form-intake-warnings";

/**
 * ONE QUESTION, COLLAPSED OR OPEN.
 *
 * ── WHY COLLAPSED IS THE DEFAULT ──────────────────────────────────────────
 *
 * The canvas drew every question fully expanded, all nineteen of them, each
 * with a title field, a description field, its settings and — for the six
 * single-selects — an option editor listing up to thirty-nine live sites. The
 * job board's form was several thousand pixels of editor, so "move Location
 * below Description" meant scrolling past both to find the controls, and the
 * shape of the form (which is the thing being edited) was never on screen at
 * once.
 *
 * A collapsed card is a row: glyph, title, the type, the required marker, and
 * the four controls that operate on the form's SHAPE rather than on the
 * question's contents — move up, move down, show/hide, expand. Opening one is
 * how you edit its contents. That is monday's arrangement and it is the right
 * one for the same reason a file tree is collapsed by default.
 *
 * The collapse state is deliberately LOCAL and not persisted. It is a view of
 * the editor, not a property of the form: persisting it would mean a PATCH per
 * disclosure triangle, and it would mean two operators editing one form
 * fighting over each other's scroll position.
 *
 * ── THE THREE WAYS TO MOVE A QUESTION, AND WHY THERE ARE THREE ────────────
 *
 *   · DRAG, for a pointer. The handle is the only draggable part of the card,
 *     so a drag that starts on the title field is a text selection, which is
 *     what it looks like it should be.
 *   · ARROW KEYS on the focused handle, for a keyboard. Drag-and-drop has no
 *     keyboard equivalent in any browser; a reorder that only works by pointer
 *     is a reorder half the audience cannot perform.
 *   · "MOVE TO…", for both, and the only one that can cross a page boundary in
 *     one gesture or reach position 14 without fourteen presses. It is a real
 *     `<select>` of named positions rather than a drag target, so a screen
 *     reader announces the destinations instead of a drop zone.
 *
 * All three write the same flat `order` array through the helpers in
 * `form-pages.ts`. There is no second ordering model.
 */

export type QuestionCardProps = {
  question: FormQuestion;
  form: BuilderForm;
  /** Position in the FLAT order — page blocks counted. */
  index: number;
  lastIndex: number;
  collapsed: boolean;
  onToggle: () => void;
  busy: boolean;
  update: (id: string, changes: Record<string, unknown>) => void;
  setSetting: (id: string, changes: Record<string, unknown>) => void;
  remove: (id: string) => void;
  nudge: (id: string, direction: -1 | 1) => void;
  moveTo: (id: string, slotIndex: number) => void;
  rebind: (question: FormQuestion, column: BuilderColumn) => void;
  slots: readonly OrderSlot[];
  columns: readonly BuilderColumn[];
  usedQuestionIds: ReadonlySet<string>;
  patch: (patch: Record<string, unknown>) => void;
  /** Single-select questions ASKED BEFORE this one — the conditional triggers. */
  triggers: ReadonlyArray<{ question: FormQuestion; options: Array<{ label: string; value: string }> }>;
  warnings: readonly IntakeWarning[];
  /**
   * Pointer reordering, owned by the panel so ONE drag can see every card.
   *
   * The id of the card being dragged, or null. Carried whole rather than as a
   * boolean per card because both facts are needed here and they are different:
   * this card is the one being dragged (so it dims), or another card is (so
   * this one accepts a drop). A single boolean could only say one of them.
   */
  draggingId: string | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDropBefore: (id: string) => void;
};

/** The word for a question type, for the collapsed row and the aria label. */
export function typeLabel(type: FormQuestion["type"]): string {
  switch (type) {
    case "SingleSelect":
      return "Choice";
    case "ShortText":
      return "Short text";
    case "LongText":
      return "Long text";
    case "Number":
      return "Number";
    case "Date":
      return "Date";
    case "DateRange":
      return "Date range";
    case "File":
      return "Files";
    case "People":
      return "Person";
    case "Subitems":
      return "Sub-items";
    default:
      return "Question";
  }
}

export function FormQuestionCard(props: QuestionCardProps) {
  const {
    question,
    form,
    index,
    lastIndex,
    collapsed,
    onToggle,
    busy,
    update,
    setSetting,
    remove,
    nudge,
    moveTo,
    rebind,
    slots,
    columns,
    usedQuestionIds,
    patch,
    triggers,
    warnings,
    draggingId,
    onDragStart,
    onDragEnd,
    onDropBefore,
  } = props;

  const isSource = draggingId === question.id;
  const acceptsDrop = draggingId !== null && !isSource;
  const glyph = questionGlyph(question.type);
  const bound = columnForQuestion(question.id, columns);
  const blocking = warnings.some((warning) => warning.level === "blocking");
  const bodyId = `form-q-${question.id}`;

  /*
   * The handle carries the keyboard reorder as well as the drag, so the two
   * gestures live on one control and a reader who finds one has found both.
   * Home and End are included because "put this first" is the move people
   * actually want and twelve ArrowUps is not it.
   */
  function onHandleKey(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      nudge(question.id, -1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      nudge(question.id, 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveTo(question.id, 0);
    } else if (event.key === "End") {
      event.preventDefault();
      moveTo(question.id, lastIndex + 1);
    }
  }

  return (
    <article
      className={[
        "form-edit__card",
        question.visible ? "" : " is-hidden",
        collapsed ? " is-collapsed" : "",
        isSource ? " is-dragging" : "",
        blocking ? " is-blocking" : "",
      ].join("")}
      onDragOver={(event) => {
        /* A card only accepts a drop while one is in progress; without the
           check every card would claim every file dragged onto the page. */
        if (acceptsDrop) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!acceptsDrop) return;
        event.preventDefault();
        onDropBefore(question.id);
      }}
    >
      <div className="form-edit__cardhead">
        <button
          type="button"
          className="form-edit__handle"
          draggable
          onDragStart={(event) => {
            /* Firefox refuses to start a drag without some payload on the
               transfer, and the id is the only thing the drop needs. */
            event.dataTransfer.setData("text/plain", question.id);
            event.dataTransfer.effectAllowed = "move";
            onDragStart(question.id);
          }}
          onDragEnd={onDragEnd}
          onKeyDown={onHandleKey}
          aria-label={`Reorder ${question.title}. Use the arrow keys, or the Move to menu.`}
          title="Drag to reorder, or use the arrow keys"
        >
          <Icon name="more" size={14} />
        </button>

        <span className={`form-edit__glyph form-edit__glyph--${glyph.tone}`}>
          <Icon name={glyph.icon} size={12} />
        </span>

        {collapsed ? (
          /*
            The collapsed row's own name is a BUTTON, so the whole title is the
            disclosure control rather than a label beside a chevron nobody aims
            at. `aria-expanded` and `aria-controls` are what make it read as a
            disclosure to a screen reader instead of as a link to somewhere.
          */
          <button
            type="button"
            className="form-edit__cardname"
            onClick={onToggle}
            aria-expanded={false}
            aria-controls={bodyId}
          >
            <span className="form-edit__name">{question.title}</span>
            <em className="form-edit__cardtype">{typeLabel(question.type)}</em>
          </button>
        ) : (
          /*
            The question's own words are editable in place, as monday's canvas
            does it. An emptied title keeps the old one — a question with no
            name is a field nobody can answer.
          */
          <DraftInput
            className="form-edit__titleinput"
            type="text"
            value={question.title}
            maxLength={120}
            busy={busy}
            aria-label={`Rename the question ${question.title}`}
            onCommit={(next) => {
              if (next.trim()) update(question.id, { title: next.trim() });
            }}
          />
        )}

        {question.required && <em aria-label="Required">*</em>}

        <div className="form-edit__cardtools">
          <button
            type="button"
            onClick={() => nudge(question.id, -1)}
            disabled={busy || index === 0}
            aria-label={`Move ${question.title} up`}
          >
            <Icon name="chevron" size={14} />
          </button>
          <button
            type="button"
            className="is-down"
            onClick={() => nudge(question.id, 1)}
            disabled={busy || index === lastIndex}
            aria-label={`Move ${question.title} down`}
          >
            <Icon name="chevron" size={14} />
          </button>
          <button
            type="button"
            onClick={() => update(question.id, { visible: !question.visible })}
            disabled={busy}
            aria-pressed={question.visible}
            aria-label={question.visible ? `Hide ${question.title}` : `Show ${question.title}`}
          >
            <Icon name={question.visible ? "check" : "close"} size={14} />
          </button>
          <button
            type="button"
            className={collapsed ? "form-edit__disclose" : "form-edit__disclose is-open"}
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            aria-label={collapsed ? `Edit ${question.title}` : `Collapse ${question.title}`}
          >
            <Icon name={collapsed ? "edit" : "chevron"} size={14} />
          </button>
        </div>
      </div>

      {/*
        `hidden` rather than an unmounted branch. The body keeps its own state —
        a half-typed description in a `DraftInput`, an expanded option list —
        and unmounting would throw both away every time somebody collapsed a
        card to look at the one below it. `[hidden]` also takes it out of the
        accessibility tree, which a `max-height: 0` would not.
      */}
      <div className="form-edit__cardbody" id={bodyId} hidden={collapsed}>
        {warnings.length > 0 && (
          <ul className="form-edit__cardwarn">
            {warnings.map((warning) => (
              <li key={warning.id} data-level={warning.level}>
                <Icon name="alert" size={13} />
                <span>
                  <strong>{warning.title}.</strong> {warning.detail}
                </span>
              </li>
            ))}
          </ul>
        )}

        <DraftInput
          className="form-edit__helpinput"
          type="text"
          value={question.description ?? ""}
          placeholder="Add a description for submitters (optional)"
          maxLength={300}
          busy={busy}
          aria-label={`Describe the question ${question.title}`}
          onCommit={(next) => update(question.id, { description: next.trim() || null })}
        />

        {/*
          WHERE THE ANSWER GOES. Drawn on every card, because "which column does
          this fill?" was previously unanswerable from the editor at all — the
          binding was implied by an id nobody could see. The picker's option
          values are column IDs; see the header of form-bindings.ts.
        */}
        <div className="form-edit__binding">
          <FormFieldPicker
            columns={columns}
            usedQuestionIds={usedQuestionIds}
            currentQuestionId={question.id}
            busy={busy}
            label="Fills the column"
            placeholder={bound ? "Choose a column…" : "Not bound to a column"}
            onPick={(column) => rebind(question, column)}
          />
          {!bound && columns.length > 0 && (
            <p className="form-edit__bindnote">
              <Icon name="alert" size={13} />
              Answers to this question have nowhere to be saved until it is pointed at a column.
            </p>
          )}
        </div>

        {/*
          MOVE TO… — the accessible reorder, and the only one that crosses a
          page in one gesture. Its options are the named slots from
          `orderSlots()`, so the insertion control and this menu offer exactly
          the same positions under exactly the same names.
        */}
        <label className="form-edit__setting form-edit__setting--wide">
          <span>Move to</span>
          <select
            value=""
            disabled={busy || slots.length < 2}
            onChange={(event) => {
              const target = Number(event.target.value);
              if (Number.isInteger(target)) moveTo(question.id, target);
            }}
          >
            <option value="">Choose a position…</option>
            {slots.map((slot) => (
              <option key={slot.index} value={slot.index}>
                {slot.label}
              </option>
            ))}
          </select>
        </label>

        {/*
          QUESTION SETTINGS — monday's per-question panel, inline. Every control
          here changes what a submitter sees, and each is rendered only for the
          question types it means anything for: a "today as default" switch on a
          text question would be a control that does nothing, which is the thing
          being fixed. Nothing is drawn for File, Person or Sub-items, because
          this build honours no setting on any of the three and a disabled
          control that is never enabled is worse than an absence.
        */}
        <div className="form-edit__settings">
          {(question.type === "Date" || question.type === "DateRange") && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={question.settings?.defaultCurrentDate === true}
                  disabled={busy || !question.visible}
                  onChange={(event) =>
                    setSetting(question.id, { defaultCurrentDate: event.target.checked })
                  }
                />
                Today as default
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={question.settings?.includeTime === true}
                  disabled={busy || !question.visible}
                  onChange={(event) =>
                    setSetting(question.id, { includeTime: event.target.checked })
                  }
                />
                Include time
              </label>
            </>
          )}

          {question.type === "SingleSelect" && (
            <>
              <label className="form-edit__setting">
                <span>Display</span>
                <select
                  value={question.settings?.display ?? "Dropdown"}
                  disabled={busy || !question.visible}
                  onChange={(event) =>
                    setSetting(question.id, {
                      display: event.target.value as "Dropdown" | "Vertical" | "Horizontal",
                    })
                  }
                >
                  <option value="Dropdown">Show options in a dropdown</option>
                  <option value="Vertical">List the options</option>
                  <option value="Horizontal">List the options side by side</option>
                </select>
              </label>
              <label className="form-edit__setting">
                <span>Options order</span>
                <select
                  value={question.settings?.optionsOrder ?? "Custom"}
                  disabled={busy || !question.visible}
                  onChange={(event) =>
                    setSetting(question.id, {
                      optionsOrder: event.target.value as "Custom" | "Alphabetical",
                    })
                  }
                >
                  <option value="Custom">Custom</option>
                  <option value="Alphabetical">Alphabetical</option>
                </select>
              </label>
            </>
          )}

          {(question.type === "ShortText" ||
            question.type === "LongText" ||
            question.type === "Number") && (
            <label className="form-edit__setting form-edit__setting--wide">
              <span>Pre-fill value</span>
              <DraftInput
                type={question.type === "Number" ? "number" : "text"}
                value={question.settings?.defaultAnswer ?? ""}
                placeholder="Leave empty for none"
                maxLength={200}
                busy={busy}
                readOnly={!question.visible}
                onCommit={(next) => setSetting(question.id, { defaultAnswer: next || null })}
              />
            </label>
          )}

          {/*
            ONLY ASK THIS WHEN… — `showIf`, which the stored configuration has
            always carried and no control has ever set.

            It is honoured end to end already: `askedQuestions()` in
            app/lib/form-projection.ts decides what the renderer draws AND what
            the submit route validates, from one implementation, so a question
            hidden by its condition is neither shown nor required. The only
            missing piece was a way to say it.

            Triggers are the single-select questions asked BEFORE this one.
            Later ones are excluded on purpose: on a multi-page form the answer
            has not been given yet when this page is drawn, so the condition
            could never be true.
          */}
          {triggers.length > 0 && (
            <>
              <label className="form-edit__setting">
                <span>Only ask this when</span>
                <select
                  value={question.showIf?.questionId ?? ""}
                  disabled={busy}
                  onChange={(event) => {
                    const questionId = event.target.value;
                    if (!questionId) {
                      update(question.id, { showIf: null });
                      return;
                    }
                    const trigger = triggers.find(
                      (entry) => entry.question.id === questionId,
                    );
                    const first = trigger?.options[0];
                    update(question.id, {
                      showIf: { questionId, equals: first ? [first.value] : [] },
                    });
                  }}
                >
                  <option value="">Always ask it</option>
                  {triggers.map((trigger) => (
                    <option key={trigger.question.id} value={trigger.question.id}>
                      {trigger.question.title}
                    </option>
                  ))}
                </select>
              </label>
              {question.showIf && (
                <label className="form-edit__setting">
                  <span>is</span>
                  <select
                    value={question.showIf.equals[0] ?? ""}
                    disabled={busy}
                    onChange={(event) =>
                      update(question.id, {
                        showIf: {
                          questionId: question.showIf?.questionId ?? "",
                          equals: event.target.value ? [event.target.value] : [],
                        },
                      })
                    }
                  >
                    <option value="">Any answer</option>
                    {(
                      triggers.find(
                        (entry) => entry.question.id === question.showIf?.questionId,
                      )?.options ?? []
                    ).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
        </div>

        {/*
          The options themselves — monday's Add / rename / reorder /
          per-option actions, wired to the canonical registers. See the header
          of form-options-editor.tsx for which register owns what.
        */}
        {question.type === "SingleSelect" && (
          <FormQuestionOptionsEditor
            question={question}
            form={form}
            patch={patch}
            busy={busy}
          />
        )}

        <div className="form-edit__cardfoot">
          <label>
            <input
              type="checkbox"
              checked={question.required}
              disabled={busy || !question.visible}
              onChange={(event) => update(question.id, { required: event.target.checked })}
            />
            Required
          </label>
          {!question.visible && <span className="form-edit__count">Hidden</span>}
          {/*
            REMOVE, and it is a removal from the FORM and not from the board.
            The wording is the whole of the safety here: the column, its cells
            and every answer already filed stay exactly where they are, and the
            question can be put back from the picker above in one gesture. So
            there is no confirmation dialog — a reversible action that asks
            "are you sure?" teaches people to click through the ones that are
            not reversible.
          */}
          <button
            type="button"
            className="form-edit__remove"
            disabled={busy}
            onClick={() => remove(question.id)}
            title="Take this question off the form. The board column and its data are untouched."
          >
            <Icon name="trash" size={13} />
            Remove from form
          </button>
        </div>
      </div>
    </article>
  );
}
