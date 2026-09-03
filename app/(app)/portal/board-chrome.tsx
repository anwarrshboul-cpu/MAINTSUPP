"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BoardActionsHost } from "./board-actions/board-actions-host";
import { AddViewMenu, ViewOverflowMenu, ViewTabMenu } from "./board-actions/view-menus";
import { rememberLandingView, useLandingView } from "./board-view-memory";
import { writeBoardView } from "./board-view-writes";
import { TabGlyph } from "./board-tab-glyph";
import { Icon } from "../../components";
import BoardViewPane, {
  useActiveTabInView,
  viewReplacesGrid,
  type BoardCalendarWiring,
} from "./board-view-pane";
import { useScrollOverflow } from "./views/scroll-affordance";
import { BoardViewsScroll, useDismissOnOutside } from "./board-views-controls";
import type { BoardItem } from "./views/view-model";
import type { BoardSummary, BoardView, ViewType } from "./board-view-types";

/* Re-exported from where it has always been imported. `live-board.tsx` and
   `board-tab-glyph.tsx` take `BoardView` off this module; the shapes moved to
   relieve this file's 500-line limit, and a move must not be a rename for
   every caller. See `board-view-types.ts`. */
export type { BoardView } from "./board-view-types";

type Props = {
  /**
   * Which board this chrome belongs to. REQUIRED, and deliberately so: it used
   * to default to `"maintenance"`, so a caller that forgot to pass a board got
   * the CANONICAL JOB BOARD's tab strip, and every view it created, renamed,
   * reordered or binned landed there. That is the fallback W02-06 forbids — a
   * missing scope is a refusal or an empty state, never somebody else's
   * register. With no default the same mistake is a compile error.
   */
  boardId: string;
  /**
   * Which SECTION this board is being drawn in — Stage 23.
   *
   * The view a person lands on is remembered per section rather than per board,
   * because two sections can read the same board and landing somewhere
   * different is the entire reason for adding the second one. Defaults to the
   * board id, which IS the section key for the two built-in board sections.
   */
  sectionKey?: string;
  /** Overrides the fetched board name when the views endpoint is not used. */
  boardName?: string;
  /** Rendered inside row 3 — the existing live-board toolbar. */
  children?: React.ReactNode;
  /**
   * Ignored. The header reads its count from `/api/automations` itself
   * (`board-actions/board-actions-host.tsx`); a number passed in here was a
   * placeholder and is never shown. Kept in the type so the one call site
   * that still passes it compiles until the integrator removes it.
   */
  automationCount?: number;
  onViewChange?: (view: BoardView) => void;
  /** Items already filtered by the table's own controls. */
  items?: BoardItem[];
  /** Option label to colour, so chips match the table. */
  palette?: Record<string, string>;
  onOpenItem?: (item: BoardItem) => void;
  onMoveItem?: (itemId: string, value: string) => void;
  /** Fired after the Form tab creates a job, so the table can pick it up. */
  onFormSubmitted?: () => void;
  /** The Calendar tab's own wiring — passed through unread. See the pane. */
  calendar?: BoardCalendarWiring;
};

/**
 * Board chrome — the three stacked rows above the grid.
 *
 *   Row 1  board name + actions          (AA1)
 *   Row 2  view tabs                     (AA3–AA6)
 *   Row 3  the existing toolbar, passed in as children
 *
 * All three are sticky so the grid scrolls beneath them (AA2).
 */
export default function BoardChrome({
  boardId,
  sectionKey,
  boardName,
  children,
  onViewChange,
  items = [],
  palette = {},
  onOpenItem,
  onMoveItem,
  onFormSubmitted,
  calendar,
}: Props) {
  const [board, setBoard] = useState<BoardSummary | null>(null);
  const [views, setViews] = useState<BoardView[]>([]);
  const [types, setTypes] = useState<ViewType[]>([]);
  const [activeKey, setActiveKey] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [renaming, setRenaming] = useState(false);

  // Anchors for the strip's three menus — see board-actions/view-menus.tsx.
  // One RefObject per tab, made together whenever the view list changes.
  const tabMenuRefs = useMemo(
    () => new Map<string, React.RefObject<HTMLButtonElement | null>>(views.map((view) => [view.id, { current: null }])),
    [views],
  );
  const tabMenuRef = (id: string) => tabMenuRefs.get(id) ?? { current: null };
  const overflowRef = useRef<HTMLButtonElement | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);

  // One closer for all three strip menus — "All", "+" and a tab's own "…".
  // See `useDismissOnOutside` for why the strip needed this at all, and the
  // `data-board-popover` markers below for what counts as "inside".
  const closeStripMenus = useCallback(() => {
    setOverflowOpen(false);
    setAddOpen(false);
    setMenuFor(null);
  }, []);
  useDismissOnOutside(closeStripMenus);

  /*
   * The strip holds eleven tabs and a phone shows two of them. The hook writes
   * `data-overflow` from measured scroll state, so the fade at the strip's edge
   * appears only while there is something past it — views/scroll-affordance.ts.
   * The second hook keeps the ACTIVE tab inside that box, which the fade alone
   * could not do — see `useActiveTabInView` for the phone it was measured on.
   */
  const tabsRef = useScrollOverflow<HTMLDivElement>();
  useActiveTabInView(tabsRef, activeKey);

  useEffect(() => {
    /*
     * ASK THE ENDPOINT ABOUT ANY BOARD THAT HAS ONE.
     *
     * This read `boardId !== "maintenance"` and then `boardId !==
     * "store-documentation"`, and both spellings were the same mistake: which
     * boards have a tab strip decided by NAME. The first left a section's own
     * register with no tabs at all (W02-06); the second is the pattern
     * requirement C exists to remove, and it would have hidden the strip on a
     * Store-Documentation-template INSTANCE too, which does have views of its
     * own.
     *
     * The board answers for itself now: the built-in Store Documentation board
     * holds no `board_views` rows — it declares its three tabs in
     * `views/store-documentation-board.tsx` and would show two strips if this
     * drew a second — so the fetch returns `views: []` and the nav below simply
     * has nothing to render. Same outcome on that board, by a property of the
     * board rather than by its key.
     *
     * An EMPTY board id is still refused here rather than sent: it is a section
     * with no register of its own, and `?board=` with nothing after it is what
     * the route 404s. Nothing is gained by making the round trip.
     */
    if (!boardId) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/board/views?board=${encodeURIComponent(boardId)}`);
        if (!response.ok) throw new Error("Views could not be loaded.");
        const payload = (await response.json()) as {
          board: BoardSummary;
          views: BoardView[];
          types: ViewType[];
        };
        if (cancelled) return;
        setBoard(payload.board);
        setViews(payload.views);
        setTypes(payload.types);
        setActiveKey((current) => {
          if (current && payload.views.some((view) => view.key === current)) return current;
          const fallback = payload.views.find((view) => view.isDefault) ?? payload.views[0];
          return fallback?.key ?? "";
        });
        setError(null);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Something went wrong.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // `boardId` gates the fetch above, so a board change must re-run it.
  }, [boardId, refreshToken]);

  /*
   * Which tab to open on — `?view=` from a shared link, then the remembered
   * landing view, then the board's own default. All three rules, and the
   * ordering fault that made the middle one dead code, live in
   * `board-view-memory.ts`, which is where this module's docstring has always
   * said they belong.
   */
  const section = sectionKey ?? boardId;
  useLandingView(section, views, setActiveKey);

  const rememberView = useCallback(
    (key: string) => rememberLandingView(section, key),
    [section],
  );

  const activeView = useMemo(
    () => views.find((view) => view.key === activeKey) ?? null,
    [views, activeKey],
  );

  useEffect(() => {
    if (activeView && onViewChange) onViewChange(activeView);
  }, [activeView, onViewChange]);

  /* Is the grid what is on screen — and so, does row 3 belong here? Row 3 is
     the TABLE's toolbar and it leaves with the thing it controls. The whole
     account, including what happens to the collapse chevron inside it, is in
     `viewReplacesGrid`. */
  const gridOnScreen = !viewReplacesGrid(activeView);

  /* The board travels with every write, or a view added on a section's
     register lands on the job board — see `board-view-writes.ts`. */
  async function send(method: "POST" | "PATCH" | "DELETE", body?: unknown, query = "") {
    const result = await writeBoardView(boardId, method, body, query);
    if (!result.ok) {
      setError(result.error);
      return null;
    }
    setRefreshToken((token) => token + 1);
    return result.payload;
  }

  async function addView(type: ViewType) {
    setAddOpen(false);
    const created = await send("POST", { name: type.label, type: type.key, icon: type.icon });
    // Remembered as well as opened: creating a view IS navigating to it, and
    // without this a reload put the reader back on Main table — the tab they
    // had just made was still there, just not the one that opened.
    const key = typeof created?.key === "string" ? created.key : "";
    if (key) { setActiveKey(key); rememberView(key); }
  }

  async function renameView(view: BoardView, name: string) {
    setRenaming(false);
    if (!name.trim() || name === view.name) return;
    await send("PATCH", { id: view.id, name: name.trim() });
  }

  async function removeView(view: BoardView) {
    setMenuFor(null);
    await send("DELETE", undefined, `?id=${encodeURIComponent(view.id)}`);
    if (view.key === activeKey) setActiveKey("");
  }

  /*
   * monday keeps all eleven tabs in the strip and scrolls it sideways, which
   * `.board-views__tabs` already does. Truncating at six put five of monday's
   * eleven — Table, Chart, Build Vibe view, File gallery and Board Reports —
   * behind a menu, so the tab order the board is meant to reproduce was not
   * visible at all. The All menu stays as monday's own jump list over every
   * view, which is what it is there for once nothing is hidden.
   */
  const visibleTabs = views;
  const overflowTabs = views.length > 6 ? views : [];

  return (
    <>
    {/* Collapse is a Main-Table affordance: remembered, but applied only while
        row 3 is drawn — `viewReplacesGrid` names the dead end otherwise. */}
    <div className={`board-chrome${collapsed && gridOnScreen ? " is-collapsed" : ""}`}>
      {/* ── Row 1 — board header (AA1) ───────────────────────────────── */}
      <BoardActionsHost
        boardId={boardId}
        boardName={boardName ?? board?.name ?? "Board"}
        activeKey={activeKey}
      />

      {error && (
        <p className="board-chrome__error" role="alert">
          {error}
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss">×</button>
        </p>
      )}

      {/* ── Row 2 — view tabs (AA3–AA6) ──────────────────────────────── */}
      {/* Drawn for a board that HAS views, not for a board with the right
          name — see the fetch above. A strip with no tabs would still draw the
          "All" and "+" controls over a board that keeps its tabs elsewhere. */}
      {views.length > 0 && (
      <nav className="board-views" aria-label="Board views">
        {/*
          The strip and its two arrows live in one positioned wrapper so the
          arrows can overlay the strip instead of sitting beside it. When they
          were flex siblings, an arrow appearing or disappearing changed the
          strip's width, which re-fired the ResizeObserver that decides whether
          the arrow shows — "ResizeObserver loop completed with undelivered
          notifications" on every collapse/expand. Overlaid, their visibility
          cannot change any measured size, so the loop cannot form.
        */}
        <div className="board-views__strip">
        <BoardViewsScroll direction="back" stripRef={tabsRef} />

        <div className="board-views__tabs" ref={tabsRef}>
          {visibleTabs.map((view) => {
            const isActive = view.key === activeKey;
            return (
              <div
                key={view.id}
                className={`board-views__tab${isActive ? " is-active" : ""}${view.built ? "" : " is-unbuilt"}`}
                data-board-popover
              >
                <button
                  type="button"
                  onClick={() => {
                    setActiveKey(view.key);
                    rememberView(view.key);
                  }}
                  aria-current={isActive ? "page" : undefined}
                  /* The server's own sentence where there is one — a Form tab
                     on a register with no form is not "not built yet", and
                     saying so sends the operator looking for a release that
                     was shipped a year ago. See `BoardView.unavailable`. */
                  title={
                    view.built
                      ? undefined
                      : view.unavailable ?? `${view.name} is not built yet`
                  }
                >
                  <TabGlyph view={view} />
                  {isActive && renaming ? (
                    <input
                      autoFocus
                      defaultValue={view.name}
                      aria-label={`Rename ${view.name}`}
                      onBlur={(event) => void renameView(view, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") setRenaming(false);
                      }}
                    />
                  ) : (
                    <span>{view.name}</span>
                  )}
                  {!view.built && <em className="board-views__soon">soon</em>}
                </button>

                {isActive && (
                  <button
                    type="button"
                    ref={(node) => {
                      tabMenuRef(view.id).current = node;
                    }}
                    className="board-views__tab-menu"
                    aria-label={`Options for ${view.name}`}
                    aria-haspopup="menu"
                    aria-expanded={menuFor === view.id}
                    onClick={() => {
                      setMenuFor(menuFor === view.id ? null : view.id);
                      setOverflowOpen(false);
                      setAddOpen(false);
                    }}
                  >
                    <Icon name="more" size={14} />
                  </button>
                )}

                {/* The tab's menu, on the shared layer — board-actions/view-menus.tsx. */}
                <ViewTabMenu
                  view={view}
                  open={menuFor === view.id}
                  anchorRef={tabMenuRef(view.id)}
                  onClose={() => setMenuFor(null)}
                  onRename={() => { setMenuFor(null); setRenaming(true); }}
                  onSetDefault={() => { setMenuFor(null); void send("PATCH", { id: view.id, isDefault: true }); }}
                  onSetLanding={() => {
                    setMenuFor(null);
                    rememberLandingView(section, view.key, "workspace");
                  }}
                  onDelete={() => void removeView(view)}
                />
              </div>
            );
          })}
        </div>

        <BoardViewsScroll direction="forward" stripRef={tabsRef} />
        </div>

        <div className="board-views__trailing">
          {overflowTabs.length > 0 && (
            <div className="board-views__overflow" data-board-popover>
              <button
                type="button"
                ref={overflowRef}
                aria-haspopup="menu"
                aria-expanded={overflowOpen}
                onClick={() => {
                  setOverflowOpen(!overflowOpen);
                  // One menu at a time, as monday does — otherwise "All" and
                  // "+" can both be open and overlapping.
                  setAddOpen(false);
                  setMenuFor(null);
                }}
              >
                All <Icon name="chevron" size={14} />
              </button>
              <ViewOverflowMenu
                views={overflowTabs}
                open={overflowOpen}
                anchorRef={overflowRef}
                onClose={() => setOverflowOpen(false)}
                onPick={(view) => {
                  setActiveKey(view.key);
                  rememberView(view.key);
                  setOverflowOpen(false);
                }}
              />
            </div>
          )}

          <div className="board-views__add" data-board-popover>
            <button
              type="button"
              ref={addRef}
              aria-haspopup="menu"
              aria-expanded={addOpen}
              onClick={() => {
                setAddOpen(!addOpen);
                setOverflowOpen(false);
                setMenuFor(null);
              }}
              aria-label="Add a view"
            >
              <Icon name="plus" size={16} />
            </button>
            <AddViewMenu
              types={types}
              open={addOpen}
              anchorRef={addRef}
              onClose={() => setAddOpen(false)}
              onAdd={(type) => void addView(type)}
            />
          </div>
        </div>
      </nav>
      )}

      {/* ── Row 3 — the existing toolbar, on the table only ──────────── */}
      {gridOnScreen && (
        <div className="board-chrome__toolbar">
          {children}
          <button
            type="button"
            className="board-chrome__collapse"
            aria-label={collapsed ? "Expand board header" : "Collapse board header"}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}
          >
            <Icon name="chevron" size={16} />
          </button>
        </div>
      )}
    </div>

      {/* ── The selected view's pane — see board-view-pane.tsx ─────────
          Rendered as a SIBLING of the chrome, not a child of it. The chrome is
          `position: sticky`, which is right for three short rows and wrong for
          a form: a sticky box taller than the viewport takes its overflowing
          bottom with it, and no scroll position can reach the end. */}
      {activeView && activeView.type !== "table" && (
        <BoardViewPane
          boardId={boardId}
          activeView={activeView}
          items={items}
          palette={palette}
          onOpenItem={onOpenItem}
          onMoveItem={onMoveItem}
          onFormSubmitted={onFormSubmitted}
          calendar={calendar}
        />
      )}
    </>
  );
}
