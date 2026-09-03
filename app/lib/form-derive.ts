import {
  maintenanceFormConfiguration,
  type FormQuestion,
} from "../../db/monday-board-spec";
import type { StoredFormConfig } from "./form-config";

/**
 * A FORM'S QUESTIONS, DERIVED FROM THE BOARD'S OWN COLUMNS.
 *
 * W2 requirement B. Every board that is a register — the canonical job board,
 * Store Documentation, and every instance a workspace section generates — must
 * be able to have a form OF ITS OWN: its own questions, its own settings, its
 * own public link, its own submissions. Before this module there was exactly
 * one form in the product, seeded for `board_id = 'maintenance'` by
 * `ensureFormBuilder` in db/init.ts, and every other board either borrowed it
 * or was refused.
 *
 * WHY DERIVED RATHER THAN COPIED, WHICH IS THE WHOLE POINT
 *
 * The obvious implementation is "if the board came from the Jobs template, copy
 * `maintenanceFormConfiguration`". That is the defect this workstream exists to
 * remove, one layer further in: it makes a BOARD KEY — or a template name,
 * which is a board key with extra steps — decide what a form asks. The moment
 * an operator deletes a column on their instance, or renames one, or adds one,
 * the copied form is asking about a board that no longer exists, and the copy
 * has no way to know.
 *
 * So the questions come from the instance's own `maintenance_board_columns`.
 * A Jobs instance still gets EXACTLY the canonical form, question for question,
 * because its columns ARE the canonical board's columns and this walks them; a
 * generic six-column register gets six questions about its own six columns; and
 * an instance whose operator has deleted "Cost of Works" has no Cost of Works
 * question, without anybody writing a branch for it.
 *
 * WHERE THE CANONICAL DEFAULT STILL WINS, AND WHY
 *
 * A column knows its title and its type. It does not know that "Pictures of
 * Maintenance Issue" carries the sentence "Any request without clear pictures
 * and videos will be declined", or that the Priority column is asked under
 * monday's heading "Status", or that Location is a single-select over the site
 * register rather than the free-text box its column type implies. That
 * knowledge is in `maintenanceFormConfiguration`, read from monday's live form,
 * and re-deriving it from a column type would produce a WORSE form than the one
 * the client already uses.
 *
 * So a column that HAS a canonical question is asked with that question,
 * verbatim. The lookup is by `column_key` — the column's own identity — never
 * by board key, board kind or template name, which is exactly the difference
 * between derived and copied: the canonical questions arrive because the
 * columns are there, and leave when the columns do.
 */

/**
 * The columns this needs, a subset of a `maintenance_board_columns` row.
 *
 * `id` is carried as well as `key` because it is the value
 * `maintenance_board_cells.column_id` holds: a derived question that is not one
 * of the canonical ones is identified by its column's ROW ID, so an answer to
 * it has a cell to land in without the submit route having to map anything.
 */
export type FormSourceColumn = {
  id: string;
  key: string;
  title: string;
  type: string;
  required: boolean;
  /** Backed by a field on `maintenance_requests` rather than by a cell. */
  system: boolean;
};

/**
 * `column_key` -> the canonical question that column is asked with.
 *
 * Read off the two specs in `db/monday-board-spec.ts` side by side: the left is
 * `maintenanceColumns[].key`, the right is the id of the question in
 * `maintenanceFormConfiguration.questions` that writes to it. Eighteen of the
 * board's twenty-six columns are asked; the other eight — `name`, `tier`,
 * `label`, `contractor`, `files`, `storeLocation`, `formView` and the Group
 * picker — are not questions on monday's form either, so they are absent here
 * rather than suppressed later.
 *
 * The three that look wrong and are not:
 *
 *   · `priority` -> `status`. monday titles the priority question "Status", and
 *     `CANONICAL_OPTION_SETS` in form-projection.ts maps question `status` onto
 *     the `priority` option set. The submit route reads `answerFor("status")`
 *     into the job's `priority`.
 *   · `status` -> `status1`. The job's workflow status is the HIDDEN question.
 *   · `requester` -> `short_text64`, titled "Manager". The board column is
 *     "Job Requested by"; they are the same field under two names.
 */
export const CANONICAL_QUESTION_BY_COLUMN: Readonly<Record<string, string>> = {
  location: "single_selecty9rcyhe",
  requester: "short_text64",
  number: "numbertb4g1z46",
  requested: "date",
  engineer: "single_select",
  description: "short_text",
  issuePictures: "upload_file",
  priority: "status",
  status: "status1",
  assignee: "person",
  completedPictures: "dup__of_upload_pictures_of_work_needed",
  cost: "numbers",
  approvedBy: "text",
  timeline: "timeline",
  nextUpdate: "date_mkmts6wz",
  completed: "date2",
  subitems: "subitems",
  invoice: "text6",
};

/**
 * A column type, as the question type that can ask about it.
 *
 * The board has TWO column vocabularies — see the note on `GenericColumn` in
 * app/lib/generic-board-template.ts — so both spellings of the same idea are
 * listed. Anything unrecognised falls back to a short text box, which is the
 * one question type that can hold any answer: a column this map has not learnt
 * about yet produces a usable question rather than no question at all.
 */
const QUESTION_TYPE_BY_COLUMN_TYPE: Readonly<Record<string, FormQuestion["type"]>> = {
  text: "ShortText",
  long_text: "LongText",
  longtext: "LongText",
  status: "SingleSelect",
  dropdown: "SingleSelect",
  single_select: "SingleSelect",
  date: "Date",
  timeline: "DateRange",
  files: "File",
  file: "File",
  people: "People",
  person: "People",
  number: "Number",
  numbers: "Number",
  phone: "Number",
  rating: "Number",
  subitems: "Subitems",
  link: "ShortText",
  email: "ShortText",
  checkbox: "ShortText",
};

/**
 * Columns that are never a question, whatever board they are on.
 *
 * `name` is the row's own title. The public submit route computes it from the
 * first line of the description (`requestTitle`), and monday's own form has
 * `includeNameQuestion: false` for the same reason — a form that asks a store
 * manager to name their ticket gets "asdf".
 *
 * `move` is the Group picker, a control rather than a field: letting a
 * submission choose its own group is exactly the mass assignment the submit
 * route refuses, and offering the control would be inviting it.
 */
const NEVER_ASKED: ReadonlySet<string> = new Set(["name", "move"]);

const CANONICAL_QUESTIONS: ReadonlyMap<string, FormQuestion> = new Map(
  (maintenanceFormConfiguration.questions as unknown as FormQuestion[]).map(
    (question) => [question.id, question],
  ),
);

/** The page block monday puts at the head of every form. */
const PAGE_BLOCK_ID = "page_block__classic_default";

/**
 * The questions a board's columns produce, in the order the form asks them.
 *
 * TWO SHAPES, DECIDED BY THE COLUMNS AND NOTHING ELSE.
 *
 * A board whose columns include at least one the canonical form knows about is
 * a JOBS-SHAPED board, and its form is the canonical one narrowed to the
 * columns actually present. Its remaining cell-backed columns become HIDDEN
 * questions — the same state monday's ten hidden questions are in — so an
 * operator can un-hide one in the builder and its answer has somewhere to go,
 * while the form a submitter opens is unchanged.
 *
 * A board with no canonical column at all — a register for CCTV, a section
 * created from the generic template — has no canonical form to narrow, so every
 * one of its columns becomes a VISIBLE question. Hiding them would produce a
 * form with no questions on it, which is not a default, it is a bug with a
 * plausible explanation.
 */
export function deriveFormQuestions(columns: readonly FormSourceColumn[]): FormQuestion[] {
  const usable = columns.filter((column) => !NEVER_ASKED.has(column.key));

  const canonical: FormQuestion[] = [];
  const derived: FormQuestion[] = [];
  const claimed = new Set<string>();

  for (const column of usable) {
    const questionId = CANONICAL_QUESTION_BY_COLUMN[column.key];
    const template = questionId ? CANONICAL_QUESTIONS.get(questionId) : undefined;
    if (template && !claimed.has(template.id)) {
      claimed.add(template.id);
      /*
       * Deep-cloned. The canonical configuration is a module-level constant, so
       * handing out a reference would let one board's edits reach into every
       * form derived afterwards on the same worker — the same reason
       * `defaultConfig()` in form-config.ts clones.
       */
      canonical.push(structuredClone(template));
    }
  }

  const jobsShaped = canonical.length > 0;

  for (const column of usable) {
    if (jobsShaped && CANONICAL_QUESTION_BY_COLUMN[column.key]) continue;
    /*
     * A system column has no cell to store an answer in — its value is a field
     * on `maintenance_requests`, written by the routes that own that record —
     * so a question for one would be a field a submitter fills in and nothing
     * can keep. Only the canonical questions above may target a system column,
     * because the submit route writes those seven fields by hand.
     */
    if (column.system) continue;
    derived.push({
      /*
       * THE COLUMN'S ROW ID IS THE QUESTION ID. `maintenance_board_cells` is
       * keyed by (request, column_id), so an answer to this question already
       * names the cell it belongs in and the submit route needs no second
       * mapping to file it.
       */
      id: column.id,
      type: QUESTION_TYPE_BY_COLUMN_TYPE[column.type] ?? "ShortText",
      title: column.title,
      description: null,
      visible: !jobsShaped,
      /* A column an operator marked required stays required when it is asked. */
      required: !jobsShaped && column.required,
      options: null,
      showIf: null,
    });
  }

  const pageBlock = CANONICAL_QUESTIONS.get(PAGE_BLOCK_ID);
  return [
    ...(pageBlock ? [structuredClone(pageBlock)] : []),
    ...canonical,
    ...derived,
  ];
}

/**
 * The whole stored configuration for a board's own form.
 *
 * `order` follows monday's `sortedQuestionsList` for the questions that have a
 * canonical identity, then the derived ones in the board's own column order.
 * That is what makes a Jobs instance's form read in the same order as the job
 * board's — Location, Manager, Contact number, Date, Engineer, Description,
 * Pictures, Status — rather than in whatever order the columns happen to sit in
 * the grid, which a board owner reorders for a different reason entirely.
 */
export function deriveFormConfig(columns: readonly FormSourceColumn[]): StoredFormConfig {
  const questions = deriveFormQuestions(columns);
  const present = new Set(questions.map((question) => question.id));

  const canonicalOrder = maintenanceFormConfiguration.order.filter((id) => present.has(id));
  const ordered = new Set(canonicalOrder);
  const order = [
    ...canonicalOrder,
    ...questions.map((question) => question.id).filter((id) => !ordered.has(id)),
  ];

  const features = structuredClone(
    maintenanceFormConfiguration.features,
  ) as StoredFormConfig["features"];
  /*
   * `itemGroupId` NAMES A GROUP ROW, and a group belongs to one board.
   *
   * It is null on the canonical seed and it must stay null here whatever the
   * source said, because a group id carried across from another board is the
   * cross-board write this workstream exists to close: the submit route
   * resolves this setting to a `stage_key` and would file the answer into
   * whichever board owns that group. Null means "this board's first group",
   * which the submit route resolves against the form's own board.
   */
  features.board = { ...features.board, itemGroupId: null };

  return {
    order,
    questions,
    features,
    appearance: structuredClone(
      maintenanceFormConfiguration.appearance,
    ) as StoredFormConfig["appearance"],
    accessibility: structuredClone(maintenanceFormConfiguration.accessibility),
    tags: [],
  };
}
