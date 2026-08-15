"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchLandingView, rememberLandingView } from "./board-view-memory";
import { iconFor, TabGlyph } from "./board-tab-glyph";
import { Icon, type IconName } from "../../components";
import {
  CalendarView,
  FormView,
  GalleryView,
  KanbanView,
  ReportsView,
} from "./views/board-views";
import { ChartView } from "./views/chart-and-filters";
import { FixTrackerView } from "./views/fix-tracker";
import { useScrollOverflow } from "./views/scroll-affordance";
import {
  BuildVibeView,
  FlatTableView,
  FormResponsesView,
  FormResultsView,
} from "./views/parity-views";
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
    <div className={`board-chrome${collapsed ? " is-collapsed" : ""}`}>
      {/* ── Row 1 — board header (AA1) ───────────────────────────────── */}
      <header className="board-header">
        <div className="board-header__title">
          <h2>{boardName ?? board?.name ?? "Board"}</h2>
          <button type="button" className="board-header__caret" aria-label="Board menu">
            <Icon name="chevron" size={16} />
          </button>
        </div>

        <div className="board-header__actions">
          <button type="button" className="board-header__action">
            <Icon name="spark" size={16} />
            <span>Integrate</span>
          </button>
          <button type="button" className="board-header__action">
            <Icon name="activity" size={16} />
            <span>Automate</span>
            <em className="board-header__count">{automationCount}</em>
          </button>
          {/*
            Named by `aria-label`, like the two icon-only buttons below it, and
            NOT by a visually-hidden span.

            Every off-screen-text recipe — this codebase already ships two, the
            Tailwind `.sr-only` this used and the `.visually-hidden` used
            twenty-odd times elsewhere — works by putting a real string in a
            1x1 box with `overflow: hidden`. That is 93px of clipped text at
            390px as far as any clipping audit is concerned, and it was the only
            such report on the board that was not a genuine truncation, so it
            cost a reader of that report a look every time.

            An `aria-label` carries the same accessible name with no text node
            to clip, which is why the siblings were already written this way.
          */}
          <button
            type="button"
            className="board-header__action"
            aria-label="Board updates"
          >
            <Icon name="updates" size={16} />
          </button>
          <button type="button" className="board-header__invite">Invite</button>
          <button type="button" className="board-header__action" aria-label="Share board">
            <Icon name="paperclip" size={16} />
          </button>
          <button type="button" className="board-header__action" aria-label="More board actions">
            <Icon name="more" size={16} />
          </button>
        </div>
      </header>

      {error && (
        <p className="board-chrome__error" role="alert">
          {error}
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss">×</button>
        </p>
      )}

      {/* ── Row 2 — view tabs (AA3–AA6) ──────────────────────────────── */}
      {boardId === "maintenance" && (
      <nav className="board-views" aria-label="Board views">
        <div className="board-views__tabs" ref={tabsRef}>
          {visibleTabs.map((view) => {
            const isActive = view.key === activeKey;
            return (
              <div
                key={view.id}
                className={`board-views__tab${isActive ? " is-active" : ""}${view.built ? "" : " is-unbuilt"}`}
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
                    onClick={() => setMenuFor(menuFor === view.id ? null : view.id)}
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

        {/*
          A forward control, because on THIS strip the fade alone was not
          enough.

          The fade works by dissolving whatever is under it, and at scroll
          position zero — the state every reader meets first — a tab boundary
          lands near the strip's right edge, so at 320px there was nothing
          under the fade but the active tab's underline and two menu dots. The
          account rail does not have this problem: its twelve destinations are
          evenly dense, so the fade always cuts through a label.

          It is the NEXT SIBLING of the scroller, which is what lets CSS show
          and hide it straight off the scroller's own `data-overflow` — no
          state, so a scroll does not re-render this component or the whole
          view pane under it. See views/scroll-affordance.css.

          One direction, not two. Two 44px controls would take 88px out of a
          218px strip at 320px; forward is the direction the reader cannot
          currently see, and once they have scrolled, the fade on the left tells
          them where they came from.
        */}
        <button
          type="button"
          className="board-views__forward"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => {
            const strip = tabsRef.current;
            if (!strip) return;
            strip.scrollBy({
              left: strip.clientWidth * 0.8,
              behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
                ? "auto"
                : "smooth",
            });
          }}
        >
          <Icon name="chevron" size={16} />
        </button>

        <div className="board-views__trailing">
          {overflowTabs.length > 0 && (
            <div className="board-views__overflow">
              <button type="button" onClick={() => setOverflowOpen(!overflowOpen)}>
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

          <div className="board-views__add">
            <button type="button" onClick={() => setAddOpen(!addOpen)} aria-label="Add a view">
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

      {activeView && activeView.type !== "table" && (
        <div className="board-chrome__pane">
          {/*
            The Fix Tracker is monday's engineer app, not a kanban. It is keyed
            off the view's own key rather than its type, because an admin can
            add further kanban views and those should stay kanbans.
          */}
          {activeView.type === "kanban" && activeView.key === "fix-tracker" && (
            <FixTrackerView items={items} palette={palette} onChanged={onFormSubmitted} />
          )}
          {activeView.type === "kanban" && activeView.key !== "fix-tracker" && (
            <KanbanView
              items={items}
              palette={palette}
              onOpen={onOpenItem}
              onMove={onMoveItem}
            />
          )}
          {activeView.type === "calendar" && (
            <CalendarView items={items} palette={palette} onOpen={onOpenItem} />
          )}
          {activeView.type === "chart" && <ChartView items={items} palette={palette} />}
          {activeView.type === "gallery" && (
            <GalleryView items={items} onOpen={onOpenItem} />
          )}
          {activeView.type === "reports" && <ReportsView items={items} />}
          {activeView.type === "form" && <FormView onSubmitted={onFormSubmitted} />}
          {/*
            monday's four other tabs. `flat-table` is monday's second table view
            (9116879) and is deliberately group-free — that is the whole
            difference from Main table, so it renders in the pane rather than
            replacing the grid below.
          */}
          {activeView.type === "form-results" && <FormResultsView items={items} />}
          {activeView.type === "form-responses" && (
            <FormResponsesView items={items} onOpen={onOpenItem} />
          )}
          {activeView.type === "flat-table" && (
            <FlatTableView items={items} onOpen={onOpenItem} />
          )}
          {activeView.type === "vibe" && <BuildVibeView items={items} />}
          {!activeView.built && (
            <p className="board-chrome__placeholder">
              <Icon name="alert" size={16} />
              <span>
                <strong>{activeView.name}</strong> is not built yet. The table below is
                still the live board.
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
