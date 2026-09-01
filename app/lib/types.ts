export type Priority = string;

export type RequestStage =
  | "Incoming"
  | "Booked"
  | "Attention"
  | "Completed";

export type EngineerType = string;

export type RequestStatus = string;

export type BoardOptionColumn =
  | "tier"
  | "engineer"
  | "priority"
  | "label"
  | "status"
  // Monday's single_selecty9rcyhe. It is a status column there, with 21 store
  // labels, so it needs an option set like the other five.
  | "storeLocation";

export type BoardColumnType =
  | "status"
  | "dropdown"
  | "text"
  | "long_text"
  | "date"
  | "people"
  | "number"
  | "files"
  | "timeline"
  | "checkbox"
  | "email"
  | "phone"
  | "link"
  // Monday keeps child items on their own board (1164003119). Here they are
  // requests with a parent, and this column is the expander that reveals them.
  | "subitems";

export interface BoardColumnChoice {
  id: string;
  label: string;
  color: string;
  textColor?: string;
}

export interface BoardColumnSettings {
  choices?: BoardColumnChoice[];
  people?: BoardColumnChoice[];
  wrap?: boolean;
  /**
   * The board's saved sort, carried by the column it sorts by.
   *
   * Sorting was `useState` and nothing else, so it lasted until the next
   * reload while column width and visibility beside it did not — the
   * inconsistency an operator notices first. `board_views.sort` is the other
   * candidate home, but views are owned by board-chrome.tsx and the sort is
   * chosen in live-board.tsx; keeping it on the column keeps one component
   * responsible for reading and writing it.
   *
   * NO LONGER AT MOST ONE. Several columns may carry a sort at once — that is
   * what makes a subsort possible — and `sortPriority` below is what orders
   * them. A column carrying a sort with no priority is read as priority 0,
   * which is exactly what every board saved before multi-sort existed looks
   * like, so the old single-column state reads back unchanged.
   */
  sort?: "asc" | "desc";
  /**
   * Where this column sits in the board's ordered sort: 0 is the primary sort,
   * 1 breaks its ties, 2 breaks those, and so on.
   *
   * Meaningless without `sort`, and dropped whenever `sort` is cleared. Ties on
   * the priority itself fall back to column position, so a hand-edited row
   * cannot make the order non-deterministic.
   */
  sortPriority?: number;
  /**
   * This column's filter rule, if it carries one.
   *
   * The board's filter is the set of these across its columns, which is how
   * monday models it: a filter belongs to the column it narrows, so deleting
   * the column deletes its filter with it and no orphan rule can survive.
   * `operator` is one of the operators in views/view-model.ts, and `values`
   * holds as many operands as that operator takes — none, one, or two.
   */
  filter?: { operator: string; values: string[] };
  /**
   * How the board combines its filter rules — "and" (the default) or "or".
   *
   * A BOARD-LEVEL choice stored on each filtered column, deliberately. There is
   * nowhere else for it to live that every board has: `maintenance_board_columns`
   * is the only per-board store this grid already writes to, and Store
   * Documentation has no `board_views` row to hang it on. A change writes to
   * every filtered column at once and the read takes the lowest-position
   * filtered column's answer, so the mirror cannot drift into two answers.
   */
  filterJoin?: "and" | "or";
}

export interface MaintenanceBoardColumn {
  id: string;
  key: string;
  title: string;
  type: BoardColumnType;
  position: number;
  width: number;
  settings: BoardColumnSettings;
  system: boolean;
  /**
   * Whether the board draws this column.
   *
   * `maintenance_board_columns.visible` has existed since Stage 1 and nothing
   * read it: hiding a column lived in a `useState<Set<string>>` in
   * live-board.tsx, so it came back on the next reload. Hiding twelve
   * certificate columns to look at two is exactly the kind of thing an operator
   * does once and expects to stay done, which is why it is carried here rather
   * than in browser state.
   */
  visible: boolean;
  /**
   * Whether the column is frozen against the left edge while the grid scrolls
   * sideways.
   *
   * `maintenance_board_columns.pinned` has existed since Stage 1 and the PATCH
   * route has always accepted it; nothing ever returned it, so the board could
   * store a pin it had no way to draw. The Items column is sticky by
   * construction and is not expressed through this flag — `stickyColumnOffsets`
   * in live-board.tsx lays the two out together.
   */
  pinned?: boolean;
  /**
   * The summary function the group footer runs over this column — "sum",
   * "count", "battery" and the rest, per `summariesFor` in lib/column-types.ts.
   *
   * Stored and server-validated since Stage 1, and likewise never returned, so
   * the seed's own choices — "battery" on Status and Priority, "sum" on Cost of
   * Works, "min"/"max" on the two dates — were written to the database and then
   * ignored by the strip that exists to honour them. Null means "whatever this
   * column's type or key summarises to by default".
   */
  summary?: string | null;
}

export interface MaintenanceBoardCell {
  requestId: string;
  columnId: string;
  value: string;
}

/**
 * What a file column draws in one cell.
 *
 * `count` is the whole truth about how many files are attached. `preview` is
 * the first few, and exists so the board can render actual thumbnails the way
 * monday does rather than a paperclip and a number — with 2,765 photographs on
 * the board, a count tells an operator nothing about whether the right photo is
 * there.
 *
 * Deliberately NOT the full attachment record: no object key, no upload token,
 * no uploader email. A board payload is the widest thing this app sends, and a
 * thumbnail needs an id, a type and a name to draw. `inlineUrl` is derived on
 * the client from the id, so the storage path never reaches the DOM.
 *
 * `byteSize` and `createdAt` were added for the Store Documentation board's
 * document chips. `FileCellFile` — the shape `FileCell` draws — needs both to
 * announce a chip ("Public Liability Certificate 2027.pdf, PDF document,
 * 102 KB") and to print the date under the filename in the viewer. Without them
 * the board passed `files={[]}` and every attached certificate rendered as an
 * anonymous grey digit with no name and no link. Two small scalars per preview
 * row is the smaller lie than a chip that cannot say what it opens; the query
 * that fills them is now scoped to the requested board's own columns, which
 * took the payload from 1,060 preview rows to the board's own.
 */
export interface MaintenanceBoardFilePreview {
  id: string;
  contentType: string;
  originalName: string;
  byteSize: number;
  createdAt: string;
}

export interface MaintenanceBoardFileCount {
  requestId: string;
  columnId: string;
  count: number;
  /** The first few, in upload order. Capped server-side. */
  preview: MaintenanceBoardFilePreview[];
}

export interface BoardColumnOption {
  id: string;
  columnKey: BoardOptionColumn;
  value: string;
  label: string;
  color: string;
  textColor: string;
  active: boolean;
  system: boolean;
  position: number;
}

export type AttachmentKind = "issue" | "completion" | "general";

export interface AttachmentRecord {
  id: string;
  requestId: string;
  kind: AttachmentKind;
  boardColumnId?: string | null;
  originalName: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
  /**
   * Who added it, when the row records one.
   *
   * Optional because the rows imported from monday do not carry an uploader —
   * monday's export names the board, not the person — so the viewer omits the
   * line rather than printing "Added by undefined".
   */
  uploadedByEmail?: string | null;
  inlineUrl: string;
  downloadUrl: string;
}

export interface MaintenanceGroup {
  id: string;
  name: string;
  color: string;
  stageKey: RequestStage | null;
  position: number;
}

export interface MaintenanceGroupItem {
  requestId: string;
  groupId: string;
  position: number;
}

export interface MaintenanceRequest {
  id: string;
  /**
   * The item this one hangs beneath — monday's Subitems column, which keeps
   * children on their own board (1164003119). Here a subitem is a request whose
   * parent is another request, so the whole editing surface already applies to
   * it. `null` on a top-level item.
   */
  parentId?: string | null;
  /**
   * Archived, but not deleted — two different states, as
   * `/api/board/items` has always had them. The column has been on
   * `maintenance_requests` since the board gained an archive; it is declared
   * here because the analytics screens have to be able to leave archived work
   * out of a spend total, and until now they could not see it.
   */
  archived?: boolean;
  source: "Portal form" | "Manual";
  /**
   * The public reference the board mints for a job — "MS-2026-0040".
   *
   * Optional because only rows created through `/api/board/items` carry one;
   * a row added inline on the board has none until it is given one. Declared
   * here because the API has always returned it and the board searches on it:
   * a requester quoting the number from their confirmation email is the one
   * search that must not fail.
   */
  reference?: string | null;
  title: string;
  description: string;
  location: string;
  siteId: string;
  requester: string;
  contact: string;
  category: string;
  engineer: EngineerType;
  tier: number;
  priority: Priority;
  stage: RequestStage;
  status: RequestStatus;
  contractor: string | null;
  /*
   * The canonical reference beside the free text, and the reason a renamed
   * contractor keeps their jobs.
   *
   * `contractor` is what somebody typed — the historical record of who was
   * named. This is who the register says that resolves to: organisation-scoped,
   * exact name, unique match only (`app/lib/contractor-reference.ts`). The API
   * has always returned it; the type simply never declared it, so every screen
   * that wanted to attribute a job to a contractor had no choice but to compare
   * names — and comparing names is what silently zeroed a contractor's whole
   * history the moment they were renamed.
   */
  contractorId: string | null;
  assignee: string | null;
  requestedAt: string;
  dueAt: string | null;
  completedAt: string | null;
  nextUpdateAt: string | null;
  cost: number | null;
  approvedBy?: string | null;
  invoice?: string | null;
  attachmentCount: number;
  issueAttachmentCount?: number;
  completedAttachmentCount?: number;
  generalAttachmentCount?: number;
  formUrl?: string | null;
  commentCount: number;
}

export type RequestDrawerTab =
  | "columns"
  | "updates"
  | "files"
  | "activity"
  | "link";

/**
 * One comment on a job, with its replies.
 *
 * Mirrors `item_updates`, which is monday's "Updates" — the conversation, as
 * distinct from `RequestActivityEntry`, which is the change log. Both appear in
 * the drawer and they are deliberately not merged: one is what people said, the
 * other is what changed.
 */
export interface RequestUpdateFile {
  id: string;
  name: string;
  contentType: string;
  byteSize: number;
  url: string;
  thumbUrl: string;
}

export interface RequestUpdate {
  id: string;
  parentId: string | null;
  authorName: string;
  authorEmail: string | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  /**
   * Files attached to THIS comment, not to the job.
   *
   * monday's updates carry their own assets and they belong to the comment: a
   * quote PDF, a photo of the part. Several imported comments read as orphans
   * without them, naming a document in the body that appeared nowhere.
   */
  files: RequestUpdateFile[];
  /**
   * `👍 Like` — monday has it on every update and every reply.
   *
   * Three fields rather than one number, because the control draws three
   * things: the tally, whether YOUR thumb is filled, and who the others were.
   * `likedBy` is capped server-side at twelve names — it feeds a hover, and
   * past a dozen that is a paragraph rather than a tooltip.
   */
  likeCount: number;
  likedByMe: boolean;
  likedBy: string[];
  replies: Array<Omit<RequestUpdate, "replies">>;
}

export interface RequestActivityEntry {
  id: string;
  action: string;
  actorEmail: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export type ComplianceState =
  | "Compliant"
  | "Expiring soon"
  | "Expired"
  | "Missing"
  | "Not required";

export interface ComplianceItem {
  kind: string;
  state: ComplianceState;
  expiry: string | null;
  fileCount: number;
}

/**
 * M6 — site attributes are `string`, not unions.
 *
 * Site types, statuses and regions are rows in `option_values` that an admin
 * adds and renames without a deploy. A union here would put the compiler in
 * charge of a list the database owns, and adding a fifth site type would become
 * a code change. Values are validated at the API boundary against the option
 * tables instead.
 */
export interface StoreRecord {
  id: string;
  name: string;
  type: string;
  region: string;
  lifecycle: string;
  status: string;
  address: string;
  manager: string;
  openRequests: number;
  /**
   * Annual maintenance budget in pence, or null when none is set.
   *
   * Null is not zero: Spend against budget counts unbudgeted sites
   * separately and says how much of the portfolio it can speak for,
   * rather than reporting them as infinitely over.
   */
  annualBudgetPence: number | null;
  compliance: ComplianceItem[];
}

export interface FileRecord {
  id: string;
  /** The stored filename — `originalName`. Always present. */
  name: string;
  /**
   * The title somebody gave this document, or null for the great majority that
   * have never been named. `documentName` in views/document-register.ts decides
   * which of the two to show; nothing else should.
   */
  title: string | null;
  kind: string;
  /** The document type an operator chose, or null. Falls back to `kind`. */
  documentType: string | null;
  description: string | null;
  site: string;
  /**
   * The site this document is filed against, authoritatively.
   *
   * The register used to derive its Site column by matching the attachment's
   * job against the job list and reading that job's free-text `location`. The
   * row carries a real site id, so the id is what it is filed under and the
   * name is a lookup from it.
   */
  siteId: string | null;
  requestId: string | null;
  uploadedAt: string;
  /** Who uploaded it. Served all along; the register simply never read it. */
  uploadedByEmail: string | null;
  size: string;
  /**
   * `YYYY-MM-DD`, or null when this document has no expiry.
   *
   * Null is not a bad value and must never be rendered as one: most rows in
   * this register are photographs and invoices that cannot expire. The column
   * is CHECK-constrained to that shape on the server, so anything stored here
   * is a real date.
   */
  expiryDate: string | null;
  /** When it was withdrawn from the live register, or null while it is live. */
  archivedAt: string | null;
  archivedBy: string | null;
  /**
   * VERSION LINEAGE. `rootDocumentId` is the id every version of one document
   * shares — served already resolved, so a client never reimplements the
   * `coalesce(root, id)` that version 1 needs. `isCurrent` marks the one
   * version that is the document today.
   */
  rootDocumentId: string;
  versionNo: number;
  isCurrent: boolean;
  /*
   * THERE IS NO `status` FIELD, AND THAT IS THE POINT.
   *
   * It used to be `status: "Current" | "Expiring soon" | "Archived"`, and
   * `loadDocuments` wrote the literal `"Current"` into every row it built from
   * the API — so the register's Status column was a constant with a type
   * around it, and the "Require attention" tile that counted "Expiring soon"
   * could never count anything. The two values that were not "Current" were
   * reachable only from `mock-data.ts`.
   *
   * A document's status is a function of its expiry date and whether it has
   * been archived, both of which are stored above. `documentStatus` in
   * views/document-register.ts derives it from the shared classifier in
   * `app/lib/expiry-status.ts`, so this register and the Compliance Tracker
   * cannot disagree about the same certificate. Nothing may store it back.
   */
  /*
   * WHERE THE BYTES ARE. `/api/files` has always returned these three —
   * `attachmentPayload` in app/api/files/route.ts:130-137 builds
   * `contentType`, `inlineUrl` and `downloadUrl` for every row — and the
   * Documents register threw all three away when it mapped the payload, so a
   * page whose whole job is to be a searchable file register listed files it
   * could not open. Optional because `app/lib/mock-data.ts` also builds
   * `FileRecord`s and has no storage behind them; the drawer treats their
   * absence as "no preview, no download" rather than rendering a dead control.
   */
  inlineUrl?: string;
  downloadUrl?: string;
  contentType?: string;
}
