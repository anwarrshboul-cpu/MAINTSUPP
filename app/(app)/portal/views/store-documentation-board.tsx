"use client";

/**
 * Store Documentation UK — the board section and its three view tabs.
 *
 * A thin shell. The grid is the same `LiveMaintenanceBoard` the maintenance
 * board uses, bound to a different board id; the two other tabs are the
 * Compliance Tracker and the renewal Calendar. Nothing here holds board state
 * of its own — that would be a second source of truth for the same rows.
 *
 * The board is EMPTY until the owner's monday export is imported. Every tab
 * therefore has to read well with no data, because that is the state it will
 * first be seen in. Nothing on this board is invented.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { RaiseTicketButton } from "../raise-ticket";
import "./store-documentation-board.css";
import type { MaintenanceRequest } from "../../../lib/types";
import { LiveMaintenanceBoard } from "../live-board";
import {
  StoreComplianceTracker,
  type ComplianceTrackerStore,
} from "./store-compliance-tracker";
import {
  buildComplianceStores,
  buildStoreBoardItems,
  type StoreDocumentationPayload,
} from "./store-documentation-model";
import { StoreExpiryCalendar, type StoreExpiryColumn } from "./store-expiry-calendar";
import type { BoardItem } from "./view-model";

const BOARD_ID = "store-documentation";

const TABS = [
  { key: "table", label: "Main table" },
  { key: "compliance", label: "Compliance Tracker" },
  { key: "calendar", label: "Calendar" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function StoreDocumentationBoard({
  onNotify,
  onOpenApps,
}: {
  onNotify: (message: string) => void;
  onOpenApps: () => void;
}) {
  const [tab, setTab] = useState<TabKey>("table");
  /*
   * The raw payload, kept whole.
   *
   * This used to be `setItems(payload.items ?? [])` — the PLACEMENTS, which
   * carry a group id and a position and nothing else. The Calendar reads
   * `item.cells[columnId]` off each row, found no `cells` on any of the 31
   * placements, and drew "0 renewals" in every month while all 42 expiry dates
   * sat in `payload.cells` in the same response. Holding the payload and
   * joining it below is what makes a row a row.
   */
  const [payload, setPayload] = useState<StoreDocumentationPayload | null>(null);
  const [columns, setColumns] = useState<StoreExpiryColumn[]>([]);
  const [stores, setStores] = useState<MaintenanceRequest[]>([]);

  /*
   * `requests` × `items` × `cells`, joined once for the two tabs that need
   * whole rows. Memoised on the payload rather than rebuilt per render: the
   * Calendar re-sorts and re-buckets everything it is handed, so a fresh array
   * identity on every keystroke elsewhere in the shell would be real work.
   */
  const items: BoardItem[] = useMemo(
    () => (payload ? buildStoreBoardItems(payload) : []),
    [payload],
  );

  /*
   * The same rows again, as the Compliance Tracker's stores.
   *
   * The tab used to fetch `/api/workspace` and matrix the ten seeded `sites`
   * rows against `compliance_documents`, which is a different model of a
   * different estate: ten stores instead of thirty-one, thirty expiry dates
   * monday does not hold, and every `fileCount` zero, so certificates that are
   * attached and downloadable read as "Missing". Its `stores` prop existed for
   * exactly this. The fetch stays as the fallback for callers outside this
   * board.
   */
  const complianceStores: ComplianceTrackerStore[] = useMemo(
    () => (payload ? buildComplianceStores(payload) : []),
    [payload],
  );

  /*
   * The Compliance Tracker and Calendar read the same rows the grid does, so
   * they are loaded once here rather than each tab fetching its own copy —
   * otherwise switching tabs re-requests the board and the two can disagree
   * about what is expired.
   */
  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/board?board=${BOARD_ID}`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) return;
      const board = (await response.json()) as StoreDocumentationPayload;
      setPayload(board);
      setColumns((board.columns ?? []).map(({ id, key }) => ({ id, key })));
      setStores(board.requests ?? []);
    } catch {
      // A failed load leaves the previous rows on screen rather than blanking
      // the board. The tabs' own empty states cover a genuinely empty board.
    }
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- `load` is async, so its
     setState lands after an await, not synchronously in the effect body; the
     rule cannot see through the promise. Fetching the board and subscribing to
     its refresh event is exactly the external-system synchronisation effects
     are for. */
  useEffect(() => {
    void load();
    // The grid dispatches this after a document is attached or removed, so the
    // tracker and calendar pick up the new expiry without a reload.
    window.addEventListener("maintsupp:refresh-board", load);
    return () => window.removeEventListener("maintsupp:refresh-board", load);
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <div className="store-documentation">
      {/*
        The section's own name, because until now it had none of its own.

        The board supplies an `<h1>` inside `.live-board-heading`, but only on
        the Main table tab and only above 760px — globals.css hides that whole
        block below it to give the grid the phone's vertical room. So the
        Compliance Tracker and Calendar tabs had no heading at ANY width, and
        the table tab had none on a phone; the topbar's `.page-identity` was
        the only thing naming the screen, and that no longer ships below 768px.

        One heading covers all three tabs at all widths, and the stylesheet
        stands it down on the one tab-and-width combination where the board is
        already saying it.
      */}
      <h1 className="store-documentation__title">Store Documentation UK</h1>
      {/*
        Outside the tab strip, so it stays put as the tabs change: a missing
        certificate is noticed on the grid, in the tracker and on the calendar
        alike, and it is the same ticket from all three.
      */}
      <div className="store-documentation__actions">
        <RaiseTicketButton
          context={{ section: "Store Documentation" }}
          onRaised={(ticket) =>
            onNotify(`${ticket.reference ?? ticket.title} raised for ${ticket.siteName}.`)
          }
          onNotify={onNotify}
        />
      </div>
      <div className="store-documentation__tabs" role="tablist" aria-label="Store Documentation views">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            id={`sd-tab-${entry.key}`}
            aria-selected={tab === entry.key}
            aria-controls={`sd-panel-${entry.key}`}
            tabIndex={tab === entry.key ? 0 : -1}
            className={tab === entry.key ? "is-active" : ""}
            onClick={() => setTab(entry.key)}
            onKeyDown={(event) => {
              const index = TABS.findIndex((item) => item.key === tab);
              let next = index;
              if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
              else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = TABS.length - 1;
              else return;
              event.preventDefault();
              setTab(TABS[next].key);
              /*
               * Focus has to follow the selection. With a roving tabindex the
               * newly selected tab becomes the only tab stop, so leaving focus
               * on the old button strands a keyboard user: the next Tab press
               * jumps out of the tablist entirely and the arrow keys stop
               * working, with nothing on screen explaining why.
               */
              const tablist = event.currentTarget.parentElement;
              tablist
                ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                [next]?.focus();
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div
        className="store-documentation__panel"
        role="tabpanel"
        id={`sd-panel-${tab}`}
        aria-labelledby={`sd-tab-${tab}`}
        tabIndex={-1}
      >
        {tab === "table" && (
          /*
           * The stores come from the board API alongside the columns, groups
           * and cells, so the grid and the two other tabs read one payload and
           * cannot disagree. Nothing is fabricated to fill the sheet: an empty
           * `requests` is an empty board, which is the honest state before the
           * monday export lands.
           */
          <LiveMaintenanceBoard
            boardId={BOARD_ID}
            requests={stores}
            onCreateDetailed={() => onNotify("Add stores by importing the monday export.")}
            onOpenRequest={() => {}}
            onRequestChange={() => void load()}
            onRequestCreated={() => void load()}
            onRequestsDeleted={() => void load()}
            onNotify={onNotify}
            onOpenApps={onOpenApps}
          />
        )}

        {tab === "compliance" &&
          /*
           * `stores` is only handed over once the board has answered. Handing
           * `undefined` in the meantime would send the tracker back to
           * `/api/workspace` — the wrong estate — for as long as the board
           * request is in flight, and handing `[]` would draw the "no stores
           * have been imported yet" empty state over a board that has 31.
           */
          (payload ? (
            <StoreComplianceTracker stores={complianceStores} />
          ) : (
            <p className="view-empty">Loading the compliance register…</p>
          ))}

        {tab === "calendar" && <StoreExpiryCalendar items={items} columns={columns} />}
      </div>
    </div>
  );
}
