"use client";

/**
 * The four monday tabs Stage 5 folded away — Results, Form Response Viewer,
 * Table and Build Vibe view — rebuilt from the live capture of monday board
 * 1139774521 in `db/monday-export/MAINTENANCE-MONDAY-CAPTURE.md`.
 *
 * Stage 5 seeded seven tabs and recorded that "Results folds into the table and
 * Form Response Viewer folds into the item panel". The capture says otherwise:
 * both are live tabs on the board the store managers use every day, alongside a
 * second, group-free Table and monday's Build Vibe app surface. Where the app
 * and the capture disagree, the capture wins.
 *
 * Every number on these four panels is counted from the rows the board has
 * already loaded — the same filtered set the grid, kanban and chart see. None
 * of them invents a figure, and each has an empty state that says what will
 * fill it rather than a spinner or a dash.
 */

import { useMemo, useState } from "react";
import "./parity-views.css";
import { Icon } from "../../../components";
import { maintenanceFormSpec } from "../../../../db/monday-board-spec";
import type { MaintenanceRequest } from "../../../lib/types";
import { columnLabels } from "../board-model";
import type { ColumnKey } from "../board-model";
import { displaySource, systemColumnSortValue } from "../board-ordering";
import { type BoardItem, formatDate, formatMoney } from "./view-model";

/**
 * The board hands `MaintenanceRequest` rows straight through as `BoardItem`, so
 * three fields these panels need are present at runtime but missing from the
 * shared type. They are widened here rather than in `view-model.ts`, which the
 * kanban, calendar and chart also depend on.
 */
type FormItem = BoardItem & {
  /*
   * Widened past `MaintenanceRequest["source"]`, which declares only
   * `"Portal form" | "Manual"`. The database holds a third value:
   * `/api/forms/[token]/submit` writes `"Shared form"` on every submission that
   * arrives through a public link, deliberately, so the board can tell a link
   * submission from one raised inside the product. The shared type has never
   * said so — see the note on `formResponses` below for what that cost.
   */
  source?: MaintenanceRequest["source"] | "Shared form";
  contact?: string;
  formUrl?: string | null;
};

/**
 * monday's own name for a row a form submission created. WorkForms writes it
 * onto the Name column of every submission, and "Manual" onto a row typed
 * straight onto the board — which is why `displaySource` produces exactly this
 * phrase, and why the imported rows carry it as their title.
 */
const FORM_ANSWER = /incoming form answer/i;

/**
 * A response is a row that arrived through the Maintenance Request form.
 *
 * Two provenances have to be recognised, because the board carries both:
 *
 *  - a row raised in MAINTSUPP carries `source: "Portal form"`;
 *  - a row that arrived through a SHARED LINK carries `source: "Shared form"`,
 *    written by `/api/forms/[token]/submit`. It was missing from this filter,
 *    and it is the one provenance that is unambiguously a form response: those
 *    rows exist BECAUSE somebody filled the public form in. Every submission
 *    through a shared link was therefore absent from both Results and the
 *    response viewer, on the job board and on every register with a form of its
 *    own — the panels reported zero responses to a form that was collecting
 *    them. W2 requirement B.
 *  - a row imported from monday carries the importer's source instead, so the
 *    only surviving record of how it arrived is monday's Name.
 *
 * Conservative on purpose. A row typed onto the board is not a response, and a
 * row whose Name has since been edited to something descriptive cannot be
 * traced back to a submission — counting either would overstate how many
 * managers filled the form in. Both panels say so under their totals.
 */
function formResponses(items: FormItem[]) {
  return items.filter(
    (item) =>
      item.source === "Portal form" ||
      item.source === "Shared form" ||
      FORM_ANSWER.test(item.title ?? ""),
  );
}

/** Newest first, which is the order monday's response viewer opens in. */
function newestFirst(items: FormItem[]) {
  return [...items].sort((left, right) => {
    const a = left.requestedAt ? new Date(left.requestedAt).getTime() : 0;
    const b = right.requestedAt ? new Date(right.requestedAt).getTime() : 0;
    return b - a;
  });
}

/**
 * The Handyman Required answer.
 *
 * monday asks it conditionally (rule 8874e83b, shown only when Engineer
 * Required is "Handyman"). MAINTSUPP has no column for it, so `FormView`
 * appends it to the description rather than dropping it — the detail is the
 * point of asking. Both form panels read it back out of the same place.
 */
const HANDYMAN_LINE = /\n*Handyman required:\s*(.+)\s*$/i;

function handymanAnswer(item: FormItem) {
  return HANDYMAN_LINE.exec(item.description ?? "")?.[1]?.trim() ?? "";
}

/** The description as the manager typed it, without the appended follow-up. */
function submittedDescription(item: FormItem) {
  return (item.description ?? "").replace(HANDYMAN_LINE, "").trim();
}

/**
 * Whether a job is finished.
 *
 * monday flags "Job Completed" as `is_done` on the Status column, and on the
 * imported board that flag is the ONLY signal there is: the monday export
 * carries no completion date, so counting on `completedAt` alone reports zero
 * completed on a board where 672 jobs are closed. The date still wins where a
 * job was closed inside MAINTSUPP and has one.
 */
const DONE_STATUS = "Job Completed";

function isComplete(item: BoardItem) {
  return Boolean(item.completedAt) || item.status === DONE_STATUS;
}

/* ── Results — monday view 646340 ────────────────────────────────────────── */

type QuestionReader = {
  /** The answer as submitted. An empty string means the question went unanswered. */
  read: (item: FormItem) => string;
  /**
   * A question answered from a fixed list gets a ranked breakdown, the way
   * monday charts its choice questions. One answered in the manager's own words
   * gets a count instead — a bar chart of 700 unique sentences says nothing.
   */
  breakdown: boolean;
  /** What one answer is, so the count below a free answer reads honestly. */
  noun?: string;
  /** Shown under the question when the app stores the answer somewhere unobvious. */
  note?: string;
};

const QUESTION_READERS: Record<string, QuestionReader> = {
  storeLocation: { read: (item) => item.location ?? "", breakdown: true },
  requester: { read: (item) => item.requester ?? "", breakdown: true },
  number: { read: (item) => item.contact ?? "", breakdown: false, noun: "phone number" },
  requested: {
    read: (item) => formatDate(item.requestedAt),
    breakdown: false,
    noun: "date",
  },
  engineer: { read: (item) => item.engineer ?? "", breakdown: true },
  handymanRequired: {
    read: handymanAnswer,
    breakdown: false,
    noun: "answer",
    note: "Asked only when Engineer Required is Handyman. The board has no column for it, so the answer is kept on the end of the description.",
  },
  description: { read: submittedDescription, breakdown: false, noun: "free-text answer" },
  issuePictures: {
    read: (item) => ((item.attachmentCount ?? 0) > 0 ? "Files attached" : ""),
    breakdown: true,
  },
  priority: { read: (item) => item.priority ?? "", breakdown: true },
};

/** How many distinct answers a breakdown shows before it collapses the tail. */
const BREAKDOWN_ROWS = 8;

/**
 * Results — monday's form-results summary.
 *
 * monday shows the submission count and, for each question on the form, how the
 * answers divide. Reproduced question by question in the form's own order, from
 * `maintenanceFormSpec`, so a question added to the form appears here without
 * anyone editing this file.
 */
export function FormResultsView({ items }: { items: BoardItem[] }) {
  const responses = useMemo(() => formResponses(items), [items]);

  const questions = useMemo(
    () =>
      maintenanceFormSpec.questions.map((question) => {
        const reader = QUESTION_READERS[question.key];
        const answers = responses.map((item) => reader?.read(item) ?? "").filter(Boolean);

        const counts = new Map<string, number>();
        for (const answer of answers) counts.set(answer, (counts.get(answer) ?? 0) + 1);
        const ranked = [...counts.entries()].sort(
          (left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "en-GB"),
        );

        return {
          key: question.key,
          label: question.label,
          required: Boolean("required" in question && question.required),
          note: reader?.note,
          noun: reader?.noun ?? "answer",
          answered: answers.length,
          distinct: ranked.length,
          rows: reader?.breakdown ? ranked.slice(0, BREAKDOWN_ROWS) : [],
          hiddenRows: reader?.breakdown ? Math.max(0, ranked.length - BREAKDOWN_ROWS) : 0,
        };
      }),
    [responses],
  );

  if (!responses.length) {
    return (
      <p className="view-empty">
        No responses to <strong>{maintenanceFormSpec.title}</strong> yet. Every submission
        through the Form tab lands on this board and is counted here — jobs typed straight
        onto the board are not form responses and are left out.
      </p>
    );
  }

  const submitted = responses
    .map((item) => item.requestedAt)
    .filter((value): value is string => Boolean(value))
    .sort();

  return (
    <div className="form-results">
      <header className="form-results__head">
        <h3>{maintenanceFormSpec.title}</h3>
        <p>{maintenanceFormSpec.description}</p>
      </header>

      <ul className="form-results__totals">
        <li>
          <span>Responses in view</span>
          <strong>{responses.length}</strong>
        </li>
        <li>
          <span>First response</span>
          <strong>{formatDate(submitted[0] ?? null)}</strong>
        </li>
        <li>
          <span>Latest response</span>
          <strong>{formatDate(submitted[submitted.length - 1] ?? null)}</strong>
        </li>
        <li>
          <span>Questions asked</span>
          <strong>{maintenanceFormSpec.questions.length}</strong>
        </li>
      </ul>

      <p className="form-results__scope">
        Counted from the {responses.length} of {items.length} rows in view that are
        recorded as a form submission. A job typed straight onto the board, or one whose
        name has since been rewritten, cannot be traced back to a response and is left out.
      </p>

      <ol className="form-results__questions">
        {questions.map((question) => (
          <li key={question.key} className="form-results__question">
            <header>
              <h4>
                {question.label}
                {question.required && <em aria-hidden="true">*</em>}
              </h4>
              <span>
                {question.answered} of {responses.length} answered
              </span>
            </header>
            {question.note && <p className="form-results__note">{question.note}</p>}

            {question.rows.length > 0 ? (
              <ul className="form-results__bars">
                {question.rows.map(([answer, count]) => (
                  <li key={answer}>
                    <span className="form-results__answer" title={answer}>
                      {answer}
                    </span>
                    <span className="form-results__bar" aria-hidden="true">
                      <i style={{ width: `${(count / responses.length) * 100}%` }} />
                    </span>
                    <span className="form-results__count">
                      {count}
                      <em>{Math.round((count / responses.length) * 100)}%</em>
                    </span>
                  </li>
                ))}
                {question.hiddenRows > 0 && (
                  <li className="form-results__tail">
                    and {question.hiddenRows} further{" "}
                    {question.hiddenRows === 1 ? "answer" : "answers"}
                  </li>
                )}
              </ul>
            ) : (
              <p className="form-results__free">
                {question.answered === 0
                  ? "No response has answered this question yet."
                  : `${question.distinct} distinct ${question.noun}${
                      question.distinct === 1 ? "" : "s"
                    } — every one is on its own card in the Form Response Viewer rather than totalled here.`}
              </p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ── Form Response Viewer — monday view 646341, app 1732 ─────────────────── */

/** One page of cards. monday's viewer pages rather than rendering 744 at once. */
const RESPONSE_PAGE = 12;

/**
 * Form Response Viewer — one card per submission, newest first.
 *
 * monday's app shows a submission as it was filled in: the questions in form
 * order with the answers underneath, not the board's column set. That is the
 * point of the tab — the board row has since been triaged, assigned and
 * restatused, and this is what the store manager actually sent.
 */
export function FormResponsesView({
  items,
  onOpen,
}: {
  items: BoardItem[];
  onOpen?: (item: BoardItem) => void;
}) {
  const [shown, setShown] = useState(RESPONSE_PAGE);
  const responses = useMemo(() => newestFirst(formResponses(items)), [items]);

  if (!responses.length) {
    return (
      <p className="view-empty">
        No responses yet. Each submission of <strong>{maintenanceFormSpec.title}</strong>{" "}
        appears here as its own card, newest first, showing the answers exactly as they
        were sent.
      </p>
    );
  }

  return (
    <div className="form-responses">
      <p className="form-responses__count">
        Showing {Math.min(shown, responses.length)} of {responses.length} responses, newest
        first — the rows of the {items.length} in view that are recorded as a form
        submission.
      </p>

      <div className="form-responses__list">
        {responses.slice(0, shown).map((item) => {
          const handyman = handymanAnswer(item);
          const files = item.attachmentCount ?? 0;
          return (
            <article key={item.id} className="form-responses__card">
              <header>
                {/*
                  The reference where the job has one. Imported monday rows do
                  not, so they fall back to monday's own Name rather than to the
                  internal id, which identifies the row to nobody.
                */}
                <strong>{item.reference?.trim() || item.title?.trim() || item.id}</strong>
                <span>{formatDate(item.requestedAt)}</span>
              </header>

              <dl>
                <dt>Location</dt>
                <dd>{item.location || "—"}</dd>
                <dt>Manager</dt>
                <dd>{item.requester || "—"}</dd>
                <dt>Contact number</dt>
                <dd>{item.contact || "—"}</dd>
                <dt>Date Requested</dt>
                <dd>{formatDate(item.requestedAt)}</dd>
                <dt>Engineer Required</dt>
                <dd>{item.engineer || "—"}</dd>
                {/* monday shows this answer only when it was asked. */}
                {handyman && (
                  <>
                    <dt>Handyman Required</dt>
                    <dd>{handyman}</dd>
                  </>
                )}
                <dt>Description of Works to be done</dt>
                <dd className="form-responses__long">{submittedDescription(item) || "—"}</dd>
                <dt>Pictures of Maintenance Issue</dt>
                <dd>
                  {files > 0 ? (
                    <span className="form-responses__files">
                      <Icon name="paperclip" size={13} />
                      {files} {files === 1 ? "file" : "files"}
                    </span>
                  ) : (
                    "None attached"
                  )}
                </dd>
                <dt>Status</dt>
                <dd>{item.priority || "—"}</dd>
              </dl>

              {onOpen && (
                <button type="button" onClick={() => onOpen(item)}>
                  Open the job this became
                </button>
              )}
            </article>
          );
        })}
      </div>

      {shown < responses.length && (
        <button
          type="button"
          className="form-responses__more"
          onClick={() => setShown(shown + RESPONSE_PAGE)}
        >
          Show {Math.min(RESPONSE_PAGE, responses.length - shown)} more
        </button>
      )}
    </div>
  );
}

/* ── Table — monday view 9116879, a second TableBoardView ────────────────── */

/**
 * The 25 monday columns, in monday's order.
 *
 * `move` is dropped: it is MAINTSUPP's own "move to group" control, which
 * monday keeps on the row menu rather than as a column, and a flat table has no
 * groups to move a row between.
 */
const FLAT_COLUMNS = columnLabels.filter((column) => column.key !== "move");

const DATE_COLUMNS = new Set<ColumnKey>(["requested", "completed", "timeline", "nextUpdate"]);
const COUNT_COLUMNS = new Set<ColumnKey>(["issuePictures", "completedPictures", "files"]);

/**
 * What one cell sorts on and what it reads as.
 *
 * Sorting reuses `systemColumnSortValue`, the same function the main table
 * sorts by, so a column cannot order one way here and another way there. Two
 * columns are read differently on purpose:
 *
 *  - `name` shows the job's own title. The main table's Name cell falls back to
 *    how the job arrived ("Incoming form answer"), which is monday's behaviour
 *    for an unnamed row but useless as a whole column of identical text.
 *  - `subitems` is counted from the rows in view. `systemColumnSortValue`
 *    returns a constant there because the grid renders children inline.
 */
function flatCell(item: FormItem, key: ColumnKey, children: number) {
  if (key === "name") {
    /* `displaySource` only separates "Manual" from everything else, and a
       shared-link submission is one of the everything else — narrowed here
       rather than widening that function's argument, which several other
       callers pass a strictly-typed record to. */
    const title =
      item.title?.trim() ||
      displaySource(item.source === "Manual" ? "Manual" : "Portal form");
    return { sort: title as string | number, text: title };
  }
  if (key === "subitems") {
    return { sort: children, text: children ? String(children) : "—" };
  }

  const value = systemColumnSortValue(item as unknown as MaintenanceRequest, key);

  if (DATE_COLUMNS.has(key)) {
    const stamp = typeof value === "number" && Number.isFinite(value) ? value : null;
    return { sort: stamp ?? Number.NEGATIVE_INFINITY, text: stamp === null ? "—" : formatDate(new Date(stamp).toISOString()) };
  }
  if (key === "cost") {
    const amount = typeof value === "number" && Number.isFinite(value) ? value : null;
    return { sort: amount ?? Number.NEGATIVE_INFINITY, text: formatMoney(amount) };
  }
  if (COUNT_COLUMNS.has(key)) {
    const count = Number(value) || 0;
    return { sort: count, text: count ? String(count) : "—" };
  }

  const text = String(value ?? "").trim();
  return { sort: text, text: text || "—" };
}

/**
 * Table — monday's second table view.
 *
 * The difference from Main table is that this one has no groups. monday keeps
 * both because the grouped board is 38 groups deep and unusable when what you
 * want is "every job, one list, sorted by cost". Every column is here, in
 * monday's column order, and any of them sorts.
 */
export function FlatTableView({
  items,
  onOpen,
}: {
  items: BoardItem[];
  onOpen?: (item: BoardItem) => void;
}) {
  const [sortKey, setSortKey] = useState<ColumnKey>("requested");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");

  const childCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      if (!item.parentId) continue;
      counts.set(item.parentId, (counts.get(item.parentId) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  const rows = useMemo(() => {
    const decorated = items.map((item) => ({
      item: item as FormItem,
      children: childCounts.get(item.id) ?? 0,
    }));
    return decorated.sort((left, right) => {
      const a = flatCell(left.item, sortKey, left.children).sort;
      const b = flatCell(right.item, sortKey, right.children).sort;
      const comparison =
        typeof a === "number" && typeof b === "number"
          ? a - b
          : String(a).localeCompare(String(b), "en-GB");
      return direction === "desc" ? -comparison : comparison;
    });
  }, [items, childCounts, sortKey, direction]);

  function sortBy(key: ColumnKey) {
    if (key === sortKey) {
      setDirection(direction === "asc" ? "desc" : "asc");
      return;
    }
    setSortKey(key);
    setDirection("asc");
  }

  if (!items.length) {
    return (
      <p className="view-empty">
        No items match the current filters. This tab lists every job on the board as one
        flat list — no groups — so clearing the board&rsquo;s filters will fill it.
      </p>
    );
  }

  return (
    <div className="flat-table">
      <p className="flat-table__hint">
        Every job in view as one list, ungrouped — a second table view. All{" "}
        {FLAT_COLUMNS.length} columns are shown; any heading sorts.
      </p>

      <div className="flat-table__scroll">
        <table>
          <thead>
            <tr>
              {FLAT_COLUMNS.map((column) => {
                const active = column.key === sortKey;
                return (
                  <th key={column.key} scope="col" aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}>
                    <button type="button" onClick={() => sortBy(column.key)}>
                      {column.label}
                      {active && <em aria-hidden="true">{direction === "asc" ? "▲" : "▼"}</em>}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ item, children }) => (
              <tr key={item.id}>
                {FLAT_COLUMNS.map((column, index) => {
                  const { text } = flatCell(item, column.key, children);
                  return (
                    <td key={column.key} title={text}>
                      {index === 0 && onOpen ? (
                        <button type="button" onClick={() => onOpen(item)}>
                          {text}
                        </button>
                      ) : (
                        text
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Build Vibe view — monday view 45948434, app 15528052 ────────────────── */

/**
 * Build Vibe view is a monday APP, not a board view.
 *
 * On monday this tab opens Vibe, monday's in-board app builder: a surface for
 * assembling a small custom app against this board's data. MAINTSUPP has no app
 * builder, and drawing a fake canvas would misrepresent what the product does.
 *
 * So the panel says what the tab is, and then shows the thing an app built here
 * would be built from — the board's own figures, counted from the rows in view.
 * That keeps the tab in monday's order and honest at the same time.
 */
export function BuildVibeView({ items }: { items: BoardItem[] }) {
  const figures = useMemo(() => {
    const rows = items as FormItem[];
    const open = rows.filter((item) => !isComplete(item));
    const spend = rows.reduce((total, item) => total + (item.cost ?? 0), 0);
    return [
      { label: "Items in view", value: String(rows.length) },
      { label: "Open", value: String(open.length) },
      { label: "Completed", value: String(rows.length - open.length) },

      { label: "Form responses", value: String(formResponses(rows).length) },
      {
        label: "Urgent and open",
        value: String(
          open.filter((item) => (item.priority ?? "").toLowerCase() === "urgent").length,
        ),
      },
      {
        label: "Files attached",
        value: String(rows.reduce((total, item) => total + (item.attachmentCount ?? 0), 0)),
      },
      { label: "Recorded cost", value: formatMoney(spend) },
      { label: "Columns on the board", value: String(FLAT_COLUMNS.length) },
    ];
  }, [items]);

  return (
    <div className="vibe-view">
      <header className="vibe-view__head">
        <span className="vibe-view__badge">
          <Icon name="spark" size={14} />
          App view
        </span>
        <h3>Build Vibe view</h3>
        <p>
          This is an app-style board view rather than a table, board or calendar. On the
          board this one was rebuilt from it was an installed app —{" "}
          <strong>Vibe, app 15528052</strong> — whose panel was an in-board app builder.
          MAINTSUPP has no app builder, so rather than draw a canvas that does nothing,
          the tab shows what an app built against this board would read: the board&rsquo;s
          own figures, counted from the rows currently in view.
        </p>
      </header>

      <ul className="vibe-view__figures">
        {figures.map((figure) => (
          <li key={figure.label}>
            <span>{figure.label}</span>
            <strong>{figure.value}</strong>
          </li>
        ))}
      </ul>

      <p className="vibe-view__foot">
        A job counts as complete when its Status is &ldquo;{DONE_STATUS}&rdquo; — the
        board&rsquo;s own done flag — or it carries a completion date. Fix Tracker is the
        other app tab on this board (app 22247989) and it is fully rebuilt; both carry the
        app glyph in the tab strip, which is how an app tab is marked.
      </p>
    </div>
  );
}
