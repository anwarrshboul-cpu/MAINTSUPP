"use client";

/**
 * Fix Tracker — the Maintenance Engineer Dashboard.
 *
 * Monday's Fix Tracker is not a board view, it is a small app built on top of
 * the board, and the difference matters: the board is for whoever coordinates,
 * this is for whoever is standing in the shop. The Fix Tracker tab used to
 * render a generic kanban, which shows the same rows in columns and answers
 * none of the questions an engineer actually has.
 *
 * The screen it replaces has:
 *
 *  - two tabs, Incoming Requests and Jobs Booked, because those are the two
 *    states an engineer cares about;
 *  - a description search and a location filter, because an engineer looks for
 *    "the shutter at Aldgate", not a reference number;
 *  - cards showing location, trade, priority and status at a glance;
 *  - a detail panel with the issue photographs, a copyable link, an upload for
 *    the completed-work photograph, a completion date, and comments.
 *
 * Everything writes through the existing endpoints — `/api/maintenance` for the
 * date and comments, `/api/files` for the photographs — so a change made here
 * is the same change made on the board.
 *
 * ── What the owner's review of the live screen changed ───────────────────────
 *
 * Four of these were wrong against the real data, not merely plain:
 *
 *  1. The card headline was `item.title`. On this estate `title` is monday's
 *     Name column, and the import filled it with the SOURCE of the row: 421
 *     rows read "Incoming form answer" and 168 read "Manual". So the largest,
 *     highest-contrast word on every card was one of two words, repeated down
 *     the grid, while the description — the only text that says what is broken
 *     — was `--muted` 13px underneath it. The two have swapped places; the
 *     source label is kept, as a tag, because it does distinguish a portal
 *     submission from something typed in by hand.
 *
 *  2. Cards showed "Requested: 07/08/2026" and nothing else about time. A date
 *     is not an age: 197 of the open jobs on this board were raised more than
 *     six months ago and they looked exactly like the ones raised yesterday.
 *     `requestedAt`, `dueAt` and `completedAt` are all on the item, so the card
 *     now says how old the job is and whether its due date has passed.
 *
 *  3. The tabs disagreed with the board — see `jobState` below.
 *
 *  4. "Issue Pictures" was empty on every one of the 717 jobs that have
 *     photographs, and the panel loaded full-size originals when it did draw
 *     one — see `photoSlot` and `PictureGrid` below.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../../components";
import { chipStyle as sharedChipStyle } from "../chip-ink";
import { uploadEvidenceFile } from "../../../lib/client-upload";
import { type BoardItem, formatDate } from "./view-model";
import { MediaViewer } from "../media-viewer";
import "./fix-tracker.css";

type Palette = Record<string, string>;

type Attachment = {
  id: string;
  kind: string;
  /**
   * Which board file column the attachment hangs in. `attachmentPayload` in
   * app/api/files/route.ts has always sent it; this view never read it, which
   * is the whole of bug 4. See `photoSlot`.
   */
  boardColumnId: string | null;
  originalName: string;
  contentType: string;
  inlineUrl: string;
  /*
   * All three come from `attachmentPayload` and always have. They are named
   * here because the viewer prints the size and the date under the filename,
   * and offers a download — a photograph opened from this screen should behave
   * exactly as one opened from the board.
   */
  byteSize: number;
  createdAt: string;
  downloadUrl: string;
};

/**
 * A label safe to put on a chip.
 *
 * 22 rows on this board have the literal string "[object Object]" in
 * `priority` — the monday import stringified an object into the column — and
 * the card rendered it, in a coloured pill, to somebody standing in a shop.
 * There is nothing this view can do to recover the real value, so it is
 * treated exactly as a missing one: the chip is omitted and the panel reads
 * "—". The rows are findable with
 *   SELECT id FROM maintenance_requests WHERE priority = '[object Object]';
 * and the fix belongs in the importer, not here.
 */
function chipLabel(value: string | null | undefined) {
  const text = (value ?? "").trim();
  if (!text || text === "[object Object]" || text === "undefined") return null;
  return text;
}

/* The second copy of the brightness test; see the note in board-views.tsx. */
function chipStyle(palette: Palette, value: string | null) {
  return sharedChipStyle((value && palette[value]) || "#c4c4c4");
}

/* ── Which tab a job belongs in ─────────────────────────────────────────────
 *
 * `stage` is the board's own grouping — the column behind the "Incoming
 * requests", "Jobs Booked", "Needs attention" and "… Recently completed"
 * groups. This used to guess from the status TEXT instead, matching any status
 * containing "scheduled", "in progress", "completed" or "booked", and the guess
 * was wrong in both directions on the live data:
 *
 *   - the nine jobs the board holds in its "Jobs Booked" group carry the
 *     statuses "Waiting for payment" (5), "Waiting for decisions" (3) and
 *     "Blocked - Awaiting Response" (1). Not one contains any of those four
 *     words, so every genuinely booked job was filed under Incoming Requests;
 *   - 671 jobs carry the status "Job Completed", which contains "completed", so
 *     the Jobs Booked tab rendered 672 cards, 671 of them finished work.
 *
 * The board's "Jobs Booked" group and `stage = "Booked"` are an exact 1:1 match
 * on this database — 9 rows, the same 9 — so keying off `stage` is what makes
 * the tab agree with the group it is named after. The counts are now printed on
 * the tabs so the next disagreement is visible without a SQL prompt.
 *
 * Finished work still needs somewhere to live, so "Completed" is added as a
 * third tab rather than left folded into "Jobs Booked" where it drowned the
 * booked jobs 75:1. Nothing is removed: both original tabs remain, and now hold
 * what their names claim.
 *
 * `stage` is not declared on `BoardItem`. The board hands these views
 * `MaintenanceRequest` objects straight through and the type has drifted behind
 * the payload — exactly the drift the `location`/`description`/`requester`
 * comment in view-model.ts describes — and view-model.ts is not this change's
 * to edit, so it is read defensively here. The old status heuristic stays as
 * the fallback for any caller that really does pass a stage-less item.
 */
type JobState = "incoming" | "booked" | "completed";

function jobState(item: BoardItem): JobState {
  const stage = (item as { stage?: string | null }).stage;
  if (typeof stage === "string" && stage.trim()) {
    const key = stage.trim().toLowerCase();
    if (key === "booked") return "booked";
    if (key === "completed") return "completed";
    // "Incoming" and "Attention" both mean outstanding work an engineer has not
    // been booked onto, which is what the Incoming Requests tab is for.
    return "incoming";
  }
  const status = (item.status ?? "").toLowerCase();
  if (status.includes("completed")) return "completed";
  if (
    status.includes("scheduled") ||
    status.includes("in progress") ||
    status.includes("booked")
  ) {
    return "booked";
  }
  return "incoming";
}

/** Kept for callers and tests that ask the original question. */
export function isBooked(item: BoardItem) {
  return jobState(item) === "booked";
}

/* ── Which photo column an attachment sits in ───────────────────────────────
 *
 * `kind` alone is the wrong thing to ask, and asking it alone is why the panel
 * said "No pictures were attached to this request" on all 717 jobs that have
 * photographs. When this was written, every one of the 2,915 imported
 * attachments carried `kind = "general"` — the monday import put the real
 * classification in `board_column_id` ("…-issuePictures", 1,149 rows;
 * "…-completedPictures", 1,616; "…-files", 55) and left `kind` at its default —
 * so `kind === "issue"` matched exactly zero rows, board-wide.
 *
 * Both are consulted rather than swapping one guess for another. `kind` is what
 * a fresh upload through `/api/files` sets, including the completion picture
 * this panel uploads; the column is what the import sets and what the board's
 * own file cells read; a job can carry some of each; and a backfill that
 * repairs one of the two must not be a prerequisite for this screen working.
 *
 * The column id is matched by SUFFIX because its prefix is the seeded
 * organisation and board — `seed-<org>-maintenance-issuePictures` — and this
 * view is handed items, not the board's column list, so it cannot resolve the
 * full id without a second round trip it does not need.
 */
function photoSlot(file: Attachment): "issue" | "completion" | "other" {
  const column = file.boardColumnId ?? "";
  if (file.kind === "issue" || column.endsWith("issuePictures")) return "issue";
  if (file.kind === "completion" || column.endsWith("completedPictures")) {
    return "completion";
  }
  return "other";
}

const isImage = (file: Attachment) => file.contentType.startsWith("image/");

/**
 * Tell the rest of the screen that a write happened.
 *
 * `onChanged` is the prop this view was given for the purpose and board-chrome
 * wires it to `onFormSubmitted` — which live-board does not pass. So it is
 * `undefined` in the only place the Fix Tracker is actually rendered, and a
 * completion date saved here, a comment added here or a photograph uploaded
 * here changed the database and nothing else: the grid behind the panel kept
 * its old counts until somebody reloaded the page.
 *
 * `maintsupp:refresh-board` is the convention the rest of the app already uses
 * for exactly this. portal-app.tsx fires it after saving a comment, with the
 * comment "the board holds the count, so both are told rather than left to
 * guess"; live-board.tsx listens for it and re-fetches the board; so does the
 * Store Documentation board. Firing it here as well costs nothing once the
 * callback is supplied, and is the difference between a saved change appearing
 * and not appearing today.
 *
 * The fix at the source is one line in live-board.tsx, which this change does
 * not own:
 *
 *     <BoardChrome
 *       boardId={boardId}
 *   +   onFormSubmitted={() => window.dispatchEvent(new Event("maintsupp:refresh-board"))}
 */
function announceChange(onChanged?: () => void) {
  onChanged?.();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("maintsupp:refresh-board"));
  }
}

/**
 * Attachment lookups, shared and cached for the life of the page.
 *
 * The card thumbnails and the panel gallery both read `/api/files`, cards come
 * and go as the engineer switches tab and retypes the search, and the Completed
 * tab alone is 673 cards. Keying the in-flight promise means a job is fetched
 * once however many times it is drawn, and scrolling back up costs nothing.
 */
const attachmentCache = new Map<string, Promise<Attachment[]>>();

function loadAttachments(requestId: string, limit: number) {
  const key = `${requestId}:${limit}`;
  let pending = attachmentCache.get(key);
  if (!pending) {
    pending = fetch(
      `/api/files?requestId=${encodeURIComponent(requestId)}&limit=${limit}`,
    )
      .then((response) => response.json())
      .then(
        (payload: { files?: Attachment[]; attachments?: Attachment[] }) =>
          payload.files ?? payload.attachments ?? [],
      )
      .catch(() => {
        // A failed lookup must not be cached as "this job has no photographs".
        attachmentCache.delete(key);
        return [] as Attachment[];
      });
    attachmentCache.set(key, pending);
  }
  return pending;
}

/* ── Age and overdue ────────────────────────────────────────────────────────
 *
 * Dates arrive as plain `YYYY-MM-DD` from the import, which `Date` parses at
 * UTC midnight, so the arithmetic is done in UTC days. Doing it in local time
 * would put a job raised today at "1 day ago" for anyone west of Greenwich, and
 * this is a screen where "today" versus "yesterday" is the point.
 */
const DAY_MS = 86_400_000;

function utcDay(value: string | null | undefined) {
  if (!value) return null;
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return null;
  return Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate());
}

function todayUtc() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** Whole days between two UTC midnights. Negative means the date has passed. */
function daysBetween(from: number, to: number) {
  return Math.round((to - from) / DAY_MS);
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * "3 days", "5 weeks", "8 months" — the coarsest unit that still reads true.
 *
 * Days up to a fortnight because that is the window an engineer plans in;
 * weeks up to about three months; months beyond that, where the exact figure
 * has stopped mattering and only the order of magnitude has not.
 */
function humanDays(days: number) {
  if (days < 14) return plural(days, "day");
  if (days < 90) return plural(Math.round(days / 7), "week");
  return plural(Math.round(days / 30), "month");
}

type Timing = {
  ageDays: number | null;
  /** Days until the due date. Negative means overdue. */
  dueDays: number | null;
  overdue: boolean;
  /** Open, no due date, and older than a month — nobody has looked at it. */
  stale: boolean;
  ageLabel: string;
  dueLabel: string | null;
};

function timingOf(item: BoardItem, now: number): Timing {
  const requested = utcDay(item.requestedAt);
  const due = utcDay(item.dueAt);
  const completed = utcDay(item.completedAt);
  const ageDays = requested === null ? null : daysBetween(requested, now);
  const dueDays = due === null ? null : daysBetween(now, due);

  /*
   * Finished work is never late, whatever its dates say.
   *
   * `completedAt` alone is not enough to decide that: 187 of the 673 jobs the
   * board has in its Completed groups have no completion date recorded, and
   * judging by the date alone put "Overdue by 41 months" in red on jobs whose
   * status is "Job Completed". The stage is the fact; the date is the
   * paperwork.
   */
  const done = completed !== null || jobState(item) === "completed";
  const overdue = !done && dueDays !== null && dueDays < 0;
  const stale = !done && due === null && ageDays !== null && ageDays >= 30;

  let ageLabel: string;
  if (ageDays === null) ageLabel = "No request date";
  else if (ageDays <= 0) ageLabel = "Raised today";
  else if (ageDays === 1) ageLabel = "Raised yesterday";
  else ageLabel = `Raised ${humanDays(ageDays)} ago`;

  let dueLabel: string | null = null;
  if (done) {
    dueLabel =
      completed === null ? "Completed" : `Completed ${formatDate(item.completedAt)}`;
  } else if (dueDays === null) {
    dueLabel = null;
  } else if (dueDays < 0) {
    dueLabel = `Overdue by ${humanDays(-dueDays)}`;
  } else if (dueDays === 0) {
    dueLabel = "Due today";
  } else {
    dueLabel = `Due in ${humanDays(dueDays)}`;
  }

  return { ageDays, dueDays, overdue, stale, ageLabel, dueLabel };
}

/**
 * Triage order: what is late, then what is nearly late, then what is oldest.
 *
 * This is the default because the dashboard exists to answer "what do I do
 * next", and board order answers "where did the coordinator put it". Board
 * order stays available in the sort control for anyone cross-checking against
 * the grid.
 */
const SORTS = [
  { key: "urgency", label: "Most urgent first" },
  { key: "oldest", label: "Oldest first" },
  { key: "newest", label: "Newest first" },
  { key: "board", label: "Board order" },
] as const;

type SortKey = (typeof SORTS)[number]["key"];

function sortCards(items: BoardItem[], sort: SortKey, now: number) {
  if (sort === "board") return items;
  const decorated = items.map((item, index) => ({
    item,
    index,
    timing: timingOf(item, now),
  }));
  decorated.sort((a, b) => {
    if (sort === "urgency") {
      if (a.timing.overdue !== b.timing.overdue) return a.timing.overdue ? -1 : 1;
      const aDue = a.timing.dueDays;
      const bDue = b.timing.dueDays;
      // A job with a due date outranks one without: somebody has committed to a
      // date on it. Among those without, age breaks the tie below.
      if (aDue !== null && bDue !== null && aDue !== bDue) return aDue - bDue;
      if (aDue !== null && bDue === null) return -1;
      if (aDue === null && bDue !== null) return 1;
    }
    const aAge = a.timing.ageDays;
    const bAge = b.timing.ageDays;
    // A missing request date sorts last rather than as "infinitely old" — it is
    // unknown, not urgent.
    if (aAge === null && bAge === null) return a.index - b.index;
    if (aAge === null) return 1;
    if (bAge === null) return -1;
    if (aAge !== bAge) return sort === "newest" ? aAge - bAge : bAge - aAge;
    return a.index - b.index;
  });
  return decorated.map((entry) => entry.item);
}

const TABS: Array<{ key: JobState; label: string; empty: string }> = [
  {
    key: "incoming",
    label: "Incoming Requests",
    empty: "No incoming requests match this search.",
  },
  {
    key: "booked",
    label: "Jobs Booked",
    empty: "No booked jobs match this search.",
  },
  {
    key: "completed",
    label: "Completed",
    empty: "No completed jobs match this search.",
  },
];

export function FixTrackerView({
  items,
  palette,
  onChanged,
}: {
  items: BoardItem[];
  palette: Palette;
  /** Fired after a write, so the board picks the change up. */
  onChanged?: () => void;
}) {
  const [tab, setTab] = useState<JobState>("incoming");
  const [query, setQuery] = useState("");
  const [location, setLocation] = useState("");
  const [sort, setSort] = useState<SortKey>("urgency");

  /*
   * Honour the link the panel's Copy Link button produces.
   *
   * That button has always written `?item=<id>` onto the URL and told the
   * engineer the link was copied, but nothing in the app ever read the
   * parameter back — the contractor who received it landed on the board and had
   * to find the job by hand. Reading it into the initial open id makes the
   * promise true for anyone who opens the link on this tab.
   *
   * Read in the initialiser rather than an effect so it is not a cascading
   * render, and it cannot cause a hydration mismatch: the panel is drawn from
   * `items.find(...)`, and `items` is empty until the board's fetch resolves,
   * which is long after this view is mounted by a click.
   */
  const [openId, setOpenId] = useState<string | null>(() =>
    typeof window === "undefined"
      ? null
      : new URL(window.location.href).searchParams.get("item"),
  );

  /*
   * "Today" is fixed for the life of the mount rather than read per card.
   * Calling `Date.now()` inside the sort comparator makes it non-deterministic
   * across a midnight boundary, and calling it per card makes 673 of them.
   */
  const now = useMemo(() => todayUtc(), []);

  const locations = useMemo(
    () =>
      [...new Set(items.map((item) => item.location || "").filter(Boolean))].sort(),
    [items],
  );

  /*
   * Search and location are applied before the tab split so the tab counts
   * describe the result the engineer is about to see. With both filters clear
   * they are the whole board, which is what makes them checkable against the
   * board's own group counts.
   */
  const matching = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items
      .filter((item) => !location || (item.location ?? "") === location)
      .filter(
        (item) =>
          !needle ||
          // `reference` joins the haystack because a contractor quotes the job
          // number back at you and the box is the only way to find it.
          `${item.description ?? ""} ${item.title} ${item.location ?? ""} ${
            item.reference ?? ""
          }`
            .toLowerCase()
            .includes(needle),
      );
  }, [items, location, query]);

  const counts = useMemo(() => {
    const tally: Record<JobState, number> = { incoming: 0, booked: 0, completed: 0 };
    for (const item of matching) tally[jobState(item)] += 1;
    return tally;
  }, [matching]);

  const visible = useMemo(
    () =>
      sortCards(
        matching.filter((item) => jobState(item) === tab),
        sort,
        now,
      ),
    [matching, now, sort, tab],
  );

  const open = openId ? items.find((item) => item.id === openId) ?? null : null;

  /*
   * Consume the deep link.
   *
   * The id is already in state from the initialiser above; stripping the
   * parameter here stops the address bar advertising a job the engineer has
   * moved on from, and stops a close-and-reopen of the tab reviving it.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("item")) return;
    url.searchParams.delete("item");
    window.history.replaceState({}, "", url.toString());
  }, []);

  const activeTab = TABS.find((entry) => entry.key === tab) ?? TABS[0];

  return (
    <div className="fix-tracker">
      <header className="fix-tracker__head">
        <h3>Maintenance Engineer Dashboard</h3>
      </header>

      <div className="fix-tracker__tabs" role="tablist" aria-label="Job state">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={tab === entry.key}
            className={tab === entry.key ? "is-active" : ""}
            onClick={() => setTab(entry.key)}
          >
            {entry.label}
            <em className="fix-tracker__tab-count">{counts[entry.key]}</em>
          </button>
        ))}
      </div>

      <div className="fix-tracker__filters">
        <label className="fix-tracker__search">
          <Icon name="search" size={17} />
          <input
            type="search"
            value={query}
            placeholder="Search by description…"
            aria-label="Search jobs by description"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="fix-tracker__location">
          <Icon name="filter" size={16} />
          <select
            value={location}
            aria-label="Filter by location"
            onChange={(event) => setLocation(event.target.value)}
          >
            <option value="">All Locations</option>
            {locations.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
        <label className="fix-tracker__sort">
          <Icon name="clock" size={16} />
          <select
            value={sort}
            aria-label="Sort jobs"
            onChange={(event) => setSort(event.target.value as SortKey)}
          >
            {SORTS.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!visible.length ? (
        <p className="view-empty">{activeTab.empty}</p>
      ) : (
        <div className="fix-tracker__cards">
          {visible.map((item) => (
            <FixTrackerCard
              key={item.id}
              item={item}
              palette={palette}
              now={now}
              onOpen={() => setOpenId(item.id)}
            />
          ))}
        </div>
      )}

      {open && (
        <FixTrackerDetail
          item={open}
          palette={palette}
          onClose={() => setOpenId(null)}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}

/**
 * One job card.
 *
 * Reading order is what an engineer needs in the order they need it: what is
 * broken, how urgent, where, how long it has been sitting, what it looks like.
 * The source label ("Manual", "Incoming form answer") is last, as a tag,
 * because it is the least actionable thing on the card and it used to be the
 * headline.
 */
function FixTrackerCard({
  item,
  palette,
  now,
  onOpen,
}: {
  item: BoardItem;
  palette: Palette;
  now: number;
  onOpen: () => void;
}) {
  const timing = timingOf(item, now);
  const priority = chipLabel(item.priority);
  const status = chipLabel(item.status);
  const headline = item.description?.trim() || item.title;
  // Only worth showing when it is not already the headline.
  const source = item.description?.trim() ? item.title : null;
  const photos = item.attachmentCount ?? 0;

  return (
    <button
      type="button"
      className={`fix-tracker__card${timing.overdue ? " is-overdue" : ""}`}
      onClick={onOpen}
    >
      <span className="fix-tracker__card-head">
        <span className="fix-tracker__card-title">{headline}</span>
        {priority && <em style={chipStyle(palette, priority)}>{priority}</em>}
      </span>

      <span className="fix-tracker__card-location">
        <Icon name="map" size={14} />
        {item.location || "No location"}
      </span>

      <span className="fix-tracker__card-timing">
        <span
          className={`fix-tracker__age${timing.stale ? " is-stale" : ""}`}
          title={`Requested ${formatDate(item.requestedAt)}`}
        >
          <Icon name="clock" size={13} />
          {timing.ageLabel}
        </span>
        {timing.dueLabel && (
          <span className={`fix-tracker__due${timing.overdue ? " is-overdue" : ""}`}>
            <Icon name={timing.overdue ? "alert" : "calendar"} size={13} />
            {timing.dueLabel}
          </span>
        )}
      </span>

      <CardPhotos requestId={item.id} count={photos} />

      {/*
        One wrapping row rather than a chip against a right-aligned stack: the
        status chips on this board run to "Quote Received (waiting for
        Approval)", and a two-column footer put the date above the chip as soon
        as one of those landed in a 280px card.
      */}
      <span className="fix-tracker__card-foot">
        {status && <em style={chipStyle(palette, status)}>{status}</em>}
        {source && <span className="fix-tracker__card-source">{source}</span>}
        <span className="fix-tracker__card-requested">
          Requested: {formatDate(item.requestedAt)}
        </span>
      </span>
    </button>
  );
}

/**
 * The photograph strip on a card.
 *
 * The count comes off the item, which costs nothing and is exact: every one of
 * the 775 rows agrees with a live `COUNT(*)` over `attachments`. The three
 * per-kind counters beside it do NOT — `issue_attachment_count` sums to 2,281
 * against 1,149 real issue pictures and `completed_attachment_count` sums to
 * zero against 1,616 — so only the total is trusted here.
 *
 * The thumbnails are fetched, and only for a card that has scrolled into view.
 * `/api/files` answers one job per request; the Completed tab draws 673 cards,
 * and 673 requests fired on mount would flatten a shop phone. An
 * IntersectionObserver keeps it to what is on screen, `loadAttachments` keeps a
 * card that comes back from being re-fetched, and the request asks for six rows
 * rather than the default hundred because four tiles are drawn.
 *
 * `?thumb=1` is not decoration: these are WhatsApp photographs straight off a
 * phone, and the panel below used to load the full-size originals — a dozen of
 * them at once on a job with a dozen pictures.
 */
function CardPhotos({ requestId, count }: { requestId: string; count: number }) {
  const [files, setFiles] = useState<Attachment[] | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!count) return undefined;
    let active = true;
    const load = () => {
      void loadAttachments(requestId, 6).then((rows) => {
        if (active) setFiles(rows);
      });
    };
    const node = anchor.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      load();
      return () => {
        active = false;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          load();
        }
      },
      // A little ahead of the fold, so the tiles are there by the time a
      // scrolling thumb arrives rather than popping in underneath it.
      { rootMargin: "300px" },
    );
    observer.observe(node);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [count, requestId]);

  if (!count) return null;

  // Issue pictures first: on a job with both, the fault is what is being
  // triaged and the completed-work photograph is the answer to a later
  // question.
  const images = (files ?? []).filter(isImage);
  const ordered = [
    ...images.filter((file) => photoSlot(file) === "issue"),
    ...images.filter((file) => photoSlot(file) !== "issue"),
  ].slice(0, 4);

  return (
    <span className="fix-tracker__card-photos" ref={anchor}>
      <span className="fix-tracker__photo-count">
        <Icon name="camera" size={13} />
        {plural(count, "photo")}
      </span>
      {ordered.length > 0 && (
        <span className="fix-tracker__photo-strip">
          {ordered.map((file) => (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              key={file.id}
              src={`${file.inlineUrl}?thumb=1`}
              alt=""
              loading="lazy"
              decoding="async"
            />
          ))}
          {count > ordered.length && (
            <span className="fix-tracker__photo-more">+{count - ordered.length}</span>
          )}
        </span>
      )}
    </span>
  );
}

/**
 * The job panel.
 *
 * Reproduces monday's, including the Copy Link button, which is what an
 * engineer sends to a contractor. The link addresses the job rather than the
 * dashboard, so whoever opens it lands on this panel.
 */
function FixTrackerDetail({
  item,
  palette,
  onClose,
  onChanged,
}: {
  item: BoardItem;
  palette: Palette;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [files, setFiles] = useState<Attachment[]>([]);
  const [completedAt, setCompletedAt] = useState(
    item.completedAt ? item.completedAt.slice(0, 10) : "",
  );
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  /** The minted public ticket URL, cached for this panel opening. */
  const [publicLink, setPublicLink] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const timing = timingOf(item, todayUtc());
  const priority = chipLabel(item.priority);
  const status = chipLabel(item.status);

  useEffect(() => {
    let active = true;
    void loadAttachments(item.id, 100).then((rows) => {
      if (active) setFiles(rows);
    });
    return () => {
      active = false;
    };
  }, [item.id]);

  const issuePictures = files.filter(
    (file) => isImage(file) && photoSlot(file) === "issue",
  );
  const completionPictures = files.filter(
    (file) => isImage(file) && photoSlot(file) === "completion",
  );
  /*
   * Whatever the two galleries did not draw, rather than `photoSlot === "other"`.
   * The picture columns hold video too — the completed-work column on this
   * board carries mp4s — and classifying by column alone dropped them out of
   * both the gallery (not an image) and this list (not "other"), so they were
   * uploaded and then unreachable.
   */
  const inGallery = new Set(
    [...issuePictures, ...completionPictures].map((file) => file.id),
  );
  const otherFiles = files.filter((file) => !inGallery.has(file.id));

  /*
   * Copy Link copies a PUBLIC, READ-ONLY ticket URL.
   *
   * It used to copy `?item=<id>` on the portal's own address — a link that
   * asked whoever received it to sign in, which is exactly what sharing a
   * ticket with a store manager or a landlord must not do. It now mints a
   * "viewer" token on the same infrastructure the contractor links use
   * (/j/:token): no login, no upload, no comment, no completion — the grant
   * itself carries no write rights and the API refuses every POST from it.
   * The registered whitelist still applies: cost, invoices and approvals are
   * never in the payload.
   *
   * Minted once per panel opening and cached, so pressing Copy twice does not
   * fill the links table with one-use tokens.
   */
  const copyLink = async () => {
    setNotice(null);
    try {
      let url = publicLink;
      if (!url) {
        const response = await fetch("/api/board/links", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId: item.id,
            audience: "viewer",
            label: "Fix Tracker share link",
            expiryDays: 30,
          }),
        });
        const payload = (await response.json()) as { url?: string; error?: string };
        if (!response.ok || !payload.url) {
          throw new Error(payload.error || "The share link could not be created.");
        }
        url = payload.url;
        setPublicLink(url);
      }
      await navigator.clipboard.writeText(url);
      setNotice("Public read-only link copied — it opens without a login.");
    } catch (caught) {
      setNotice(
        caught instanceof Error ? caught.message : "The link could not be copied.",
      );
    }
  };

  const saveCompletion = async () => {
    setBusy("date");
    setNotice(null);
    try {
      const response = await fetch("/api/maintenance", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: item.id,
          fields: { completedAt: completedAt || null },
        }),
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error || "The date could not be saved.");
      }
      setNotice("Completion date saved.");
      announceChange(onChanged);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The date could not be saved.");
    } finally {
      setBusy("");
    }
  };

  const submitComment = async () => {
    const note = comment.trim();
    if (!note) return;
    setBusy("comment");
    setNotice(null);
    try {
      const response = await fetch("/api/maintenance", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, note }),
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error || "The comment could not be saved.");
      }
      setComment("");
      setNotice("Comment added.");
      announceChange(onChanged);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "The comment could not be saved.",
      );
    } finally {
      setBusy("");
    }
  };

  const uploadCompleted = async (file: File) => {
    setBusy("upload");
    setNotice(null);
    try {
      await uploadEvidenceFile({ file, requestId: item.id, kind: "completion" });
      setNotice("Completed-work picture uploaded.");
      if (uploadRef.current) uploadRef.current.value = "";
      // The cache would otherwise keep serving the gallery it was primed with,
      // and the picture just uploaded would not appear until a reload.
      attachmentCache.delete(`${item.id}:100`);
      attachmentCache.delete(`${item.id}:6`);
      const rows = await loadAttachments(item.id, 100);
      setFiles(rows);
      announceChange(onChanged);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The upload failed.");
    } finally {
      setBusy("");
    }
  };

  /*
   * Rendered into `document.body`, not where it sits in the tree.
   *
   * `z-index: var(--z-sheet)` is 510 and the job cards behind it are 32, so on
   * paper this panel could not lose — and it did, every time. The overlay is a
   * descendant of `.board-chrome`, which is `position: sticky; z-index: 5`, and
   * that CREATES A STACKING CONTEXT: 510 is then only a rank among the chrome's
   * own children, and the whole chrome — panel included — is painted at 5,
   * underneath the metrics strip. Measured, not guessed: overlay z=510 inside
   * an ancestor at z=5, strip at z=32.
   *
   * Raising the number would not have helped, and neither would lowering the
   * strip; any fix that leaves the panel inside the chrome is one sticky
   * ancestor away from breaking again. A portal removes it from that context
   * altogether, which is what `MobileCellSheet` already does for the same
   * reason.
   */
  return createPortal(
    <div className="fix-tracker__overlay" role="presentation">
      <button
        className="modal-scrim"
        type="button"
        aria-label="Close job"
        onClick={onClose}
      />
      <section
        className="fix-tracker__panel"
        role="dialog"
        aria-modal="true"
        aria-label={item.description?.trim() || item.title}
      >
        <header>
          <div>
            {/*
              The panel led with `item.title` too, so a contractor opening a
              copied link was met with a dialog headed "Manual". The description
              leads; the source label and job id stay underneath it.
            */}
            <h4>{item.description?.trim() || item.title}</h4>
            <small>
              {item.description?.trim() ? `${item.title} · ` : ""}
              Job ID: {item.reference ?? item.id}
            </small>
          </div>
          <button className="secondary-button" type="button" onClick={() => void copyLink()}>
            <Icon name="paperclip" size={15} />
            Copy Link
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="close" size={18} />
          </button>
        </header>

        {(timing.overdue || timing.stale) && (
          <p
            className={`fix-tracker__flag${timing.overdue ? " is-overdue" : ""}`}
            role="status"
          >
            <Icon name="alert" size={15} />
            {timing.overdue
              ? `${timing.dueLabel} — due ${formatDate(item.dueAt)}.`
              : `${timing.ageLabel} with no due date set.`}
          </p>
        )}

        <dl className="fix-tracker__facts">
          <div>
            <dt>Location</dt>
            <dd>{item.location || "—"}</dd>
          </div>
          <div>
            <dt>Engineer Type</dt>
            <dd>{item.engineer || "—"}</dd>
          </div>
          <div>
            <dt>Priority</dt>
            <dd>
              {priority ? (
                <em style={chipStyle(palette, priority)}>{priority}</em>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              {status ? (
                <em style={chipStyle(palette, status)}>{status}</em>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt>Date Requested</dt>
            <dd>
              {formatDate(item.requestedAt)}
              <span className="fix-tracker__fact-note">{timing.ageLabel}</span>
            </dd>
          </div>
          {/*
            Added rather than swapped in: the two dates the card now reasons
            about were readable nowhere on this panel, so an engineer could not
            check the age the card was claiming.
          */}
          <div>
            <dt>Date Due</dt>
            <dd>
              {formatDate(item.dueAt)}
              {timing.dueLabel && (
                <span
                  className={`fix-tracker__fact-note${
                    timing.overdue ? " is-overdue" : ""
                  }`}
                >
                  {timing.dueLabel}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Requested By</dt>
            <dd>{item.requester || "—"}</dd>
          </div>
        </dl>

        <section className="fix-tracker__block">
          <h5>Description</h5>
          <p className="fix-tracker__description">
            {item.description || "No description was given."}
          </p>
        </section>

        <section className="fix-tracker__block">
          <h5>
            <Icon name="camera" size={15} />
            Issue Pictures
            {issuePictures.length > 0 && (
              <em className="fix-tracker__block-count">{issuePictures.length}</em>
            )}
          </h5>
          {issuePictures.length ? (
            <PictureGrid files={issuePictures} />
          ) : (
            <p className="fix-tracker__empty">No pictures were attached to this request.</p>
          )}
        </section>

        {/*
          The completed-work photographs were uploadable here and viewable
          nowhere — 1,616 of them on this board. The section only draws when
          there are some, so a job with none is not given an empty heading.
        */}
        {completionPictures.length > 0 && (
          <section className="fix-tracker__block">
            <h5>
              <Icon name="check" size={15} />
              Completed Work Pictures
              <em className="fix-tracker__block-count">{completionPictures.length}</em>
            </h5>
            <PictureGrid files={completionPictures} />
          </section>
        )}

        {otherFiles.length > 0 && (
          <section className="fix-tracker__block">
            <h5>
              <Icon name="paperclip" size={15} />
              Other Files
              <em className="fix-tracker__block-count">{otherFiles.length}</em>
            </h5>
            <ul className="fix-tracker__files">
              {otherFiles.map((file) => (
                <li key={file.id}>
                  <a href={file.inlineUrl} target="_blank" rel="noreferrer">
                    <Icon name="document" size={14} />
                    {file.originalName}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="fix-tracker__block">
          <h5>
            <Icon name="image" size={15} />
            Upload Completed Work Picture
          </h5>
          <input
            ref={uploadRef}
            type="file"
            accept="image/*"
            disabled={busy === "upload"}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadCompleted(file);
            }}
          />
        </section>

        <section className="fix-tracker__block">
          <h5>
            <Icon name="calendar" size={15} />
            Date Completed
          </h5>
          <div className="fix-tracker__row">
            <input
              type="date"
              value={completedAt}
              aria-label="Date completed"
              onChange={(event) => setCompletedAt(event.target.value)}
            />
            <button
              className="primary-button"
              type="button"
              disabled={busy === "date"}
              onClick={() => void saveCompletion()}
            >
              {busy === "date" ? "Saving…" : "Save"}
            </button>
          </div>
        </section>

        <section className="fix-tracker__block">
          <h5>
            <Icon name="message" size={15} />
            Add Comment
          </h5>
          <textarea
            rows={3}
            value={comment}
            placeholder="Add your comment or notes here…"
            aria-label="Add a comment"
            onChange={(event) => setComment(event.target.value)}
          />
          <button
            className="primary-button"
            type="button"
            disabled={busy === "comment" || !comment.trim()}
            onClick={() => void submitComment()}
          >
            {busy === "comment" ? "Submitting…" : "Submit Comment"}
          </button>
        </section>

        {notice && (
          <p className="fix-tracker__notice" role="status">
            {notice}
          </p>
        )}

        <footer>
          <button className="secondary-button" type="button" onClick={onClose}>
            Close
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

/**
 * A gallery of photographs.
 *
 * The tile is the thumbnail derivative, the link is the original. The panel
 * used to point both at the original, so opening a job with a dozen pictures
 * pulled a dozen full-size camera JPEGs over whatever connection the shop has.
 * `?thumb=1` degrades to the original when no derivative was generated, so a
 * missing thumbnail costs bandwidth rather than a broken tile.
 */
function PictureGrid({ files }: { files: Attachment[] }) {
  /*
   * Opens the viewer, not a browser tab.
   *
   * A raw tab is the browser's image page: no swipe to the next photograph, no
   * zoom that works on a phone, no way back except the back button, and the
   * full-size original pulled over whatever connection the shop has. An
   * engineer standing in front of the fault is exactly the reader who cannot
   * afford any of that.
   */
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="fix-tracker__gallery">
      {files.map((file) => (
        <button
          key={file.id}
          type="button"
          title={file.originalName}
          /* Focused explicitly so closing the viewer returns the ring here —
             Safari does not focus a button on tap by itself. */
          onClick={(event) => {
            event.currentTarget.focus();
            setOpenId(file.id);
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`${file.inlineUrl}?thumb=1`}
            alt={file.originalName}
            loading="lazy"
            decoding="async"
          />
        </button>
      ))}
      {openId && (
        <MediaViewer
          files={files}
          currentId={openId}
          contextLabel="Job photographs"
          onNavigate={setOpenId}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}
