/**
 * Board model — types, option seeds and column definitions.
 *
 * Extracted from live-board.tsx (Stage 8, item H1). Pure data and types only:
 * no JSX, no hooks, no side effects, so it can be imported anywhere without
 * pulling the board component into the bundle.
 */
import {
  maintenanceColumns,
  maintenanceGroups as maintenanceGroupSeeds,
  maintenanceOptions,
  maintenanceSubitemOptions,
  maintenanceUiColumns,
} from "../../../db/monday-board-spec";
import type { IconName } from "../../components";
import type {
  BoardColumnType,
  BoardOptionColumn,
  MaintenanceBoardColumn,
  MaintenanceBoardFilePreview,
  MaintenanceGroup,
  MaintenanceGroupItem,
  MaintenanceRequest,
  RequestStage,
} from "../../lib/types";

export type EditableFields = Partial<
  Pick<
    MaintenanceRequest,
    | "source"
    | "description"
    | "location"
    | "requester"
    | "contact"
    | "category"
    | "engineer"
    | "tier"
    | "priority"
    | "status"
    | "contractor"
    | "assignee"
    | "requestedAt"
    | "completedAt"
    | "dueAt"
    | "nextUpdateAt"
    | "cost"
    | "approvedBy"
    | "invoice"
    | "formUrl"
  >
>;

export type ColumnKey =
  | "name"
  | "location"
  | "description"
  | "tier"
  | "engineer"
  | "priority"
  | "label"
  | "status"
  | "contractor"
  | "assignee"
  | "requested"
  | "completed"
  | "timeline"
  | "requester"
  | "nextUpdate"
  | "issuePictures"
  | "completedPictures"
  | "cost"
  | "approvedBy"
  | "invoice"
  | "files"
  | "number"
  | "storeLocation"
  | "formView"
  | "subitems"
  | "move";

export type ThemePreference = "system" | "light" | "dark";

export type BoardDateIcon =
  | "clock-green"
  | "notice-green"
  | "check-green"
  | "arrow-green"
  | "help-green"
  | "clock-red"
  | "warning-red"
  | "back-red"
  | "close-red"
  | "bolt-blue"
  | "warning-orange"
  | "rocket-blue"
  | "smile-grey"
  | "important-grey";

export type BoardDateMetadata = {
  date: string;
  time: string;
  icon: BoardDateIcon | "";
};

export const boardDateIconOptions: Array<{
  id: BoardDateIcon;
  label: string;
  color: string;
  icon?: IconName;
  glyph?: string;
}> = [
  { id: "clock-green", label: "On time", color: "#19835f", icon: "clock" },
  { id: "notice-green", label: "Notice", color: "#19835f", glyph: "!" },
  { id: "check-green", label: "Complete", color: "#19835f", icon: "check" },
  { id: "arrow-green", label: "Moving", color: "#19835f", icon: "arrow" },
  { id: "help-green", label: "Question", color: "#19835f", glyph: "?" },
  { id: "clock-red", label: "Late", color: "#c83e3e", icon: "clock" },
  { id: "warning-red", label: "Warning", color: "#c83e3e", icon: "alert" },
  { id: "back-red", label: "Return", color: "#c83e3e", glyph: "←" },
  { id: "close-red", label: "Stopped", color: "#c83e3e", icon: "close" },
  { id: "bolt-blue", label: "Fast", color: "#079a90", glyph: "ϟ" },
  { id: "warning-orange", label: "Attention", color: "#a66507", icon: "alert" },
  { id: "rocket-blue", label: "Launch", color: "#12b5aa", glyph: "▲" },
  { id: "smile-grey", label: "Good", color: "#667889", glyph: "☺" },
  { id: "important-grey", label: "Important", color: "#667889", glyph: "!" },
];

export const boardDateIconIds = new Set<BoardDateIcon>(
  boardDateIconOptions.map((option) => option.id),
);

export type Option = {
  id?: string;
  value: string;
  label?: string;
  color: string;
  text?: string;
  active?: boolean;
  system?: boolean;
};

/**
 * Client-side fallback groups — shown only for the moment before `/api/board`
 * answers with the real ones.
 *
 * Derived from `monday-board-spec.ts`. These were four hand-written entries
 * ("Incoming requests", "Jobs booked", "Needs attention", "Recently completed")
 * that matched neither the seed nor monday, so the board flashed a group list
 * it then replaced. Stage keys come from the same table the seed uses.
 */
const FALLBACK_STAGE_BY_GROUP_KEY: Record<string, RequestStage> = {
  topics: "Incoming",
  "jobs-booked": "Booked",
  "needs-attention": "Attention",
  "completed-2026-08": "Completed",
};

export const fallbackGroups: MaintenanceGroup[] = maintenanceGroupSeeds.map(
  (group, position) => ({
    id: `group-${group.key}`,
    name: group.name,
    color: group.colour,
    stageKey: FALLBACK_STAGE_BY_GROUP_KEY[group.key] ?? null,
    position,
  }),
);

export const groupColors = [
  "#579bfc",
  "#00c875",
  "#fdab3d",
  "#a25ddc",
  "#e2445c",
  "#0086c0",
  "#ff642e",
  "#037f4c",
];

/**
 * Client-side fallback options — used only until `/api/board` answers with the
 * option rows an admin actually configured.
 *
 * Derived from `monday-board-spec.ts` so the fallback cannot drift from the
 * seed. Hand-written copies of these lists had already diverged: they carried
 * "Blocked - Awaiting information" for monday's "Blocked - Awaiting Response",
 * a "High" priority monday does not have, and six statuses that exist nowhere
 * on the board. A chip rendered from the fallback disagreed with the same chip
 * rendered from the database.
 */
function toOptions(setKey: string): Option[] {
  return (maintenanceOptions[setKey] ?? []).map((entry) => ({
    value: entry.value,
    label: entry.label === entry.value ? undefined : entry.label,
    color: entry.colour,
    text: entry.textColour,
  }));
}

export const tierOptions: Option[] = toOptions("tier_level");
export const engineerOptions: Option[] = toOptions("engineer_required");
export const priorityOptions: Option[] = toOptions("priority");
export const labelOptions: Option[] = toOptions("maintenance_label");
export const statusOptions: Option[] = toOptions("maintenance_status");
export const storeLocationOptions: Option[] = toOptions("store_location");
/** Monday's subitem board (1164003119) carries its own three-label status. */
export const subitemStatusOptions: Option[] = (
  maintenanceSubitemOptions.subitem_status ?? []
).map((entry) => ({
  value: entry.value,
  label: entry.label === entry.value ? undefined : entry.label,
  color: entry.colour,
  text: entry.textColour,
}));

export const editableFallbackOptions: Record<BoardOptionColumn, Option[]> = {
  tier: tierOptions,
  engineer: engineerOptions,
  priority: priorityOptions,
  label: labelOptions,
  status: statusOptions,
  storeLocation: storeLocationOptions,
};

export type SystemColumnDefinition = {
  key: ColumnKey;
  label: string;
  type: BoardColumnType;
  width: number;
};

/**
 * The board's column set, from `monday-board-spec.ts`.
 *
 * This was the third hand-written copy of the same 25 columns — alongside
 * `systemBoardColumns` in the board route and `seedColumns` in the database
 * seed. All three now read the one capture, so a column cannot be renamed,
 * retyped or resized in one place and stay stale in the other two.
 *
 * All 25 columns are rendered, `subitems` included.
 */
export const columnLabels: SystemColumnDefinition[] = [
  ...maintenanceColumns,
  ...maintenanceUiColumns,
].map((column) => ({
  key: column.key as ColumnKey,
  label: column.title,
  type: column.type as BoardColumnType,
  width: column.width,
}));

export const systemColumnDefaultWidths = new Map(
  columnLabels.map((column) => [column.key, column.width]),
);

export const mobileSystemColumnDefaultWidths: Partial<Record<ColumnKey, number>> = {
  name: 150,
  location: 130,
  description: 180,
  tier: 112,
  engineer: 126,
  priority: 112,
  label: 118,
  status: 145,
  contractor: 135,
  assignee: 130,
  requested: 130,
  completed: 130,
  timeline: 150,
  requester: 140,
  nextUpdate: 130,
  issuePictures: 170,
  completedPictures: 170,
  cost: 115,
  approvedBy: 130,
  invoice: 120,
  files: 105,
  number: 135,
  storeLocation: 160,
  formView: 120,
  move: 145,
};

export const fallbackSystemColumns: MaintenanceBoardColumn[] = columnLabels.map(
  (column, position) => ({
    id: `column-system-${column.key}`,
    key: column.key,
    title: column.label,
    type: column.type,
    position: position * 1000,
    width: column.width,
    settings: { wrap: false },
    system: true,
  }),
);

export type BoardDisplayColumn =
  | {
      kind: "system";
      key: ColumnKey;
      column: MaintenanceBoardColumn;
    }
  | {
      kind: "custom";
      column: MaintenanceBoardColumn;
    };

export type MaintenanceBoardSnapshotColumn = {
  kind: BoardDisplayColumn["kind"];
  key: string | null;
  column: MaintenanceBoardColumn;
};

export type MaintenanceBoardSnapshot = {
  columns: MaintenanceBoardSnapshotColumn[];
  cellValues: Record<string, string>;
  fileCounts: Record<string, number>;
  /** First few files per cell, so a cell can draw thumbnails rather than a count. */
  filePreviews: Record<string, MaintenanceBoardFilePreview[]>;
  groups: MaintenanceGroup[];
  items: MaintenanceGroupItem[];
};

export type BoardDropTarget = {
  groupId: string;
  beforeRequestId: string | null;
};

export type BoardDragItem = {
  request: MaintenanceRequest;
  sourceGroupId: string;
};

export type ColumnTypeDefinition = {
  type: BoardColumnType;
  label: string;
  description: string;
  icon: IconName;
  color: string;
  section: "Essentials" | "Super useful" | "More columns";
};

export const columnTypeDefinitions: ColumnTypeDefinition[] = [
  {
    type: "status",
    label: "Status",
    description: "Colour-coded workflow labels",
    icon: "list",
    color: "#19835f",
    section: "Essentials",
  },
  {
    type: "dropdown",
    label: "Dropdown",
    description: "Pick one option from a list",
    icon: "chevron",
    color: "#087f78",
    section: "Essentials",
  },
  {
    type: "text",
    label: "Text",
    description: "Short notes or reference text",
    icon: "document",
    color: "#df5a25",
    section: "Essentials",
  },
  {
    type: "date",
    label: "Date",
    description: "Choose a calendar date",
    icon: "calendar",
    color: "#1b4662",
    section: "Essentials",
  },
  {
    type: "people",
    label: "People",
    description: "Assign a person",
    icon: "user",
    color: "#087f78",
    section: "Essentials",
  },
  {
    type: "number",
    label: "Numbers",
    description: "Costs, quantities or scores",
    icon: "chart",
    color: "#a66507",
    section: "Essentials",
  },
  {
    type: "files",
    label: "Files",
    description: "Images, videos and documents",
    icon: "folder",
    color: "#f06b35",
    section: "Super useful",
  },
  {
    type: "timeline",
    label: "Timeline",
    description: "Start and end dates",
    icon: "clock",
    color: "#1b4662",
    section: "Super useful",
  },
  {
    type: "checkbox",
    label: "Checkbox",
    description: "Simple yes or no",
    icon: "check",
    color: "#a66507",
    section: "Super useful",
  },
  {
    type: "long_text",
    label: "Long text",
    description: "Detailed notes",
    icon: "message",
    color: "#087f78",
    section: "More columns",
  },
  {
    type: "email",
    label: "Email",
    description: "Email addresses",
    icon: "message",
    color: "#0b2033",
    section: "More columns",
  },
  {
    type: "phone",
    label: "Phone",
    description: "Telephone numbers",
    icon: "user",
    color: "#19835f",
    section: "More columns",
  },
  {
    type: "link",
    label: "Link",
    description: "Website or document links",
    icon: "arrow",
    color: "#123149",
    section: "More columns",
  },
];
