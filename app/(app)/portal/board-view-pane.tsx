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

import { useEffect, useMemo } from "react";
import type { BoardView } from "./board-chrome";
import { Icon } from "../../components";
import { OperationsCalendarPanel } from "./calendar-surface";
import type { CalendarWriteTarget } from "./calendar-model";
import type { MaintenanceRequest } from "../../lib/types";
import type { WorkspaceSnapshot } from "../../lib/workspace-data";
import {
  GalleryView,
  KanbanView,
  ReportsView,
} from "./views/board-views";
import FormBuilder from "./form-builder";
import { ChartView } from "./views/chart-and-filters";
import { FixTrackerView } from "./views/fix-tracker";
import {
  BuildVibeView,
  FlatTableView,
  FormResponsesView,
  FormResultsView,
} from "./views/parity-views";
import type { BoardItem } from "./views/view-model";

/**
 * Everything the Calendar tab needs that the grid's own props do not carry.
 *
 * ONE BUNDLE RATHER THAN SEVEN LOOSE PROPS, because these are not seven
 * unrelated options: they are the wiring for a single surface, and a host
 * either has all of it or none of it. `BoardChrome` passes the bundle straight
 * through without reading a field of it, which is also what keeps the chrome
 * under its 500-line limit.
 *
 * Every field is optional and the whole bundle is optional, so a host that
 * mounts the chrome without a workspace behind it — a board with no compliance
 * register, a preview, a test — still gets a working calendar: it draws the
 * board's own dates and refuses a date CHANGE out loud rather than pretending
 * to save one. See `NO_DATE_WRITER` below.
 */
export type BoardCalendarWiring = {
  /**
   * The same rows as `items`, typed as what they actually are.
   *
   * See `boardItemsAsRequests` for why the two types coincide and what the
   * adapter cannot recover. A host that already holds `MaintenanceRequest[]` —
   * `live-board.tsx` does — should pass it here, and then nothing is adapted
   * and nothing is lost.
   */
  requests?: MaintenanceRequest[];
  /**
   * The compliance register. Omitted means `[]`, and the calendar then draws no
   * renewal events at all — which is the honest picture for a board that has no
   * register behind it, rather than an empty row of certificates.
   */
  complianceRecords?: WorkspaceSnapshot["compliance"];
  onOpenRequest?: (request: MaintenanceRequest) => void;
  onOpenCompliance?: (id: string | null) => void;
  onNotify?: (message: string) => void;
  /** The audited write path for a job's own date field. */
  onJobDateChange?: (
    id: string,
    field: "dueAt" | "requestedAt" | "completedAt" | "nextUpdateAt",
    day: string | null,
  ) => Promise<void>;
  /** The audited write path for a certificate expiry. */
  onComplianceDateChange?: (
    target: CalendarWriteTarget,
    day: string,
  ) => Promise<void>;
};

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
  /** See `BoardCalendarWiring` — the Calendar tab's own props. */
  calendar?: BoardCalendarWiring;
};

/**
 * The refusal a calendar gives when nobody wired a write path to it.
 *
 * NOT a no-op that resolves. `commitDate` in `calendar-surface.tsx` reports a
 * rejection through `onNotify` and leaves the picker open on the value the
 * person chose; a silent success would close the picker, redraw the event on
 * the new day and lose the change on the next refresh with nothing to explain
 * it. Refusing out loud is the only honest answer to "save this" when there is
 * nothing behind it.
 */
const NO_DATE_WRITER = async (): Promise<never> => {
  throw new Error("This board cannot save calendar dates.");
};

/**
 * `BoardItem` → `MaintenanceRequest`, for a host that has only the pane's own
 * items.
 *
 * WHY THE TWO TYPES COINCIDE AT RUNTIME. The board hands the pane the very
 * objects it loaded: `live-board.tsx` renders `<BoardChrome items={…}>` from
 * its `MaintenanceRequest[]`, and every field `BoardItem` names — id, title,
 * status, priority, siteId, location, category, contractor and the four date
 * fields — is read straight off those objects under the same name. `BoardItem`
 * is not a different shape; it is the SUBSET of the request that the view
 * renderers read, written down separately so a view cannot reach for a field
 * the board does not pass. TypeScript has no way to know the two describe one
 * object, which is why the existing call site casts, and casting is exactly
 * what this function exists to avoid.
 *
 * WHAT IT CANNOT RECOVER. `stage` is not in `BoardItem`, so it is defaulted to
 * the board's first stage rather than guessed at. The calendar reads stage in
 * one place only — `isClosedRequest`, which resolves an event's colour — and
 * that test is `stage === "Completed" || hasCompletedStatus(request)`, so a
 * finished job is still drawn as resolved through its STATUS, which `BoardItem`
 * does carry, or through its completion date. The gap is a job filed as
 * Completed by stage whose status says otherwise and which has no completion
 * date: that one is drawn as still open. Passing `requests` avoids the gap
 * entirely, and the board does.
 */
export function boardItemsAsRequests(items: BoardItem[]): MaintenanceRequest[] {
  return items.map((item) => ({
    id: item.id,
    parentId: item.parentId,
    reference: item.reference,
    source: "Manual",
    title: item.title,
    description: item.description ?? "",
    location: item.location ?? "",
    siteId: item.siteId ?? "",
    requester: item.requester ?? "",
    contact: "",
    category: item.category ?? "",
    engineer: item.engineer ?? "",
    tier: item.tier ?? 0,
    priority: item.priority ?? "",
    stage: "Incoming",
    status: item.status ?? "",
    contractor: item.contractor,
    /*
     * A `BoardItem` carries the contractor's NAME and not the reference, so
     * there is nothing truthful to put here. Null is the honest answer rather
     * than a gap: every consumer of this shape treats a missing reference as
     * "match by name", which is exactly what a board row can support and
     * exactly what these rows did before the column existed.
     */
    contractorId: null,
    assignee: item.assignee,
    /* `requestedAt` is the one non-null date on the request. An item with none
       gets the empty string, which `calendarDay` rejects like any other
       unparseable value — so the row simply carries no Date Requested event. */
    requestedAt: item.requestedAt ?? "",
    dueAt: item.dueAt,
    completedAt: item.completedAt,
    nextUpdateAt: item.nextUpdateAt,
    cost: item.cost,
    attachmentCount: item.attachmentCount ?? 0,
    commentCount: item.commentCount ?? 0,
  }));
}

/**
 * THE TAB STRIP FOLLOWS THE ACTIVE TAB.
 *
 * Written here for the same reason `viewReplacesGrid` is, and the reason this
 * whole file exists: `board-chrome.tsx` has a hard 500-line limit and this
 * needed its explanation more than it needed to be in that file. What it does
 * and when it runs is unchanged by living next door.
 *
 * THE FAULT. The strip holds eleven tabs and scrolls sideways. On a phone it
 * shows two of them: measured at 320–430px the strip's `clientWidth` is
 * 218–328 against a `scrollWidth` of 1285, so only Form and Main table are in
 * the box (only Form at 320). Calendar sits at x 444–545 — five tabs past the
 * right edge. Nothing ever moved the strip, so `scrollLeft` stayed 0 no matter
 * which tab was current, and two things followed:
 *
 *   • Landing on a view you did not click — `?view=calendar` from a shared
 *     link, or the remembered landing view from `board-view-memory.ts` —
 *     showed a reader "Form | Main table" with NEITHER marked current, and the
 *     calendar drawn underneath. The tab saying where you are was 398px off
 *     screen. A reader being told they are somewhere they cannot see.
 *   • Picking a far tab out of the "All" menu opened it and left the strip
 *     where it was, so the same thing happened the moment you looked up.
 *
 * WHY `scrollLeft` AND NOT `scrollIntoView`. `scrollIntoView` walks EVERY
 * scrollable ancestor and will scroll the page itself sideways to satisfy the
 * request. A board page that shifts horizontally when you change tabs is worse
 * than the problem being fixed, and `calendar-views.tsx` refuses the same call
 * on its week scroller for the same reason. Scrolling the strip's own
 * `scrollLeft` cannot move anything but the strip.
 *
 * Rects rather than `offsetLeft`, because `.board-views__tab` is positioned and
 * the strip sits inside `.board-views__strip`, which is positioned too — which
 * of them ends up the offset parent is a CSS detail this should not depend on.
 * The delta between two `getBoundingClientRect()` reads is the same number in
 * any of those cases.
 *
 * IT ONLY EVER CORRECTS. A tab already inside the box returns early, so a
 * reader who has scrolled the strip by hand is not yanked back on the next
 * render — only an active tab that is genuinely out of sight moves anything.
 *
 * This does not give the strip a visible affordance on touch; `BoardViewsScroll`
 * renders nothing there. It makes the CURRENT tab visible, which is the half
 * that was telling the reader something untrue.
 */
export function useActiveTabInView(
  stripRef: React.RefObject<HTMLDivElement | null>,
  activeKey: string,
) {
  useEffect(() => {
    const strip = stripRef.current;
    const tab = strip?.querySelector<HTMLElement>(".board-views__tab.is-active");
    if (!strip || !tab) return;
    const box = strip.getBoundingClientRect();
    const rect = tab.getBoundingClientRect();
    if (rect.left >= box.left && rect.right <= box.right) return;
    /*
     * ALIGN THE TAB'S START, IN BOTH DIRECTIONS — because the strip is a
     * SNAP CONTAINER. `.board-views__tabs` is `scroll-snap-type: x proximity`
     * and every `.board-views__tab` is `scroll-snap-align: start`, so the only
     * offsets the browser will actually rest at are the ones where some tab
     * begins at the strip's left edge.
     *
     * The obvious arithmetic — for a tab past the right edge, scroll just far
     * enough to bring its right edge in — asks for an offset BETWEEN two snap
     * points, and the browser quietly rounds it to the nearer one. Measured at
     * 430px that landed `scrollLeft` at 194 where 223 was wanted, leaving the
     * Calendar tab 29px past the edge and STILL cut off; calling it a second
     * time changed nothing, because the snap put it back. A correction the
     * scroll container will not hold is not a correction.
     *
     * Asking for the tab's own start IS a snap point, so it is honoured
     * exactly, and it also brings the tabs AFTER the active one into view —
     * which is the direction a reader who has just landed on a far tab wants
     * to look. A tab at the very end simply clamps to the maximum scroll.
     */
    const delta = rect.left - box.left;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    strip.scrollTo({
      left: Math.max(0, strip.scrollLeft + delta),
      behavior: reduced ? "auto" : "smooth",
    });
    // `activeKey` is what changes when a different tab becomes current.
  }, [stripRef, activeKey]);
}

/**
 * Whether opening this tab means the grid goes away — A VIEW TAB IS A SECTION,
 * NOT A BANNER OVER THE GRID.
 *
 * Splitting the pane out of the chrome, above, moved where these branches are
 * WRITTEN. This answers the separate question of what else is on screen while
 * one of them renders, and until it existed the answer was "the whole table,
 * underneath". Form and Fix Tracker were drawn ON TOP OF the board rather than
 * instead of it, and two things followed that a reader sees:
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
 * only the "not built yet" note below — which says in as many words that the
 * table below is still the live board. Hiding it would leave that tab showing
 * nothing at all.
 *
 * `live-board.tsx` calls this with the view `BoardChrome` reports up, and uses
 * the answer to drop the grid, the footer, the mobile cards and the group
 * creator together.
 *
 * ROW 3 — THE TABLE'S TOOLBAR — LEAVES BY THE SAME ANSWER.
 *
 * `board-chrome.tsx` renders its third row only when this returns false. The
 * row holds New item, Search items, People, Newest, Filter, Hide, Board groups
 * and Export, and every one of those verbs acts on the grid. Rendered
 * unconditionally it appeared over the Form, over the Calendar and over every
 * other view: a 60px band of buttons that filter and export a table which is
 * not on screen, and which a phone has to scroll past before reaching the view
 * it asked for. It is REMOVED rather than hidden — an empty
 * `.board-chrome__toolbar` is still a flex row with a gap and a 44px button in
 * it, so `visibility` would have left exactly the blank band being removed.
 *
 * The unbuilt exception carries straight over and is the reason this is the
 * right test rather than `type !== "table"`: an unbuilt view keeps the grid on
 * purpose, so it keeps the toolbar that drives it.
 *
 * One consequence worth naming, because it is a trap the chrome has to dodge:
 * the collapse chevron lives inside that row and is the only control that
 * un-hides `.board-header` and `.board-views`. A reader who collapses the
 * header on Main table and then opens Calendar would be left with no header,
 * no tab strip and no way back to either. The chrome answers by remembering
 * the collapsed flag but applying it only while row 3 is drawn.
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
  calendar,
}: Props) {
  /* Memoised because `buildCalendarEvents` keys off the array identity: a fresh
     adapted array on every render would rebuild every event on every keystroke
     in the board above. When the host passes `requests` this is a pass-through
     and adapts nothing. */
  const calendarRequests = useMemo(
    () => calendar?.requests ?? boardItemsAsRequests(items),
    [calendar?.requests, items],
  );

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
      {/*
        ONE CALENDAR, NOT TWO.

        This tab used to draw `CalendarView` from `views/board-views.tsx`: a
        bare month grid with a month stepper, keyed on Date Requested, with no
        view switcher, no date sources, no filters, no colours and no way to
        change a date. The real calendar was built on the Planned page, and the
        owner went looking for it HERE — which is where a person who thinks "I
        want to see this board as a calendar" actually goes. Two calendars, and
        the one with the features was not the one being opened.

        `OperationsCalendarPanel` is that calendar, extracted so both surfaces
        mount the same component — see the note at the top of
        `calendar-surface.tsx`. It owns all of its own state; what it takes from
        here is the records, already scoped to this board, and the write paths.

        Keyed on the TYPE, not on `activeView.key`, so a second calendar view
        added through the "+" menu behaves like the seeded one. That mirrors
        kanban above, where the type is the rule and `fix-tracker` is the one
        named exception.

        `periodWindow` is null: the Planned page has a PeriodPicker above the
        panel and this tab has no such control, so every date the board carries
        is in range. `onShowAllDates` is omitted for the same reason — there is
        no host range to clear.
      */}
      {activeView.type === "calendar" && (
        <OperationsCalendarPanel
          requests={calendarRequests}
          complianceRecords={calendar?.complianceRecords ?? []}
          periodWindow={null}
          onOpenRequest={(request) => calendar?.onOpenRequest?.(request)}
          onOpenCompliance={(id) => calendar?.onOpenCompliance?.(id)}
          onNotify={(message) => calendar?.onNotify?.(message)}
          onJobDateChange={calendar?.onJobDateChange ?? NO_DATE_WRITER}
          onComplianceDateChange={
            calendar?.onComplianceDateChange ?? NO_DATE_WRITER
          }
        />
      )}
      {activeView.type === "chart" && <ChartView items={items} palette={palette} />}
      {activeView.type === "gallery" && (
        <GalleryView items={items} onOpen={onOpenItem} />
      )}
      {activeView.type === "reports" && <ReportsView items={items} />}
      {/*
        The Form tab is the live form wrapped in monday's builder chrome. The
        builder draws `FormView` itself for the view and preview modes, so the
        questions are unchanged — what is added is the toolbar above them, and
        that toolbar is hidden below 768px so a phone gets the form alone.
      */}
      {activeView.type === "form" && <FormBuilder onSubmitted={onFormSubmitted} />}
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
