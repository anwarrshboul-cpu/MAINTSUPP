"use client";

import {
  Fragment,
  useCallback,
  useDeferredValue,
  useEffect,
  useContext,
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
import {
  ColumnSettingsDialog,
  columnSettingsActionLabel,
} from "./board-column-settings";
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
import { SummaryDistribution } from "./cells/summary-distribution";
import { ExpiryCell } from "./cells/expiry-cell";
import { FileCell, boardFileCellFiles } from "./cells/file-cell";
import {
  AnalyticsMetricCard,
  AnalyticsToolbar,
  analyticsPeriodOptions,
  withinAnalyticsPeriod,
} from "./dashboard-analytics";
import { computeJobMeters, jobMeterTrendLabels } from "./dashboard-meters";
import { JobsMeterToggle, useCollapsingMeters } from "./jobs-meter-strip";

import {
  type BoardDisplayColumn,
  type BoardDragItem,
  type BoardDropTarget,
  type BoardResponse,
  type ColumnKey,
  type ColumnTypeDefinition,
  type CompactBoardResponse,
  type EditableFields,
  type MaintenanceBoardSnapshot,
  type MaintenanceBoardSnapshotColumn,
  type Option,
  columnTypeDefinitions,
  decodeBoardResponse,
  editableFallbackOptions,
  fallbackGroups,
  fallbackSystemColumns,
  groupColors,
  subitemStatusOptions,
} from "./board-model";
import {
  boardItemName,
  compareBoardValues,
  moveBoardItemPlacement,
  systemColumnSortValue,
} from "./board-ordering";
import {
  customCellKey,
  choiceList,
  customCellDisplay,
  findChoice,
  serializeCustomCellValue,
  shouldCenterBoardCell,
  displayedBoardColumnWidth,
  compactNumber,
  dateRangeSummary,
  filledSummary,
} from "./board-format";
import { useBoardMenuFit } from "./board-menu-fit";
import {
  MobileBoardContext,
  MobileCellSheet,
  useRevealBoardPopover,
} from "./board-primitives";
import { BoardMobileSection } from "./board-mobile-list";
import { copyBoardText, downloadBoardCsv } from "./board-export";
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

/**
 * The layout this board was last read in on a phone. Cards unless told
 * otherwise — that is what a 390px screen is for.
 */
function readMobileLayout(boardId: string): {
  boardId: string;
  layout: "cards" | "grid";
} {
  try {
    const stored = window.localStorage.getItem(
      `maintsupp:board:${boardId}:mobile-layout`,
    );
    if (stored === "cards" || stored === "grid") return { boardId, layout: stored };
  } catch {
    // Private browsing, or storage disabled.
  }
  return { boardId, layout: "cards" };
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
      try {
        window.localStorage.setItem(`maintsupp:board:${boardId}:mobile-layout`, layout);
      } catch {
        // A preference that cannot be saved is still a preference for now.
      }
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
  const [sortDirection, setSortDirection] = useState<"newest" | "oldest">(
    "newest",
  );
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
  const [actionsOpen, setActionsOpen] = useState(false);
  const [hideOpen, setHideOpen] = useState(false);
  // The columns panel hangs off a toolbar button, and the toolbar scrolls
  // sideways on a phone — see `useBoardMenuFit` for what that did to it.
  const hideMenuRef = useBoardMenuFit(hideOpen);
  const [columnPickerGroupId, setColumnPickerGroupId] = useState<string | null>(
    null,
  );
  const [columnInsertAfterId, setColumnInsertAfterId] = useState<string | null>(
    null,
  );
  const [columnSort, setColumnSort] = useState<{
    columnId: string;
    direction: "asc" | "desc";
  } | null>(null);
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
  // Only one group menu is ever open, so one ref serves whichever group opened
  // it. See `useBoardMenuFit` for why the menus need measuring at all.
  const groupMenuRef = useBoardMenuFit(groupMenuId !== null);
  const [selectionMoveOpen, setSelectionMoveOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingBoard, setLoadingBoard] = useState(true);
  const [draggingRequestId, setDraggingRequestId] = useState<string | null>(
    null,
  );
  const [dropTarget, setDropTarget] = useState<BoardDropTarget | null>(null);
  const dragItemRef = useRef<BoardDragItem | null>(null);
  const dropTargetRef = useRef<BoardDropTarget | null>(null);
  const pointerDragRef = useRef<{
    pointerId: number;
    pointerType: string;
    startX: number;
    startY: number;
    clientX: number;
    clientY: number;
    active: boolean;
    holdTimer: number | null;
    element: HTMLTableRowElement;
    item: BoardDragItem;
  } | null>(null);

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
      .sort((a, b) => {
        const delta =
          new Date(b.requestedAt).getTime() -
          new Date(a.requestedAt).getTime();
        return sortDirection === "newest" ? delta : -delta;
      });
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
    sortDirection,
  ]);

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
    () => computeJobMeters(filtered, analyticsPeriod, analyticsNow),
    [analyticsNow, analyticsPeriod, filtered],
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
      const response = await fetch(boardUrl("/api/board", boardId), {
        method: "PATCH",
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

  const groupedRows = useMemo(() => {
    const rowsByGroup = new Map<string, MaintenanceRequest[]>(
      groupByColumn ? [] : groups.map((group) => [group.id, []]),
    );
    const byColumn = groupByColumn
      ? allBoardColumns.find((item) => item.column.id === groupByColumn)
      : null;

    for (const request of filtered) {
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

    const activeColumn = columnSort
      ? allBoardColumns.find(
          (entry) => entry.column.id === columnSort.columnId,
        )
      : null;
    const direction = columnSort?.direction === "desc" ? -1 : 1;
    for (const rows of rowsByGroup.values()) {
      rows.sort((left, right) => {
        if (activeColumn) {
          const valueFor = (request: MaintenanceRequest) =>
            activeColumn.kind === "system"
              ? activeColumn.key === "name"
                ? boardItemName(
                    request,
                    boardId,
                    customCells[customCellKey(request.id, activeColumn.column.id)],
                  )
                : systemColumnSortValue(request, activeColumn.key)
              : activeColumn.column.type === "files"
                ? customFileCounts[
                    customCellKey(request.id, activeColumn.column.id)
                  ] ?? 0
                : customCellDisplay(
                    activeColumn.column,
                    customCells[
                      customCellKey(request.id, activeColumn.column.id)
                    ] ?? "",
                  );
          const compared = compareBoardValues(valueFor(left), valueFor(right));
          if (compared) return compared * direction;
        }
        return (
          (placement.get(left.id)?.position ?? Number.MAX_SAFE_INTEGER) -
          (placement.get(right.id)?.position ?? Number.MAX_SAFE_INTEGER)
        );
      });
    }
    return rowsByGroup;
  }, [
    allBoardColumns,
    boardId,
    columnSort,
    customCells,
    customFileCounts,
    filtered,
    groupByColumn,
    groups,
    placement,
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
    for (const request of filtered) {
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
  }, [allBoardColumns, customCells, filtered, groupByColumn, groups]);

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

  const sortByColumn = (
    column: MaintenanceBoardColumn,
    direction: "asc" | "desc",
  ) => {
    setColumnSort({ columnId: column.id, direction });
    setColumnMenuInstance(null);
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
    if (
      !window.confirm(
        `Delete "${column.title}" and all of its values${
          column.type === "files" ? " and files" : ""
        }? This cannot be undone.`,
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
      onNotify(`${column.title} deleted.`);
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
        error?: string;
      };
      if (!response.ok || !payload.cell) {
        throw new Error(payload.error || "The cell could not be saved.");
      }
      setCustomCells((current) => ({
        ...current,
        [key]: payload.cell!.value,
      }));
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

  const setBoardDropTarget = (target: BoardDropTarget | null) => {
    dropTargetRef.current = target;
    setDropTarget((current) =>
      current?.groupId === target?.groupId &&
      current?.beforeRequestId === target?.beforeRequestId
        ? current
        : target,
    );
  };

  const clearBoardDrag = () => {
    const pointer = pointerDragRef.current;
    if (pointer && pointer.holdTimer !== null) {
      window.clearTimeout(pointer.holdTimer);
    }
    if (pointer?.element.hasPointerCapture(pointer.pointerId)) {
      pointer.element.releasePointerCapture(pointer.pointerId);
    }
    dragItemRef.current = null;
    pointerDragRef.current = null;
    setDraggingRequestId(null);
    setBoardDropTarget(null);
  };

  const startBoardDrag = (item: BoardDragItem) => {
    dragItemRef.current = item;
    setDraggingRequestId(item.request.id);
    setBoardDropTarget(null);
    setRowMenuId(null);
    setGroupMenuId(null);
    setColumnMenuInstance(null);
    setColumnPickerGroupId(null);
  };

  const resolveBoardDropTarget = (
    clientX: number,
    clientY: number,
    fallbackGroupId?: string,
  ) => {
    const element = document.elementFromPoint(clientX, clientY);
    const row = element?.closest<HTMLElement>("[data-board-row-id]");
    const group = element?.closest<HTMLElement>("[data-board-group-id]");
    const groupId =
      row?.dataset.boardRowGroupId ??
      group?.dataset.boardGroupId ??
      fallbackGroupId ??
      null;
    if (!groupId) {
      setBoardDropTarget(null);
      return;
    }

    let beforeRequestId: string | null = null;
    if (row?.dataset.boardRowId) {
      const rect = row.getBoundingClientRect();
      if (clientY <= rect.top + rect.height / 2) {
        beforeRequestId = row.dataset.boardRowId;
      } else {
        let sibling = row.nextElementSibling;
        while (
          sibling instanceof HTMLElement &&
          !sibling.dataset.boardRowId
        ) {
          sibling = sibling.nextElementSibling;
        }
        beforeRequestId =
          sibling instanceof HTMLElement
            ? sibling.dataset.boardRowId ?? null
            : null;
      }
    }
    setBoardDropTarget({ groupId, beforeRequestId });
  };

  const autoScrollBoardForDrag = (clientX: number, clientY: number) => {
    const scroller = document.querySelector<HTMLElement>(".live-board-scroll");
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const edge = 58;
    const verticalStep = 18;
    const horizontalStep = 24;
    if (clientY < rect.top + edge) scroller.scrollBy(0, -verticalStep);
    else if (clientY > rect.bottom - edge) scroller.scrollBy(0, verticalStep);
    if (clientX < rect.left + edge) scroller.scrollBy(-horizontalStep, 0);
    else if (clientX > rect.right - edge) scroller.scrollBy(horizontalStep, 0);
  };

  const finishBoardDrag = () => {
    const item = dragItemRef.current;
    const target = dropTargetRef.current;
    clearBoardDrag();
    if (!item || !target) return;
    void moveItem(
      item.request,
      target.groupId,
      target.beforeRequestId,
    );
  };

  const activatePointerDrag = (
    pointer: NonNullable<typeof pointerDragRef.current>,
  ) => {
    if (pointer.active) return;
    pointer.active = true;
    if (pointer.holdTimer !== null) {
      window.clearTimeout(pointer.holdTimer);
      pointer.holdTimer = null;
    }
    try {
      pointer.element.setPointerCapture(pointer.pointerId);
    } catch {
      // The pointer may already have ended while the hold timer was firing.
    }
    startBoardDrag(pointer.item);
    if (pointer.pointerType !== "mouse" && "vibrate" in navigator) {
      navigator.vibrate(12);
    }
  };

  const onPointerDragStart = (
    item: BoardDragItem,
    event: ReactPointerEvent<HTMLTableRowElement>,
  ) => {
    if (!event.isPrimary || event.button !== 0) return;
    if (
      event.target instanceof Element &&
      event.target.closest("[data-board-drag-ignore]")
    ) {
      return;
    }

    const pointer: NonNullable<typeof pointerDragRef.current> = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      active: false,
      holdTimer: null,
      element: event.currentTarget,
      item,
    };
    pointerDragRef.current = pointer;
    const pointerId = event.pointerId;
    pointer.holdTimer = window.setTimeout(
      () => {
        const current = pointerDragRef.current;
        if (!current || current.pointerId !== pointerId) return;
        activatePointerDrag(current);
      },
      event.pointerType === "mouse" ? 170 : 300,
    );
  };

  const onPointerDragMove = (
    event: ReactPointerEvent<HTMLTableRowElement>,
  ) => {
    const pointer = pointerDragRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId) return false;
    pointer.clientX = event.clientX;
    pointer.clientY = event.clientY;

    if (!pointer.active) {
      const distance = Math.hypot(
        event.clientX - pointer.startX,
        event.clientY - pointer.startY,
      );
      if (pointer.pointerType === "mouse") {
        if (distance < 4 || event.buttons !== 1) return false;
        activatePointerDrag(pointer);
      } else {
        if (distance < 10) return false;
        if (pointer.holdTimer !== null) {
          window.clearTimeout(pointer.holdTimer);
        }
        pointerDragRef.current = null;
        return false;
      }
    }
    event.preventDefault();
    event.stopPropagation();
    resolveBoardDropTarget(event.clientX, event.clientY);
    autoScrollBoardForDrag(event.clientX, event.clientY);
    return true;
  };

  const onPointerDragEnd = (
    event: ReactPointerEvent<HTMLTableRowElement>,
  ) => {
    const pointer = pointerDragRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId) return false;
    const wasActive = pointer.active;
    if (pointer.holdTimer !== null) {
      window.clearTimeout(pointer.holdTimer);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    pointerDragRef.current = null;
    if (wasActive) {
      event.preventDefault();
      event.stopPropagation();
      finishBoardDrag();
    }
    return wasActive;
  };

  const onPointerDragCancel = (
    event: ReactPointerEvent<HTMLTableRowElement>,
  ) => {
    if (pointerDragRef.current?.pointerId !== event.pointerId) return;
    clearBoardDrag();
  };

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
      !window.confirm(
        `Delete ${requestIds.length} selected item${requestIds.length === 1 ? "" : "s"} and all attached files? This cannot be undone.`,
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
          `${deletedIds.length} item${deletedIds.length === 1 ? "" : "s"} deleted.`,
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

  const identity = boardIdentity(boardId);
  const isStoreDocumentation = boardId === "store-documentation";
  const canEditGroups = !isStoreDocumentation;
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
          periods={analyticsPeriodOptions}
          onPeriodChange={setAnalyticsPeriod}
          onExport={() =>
            downloadBoardCsv(
              boardId,
              scopedRequests,
              customColumns,
              customCells,
              customFileCounts,
            )
          }
        />
      </section>
      )}

      {/* `.live-job-metrics`, and `is-collapsed` once it sticks — the classes,
          the refs and the reasoning all live in jobs-meter-strip.tsx. */}
      {boardId === "maintenance" && (
      <section className={sectionClassName} ref={sectionRef} aria-label="Job meters">
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
              <small>{scopedRequests.length} {identity.itemNoun}</small>
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
          automationCount={1}
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
              <select
                aria-label="Filter by priority"
                value={priority}
                onChange={(event) =>
                  setPriority(event.target.value as "All" | Priority)
                }
              >
                <option>All</option>
                <option>Urgent</option>
                <option>High</option>
                <option>Medium</option>
                <option>Low</option>
              </select>
            )}
          </label>

          {/*
            Sort. On maintenance this flips the board between newest and oldest
            first. Store Documentation has no meaningful "requested" date — a
            store is not a ticket — so it sorts the sheet alphabetically by
            store instead, driving the same `columnSort` the Store column's own
            header menu sets, so the two controls agree rather than fighting.
          */}
          {isStoreDocumentation && itemNameColumn ? (
            <button
              className="live-board-tool"
              type="button"
              aria-label="Sort stores by name"
              onClick={() =>
                setColumnSort((current) =>
                  current?.columnId === itemNameColumn.id &&
                  current.direction === "asc"
                    ? { columnId: itemNameColumn.id, direction: "desc" }
                    : { columnId: itemNameColumn.id, direction: "asc" },
                )
              }
            >
              <Icon name="activity" size={16} />
              {columnSort?.columnId === itemNameColumn.id &&
              columnSort.direction === "desc"
                ? "Z–A"
                : "A–Z"}
            </button>
          ) : (
            <button
              className="live-board-tool"
              type="button"
              onClick={() => {
                setColumnSort(null);
                setSortDirection((current) =>
                  current === "newest" ? "oldest" : "newest",
                );
              }}
            >
              <Icon name="activity" size={16} />
              {sortDirection === "newest" ? "Newest" : "Oldest"}
            </button>
          )}

          <div className="live-board-menu-wrap" data-board-popover>
            <button
              className="live-board-tool"
              type="button"
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
            {hideOpen && (
              <div className="live-board-menu column-menu" ref={hideMenuRef}>
                <strong>Visible columns</strong>
                {allBoardColumns.map((entry) => {
                  const key =
                    entry.kind === "system"
                      ? entry.key
                      : `custom:${entry.column.id}`;
                  return (
                    <label key={key}>
                      <input
                        type="checkbox"
                        checked={visible(key)}
                        onChange={() =>
                          setHiddenColumns((current) => {
                            const next = new Set(current);
                            if (next.has(key)) next.delete(key);
                            else next.add(key);
                            return next;
                          })
                        }
                      />
                      {entry.column.title}
                    </label>
                  );
                })}
              </div>
            )}
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

          <button
            className="live-board-tool"
            type="button"
            onClick={() =>
              downloadBoardCsv(
                boardId,
                filtered,
                customColumns,
                customCells,
                customFileCounts,
              )
            }
          >
            <Icon name="download" size={16} />
            Export
          </button>
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
              const isDropTarget =
                Boolean(draggingRequestId) && dropTarget?.groupId === group.id;
              return (
                <section
                  className={`sheet-group${
                    isCollapsed ? "" : ` ${DEFERRED_GROUP_CLASS}`
                  }${isDropTarget ? " is-drop-target" : ""}${
                    isDropTarget && dropTarget?.beforeRequestId === null
                      ? " is-drop-at-end"
                      : ""
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
                        className="sheet-group__more"
                        type="button"
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
                      {groupMenuId === group.id && (
                        <div className="sheet-group__menu" ref={groupMenuRef}>
                          <button
                            type="button"
                            onClick={() => {
                              setCollapsed((current) => {
                                const next = new Set(current);
                                if (isCollapsed) next.delete(group.id);
                                else next.add(group.id);
                                return next;
                              });
                              setGroupMenuId(null);
                            }}
                          >
                            <Icon name="chevron" size={15} />
                            {isCollapsed ? "Expand group" : "Collapse group"}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (collapsed.size === groups.length) {
                                setCollapsed(new Set());
                              } else {
                                setCollapsed(
                                  new Set(groups.map((item) => item.id)),
                                );
                              }
                              setGroupMenuId(null);
                            }}
                          >
                            <Icon name="grid" size={15} />
                            {collapsed.size === groups.length
                              ? "Expand all groups"
                              : "Collapse all groups"}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setRowsSelected(
                                rows.map((request) => request.id),
                                true,
                              );
                              setGroupMenuId(null);
                            }}
                          >
                            <Icon name="check" size={15} />
                            Select all items in group
                          </button>
                          {!isStoreDocumentation && (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  setRenamingId(group.id);
                                  setRenameValue(group.name);
                                  setGroupMenuId(null);
                                }}
                              >
                                <Icon name="settings" size={15} />
                                Rename group
                              </button>
                              <button
                                type="button"
                                disabled={saving}
                                onClick={() => duplicateGroup(group)}
                              >
                                <Icon name="grid" size={15} />
                                Copy group and items
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  openGroupCreator();
                                  setGroupMenuId(null);
                                }}
                              >
                                <Icon name="plus" size={15} />
                                Add group
                              </button>
                              <div className="sheet-group__colors">
                                <span>Group color</span>
                                <div>
                                  {groupColors.map((color) => (
                                    <button
                                      key={color}
                                      type="button"
                                      aria-label={`Use ${color} for ${group.name}`}
                                      aria-pressed={group.color === color}
                                      style={{ "--group-choice": color } as CSSProperties}
                                      onClick={() => updateGroupColor(group, color)}
                                    />
                                  ))}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => sortGroup(group, "alphabetical")}
                              >
                                <Icon name="activity" size={15} />
                                Sort items A–Z
                              </button>
                              <button
                                type="button"
                                onClick={() => sortGroup(group, "newest")}
                              >
                                <Icon name="activity" size={15} />
                                Sort newest first
                              </button>
                              <button
                                type="button"
                                disabled={groups[0]?.id === group.id}
                                onClick={() => moveGroup(group, "up")}
                              >
                                <Icon name="arrow" size={15} />
                                Move group up
                              </button>
                              <button
                                type="button"
                                disabled={groups.at(-1)?.id === group.id}
                                onClick={() => moveGroup(group, "down")}
                              >
                                <Icon name="arrow" size={15} />
                                Move group down
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              downloadBoardCsv(
                                boardId,
                                rows,
                                customColumns,
                                customCells,
                                customFileCounts,
                              );
                              setGroupMenuId(null);
                            }}
                          >
                            <Icon name="download" size={15} />
                            Export group
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              createItem(group.id);
                              setGroupMenuId(null);
                            }}
                          >
                            <Icon name="plus" size={15} />
                            {addItemToGroupLabel}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              onNotify(
                                "Board apps are ready for the next integration.",
                              );
                              setGroupMenuId(null);
                            }}
                          >
                            <Icon name="settings" size={15} />
                            Apps
                          </button>
                          <button
                            type="button"
                            disabled={!rows.length || bulkBusy}
                            onClick={() => {
                              setGroupMenuId(null);
                              runBulkAction(
                                "archive_items",
                                rows.map((request) => request.id),
                              );
                            }}
                          >
                            <Icon name="folder" size={15} />
                            Archive group items
                          </button>
                          <button
                            className="is-danger"
                            type="button"
                            disabled={groups.length < 2}
                            onClick={() => deleteGroup(group)}
                          >
                            <Icon name="close" size={15} />
                            Delete group
                          </button>
                        </div>
                      )}
                    </div>
                    )}
                  </header>

                  {!isCollapsed && (
                    <table className="live-sheet">
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
                          {visibleBoardColumns.map((entry) => {
                            const column = entry.column;
                            const instanceId = `${group.id}:${column.id}`;
                            return (
                              <BoardColumnHeader
                                key={column.id}
                                kind={entry.kind}
                                systemKey={
                                  entry.kind === "system" ? entry.key : undefined
                                }
                                column={column}
                                menuOpen={columnMenuInstance === instanceId}
                                sortDirection={
                                  columnSort?.columnId === column.id
                                    ? columnSort.direction
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
                                  const visibilityKey =
                                    entry.kind === "system"
                                      ? entry.key
                                      : `custom:${column.id}`;
                                  setHiddenColumns(
                                    (current) =>
                                      new Set(current).add(visibilityKey),
                                  );
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
                            dragging={draggingRequestId === request.id}
                            dropBefore={
                              dropTarget?.groupId === group.id &&
                              dropTarget.beforeRequestId === request.id
                            }
                            columns={visibleBoardColumns}
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
                            onPointerDragStart={(event) =>
                              onPointerDragStart(
                                {
                                  request,
                                  sourceGroupId: group.id,
                                },
                                event,
                              )
                            }
                            onPointerDragMove={onPointerDragMove}
                            onPointerDragEnd={onPointerDragEnd}
                            onPointerDragCancel={onPointerDragCancel}
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
                              saveCustomCell(request, column, value)
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
            Showing <strong>{filtered.length}</strong> of {scopedRequests.length}{" "}
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
          <button
            type="button"
            onClick={() =>
              downloadBoardCsv(
                boardId,
                selectedRequests,
                customColumns,
                customCells,
                customFileCounts,
              )
            }
          >
            <Icon name="download" size={18} />
            Export
          </button>
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

function BoardColumnHeader({
  kind,
  systemKey,
  column,
  menuOpen,
  sortDirection,
  onMenuToggle,
  onConfigure,
  onRename,
  onToggleWrap,
  onSort,
  onAddRight,
  onDuplicate,
  onClear,
  onHide,
  onDelete,
  onChangeType,
  onCollapse,
  onGroupBy,
  collapsed,
  groupedByThis,
  onResizePreview,
  onResizeCommit,
}: {
  kind: BoardDisplayColumn["kind"];
  systemKey?: ColumnKey;
  column: MaintenanceBoardColumn;
  menuOpen: boolean;
  sortDirection: "asc" | "desc" | null;
  onMenuToggle: () => void;
  onConfigure?: () => void;
  onRename: () => void;
  onToggleWrap: () => void;
  onSort: (direction: "asc" | "desc") => void;
  onAddRight: () => void;
  onDuplicate?: () => void;
  onClear?: () => void;
  onHide: () => void;
  onDelete?: () => void;
  /** Retype a custom column. System columns refuse — the board reads them. */
  onChangeType?: (type: BoardColumnType) => void;
  onCollapse: () => void;
  onGroupBy: () => void;
  collapsed: boolean;
  groupedByThis: boolean;
  onResizePreview: (width: number) => void;
  onResizeCommit: (width: number) => void;
}) {
  const mobile = useContext(MobileBoardContext);
  const displayedWidth = displayedBoardColumnWidth(column, mobile);
  const definition =
    columnTypeDefinitions.find((item) => item.type === column.type) ??
    columnTypeDefinitions[2];
  const className =
    kind === "system" && systemKey
      ? `sheet-column--${systemKey}`
      : "sheet-column--custom";
  return (
    <th
      className={`${className}${
        column.settings.wrap ? " is-column-wrapped" : ""
      }`}
      style={{
        width: displayedWidth,
        minWidth: displayedWidth,
        maxWidth: displayedWidth,
      }}
    >
      <div className="custom-column-header" data-board-popover>
        {kind === "custom" && (
          <span
            className="custom-column-header__type"
            style={{ background: definition.color }}
          >
            <Icon name={definition.icon} size={13} />
          </span>
        )}
        <strong title={column.title}>{column.title}</strong>
        {sortDirection && (
          <button
            className="column-sort-indicator"
            type="button"
            title={`Sorted ${sortDirection === "asc" ? "ascending" : "descending"}`}
            aria-label={`Reverse ${column.title} sort`}
            onClick={() => onSort(sortDirection === "asc" ? "desc" : "asc")}
          >
            <Icon name="activity" size={12} />
          </button>
        )}
        <button
          className="custom-column-header__more"
          type="button"
          aria-label={`Actions for ${column.title}`}
          onClick={onMenuToggle}
        >
          <Icon name="more" size={15} />
        </button>
        {menuOpen && (
          <div className="custom-column-menu">
            <small>{kind === "system" ? "Board" : definition.label} column</small>
            {onConfigure && (
              <button type="button" onClick={onConfigure}>
                <Icon name="settings" size={15} />
                {columnSettingsActionLabel(column.type)}
              </button>
            )}
            <button type="button" onClick={onRename}>
              <Icon name="settings" size={15} />
              Rename column
            </button>
            <button type="button" onClick={onToggleWrap}>
              <Icon name="list" size={15} />
              {column.settings.wrap ? "Unwrap text" : "Wrap text"}
            </button>
            <button type="button" onClick={() => onSort("asc")}>
              <Icon name="activity" size={15} />
              Sort ascending
            </button>
            <button type="button" onClick={() => onSort("desc")}>
              <Icon name="activity" size={15} />
              Sort descending
            </button>
            <button type="button" onClick={onAddRight}>
              <Icon name="plus" size={15} />
              Add column to the right
            </button>
            {onDuplicate && (
              <button type="button" onClick={onDuplicate}>
                <Icon name="grid" size={15} />
                Duplicate column
              </button>
            )}
            {onClear && (
              <button type="button" onClick={onClear}>
                <Icon name="close" size={15} />
                Clear column
              </button>
            )}
            <button type="button" onClick={onCollapse}>
              <Icon name="chevron" size={15} />
              {collapsed ? "Expand column" : "Collapse column"}
            </button>
            <button type="button" onClick={onGroupBy}>
              <Icon name="grid" size={15} />
              {groupedByThis ? "Stop grouping by this" : "Group by this column"}
            </button>
            {onChangeType && (
              <label className="custom-column-menu__type">
                <span>
                  <Icon name="settings" size={15} />
                  Change column type
                </span>
                <select
                  value={column.type}
                  onChange={(event) =>
                    onChangeType(event.target.value as BoardColumnType)
                  }
                >
                  {columnTypeDefinitions.map((item) => (
                    <option key={item.type} value={item.type}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button type="button" onClick={onHide}>
              <Icon name="list" size={15} />
              Hide column
            </button>
            {onDelete && (
              <button className="is-danger" type="button" onClick={onDelete}>
                <Icon name="close" size={15} />
                Delete column
              </button>
            )}
          </div>
        )}
        <ColumnResizeHandle
          column={column}
          displayedWidth={displayedWidth}
          minimum={systemKey === "name" ? (mobile ? 150 : 220) : 90}
          onPreview={onResizePreview}
          onCommit={onResizeCommit}
        />
      </div>
    </th>
  );
}

function ColumnResizeHandle({
  column,
  displayedWidth,
  minimum,
  onPreview,
  onCommit,
}: {
  column: MaintenanceBoardColumn;
  displayedWidth: number;
  minimum: number;
  onPreview: (width: number) => void;
  onCommit: (width: number) => void;
}) {
  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = displayedWidth;
    let latestWidth = startWidth;
    document.body.classList.add("is-resizing-board-column");
    const move = (moveEvent: PointerEvent) => {
      latestWidth = Math.max(
        minimum,
        Math.min(600, Math.round(startWidth + moveEvent.clientX - startX)),
      );
      onPreview(latestWidth);
    };
    const finish = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", finish);
      document.body.classList.remove("is-resizing-board-column");
      if (latestWidth !== startWidth) onCommit(latestWidth);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", finish, { once: true });
    document.addEventListener("pointercancel", finish, { once: true });
  };
  return (
    <button
      className="column-resize-handle"
      type="button"
      aria-label={`Resize ${column.title} column`}
      title="Resize column"
      onPointerDown={startResize}
    />
  );
}

function ColumnPicker({
  query,
  showMore,
  busy,
  onQueryChange,
  onShowMore,
  onChoose,
  onClose,
}: {
  query: string;
  showMore: boolean;
  busy: boolean;
  onQueryChange: (value: string) => void;
  onShowMore: () => void;
  onChoose: (type: BoardColumnType) => void;
  onClose: () => void;
}) {
  const mobile = useContext(MobileBoardContext);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  const needle = query.trim().toLowerCase();
  const mobilePrimaryTypes: BoardColumnType[] = [
    "status",
    "people",
    "date",
    "text",
    "number",
    "timeline",
    "dropdown",
    "checkbox",
  ];
  const mobilePrimaryDefinitions = mobilePrimaryTypes
    .map((type) => columnTypeDefinitions.find((item) => item.type === type))
    .filter((item): item is ColumnTypeDefinition => Boolean(item));
  const mobileMoreDefinitions = columnTypeDefinitions.filter(
    (item) => !mobilePrimaryTypes.includes(item.type),
  );
  const visibleDefinitions = mobile
    ? showMore
      ? [...mobilePrimaryDefinitions, ...mobileMoreDefinitions]
      : mobilePrimaryDefinitions
    : columnTypeDefinitions.filter(
        (item) =>
          (item.section !== "More columns" || showMore || Boolean(needle)) &&
          (!needle ||
            item.label.toLowerCase().includes(needle) ||
            item.description.toLowerCase().includes(needle)),
      );
  const sections: ColumnTypeDefinition["section"][] = [
    "Essentials",
    "Super useful",
    "More columns",
  ];

  return (
    <div
      className={`column-picker${mobile ? " column-picker--mobile" : ""}`}
      role="dialog"
      aria-label="Add column"
    >
      {mobile ? (
        <header className="column-picker__mobile-header">
          <button
            type="button"
            aria-label="Close column picker"
            onClick={onClose}
          >
            <Icon name="close" size={25} />
          </button>
          <strong>Create new column</strong>
          <span aria-hidden="true" />
        </header>
      ) : (
        <header>
          <label>
            <Icon name="search" size={16} />
            <input
              autoFocus
              type="search"
              value={query}
              placeholder="Search or describe your column"
              onChange={(event) => onQueryChange(event.target.value)}
            />
          </label>
          <button
            type="button"
            aria-label="Close column picker"
            onClick={onClose}
          >
            <Icon name="close" size={17} />
          </button>
        </header>
      )}
      <div className="column-picker__body">
        {(mobile ? ["Essentials" as const] : sections).map((section) => {
          const definitions = visibleDefinitions.filter(
            (item) => mobile || item.section === section,
          );
          if (!definitions.length) return null;
          return (
            <section key={section}>
              {!mobile && <small>{section}</small>}
              <div>
                {definitions.map((definition) => (
                  <button
                    key={definition.type}
                    type="button"
                    disabled={busy}
                    onClick={() => onChoose(definition.type)}
                  >
                    <span style={{ background: definition.color }}>
                      <Icon name={definition.icon} size={mobile ? 23 : 15} />
                    </span>
                    <span>
                      <strong>
                        {mobile && definition.type === "dropdown"
                          ? "Tags"
                          : definition.label === "Numbers"
                            ? "Number"
                            : definition.label}
                      </strong>
                      {!mobile && <small>{definition.description}</small>}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
        {!visibleDefinitions.length && (
          <div className="column-picker__empty">
            No matching column type. Try text, date, people or files.
          </div>
        )}
      </div>
      {!showMore && !needle && (
        <button
          className="column-picker__more"
          type="button"
          onClick={onShowMore}
        >
          More columns
          <Icon name="chevron" size={15} />
        </button>
      )}
    </div>
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
  dragging,
  dropBefore,
  columns,
  onOpen,
  onOpenUpdates,
  onSelected,
  onMenuToggle,
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
  dragging: boolean;
  dropBefore: boolean;
  columns: BoardDisplayColumn[];
  onOpen: () => void;
  onOpenUpdates: () => void;
  onSelected: (selected: boolean) => void;
  onMenuToggle: () => void;
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
  // A row near the bottom of the screen has no room to open a 376px menu
  // downward. See `useBoardMenuFit`.
  const rowMenuRef = useBoardMenuFit(menuOpen);
  // Move column: 38 groups x 744 rows = 28,272 <option>s. Build them on focus.
  const [moveListOpen, setMoveListOpen] = useState(false);
  const columnStyle = (column: MaintenanceBoardColumn): CSSProperties => {
    const width = displayedBoardColumnWidth(column, mobile);
    return {
      width,
      minWidth: width,
      maxWidth: width,
    };
  };
  const systemCell = (
    key: ColumnKey,
    column: MaintenanceBoardColumn,
  ) => {
    const className =
      "sheet-column--" +
      key +
      (column.settings.wrap ? " is-column-wrapped" : "") +
      (shouldCenterBoardCell(column, key) ? " is-content-centered" : "");
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
              value={String(request.tier)}
              options={optionSets.tier}
              editableColumn="tier"
              onCreateOption={onCreateOption}
              onUpdateOption={onUpdateOption}
              onDeleteOption={onDeleteOption}
              onChange={(value) => onSave({ tier: Number(value) })}
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
              onSave={(value) =>
                onSave({ cost: value.trim() ? Number(value) : null })
              }
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
      className={`${selected ? "is-selected" : ""}${
        dragging ? " is-dragging" : ""
      }${dropBefore ? " is-drop-before" : ""}`.trim()}
      data-board-row-id={request.id}
      data-board-row-group-id={currentGroupId}
      aria-grabbed={dragging}
      title="Hold and drag any cell to move this row"
      onClickCapture={(event) => {
        if (!suppressRowClickRef.current) return;
        suppressRowClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onContextMenu={(event) => {
        if (dragging) event.preventDefault();
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
        <button
          className="sheet-row-more"
          type="button"
          aria-label={"Actions for " + request.id}
          title="Click for item actions"
          onClick={onMenuToggle}
        >
          <Icon name="more" size={15} />
        </button>
        <input
          type="checkbox"
          aria-label={"Select " + request.id}
          checked={selected}
          onChange={(event) => onSelected(event.target.checked)}
        />
        {menuOpen && (
          <div className="sheet-row-menu" data-board-drag-ignore ref={rowMenuRef}>
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
            <button type="button" onClick={onAddSubitem}>
              <Icon name="list" size={15} />
              Add subitem
            </button>
            <button
              type="button"
              disabled={!canConvertToSubitem}
              title={
                canConvertToSubitem
                  ? "Make this a child of the item above it"
                  : "There is no item above this one to become its parent"
              }
              onClick={onConvertToSubitem}
            >
              <Icon name="arrow" size={15} />
              Convert to subitem
            </button>
            <label>
              <span>
                <Icon name="arrow" size={15} />
                Move to
              </span>
              <select
                value={currentGroupId}
                onChange={(event) => {
                  onMove(event.target.value);
                  onMenuToggle();
                }}
              >
                {groups.map((group) => (
                  <option value={group.id} key={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={onArchive}>
              <Icon name="folder" size={15} />
              Archive item
            </button>
            <button className="is-danger" type="button" onClick={onDelete}>
              <Icon name="close" size={15} />
              Delete item
            </button>
          </div>
        )}
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
              (shouldCenterBoardCell(column) ? " is-content-centered" : "")
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
