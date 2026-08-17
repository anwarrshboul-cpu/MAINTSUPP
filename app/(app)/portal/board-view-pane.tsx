"use client";

/**
 * What a view tab actually shows — everything except Main table.
 *
 * Extracted from `board-chrome.tsx`, which `stage-eight-board-split` holds to
 * 500 lines and which was within seven of it. Eleven of its imports existed
 * only to be named once each in one switch-shaped block, so moving the block
 * takes the imports with it and leaves the chrome as what its own header
 * comment says it is: three stacked rows and the state behind them.
 *
 * IT RENDERS AS A SIBLING OF `.board-chrome`, NOT INSIDE IT.
 *
 * The chrome is `position: sticky; top: 0`, which is right for three short rows
 * that should tuck under the top bar and stay there. A form is not three short
 * rows. A sticky box taller than the viewport pins its top at the offset and
 * takes its overflowing bottom with it, so the last fields of the request form
 * and the last row of Fix Tracker cards sat below the fold with no scroll
 * position that could reach them. Out here the pane is ordinary flow content
 * and scrolls like anything else, while the rows above it keep sticking.
 */

import {
  CalendarView,
  FormView,
  GalleryView,
  KanbanView,
  ReportsView,
} from "./views/board-views";
import { ChartView } from "./views/chart-and-filters";
import { FixTrackerView } from "./views/fix-tracker";
import {
  BuildVibeView,
  FlatTableView,
  FormResponsesView,
  FormResultsView,
} from "./views/parity-views";
import { Icon } from "../../components";
import type { BoardView } from "./board-chrome";
import type { BoardItem } from "./views/view-model";

/**
 * Whether opening this tab means the grid goes away — A VIEW TAB IS A SECTION,
 * NOT A BANNER OVER THE GRID.
 *
 * Every tab used to render its view into the pane and leave the whole table
 * mounted underneath, so Form and Fix Tracker were drawn ON TOP OF the board
 * rather than instead of it. Two things went wrong with that, and both are what
 * a reader sees rather than a tidiness argument:
 *
 *   • `.live-board-footer` — the "Add new group" bar — is
 *     `position: absolute; bottom: 0; z-index: 12`, pinned to the bottom of the
 *     board section, while `.board-chrome` above it is `z-index: 5`. So the
 *     footer painted OVER the bottom of whatever the pane was showing: the last
 *     field of the request form and the last row of Fix Tracker cards were cut
 *     off by a bar belonging to a table that was not on screen.
 *   • the grid kept its scroll height, so the page went on scrolling long past
 *     the end of the view, through a table nobody had asked to see.
 *
 * An UNBUILT view is the one exception and keeps the grid, because its pane is
 * only a "not built yet" note — which says in as many words that the table below
 * is still the live board. Hiding it would leave that tab showing nothing at all.
 *
 * `live-board.tsx` calls this with the view `BoardChrome` reports up, and uses
 * the answer to drop the grid, the footer, the mobile cards and the group
 * creator together.
 */
export function viewReplacesGrid(view: BoardView | null) {
  return Boolean(view && view.type !== "table" && view.built);
}

export default function BoardViewPane({
  activeView,
  items,
  palette,
  onOpenItem,
  onMoveItem,
  onFormSubmitted,
}: {
  activeView: BoardView;
  items: BoardItem[];
  palette: Record<string, string>;
  onOpenItem?: (item: BoardItem) => void;
  onMoveItem?: (itemId: string, value: string) => void;
  onFormSubmitted?: () => void;
}) {
  return (
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
  );
}
