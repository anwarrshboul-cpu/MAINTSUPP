"use client";

import * as React from "react";
import type { FormQuestion } from "../../../db/monday-board-spec";
import { Icon } from "../../components";
import { DraftInput } from "./form-builder-controls";
import {
  QUESTION_TYPE_BY_COLUMN_TYPE,
  questionIdForColumn,
  type BuilderColumn,
} from "./form-bindings";
import { FormFieldPicker } from "./form-field-picker";
import { questionGlyph, type BuilderForm } from "./form-builder-model";
import { intakeWarnings, worstLevel, type IntakeWarning } from "./form-intake-warnings";
import { FormQuestionCard } from "./form-question-card";
import {
  fullOrder,
  insertAt,
  moveTo,
  newPageBlock,
  nudge,
  orderSlots,
  orderedEntries,
  pagesOf,
  removePageBlock,
} from "./form-pages";

/**
 * THE EDIT SURFACE — the Content rail, the canvas, the pages and the warnings.
 *
 * SPLIT OUT OF `form-builder-panels.tsx`, WHICH KEEPS DESIGN AND SETTINGS. That
 * file was three panels sharing one visual vocabulary and it said so; it was
 * right while all three were lists of switches. Edit is no longer a list — it
 * has a page model, three reordering gestures, an insertion control, a field
 * picker and an intake report — so it is a screen, and it sits with the two
 * components it is made of (`form-question-card.tsx`, `form-field-picker.tsx`)
 * rather than above two panels it shares nothing with but a stylesheet.
 *
 * ── WHERE THE CONTROLS LIVE, AND WHY IT IS THE CANVAS ─────────────────────
 *
 * Every control that CHANGES the form is on the canvas: the insert rows between
 * cards, the page headings, Add a page, and everything on a card. The Content
 * rail is navigation only — a glyph, a name, a marker when a question is hidden
 * — which is exactly what the stylesheet has always claimed it is, and it is
 * why the rail can stay `display: none` below 768px without taking a single
 * capability away from a phone. A control that exists only in the rail would
 * have quietly made this editor desktop-only again.
 *
 * ── WHAT IS NOT STORED ────────────────────────────────────────────────────
 *
 * Which cards are open, which insert row is showing its picker, and what is
 * mid-drag are all local state. None of them is a property of the form: storing
 * them would mean a PATCH per disclosure triangle against a pooler that is
 * already this product's measured bottleneck, and it would mean two people
 * editing one form fighting over each other's scroll position.
 */

/**
 * ADD A QUESTION *HERE* — the insertion control, one per position.
 *
 * A TOP-LEVEL COMPONENT, not a closure inside the panel, and that is not a
 * style preference. A component declared inside another component's body is a
 * NEW component type on every render, so React unmounts and remounts its whole
 * subtree each time the panel re-renders — which for this one means the picker
 * loses focus the instant anything else on the canvas changes. The bug shows up
 * as "the dropdown closes while I am choosing", and it is invisible in a
 * screenshot.
 *
 * Collapsed to a button until it is used. Twenty always-open pickers would be
 * twenty selects in the tab order between every pair of questions, which is a
 * worse keyboard experience than the one this control exists to provide.
 */
/**
 * The field types a NEW field can be created as from the form editor.
 *
 * The plain answer types a submitter types into. Choice columns (Status,
 * Labels) are left to the board, because they need an option list before they
 * can be asked; an existing one is still offered by the column picker.
 */
const NEW_FIELD_TYPES: ReadonlyArray<readonly [string, string]> = [
  ["text", "Short text"],
  ["long_text", "Long text"],
  ["number", "Number"],
  ["date", "Date"],
  ["email", "Email"],
];

/**
 * CREATE A NEW FIELD — the second half of the insertion control.
 *
 * A name and a type. Creating it makes the board column (through the shell's
 * `createField`, because a panel may not fetch) and then puts its question on
 * the form at this position, exactly as picking an existing column does.
 */
function NewFieldForm({
  busy,
  onCreate,
  onCancel,
}: {
  busy: boolean;
  onCreate: (title: string, type: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = React.useState("");
  const [type, setType] = React.useState("text");
  const [working, setWorking] = React.useState(false);
  const nameId = React.useId();
  const typeId = React.useId();

  async function submit() {
    const name = title.trim();
    if (!name || working) return;
    setWorking(true);
    try {
      await onCreate(name, type);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="form-edit__newfield">
      <label htmlFor={nameId}>Field name</label>
      <input
        id={nameId}
        type="text"
        value={title}
        maxLength={80}
        placeholder="e.g. Company name"
        autoFocus
        disabled={busy || working}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <label htmlFor={typeId}>Answer type</label>
      <select
        id={typeId}
        value={type}
        disabled={busy || working}
        onChange={(event) => setType(event.target.value)}
      >
        {NEW_FIELD_TYPES.map(([value, name]) => (
          <option key={value} value={value}>
            {name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="form-edit__newfieldadd"
        disabled={busy || working || !title.trim()}
        onClick={() => void submit()}
      >
        <Icon name="plus" size={13} />
        {working ? "Adding…" : "Add field"}
      </button>
      <button type="button" className="form-edit__insertcancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

function InsertRow({
  slotIndex,
  label,
  openHere,
  onOpen,
  onCancel,
  columns,
  used,
  busy,
  onPick,
  onCreate,
}: {
  slotIndex: number;
  label: string;
  openHere: boolean;
  onOpen: (slotIndex: number) => void;
  onCancel: () => void;
  columns: readonly BuilderColumn[];
  used: ReadonlySet<string>;
  busy: boolean;
  onPick: (column: BuilderColumn, slotIndex: number) => void;
  onCreate: (title: string, type: string, slotIndex: number) => Promise<void>;
}) {
  /* Which half of the control is showing: a column the board already has, or
     a brand-new field. New is the default — it is what "add a question"
     means to somebody who has not met the board's columns. */
  const [creatingNew, setCreatingNew] = React.useState(true);
  return (
    <div className={`form-edit__insert${openHere ? " is-open" : ""}`}>
      {openHere ? (
        <div className="form-edit__insertpanel">
          <div className="form-edit__inserttabs" role="group" aria-label="Add a question">
            <button
              type="button"
              aria-pressed={creatingNew}
              className={creatingNew ? "is-active" : undefined}
              onClick={() => setCreatingNew(true)}
            >
              New field
            </button>
            <button
              type="button"
              aria-pressed={!creatingNew}
              className={creatingNew ? undefined : "is-active"}
              onClick={() => setCreatingNew(false)}
            >
              Existing column
            </button>
          </div>
          {creatingNew ? (
            <NewFieldForm
              busy={busy}
              onCreate={(title, type) => onCreate(title, type, slotIndex)}
              onCancel={onCancel}
            />
          ) : (
            <FormFieldPicker
              columns={columns}
              usedQuestionIds={used}
              busy={busy}
              label={label}
              placeholder="Which column should it fill?"
              onPick={(column) => onPick(column, slotIndex)}
            >
              <button type="button" className="form-edit__insertcancel" onClick={onCancel}>
                Cancel
              </button>
            </FormFieldPicker>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="form-edit__insertbtn"
          disabled={busy}
          onClick={() => onOpen(slotIndex)}
          aria-label={label}
        >
          <Icon name="plus" size={13} />
          <span>Add a question here</span>
        </button>
      )}
    </div>
  );
}

type EditPanelProps = {
  form: BuilderForm;
  patch: (patch: Record<string, unknown>) => void;
  busy: boolean;
  /**
   * EVERY LIVE COLUMN OF THE TARGET BOARD, from `GET /api/board/columns`.
   *
   * Fetched by the builder shell and handed down, because
   * `tests/stage-twentynine-form-builder.test.mjs` holds — correctly — that no
   * panel reaches the network on its own. Empty while it is in flight, which
   * every consumer here treats as "not known yet" rather than as "none".
   */
  columns: readonly BuilderColumn[];
  /**
   * Make a new board column for a field the board does not have yet, from the
   * shell (a panel may not fetch). Resolves to the column, or null when the
   * shell could not create it — it reports why itself.
   */
  createField?: (title: string, type: string) => Promise<BuilderColumn | null>;
};

export function FormEditPanel({ form, patch, busy, columns, createField }: EditPanelProps) {
  const config = form.config;
  const order = React.useMemo(() => fullOrder(config), [config]);
  const entries = React.useMemo(() => orderedEntries(config), [config]);
  const pages = React.useMemo(() => pagesOf(config), [config]);
  const slots = React.useMemo(() => orderSlots(config), [config]);
  const used = React.useMemo(
    () => new Set(config.questions.map((question) => question.id)),
    [config.questions],
  );

  /* Open cards, by id. Everything is collapsed until somebody opens it — see
     the header of `form-question-card.tsx` for why that is the default. */
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  /* Which insert row is showing its picker. One at a time: twenty pickers is
     twenty selects nobody asked for, and a tab order nobody can use. */
  const [inserting, setInserting] = React.useState<number | null>(null);
  const [dragging, setDragging] = React.useState<string | null>(null);

  /*
   * THE INTAKE REPORT. Computed from the configuration, the board's columns and
   * the option substitution the server serves — the same three things the
   * submit route decides on. See `form-intake-warnings.ts` for each rule and
   * the refusal it predicts.
   */
  const warnings = React.useMemo<IntakeWarning[]>(
    () =>
      intakeWarnings({
        config,
        boundIds: columns.length
          ? new Set([
              ...columns.map((column) => column.id),
              ...columns.map((column) => questionIdForColumn(column)),
            ])
          : null,
        optionOverrides: form.optionOverrides ?? {},
        filesIntoThisBoard: form.filesIntoThisBoard !== false,
        active: form.active,
        closeAt: form.closeAt,
        responseLimit: form.responseLimit,
        responseCount: form.responseCount,
      }),
    [config, columns, form],
  );

  const warningsByQuestion = React.useMemo(() => {
    const grouped = new Map<string, IntakeWarning[]>();
    for (const warning of warnings) {
      if (!warning.questionId) continue;
      const list = grouped.get(warning.questionId) ?? [];
      list.push(warning);
      grouped.set(warning.questionId, list);
    }
    return grouped;
  }, [warnings]);

  const formWide = warnings.filter((warning) => !warning.questionId);

  /* ── Writes ───────────────────────────────────────────────────────────── */

  function update(id: string, changes: Record<string, unknown>) {
    patch({
      questions: config.questions.map((question) =>
        question.id === id ? { ...question, ...changes } : question,
      ),
    });
  }

  /**
   * Merge one question's settings.
   *
   * Merged rather than replaced so setting "include time" cannot wipe "today
   * as default" that was set a moment earlier — each control owns one key.
   */
  function setSetting(id: string, changes: Record<string, unknown>) {
    patch({
      questions: config.questions.map((question) =>
        question.id === id
          ? { ...question, settings: { ...(question.settings ?? {}), ...changes } }
          : question,
      ),
    });
  }

  /*
   * EVERY REORDER GOES THROUGH THE FLAT ORDER, page blocks included.
   *
   * The previous implementation swapped two entries of a list built with the
   * page blocks stripped out, then re-prefixed every page block it could find.
   * With one block that is correct; with two it hoists both to the front and
   * collapses a multi-page form onto one page. See the header of
   * `form-pages.ts`.
   */
  function nudgeEntry(id: string, direction: -1 | 1) {
    patch({ order: nudge(order, id, direction) });
  }

  function moveEntry(id: string, slotIndex: number) {
    patch({ order: moveTo(order, id, slotIndex) });
  }

  /**
   * Put a column's question on the form at a chosen position.
   *
   * TWO CASES, ONE GESTURE. A column whose question already exists — the hidden
   * ones `deriveFormQuestions` creates for every cell-backed column a
   * jobs-shaped board does not ask about — is SHOWN and moved, keeping its
   * title, description, options and settings. Only a column with no question at
   * all gets a new one. Adding a second question with the same id would be a
   * duplicate the order could not distinguish, and re-deriving one would throw
   * away whatever an operator had already configured on the hidden copy.
   */
  function addColumn(column: BuilderColumn, slotIndex: number) {
    const id = questionIdForColumn(column);
    const existing = config.questions.find((question) => question.id === id);
    const questions = existing
      ? config.questions.map((question) =>
          question.id === id ? { ...question, visible: true } : question,
        )
      : [
          ...config.questions,
          {
            id,
            type: (QUESTION_TYPE_BY_COLUMN_TYPE[column.type] ??
              "ShortText") as FormQuestion["type"],
            title: column.title,
            description: null,
            visible: true,
            required: column.required,
            options: null,
            showIf: null,
          } satisfies FormQuestion,
        ];
    /*
     * `moveTo` for a question that is already IN the order, `insertAt` for one
     * that is not, and the difference is an off-by-one that would put a
     * re-shown question in the wrong place. A slot index is read against the
     * order as it stands; removing an entry that sits BEFORE the slot shifts
     * everything after it left by one, which `moveTo` corrects for and a plain
     * splice does not. Every hidden question is already in the order, so this
     * is the common path, not the exotic one.
     */
    patch({
      questions,
      order: existing ? moveTo(order, id, slotIndex) : insertAt(order, id, slotIndex),
    });
    setInserting(null);
    setOpen((current) => ({ ...current, [id]: true }));
  }

  /**
   * A NEW FIELD at a chosen position: create its column, then bind it exactly
   * as picking an existing column would — so it is required/optional, titled
   * and moved like any other question, and its answers land in its own cell.
   */
  async function createAndAdd(title: string, type: string, slotIndex: number) {
    if (!createField) return;
    const column = await createField(title, type);
    if (column) addColumn(column, slotIndex);
  }

  /**
   * Take a question off the form.
   *
   * The question object goes with it rather than being marked hidden, because
   * "hidden" already means something else here — the ten questions monday keeps
   * hidden are still part of the form and can be shown again from the picker.
   * The board column, its cells and every answer already filed are untouched;
   * `questions` and `order` are the form's own description of itself.
   */
  function removeQuestion(id: string) {
    patch({
      questions: config.questions.filter((question) => question.id !== id),
      order: order.filter((entry) => entry !== id),
    });
  }

  /**
   * Point a question at a different column.
   *
   * The id IS the binding, so this is a rename of the question's identity, and
   * everything the operator wrote — the title, the help text, the required
   * flag, the settings, the option preferences — moves with it. Its position in
   * the order is preserved for the same reason: re-binding a question is not a
   * request to move it.
   */
  function rebind(question: FormQuestion, column: BuilderColumn) {
    const nextId = questionIdForColumn(column);
    if (nextId === question.id) return;
    const collides = config.questions.some((entry) => entry.id === nextId);
    if (collides) return;
    const moved: FormQuestion = {
      ...question,
      id: nextId,
      type: (QUESTION_TYPE_BY_COLUMN_TYPE[column.type] ??
        question.type) as FormQuestion["type"],
    };
    patch({
      questions: config.questions.map((entry) => {
        if (entry.id === question.id) return moved;
        /* A CONDITION NAMING THE OLD ID IS RE-POINTED, NOT LEFT TO DANGLE.
           The question is the same question under a new identity, so a
           "only ask this when X" that named it still means what it meant;
           dropping the reference instead would silently un-hook a conditional
           question, and leaving it would block one that can never appear. */
        if (entry.showIf?.questionId === question.id) {
          return { ...entry, showIf: { ...entry.showIf, questionId: nextId } };
        }
        return entry;
      }),
      order: order.map((entry) => (entry === question.id ? nextId : entry)),
    });
  }

  /* ── Pages ────────────────────────────────────────────────────────────── */

  function addPage() {
    /* The id has to be unique among questions, and stable once written. A
       timestamp is enough: two page breaks cannot be created in the same
       millisecond by one operator, and the id is never compared across forms. */
    const block = newPageBlock(`Page ${pages.length + 1}`, String(Date.now()));
    patch({
      questions: [...config.questions, block],
      order: [...order, block.id],
    });
  }

  function removePage(pageId: string) {
    const next = removePageBlock(config, pageId);
    patch({ questions: next.questions, order: next.order });
  }

  /* ── The rail ─────────────────────────────────────────────────────────── */

  function reveal(id: string) {
    setOpen((current) => ({ ...current, [id]: true }));
    /* The rail is navigation, so a click has to actually navigate. Guarded for
       the server render, where there is no document. */
    if (typeof document === "undefined") return;
    document.getElementById(`form-card-${id}`)?.scrollIntoView({ block: "nearest" });
  }

  /*
   * The conditional triggers a question may use: every single-select ASKED
   * BEFORE it. Computed once over the flat order and read by index, rather than
   * re-scanned per card, because the canvas draws this for every question and
   * the inner loop would be quadratic in the number of questions on a form.
   */
  const triggersBefore: Array<
    Array<{ question: FormQuestion; options: Array<{ label: string; value: string }> }>
  > = [];
  {
    const running: Array<{
      question: FormQuestion;
      options: Array<{ label: string; value: string }>;
    }> = [];
    for (const entry of entries) {
      triggersBefore.push([...running]);
      if (entry.type === "SingleSelect" && entry.visible) {
        running.push({
          question: entry,
          options:
            form.optionOverrides?.[entry.id] ??
            (entry.options ?? [])
              .filter((option) => option.visible && option.active)
              .map((option) => ({ label: option.label, value: option.value })),
        });
      }
    }
  }

  const level = worstLevel(warnings);

  /*
   * EACH PAGE'S POSITIONS, WORKED OUT BEFORE THE RENDER RATHER THAN DURING IT.
   *
   * The obvious version walks the pages with a `let cursor` and increments it
   * as the cards are drawn. It reads well and it is wrong twice over: React's
   * `react-hooks/immutability` rule refuses a variable reassigned inside the
   * render tree outright, and the reason it refuses is real — the value is
   * captured by the closures in that tree, so anything that re-renders one
   * subtree without re-running the whole map sees a `cursor` from a previous
   * pass and puts a question in the wrong place.
   *
   * The positions are a function of the flat order, so they are derived from
   * it: every question's index, and the slot at the end of each page — which
   * for an empty page is the position immediately after its own page block.
   */
  const pageViews = React.useMemo(() => {
    const indexOf = new Map(entries.map((entry, position) => [entry.id, position]));
    return pages.map((page) => {
      const head = page.id ? (indexOf.get(page.id) ?? -1) : -1;
      const questionIndices = page.questions.map((question) => indexOf.get(question.id) ?? 0);
      return {
        page,
        questionIndices,
        endSlot: questionIndices.length
          ? questionIndices[questionIndices.length - 1] + 1
          : head + 1,
      };
    });
  }, [entries, pages]);

  return (
    <div className="form-edit" aria-busy={busy || undefined}>
      <aside className="form-edit__content" aria-label="Form content">
        <header>
          <Icon name="chevron" size={14} />
          <strong>Content</strong>
        </header>
        {pages.map((page) => (
          <div key={page.id ?? "implicit"} className="form-edit__railpage">
            <p className="form-edit__page">
              {page.title || `Page ${page.number}`}
              <em>{page.questions.length}</em>
            </p>
            <ol>
              {page.questions.map((question) => {
                const glyph = questionGlyph(question.type);
                const flagged = warningsByQuestion.get(question.id);
                return (
                  <li
                    key={question.id}
                    className={question.visible ? undefined : "is-hidden"}
                    title={question.visible ? question.title : `${question.title} — hidden`}
                  >
                    <button type="button" onClick={() => reveal(question.id)}>
                      <span className={`form-edit__glyph form-edit__glyph--${glyph.tone}`}>
                        <Icon name={glyph.icon} size={12} />
                      </span>
                      <span className="form-edit__name">{question.title}</span>
                      {flagged?.some((warning) => warning.level === "blocking") && (
                        <Icon name="alert" size={12} />
                      )}
                      {!question.visible && <Icon name="close" size={12} />}
                    </button>
                  </li>
                );
              })}
              {page.questions.length === 0 && (
                <li className="form-edit__railempty">No questions yet</li>
              )}
            </ol>
          </div>
        ))}
      </aside>

      <div className="form-edit__canvas">
        {/*
          THE INTAKE REPORT, at the top of the canvas rather than in a panel
          somebody has to go and find. A form that cannot produce a job is not a
          detail of the Settings screen; it is the first thing about this form.
        */}
        {warnings.length > 0 && (
          <section className="form-edit__intake" data-level={level ?? "warning"} aria-label="Intake checks">
            <h3>
              <Icon name={level === "blocking" ? "alert" : "shield"} size={14} />
              {level === "blocking"
                ? "This form cannot file a job as it stands"
                : "Worth checking before you share this form"}
            </h3>
            <ul>
              {formWide.map((warning) => (
                <li key={warning.id} data-level={warning.level}>
                  <strong>{warning.title}.</strong> {warning.detail}
                </li>
              ))}
              {warningsByQuestion.size > 0 && (
                <li className="form-edit__intakecount">
                  {warningsByQuestion.size === 1
                    ? "One question has a problem of its own — it is marked below."
                    : `${warningsByQuestion.size} questions have problems of their own — they are marked below.`}
                </li>
              )}
            </ul>
          </section>
        )}

        <div className="form-edit__card form-edit__card--head">
          <h2>{form.title}</h2>
          {form.description && <p>{form.description}</p>}
        </div>

        {pageViews.map(({ page, questionIndices, endSlot }) => {
          return (
            <section key={page.id ?? "implicit"} className="form-edit__pagegroup">
              {pages.length > 1 && (
                <header className="form-edit__pagehead">
                  <Icon name="document" size={13} />
                  {page.id ? (
                    <DraftInput
                      type="text"
                      className="form-edit__pagename"
                      value={page.title}
                      maxLength={120}
                      busy={busy}
                      aria-label={`Name for page ${page.number}`}
                      onCommit={(next) => update(page.id as string, { title: next.trim() || "Page" })}
                    />
                  ) : (
                    <strong>Page {page.number}</strong>
                  )}
                  {page.id && page.number > 1 && (
                    <button
                      type="button"
                      className="form-edit__pageremove"
                      disabled={busy}
                      onClick={() => removePage(page.id as string)}
                      title="Remove this page break. Its questions move onto the page above."
                    >
                      <Icon name="close" size={13} />
                      Remove page break
                    </button>
                  )}
                </header>
              )}

              {page.questions.map((question, position) => {
                const index = questionIndices[position];
                return (
                  <React.Fragment key={question.id}>
                    <InsertRow
                      slotIndex={index}
                      label={`Add a question before ${question.title}`}
                      openHere={inserting === index}
                      onOpen={setInserting}
                      onCancel={() => setInserting(null)}
                      columns={columns}
                      used={used}
                      busy={busy}
                      onPick={addColumn}
                      onCreate={createAndAdd}
                    />
                    <div id={`form-card-${question.id}`}>
                      <FormQuestionCard
                        question={question}
                        form={form}
                        index={index}
                        lastIndex={entries.length - 1}
                        collapsed={!open[question.id]}
                        onToggle={() =>
                          setOpen((current) => ({
                            ...current,
                            [question.id]: !current[question.id],
                          }))
                        }
                        busy={busy}
                        update={update}
                        setSetting={setSetting}
                        remove={removeQuestion}
                        nudge={nudgeEntry}
                        moveTo={moveEntry}
                        rebind={rebind}
                        slots={slots}
                        columns={columns}
                        usedQuestionIds={used}
                        patch={patch}
                        triggers={triggersBefore[index] ?? []}
                        warnings={warningsByQuestion.get(question.id) ?? []}
                        draggingId={dragging}
                        onDragStart={setDragging}
                        onDragEnd={() => setDragging(null)}
                        onDropBefore={(targetId) => {
                          if (!dragging || dragging === targetId) return;
                          moveEntry(dragging, order.indexOf(targetId));
                          setDragging(null);
                        }}
                      />
                    </div>
                  </React.Fragment>
                );
              })}

              <InsertRow
                slotIndex={endSlot}
                label={
                  pages.length > 1
                    ? `Add a question at the end of page ${page.number}`
                    : "Add a question at the end"
                }
                openHere={inserting === endSlot}
                onOpen={setInserting}
                onCancel={() => setInserting(null)}
                columns={columns}
                used={used}
                busy={busy}
                onPick={addColumn}
                onCreate={createAndAdd}
              />
            </section>
          );
        })}

        <div className="form-edit__card form-edit__card--submit">
          <span>{config.appearance.submitButton.text || "Submit"}</span>
        </div>

        {/*
          ADD A PAGE, under the Submit card, because that is where a new page
          goes: at the end. A page break in the middle is made by moving a
          question across it, which is one gesture in the Move to… menu.
        */}
        <button type="button" className="form-edit__addpage" disabled={busy} onClick={addPage}>
          <Icon name="plus" size={13} />
          Add a page
        </button>
        <p className="form-edit__pagenote">
          {pages.length > 1
            ? `${pages.length} pages. A submitter answers one page at a time.`
            : "One page. Adding a second breaks the form into steps."}
        </p>
      </div>
    </div>
  );
}
