"use client";

/**
 * Which component draws the selected view.
 *
 * This is one `switch` written as JSX, and it lives apart from `board-chrome`
 * because it is the part of the chrome that GROWS. The chrome's own job — fetch
 * the saved views, keep the tab strip, remember where a reader lands — is
 * finished and stable at around 480 lines. The pane gained four view types in
 * Stage 19 alone, and every one of them added a branch here and an import at
 * the top of the file. That is what pushed `board-chrome.tsx` over its 500-line
 * limit, and leaving the two together would push it over again on the next view.
 *
 * The split is the same one Stage 23 made when the tab glyphs moved to
 * `board-tab-glyph.tsx` for exactly this reason: the assertions that used to
 * read `board-chrome.tsx` now read this file, because what is rendered and when
 * has not changed at all — only which file it is written in.
 *
 * It also stops the chrome importing all eleven view modules. `board-chrome` is
 * rendered on every board; the eight heavy view components underneath are only
 * reachable once somebody picks a non-table tab.
 */

import type { BoardView } from "./board-chrome";
import { Icon } from "../../components";
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
import type { BoardItem } from "./views/view-model";

type Props = {
  /** The selected view. The caller has already excluded `type === "table"`. */
  activeView: BoardView;
  /** Items already filtered by the table's own controls. */
  items: BoardItem[];
  /** Option label to colour, so chips match the table. */
  palette: Record<string, string>;
  onOpenItem?: (item: BoardItem) => void;
  onMoveItem?: (itemId: string, value: string) => void;
  /** Fired after the Form tab creates a job, so the table can pick it up. */
  onFormSubmitted?: () => void;
};

export default function BoardViewPane({
  activeView,
  items,
  palette,
  onOpenItem,
  onMoveItem,
  onFormSubmitted,
}: Props) {
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
