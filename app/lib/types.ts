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
  source: "Portal form" | "Manual";
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
  name: string;
  kind: string;
  site: string;
  requestId: string | null;
  uploadedAt: string;
  size: string;
  status: "Current" | "Expiring soon" | "Archived";
}
