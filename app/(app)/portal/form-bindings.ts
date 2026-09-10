/**
 * WHICH COLUMN A QUESTION FILLS — the browser's copy of the one mapping that
 * makes a form answer land somewhere.
 *
 * ── THE RULE THIS FILE EXISTS TO MAKE ENFORCEABLE ─────────────────────────
 *
 * A question is bound to a column BY COLUMN ID, never by its label and never by
 * its position. Two of the three are tempting and both are wrong here:
 *
 *   · By label, because the builder shows labels. But a column title is edited
 *     from the board's own header menu by somebody who is not thinking about a
 *     form, and `features.board.syncQuestionAndColumnsTitles` exists precisely
 *     to rename questions when it happens. A binding by label would silently
 *     re-point — or silently break — on a rename.
 *   · By index, because `order` is an array. But a column added, deleted or
 *     dragged on the board shifts every index after it, so an index binding
 *     files today's answers into yesterday's column and nothing reports it.
 *
 * So the id is the binding, and there are two kinds of id:
 *
 *   · a DERIVED question carries the column's own row id, because
 *     `maintenance_board_cells` is keyed by (request, column_id) — see
 *     `deriveFormQuestions` in app/lib/form-derive.ts. The answer already names
 *     the cell it belongs in.
 *   · a CANONICAL question carries monday's question id, because the submit
 *     route reads those eighteen BY NAME into first-class fields of a work
 *     order (`answerFor("short_text64")` is the manager's name, not a cell).
 *
 * ── WHY THE MAP IS COPIED AND HOW THE COPY IS KEPT HONEST ─────────────────
 *
 * `CANONICAL_QUESTION_BY_COLUMN` in `app/lib/form-derive.ts` is the original.
 * That module imports the whole captured monday specification, which is a large
 * server-side constant, so importing it into the builder would put it in every
 * browser's bundle to read eighteen short strings. It is transcribed here
 * instead, and `tests/form-editor-model.test.mjs` reads BOTH files and requires
 * them to be identical — so a canonical question added or renamed there fails
 * this file's test on the same day rather than quietly turning every form in the
 * product into a page of "has nowhere to save its answer".
 */

export const CANONICAL_QUESTION_BY_COLUMN_KEY: Readonly<Record<string, string>> = {
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

/** The same map read the other way: question id → the column key it fills. */
export const COLUMN_KEY_BY_CANONICAL_QUESTION: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(CANONICAL_QUESTION_BY_COLUMN_KEY).map(([key, id]) => [id, key]),
  );

/** Every question id the submit route handles by name. */
export const CANONICAL_QUESTION_IDS: readonly string[] = Object.values(
  CANONICAL_QUESTION_BY_COLUMN_KEY,
);

/** A board column, as `GET /api/board/columns` returns the fields used here. */
export type BuilderColumn = {
  id: string;
  key: string;
  title: string;
  type: string;
  required: boolean;
  /**
   * Backed by a field on `maintenance_requests` rather than by a cell.
   *
   * A system column can only be asked THROUGH a canonical question, because
   * those seven fields are written by hand in the submit route; a derived
   * question pointed at one would collect an answer with no cell to hold it.
   * `deriveFormQuestions` refuses them for the same reason, and the picker
   * below offers them only where a canonical question already claims them.
   */
  system: boolean;
};

/**
 * The question id a column would be asked with.
 *
 * The canonical id where one exists — so the answer reaches the work order's
 * own field — and the column's row id otherwise, which is the cell it lands in.
 */
export function questionIdForColumn(column: BuilderColumn): string {
  return CANONICAL_QUESTION_BY_COLUMN_KEY[column.key] ?? column.id;
}

/** The column a question fills, or null when nothing on the board matches. */
export function columnForQuestion(
  questionId: string,
  columns: readonly BuilderColumn[],
): BuilderColumn | null {
  const canonicalKey = COLUMN_KEY_BY_CANONICAL_QUESTION[questionId];
  if (canonicalKey) {
    return columns.find((column) => column.key === canonicalKey) ?? null;
  }
  return columns.find((column) => column.id === questionId) ?? null;
}

/**
 * The question type a column can be asked with.
 *
 * Mirrors `QUESTION_TYPE_BY_COLUMN_TYPE` in app/lib/form-derive.ts, and for the
 * same reason as the map above: the board has two column vocabularies, so both
 * spellings of an idea are listed, and anything unrecognised becomes a short
 * text box — the one question type that can hold any answer. A column this map
 * has not learnt about yet produces a usable question rather than none.
 */
export const QUESTION_TYPE_BY_COLUMN_TYPE: Readonly<Record<string, string>> = {
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
