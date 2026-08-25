"use client";

import {
  Fragment,
  useCallback,
  useDeferredValue,
  useEffect,
  useContext,
  createRef,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import BoardChrome, { type BoardView } from "./board-chrome";
import { viewReplacesGrid } from "./board-view-pane";
import BoardColumnSummary from "./board-column-summary";
import { boardIdentity } from "./board-identity";
import { DEFERRED_GROUP_CLASS, deferredGroupHeight } from "./board-visibility";
import { ColumnSettingsDialog } from "./board-column-settings";
import { chipStyle } from "./chip-ink";
import { Icon } from "../../components";
import { publishBoardOptions } from "../../lib/board-option-registry";
import type {
  AttachmentKind,
  BoardColumnChoice,
  BoardColumnSettings,
  BoardColumnType,
  BoardColumnOption,
  BoardOptionColumn,
  MaintenanceBoardCell,
  MaintenanceBoardColumn,
  MaintenanceBoardFilePreview,
  MaintenanceGroup,
  MaintenanceGroupItem,
  MaintenanceRequest,
  Priority,
  RequestDrawerTab,
  RequestStatus,
} from "../../lib/types";
import {
  EvidenceManager,
  FileHoverPreview,
} from "./evidence-manager";
import { BoardFileCell } from "./cells/board-file-cell";
import { ExpiryCell } from "./cells/expiry-cell";
import { FileCell, boardFileCellFiles } from "./cells/file-cell";
import {
  AnalyticsMetricCard,
  AnalyticsToolbar,
  withinAnalyticsPeriod,
} from "./dashboard-analytics";
import { computeJobMeters, jobMeterTrendLabels } from "./dashboard-meters";
import { PeriodPicker } from "./period-picker";
import { JobsMeterToggle, useCollapsingMeters } from "./jobs-meter-strip";

import {
  type BoardDisplayColumn,
  type BoardResponse,
  type ColumnKey,
  type CompactBoardResponse,
  type EditableFields,
  type MaintenanceBoardSnapshot,
  type MaintenanceBoardSnapshotColumn,
  type Option,
  decodeBoardResponse,
  editableFallbackOptions,
  fallbackGroups,
  fallbackSystemColumns,
  groupColors,
  subitemStatusOptions,
} from "./board-model";
import {
  boardItemName,
  moveBoardItemPlacement,
  systemColumnSortValue,
} from "./board-ordering";
import { useBoardRowDrag } from "./board-row-drag-gesture";
/*
 * The phone's layout preference is VERSIONED, and the reader that knows why
 * lives in its own file — an unversioned stored "cards" outlived the default it
 * was chosen against and kept opening Jobs on the cards. Read that file's
 * header before touching either call below.
 */
import { readMobileLayout, writeMobileLayout } from "./board-mobile-layout";
import {
  customCellKey,
  choiceList,
  customCellDisplay,
  findChoice,
  serializeCustomCellValue,
  shouldCenterBoardCell,
  displayedBoardColumnWidth,
} from "./board-format";
import { AnchoredPopover } from "./overlay/anchored";
import { GroupActionMenu } from "./overlay/group-action-menu";
import {
  MoveToGroupSelect,
  buildBoardItemActions,
  convertToSubitemTitle,
  type BoardItemActionSources,
  type BoardItemActions,
} from "./overlay/item-actions";
import {
  MobileBoardContext,
  MobileCellSheet,
  useRevealBoardPopover,
} from "./board-primitives";
import { BoardMobileSection } from "./board-mobile-list";
import { copyBoardText, downloadBoardCsv } from "./board-export";
import { BoardColumnHeader } from "./board-column-header";
import { ColumnPicker } from "./board-column-picker";
import { BoardFilterPanel, BoardSortPanel, type FilterChoice } from "./board-controls";
import {
  type BoardSortRule,
  type SortDirection,
  addSortRule,
  compareBoardRows,
  flipSortRule,
  moveSortRule,
  readSortRules,
  removeSortRule,
  replaceSortRules,
  sortBoardRows,
  sortDirectionFor,
  sortRuleIndex,
  sortSettingsFor,
} from "./board-sort";
import {
  EMPTY_FILTER,
  type BoardFilterState,
  applyBoardFilter,
  filterKindFor,
  filterSettingsFor,
  findFilterRule,
  isFilterableColumn,
  operatorsFor,
  readFilterState,
  removeFilterRule,
  setFilterRule,
} from "./board-filter";
import {
  stickyColumnOffsets,
  stickyZIndex,
  type StickyColumn,
} from "./board-pinning";
import { withFrozenColumnsLeading } from "./board-column-drag";
import { useColumnHeaderDrag } from "./board-column-drag-gesture";
import { summariesFor } from "../../lib/column-types";
import { useCapability } from "../../lib/client-capabilities";
import {
  type ThemeChoice,
  setThemeChoice,
  useResolvedTheme,
  useThemeChoice,
} from "./theme";

// portal-app imports these from here; re-exported so the split is invisible
// to callers.
export type {
  MaintenanceBoardSnapshot,
  MaintenanceBoardSnapshotColumn,
} from "./board-model";


/** Width a collapsed column narrows to — wide enough to click, too narrow to read. */
const COLLAPSED_COLUMN_WIDTH = 44;

function boardUrl(path: string, boardId: string) {
  if (boardId === "maintenance") return path;
  return `${path}${path.includes("?") ? "&" : "?"}board=${encodeURIComponent(boardId)}`;
}

/** The anchor a group the memo never saw gets: nothing to measure against. */
const DETACHED_ANCHOR = createRef<HTMLButtonElement>();

/*
 * TIER OPTIONS STORE MONDAY'S LABELS; THE FIELD STORES THE NUMBER.
 *
 * `maintenance_requests.tier` has been the bare number 1–4 since Stage 1 — the
 * SLA rules key on it — while the option registry (and the monday spec it is
 * seeded from) stores "Tier 1"–"Tier 4" as the option VALUES. Left unmapped,
 * that mismatch broke every tier surface at once: the cell drew the raw digit
 * in an anonymous grey chip, picking "Tier 3" saved `Number("Tier 3")` — NaN —
 * sorting by Tier ranked every row identically, and a Tier filter matched
 * nothing. The two helpers below are the one bridge, used by the cell, the
 * sort's option order and the filter's choices, so the number and the label
 * can never disagree again.
 */
const tierDigits = (value: string) => value.replace(/\D+/g, "");

/** The option value the tier cell should light up — "3" resolved to "Tier 3". */
function tierCellValue(tier: string, options: Option[]): string {
  if (options.some((option) => option.value === tier)) return tier;
  return (
    options.find((option) => tierDigits(option.value) === tier)?.value ?? tier
  );
}

export function LiveMaintenanceBoard({
  boardId = "maintenance",
  sectionKey,
  requests,
  onCreateDetailed,
  onOpenRequest,
  onRequestChange,
  onRequestCreated,
  onRequestsDeleted,
  onBoardSnapshotChange,
  onNotify,
  onOpenApps,
  onItemActionsChange,
}: {
  boardId?: string;
  /**
   * The section this board is drawn in — Stage 23.
   *
   * Passed straight through to `BoardChrome`, which remembers the open tab
   * against it. Without it, a workspace section pointed at the job board would
   * share the job board's remembered view, and the second section would open
   * wherever the first was left — which defeats the point of adding it.
   */
  sectionKey?: string;
  requests: MaintenanceRequest[];
  onCreateDetailed: () => void;
  onOpenRequest: (
    request: MaintenanceRequest,
    tab?: RequestDrawerTab,
  ) => void;
  onRequestChange: (request: MaintenanceRequest) => void;
  onRequestCreated: (request: MaintenanceRequest) => void;
  onRequestsDeleted: (requestIds: string[]) => void;
  onBoardSnapshotChange?: (snapshot: MaintenanceBoardSnapshot) => void;
  onNotify: (message: string) => void;
  onOpenApps: () => void;
  /** The item verbs the drawer's "⋮" offers — see overlay/item-actions.tsx. */
  onItemActionsChange?: (actions: BoardItemActions | null) => void;
}) {
  const [isMobile, setIsMobile] = useState(false);
  /* The shared store, not a private copy — see the note above the removed
     theme effects further down. Reading only: the document is stamped before
     paint by the boot script and kept in step by the topbar toggle. */
  const themePreference = useThemeChoice();
  const resolvedTheme = useResolvedTheme();
  const [groups, setGroups] = useState<MaintenanceGroup[]>(fallbackGroups);
  const [items, setItems] = useState<MaintenanceGroupItem[]>([]);
  /** Whether the board snapshot has arrived — see `scopedRequests`. */
  const [placementsLoaded, setPlacementsLoaded] = useState(false);
  /**
   * Which board the columns in state were LOADED for, or null while they are
   * still the fallback seed. The saved sort/filter seed below must wait for
   * this: the fallback columns are non-empty from the first render, so a seed
   * gated only on "are there columns" consumed itself against the fallbacks —
   * reading zero rules — and the ref then blocked the real columns from ever
   * seeding. Saved sorts and filters looked like they simply did not persist.
   */
  const [columnsLoadedFor, setColumnsLoadedFor] = useState<string | null>(null);
  // Options are configuration and live in the database. Starting empty means a
  // brief neutral render rather than showing labels the workspace may not have.
  const [boardOptions, setBoardOptions] = useState<BoardColumnOption[]>([]);
  const [customColumns, setCustomColumns] = useState<MaintenanceBoardColumn[]>(
    [],
  );
  const [systemColumns, setSystemColumns] = useState<MaintenanceBoardColumn[]>(
    fallbackSystemColumns,
  );
  const [customCells, setCustomCells] = useState<Record<string, string>>({});
  /*
   * Which view tab is open, reported up by `BoardChrome`. `null` on every board
   * but maintenance, which is the only one that shows the tab strip.
   */
  const [activeBoardView, setActiveBoardView] = useState<BoardView | null>(null);
  // Whether that tab is a section of its own — see `viewReplacesGrid`.
  const gridReplaced = viewReplacesGrid(activeBoardView);
  const [customFileCounts, setCustomFileCounts] = useState<
    Record<string, number>
  >({});
  /* First few files per cell, for the thumbnail tiles. Held beside the counts
     because the count is authoritative and the preview is only a sample. */
  const [customFilePreviews, setCustomFilePreviews] = useState<
    Record<string, MaintenanceBoardFilePreview[]>
  >({});
  const [evidenceTarget, setEvidenceTarget] = useState<{
    request: MaintenanceRequest;
    kind: AttachmentKind | "all";
    column?: MaintenanceBoardColumn;
  } | null>(null);
  /*
   * Cards or the grid, on a phone only.
   *
   * Cards by default, because that is what a 390px screen is for and what
   * monday does. The grid stays one tap away rather than being replaced: a
   * coordinator on a tablet may genuinely want the table, and a mobile view
   * with no way out is its own trap. Remembered per board in the same
   * `localStorage` the board already uses for collapsed groups, so the choice
   * survives a reload and does not follow you to a different board.
   */
  const [layoutFor, setLayoutFor] = useState(() => readMobileLayout(boardId));

  /*
   * Adjusted during render rather than in an effect.
   *
   * The obvious shape — `useEffect` reading storage and calling `setState` —
   * paints the default first and the stored choice a frame later, so a phone
   * that chose the table flashes the cards on every board change. React's own
   * answer to "a prop changed and state must follow" is to compare and set
   * during render, which re-renders before anything is committed to the
   * screen; the lint rule that flags setState-in-an-effect is pointing at
   * exactly this.
   */
  if (layoutFor.boardId !== boardId) setLayoutFor(readMobileLayout(boardId));
  const mobileLayout = layoutFor.layout;

  const chooseMobileLayout = useCallback(
    (layout: "cards" | "grid") => {
      setLayoutFor({ boardId, layout });
      writeMobileLayout(boardId, layout);
    },
    [boardId],
  );

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [collapsedLoaded, setCollapsedLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [portfolio, setPortfolio] = useState("all");
  /*
   * Opens on everything: monday has no period control and shows the whole
   * board. The old 90-day default was invisible while every imported row was
   * stamped "requested today", then hid 536 of 744 the moment the import
   * started carrying monday's real Date Requested — a job raised six months ago
   * looked deleted rather than filtered.
   */
  const [analyticsPeriod, setAnalyticsPeriod] = useState("all");
  const [analyticsNow] = useState(() => Date.now());
  const [priority, setPriority] = useState<"All" | Priority>("All");
  /** Store Documentation's filter, holding a Store Type choice id. */
  const [storeType, setStoreType] = useState("All");
  const [assignee, setAssignee] = useState("All");
  /*
   * THE BOARD'S ORDERED SORT.
   *
   * This was `{ columnId, direction } | null`, so sorting by a second column
   * discarded the first and "Priority, then Due Date" — the ordering a
   * maintenance board is actually read in — could not be expressed. Position in
   * the array is priority: rule 0 decides, rule 1 breaks its ties. The rules
   * and the comparator live in board-sort.ts, where they can be tested against
   * rows rather than eyeballed on the page.
   */
  const [sortRules, setSortRules] = useState<BoardSortRule[]>([]);
  /** The board's structured filter — see board-filter.ts. */
  const [filterState, setFilterState] = useState<BoardFilterState>(EMPTY_FILTER);
  const [sortPanelOpen, setSortPanelOpen] = useState(false);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  /*
   * Whether this person may produce a CSV, answered by the server.
   *
   * The rule itself is on POST /api/board/csv; this only decides whether to
   * draw a button that would be refused. `null` while the answer is in flight,
   * and the control is drawn in that state rather than flickering off on every
   * page load — see lib/client-capabilities.ts.
   */
  const canExport = useCapability("data.export");
  /*
   * HIDDEN COLUMNS ARE SERVER STATE, seeded here and written back on change.
   *
   * This was a bare `new Set()`, so hiding a column lasted until the next
   * reload — an operator who hid ten certificate columns to read the other two
   * got all twelve back on the next visit. `visible` has been on
   * `maintenance_board_columns` since Stage 1 with nothing reading or writing
   * it; `visibilityKeyFor` below is the one place that maps a column to the key
   * this set uses, so the seed and the toggle cannot drift apart.
   */
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
  const [actionsOpen, setActionsOpen] = useState(false);
  const [hideOpen, setHideOpen] = useState(false);
  // The columns panel is anchored to this button through the layer portal.
  const hideButtonRef = useRef<HTMLButtonElement | null>(null);
  const [columnPickerGroupId, setColumnPickerGroupId] = useState<string | null>(
    null,
  );
  const [columnInsertAfterId, setColumnInsertAfterId] = useState<string | null>(
    null,
  );
  const [columnSearch, setColumnSearch] = useState("");
  const [showMoreColumnTypes, setShowMoreColumnTypes] = useState(false);
  const [columnMenuInstance, setColumnMenuInstance] = useState<string | null>(
    null,
  );
  const [columnSettingsTargetId, setColumnSettingsTargetId] = useState<
    string | null
  >(null);
  const [columnBusy, setColumnBusy] = useState(false);
  const [showGroupCreator, setShowGroupCreator] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupColor, setNewGroupColor] = useState(groupColors[0]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [rowMenuId, setRowMenuId] = useState<string | null>(null);
  const [groupMenuId, setGroupMenuId] = useState<string | null>(null);
  const [selectionMoveOpen, setSelectionMoveOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingBoard, setLoadingBoard] = useState(true);

  /*
   * The board no longer keeps its own theme.
   *
   * It used to hold a second copy of the preference in state, initialised to
   * the literal "dark" with the storage read deferred behind `setTimeout(0)`,
   * apply it to the document from an effect, listen to `prefers-color-scheme`
   * with that stale copy, and — the part that did the lasting damage — write
   * the value back to `localStorage` on mount. That last line gave every
   * visitor an explicit stored "dark" they had never chosen, which is why the
   * default could not follow the device however the default was written.
   *
   * The mobile picker below now reads and writes the same store as the topbar
   * toggle (`theme.ts`), so the two controls cannot disagree, and the document
   * is stamped before first paint by the boot script instead of after mount.
   */
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const sync = () => setIsMobile(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const openMobileColumnPicker = () => {
      if (!window.matchMedia("(max-width: 760px)").matches) return;
      setColumnInsertAfterId(null);
      setColumnPickerGroupId(groups[0]?.id ?? "mobile-column-picker");
      setColumnSearch("");
      setShowMoreColumnTypes(false);
      setColumnMenuInstance(null);
      setGroupMenuId(null);
      setRowMenuId(null);
    };
    window.addEventListener(
      "maintsupp:open-column-picker",
      openMobileColumnPicker,
    );
    return () =>
      window.removeEventListener(
        "maintsupp:open-column-picker",
        openMobileColumnPicker,
      );
  }, [groups]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(
          "maintsupp:maintenance-board:collapsed-groups",
        );
        if (saved) {
          const parsed = JSON.parse(saved) as unknown;
          if (Array.isArray(parsed)) {
            setCollapsed(
              new Set(
                parsed.filter(
                  (value): value is string => typeof value === "string",
                ),
              ),
            );
          }
        }
      } catch {
        // Collapsed groups are a device preference; the board still works without it.
      } finally {
        setCollapsedLoaded(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!collapsedLoaded) return;
    try {
      window.localStorage.setItem(
        "maintsupp:maintenance-board:collapsed-groups",
        JSON.stringify(Array.from(collapsed)),
      );
    } catch {
      // Ignore unavailable browser storage and keep the in-memory state.
    }
  }, [collapsed, collapsedLoaded]);

  useEffect(() => {
    const closeMenus = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("[data-board-popover]")
      ) {
        return;
      }
      setActionsOpen(false);
      setHideOpen(false);
      setColumnPickerGroupId(null);
      setColumnInsertAfterId(null);
      setColumnMenuInstance(null);
      setRowMenuId(null);
      setGroupMenuId(null);
      setSelectionMoveOpen(false);
      /*
       * The Sort and Filter panels are dialogs like every other popover here,
       * and they were the only two this pair of closers forgot: Escape and a
       * click on the grid left them floating over the board. Their own wrap
       * carries `data-board-popover`, so a click INSIDE either panel still
       * survives the pointerdown path above.
       */
      setSortPanelOpen(false);
      setFilterPanelOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setActionsOpen(false);
      setHideOpen(false);
      setColumnPickerGroupId(null);
      setColumnInsertAfterId(null);
      setColumnMenuInstance(null);
      setRowMenuId(null);
      setGroupMenuId(null);
      setSelectionMoveOpen(false);
      setSortPanelOpen(false);
      setFilterPanelOpen(false);
    };
    document.addEventListener("pointerdown", closeMenus);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenus);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  useEffect(() => {
    let active = true;
    async function loadBoard() {
      try {
        // `compact=1` — this grid holds its own rows (the `requests` prop), so
        // the flag drops the payload's `requests` key, 756 KB parsed and thrown
        // away on every load, and asks for the interned encoding board-model.ts's
        // `decodeBoardResponse` reads.
        const response = await fetch(boardUrl("/api/board?compact=1", boardId), {
          headers: { Accept: "application/json" },
        });
        if (!response.ok) return;
        const payload = decodeBoardResponse(
          (await response.json()) as CompactBoardResponse & BoardResponse,
        );
        if (!active) return;
        if (payload.groups?.length) setGroups(payload.groups);
        if (payload.items) setItems(payload.items);
        // Only once this has landed can a row be told apart from a row on
        // another board — see `scopedRequests`.
        setPlacementsLoaded(true);
        if (payload.options?.length) {
          setBoardOptions(payload.options);
          // Share the configured labels and colours with screens outside this
          // component, so mobile cards render the admin's values, not a seed.
          publishBoardOptions(payload.options);
        }
        if (payload.columns) {
          const loadedSystemColumns = payload.columns.filter(
            (column) => column.system,
          );
          setSystemColumns(
            loadedSystemColumns.length
              ? loadedSystemColumns
              : fallbackSystemColumns,
          );
          setCustomColumns(
            payload.columns.filter((column) => !column.system),
          );
          // Only now do the columns in state carry the saved sort and filter.
          setColumnsLoadedFor(boardId);
        }
        if (payload.cells) {
          setCustomCells(
            Object.fromEntries(
              payload.cells.map((cell) => [
                customCellKey(cell.requestId, cell.columnId),
                cell.value,
              ]),
            ),
          );
        }
        if (payload.fileCounts) {
          setCustomFileCounts(
            Object.fromEntries(
              payload.fileCounts.map((item) => [
                customCellKey(item.requestId, item.columnId),
                item.count,
              ]),
            ),
          );
          setCustomFilePreviews(
            Object.fromEntries(
              payload.fileCounts.map((item) => [
                customCellKey(item.requestId, item.columnId),
                item.preview ?? [],
              ]),
            ),
          );
        }
      } finally {
        if (active) setLoadingBoard(false);
      }
    }
    const refreshBoard = () => {
      void loadBoard();
    };
    void loadBoard();
    window.addEventListener("maintsupp:refresh-board", refreshBoard);
    return () => {
      active = false;
      window.removeEventListener("maintsupp:refresh-board", refreshBoard);
    };
    // `boardId` belongs here: switching board must re-fetch, or the grid keeps
    // showing the previous board's rows under the new board's columns.
  }, [boardId]);

  const assignees = useMemo(
    () =>
      Array.from(
        new Set(
          requests
            .map((request) => request.assignee)
            .filter((value): value is string => Boolean(value)),
        ),
      ).sort(),
    [requests],
  );

  const portfolioChoices = useMemo(() => {
    const siteNames = new Map<string, string>();
    for (const request of requests) {
      siteNames.set(request.siteId || request.location, request.location);
    }
    return [
      { value: "all", label: "All portfolios" },
      ...Array.from(siteNames, ([value, label]) => ({ value, label })).sort(
        (left, right) => left.label.localeCompare(right.label),
      ),
    ];
  }, [requests]);

  // Palette for the alternative views, so a chip means the same colour
  // everywhere. Derived from the same option rows the table uses.
  const viewPalette = useMemo(() => {
    const palette: Record<string, string> = {};
    for (const option of boardOptions) {
      palette[option.label] = option.color;
      palette[option.value] = option.color;
    }
    return palette;
  }, [boardOptions]);

  /** Where each row sits on THIS board. Declared above `scopedRequests`, which
   * needs it to tell this board's rows from another board's. */
  const placement = useMemo(
    () => new Map(items.map((item) => [item.requestId, item])),
    [items],
  );

  /*
   * The rows this board actually holds.
   *
   * The dashboard fetches every request the organisation has and hands the same
   * array to whichever board is on screen, so a board must narrow it to the
   * rows it places. Without that, the maintenance board drew all 31 Store
   * Documentation stores as jobs — absent from *this* board's `items`, they
   * fell through to `groups[0]` and landed under "Incoming requests", so the
   * count read 41 where the board holds 10 and every meter counted stores as
   * work orders.
   *
   * Gated on the snapshot having arrived, or a still-loading board would blank.
   * `setItems` is updated synchronously on create, before the row is announced,
   * so a new row is never briefly filtered out.
   *
   * WHY THE `loadingBoard` ARM. `requests` lands before placements do, and
   * `!placementsLoaded` used to let every row through in between: all 776
   * requests — Store Documentation's 31 stores included — built under fallback
   * groups and four fallback columns, 2.9s of main-thread work in Chrome, first
   * painted at 2,094ms when the real payload had arrived at 1,899ms, then thrown
   * away. So hold the rows while the request is in flight; the heading already
   * says "Syncing board". The failure case this really protects is kept:
   * `loadingBoard` is cleared in that handler's `finally`, so a not-ok board
   * response still shows every row.
   */
  const scopedRequests = useMemo(
    () =>
      requests.filter(
        (request) =>
          (placementsLoaded ? placement.has(request.id) : !loadingBoard) &&
          (portfolio === "all" ||
            request.siteId === portfolio ||
            request.location === portfolio) &&
          withinAnalyticsPeriod(
            request.requestedAt,
            analyticsPeriod,
            analyticsNow,
          ),
      ),
    [
      analyticsNow,
      analyticsPeriod,
      loadingBoard,
      placement,
      placementsLoaded,
      portfolio,
      requests,
    ],
  );

  const assigneeOptions = useMemo<Option[]>(
    () => [
      { value: "", label: "Unassigned", color: "#eef2f4", text: "#61717c" },
      ...assignees.map((person, index) => ({
        value: person,
        color: groupColors[index % groupColors.length],
      })),
    ],
    [assignees],
  );

  const itemNameColumn = useMemo(
    () => systemColumns.find((column) => column.key === "name") ?? null,
    [systemColumns],
  );

  /*
   * Store Documentation filters by Store Type, not by priority — the board has
   * no priority column, so the maintenance filter offered four values that
   * matched nothing and hid every row when used. The choices come off the
   * column itself rather than a hardcoded list, so an admin who adds a fifth
   * store type sees it here without a deploy.
   */
  const storeTypeColumn = useMemo(
    () =>
      customColumns.find(
        (column) => column.key === "storeType" && column.type === "dropdown",
      ) ?? null,
    [customColumns],
  );
  const storeTypeChoices = useMemo(
    () => (storeTypeColumn ? choiceList(storeTypeColumn) : []),
    [storeTypeColumn],
  );

  /*
   * Which board this grid is, in the two forms the rest of the component asks
   * for it. Declared here rather than beside the JSX because the sort and
   * filter helpers above the render read them, and a const referenced before
   * its declaration is a temporal dead zone error rather than an undefined.
   */
  const isStoreDocumentation = boardId === "store-documentation";
  const canEditGroups = !isStoreDocumentation;

  const allBoardColumns = useMemo<BoardDisplayColumn[]>(
    () =>
      [
        ...systemColumns.map(
          (column): BoardDisplayColumn => ({
            kind: "system",
            key: column.key as ColumnKey,
            column,
          }),
        ),
        ...customColumns.map(
          (column): BoardDisplayColumn => ({ kind: "custom", column }),
        ),
      ].sort((left, right) => left.column.position - right.column.position),
    [customColumns, systemColumns],
  );

  /** Every column by id, which the sort and filter engines both look through. */
  const columnsById = useMemo(
    () => new Map(allBoardColumns.map((entry) => [entry.column.id, entry])),
    [allBoardColumns],
  );

  const systemOptionOrders = useMemo(() => {
    const orders = new Map<string, Map<string, number>>();
    for (const key of [
      "tier",
      "engineer",
      "priority",
      "label",
      "status",
      "storeLocation",
    ] as BoardOptionColumn[]) {
      const saved = boardOptions
        .filter((option) => option.columnKey === key)
        .sort((left, right) => left.position - right.position);
      const choices = saved.length
        ? saved.map((option) => ({ value: option.value, label: option.label }))
        : (editableFallbackOptions[key] ?? []).map((option) => ({
            value: option.value,
            label: option.label,
          }));
      if (!choices.length) continue;
      const lookup = new Map<string, number>();
      choices.forEach((choice, index) => {
        if (choice.value) lookup.set(choice.value, index);
        if (choice.label) lookup.set(choice.label, index);
        // The tier FIELD is the bare number; alias "3" onto "Tier 3" so a
        // tier sort ranks rows instead of scoring them all "not in the list".
        if (key === "tier") {
          const digits = tierDigits(choice.value ?? "");
          if (digits) lookup.set(digits, index);
        }
      });
      orders.set(key, lookup);
    }
    return orders;
  }, [boardOptions]);

  const filtered = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    return [...scopedRequests]
      .filter(
        (request) =>
          (!needle ||
            [
              request.id,
              boardItemName(
                request,
                boardId,
                itemNameColumn
                  ? customCells[customCellKey(request.id, itemNameColumn.id)]
                  : undefined,
              ),
              request.description,
              request.location,
              request.requester,
              request.contractor ?? "",
              // The server-assigned public reference (e.g. MS-2026-0040). A
              // requester quoting the number from their confirmation email is
              // the one search this box must never fail.
              request.reference ?? "",
              // The stored title. The Name COLUMN deliberately shows the
              // arrival form on this board (monday parity — boardItemName),
              // so a public submission's own title ("Leaking tap") appeared
              // nowhere in this haystack and its exact words found nothing.
              request.title ?? "",
              ...customColumns.map((column) =>
                customCellDisplay(
                  column,
                  customCells[customCellKey(request.id, column.id)] ?? "",
                ),
              ),
            ].some((value) => value.toLowerCase().includes(needle))) &&
          (storeTypeColumn
            ? storeType === "All" ||
              findChoice(
                storeTypeChoices,
                customCells[customCellKey(request.id, storeTypeColumn.id)] ?? "",
              )?.id === storeType
            : priority === "All" || request.priority === priority) &&
          (assignee === "All" ||
            (assignee === "Unassigned"
              ? !request.assignee
              : request.assignee === assignee)),
      )
      /*
       * NEWEST FIRST IS THE BASE ORDER, NOT THE SORT.
       *
       * This used to be where the toolbar's Newest/Oldest button applied — and
       * it had no effect on the grid, because `groupedRows` below re-sorts
       * every group by stored position. It changed the CSV and nothing a person
       * could see. Newest/Oldest is now a rule on the Date Requested column
       * like any other sort, so the toolbar and the grid agree; what is left
       * here is a deterministic base order, so two rows no rule separates do
       * not swap places between renders.
       */
      .sort(
        (left, right) =>
          new Date(right.requestedAt).getTime() -
          new Date(left.requestedAt).getTime(),
      );
  }, [
    assignee,
    boardId,
    customCells,
    customColumns,
    itemNameColumn,
    priority,
    storeType,
    storeTypeChoices,
    storeTypeColumn,
    deferredQuery,
    scopedRequests,
  ]);

  /*
   * The structured filter, applied after the search box and the two toolbar
   * dropdowns. The three coexist deliberately: search answers "where is that
   * job", a filter answers "show me this kind of work", and neither is a
   * substitute for the other.
   */
  const filterContext = useMemo(
    () => ({
      boardId,
      columnsById,
      cells: customCells,
      fileCounts: customFileCounts,
    }),
    [boardId, columnsById, customCells, customFileCounts],
  );

  const visibleRows = useMemo(
    () => applyBoardFilter(filtered, filterState, filterContext),
    [filtered, filterState, filterContext],
  );

  const selectedRequests = useMemo(
    () => requests.filter((request) => selectedIds.has(request.id)),
    [requests, selectedIds],
  );

  /**
   * The six meters above the board. All the maths lives in dashboard-meters.ts,
   * which is React-free so the numbers can be asserted against rows in a test
   * rather than eyeballed on the page.
   *
   * `filtered`, not `scopedRequests`: the meters sit directly above the table
   * and have to describe the rows it is drawing. `scopedRequests` is portfolio
   * and period only, so the old code left all six numbers frozen while the
   * search box, the priority filter and the assignee filter emptied the board
   * underneath them.
   */
  const jobAnalytics = useMemo(
    () => computeJobMeters(visibleRows, analyticsPeriod, analyticsNow),
    [analyticsNow, analyticsPeriod, visibleRows],
  );

  /* The six meters stay reachable by collapsing into a strip pinned under the
     top bar once they reach it. Every part of the mechanism, and the two
     measurements that keep it from oscillating, live in jobs-meter-strip.tsx. */
  const { pageRef, railState, anchorRef, sectionRef, sectionClassName, ...meters } =
    useCollapsingMeters(boardId === "maintenance");

  /**
   * Row-menu actions — the five monday offers that the board did not.
   *
   * The item drawer is addressable at `?item=<id>`, so "open in new tab" and
   * "copy link" are the same URL used two ways; anyone opening that link lands
   * on the item rather than the top of the board.
   */
  const itemHref = (requestId: string) => {
    if (typeof window === "undefined") return "";
    const url = new URL(window.location.href);
    url.searchParams.set("item", requestId);
    return url.toString();
  };

  const openItemInNewTab = (request: MaintenanceRequest) => {
    setRowMenuId(null);
    window.open(itemHref(request.id), "_blank", "noopener,noreferrer");
  };

  const copyItemLink = async (request: MaintenanceRequest) => {
    setRowMenuId(null);
    try {
      await copyBoardText(itemHref(request.id));
      onNotify(`Link to ${request.id} copied.`);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "The link could not be copied.");
    }
  };

  /**
   * Creates a sibling directly beneath `request`.
   *
   * Two calls, because position is the entire point of the action and
   * `create_item` appends to the end of the group. The follow-up `move_item`
   * uses the row that currently sits after `request` as the drop anchor; when
   * `request` is last there is nothing to anchor to and appending is already
   * correct.
   */
  const createItemBelow = async (request: MaintenanceRequest, groupId: string) => {
    setRowMenuId(null);
    const siblings = groupRows(groupId);
    const index = siblings.findIndex((entry) => entry.id === request.id);
    const anchor = index >= 0 ? siblings[index + 1] : undefined;

    try {
      /*
       * POST, not PATCH: `create_item` lives in /api/board's POST dispatch —
       * the PATCH handler answers 400 "Unknown board action." for it, which is
       * exactly what "Create new item below" did from the day it shipped.
       * `createItem` above always had the verb right; this call did not.
       */
      const response = await fetch(boardUrl("/api/board", boardId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create_item", groupId }),
      });
      const payload = (await response.json()) as {
        request?: MaintenanceRequest;
        item?: MaintenanceGroupItem;
        error?: string;
      };
      if (!response.ok || !payload.request || !payload.item) {
        throw new Error(payload.error || "The item could not be created.");
      }
      setItems((current) => [...current, payload.item!]);
      onRequestCreated(payload.request);

      if (anchor) {
        const moved = await fetch(boardUrl("/api/board", boardId), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "move_item",
            requestId: payload.request.id,
            groupId,
            beforeRequestId: anchor.id,
          }),
        });
        const movedPayload = (await moved.json()) as {
          items?: MaintenanceGroupItem[];
          error?: string;
        };
        if (moved.ok && movedPayload.items) {
          const changed = new Map(movedPayload.items.map((item) => [item.requestId, item]));
          setItems((current) =>
            current.map((item) => changed.get(item.requestId) ?? item),
          );
        }
      }

      onNotify(`${payload.request.id} added below ${request.id}.`);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "The item could not be created.");
    }
  };

  /**
   * Files an item under the one above it in the same group.
   *
   * Monday's own rule: the new parent is the preceding sibling. The menu entry
   * is disabled rather than hidden when there is no row above, which is how
   * monday shows it.
   */
  const convertToSubitem = async (request: MaintenanceRequest, groupId: string) => {
    setRowMenuId(null);
    const siblings = groupRows(groupId);
    const index = siblings.findIndex((entry) => entry.id === request.id);
    const parent = index > 0 ? siblings[index - 1] : null;
    if (!parent) {
      onNotify("There is no item above this one to become its parent.");
      return;
    }
    try {
      const response = await fetch("/api/maintenance", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: request.id, fields: { parentId: parent.id } }),
      });
      const payload = (await response.json()) as { request?: MaintenanceRequest; error?: string };
      if (!response.ok) throw new Error(payload.error || "The item could not be converted.");
      onRequestChange(payload.request ?? { ...request, parentId: parent.id });
      setExpandedSubitems((current) => new Set(current).add(parent.id));
      onNotify(`${request.id} is now a subitem of ${parent.id}.`);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "The item could not be converted.");
    }
  };

  /**
   * Collapsed columns — monday's "Collapse", which narrows a column to a strip
   * rather than hiding it. The distinction matters: a hidden column disappears
   * from the header entirely, a collapsed one stays in place so you can see
   * where it is and open it again.
   */
  const [collapsedColumns, setCollapsedColumns] = useState<Set<string>>(new Set());

  const toggleColumnCollapsed = (columnId: string) => {
    setColumnMenuInstance(null);
    setCollapsedColumns((current) => {
      const next = new Set(current);
      if (next.has(columnId)) next.delete(columnId);
      else next.add(columnId);
      return next;
    });
  };

  /**
   * Grouping the board by a column's value rather than by the stored group.
   *
   * A view-level override, deliberately: it changes how rows are drawn, not
   * where they are filed. Turning it off puts every row back in the group it
   * has always belonged to, and nothing has been written in the meantime.
   */
  const [groupByColumn, setGroupByColumn] = useState<string | null>(null);

  const toggleGroupByColumn = (columnId: string) => {
    setColumnMenuInstance(null);
    setGroupByColumn((current) => (current === columnId ? null : columnId));
  };

  const changeColumnType = async (
    column: MaintenanceBoardColumn,
    type: BoardColumnType,
    force = false,
  ) => {
    if (type === column.type) return;
    setColumnMenuInstance(null);
    try {
      const response = await fetch(boardUrl("/api/board/columns", boardId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: column.id, type, force }),
      });
      const payload = (await response.json()) as {
        error?: string;
        message?: string;
        affected?: number;
      };

      // The API refuses a conversion that would clear stored values until the
      // caller has seen the count and said yes. Asking is the whole point —
      // silently emptying cells is the failure this guards against.
      if (response.status === 409 && payload.error === "lossy-conversion") {
        const confirmed = window.confirm(
          `${payload.message ?? "Some values cannot be converted."}\n\nConvert anyway?`,
        );
        if (confirmed) await changeColumnType(column, type, true);
        return;
      }
      if (!response.ok) throw new Error(payload.error || "The column type could not be changed.");

      setCustomColumns((current) =>
        current.map((entry) => (entry.id === column.id ? { ...entry, type } : entry)),
      );
      onNotify(`${column.title} is now a ${type.replace(/_/g, " ")} column.`);
    } catch (error) {
      onNotify(
        error instanceof Error ? error.message : "The column type could not be changed.",
      );
    }
  };

  const copySelectedIds = async () => {
    try {
      await copyBoardText(selectedRequests.map((request) => request.id).join("\n"));
      onNotify(
        `${selectedRequests.length} job ID${selectedRequests.length === 1 ? "" : "s"} copied.`,
      );
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "The job IDs could not be copied.");
    }
  };

  const copySelectedSummary = async () => {
    const summary = selectedRequests
      .map(
        (request) =>
          `${request.id} — ${request.title}\n${request.location} · ${request.priority} · ${request.status}${request.assignee ? ` · ${request.assignee}` : ""}`,
      )
      .join("\n\n");
    try {
      await copyBoardText(summary);
      onNotify(
        `Sidekick summary for ${selectedRequests.length} job${selectedRequests.length === 1 ? "" : "s"} copied.`,
      );
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "The summary could not be copied.");
    }
  };


  /**
   * The key `hiddenColumns` uses for a column.
   *
   * System columns are keyed by their stable `key` and custom ones by their id,
   * because a custom column has no meaningful key of its own. Both shapes were
   * already spelled out at three call sites; this is the single definition they
   * now share.
   */
  const visibilityKeyFor = (entry: BoardDisplayColumn) =>
    entry.kind === "system" ? entry.key : `custom:${entry.column.id}`;

  /*
   * Seeded from the board payload, and re-seeded whenever the columns reload —
   * a board switch or a refresh brings its own visibility with it.
   */
  useEffect(() => {
    setHiddenColumns(
      new Set(
        allBoardColumns
          .filter((entry) => entry.column.visible === false)
          .map(visibilityKeyFor),
      ),
    );
  }, [allBoardColumns]);

  /*
   * The saved sort and filter, read back off the columns that carry them.
   *
   * SEEDED ONCE PER BOARD, tracked by a ref rather than by "is the state still
   * empty". The columns reload after every cell edit and after every column
   * write; with an emptiness test, clearing a sort would be undone by the very
   * next reload, and clearing a filter likewise — the state and the saved state
   * would each keep re-asserting the other. The ref says "this board's stored
   * choices have been applied", which is the actual condition.
   */
  const seededChoicesFor = useRef<string | null>(null);
  useEffect(() => {
    if (!allBoardColumns.length) return;
    /*
     * Wait for THIS board's real columns. The fallback columns satisfy the
     * length check from the very first render, and seeding from them read an
     * empty sort and an empty filter, then marked the board seeded — so the
     * saved rules never applied and every session started from scratch. See
     * `columnsLoadedFor` above.
     */
    if (columnsLoadedFor !== boardId) return;
    if (seededChoicesFor.current === boardId) return;
    seededChoicesFor.current = boardId;
    setSortRules(readSortRules(allBoardColumns));
    setFilterState(readFilterState(allBoardColumns));
  }, [allBoardColumns, boardId, columnsLoadedFor]);

  /**
   * Hide or show a column, and remember it.
   *
   * The local set moves first so the board redraws immediately; the write
   * follows. A failed write is reported and the column comes back, because a
   * column that looks hidden but is not is worse than one that refused to hide.
   */
  const setColumnVisible = async (entry: BoardDisplayColumn, next: boolean) => {
    const key = visibilityKeyFor(entry);
    setHiddenColumns((current) => {
      const updated = new Set(current);
      if (next) updated.delete(key);
      else updated.add(key);
      return updated;
    });
    try {
      await updateCustomColumn(entry.column, { visible: next });
    } catch (error) {
      setHiddenColumns((current) => {
        const reverted = new Set(current);
        if (next) reverted.add(key);
        else reverted.delete(key);
        return reverted;
      });
      onNotify(
        error instanceof Error
          ? error.message
          : "The column could not be hidden.",
      );
    }
  };

  const groupForRequest = (request: MaintenanceRequest) =>
    placement.get(request.id)?.groupId ??
    groups.find((group) => group.stageKey === request.stage)?.id ??
    groups[0]?.id;

  const visible = (key: string) => !hiddenColumns.has(key);
  const visibleBoardColumns = allBoardColumns
    .filter((entry) =>
      entry.kind === "system"
        ? visible(entry.key)
        : visible(`custom:${entry.column.id}`),
    )
    // A collapsed column keeps its place in the header and narrows to a strip.
    // Overriding the width here rather than at each render site means the
    // header, the cells and the summary row all agree without any of them
    // knowing the feature exists.
    .map((entry) =>
      collapsedColumns.has(entry.column.id)
        ? { ...entry, column: { ...entry.column, width: COLLAPSED_COLUMN_WIDTH } }
        : entry,
    );

  useEffect(() => {
    if (!onBoardSnapshotChange) return;
    const columns = allBoardColumns
      .filter((entry) =>
        entry.kind === "system"
          ? !hiddenColumns.has(entry.key)
          : !hiddenColumns.has(`custom:${entry.column.id}`),
      )
      .map(
        (entry): MaintenanceBoardSnapshotColumn => ({
          kind: entry.kind,
          key: entry.kind === "system" ? entry.key : null,
          column: entry.column,
        }),
      );
    onBoardSnapshotChange({
      columns,
      cellValues: customCells,
      fileCounts: customFileCounts,
      filePreviews: customFilePreviews,
      groups,
      items,
    });
  }, [
    allBoardColumns,
    customCells,
    customFileCounts,
    customFilePreviews,
    groups,
    hiddenColumns,
    items,
    onBoardSnapshotChange,
  ]);

  /*
   * The business order of every option-backed system column, as position
   * lookups keyed by BOTH the stored value and the label — a cell may hold
   * either, depending on whether it was picked in the grid or imported.
   *
   * This is what makes "sort by Priority" mean P1 before P4 rather than "L"
   * before "M": the order the workspace put its own options in. Built here
   * rather than read through `optionsFor`, which is declared further down the
   * component and would be in its temporal dead zone from inside this memo.
   */

  /**
   * Everything the comparator needs that is neither a rule nor a row.
   *
   * Built once per render rather than closed over inside the sort, so the same
   * context can order the grid, the CSV export and a test.
   */
  const sortContext = useMemo(
    () => ({
      boardId,
      columnsById,
      cells: customCells,
      fileCounts: customFileCounts,
      optionOrderFor: (key: ColumnKey) => systemOptionOrders.get(key),
      positionOf: (requestId: string) =>
        placement.get(requestId)?.position ?? Number.MAX_SAFE_INTEGER,
    }),
    [boardId, columnsById, customCells, customFileCounts, placement, systemOptionOrders],
  );

  /** The rows in the order the grid draws them, flattened. What an export gets. */
  const exportRows = useMemo(
    () => sortBoardRows(visibleRows, sortRules, sortContext),
    [sortContext, sortRules, visibleRows],
  );

  const groupedRows = useMemo(() => {
    const rowsByGroup = new Map<string, MaintenanceRequest[]>(
      groupByColumn ? [] : groups.map((group) => [group.id, []]),
    );
    const byColumn = groupByColumn
      ? allBoardColumns.find((item) => item.column.id === groupByColumn)
      : null;

    for (const request of visibleRows) {
      // Subitems hang under their parent, not beside it. Without this a child
      // was placed in a group and drawn as a top-level row, so the same work
      // appeared twice and the group counts were wrong.
      if (request.parentId) continue;

      const groupId = byColumn
        ? `by:${
            String(
              byColumn.kind === "system"
                ? systemColumnSortValue(request, byColumn.key)
                : customCellDisplay(
                    byColumn.column,
                    customCells[customCellKey(request.id, byColumn.column.id)] ?? "",
                  ),
            ).trim() || "(empty)"
          }`
        : placement.get(request.id)?.groupId ??
          groups.find((group) => group.stageKey === request.stage)?.id ??
          groups[0]?.id;
      if (!groupId) continue;
      const rows = rowsByGroup.get(groupId) ?? [];
      rows.push(request);
      rowsByGroup.set(groupId, rows);
    }

    /*
     * ONE COMPARATOR, ONE SET OF RULES — see board-sort.ts.
     *
     * This used to inline a single column's comparison, with the option-order
     * lookup and the empty-last rule spelled out here. All of it moved, whole,
     * so that the ordering can be tested against rows rather than eyeballed on
     * the page, and so the CSV export can be sorted by the same function the
     * grid draws with instead of a second copy that agrees until it does not.
     */
    for (const rows of rowsByGroup.values()) {
      rows.sort((left, right) =>
        compareBoardRows(left, right, sortRules, sortContext),
      );
    }
    return rowsByGroup;
  }, [
    allBoardColumns,
    customCells,
    groupByColumn,
    groups,
    placement,
    sortContext,
    sortRules,
    visibleRows,
  ]);

  const groupRows = (groupId: string) => groupedRows.get(groupId) ?? [];

  /**
   * The groups the board draws.
   *
   * Normally the stored groups. When a column is chosen as the grouping, one
   * synthetic group per distinct value replaces them — a display override, so
   * nothing is written and switching it off puts every row back where it has
   * always been filed. Synthetic groups carry no menu, because renaming or
   * deleting "Urgent" is not a thing that can mean anything.
   */
  const displayGroups = useMemo(() => {
    if (!groupByColumn) return groups.map((group) => ({ group, synthetic: false }));

    const entry = allBoardColumns.find((item) => item.column.id === groupByColumn);
    if (!entry) return groups.map((group) => ({ group, synthetic: false }));

    const seen = new Map<string, MaintenanceGroup>();
    for (const request of visibleRows) {
      if (request.parentId) continue;
      const value = String(
        entry.kind === "system"
          ? systemColumnSortValue(request, entry.key)
          : customCellDisplay(
              entry.column,
              customCells[customCellKey(request.id, entry.column.id)] ?? "",
            ),
      ).trim();
      const label = value || "(empty)";
      if (seen.has(label)) continue;
      seen.set(label, {
        id: `by:${label}`,
        name: label,
        color: groupColors[seen.size % groupColors.length],
        stageKey: null,
        position: seen.size,
      });
    }
    return [...seen.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((group) => ({ group, synthetic: true }));
  }, [allBoardColumns, customCells, visibleRows, groupByColumn, groups]);

  /*
   * One anchor ref per drawn group, so the portalled group menu can measure
   * the "…" that opened it. Built with `createRef` inside a memo rather than
   * read out of a ref-held Map during render: the React compiler rule
   * (react-hooks/refs) rejects a `.current` read while rendering, and a Map of
   * refs rebuilt only when the drawn groups change is the same thing without
   * the read. A group this map has never seen gets a detached ref, which the
   * popover treats as "nothing to anchor to".
   */
  const groupAnchors = useMemo(
    () =>
      new Map(
        displayGroups.map(({ group }) => [group.id, createRef<HTMLButtonElement>()] as const),
      ),
    [displayGroups],
  );
  const groupMoreRef = (groupId: string) => groupAnchors.get(groupId) ?? DETACHED_ANCHOR;

  /**
   * Children keyed by parent — monday's Subitems column.
   *
   * Built from the same request list the board already holds, so a subitem is
   * editable through every path a top-level item is. Ordered by creation, which
   * is the order monday adds them in.
   */
  const subitemsByParent = useMemo(() => {
    const byParent = new Map<string, MaintenanceRequest[]>();
    for (const request of requests) {
      if (!request.parentId) continue;
      const bucket = byParent.get(request.parentId) ?? [];
      bucket.push(request);
      byParent.set(request.parentId, bucket);
    }
    for (const bucket of byParent.values()) {
      bucket.sort(
        (left, right) =>
          new Date(left.requestedAt).getTime() - new Date(right.requestedAt).getTime(),
      );
    }
    return byParent;
  }, [requests]);

  const [expandedSubitems, setExpandedSubitems] = useState<Set<string>>(new Set());

  const toggleSubitems = (requestId: string) => {
    setExpandedSubitems((current) => {
      const next = new Set(current);
      if (next.has(requestId)) next.delete(requestId);
      else next.add(requestId);
      return next;
    });
  };

  /** Creates a child of `parent` — POST /api/board/items with a parentId. */
  const addSubitem = async (parent: MaintenanceRequest, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      const response = await fetch(boardUrl("/api/board/items", boardId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: trimmed,
          parentId: parent.id,
          siteId: parent.siteId,
          // Monday's subitem board opens a child on "Working on it".
          status: "Working on it",
          location: parent.location,
          requester: parent.requester,
          contact: parent.contact,
          engineer: parent.engineer,
          category: parent.category,
        }),
      });
      const payload = (await response.json()) as { item?: MaintenanceRequest; error?: string };
      if (!response.ok || !payload.item) {
        throw new Error(payload.error || "The subitem could not be added.");
      }
      onRequestCreated(payload.item);
      setExpandedSubitems((current) => new Set(current).add(parent.id));
    } catch (error) {
      onNotify(
        error instanceof Error ? error.message : "The subitem could not be added.",
      );
    }
  };

  const saveFields = async (
    request: MaintenanceRequest,
    fields: EditableFields,
  ) => {
    const optimistic = { ...request, ...fields };
    onRequestChange(optimistic);
    try {
      const response = await fetch("/api/maintenance", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: request.id, fields }),
      });
      const payload = (await response.json()) as {
        request?: MaintenanceRequest;
        error?: string;
      };
      if (!response.ok || !payload.request) {
        throw new Error(payload.error || "The cell could not be saved.");
      }
      onRequestChange(payload.request);
      onNotify(`${request.id} updated.`);
    } catch (error) {
      onRequestChange(request);
      onNotify(
        error instanceof Error ? error.message : "The cell could not be saved.",
      );
    }
  };

  /**
   * The marker and time of day a date cell carries beside its date.
   *
   * A SYSTEM date column's date belongs to the job — it is written by
   * `saveFields` through PATCH /api/maintenance, which is what the calendar and
   * the overdue count read. Only the decoration is a cell, and it is stored
   * WITHOUT a date so it can never disagree with the field about one. That is
   * also what lets the server accept it: `update_cell` refuses a system column
   * outright otherwise, and every date edit on this board used to fire a second
   * request that came back 400 and put an error in front of the operator.
   *
   * A workspace column's date IS its cell, so nothing is stripped there.
   */
  const saveDateDecoration = (
    request: MaintenanceRequest,
    column: MaintenanceBoardColumn,
    metadataValue: string,
  ) => {
    if (!column.system) return saveCustomCell(request, column, metadataValue);
    let decoration = "";
    if (metadataValue) {
      try {
        const parsed = JSON.parse(metadataValue) as {
          time?: unknown;
          icon?: unknown;
        };
        const time = typeof parsed.time === "string" ? parsed.time : "";
        const icon = typeof parsed.icon === "string" ? parsed.icon : "";
        if (time || icon) decoration = JSON.stringify({ time, icon });
      } catch {
        // Unreadable metadata clears the decoration rather than storing it.
      }
    }
    return saveCustomCell(request, column, decoration);
  };

  const optionsFor = (columnKey: BoardOptionColumn): Option[] => {
    const saved = boardOptions
      .filter((option) => option.columnKey === columnKey)
      .sort((a, b) => a.position - b.position)
      .map((option) => ({
        id: option.id,
        value: option.value,
        label: option.label,
        color: option.color,
        text: option.textColor,
        active: option.active,
        system: option.system,
      }));
    return saved.length ? saved : editableFallbackOptions[columnKey];
  };

  const createOption = async (
    columnKey: BoardOptionColumn,
    label: string,
    color: string,
  ) => {
    const response = await fetch(boardUrl("/api/board", boardId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create_option", columnKey, label, color }),
    });
    const payload = (await response.json()) as {
      option?: BoardColumnOption;
      error?: string;
    };
    if (!response.ok || !payload.option) {
      throw new Error(payload.error || "The label could not be created.");
    }
    setBoardOptions((current) => [...current, payload.option!]);
    onNotify(`${payload.option.label} added.`);
  };

  const updateOption = async (
    optionId: string,
    changes: { label?: string; color?: string; active?: boolean },
  ) => {
    const response = await fetch(boardUrl("/api/board", boardId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update_option", optionId, ...changes }),
    });
    const payload = (await response.json()) as {
      option?: BoardColumnOption;
      error?: string;
    };
    if (!response.ok || !payload.option) {
      throw new Error(payload.error || "The label could not be updated.");
    }
    setBoardOptions((current) =>
      current.map((option) =>
        option.id === payload.option!.id ? payload.option! : option,
      ),
    );
    onNotify(`${payload.option.label} updated.`);
  };

  const deleteOption = async (optionId: string) => {
    const response = await fetch(boardUrl("/api/board", boardId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete_option", optionId }),
    });
    const payload = (await response.json()) as {
      deleted?: boolean;
      error?: string;
    };
    if (!response.ok || !payload.deleted) {
      throw new Error(payload.error || "The label could not be deleted.");
    }
    setBoardOptions((current) => current.filter((option) => option.id !== optionId));
    onNotify("Label deleted.");
  };

  const createCustomColumn = async (type: BoardColumnType) => {
    if (columnBusy) return;
    setColumnBusy(true);
    try {
      const response = await fetch(boardUrl("/api/board", boardId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_column",
          type,
          afterColumnId: columnInsertAfterId,
        }),
      });
      const payload = (await response.json()) as {
        column?: MaintenanceBoardColumn;
        error?: string;
      };
      if (!response.ok || !payload.column) {
        throw new Error(payload.error || "The column could not be added.");
      }
      setCustomColumns((current) => [...current, payload.column!]);
      setColumnPickerGroupId(null);
      setColumnInsertAfterId(null);
      setColumnSearch("");
      setShowMoreColumnTypes(false);
      onNotify(`${payload.column.title} column added.`);
    } catch (error) {
      onNotify(
        error instanceof Error ? error.message : "The column could not be added.",
      );
    } finally {
      setColumnBusy(false);
    }
  };

  const updateCustomColumn = async (
    column: MaintenanceBoardColumn,
    changes: {
      title?: string;
      settings?: BoardColumnSettings;
      width?: number;
      visible?: boolean;
      /* Both have been columns on the table since Stage 1; neither had a
         writer on this route until the board gained controls for them. */
      pinned?: boolean;
      summary?: string;
    },
  ) => {
    const response = await fetch(boardUrl("/api/board", boardId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update_column",
        columnId: column.id,
        ...changes,
      }),
    });
    const payload = (await response.json()) as {
      column?: MaintenanceBoardColumn;
      error?: string;
    };
    if (!response.ok || !payload.column) {
      throw new Error(payload.error || "The column could not be updated.");
    }
    const applyUpdatedColumn = (current: MaintenanceBoardColumn[]) =>
      current.map((item) =>
        item.id === payload.column!.id ? payload.column! : item,
      );
    if (payload.column.system) {
      setSystemColumns(applyUpdatedColumn);
    } else {
      setCustomColumns(applyUpdatedColumn);
    }
    return payload.column;
  };

  const renameCustomColumn = async (column: MaintenanceBoardColumn) => {
    const title = window.prompt("Column name", column.title)?.trim();
    if (!title || title === column.title) return;
    setColumnMenuInstance(null);
    try {
      const updated = await updateCustomColumn(column, { title });
      onNotify(`Column renamed to ${updated.title}.`);
    } catch (error) {
      onNotify(
        error instanceof Error
          ? error.message
          : "The column could not be renamed.",
      );
    }
  };

  const toggleColumnWrap = async (column: MaintenanceBoardColumn) => {
    setColumnMenuInstance(null);
    try {
      const updated = await updateCustomColumn(column, {
        settings: {
          ...column.settings,
          wrap: column.settings.wrap !== true,
        },
      });
      onNotify(
        `${updated.title} text ${updated.settings.wrap ? "will wrap" : "will stay on one line"}.`,
      );
    } catch (error) {
      onNotify(
        error instanceof Error
          ? error.message
          : "The wrapping setting could not be saved.",
      );
    }
  };

  /**
   * Write the board's sort to the columns that carry it.
   *
   * The rules move locally first so the grid reorders under the pointer, then
   * every column whose stored sort has changed is written. That is more writes
   * than the single sort needed — clearing one rule renumbers the ones after it
   * — but it is the only way the saved order and the drawn order can be the
   * same thing. `sortSettingsFor` decides what one column should store; this
   * decides which columns need telling.
   *
   * A failed write leaves the board sorted and says so, rather than silently
   * reverting: the reorder on screen is real either way, only its memory is at
   * stake.
   */
  const commitSortRules = (next: BoardSortRule[]) => {
    const previous = sortRules;
    setSortRules(next);
    setColumnMenuInstance(null);
    const touched = new Set([
      ...previous.map((rule) => rule.columnId),
      ...next.map((rule) => rule.columnId),
    ]);
    void (async () => {
      try {
        for (const columnId of touched) {
          const entry = columnsById.get(columnId);
          if (!entry) continue;
          const settings = sortSettingsFor(
            entry.column.settings as Record<string, unknown>,
            next,
            columnId,
          );
          if (
            JSON.stringify(settings) === JSON.stringify(entry.column.settings)
          ) {
            continue;
          }
          await updateCustomColumn(entry.column, { settings });
        }
      } catch (error) {
        onNotify(
          error instanceof Error
            ? `Sorted, but the choice could not be saved: ${error.message}`
            : "Sorted, but the choice could not be saved.",
        );
      }
    })();
  };

  /** A header click, or "Sort ascending" in a column menu: this column alone. */
  const sortByColumn = (
    column: MaintenanceBoardColumn,
    direction: SortDirection,
  ) => commitSortRules(replaceSortRules(column.id, direction));

  /** The deliberate multi-sort action: append this column as a tie-breaker. */
  const addSortByColumn = (
    column: MaintenanceBoardColumn,
    direction: SortDirection,
  ) => commitSortRules(addSortRule(sortRules, column.id, direction));

  /**
   * Which columns a rule may name.
   *
   * Visible ones only, in board order — offering to sort by a column somebody
   * has hidden would reorder the grid by something they cannot see. Subitems is
   * excluded from both: it is an expander rather than a value, and monday does
   * not offer it either.
   */
  const sortableColumns = useMemo(
    () => visibleBoardColumns.filter((entry) => entry.column.type !== "subitems"),
    [visibleBoardColumns],
  );
  const filterableColumns = useMemo(
    () => visibleBoardColumns.filter(isFilterableColumn),
    [visibleBoardColumns],
  );

  /**
   * The values a filter on this column can be built from.
   *
   * WHICH SIDE OF THE OPTION THE RULE STORES depends on where the value lives.
   * A system option column is matched against the FIELD ON THE JOB — Priority
   * holds "Urgent" — so the rule stores the option's value. A workspace column
   * is matched against what its cell DISPLAYS, because a stored choice id is
   * not something anybody would pick from a list, so the rule stores the label.
   * `toFilterItem` in board-filter.ts is the other half of that arrangement.
   */
  const filterChoicesFor = (entry: BoardDisplayColumn): FilterChoice[] => {
      if (entry.kind === "custom") {
        if (entry.column.type === "checkbox") {
          return [
            { value: "Yes", label: "Yes" },
            { value: "No", label: "No" },
          ];
        }
        return choiceList(entry.column).map((choice) => ({
          value: choice.label,
          label: choice.label,
        }));
      }
      if (entry.key === "assignee") {
        return assignees.map((person) => ({ value: person, label: person }));
      }
      if (entry.key === "move") {
        // The four lifecycle stages, which is what the Group column writes.
        return ["Incoming", "Booked", "Attention", "Completed"].map((stage) => ({
          value: stage,
          label: stage,
        }));
      }
      const optionKey = (
        {
          tier: "tier",
          engineer: "engineer",
          priority: "priority",
          label: "label",
          status: "status",
          location: "storeLocation",
          storeLocation: "storeLocation",
        } as Partial<Record<ColumnKey, BoardOptionColumn>>
      )[entry.key];
      if (!optionKey) return [];
    return optionsFor(optionKey)
      .filter((option) => option.active !== false)
      .map((option) => ({
        /* The tier RULE must store what the FIELD holds — the bare number —
           or `any_of` compares "Tier 3" against 3 and matches nothing. The
           label keeps the full "Tier 3" so the chip still reads properly. */
        value:
          entry.key === "tier"
            ? tierDigits(option.value) || option.value
            : option.value,
        label: option.label ?? option.value,
      }));
  };

  /**
   * Write the board's filter to the columns that carry it.
   *
   * Same shape as `commitSortRules`, and for the same reason: a rule belongs to
   * its column, so one change can add, remove or re-join several at once and
   * only the columns whose stored settings actually differ are written.
   */
  const commitFilterState = (next: BoardFilterState) => {
    const previous = filterState;
    setFilterState(next);
    const touched = new Set([
      ...previous.rules.map((rule) => rule.columnId),
      ...next.rules.map((rule) => rule.columnId),
    ]);
    void (async () => {
      try {
        for (const columnId of touched) {
          const entry = columnsById.get(columnId);
          if (!entry) continue;
          const settings = filterSettingsFor(
            entry.column.settings as Record<string, unknown>,
            next,
            columnId,
          );
          if (JSON.stringify(settings) === JSON.stringify(entry.column.settings)) {
            continue;
          }
          await updateCustomColumn(entry.column, { settings });
        }
      } catch (error) {
        onNotify(
          error instanceof Error
            ? `Filtered, but the choice could not be saved: ${error.message}`
            : "Filtered, but the choice could not be saved.",
        );
      }
    })();
  };

  /**
   * Where each frozen column sits, recomputed whenever a width or an order
   * changes. `visibleBoardColumns` already carries the collapsed override, so a
   * collapsed pin contributes the 44px it actually occupies.
   */
  const stickyOffsets = useMemo(
    () => stickyColumnOffsets(visibleBoardColumns, isMobile),
    [visibleBoardColumns, isMobile],
  );

  /*
   * THE ADD-ITEM ROW WAS THE ONE ROW NOBODY GAVE THE FROZEN OFFSETS TO.
   *
   * The header, the body cells and the summary cells are all handed
   * `stickyOffsets.get(column.id)`. The "+ Add item" cell at the foot of every
   * group never was, and got away with it because `.sheet-column--name` hard-
   * codes `left: 72px` — which is exactly what `stickyColumnOffsets` computes
   * for Items when Items is the first frozen column, so the two agreed by
   * coincidence. Pin a column, or drag a pinned column ahead of Items, and the
   * coincidence ends: the rest of the frozen edge moves to its new offset and
   * the last row of every group stays behind at 72, so the bottom of each
   * group visibly detaches from the column above it partway through a scroll.
   */
  const stickyCellStyle = (columnId: string): CSSProperties => {
    const sticky = stickyOffsets.get(columnId);
    if (!sticky) return {};
    return {
      position: "sticky",
      left: sticky.left,
      zIndex: stickyZIndex(sticky.order, false),
    };
  };

  /**
   * Freeze a column against the left edge, or release it.
   *
   * Optimistic like every other column write here: the grid redraws first and
   * the failure puts it back, because a column that looks pinned and is not is
   * worse than one that refused to pin.
   */
  /**
   * Freeze or unfreeze a column — which MOVES it, because it has to.
   *
   * A frozen column is drawn against the left edge while the rest of the board
   * scrolls underneath. Freezing one in the middle of the board and leaving it
   * there produces a frozen set that is not contiguous, and there is no
   * arrangement of offsets that draws that correctly: the frozen column is
   * painted at the left edge on top of whatever has scrolled beneath it, and
   * the columns between vanish behind it. Measured on the Preview before this
   * was fixed — freezing the third column left sticky offsets on columns 0 and
   * 2, with column 1 underneath the second of them.
   *
   * The drag already ends in `withFrozenColumnsLeading` for exactly this
   * reason. Pinning is the other way into the same illegal arrangement, so it
   * ends there too: the flag is written, then the order that flag implies.
   */
  const toggleColumnPinned = async (entry: BoardDisplayColumn) => {
    const next = entry.column.pinned !== true;
    setColumnMenuInstance(null);
    const apply = (pinned: boolean) => (current: MaintenanceBoardColumn[]) =>
      current.map((item) =>
        item.id === entry.column.id ? { ...item, pinned } : item,
      );
    if (entry.column.system) setSystemColumns(apply(next));
    else setCustomColumns(apply(next));
    try {
      await updateCustomColumn(entry.column, { pinned: next });
      onNotify(
        next
          ? `${entry.column.title} is frozen to the left.`
          : `${entry.column.title} scrolls with the board again.`,
      );

      /*
       * The order the new flag implies. Computed from the columns as they are
       * about to be rather than from state, which has only just been asked to
       * change and has not re-rendered yet.
       */
      const requested = withFrozenColumnsLeading(
        visibleBoardColumns.map((item) =>
          item.column.id === entry.column.id
            ? ({ ...item, column: { ...item.column, pinned: next } } as BoardDisplayColumn)
            : item,
        ),
      );
      const moved = requested.some(
        (item, index) => item.column.id !== visibleBoardColumns[index]?.column.id,
      );
      // Unfreezing leaves the column where it is: the run is still contiguous
      // without it, and a column that jumps back across the board when it is
      // released is not what anybody asked for.
      if (moved) await applyColumnOrder(requested);
    } catch (error) {
      if (entry.column.system) setSystemColumns(apply(!next));
      else setCustomColumns(apply(!next));
      onNotify(
        error instanceof Error ? error.message : "The column could not be pinned.",
      );
    }
  };

  /** Which summary the group footer runs over this column. "" means the default. */
  const setColumnSummary = async (
    column: MaintenanceBoardColumn,
    summary: string,
  ) => {
    setColumnMenuInstance(null);
    const apply = (value: string | null) => (current: MaintenanceBoardColumn[]) =>
      current.map((item) =>
        item.id === column.id ? { ...item, summary: value } : item,
      );
    const previous = column.summary ?? null;
    if (column.system) setSystemColumns(apply(summary || null));
    else setCustomColumns(apply(summary || null));
    try {
      await updateCustomColumn(column, { summary });
    } catch (error) {
      if (column.system) setSystemColumns(apply(previous));
      else setCustomColumns(apply(previous));
      onNotify(
        error instanceof Error ? error.message : "The summary could not be changed.",
      );
    }
  };

  /**
   * Write a new column order.
   *
   * PATCH /api/board/columns has taken a bulk `[{ id, position }]` since Stage
   * 1 and no UI ever called it. It is called here rather than through
   * /api/board's `update_column` because reordering is one request for the
   * whole board: sending 26 individual writes would leave the board in a
   * half-reordered state if one of them failed.
   *
   * Positions are renumbered in thousands so a later "add column to the right"
   * still has room to insert between two neighbours, which is the same spacing
   * the seeder and `create_column` use.
   */
  const applyColumnOrder = async (requested: BoardDisplayColumn[]) => {
    /*
     * FROZEN COLUMNS KEEP THE LEADING REGION — see `withFrozenColumnsLeading`.
     *
     * A frozen column drawn between two scrolling ones cannot be laid out: its
     * offset would no longer continue the run from the left edge, so it would
     * be painted over whatever had scrolled beneath it. The rule is applied
     * here rather than in each caller so a drag, a menu move and anything added
     * later all obey it, and the operator is told when it moved something,
     * because a board that quietly disagrees with the gesture is worse than one
     * that explains itself.
     */
    const ordered = withFrozenColumnsLeading(requested);
    if (ordered !== requested) {
      onNotify("Frozen columns stay at the left of the board.");
    }
    const positions = ordered.map((entry, index) => ({
      id: entry.column.id,
      position: index * 1000,
    }));
    const positionById = new Map(positions.map((entry) => [entry.id, entry.position]));
    const reposition = (current: MaintenanceBoardColumn[]) =>
      current.map((column) =>
        positionById.has(column.id)
          ? { ...column, position: positionById.get(column.id)! }
          : column,
      );
    const previousSystem = systemColumns;
    const previousCustom = customColumns;
    setSystemColumns(reposition);
    setCustomColumns(reposition);
    setColumnMenuInstance(null);
    try {
      const response = await fetch(boardUrl("/api/board/columns", boardId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: positions }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || "The column order could not be saved.");
      }
    } catch (error) {
      setSystemColumns(previousSystem);
      setCustomColumns(previousCustom);
      onNotify(
        error instanceof Error ? error.message : "The column order could not be saved.",
      );
    }
  };

  /*
   * DRAGGING A COLUMN HEADER.
   *
   * The gesture itself is in board-column-drag-gesture.ts and its arithmetic in
   * board-column-drag.ts — including the reason it is pointer events rather
   * than the DOM drag API, which is that the header's title is an absolutely
   * positioned centring overlay with `pointer-events: none` and `draggable` on
   * it never received a `mousedown`.
   *
   * The board hands it three things: the columns on screen, whether the
   * snapshot has landed, and what to do with a new order.
   */
  const {
    columnDrag,
    onColumnPointerDown,
    onColumnPointerMove,
    onColumnPointerUp,
    onColumnPointerCancel,
    onColumnClickCapture,
  } = useColumnHeaderDrag({
    columns: visibleBoardColumns,
    loading: loadingBoard,
    onReorder: (order) => void applyColumnOrder(order),
  });

  /** Move one column one place left or right, among the columns on screen. */
  const moveColumnBy = async (entry: BoardDisplayColumn, delta: -1 | 1) => {
    const from = visibleBoardColumns.findIndex(
      (item) => item.column.id === entry.column.id,
    );
    const to = from + delta;
    if (from < 0 || to < 0 || to >= visibleBoardColumns.length) return;
    const ordered = [...visibleBoardColumns];
    const [moved] = ordered.splice(from, 1);
    ordered.splice(to, 0, moved);
    await applyColumnOrder(ordered);
  };

  /**
   * Ask the server for a CSV of these rows and hand it to the browser.
   *
   * Four controls export — the page heading, the toolbar, a group's menu and
   * the selection bar — and each passes a different set of rows. What they
   * share is the columns being drawn and the failure path, which is why the
   * request is assembled once here: a refusal has to reach the operator with
   * the server's own sentence, not disappear into a download that never starts.
   */
  const exportRowsToCsv = async (rows: MaintenanceRequest[]) => {
    try {
      await downloadBoardCsv({
        boardId,
        requests: rows,
        columns: visibleBoardColumns.map((entry) => entry.column),
      });
    } catch (error) {
      onNotify(
        error instanceof Error ? error.message : "The board could not be exported.",
      );
    }
  };

  /** Opens the filter panel with a rule already started on one column. */
  const filterByColumn = (entry: BoardDisplayColumn) => {
    setColumnMenuInstance(null);
    setSortPanelOpen(false);
    setFilterPanelOpen(true);
    if (findFilterRule(filterState, entry.column.id)) return;
    const first = operatorsFor(entry)[0];
    if (!first) return;
    commitFilterState(
      setFilterRule(filterState, {
        columnId: entry.column.id,
        operator: first.key,
        values: [],
      }),
    );
  };

  /**
   * The toolbar's one-click sort, and what it is called right now.
   *
   * On maintenance it is Date Requested; on Store Documentation the Store name,
   * because a store is not a ticket and has no meaningful "requested" date.
   * Either way it now writes a RULE on a real column, which is the fix: the old
   * Newest/Oldest set a private flag that reordered the CSV and nothing on
   * screen, because every group is re-sorted by the board's own comparator.
   *
   * With no rule set the board is in its base order — newest first — so that is
   * what the label says, and the first click moves it to oldest.
   */
  const quickSortColumn = isStoreDocumentation
    ? itemNameColumn
    : systemColumns.find((column) => column.key === "requested") ?? null;
  const quickSortDirection = quickSortColumn
    ? sortDirectionFor(sortRules, quickSortColumn.id)
    : null;
  const quickSortLabel = isStoreDocumentation
    ? {
        text: quickSortDirection === "desc" ? "Z–A" : "A–Z",
        aria: "Sort stores by name",
      }
    : {
        text: quickSortDirection === "asc" ? "Oldest" : "Newest",
        aria: "Sort by the date each job was requested",
      };
  const quickSortToggle = () => {
    if (!quickSortColumn) return;
    commitSortRules(
      replaceSortRules(
        quickSortColumn.id,
        quickSortDirection === "asc" ? "desc" : "asc",
      ),
    );
  };

  const openColumnPickerAfter = (
    groupId: string,
    column: MaintenanceBoardColumn | null,
  ) => {
    setColumnInsertAfterId(column?.id ?? null);
    setColumnPickerGroupId(groupId);
    setColumnMenuInstance(null);
    setGroupMenuId(null);
    setRowMenuId(null);
  };

  const previewColumnWidth = (
    column: MaintenanceBoardColumn,
    width: number,
  ) => {
    const updateWidth = (current: MaintenanceBoardColumn[]) =>
      current.map((item) =>
        item.id === column.id ? { ...item, width } : item,
      );
    if (column.system) setSystemColumns(updateWidth);
    else setCustomColumns(updateWidth);
  };

  const commitColumnWidth = async (
    column: MaintenanceBoardColumn,
    width: number,
  ) => {
    try {
      await updateCustomColumn(column, { width });
    } catch (error) {
      previewColumnWidth(column, column.width);
      onNotify(
        error instanceof Error
          ? error.message
          : "The column width could not be saved.",
      );
    }
  };

  const duplicateCustomColumn = async (column: MaintenanceBoardColumn) => {
    if (columnBusy) return;
    setColumnBusy(true);
    setColumnMenuInstance(null);
    try {
      const response = await fetch(boardUrl("/api/board", boardId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "duplicate_column",
          columnId: column.id,
        }),
      });
      const payload = (await response.json()) as {
        column?: MaintenanceBoardColumn;
        cells?: MaintenanceBoardCell[];
        error?: string;
      };
      if (!response.ok || !payload.column) {
        throw new Error(payload.error || "The column could not be duplicated.");
      }
      setCustomColumns((current) => [...current, payload.column!]);
      if (payload.cells?.length) {
        setCustomCells((current) => ({
          ...current,
          ...Object.fromEntries(
            payload.cells!.map((cell) => [
              customCellKey(cell.requestId, cell.columnId),
              cell.value,
            ]),
          ),
        }));
      }
      onNotify(`${payload.column.title} added.`);
    } catch (error) {
      onNotify(
        error instanceof Error
          ? error.message
          : "The column could not be duplicated.",
      );
    } finally {
      setColumnBusy(false);
    }
  };

  const clearCustomColumn = async (column: MaintenanceBoardColumn) => {
    if (
      !window.confirm(
        `Clear every value${column.type === "files" ? " and file" : ""} in "${column.title}"? This cannot be undone.`,
      )
    ) {
      return;
    }
    setColumnMenuInstance(null);
    try {
      const response = await fetch(boardUrl("/api/board", boardId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "clear_column",
          columnId: column.id,
        }),
      });
      const payload = (await response.json()) as {
        cleared?: boolean;
        error?: string;
      };
      if (!response.ok || !payload.cleared) {
        throw new Error(payload.error || "The column could not be cleared.");
      }
      setCustomCells((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([key]) => !key.endsWith(`::${column.id}`),
          ),
        ),
      );
      setCustomFileCounts((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([key]) => !key.endsWith(`::${column.id}`),
          ),
        ),
      );
      onNotify(`${column.title} cleared.`);
    } catch (error) {
      onNotify(
        error instanceof Error
          ? error.message
          : "The column could not be cleared.",
      );
    }
  };

  const deleteCustomColumn = async (column: MaintenanceBoardColumn) => {
    /*
     * It asks, and it no longer lies.
     *
     * "This cannot be undone" was true when the delete took the cells with it.
     * It goes to the Recycle Bin now — the column, its values and its files —
     * and stays there for thirty days, so the sentence has to say that instead.
     * A confirmation that overstates the danger is not a safe confirmation; it
     * is one that teaches people to stop doing something harmless, and then to
     * click through the one that matters.
     */
    if (
      !window.confirm(
        `Move "${column.title}" and its values${
          column.type === "files" ? " and files" : ""
        } to the Recycle Bin? You can restore it from there for 30 days.`,
      )
    ) {
      return;
    }
    setColumnMenuInstance(null);
    try {
      const response = await fetch(boardUrl("/api/board", boardId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete_column",
          columnId: column.id,
        }),
      });
      const payload = (await response.json()) as {
        deleted?: boolean;
        error?: string;
      };
      if (!response.ok || !payload.deleted) {
        throw new Error(payload.error || "The column could not be deleted.");
      }
      setCustomColumns((current) =>
        current.filter((item) => item.id !== column.id),
      );
      setCustomCells((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([key]) => !key.endsWith(`::${column.id}`),
          ),
        ),
      );
      setCustomFileCounts((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([key]) => !key.endsWith(`::${column.id}`),
          ),
        ),
      );
      onNotify(`${column.title} moved to the Recycle Bin. Restore it from there.`);
    } catch (error) {
      onNotify(
        error instanceof Error
          ? error.message
          : "The column could not be deleted.",
      );
    }
  };

  const saveCustomCell = async (
    request: MaintenanceRequest,
    column: MaintenanceBoardColumn,
    value: string | boolean | { start: string; end: string },
  ) => {
    const key = customCellKey(request.id, column.id);
    const before = customCells[key] ?? "";
    const optimistic = serializeCustomCellValue(column.type, value);
    setCustomCells((current) => ({ ...current, [key]: optimistic }));
    try {
      const response = await fetch(boardUrl("/api/board", boardId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_cell",
          requestId: request.id,
          columnId: column.id,
          value,
        }),
      });
      const payload = (await response.json()) as {
        cell?: MaintenanceBoardCell;
        automationsRan?: number;
        error?: string;
      };
      if (!response.ok || !payload.cell) {
        throw new Error(payload.error || "The cell could not be saved.");
      }
      setCustomCells((current) => ({
        ...current,
        [key]: payload.cell!.value,
      }));
      /*
       * An automation fired on this edit, so cells this response does not name
       * may have changed too. Refetch rather than keep values the database no
       * longer holds — the board showed the pre-automation value until a manual
       * reload otherwise.
       */
      if (payload.automationsRan) {
        window.dispatchEvent(new Event("maintsupp:refresh-board"));
      }
    } catch (error) {
      setCustomCells((current) => ({ ...current, [key]: before }));
      onNotify(
        error instanceof Error ? error.message : "The cell could not be saved.",
      );
    }
  };

  const createItem = async (groupId: string) => {
    if (saving) return;
    setSaving(true);
    try {
      const response = await fetch(boardUrl("/api/board", boardId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create_item", groupId }),
      });
      const payload = (await response.json()) as {
        request?: MaintenanceRequest;
        item?: MaintenanceGroupItem;
        error?: string;
      };
      if (!response.ok || !payload.request || !payload.item) {
        throw new Error(payload.error || "The item could not be created.");
      }
      setItems((current) => [...current, payload.item!]);
      onRequestCreated(payload.request);
      onNotify(`${payload.request.id} added to the live board.`);
    } catch (error) {
      onNotify(
        error instanceof Error ? error.message : "The item could not be created.",
      );
    } finally {
      setSaving(false);
      setActionsOpen(false);
    }
  };

  const createGroup = async () => {
    if (saving || newGroupName.trim().length < 2) return;
    setSaving(true);
    try {
      const response = await fetch(boardUrl("/api/board", boardId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_group",
          name: newGroupName,
          color: newGroupColor,
        }),
      });
      const payload = (await response.json()) as {
        group?: MaintenanceGroup;
        error?: string;
      };
      if (!response.ok || !payload.group) {
        throw new Error(payload.error || "The group could not be created.");
      }
      setGroups((current) => [...current, payload.group!]);
      setNewGroupName("");
      setShowGroupCreator(false);
      onNotify(`${payload.group.name} created.`);
    } catch (error) {
      onNotify(
        error instanceof Error
          ? error.message
          : "The group could not be created.",
      );
    } finally {
      setSaving(false);
    }
  };

  const renameGroup = async (group: MaintenanceGroup) => {
    const name = renameValue.trim();
    if (name.length < 2 || name === group.name) {
      setRenamingId(null);
      return;
    }
    const before = group;
    setGroups((current) =>
      current.map((item) => (item.id === group.id ? { ...item, name } : item)),
    );
    setRenamingId(null);
    try {
      const response = await fetch(boardUrl("/api/board", boardId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "rename_group",
          groupId: group.id,
          name,
        }),
      });
      if (!response.ok) throw new Error("The group name could not be saved.");
      onNotify(`Group renamed to ${name}.`);
    } catch (error) {
      setGroups((current) =>
        current.map((item) => (item.id === group.id ? before : item)),
      );
      onNotify(
        error instanceof Error
          ? error.message
          : "The group name could not be saved.",
      );
    }
  };

  const updateGroupColor = async (group: MaintenanceGroup, color: string) => {
    if (color === group.color) {
      setGroupMenuId(null);
      return;
    }
    const before = group;
    setGroups((current) =>
      current.map((item) => (item.id === group.id ? { ...item, color } : item)),
    );
    setGroupMenuId(null);
    try {
      const response = await fetch(boardUrl("/api/board", boardId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_group", groupId: group.id, color }),
      });
      const payload = (await response.json()) as {
        group?: MaintenanceGroup;
        error?: string;
      };
      if (!response.ok || !payload.group) {
        throw new Error(payload.error || "The group color could not be saved.");
      }
      setGroups((current) =>
        current.map((item) =>
          item.id === payload.group!.id ? payload.group! : item,
        ),
      );
      onNotify(`${group.name} color updated.`);
    } catch (error) {
      setGroups((current) =>
        current.map((item) => (item.id === group.id ? before : item)),
      );
      onNotify(
        error instanceof Error
          ? error.message
          : "The group color could not be saved.",
      );
    }
  };

  const moveGroup = async (group: MaintenanceGroup, direction: "up" | "down") => {
    setGroupMenuId(null);
    try {
      const response = await fetch(boardUrl("/api/board", boardId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "move_group", groupId: group.id, direction }),
      });
      const payload = (await response.json()) as {
        groups?: MaintenanceGroup[];
        error?: string;
      };
      if (!response.ok || !payload.groups) {
        throw new Error(payload.error || "The group could not be moved.");
      }
      setGroups(payload.groups);
      onNotify(`${group.name} moved ${direction}.`);
    } catch (error) {
      onNotify(
        error instanceof Error ? error.message : "The group could not be moved.",
      );
    }
  };

  const sortGroup = async (
    group: MaintenanceGroup,
    mode: "alphabetical" | "newest",
  ) => {
    const rows = requests
      .filter((request) => groupForRequest(request) === group.id)
      .sort((a, b) =>
        mode === "alphabetical"
          ? a.description.localeCompare(b.description, undefined, {
              sensitivity: "base",
            })
          : new Date(b.requestedAt).getTime() -
            new Date(a.requestedAt).getTime(),
      );
    setGroupMenuId(null);
    try {
      const response = await fetch(boardUrl("/api/board", boardId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sort_group",
          groupId: group.id,
          requestIds: rows.map((request) => request.id),
        }),
      });
      const payload = (await response.json()) as {
        items?: MaintenanceGroupItem[];
        error?: string;
      };
      if (!response.ok || !payload.items) {
        throw new Error(payload.error || "The group could not be sorted.");
      }
      setItems((current) => [
        ...current.filter((item) => item.groupId !== group.id),
        ...payload.items!,
      ]);
      onNotify(
        `${group.name} sorted ${mode === "alphabetical" ? "A–Z" : "newest first"}.`,
      );
    } catch (error) {
      onNotify(
        error instanceof Error ? error.message : "The group could not be sorted.",
      );
    }
  };

  const duplicateGroup = async (group: MaintenanceGroup) => {
    if (saving) return;
    const sourceRows = requests
      .filter((request) => groupForRequest(request) === group.id)
      .sort(
        (a, b) =>
          (placement.get(a.id)?.position ?? Number.MAX_SAFE_INTEGER) -
          (placement.get(b.id)?.position ?? Number.MAX_SAFE_INTEGER),
      );
    setSaving(true);
    setGroupMenuId(null);
    try {
      const groupResponse = await fetch(boardUrl("/api/board", boardId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_group",
          name: `${group.name} copy`,
          color: group.color,
        }),
      });
      const groupPayload = (await groupResponse.json()) as {
        group?: MaintenanceGroup;
        error?: string;
      };
      if (!groupResponse.ok || !groupPayload.group) {
        throw new Error(groupPayload.error || "The group could not be copied.");
      }
      const createdGroup = groupPayload.group;
      setGroups((current) => [...current, createdGroup]);

      if (sourceRows.length) {
        const duplicateResponse = await fetch(boardUrl("/api/board", boardId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "duplicate_items",
            requestIds: sourceRows.map((request) => request.id),
          }),
        });
        const duplicatePayload = (await duplicateResponse.json()) as {
          requests?: MaintenanceRequest[];
          items?: MaintenanceGroupItem[];
          cells?: MaintenanceBoardCell[];
          error?: string;
        };
        if (!duplicateResponse.ok || !duplicatePayload.requests) {
          throw new Error(
            duplicatePayload.error || "The group items could not be copied.",
          );
        }
        const duplicateIds = duplicatePayload.requests.map((request) => request.id);
        const moveResponse = await fetch(boardUrl("/api/board", boardId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "move_items",
            requestIds: duplicateIds,
            groupId: createdGroup.id,
          }),
        });
        const movePayload = (await moveResponse.json()) as {
          items?: MaintenanceGroupItem[];
          requests?: MaintenanceRequest[];
          error?: string;
        };
        if (!moveResponse.ok || !movePayload.items) {
          throw new Error(movePayload.error || "The copied items could not be moved.");
        }
        setItems((current) => [...current, ...movePayload.items!]);
        for (const created of duplicatePayload.requests) onRequestCreated(created);
        for (const updated of movePayload.requests ?? []) onRequestChange(updated);
        if (duplicatePayload.cells?.length) {
          setCustomCells((current) => ({
            ...current,
            ...Object.fromEntries(
              duplicatePayload.cells!.map((cell) => [
                customCellKey(cell.requestId, cell.columnId),
                cell.value,
              ]),
            ),
          }));
        }
      }
      onNotify(`${group.name} copied with ${sourceRows.length} items.`);
    } catch (error) {
      onNotify(
        error instanceof Error ? error.message : "The group could not be copied.",
      );
    } finally {
      setSaving(false);
    }
  };

  const deleteGroup = async (group: MaintenanceGroup) => {
    const target = groups.find((item) => item.id !== group.id);
    if (!target) {
      onNotify("The board must keep at least one group.");
      setGroupMenuId(null);
      return;
    }
    if (
      !window.confirm(
        `Delete "${group.name}"? Its items will be moved safely to "${target.name}".`,
      )
    ) {
      return;
    }
    setGroupMenuId(null);
    try {
      const response = await fetch(boardUrl("/api/board", boardId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete_group",
          groupId: group.id,
          targetGroupId: target.id,
        }),
      });
      const payload = (await response.json()) as {
        deleted?: boolean;
        items?: MaintenanceGroupItem[];
        requests?: MaintenanceRequest[];
        error?: string;
      };
      if (!response.ok || !payload.deleted) {
        throw new Error(payload.error || "The group could not be deleted.");
      }
      setGroups((current) => current.filter((item) => item.id !== group.id));
      setItems((current) => [
        ...current.filter((item) => item.groupId !== group.id),
        ...(payload.items ?? []),
      ]);
      for (const updated of payload.requests ?? []) onRequestChange(updated);
      onNotify(`${group.name} deleted; its items moved to ${target.name}.`);
    } catch (error) {
      onNotify(
        error instanceof Error ? error.message : "The group could not be deleted.",
      );
    }
  };

  const moveItem = async (
    request: MaintenanceRequest,
    groupId: string,
    beforeRequestId: string | null = null,
  ) => {
    if (beforeRequestId === request.id) return;
    const beforeItems = items;
    const sourceGroupId =
      placement.get(request.id)?.groupId ?? groupForRequest(request);
    const currentOrder = items
      .filter((item) => item.groupId === groupId)
      .sort((left, right) => left.position - right.position)
      .map((item) => item.requestId);
    const nextItems = moveBoardItemPlacement(
      items,
      request.id,
      groupId,
      beforeRequestId,
    );
    const nextOrder = nextItems
      .filter((item) => item.groupId === groupId)
      .sort((left, right) => left.position - right.position)
      .map((item) => item.requestId);
    if (
      sourceGroupId === groupId &&
      currentOrder.length === nextOrder.length &&
      currentOrder.every((requestId, index) => requestId === nextOrder[index])
    ) {
      return;
    }
    setItems(nextItems);
    try {
      const response = await fetch(boardUrl("/api/board", boardId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "move_item",
          requestId: request.id,
          groupId,
          beforeRequestId,
        }),
      });
      const payload = (await response.json()) as {
        item?: MaintenanceGroupItem;
        items?: MaintenanceGroupItem[];
        request?: MaintenanceRequest | null;
        error?: string;
      };
      if (!response.ok || !payload.item) {
        throw new Error(payload.error || "The item could not be moved.");
      }
      const persistedItems = payload.items?.length
        ? payload.items
        : [payload.item];
      const persistedIds = new Set(
        persistedItems.map((item) => item.requestId),
      );
      setItems((current) => [
        ...current.filter(
          (item) =>
            item.requestId !== request.id &&
            !persistedIds.has(item.requestId),
        ),
        ...persistedItems,
      ]);
      if (payload.request) {
        onRequestChange(payload.request);
      }
      const target = groups.find((group) => group.id === groupId);
      onNotify(
        sourceGroupId === groupId
          ? `${request.id} reordered in ${target?.name ?? "group"}.`
          : `${request.id} moved to ${target?.name ?? "group"}.`,
      );
    } catch (error) {
      setItems(beforeItems);
      onNotify(
        error instanceof Error ? error.message : "The item could not be moved.",
      );
    }
  };

  /*
   * THE ROW DRAG LIVES IN `board-row-drag-gesture.ts` NOW.
   *
   * It used to be two hundred lines here: a hold timer that armed on any press
   * anywhere in a row, a hit test on every pointer move, and a scroll that
   * jumped the board 24px per event. Between them they made a sideways swipe on
   * a phone a coin toss between a pan and a half-lifted row that died to
   * `pointercancel`. That file is where the fix and its reasoning live.
   *
   * What stays here is the only part of the drag the BOARD owns: what a drop
   * means. `moveItem` above is untouched, optimistic apply and rollback
   * included — the persistence was never the defect.
   */
  const {
    onRowPointerDown,
    onRowPointerMove,
    onRowPointerUp,
    onRowPointerCancel,
  } = useBoardRowDrag({
    onDrop: (item, target) =>
      void moveItem(item.request, target.groupId, target.beforeRequestId),
    onDragStart: () => {
      setRowMenuId(null);
      setGroupMenuId(null);
      setColumnMenuInstance(null);
      setColumnPickerGroupId(null);
    },
  });

  const setRowsSelected = (requestIds: string[], selected: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const requestId of requestIds) {
        if (selected) next.add(requestId);
        else next.delete(requestId);
      }
      return next;
    });
  };

  const runBulkAction = async (
    action:
      | "duplicate_items"
      | "move_items"
      | "archive_items"
      | "delete_items",
    requestIds = Array.from(selectedIds),
    groupId?: string,
  ) => {
    if (!requestIds.length || bulkBusy) return;
    if (
      action === "delete_items" &&
      /*
       * The same honesty fix the column delete got: `delete_items` is a SOFT
       * delete into the Recycle Bin, and a confirmation that claims "this
       * cannot be undone" about a recoverable action teaches people to click
       * through the one that is telling the truth.
       */
      !window.confirm(
        `Move ${requestIds.length} selected item${requestIds.length === 1 ? "" : "s"} and their files to the Recycle Bin? You can restore them from there for 30 days.`,
      )
    ) {
      return;
    }
    setBulkBusy(true);
    setRowMenuId(null);
    setSelectionMoveOpen(false);
    try {
      const response = await fetch(boardUrl("/api/board", boardId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, requestIds, groupId }),
      });
      const payload = (await response.json()) as {
        requests?: MaintenanceRequest[];
        items?: MaintenanceGroupItem[];
        cells?: MaintenanceBoardCell[];
        group?: MaintenanceGroup;
        deletedIds?: string[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "The selected items could not be changed.");
      }

      if (action === "duplicate_items") {
        setItems((current) => [...current, ...(payload.items ?? [])]);
        for (const created of payload.requests ?? []) onRequestCreated(created);
        if (payload.cells?.length) {
          setCustomCells((current) => ({
            ...current,
            ...Object.fromEntries(
              payload.cells!.map((cell) => [
                customCellKey(cell.requestId, cell.columnId),
                cell.value,
              ]),
            ),
          }));
        }
        onNotify(
          `${payload.requests?.length ?? 0} item${payload.requests?.length === 1 ? "" : "s"} duplicated.`,
        );
      } else if (action === "delete_items") {
        const deletedIds = payload.deletedIds ?? requestIds;
        setItems((current) =>
          current.filter((item) => !deletedIds.includes(item.requestId)),
        );
        onRequestsDeleted(deletedIds);
        onNotify(
          `${deletedIds.length} item${deletedIds.length === 1 ? "" : "s"} moved to the Recycle Bin.`,
        );
      } else {
        if (
          payload.group &&
          !groups.some((group) => group.id === payload.group!.id)
        ) {
          setGroups((current) => [...current, payload.group!]);
        }
        setItems((current) => [
          ...current.filter(
            (item) =>
              !(payload.items ?? []).some(
                (moved) => moved.requestId === item.requestId,
              ),
          ),
          ...(payload.items ?? []),
        ]);
        for (const updated of payload.requests ?? []) onRequestChange(updated);
        onNotify(
          action === "archive_items"
            ? `${requestIds.length} item${requestIds.length === 1 ? "" : "s"} archived.`
            : `${requestIds.length} item${requestIds.length === 1 ? "" : "s"} moved to ${payload.group?.name ?? "the selected group"}.`,
        );
      }
      setSelectedIds(new Set());
    } catch (error) {
      onNotify(
        error instanceof Error
          ? error.message
          : "The selected items could not be changed.",
      );
    } finally {
      setBulkBusy(false);
    }
  };

  const openGroupCreator = () => {
    setShowGroupCreator(true);
    setActionsOpen(false);
    window.setTimeout(
      () => document.getElementById("new-group-name")?.focus(),
      0,
    );
  };

  /*
   * The row menu's verbs, published for the item drawer's "⋮" — monday keeps
   * an item's actions at the top right of the item, and a phone has no row
   * gutter to put a "…" in. The handlers above are closures rebuilt every
   * render, so a ref holds the latest set and ONE stable facade goes up on
   * mount; the board's own renders never re-render the parent.
   */
  const itemActionSources = useRef<BoardItemActionSources | null>(null);
  useEffect(() => {
    itemActionSources.current = {
      groups,
      storeDocumentation: isStoreDocumentation,
      groupIdFor: (request) => groupForRequest(request) ?? "",
      groupRows,
      subitemCount: (requestId) => subitemsByParent.get(requestId)?.length ?? 0,
      openItemInNewTab,
      copyItemLink,
      createItemBelow,
      addSubitem,
      convertToSubitem,
      moveItem,
      runBulkAction,
    };
  });
  useEffect(() => {
    if (!onItemActionsChange) return undefined;
    onItemActionsChange(
      buildBoardItemActions(boardId, () => itemActionSources.current),
    );
    return () => onItemActionsChange(null);
  }, [boardId, onItemActionsChange]);

  const identity = boardIdentity(boardId);
  const newItemLabel = isStoreDocumentation ? "New store" : "New item";
  const addItemToGroupLabel = isStoreDocumentation ? "Add store to group" : "Add item to group";

  return (
    <MobileBoardContext.Provider value={isMobile}>
    <div className="section-stack live-board-page" ref={pageRef} data-jobs-rail={railState}>
      {boardId === "maintenance" && (
      <section className="analytics-page-heading live-jobs-analytics-heading" ref={anchorRef}>
        <div><span>Live maintenance workspace</span><h1>Live job list</h1></div>
        <AnalyticsToolbar
          portfolio={portfolio}
          portfolios={portfolioChoices}
          onPortfolioChange={setPortfolio}
          period={analyticsPeriod}
          /*
           * The full picker, not the four rolling windows the plain select
           * offered. `withinAnalyticsPeriod` — which is what `scopedRequests`
           * filters on above — already understood the whole vocabulary; only
           * the control was narrower than the code behind it, so a reader could
           * ask for "last 90 days" but not for a named month or a start and end
           * of their own.
           */
          periodControl={
            <PeriodPicker
              value={analyticsPeriod}
              onChange={setAnalyticsPeriod}
              now={analyticsNow}
            />
          }
          onPeriodChange={setAnalyticsPeriod}
          onExport={canExport === false ? undefined : () => void exportRowsToCsv(scopedRequests)}
        />
      </section>
      )}

      {/* `.live-job-metrics`, and `is-collapsed` once it sticks — the classes,
          the refs and the reasoning all live in jobs-meter-strip.tsx.

          `tabIndex` because the strip scrolls sideways at phone widths, and a
          scrolling region with no tab stop cannot be scrolled by keyboard at
          all — the cards past the fold are simply unreachable. */}
      {boardId === "maintenance" && (
        <section
          className={sectionClassName}
          ref={sectionRef}
          aria-label="Job meters"
          tabIndex={0}
        >
        <AnalyticsMetricCard label="Open" value={String(jobAnalytics.open.count)} detail="Active work orders" icon="inbox" tone="teal" trend={jobAnalytics.open.trend} trendLabel={jobMeterTrendLabels.open} />
        <AnalyticsMetricCard label="P1 critical" value={String(jobAnalytics.critical.count)} detail="Urgent or Tier 1" icon="alert" tone="red" trend={jobAnalytics.critical.trend} trendLabel={jobMeterTrendLabels.critical} />
        <AnalyticsMetricCard label="Awaiting parts" value={String(jobAnalytics.parts.count)} detail="Supply dependency" icon="tool" tone="orange" trend={jobAnalytics.parts.trend} trendLabel={jobMeterTrendLabels.parts} />
        <AnalyticsMetricCard label="Awaiting approval" value={String(jobAnalytics.approval.count)} detail="Sign-off required" icon="user" tone="purple" trend={jobAnalytics.approval.trend} trendLabel={jobMeterTrendLabels.approval} />
        <AnalyticsMetricCard label="Closed in period" value={String(jobAnalytics.closed.count)} detail="Completed in this view" icon="check" tone="green" trend={jobAnalytics.closed.trend} trendLabel={jobMeterTrendLabels.closed} />
        <AnalyticsMetricCard label="Avg SLA target" value={jobAnalytics.sla.averageHours === null ? "—" : `${jobAnalytics.sla.averageHours.toFixed(1)} hrs`} detail={`Mean of ${jobAnalytics.sla.sample} due dates`} icon="clock" tone="blue" trend={jobAnalytics.sla.trend} trendLabel={jobMeterTrendLabels.sla} />
        <JobsMeterToggle stuck={meters.stuck} collapsed={meters.collapsed} onToggle={meters.toggle} />
      </section>
      )}

      <section className="section-header live-board-heading">
        <div>
          <span className="eyebrow-chip">
            <Icon name="grid" size={15} />
            {identity.eyebrow}
          </span>
          <h1>{identity.heading}</h1>
          <p>{identity.blurb}</p>
        </div>
        <div className="live-board-heading__meta">
          <span>
            <i className={loadingBoard ? "is-syncing" : ""} />
            {loadingBoard ? "Syncing board" : "All changes saved live"}
          </span>
          <strong>{scopedRequests.length} items</strong>
        </div>
      </section>

      <section className="panel live-board-panel">
        <div className="mobile-board-bar">
          <div>
            <span>
              <Icon name="grid" size={16} />
            </span>
            <span>
              <strong>{identity.shortName}</strong>
              {/* "0 live items" while the first snapshot is still on its way
                  read as an empty board; say what is actually happening. */}
              <small>
                {loadingBoard && !scopedRequests.length
                  ? "Loading…"
                  : `${scopedRequests.length} ${identity.itemNoun}`}
              </small>
            </span>
          </div>
          <span className="mobile-board-table-label">
            <Icon name="list" size={15} />
            Main table
          </span>
          <label
            className="board-theme-picker board-theme-picker--mobile"
            title={`${
              themePreference === "system"
                ? "System"
                : themePreference === "dark"
                  ? "Dark"
                  : "Light"
            } theme`}
          >
            <Icon name={resolvedTheme === "dark" ? "moon" : "sun"} size={17} />
            <select
              aria-label="Colour theme"
              value={themePreference}
              onChange={(event) =>
                setThemeChoice(event.target.value as ThemeChoice)
              }
            >
              <option value="system">System theme</option>
              <option value="light">Light theme</option>
              <option value="dark">Dark theme</option>
            </select>
          </label>
        </div>
        <BoardChrome
          boardId={boardId}
          sectionKey={sectionKey}
          boardName={identity.heading}
          /*
           * Without this the Fix Tracker saved and nothing moved on screen.
           *
           * `BoardChrome` wires its `onChanged` to `onFormSubmitted`, and this
           * call site never passed one — so a completion date, a comment or an
           * upload made in the Fix Tracker wrote to the database and the board
           * behind it kept showing the old value until a manual reload. The
           * refresh event is the convention the rest of the app already uses
           * and this component already listens for.
           */
          onFormSubmitted={() =>
            window.dispatchEvent(new Event("maintsupp:refresh-board"))
          }
          onViewChange={setActiveBoardView}
          items={scopedRequests as never}
          palette={viewPalette}
          onOpenItem={(item) => {
            const match = scopedRequests.find((request) => request.id === item.id);
            if (match) onOpenRequest(match, "columns");
          }}
        >
        <div className="live-board-toolbar">
          <div className="live-board-split" data-board-popover>
            <button
              className="primary-button"
              type="button"
              disabled={saving}
              onClick={() => groups[0] && createItem(groups[0].id)}
            >
              <Icon name="plus" size={17} />
              {newItemLabel}
            </button>
            <button
              type="button"
              aria-label="More new item options"
              onClick={() => {
                setActionsOpen((open) => !open);
                setHideOpen(false);
                setGroupMenuId(null);
                setRowMenuId(null);
                setColumnMenuInstance(null);
                setColumnPickerGroupId(null);
              }}
            >
              <Icon name="chevron" size={15} />
            </button>
            {actionsOpen && (
              <div className="live-board-menu action-menu">
                <button type="button" onClick={onCreateDetailed}>
                  <Icon name="document" size={16} />
                  New item via form
                </button>
                {canEditGroups && (
                  <button type="button" onClick={openGroupCreator}>
                    <Icon name="grid" size={16} />
                    New group of items
                  </button>
                )}
                <span>
                  <Icon name="upload" size={16} />
                  Excel import mapping ready
                </span>
              </div>
            )}
          </div>

          <label className="live-board-search">
            <Icon name="search" size={17} />
            <input
              type="search"
              value={query}
              placeholder={
                isStoreDocumentation ? "Search stores…" : "Search items…"
              }
              aria-label={
                isStoreDocumentation ? "Search stores" : "Search items"
              }
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

          {!isStoreDocumentation && (
            <label className="live-board-tool">
              <Icon name="user" size={16} />
              <select
                aria-label="Filter by person"
                value={assignee}
                onChange={(event) => setAssignee(event.target.value)}
              >
                <option>All</option>
                <option>Unassigned</option>
                {assignees.map((person) => (
                  <option key={person}>{person}</option>
                ))}
              </select>
            </label>
          )}

          <label className="live-board-tool">
            <Icon name="filter" size={16} />
            {storeTypeColumn ? (
              <select
                aria-label={`Filter by ${storeTypeColumn.title}`}
                value={storeType}
                onChange={(event) => setStoreType(event.target.value)}
              >
                <option value="All">All</option>
                {storeTypeChoices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </select>
            ) : (
              /*
                THE OPTIONS THIS WORKSPACE ACTUALLY HAS, not four literals.

                This list read Urgent, High, Medium, Low. The registry holds
                Medium, Low and Urgent — monday's Priority column has no "High"
                — so the dropdown offered a value no job could carry and could
                never match, while any priority an admin added was missing from
                it. Same source as the chips in the grid, so a renamed option
                renames here too.
              */
              <select
                aria-label="Filter by priority"
                value={priority}
                onChange={(event) =>
                  setPriority(event.target.value as "All" | Priority)
                }
              >
                <option value="All">All</option>
                {optionsFor("priority").map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label ?? option.value}
                  </option>
                ))}
              </select>
            )}
          </label>

          {/*
            SORT — the composite control, beside the quick sort in every header.

            The button is the fast path this toolbar always had: on maintenance
            it flips the board between newest and oldest first, on Store
            Documentation between A–Z and Z–A, because a store is not a ticket
            and has no meaningful "requested" date. What changed is that both
            now write a RULE on a real column — Date Requested, or the Store
            column — instead of a private flag the grid ignored. The old
            Newest/Oldest reordered the CSV and nothing on screen, because
            `groupedRows` re-sorted every group by stored position underneath
            it.

            The chevron beside it opens the full ordered sort, where a
            tie-breaker can be added, reordered or dropped.
          */}
          <div className="live-board-menu-wrap live-board-rules-wrap" data-board-popover>
            <button
              className="live-board-tool"
              type="button"
              aria-label={quickSortLabel.aria}
              onClick={quickSortToggle}
            >
              <Icon name="activity" size={16} />
              {quickSortLabel.text}
            </button>
            <button
              className="live-board-tool live-board-tool--adjacent"
              type="button"
              aria-label="Open the board's sort rules"
              aria-expanded={sortPanelOpen}
              onClick={() => {
                setSortPanelOpen((open) => !open);
                setFilterPanelOpen(false);
                setActionsOpen(false);
                setHideOpen(false);
              }}
            >
              {sortRules.length > 1 && (
                <span className="live-board-tool__count">{sortRules.length}</span>
              )}
              <Icon name="chevron" size={14} />
            </button>
            {sortPanelOpen && (
              <BoardSortPanel
                columns={sortableColumns}
                rules={sortRules}
                onReplace={(columnId, direction) =>
                  commitSortRules(replaceSortRules(columnId, direction))
                }
                onAdd={(columnId, direction) =>
                  commitSortRules(addSortRule(sortRules, columnId, direction))
                }
                onFlip={(columnId) => commitSortRules(flipSortRule(sortRules, columnId))}
                onMove={(columnId, delta) =>
                  commitSortRules(moveSortRule(sortRules, columnId, delta))
                }
                onRemove={(columnId) => commitSortRules(removeSortRule(sortRules, columnId))}
                onClear={() => commitSortRules([])}
                onClose={() => setSortPanelOpen(false)}
              />
            )}
          </div>

          {/*
            FILTER — the structured one. The engine behind it has been in
            views/view-model.ts since Stage 6 with all thirteen of monday's
            operators; nothing on the grid could reach it. The search box above
            and the two dropdowns beside it are untouched and AND with whatever
            is set here.
          */}
          <div className="live-board-menu-wrap live-board-rules-wrap" data-board-popover>
            <button
              className={`live-board-tool${filterState.rules.length ? " is-active" : ""}`}
              type="button"
              aria-expanded={filterPanelOpen}
              onClick={() => {
                setFilterPanelOpen((open) => !open);
                setSortPanelOpen(false);
                setActionsOpen(false);
                setHideOpen(false);
              }}
            >
              <Icon name="filter" size={16} />
              Filter
              {filterState.rules.length > 0 && (
                <span className="live-board-tool__count">{filterState.rules.length}</span>
              )}
            </button>
            {filterPanelOpen && (
              <BoardFilterPanel
                columns={filterableColumns}
                state={filterState}
                choicesFor={filterChoicesFor}
                kindFor={filterKindFor}
                matched={visibleRows.length}
                total={filtered.length}
                onJoinChange={(join) => commitFilterState({ ...filterState, join })}
                onRuleChange={(rule) => commitFilterState(setFilterRule(filterState, rule))}
                onRemove={(columnId) =>
                  commitFilterState(removeFilterRule(filterState, columnId))
                }
                onClear={() => commitFilterState({ join: filterState.join, rules: [] })}
                onClose={() => setFilterPanelOpen(false)}
              />
            )}
          </div>

          <div className="live-board-menu-wrap" data-board-popover>
            <button
              ref={hideButtonRef}
              className="live-board-tool"
              type="button"
              aria-expanded={hideOpen}
              onClick={() => {
                setHideOpen((open) => !open);
                setActionsOpen(false);
                setGroupMenuId(null);
                setRowMenuId(null);
                setColumnMenuInstance(null);
                setColumnPickerGroupId(null);
              }}
            >
              <Icon name="grid" size={16} />
              Hide
            </button>
            <AnchoredPopover
              open={hideOpen}
              anchorRef={hideButtonRef}
              onClose={() => setHideOpen(false)}
              role="dialog"
              label="Visible columns"
            >
              <div className="live-board-menu column-menu">
                <strong>Visible columns</strong>
                {allBoardColumns.map((entry) => {
                  const key = visibilityKeyFor(entry);
                  return (
                    <label key={key}>
                      <input
                        type="checkbox"
                        checked={visible(key)}
                        onChange={() => void setColumnVisible(entry, !visible(key))}
                      />
                      {entry.column.title}
                    </label>
                  );
                })}
              </div>
            </AnchoredPopover>
          </div>

          {/*
            Group by — monday keeps this on the toolbar as well as in each
            column's menu, because it is a property of the whole board rather
            than of one column. "Board groups" restores the stored grouping.
          */}
          {!isStoreDocumentation && (
            <label className="live-board-tool">
              <Icon name="grid" size={16} />
              <select
                aria-label="Group the board by"
                value={groupByColumn ?? ""}
                onChange={(event) => setGroupByColumn(event.target.value || null)}
              >
                <option value="">Board groups</option>
                {allBoardColumns
                  .filter((entry) => entry.column.type !== "subitems")
                  .map((entry) => (
                    <option key={entry.column.id} value={entry.column.id}>
                      {entry.column.title}
                    </option>
                  ))}
              </select>
            </label>
          )}

          {/*
            The export controls are drawn only where the server would allow one.
            THE RULE IS NOT HERE — POST /api/board/csv holds `data.export` and
            refuses without it — so this is a courtesy, not a gate, and it reads
            the same answer the server enforces with rather than guessing from a
            role. `canExport === null` means the answer is still in flight, and
            the button is drawn: flashing every control off on each page load
            reads as a permissions fault.
          */}
          {canExport !== false && (
            <button
              className="live-board-tool"
              type="button"
              onClick={() => void exportRowsToCsv(exportRows)}
            >
              <Icon name="download" size={16} />
              Export
            </button>
          )}
        </div>
        </BoardChrome>

        {showGroupCreator && !isStoreDocumentation && !gridReplaced && (
          <div className="group-creator">
            <div>
              <span>Create a new group</span>
              <strong>Give this part of the board a clear workflow name.</strong>
            </div>
            <input
              id="new-group-name"
              value={newGroupName}
              placeholder="e.g. Quotes received"
              onChange={(event) => setNewGroupName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") createGroup();
                if (event.key === "Escape") setShowGroupCreator(false);
              }}
            />
            <div className="group-color-picker">
              {groupColors.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-label={`Use ${color}`}
                  className={newGroupColor === color ? "is-active" : ""}
                  style={{ "--group-color": color } as CSSProperties}
                  onClick={() => setNewGroupColor(color)}
                />
              ))}
            </div>
            <button
              className="primary-button"
              type="button"
              disabled={newGroupName.trim().length < 2 || saving}
              onClick={createGroup}
            >
              Create group
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="Cancel group creation"
              onClick={() => setShowGroupCreator(false)}
            >
              <Icon name="close" size={17} />
            </button>
          </div>
        )}

        {isMobile && !gridReplaced && (
          <BoardMobileSection
            layout={mobileLayout}
            onChooseLayout={chooseMobileLayout}
            groups={displayGroups.map(({ group }) => ({
              group,
              // Subitems belong to their parent's card, not beside it.
              rows: groupRows(group.id).filter((request) => !request.parentId),
            }))}
            collapsed={collapsed}
            onToggleGroup={(groupId) =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(groupId)) next.delete(groupId);
                else next.add(groupId);
                return next;
              })
            }
            onOpenItem={(request) => onOpenRequest(request)}
            photoColumns={allBoardColumns
              .filter(
                (entry) =>
                  entry.kind === "custom" &&
                  (entry.column.key === "issuePictures" ||
                    entry.column.key === "completedPictures"),
              )
              .map((entry) => entry.column.id)}
            fileCounts={customFileCounts}
            searching={Boolean(query.trim())}
          />
        )}

        <div
          className="live-board-scroll"
          tabIndex={0}
          aria-label="Maintenance board"
          // The grid stays mounted and measurable; a phone showing cards simply
          // does not draw it. `hidden` rather than unmounting keeps column
          // widths, scroll position and the drag machinery intact for the
          // switch back — which is why a non-table view tab hides it the same
          // way rather than unmounting it: switching back to Main table must
          // land on the board you left, not on a rebuilt one.
          hidden={(isMobile && mobileLayout === "cards") || gridReplaced}
        >
          <div className="live-board-canvas">
            {displayGroups.map(({ group, synthetic }) => {
              const rows = groupRows(group.id);
              const isCollapsed = collapsed.has(group.id);
              /*
               * `is-drop-target` and `is-drop-at-end` are NOT computed here.
               * The drag paints them straight onto this element — see the note
               * in board-row-drag-gesture.ts. Recomputing them in the render
               * meant one full pass over 38 groups for every gap a drag
               * crossed, which measured at 517ms.
               */
              return (
                <section
                  className={`sheet-group${
                    isCollapsed ? "" : ` ${DEFERRED_GROUP_CLASS}`
                  }`}
                  key={group.id}
                  data-board-group-id={group.id}
                  style={{
                    "--group-color": group.color,
                    "--group-height": `${deferredGroupHeight(rows.length)}px`,
                  } as CSSProperties}
                >
                  <header className="sheet-group__header">
                    <button
                      type="button"
                      aria-label={
                        isCollapsed
                          ? `Expand ${group.name}`
                          : `Collapse ${group.name}`
                      }
                      onClick={() =>
                        setCollapsed((current) => {
                          const next = new Set(current);
                          if (next.has(group.id)) next.delete(group.id);
                          else next.add(group.id);
                          return next;
                        })
                      }
                    >
                      <Icon name="chevron" size={16} />
                    </button>
                    {renamingId === group.id ? (
                      <input
                        value={renameValue}
                        autoFocus
                        onChange={(event) => setRenameValue(event.target.value)}
                        onBlur={() => renameGroup(group)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") renameGroup(group);
                          if (event.key === "Escape") setRenamingId(null);
                        }}
                      />
                    ) : (
                      <button
                        className="sheet-group__name"
                        type="button"
                        title="Double-click to rename"
                        onDoubleClick={() => {
                          setRenamingId(group.id);
                          setRenameValue(group.name);
                        }}
                      >
                        {group.name}
                      </button>
                    )}
                    <span>{rows.length} items</span>
                    {/*
                      A synthetic group is a column value, not a stored group.
                      Renaming, recolouring or deleting "Urgent" cannot mean
                      anything, so the controls that would write are not drawn
                      while the board is grouped by a column.
                    */}
                    {!synthetic && (
                    <button
                      className="sheet-group__rename"
                      type="button"
                      onClick={() => {
                        setRenamingId(group.id);
                        setRenameValue(group.name);
                      }}
                    >
                      Rename
                    </button>
                    )}
                    {!synthetic && (
                    <div className="sheet-group__menu-wrap" data-board-popover>
                      <button
                        ref={groupMoreRef(group.id)}
                        className="sheet-group__more"
                        type="button"
                        aria-expanded={groupMenuId === group.id}
                        aria-label={`Actions for ${group.name}`}
                        onClick={() => {
                          setGroupMenuId((current) =>
                            current === group.id ? null : group.id,
                          );
                          setRowMenuId(null);
                          setColumnMenuInstance(null);
                          setColumnPickerGroupId(null);
                        }}
                      >
                        <Icon name="more" size={17} />
                      </button>
                      <GroupActionMenu
                        open={groupMenuId === group.id}
                        anchorRef={groupMoreRef(group.id)}
                        onClose={() => setGroupMenuId(null)}
                        group={group}
                        rowCount={rows.length}
                        colors={groupColors}
                        isCollapsed={isCollapsed}
                        allCollapsed={collapsed.size === groups.length}
                        isFirst={groups[0]?.id === group.id}
                        isLast={groups.at(-1)?.id === group.id}
                        storeDocumentation={isStoreDocumentation}
                        canExport={canExport !== false}
                        canDelete={groups.length >= 2}
                        saving={saving}
                        busy={bulkBusy}
                        addItemLabel={addItemToGroupLabel}
                        onToggleCollapse={() =>
                          setCollapsed((current) => {
                            const next = new Set(current);
                            if (isCollapsed) next.delete(group.id);
                            else next.add(group.id);
                            return next;
                          })
                        }
                        onToggleCollapseAll={() =>
                          setCollapsed(
                            collapsed.size === groups.length
                              ? new Set()
                              : new Set(groups.map((item) => item.id)),
                          )
                        }
                        onSelectAll={() =>
                          setRowsSelected(rows.map((request) => request.id), true)
                        }
                        onRename={() => {
                          setRenamingId(group.id);
                          setRenameValue(group.name);
                        }}
                        onDuplicate={() => void duplicateGroup(group)}
                        onAddGroup={openGroupCreator}
                        onColor={(color) => void updateGroupColor(group, color)}
                        onSort={(order) => void sortGroup(group, order)}
                        onMoveGroup={(direction) => void moveGroup(group, direction)}
                        onExport={() => void exportRowsToCsv(rows)}
                        onAddItem={() => createItem(group.id)}
                        onApps={() =>
                          onNotify("Board apps are ready for the next integration.")
                        }
                        onArchiveItems={() =>
                          runBulkAction(
                            "archive_items",
                            rows.map((request) => request.id),
                          )
                        }
                        onDelete={() => void deleteGroup(group)}
                      />
                    </div>
                    )}
                  </header>

                  {!isCollapsed && (
                    <table className={`live-sheet${loadingBoard ? " is-syncing" : ""}`}>
                      <thead>
                        <tr>
                          <th className="sheet-check">
                            <input
                              type="checkbox"
                              aria-label={`Select ${group.name}`}
                              checked={
                                rows.length > 0 &&
                                rows.every((request) => selectedIds.has(request.id))
                              }
                              onChange={(event) =>
                                setRowsSelected(
                                  rows.map((request) => request.id),
                                  event.target.checked,
                                )
                              }
                            />
                          </th>
                          {visibleBoardColumns.map((entry, columnIndex) => {
                            const column = entry.column;
                            const instanceId = `${group.id}:${column.id}`;
                            const rank = sortRuleIndex(sortRules, column.id);
                            return (
                              <BoardColumnHeader
                                key={column.id}
                                kind={entry.kind}
                                systemKey={
                                  entry.kind === "system" ? entry.key : undefined
                                }
                                column={column}
                                menuOpen={columnMenuInstance === instanceId}
                                sortDirection={sortDirectionFor(sortRules, column.id)}
                                /* The rank is drawn only when there is more than
                                   one rule: a "1" beside the only sorted column
                                   says nothing and adds a badge to every board. */
                                sortRank={
                                  sortRules.length > 1 && rank >= 0 ? rank + 1 : null
                                }
                                filtered={Boolean(findFilterRule(filterState, column.id))}
                                pinned={column.pinned === true}
                                sticky={stickyOffsets.get(column.id)}
                                summaries={summariesFor(column.type)}
                                canMoveLeft={columnIndex > 0}
                                canMoveRight={columnIndex < visibleBoardColumns.length - 1}
                                dragging={columnDrag?.columnId === column.id}
                                dropSide={
                                  columnDrag?.marker?.columnId === column.id
                                    ? columnDrag.marker.side
                                    : null
                                }
                                onMenuToggle={() => {
                                  setColumnMenuInstance((current) =>
                                    current === instanceId ? null : instanceId,
                                  );
                                  setGroupMenuId(null);
                                  setRowMenuId(null);
                                  setColumnPickerGroupId(null);
                                }}
                                onMenuClose={() => setColumnMenuInstance(null)}
                                onConfigure={
                                  entry.kind === "custom"
                                    ? () => {
                                        setColumnSettingsTargetId(column.id);
                                        setColumnMenuInstance(null);
                                      }
                                    : undefined
                                }
                                onRename={() => renameCustomColumn(column)}
                                onToggleWrap={() => toggleColumnWrap(column)}
                                onSort={(direction) =>
                                  sortByColumn(column, direction)
                                }
                                onAddSort={(direction) =>
                                  addSortByColumn(column, direction)
                                }
                                onFilter={() => filterByColumn(entry)}
                                onTogglePin={() => void toggleColumnPinned(entry)}
                                onMove={(delta) => void moveColumnBy(entry, delta)}
                                onSummary={(summary) => void setColumnSummary(column, summary)}
                                onColumnPointerDown={(event) =>
                                  onColumnPointerDown(entry, event)
                                }
                                onColumnPointerMove={onColumnPointerMove}
                                onColumnPointerUp={onColumnPointerUp}
                                onColumnPointerCancel={onColumnPointerCancel}
                                onColumnClickCapture={onColumnClickCapture}
                                onAddRight={() =>
                                  openColumnPickerAfter(group.id, column)
                                }
                                onDuplicate={
                                  entry.kind === "custom"
                                    ? () => duplicateCustomColumn(column)
                                    : undefined
                                }
                                onClear={
                                  entry.kind === "custom"
                                    ? () => clearCustomColumn(column)
                                    : undefined
                                }
                                onChangeType={
                                  entry.kind === "custom"
                                    ? (type) => void changeColumnType(column, type)
                                    : undefined
                                }
                                onCollapse={() => toggleColumnCollapsed(column.id)}
                                onGroupBy={() => toggleGroupByColumn(column.id)}
                                collapsed={collapsedColumns.has(column.id)}
                                groupedByThis={groupByColumn === column.id}
                                onHide={() => {
                                  void setColumnVisible(entry, false);
                                  setColumnMenuInstance(null);
                                }}
                                onDelete={
                                  entry.kind === "custom"
                                    ? () => deleteCustomColumn(column)
                                    : undefined
                                }
                                onResizePreview={(width) =>
                                  previewColumnWidth(column, width)
                                }
                                onResizeCommit={(width) =>
                                  commitColumnWidth(column, width)
                                }
                              />
                            );
                          })}
                          <th className="sheet-add-column" data-board-popover>
                            <button
                              type="button"
                              aria-label="Add column"
                              title="Add column"
                              onClick={() => {
                                if (columnPickerGroupId === group.id) {
                                  setColumnPickerGroupId(null);
                                  setColumnInsertAfterId(null);
                                } else {
                                  openColumnPickerAfter(group.id, null);
                                }
                              }}
                            >
                              <Icon name="plus" size={17} />
                            </button>
                            {columnPickerGroupId === group.id && !isMobile && (
                              <ColumnPicker
                                query={columnSearch}
                                showMore={showMoreColumnTypes}
                                busy={columnBusy}
                                onQueryChange={setColumnSearch}
                                onShowMore={() => setShowMoreColumnTypes(true)}
                                onChoose={createCustomColumn}
                                onClose={() => {
                                  setColumnPickerGroupId(null);
                                  setColumnInsertAfterId(null);
                                  setColumnSearch("");
                                  setShowMoreColumnTypes(false);
                                }}
                              />
                            )}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((request, rowIndex) => (
                          <Fragment key={request.id}>
                          <BoardRow
                            boardId={boardId}
                            request={request}
                            groups={groups}
                            currentGroupId={group.id}
                            selected={selectedIds.has(request.id)}
                            menuOpen={rowMenuId === request.id}
                            columns={visibleBoardColumns}
                            stickyOffsets={stickyOffsets}
                            onOpen={() => {
                              setRowMenuId(null);
                              setGroupMenuId(null);
                              setColumnMenuInstance(null);
                              setColumnPickerGroupId(null);
                              onOpenRequest(request, "columns");
                            }}
                            onOpenUpdates={() => {
                              setRowMenuId(null);
                              setGroupMenuId(null);
                              setColumnMenuInstance(null);
                              setColumnPickerGroupId(null);
                              onOpenRequest(request, "updates");
                            }}
                            onSelected={(selected) =>
                              setRowsSelected([request.id], selected)
                            }
                            onMenuToggle={() => {
                              setRowMenuId((current) =>
                                current === request.id ? null : request.id,
                              );
                              setGroupMenuId(null);
                              setColumnMenuInstance(null);
                              setColumnPickerGroupId(null);
                            }}
                            onMenuClose={() => setRowMenuId(null)}
                            onPointerDragStart={(event) =>
                              onRowPointerDown(
                                { request, sourceGroupId: group.id },
                                event,
                              )
                            }
                            onPointerDragMove={onRowPointerMove}
                            onPointerDragEnd={onRowPointerUp}
                            onPointerDragCancel={onRowPointerCancel}
                            onDuplicate={() =>
                              runBulkAction("duplicate_items", [request.id])
                            }
                            onArchive={() =>
                              runBulkAction("archive_items", [request.id])
                            }
                            onDelete={() =>
                              runBulkAction("delete_items", [request.id])
                            }
                            onSave={(fields) => saveFields(request, fields)}
                            onMove={(groupId) => moveItem(request, groupId)}
                            optionSets={{
                              tier: optionsFor("tier"),
                              engineer: optionsFor("engineer"),
                              priority: optionsFor("priority"),
                              label: optionsFor("label"),
                              status: optionsFor("status"),
                              storeLocation: optionsFor("storeLocation"),
                            }}
                            assigneeOptions={assigneeOptions}
                            onCreateOption={createOption}
                            onUpdateOption={updateOption}
                            onDeleteOption={deleteOption}
                            customCells={customCells}
                            customFileCounts={customFileCounts}
                            customFilePreviews={customFilePreviews}
                            onSaveCustom={(column, value) =>
                              saveCustomCell(request, column, value)
                            }
                            onSaveDateMetadata={(column, value) =>
                              saveDateDecoration(request, column, value)
                            }
                            onUpdateCustomColumn={(column, settings) =>
                              updateCustomColumn(column, { settings }).then(
                                (updated) => {
                                  onNotify(`${updated.title} options updated.`);
                                },
                              )
                            }
                            onOpenCustomFiles={(column) =>
                              setEvidenceTarget({
                                request,
                                kind: "all",
                                column,
                              })
                            }
                            onOpenFiles={(kind) =>
                              setEvidenceTarget({ request, kind })
                            }
                            subitemCount={
                              (subitemsByParent.get(request.id) ?? []).length
                            }
                            subitemsExpanded={expandedSubitems.has(request.id)}
                            onToggleSubitems={() => toggleSubitems(request.id)}
                            onOpenNewTab={() => openItemInNewTab(request)}
                            onCopyLink={() => void copyItemLink(request)}
                            onCreateBelow={() =>
                              void createItemBelow(request, group.id)
                            }
                            onAddSubitem={() => {
                              setRowMenuId(null);
                              setExpandedSubitems((current) =>
                                new Set(current).add(request.id),
                              );
                            }}
                            onConvertToSubitem={() =>
                              void convertToSubitem(request, group.id)
                            }
                            canConvertToSubitem={rowIndex > 0 && (subitemsByParent.get(request.id)?.length ?? 0) === 0}
                          />
                          {expandedSubitems.has(request.id) && (
                            <tr className="sheet-subitem-row">
                              <td colSpan={visibleBoardColumns.length + 2}>
                                <SubitemRows
                                  subitems={(
                                    subitemsByParent.get(request.id) ?? []
                                  ).map((child) => ({
                                    id: child.id,
                                    title: child.description || child.title,
                                    assignee: child.assignee,
                                    status: child.status,
                                    dueAt: child.dueAt,
                                  }))}
                                  statusOptions={subitemStatusOptions}
                                  assigneeOptions={assigneeOptions}
                                  onSave={(id, fields) => {
                                    const child = requests.find(
                                      (entry) => entry.id === id,
                                    );
                                    if (child) saveFields(child, fields as EditableFields);
                                  }}
                                  onAdd={(title) => void addSubitem(request, title)}
                                  onOpen={(id) => {
                                    const child = requests.find(
                                      (entry) => entry.id === id,
                                    );
                                    if (child) onOpenRequest(child, "columns");
                                  }}
                                />
                              </td>
                            </tr>
                          )}
                          </Fragment>
                        ))}
                        <tr className="sheet-add-row sheet-summary-row">
                          <td className="sheet-check">
                            <span />
                          </td>
                          {visibleBoardColumns.map((entry) => {
                            const column = entry.column;
                            if (entry.kind === "system" && entry.key === "name") {
                              return (
                              <td
                                key={column.id}
                                className="sheet-column--name sheet-add-row__item"
                                style={{
                                  width: displayedBoardColumnWidth(
                                    column,
                                    isMobile,
                                  ),
                                  minWidth: displayedBoardColumnWidth(
                                    column,
                                    isMobile,
                                  ),
                                  maxWidth: displayedBoardColumnWidth(
                                    column,
                                    isMobile,
                                  ),
                                  ...stickyCellStyle(column.id),
                                }}
                              >
                                <button
                                  type="button"
                                  disabled={saving}
                                  onClick={() => createItem(group.id)}
                                >
                                  <Icon name="plus" size={14} />
                                  Add item
                                </button>
                              </td>
                              );
                            }
                            return (
                              <BoardColumnSummary
                                key={column.id}
                                entry={entry}
                                rows={rows}
                                optionSets={{
                                  tier: optionsFor("tier"),
                                  engineer: optionsFor("engineer"),
                                  priority: optionsFor("priority"),
                                  label: optionsFor("label"),
                                  status: optionsFor("status"),
                                  storeLocation: optionsFor("storeLocation"),
                                }}
                                assigneeOptions={assigneeOptions}
                                customCells={customCells}
                                customFileCounts={customFileCounts}
                                sticky={stickyOffsets.get(column.id)}
                              />
                            );
                          })}
                          <td className="sheet-add-column-spacer sheet-summary-spacer" />
                        </tr>
                      </tbody>
                    </table>
                  )}
                </section>
              );
            })}
          </div>
        </div>

        {/*
          Conditionally rendered rather than given `hidden` like the grid above:
          `.live-board-footer` carries `display: flex` from a class rule, which
          outranks the user agent's `[hidden] { display: none }`, so the
          attribute alone would leave the bar exactly where it was.
        */}
        {!gridReplaced && (
        <div className="live-board-footer">
          <button type="button" onClick={openGroupCreator}>
            <Icon name="plus" size={16} />
            Add new group
          </button>
          <span>
            Showing <strong>{visibleRows.length}</strong> of {scopedRequests.length}{" "}
            items
          </span>
        </div>
        )}
      </section>
      {selectedIds.size > 0 && (
        <div className="live-selection-bar" role="toolbar" aria-label="Selected item actions">
          <span className="live-selection-count">{selectedIds.size}</span>
          <strong>
            {selectedIds.size} item{selectedIds.size === 1 ? "" : "s"} selected
          </strong>
          <button
            type="button"
            disabled={bulkBusy}
            onClick={() => runBulkAction("duplicate_items")}
          >
            <Icon name="grid" size={18} />
            Duplicate
          </button>
          {canExport !== false && (
            <button type="button" onClick={() => void exportRowsToCsv(selectedRequests)}>
              <Icon name="download" size={18} />
              Export
            </button>
          )}
          <button
            type="button"
            disabled={bulkBusy}
            onClick={() => runBulkAction("archive_items")}
          >
            <Icon name="folder" size={18} />
            Archive
          </button>
          <button
            className="is-danger"
            type="button"
            disabled={bulkBusy}
            onClick={() => runBulkAction("delete_items")}
          >
            <Icon name="close" size={18} />
            Delete
          </button>
          <button
            type="button"
            onClick={() => void copySelectedIds()}
          >
            <Icon name="document" size={18} />
            Copy IDs
          </button>
          <div className="live-selection-move" data-board-popover>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => {
                setSelectionMoveOpen((current) => !current);
                setGroupMenuId(null);
                setRowMenuId(null);
                setColumnMenuInstance(null);
              }}
            >
              <Icon name="arrow" size={18} />
              Move to
            </button>
            {selectionMoveOpen && (
              <div>
                {groups.map((group) => (
                  <button
                    type="button"
                    key={group.id}
                    onClick={() =>
                      runBulkAction("move_items", Array.from(selectedIds), group.id)
                    }
                  >
                    <i style={{ background: group.color }} />
                    {group.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => void copySelectedSummary()}
          >
            <Icon name="spark" size={18} />
            Sidekick summary
          </button>
          <button
            type="button"
            onClick={onOpenApps}
          >
            <Icon name="grid" size={18} />
            Apps
          </button>
          <button
            className="live-selection-close"
            type="button"
            aria-label="Clear selection"
            onClick={() => setSelectedIds(new Set())}
          >
            <Icon name="close" size={18} />
          </button>
        </div>
      )}
      {columnSettingsTargetId &&
        (() => {
          const target = customColumns.find(
            (column) => column.id === columnSettingsTargetId,
          );
          return target ? (
            <ColumnSettingsDialog
              key={target.id}
              column={target}
              onClose={() => setColumnSettingsTargetId(null)}
              onSave={async (changes) => {
                const updated = await updateCustomColumn(target, changes);
                onNotify(`${updated.title} settings saved.`);
                setColumnSettingsTargetId(null);
              }}
            />
          ) : null;
        })()}
      {isMobile &&
        columnPickerGroupId &&
        createPortal(
          <div className="mobile-column-picker-layer" data-board-popover>
            <button
              className="mobile-column-picker-layer__backdrop"
              type="button"
              aria-label="Close column picker"
              onClick={() => {
                setColumnPickerGroupId(null);
                setColumnInsertAfterId(null);
                setColumnSearch("");
                setShowMoreColumnTypes(false);
              }}
            />
            <ColumnPicker
              query={columnSearch}
              showMore={showMoreColumnTypes}
              busy={columnBusy}
              onQueryChange={setColumnSearch}
              onShowMore={() => setShowMoreColumnTypes(true)}
              onChoose={createCustomColumn}
              onClose={() => {
                setColumnPickerGroupId(null);
                setColumnInsertAfterId(null);
                setColumnSearch("");
                setShowMoreColumnTypes(false);
              }}
            />
          </div>,
          document.body,
        )}
      {evidenceTarget && (
        <EvidenceManager
          request={
            requests.find((request) => request.id === evidenceTarget.request.id) ??
            evidenceTarget.request
          }
          initialKind={evidenceTarget.kind}
          columnId={evidenceTarget.column?.id}
          columnTitle={evidenceTarget.column?.title}
          onClose={() => setEvidenceTarget(null)}
          onRequestChange={(updated) => {
            onRequestChange(updated);
            setEvidenceTarget((current) =>
              current ? { ...current, request: updated } : current,
            );
          }}
          onFileCountChange={
            evidenceTarget.column
              ? (count) =>
                  setCustomFileCounts((current) => ({
                    ...current,
                    [customCellKey(
                      evidenceTarget.request.id,
                      evidenceTarget.column!.id,
                    )]: count,
                  }))
              : undefined
          }
          onNotify={onNotify}
        />
      )}
    </div>
    </MobileBoardContext.Provider>
  );
}

function CustomColumnCell({
  boardId,
  column,
  value,
  fileCount,
  filePreview,
  requestId,
  onChange,
  onUpdateSettings,
  onOpenFiles,
}: {
  boardId: string;
  column: MaintenanceBoardColumn;
  value: string;
  fileCount: number;
  /** First few files in this cell, for the tiles. */
  filePreview: MaintenanceBoardFilePreview[];
  requestId: string;
  onChange: (
    value: string | boolean | { start: string; end: string },
  ) => void;
  onUpdateSettings: (settings: BoardColumnSettings) => Promise<void>;
  onOpenFiles: () => void;
}) {
  if (
    column.type === "status" ||
    column.type === "dropdown" ||
    column.type === "people"
  ) {
    return (
      <CustomChoiceCell
        column={column}
        value={value}
        onChange={onChange}
        onUpdateSettings={onUpdateSettings}
      />
    );
  }
  if (column.type === "date") {
    /*
     * On the Store Documentation board every date column is a certificate
     * expiry, so it renders with its RAG state rather than as a bare date. A
     * date sitting in a cell tells you nothing; "expired 147 days ago" is the
     * whole reason the column exists. Maintenance keeps the plain date cell.
     */
    if (boardId === "store-documentation") {
      return (
        <ExpiryCell
          title={column.title}
          value={value}
          metadataValue={value}
          onSave={(_next, metadata) => onChange(metadata)}
        />
      );
    }
    return (
      <DateCell
        title={column.title}
        value={value}
        metadataValue={value}
        onSave={(_next, metadata) => onChange(metadata)}
      />
    );
  }
  if (column.type === "timeline") {
    let timeline: { start?: string; end?: string } = {};
    try {
      timeline = value ? (JSON.parse(value) as typeof timeline) : {};
    } catch {
      timeline = {};
    }
    return (
      <TimelineCell
        title={column.title}
        start={timeline.start}
        end={timeline.end}
        onSave={(start, end) =>
          onChange({ start: start ?? "", end: end ?? "" })
        }
      />
    );
  }
  if (column.type === "checkbox") {
    return (
      <label className="sheet-custom-checkbox">
        <input
          type="checkbox"
          checked={value === "true"}
          aria-label={column.title}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span><Icon name="check" size={13} /></span>
      </label>
    );
  }
  if (column.type === "files") {
    /*
     * The twelve document columns are what the Store Documentation board is
     * for, so they get real per-file chips. Maintenance keeps the hover preview
     * it has always had — changing it was not asked for and board parity tests
     * pin its behaviour.
     */
    if (boardId === "store-documentation") {
      return (
        <FileCell
          title={column.title}
          requestId={requestId}
          columnId={column.id}
          // The real documents, not `[]`. See `boardFileCellFiles`: with no
          // files the cell drew one anonymous digit per certificate. All
          // twelve columns now draw chips — the `column.key === "rams"`
          // special case is gone, because `summary` in the board spec is the
          // group-footer aggregation ("battery", "min", "sum"), never a cell
          // renderer, and monday types all twelve columns identically.
          files={boardFileCellFiles(filePreview)}
          count={fileCount}
          onSave={() => {
            // Counts live in the board snapshot, so a new or removed document
            // has to come back through the board rather than be patched here.
            window.dispatchEvent(new Event("maintsupp:refresh-board"));
          }}
          onOpen={onOpenFiles}
        />
      );
    }
    /* Every maintenance file column takes THIS path, not the `case
       "issuePictures"` blocks below — which is why the photo columns drew a
       paperclip and a number instead of the photographs. */
    return (
      <FileHoverPreview
        requestId={requestId}
        columnId={column.id}
        mondayMediaStyle
        count={fileCount}
        preview={filePreview}
        onOpen={onOpenFiles}
      />
    );
  }
  return (
    <InlineTextCell
      title={column.title}
      value={value}
      emptyLabel="Add value"
      multiline={column.type === "long_text"}
      inputMode={
        column.type === "number"
          ? "decimal"
          : column.type === "email"
            ? "email"
            : column.type === "phone"
              ? "tel"
              : column.type === "link"
                ? "url"
                : "text"
      }
      onSave={onChange}
    />
  );
}


function CustomChoiceCell({
  column,
  value,
  onChange,
  onUpdateSettings,
}: {
  column: MaintenanceBoardColumn;
  value: string;
  onChange: (value: string) => void;
  onUpdateSettings: (settings: BoardColumnSettings) => Promise<void>;
}) {
  const mobile = useContext(MobileBoardContext);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newColor, setNewColor] = useState("#579bfc");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const choices = choiceList(column);
  const selected = findChoice(choices, value);
  const settingsKey = column.type === "people" ? "people" : "choices";

  useRevealBoardPopover(open && !mobile, ref, editing);

  useEffect(() => {
    if (!open || mobile) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        setOpen(false);
        setEditing(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [mobile, open]);

  const closeEditor = () => {
    setOpen(false);
    setEditing(false);
    setSearch("");
  };

  const visibleChoices = choices.filter((choice) =>
    choice.label.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const saveChoices = async (nextChoices: BoardColumnChoice[]) => {
    setWorking(true);
    setError(null);
    try {
      await onUpdateSettings({
        ...column.settings,
        [settingsKey]: nextChoices,
      });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The options could not be saved.",
      );
    } finally {
      setWorking(false);
    }
  };

  const addChoice = async () => {
    const label = newLabel.trim();
    if (!label || working) return;
    const idBase = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const id = `${idBase || "choice"}-${crypto.randomUUID()}`;
    await saveChoices([...choices, { id, label, color: newColor }]);
    setNewLabel("");
  };

  return (
    <div className="sheet-option-cell sheet-custom-choice" ref={ref}>
      <button
        type="button"
        /*
         * Two different problems, so two different answers.
         *
         * EMPTY: no option is selected, so there is no data colour and the
         * chip is pure design — it belongs to the theme and goes through the
         * neutral-chip tokens. The literal pair it replaces (#8a979f on
         * #eef1f3, 2.64:1) was the same in light and dark and failed in both,
         * on 2,229 cells.
         *
         * FILLED: the ground is monday's colour for that label and must not
         * move. Only the label colour is ours to choose, and `chipInk` keeps
         * the stored one whenever it is legible on that exact ground.
         */
        style={
          selected
            ? chipStyle(selected.color, selected.textColor)
            : {
                background: "var(--chip-neutral-bg)",
                color: "var(--chip-neutral-fg)",
              }
        }
        onClick={() => {
          setOpen((current) => !current);
          setEditing(false);
          setSearch("");
        }}
      >
        {selected?.label ?? "—"}
      </button>
      {open && !mobile && !editing && (
        <div className="sheet-option-popover">
          <div className="sheet-option-grid">
            <button
              type="button"
              className="sheet-option-clear"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              Clear value
            </button>
            {choices.map((choice) => (
              <button
                key={choice.id}
                type="button"
                style={chipStyle(choice.color, choice.textColor)}
                onClick={() => {
                  onChange(choice.id);
                  setOpen(false);
                }}
              >
                {choice.label}
              </button>
            ))}
          </div>
          <button
            className="sheet-option-edit"
            type="button"
            onClick={() => setEditing(true)}
          >
            <Icon name="settings" size={15} />
            {column.type === "people" ? "Edit people" : "Edit labels"}
          </button>
        </div>
      )}
      {open && !mobile && editing && (
        <div className="sheet-option-popover sheet-label-editor">
          <header>
            <button type="button" onClick={() => setEditing(false)}>‹</button>
            <strong>
              {column.type === "people" ? "Edit people" : "Edit labels"}
            </strong>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setEditing(false);
              }}
            >
              <Icon name="close" size={15} />
            </button>
          </header>
          <div className="sheet-label-editor__list">
            {choices.map((choice) => (
              <div key={`${choice.id}-${choice.label}-${choice.color}`}>
                <input
                  type="color"
                  aria-label={`Color for ${choice.label}`}
                  value={choice.color}
                  disabled={working}
                  onChange={(event) =>
                    saveChoices(
                      choices.map((item) =>
                        item.id === choice.id
                          ? { ...item, color: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
                <input
                  defaultValue={choice.label}
                  aria-label={`Name for ${choice.label}`}
                  disabled={working}
                  onBlur={(event) => {
                    const label = event.currentTarget.value.trim();
                    if (!label || label === choice.label) return;
                    saveChoices(
                      choices.map((item) =>
                        item.id === choice.id ? { ...item, label } : item,
                      ),
                    );
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
                <button
                  type="button"
                  className="is-danger"
                  disabled={working}
                  title="Delete option"
                  onClick={() =>
                    saveChoices(
                      choices.filter((item) => item.id !== choice.id),
                    )
                  }
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="sheet-label-editor__new">
            <input
              type="color"
              aria-label="New option color"
              value={newColor}
              onChange={(event) => setNewColor(event.target.value)}
            />
            <input
              value={newLabel}
              placeholder="+ New option"
              onChange={(event) => setNewLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addChoice();
              }}
            />
            <button
              type="button"
              disabled={!newLabel.trim() || working}
              onClick={addChoice}
            >
              Add
            </button>
          </div>
          {error && (
            <small className="sheet-label-editor__error">{error}</small>
          )}
        </div>
      )}
      {open && mobile && (
        <MobileCellSheet
          title={editing ? `Edit ${column.title}` : column.title}
          subtitle={
            editing
              ? "Changes are saved to this board"
              : selected
                ? `Current: ${selected.label}`
                : "No value selected"
          }
          onClose={closeEditor}
          className="mobile-choice-sheet"
          footer={
            editing ? (
              <>
                <button type="button" onClick={() => setEditing(false)}>
                  Back
                </button>
                <button className="primary-button" type="button" onClick={closeEditor}>
                  Done
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    onChange("");
                    closeEditor();
                  }}
                >
                  Clear
                </button>
                <button className="primary-button" type="button" onClick={() => setEditing(true)}>
                  {column.type === "people" ? "Manage people" : "Manage labels"}
                </button>
              </>
            )
          }
        >
          {!editing ? (
            <>
              <label className="mobile-sheet-search">
                <Icon name="search" size={17} />
                <input
                  type="search"
                  value={search}
                  placeholder={column.type === "people" ? "Search people" : "Search options"}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <div
                className={`mobile-choice-list${
                  column.type === "people" ? " mobile-choice-list--people" : ""
                }`}
              >
                {visibleChoices.map((choice) => (
                  <button
                    key={choice.id}
                    type="button"
                    className={choice.id === value ? "is-selected" : ""}
                    onClick={() => {
                      onChange(choice.id);
                      closeEditor();
                    }}
                  >
                    <span style={{ background: choice.color }}>
                      {column.type === "people"
                        ? choice.label
                            .split(/\s+/)
                            .slice(0, 2)
                            .map((part) => part[0])
                            .join("")
                            .toUpperCase()
                        : ""}
                    </span>
                    <strong>{choice.label}</strong>
                    {choice.id === value && <Icon name="check" size={18} />}
                  </button>
                ))}
                {!visibleChoices.length && (
                  <p className="mobile-choice-empty">No matching options.</p>
                )}
              </div>
            </>
          ) : (
            <div className="mobile-option-manager">
              <div className="mobile-option-manager__list">
                {choices.map((choice) => (
                  <div key={`${choice.id}-${choice.label}-${choice.color}`}>
                    <input
                      type="color"
                      aria-label={`Color for ${choice.label}`}
                      value={choice.color}
                      disabled={working}
                      onChange={(event) =>
                        void saveChoices(
                          choices.map((item) =>
                            item.id === choice.id
                              ? { ...item, color: event.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                    <input
                      defaultValue={choice.label}
                      aria-label={`Name for ${choice.label}`}
                      disabled={working}
                      onBlur={(event) => {
                        const label = event.currentTarget.value.trim();
                        if (!label || label === choice.label) return;
                        void saveChoices(
                          choices.map((item) =>
                            item.id === choice.id ? { ...item, label } : item,
                          ),
                        );
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                    />
                    <button
                      type="button"
                      aria-label={`Delete ${choice.label}`}
                      disabled={working || choices.length <= 1}
                      onClick={() =>
                        void saveChoices(
                          choices.filter((item) => item.id !== choice.id),
                        )
                      }
                    >
                      <Icon name="close" size={16} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="mobile-option-manager__new">
                <input
                  type="color"
                  aria-label="New option color"
                  value={newColor}
                  onChange={(event) => setNewColor(event.target.value)}
                />
                <input
                  value={newLabel}
                  placeholder={column.type === "people" ? "New person" : "New label"}
                  onChange={(event) => setNewLabel(event.target.value)}
                />
                <button type="button" disabled={!newLabel.trim() || working} onClick={() => void addChoice()}>
                  Add
                </button>
              </div>
              {error && <p className="mobile-sheet-error">{error}</p>}
            </div>
          )}
        </MobileCellSheet>
      )}
    </div>
  );
}

function BoardRow({
  boardId,
  request,
  groups,
  currentGroupId,
  selected,
  menuOpen,
  columns,
  stickyOffsets,
  onOpen,
  onOpenUpdates,
  onSelected,
  onMenuToggle,
  onMenuClose,
  onPointerDragStart,
  onPointerDragMove,
  onPointerDragEnd,
  onPointerDragCancel,
  onDuplicate,
  onArchive,
  onDelete,
  onSave,
  onMove,
  optionSets,
  assigneeOptions,
  onCreateOption,
  onUpdateOption,
  onDeleteOption,
  customCells,
  customFileCounts,
  customFilePreviews,
  onSaveCustom,
  onSaveDateMetadata,
  onUpdateCustomColumn,
  onOpenCustomFiles,
  onOpenFiles,
  subitemCount,
  subitemsExpanded,
  onToggleSubitems,
  onOpenNewTab,
  onCopyLink,
  onCreateBelow,
  onAddSubitem,
  onConvertToSubitem,
  canConvertToSubitem,
}: {
  boardId: string;
  request: MaintenanceRequest;
  groups: MaintenanceGroup[];
  currentGroupId: string;
  selected: boolean;
  menuOpen: boolean;
  columns: BoardDisplayColumn[];
  /**
   * Where each frozen column sits, keyed by column id.
   *
   * Computed once for the board rather than per row: it depends only on the
   * columns and their widths, and 745 rows recomputing the same running total
   * would be 745 identical passes over 26 columns on every render.
   */
  stickyOffsets: Map<string, StickyColumn>;
  onOpen: () => void;
  onOpenUpdates: () => void;
  onSelected: (selected: boolean) => void;
  onMenuToggle: () => void;
  /** Closes the row menu outright — the popover's dismissal, not a toggle. */
  onMenuClose: () => void;
  onPointerDragStart: (
    event: ReactPointerEvent<HTMLTableRowElement>,
  ) => void;
  onPointerDragMove: (
    event: ReactPointerEvent<HTMLTableRowElement>,
  ) => boolean;
  onPointerDragEnd: (
    event: ReactPointerEvent<HTMLTableRowElement>,
  ) => boolean;
  onPointerDragCancel: (
    event: ReactPointerEvent<HTMLTableRowElement>,
  ) => void;
  onDuplicate: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onSave: (fields: EditableFields) => void;
  onMove: (groupId: string) => void;
  optionSets: Record<BoardOptionColumn, Option[]>;
  assigneeOptions: Option[];
  onCreateOption: (
    columnKey: BoardOptionColumn,
    label: string,
    color: string,
  ) => Promise<void>;
  onUpdateOption: (
    optionId: string,
    changes: { label?: string; color?: string; active?: boolean },
  ) => Promise<void>;
  onDeleteOption: (optionId: string) => Promise<void>;
  customCells: Record<string, string>;
  customFileCounts: Record<string, number>;
  customFilePreviews: Record<string, MaintenanceBoardFilePreview[]>;
  onSaveCustom: (
    column: MaintenanceBoardColumn,
    value: string | boolean | { start: string; end: string },
  ) => void;
  onSaveDateMetadata: (
    column: MaintenanceBoardColumn,
    value: string,
  ) => void;
  onUpdateCustomColumn: (
    column: MaintenanceBoardColumn,
    settings: BoardColumnSettings,
  ) => Promise<void>;
  onOpenCustomFiles: (column: MaintenanceBoardColumn) => void;
  onOpenFiles: (kind: AttachmentKind | "all") => void;
  /** How many children this item has — the Subitems column's value. */
  subitemCount: number;
  subitemsExpanded: boolean;
  onToggleSubitems: () => void;
  onOpenNewTab: () => void;
  onCopyLink: () => void;
  onCreateBelow: () => void;
  onAddSubitem: () => void;
  onConvertToSubitem: () => void;
  /**
   * False for the first row of a group and for an item that already has
   * children — there is nothing above to become the parent, and monday does not
   * allow a parent to become a child. Disabled rather than hidden, which is how
   * monday shows it.
   */
  canConvertToSubitem: boolean;
}) {
  const mobile = useContext(MobileBoardContext);
  const suppressRowClickRef = useRef(false);
  // The "…" the portalled row menu is anchored to.
  const moreRef = useRef<HTMLButtonElement | null>(null);
  // Move column: 38 groups x 744 rows = 28,272 <option>s. Build them on focus.
  const [moveListOpen, setMoveListOpen] = useState(false);
  const columnStyle = (column: MaintenanceBoardColumn): CSSProperties => {
    const width = displayedBoardColumnWidth(column, mobile);
    const style: CSSProperties = {
      width,
      minWidth: width,
      maxWidth: width,
    };
    /*
     * A frozen column's left offset is the running width of everything frozen
     * ahead of it, which is data rather than a stylesheet constant — see
     * board-pinning.ts. The stylesheet still owns the Items column's own sticky
     * rules; this only supplies the number, and only where one applies.
     */
    const sticky = stickyOffsets.get(column.id);
    if (sticky) {
      style.left = sticky.left;
      style.zIndex = stickyZIndex(sticky.order, false);
    }
    return style;
  };

  /** Marks a cell whose column is pinned, so the stylesheet can make it opaque. */
  const pinnedClass = (column: MaintenanceBoardColumn) =>
    column.pinned === true ? " is-pinned-column" : "";
  const systemCell = (
    key: ColumnKey,
    column: MaintenanceBoardColumn,
  ) => {
    const className =
      "sheet-column--" +
      key +
      (column.settings.wrap ? " is-column-wrapped" : "") +
      (shouldCenterBoardCell(column, key) ? " is-content-centered" : "") +
      pinnedClass(column);
    const shared = {
      className,
      style: columnStyle(column),
    };
    switch (key) {
      case "name": {
        const itemName = boardItemName(
          request,
          boardId,
          customCells[customCellKey(request.id, column.id)],
        );
        return (
          <td {...shared}>
            {/*
              THE ONLY WAY TO DRAG A ROW WITH A FINGER — AND IT IS IN THIS CELL
              BECAUSE THIS IS THE ONE THAT DOES NOT SCROLL AWAY.

              Everywhere else on a row a touch is a scroll, decided before
              anything of ours runs — see `THE TOUCH STORY` in
              `board-row-drag.ts`. This is the one spot that declares
              `touch-action: none`, which is the one thing a compositor will not
              argue with, so it is the one spot a touch drag can begin.

              It sat in the 42px checkbox gutter next door until a phone was
              given a single frozen column and the Name cell took the slot.
              After that the grip rode away with the row: measured at x 1, −41,
              −599 and −1999 as `scrollLeft` went 0, 42, 600, 2000 — so past
              42px of sideways scroll there was NO WAY to start a touch drag at
              all, on a board 3,800px wider than the screen. A handle has to
              live in whatever is frozen. Nothing about the button changed: it
              is still `position: absolute; left: 0`, and the `<td>` it now sits
              in is `position: sticky`, so that resolves against the frozen cell
              instead of the gutter.

              `touch-action` stays inline rather than moving to the stylesheet
              because it is the load-bearing part, and it must not be able to go
              missing in a refactor of the sheet's CSS.
            */}
            {mobile && (
            <button
              type="button"
              className="sheet-row-grip"
              data-board-row-handle
              aria-label={"Drag " + request.id + " to reorder"}
              title="Drag to move this row"
              style={{
                position: "absolute",
                top: "50%",
                left: 0,
                display: "grid",
                placeItems: "center",
                width: 18,
                height: 40,
                padding: 0,
                border: 0,
                borderRadius: 5,
                background: "transparent",
                color: "var(--muted, #60727d)",
                transform: "translateY(-50%)",
                touchAction: "none",
                cursor: "grab",
              }}
            >
              <Icon name="menu" size={14} />
            </button>
            )}
            <div className="sheet-item-cell">
              <ItemNameEditor
                value={itemName}
                onSave={(value) => onSaveCustom(column, value)}
              />
              <button
                className="sheet-open-item"
                type="button"
                onClick={onOpen}
                title="Open item page"
                aria-label={"Open " + request.id + " item page"}
              >
                <Icon name="arrow" size={14} />
              </button>
              <button
                className="sheet-comment"
                type="button"
                onClick={onOpenUpdates}
                title="Open updates"
                aria-label={"Open updates for " + request.id}
              >
                <span
                  className={`sheet-update-icon${
                    request.commentCount ? " has-updates" : " is-empty"
                  }`}
                  aria-hidden="true"
                >
                  <svg
                    className="sheet-update-icon__glyph"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.8"
                  >
                    <path d="M19.4 11.2a7.7 7.7 0 0 1-9.8 7.4l-4 1.9 1.2-3.7a7.7 7.7 0 1 1 12.6-5.6Z" />
                    {!request.commentCount && (
                      <path d="M9 11.2h5.2m-2.6-2.6v5.2" />
                    )}
                  </svg>
                  {request.commentCount ? (
                    <small>{request.commentCount}</small>
                  ) : null}
                </span>
              </button>
            </div>
          </td>
        );
      }
      case "location":
        return (
          <td {...shared}>
              <InlineTextCell
              title={column.title}
              value={request.location}
              onSave={(location) => onSave({ location })}
            />
          </td>
        );
      case "description":
        return (
          <td {...shared}>
            <InlineTextCell
              title={column.title}
              multiline
              value={request.description}
              onSave={(description) => onSave({ description })}
            />
          </td>
        );
      case "tier":
        return (
          <td {...shared}>
            <OptionCell
              title={column.title}
              /* "3" resolved to the "Tier 3" option so the chip lights up with
                 the workspace's own label and colour — see `tierCellValue`. */
              value={tierCellValue(String(request.tier), optionSets.tier)}
              options={optionSets.tier}
              editableColumn="tier"
              onCreateOption={onCreateOption}
              onUpdateOption={onUpdateOption}
              onDeleteOption={onDeleteOption}
              onChange={(value) => {
                /* The field is numeric: "Tier 3" saves 3, a bare "2" saves 2.
                   An option with no number in it cannot be stored in a numeric
                   field, so it is refused rather than saved as null. */
                const tier = Number(tierDigits(value) || value);
                if (Number.isFinite(tier) && value.trim()) onSave({ tier });
              }}
            />
          </td>
        );
      case "engineer":
        return (
          <td {...shared}>
            <OptionCell
              title={column.title}
              value={request.engineer}
              options={optionSets.engineer}
              editableColumn="engineer"
              onCreateOption={onCreateOption}
              onUpdateOption={onUpdateOption}
              onDeleteOption={onDeleteOption}
              onChange={(engineer) =>
                onSave({
                  engineer: engineer as MaintenanceRequest["engineer"],
                })
              }
            />
          </td>
        );
      case "priority":
        return (
          <td {...shared}>
            <OptionCell
              title={column.title}
              value={request.priority}
              options={optionSets.priority}
              editableColumn="priority"
              onCreateOption={onCreateOption}
              onUpdateOption={onUpdateOption}
              onDeleteOption={onDeleteOption}
              onChange={(priority) =>
                onSave({ priority: priority as Priority })
              }
            />
          </td>
        );
      case "label":
        return (
          <td {...shared}>
            <OptionCell
              title={column.title}
              value={request.category}
              options={optionSets.label}
              editableColumn="label"
              onCreateOption={onCreateOption}
              onUpdateOption={onUpdateOption}
              onDeleteOption={onDeleteOption}
              columns={3}
              onChange={(category) => onSave({ category })}
            />
          </td>
        );
      case "status":
        return (
          <td {...shared}>
            <OptionCell
              title={column.title}
              value={request.status}
              options={optionSets.status}
              editableColumn="status"
              onCreateOption={onCreateOption}
              onUpdateOption={onUpdateOption}
              onDeleteOption={onDeleteOption}
              columns={4}
              onChange={(status) =>
                onSave({ status: status as RequestStatus })
              }
            />
          </td>
        );
      case "contractor":
        return (
          <td {...shared}>
            <InlineTextCell
              title={column.title}
              value={request.contractor ?? ""}
              emptyLabel="—"
              onSave={(contractor) =>
                onSave({ contractor: contractor || null })
              }
            />
          </td>
        );
      case "assignee":
        return (
          <td {...shared}>
            <OptionCell
              title={column.title}
              mobileKind="people"
              value={request.assignee ?? ""}
              options={assigneeOptions}
              onChange={(assignee) =>
                onSave({ assignee: assignee || null })
              }
            />
          </td>
        );
      case "requested":
        return (
          <td {...shared}>
            <DateCell
              title={column.title}
              clearable={false}
              value={request.requestedAt}
              metadataValue={
                customCells[customCellKey(request.id, column.id)] ?? ""
              }
              onSave={(requestedAt, metadata) => {
                if (requestedAt) {
                  onSave({ requestedAt });
                  onSaveDateMetadata(column, metadata);
                }
              }}
            />
          </td>
        );
      case "completed":
        return (
          <td {...shared}>
            <DateCell
              title={column.title}
              value={request.completedAt}
              metadataValue={
                customCells[customCellKey(request.id, column.id)] ?? ""
              }
              onSave={(completedAt, metadata) => {
                onSave({ completedAt });
                onSaveDateMetadata(column, metadata);
              }}
            />
          </td>
        );
      /*
       * THE JOB'S DEADLINE, AND THE SAME FIELD THE CALENDAR READS.
       *
       * `maintenance_requests.due_at` has driven the overdue meter, the Planned
       * calendar and the SLA window since long before the board showed it; the
       * only way to set it was the Timeline column's end handle or the request
       * drawer. This writes THE SAME FIELD — there is no cell behind it — so a
       * date set here is the date the calendar draws and the date the overdue
       * count measures against, with nothing to keep in step.
       *
       * The same `DateCell` the other three date columns use, so the picker,
       * the icon menu and the keyboard behaviour are one implementation.
       * `metadataValue` is the icon and time that sit alongside the date, which
       * IS a cell — decoration on the value, never the value.
       */
      case "dueDate":
        return (
          <td {...shared}>
            <DateCell
              title={column.title}
              value={request.dueAt}
              metadataValue={
                customCells[customCellKey(request.id, column.id)] ?? ""
              }
              onSave={(dueAt, metadata) => {
                onSave({ dueAt });
                onSaveDateMetadata(column, metadata);
              }}
            />
          </td>
        );
      case "timeline":
        return (
          <td {...shared}>
            <TimelineCell
              title={column.title}
              preserveStartOnClear
              start={request.requestedAt}
              end={request.dueAt}
              onSave={(requestedAt, dueAt) =>
                onSave({
                  requestedAt: requestedAt || request.requestedAt,
                  dueAt,
                })
              }
            />
          </td>
        );
      case "requester":
        return (
          <td {...shared}>
            <InlineTextCell
              title={column.title}
              value={request.requester}
              onSave={(requester) => onSave({ requester })}
            />
          </td>
        );
      case "nextUpdate":
        return (
          <td {...shared}>
            <DateCell
              title={column.title}
              value={request.nextUpdateAt}
              metadataValue={
                customCells[customCellKey(request.id, column.id)] ?? ""
              }
              onSave={(nextUpdateAt, metadata) => {
                onSave({ nextUpdateAt });
                onSaveDateMetadata(column, metadata);
              }}
            />
          </td>
        );
      /* Both photo columns are the same cell opened onto a different kind.
         Counted from the rows filed in the column, never from the
         denormalised counters — those had drifted badly: issue read 2,281
         with no issue-kind row behind it, completed read 0 against 1,616
         photographs. */
      case "issuePictures":
      case "completedPictures":
        return (
          <td {...shared}>
            <BoardFileCell
              requestId={request.id}
              columnId={column.id}
              columnTitle={column.title}
              counts={customFileCounts}
              previews={customFilePreviews}
              mondayMediaStyle
              onOpen={() =>
                onOpenFiles(key === "issuePictures" ? "issue" : "completion")
              }
            />
          </td>
        );
      case "cost":
        return (
          <td {...shared}>
            <InlineTextCell
              title={column.title}
              value={request.cost === null ? "" : String(request.cost)}
              emptyLabel="—"
              inputMode="decimal"
              onSave={(value) => {
                /* Blank clears; a number saves; anything else is refused.
                   Unguarded, "abc" became Number("abc") = NaN, which JSON
                   serialises as null — so a typo DELETED the recorded cost
                   instead of being rejected like the tier cell rejects one. */
                const cost = value.trim() ? Number(value) : null;
                if (cost === null || Number.isFinite(cost)) onSave({ cost });
              }}
            />
          </td>
        );
      case "approvedBy":
        return (
          <td {...shared}>
            <OptionCell
              title={column.title}
              mobileKind="people"
              value={request.approvedBy ?? ""}
              options={assigneeOptions}
              onChange={(approvedBy) =>
                onSave({ approvedBy: approvedBy || null })
              }
            />
          </td>
        );
      case "invoice":
        return (
          <td {...shared}>
            <InlineTextCell
              title={column.title}
              value={request.invoice ?? ""}
              emptyLabel="—"
              onSave={(invoice) => onSave({ invoice: invoice || null })}
            />
          </td>
        );
      case "files":
        return (
          <td {...shared}>
            {/* Counts what is filed in this column, not every attachment. */}
            <BoardFileCell
              requestId={request.id}
              columnId={column.id}
              columnTitle={column.title}
              counts={customFileCounts}
              previews={customFilePreviews}
              onOpen={() => onOpenFiles("all")}
            />
          </td>
        );
      case "number":
        return (
          <td {...shared}>
            <InlineTextCell
              title={column.title}
              value={request.contact}
              onSave={(contact) => onSave({ contact })}
            />
          </td>
        );
      case "storeLocation":
        return (
          <td {...shared}>
            <OptionCell
              title={column.title}
              value={request.location}
              options={request.location ? [{ value: request.location, color: groupColors[0] }] : []}
              columns={3}
              onChange={(location) => onSave({ location })}
            />
          </td>
        );
      case "subitems":
        return (
          <td {...shared}>
            <SubitemsCell
              count={subitemCount}
              expanded={subitemsExpanded}
              onToggle={onToggleSubitems}
            />
          </td>
        );
      case "formView":
        return (
          <td {...shared}>
            {request.formUrl ? (
              <a
                className="sheet-form-link"
                href={request.formUrl}
                target="_blank"
                rel="noreferrer"
                title="Open original form"
              >
                <Icon name="document" size={16} />
              </a>
            ) : (
              <button
                className="sheet-form-link"
                type="button"
                onClick={onOpen}
                title="Open item"
              >
                <Icon name="document" size={16} />
              </button>
            )}
          </td>
        );
      case "move":
        return (
          <td {...shared}>
            <select
              value={currentGroupId}
              aria-label={"Move " + request.id}
              onFocus={() => setMoveListOpen(true)}
              onChange={(event) => onMove(event.target.value)}
            >
              {(moveListOpen ? groups : groups.filter((g) => g.id === currentGroupId)).map((group) => (
                <option value={group.id} key={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </td>
        );
    }
  };

  return (
    <tr
      /*
       * `is-dragging` and `is-drop-before` are missing on purpose: the drag
       * writes both directly. Leaving them out of this string is also what
       * keeps them there — React only rewrites `className` when its own value
       * changes, and this one now never changes during a drag, so nothing the
       * gesture painted can be wiped by a render.
       */
      className={selected ? "is-selected" : ""}
      data-board-row-id={request.id}
      data-board-row-group-id={currentGroupId}
      title="Drag to move this row; on a touch screen, press and hold first"
      onClickCapture={(event) => {
        if (!suppressRowClickRef.current) return;
        suppressRowClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onContextMenu={(event) => {
        if (event.currentTarget.classList.contains("is-dragging")) {
          event.preventDefault();
        }
      }}
      onPointerDownCapture={onPointerDragStart}
      onPointerMoveCapture={(event) => {
        if (onPointerDragMove(event)) {
          suppressRowClickRef.current = true;
        }
      }}
      onPointerUpCapture={(event) => {
        if (onPointerDragEnd(event)) {
          suppressRowClickRef.current = true;
          window.setTimeout(() => {
            suppressRowClickRef.current = false;
          }, 0);
        }
      }}
      onPointerCancelCapture={(event) => {
        suppressRowClickRef.current = false;
        onPointerDragCancel(event);
      }}
    >
      <td className="sheet-check" data-board-popover>
        {/*
          THE FINGER'S DRAG HANDLE USED TO LIVE HERE, AND IT CANNOT ANY MORE.
          This gutter is no longer frozen — a phone gets ONE frozen column and
          the Name cell has it — so a handle drawn here rides away with the rest
          of the row the moment the board is scrolled sideways. It is now the
          first child of the Name cell; the note beside it says why.
        */}
        {/* No gutter trigger on a phone: the item's actions are behind the
            "⋮" at the top right of the item drawer instead. */}
        {!mobile && (
        <button
          ref={moreRef}
          className="sheet-row-more"
          type="button"
          /*
           * ALSO THE GRAB HANDLE, on a pointer that has one. It already carries
           * `touch-action: none`, so a drag started here can never be taken
           * away by the compositor. A press still has to travel before it lifts
           * anything, which is what keeps this a button you can click.
           */
          data-board-row-handle
          aria-label={"Actions for " + request.id}
          aria-expanded={menuOpen}
          title="Click for item actions"
          onClick={onMenuToggle}
        >
          <Icon name="more" size={15} />
        </button>
        )}
        <input
          type="checkbox"
          aria-label={"Select " + request.id}
          checked={selected}
          /* Out of the grip's way; the phone gutter is 42px and holds both. */
          style={mobile ? { marginLeft: 10 } : undefined}
          onChange={(event) => onSelected(event.target.checked)}
        />
        <AnchoredPopover
          open={menuOpen}
          anchorRef={moreRef}
          onClose={onMenuClose}
          label={"Actions for " + request.id}
        >
          <div className="sheet-row-menu" data-board-drag-ignore>
            <button type="button" onClick={onOpen}>
              <Icon name="document" size={15} />
              Open item
            </button>
            <button type="button" onClick={onOpenNewTab}>
              <Icon name="upload" size={15} />
              Open in new tab
            </button>
            <button type="button" onClick={onCopyLink}>
              <Icon name="paperclip" size={15} />
              Copy item link
            </button>
            <button type="button" onClick={onDuplicate}>
              <Icon name="grid" size={15} />
              Duplicate item
            </button>
            <button type="button" onClick={onCreateBelow}>
              <Icon name="plus" size={15} />
              Create new item below
            </button>
            {/* Subitems are a Jobs-board concept; a store has none. */}
            {boardId !== "store-documentation" && (
            <>
            <button type="button" onClick={onAddSubitem}>
              <Icon name="list" size={15} />
              Add subitem
            </button>
            <button
              type="button"
              disabled={!canConvertToSubitem}
              title={convertToSubitemTitle(canConvertToSubitem)}
              onClick={onConvertToSubitem}
            >
              <Icon name="arrow" size={15} />
              Convert to subitem
            </button>
            </>
            )}
            <MoveToGroupSelect
              label="Move to"
              groups={groups}
              value={currentGroupId}
              onChange={(groupId) => {
                onMove(groupId);
                onMenuClose();
              }}
            />
            <button type="button" onClick={onArchive}>
              <Icon name="folder" size={15} />
              Archive item
            </button>
            <button className="is-danger" type="button" onClick={onDelete}>
              <Icon name="close" size={15} />
              Delete item
            </button>
          </div>
        </AnchoredPopover>
      </td>
      {columns.map((entry) => {
        if (entry.kind === "system") {
          return (
            <Fragment key={entry.column.id}>
              {systemCell(entry.key, entry.column)}
            </Fragment>
          );
        }
        const column = entry.column;
        return (
          <td
            className={
              "sheet-column--custom sheet-column--custom-" +
              column.type +
              (column.settings.wrap ? " is-column-wrapped" : "") +
              (shouldCenterBoardCell(column) ? " is-content-centered" : "") +
              pinnedClass(column)
            }
            key={column.id}
            style={columnStyle(column)}
          >
            <CustomColumnCell
              boardId={boardId}
              column={column}
              value={
                customCells[customCellKey(request.id, column.id)] ?? ""
              }
              fileCount={
                customFileCounts[customCellKey(request.id, column.id)] ?? 0
              }
              filePreview={
                customFilePreviews[customCellKey(request.id, column.id)] ?? []
              }
              requestId={request.id}
              onChange={(value) => onSaveCustom(column, value)}
              onUpdateSettings={(settings) =>
                onUpdateCustomColumn(column, settings)
              }
              onOpenFiles={() => onOpenCustomFiles(column)}
            />
          </td>
        );
      })}
      <td className="sheet-add-column-spacer" />
    </tr>
  );
}


import {
  ItemNameEditor,
  OptionCell,
  InlineTextCell,
  DateCell,
  TimelineCell,
} from "./board-cells";
import { SubitemRows, SubitemsCell } from "./board-subitems";
