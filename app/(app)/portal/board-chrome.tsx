"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import BoardHeader from "./board-header";
import { fetchLandingView, rememberLandingView } from "./board-view-memory";
import { iconFor, TabGlyph } from "./board-tab-glyph";
import { Icon } from "../../components";
import BoardViewPane from "./board-view-pane";
import { useScrollOverflow } from "./views/scroll-affordance";
import { BoardViewsScroll, useDismissOnOutside } from "./board-views-controls";
import type { BoardItem } from "./views/view-model";

export type BoardView = {
  id: string;
  key: string;
  name: string;
  type: string;
  icon: string | null;
  position: number;
  isDefault: boolean;
  system: boolean;
  built: boolean;
  /** Saved view settings. `glyph` carries monday's tab decoration. */
  settings?: { glyph?: "pin" | "app" };
};

type ViewType = { key: string; label: string; icon: string; built: boolean };

type BoardSummary = {
  id: string;
  key: string;
  name: string;
  itemNoun: string;
};

type Props = {
  /**
   * Which board this chrome belongs to.
   *
   * `/api/board/views` serves the maintenance board's saved views — Form, Fix
   * Tracker, Chart and File gallery are all built around work orders. On any
   * other board those tabs are neither meaningful nor reachable, so the strip is
   * suppressed rather than shown broken, and that board supplies its own views.
   */
  boardId?: string;
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
  boardId = "maintenance",
  sectionKey,
  boardName,
  children,
  automationCount = 1,
  onViewChange,
  items = [],
  palette = {},
  onOpenItem,
  onMoveItem,
  onFormSubmitted,
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
   */
  const tabsRef = useScrollOverflow<HTMLDivElement>();

  useEffect(() => {
    if (boardId !== "maintenance") return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/board/views");
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
   * Which tab to open on — see `board-view-memory.ts` for the rules. Runs after
   * the views load and only overrides an unset tab, so it can never yank the
   * strip out from under somebody mid-click.
   */
  const section = sectionKey ?? boardId;
  useEffect(() => {
    if (!views.length) return;
    let cancelled = false;
    void fetchLandingView(section).then((landing) => {
      if (!landing || cancelled) return;
      setActiveKey((current) =>
        current && views.some((view) => view.key === current)
          ? current
          : landing.view,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [views, section]);

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

  async function send(method: "POST" | "PATCH" | "DELETE", body?: unknown, query = "") {
    const response = await fetch(`/api/board/views${query}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(String(payload.error ?? "That did not work."));
      return null;
    }
    setRefreshToken((token) => token + 1);
    return payload;
  }

  async function addView(type: ViewType) {
    setAddOpen(false);
    const created = await send("POST", { name: type.label, type: type.key, icon: type.icon });
    if (created?.key) setActiveKey(created.key);
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
    <div className={`board-chrome${collapsed ? " is-collapsed" : ""}`}>
      {/* ── Row 1 — board header (AA1) ───────────────────────────────── */}
      <BoardHeader
        boardName={boardName ?? board?.name ?? "Board"}
        automationCount={automationCount}
      />

      {error && (
        <p className="board-chrome__error" role="alert">
          {error}
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss">×</button>
        </p>
      )}

      {/* ── Row 2 — view tabs (AA3–AA6) ──────────────────────────────── */}
      {boardId === "maintenance" && (
      <nav className="board-views" aria-label="Board views">
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
                  title={view.built ? undefined : `${view.name} is not built yet`}
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
                    className="board-views__tab-menu"
                    aria-label={`Options for ${view.name}`}
                    onClick={() => {
                      setMenuFor(menuFor === view.id ? null : view.id);
                      setOverflowOpen(false);
                      setAddOpen(false);
                    }}
                  >
                    <Icon name="more" size={14} />
                  </button>
                )}

                {menuFor === view.id && (
                  <div className="board-views__menu" role="menu">
                    <button type="button" onClick={() => { setMenuFor(null); setRenaming(true); }}>
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => { setMenuFor(null); void send("PATCH", { id: view.id, isDefault: true }); }}
                    >
                      Set as default
                    </button>
                    {/* monday distinguishes the two: the board's default, and
                        the view everyone lands on in THIS section. The second
                        is what an owner adding a section actually wants. */}
                    <button
                      type="button"
                      onClick={() => {
                        setMenuFor(null);
                        rememberLandingView(section, view.key, "workspace");
                      }}
                    >
                      Set as the view everyone lands on
                    </button>
                    <button
                      type="button"
                      className="is-destructive"
                      disabled={view.system}
                      title={view.system ? "The main table cannot be removed" : undefined}
                      onClick={() => void removeView(view)}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <BoardViewsScroll direction="forward" stripRef={tabsRef} />

        <div className="board-views__trailing">
          {overflowTabs.length > 0 && (
            <div className="board-views__overflow" data-board-popover>
              <button
                type="button"
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
              {overflowOpen && (
                <div className="board-views__menu" role="menu">
                  {overflowTabs.map((view) => (
                    <button
                      key={view.id}
                      type="button"
                      onClick={() => {
                        setActiveKey(view.key);
                        rememberView(view.key);
                        setOverflowOpen(false);
                      }}
                    >
                      {view.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="board-views__add" data-board-popover>
            <button
              type="button"
              onClick={() => {
                setAddOpen(!addOpen);
                setOverflowOpen(false);
                setMenuFor(null);
              }}
              aria-label="Add a view"
            >
              <Icon name="plus" size={16} />
            </button>
            {addOpen && (
              <div className="board-views__menu" role="menu">
                {types.map((type) => (
                  <button key={type.key} type="button" onClick={() => void addView(type)}>
                    <Icon name={iconFor(type.icon)} size={15} />
                    {type.label}
                    {!type.built && <em className="board-views__soon">soon</em>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </nav>
      )}

      {/* ── Row 3 — the existing toolbar ─────────────────────────────── */}
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
    </div>

      {/* ── The selected view's pane — see board-view-pane.tsx ─────────
          Rendered as a SIBLING of the chrome, not a child of it. The chrome is
          `position: sticky`, which is right for three short rows and wrong for
          a form: a sticky box taller than the viewport takes its overflowing
          bottom with it, and no scroll position can reach the end. */}
      {activeView && activeView.type !== "table" && (
        <BoardViewPane
          activeView={activeView}
          items={items}
          palette={palette}
          onOpenItem={onOpenItem}
          onMoveItem={onMoveItem}
          onFormSubmitted={onFormSubmitted}
        />
      )}
    </>
  );
}
