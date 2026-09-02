"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../../components";
import { RegisterColumnsPanel } from "./register/register-columns-panel";
import {
  RegisterError,
  addRegisterColumn,
  fetchRegister,
  hiddenColumns,
  orderAfterMove,
  pinRegisterColumn,
  pinnedColumn,
  registerCellValue,
  removeRegisterColumn,
  renameRegisterColumn,
  reorderRegisterColumns,
  resizeRegisterColumn,
  restoreRegisterColumn,
  setRegisterColumnHidden,
  visibleColumns,
  writeRegisterCell,
  type RegisterColumn,
  type RegisterSnapshot,
} from "./register/register-client";

/**
 * W06-11 — THE CONTRACTORS REGISTER, configurable.
 *
 * The criterion asks for the same five things the Sites register got: reorder,
 * rename, show and hide, resize, and add a column of your own. This mounts the
 * shared engine — `/api/registers?register=contractors`, `register-client.ts` —
 * on the Contractors page. There is no second implementation and no second idea
 * of what a column is; the discriminator is the register key and that is all.
 *
 * ── THE ONE RULE THIS COMPONENT EXISTS TO OBEY ───────────────────────────
 *
 * Every cell goes through `registerCellValue(column, row, snap.values, row.id)`.
 * A NATIVE column's value lives on the contractor row and a CUSTOM column's
 * lives in `snap.values`; the two are drawn side by side and look identical, so
 * a grid that reaches into `values` for all of them renders all twenty-five
 * native columns BLANK — which reads as missing data rather than as a bug.
 * `registerCellValue` is the only reader here, and it is called in exactly one
 * place below.
 *
 * ── WHAT REPLACED THE OLD TABLE, AND WHY ─────────────────────────────────
 *
 * The Contractors page drew a fixed eleven-column table, and a comment beside
 * its `<thead>` argued against a twelfth on the grounds that the table already
 * scrolls sideways from 1440 down. That reasoning was right about a HARD-CODED
 * column and does not survive this: the answer to "the table is too wide" is
 * that the reader decides which columns are on it, which is exactly what this
 * provides. The eleven columns are still available — nine are native columns of
 * the register and the two computed ones (assigned/completed work, and the
 * performance figures) stay on the page above, where they belong, because they
 * are period-scoped measurements and not fields on a contractor.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────
 *
 * A native cell is not editable in this grid. `writeRegisterCell` refuses one
 * in the browser rather than making the round trip, because a native value
 * belongs to the contractor and is written through `PATCH /api/workspace`,
 * where its validation, its name-uniqueness rule and its audit line already
 * live. Writing it here would put a second copy in `register_values` and the
 * two would disagree the moment anybody used the ordinary editor. "Manage
 * contractors" is the way in, and the cell says so.
 *
 * ── ONE FROZEN LANE, AND THE READER DECIDES WHETHER IT IS FROZEN ─────────
 *
 * THE IDENTITY LANE — who the contractor is and how to reach them — is the
 * `name` register column drawn as the row's first cell. It exists because the
 * register let an operator hide that column, and the live register did exactly
 * that, leaving rows of rates and postcodes with no name anywhere on them.
 *
 * WHAT IS PINNED IS A COLUMN, NOT A LANE INVENTED BESIDE ONE. The pin lives in
 * `register_columns.settings` as `{"pinned": true}`, at most one per register,
 * and pinning implies visible — see `frozenRegisterColumn` below. So there is
 * one place a column's identity, order, title and width are recorded, and
 * "frozen" is one more property of the column rather than a second idea of what
 * a column is. A pinned column is drawn ONCE, as the lane, and is not also in
 * the scrolling set: the previous version drew the lane beside a `name` column
 * that was still on the table, and the live register printed the contractor's
 * name twice on every row.
 *
 * UNPINNED, it is an ordinary column: no sticky, no reserved offset, no
 * shadow, and it takes its configured position among the others. The only
 * thing that survives is the identity RENDERING — the name, the archived badge
 * and the actionable phone/WhatsApp/email travel with the column wherever it
 * goes, and are drawn in exactly one place either way.
 *
 * THE ACTION LANE IS GONE. It was a second frozen lane at the right carrying a
 * chevron and a pencil, permanently occupying eighty-six pixels of a table the
 * owner already found too wide, to offer a press the whole row now answers and
 * an editor the profile drawer now carries. Deleting it is the point: there is
 * no permanent actions column on this table.
 *
 * The frozen lane is OPAQUE and above the scrolling cells — see
 * `.contractor-register__lane` in `globals.css`. A translucent sticky cell
 * shows the rows sliding underneath it, which reads as a rendering fault.
 */

/** The contractor rows this grid draws. Native values are read off these. */
export type RegisterEntityRow = { id: string; name: string };

/**
 * A column the register does not own — and cannot.
 *
 * The Contractors page carries five figures per row (assigned, completed,
 * completion rate, open urgent, tracked spend) that are NOT fields on a
 * contractor: they are counts over the jobs inside the page's reporting
 * period, and they change when the period picker moves. A register column is a
 * view onto a stored value, so there is nothing for one of these to be a view
 * OF — seeding them as native columns would put a measurement in a catalogue of
 * facts, and `PATCH /api/registers/values` would then be asked to write one.
 *
 * So they are drawn beside the register rather than inside it: fixed, always
 * last, never reorderable, never hideable, and labelled with the window they
 * were measured over on the page above.
 */
export type ExtraColumn<Row> = {
  key: string;
  title: string;
  render: (row: Row) => React.ReactNode;
};

/**
 * ONE ORDERED DEFINITION OF WHAT IS ON THE TABLE, drawn twice.
 *
 * `<thead>` and `<tbody>` map the SAME array. That is not tidiness: a header
 * loop over one list beside a cell loop over another is a table whose labels
 * stop matching its values the first time anything is reordered, hidden or
 * pinned, and nothing about it fails — the figures simply appear under the
 * wrong headings, which is the one rendering fault a reader will believe. The
 * order is decided once, in `gridLanes`, and both loops are a `.map` over it.
 *
 * `frozen` is what makes a lane sticky. `column` is set for a register column
 * and `extra` for one of the page's period-scoped figures; `identity` says the
 * cell draws the name, the archived badge and the actionable contact block
 * rather than a stored value, and travels with the identity column whether it
 * is the frozen lane or an ordinary cell somewhere in the middle.
 */
type GridLane<Row> = {
  key: string;
  title: string;
  frozen: boolean;
  column: RegisterColumn | null;
  extra: ExtraColumn<Row> | null;
  identity: boolean;
};

/**
 * The lanes of one render, in the order they are drawn.
 *
 * THE FROZEN COLUMN IS REMOVED FROM THE SCROLLING SET rather than drawn beside
 * it. A lane and a column carrying the same value is the contractor's name
 * printed twice on every row, which is what the live register did.
 *
 * THE MEASUREMENTS TRAIL THE REGISTER'S OWN COLUMNS. They are not register
 * columns — `register-catalogue.ts` says why — so nothing records a position
 * for them and the page's declaration order is the only order there is. It is
 * read from ONE array here rather than written into the JSX twice.
 *
 * THE IDENTITY IS NEVER ABSENT. If the identity column is neither the frozen
 * lane nor in the visible set, its rendering is put back at the front as an
 * ordinary (unfrozen) cell: a row that does not say whose row it is was the
 * defect this lane was built for, and unpinning must not be a way back to it.
 */
function gridLanes<Row>(
  scrolling: readonly RegisterColumn[],
  frozen: RegisterColumn | null,
  identity: RegisterColumn | null,
  extras: readonly ExtraColumn<Row>[],
  /*
   * EVERY COLUMN THE REGISTER HOLDS, hidden ones included — and it has to be
   * every one, not the visible run. The fallback below draws a measurement the
   * register has no ROW for; "no row" and "not on the table" are different
   * facts, and reading the second for the first is what made hiding a
   * measurement move it to the end of the row instead of taking it off.
   * Measured: hiding "Assigned" left thirty headers with Assigned last.
   */
  known: readonly RegisterColumn[],
): GridLane<Row>[] {
  const laneOf = (column: RegisterColumn, isFrozen: boolean): GridLane<Row> => ({
    key: `column:${column.key}`,
    title: column.title,
    frozen: isFrozen,
    column,
    extra: extraByKey.get(column.key) ?? null,
    identity: identity !== null && column.id === identity.id,
  });

  /*
   * A MEASUREMENT IS A COLUMN THAT KNOWS HOW TO DRAW ITSELF.
   *
   * The six counts are declared in `register-catalogue.ts`, so they arrive here
   * as ordinary register columns carrying an order the operator chose. What
   * they do not carry is a value: the number lives on the row this page loaded,
   * and the `extraColumns` entry keyed the same way is what turns it into "0%"
   * or "£0". Pairing them by key is what lets ONE ordered list drive both — the
   * alternative, a configurable list beside a hardcoded tail, is exactly the
   * two-orders problem this function exists to refuse.
   */
  const extraByKey = new Map(extras.map((extra) => [extra.key, extra]));

  const lanes: GridLane<Row>[] = [];
  if (frozen) lanes.push(laneOf(frozen, true));
  for (const column of scrolling) lanes.push(laneOf(column, false));
  /*
   * Only measurements with NO column of their own are appended. On a register
   * seeded before the catalogue declared them there is briefly no row — and a
   * reader who lost their figures because a migration had not run yet would be
   * right to call that a regression, so the page keeps drawing them until the
   * reconcile in `loadRegisterColumns` catches up on the next read.
   *
   * ASKED OF `known` AND NOT OF `scrolling`, and the difference is a defect
   * report. `scrolling` is what is ON THE TABLE, so a measurement the operator
   * had just UNTICKED fell out of it and was immediately re-appended here — the
   * press moved the column to the end of the row rather than taking it off, and
   * a second press could not help because the state it was reading had already
   * changed. `known` is every column the register holds, hidden ones included,
   * so this fires only when there is genuinely no row to configure.
   */
  for (const extra of extras) {
    if (known.some((column) => column.key === extra.key)) continue;
    lanes.push({
      key: `extra:${extra.key}`,
      title: extra.title,
      frozen: false,
      column: null,
      extra,
      identity: false,
    });
  }
  if (!lanes.some((lane) => lane.identity)) {
    lanes.splice(frozen ? 1 : 0, 0, {
      key: "identity",
      title: identity?.title ?? "Contractor",
      frozen: false,
      column: null,
      extra: null,
      identity: true,
    });
  }
  return lanes;
}

/**
 * A cell, as the reader should see it.
 *
 * `registerCellValue` answers in STRINGS because it has to serve a text column
 * and a boolean one through the same signature. This is the display half of
 * that: pence become money, a JSON array becomes a list, a boolean becomes a
 * word. Nothing here re-reads the entity — it works only on what the one reader
 * returned, so a formatting change cannot become a second source of truth.
 */
export function formatRegisterCell(column: RegisterColumn, raw: string | null): string {
  if (raw === null || raw === "") return "—";
  switch (column.type) {
    case "currency": {
      /*
       * INTEGER PENCE on the row. A day rate stored as 45000 printed raw is
       * "45000", which reads as forty-five thousand pounds — the exact class of
       * confident wrong answer this codebase spends its comments on.
       */
      const pence = Number(raw);
      if (!Number.isFinite(pence)) return raw;
      return new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: "GBP",
      }).format(pence / 100);
    }
    case "checkbox":
      return raw === "true" || raw === "1" ? "Yes" : "No";
    case "multi_select": {
      // Stored as a JSON array on the contractor row. A parse failure prints
      // what is stored rather than an error: the value is still a fact.
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) return parsed.length ? parsed.join(", ") : "—";
      } catch {
        /* Not JSON. Fall through and print it. */
      }
      return raw;
    }
    default:
      return raw;
  }
}

type Busy = string | null;

/**
 * WHAT A PRESS ON A ROW MUST NOT SWALLOW.
 *
 * The whole row opens the contractor, because the affordance that used to do it
 * was a chevron in the last cell of a table twenty-four columns wide: opening a
 * contractor meant scrolling sideways past every rate and postcode first. A row
 * handler fixes that and immediately creates the opposite hazard — the row is
 * FULL of things that already do something, and a coordinator who taps a phone
 * number wants the dialler, not a drawer.
 *
 * ONE `closest` GUARD RATHER THAN `stopPropagation` ON EVERY CHILD. Both work.
 * The difference is what happens to the NEXT control somebody adds to a cell:
 * with per-child handlers it opens the drawer until whoever added it remembers,
 * and nothing fails visibly when they do not. This lists the things a browser
 * already treats as interactive, so a new link, button or field is exempt the
 * moment it exists.
 *
 * `label` is here because pressing one activates the control it labels, and
 * `[role="menuitem"]` because the column menu's items are buttons inside a
 * `div` the guard would otherwise have to walk past. The `role=` entries after
 * it cover the controls this product draws on a `div` rather than on the
 * element a browser would recognise — a pin toggle, a switch, a checkbox
 * standing in for one — so a press on any of them is the control's and not the
 * row's.
 */
const ROW_INTERACTIVE_SELECTOR = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="separator"]',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[contenteditable="true"]',
].join(", ");

/**
 * WHICH COLUMN IS THE FROZEN LANE.
 *
 * `pinnedColumn` is the register's own answer and is asked FIRST — `pinned` is
 * derived on the server from `register_columns.settings`, there is no `pinned`
 * SQL column, and this must not grow a second reading of that JSON.
 *
 * THE FALLBACK IS THE WHOLE POINT OF THIS FUNCTION. Not one organisation in
 * either database has a pinned column: the seed sets the flag once, at seed, so
 * it reaches a workspace created after the flag existed and nobody else. The
 * owner's Staging register — twenty-five contractor columns, all hidden — comes
 * back with `pinned` false on every one of them. "No column is pinned" is
 * therefore the state of every live register, and rendering no lane for it
 * would take the contractor's name and phone number off the very Preview this
 * work is for. So an unpinned register freezes its IDENTITY, and pinning is how
 * a reader moves the lane elsewhere rather than how they get one.
 *
 * Matched on `nativeField`, never on position — the reader may have moved the
 * column anywhere, and the default belongs to the identity wherever it sits.
 *
 * A STORED `pinned: false` IS STILL HONOURED, and this is the one place that
 * reads `settings` directly. It is a LIVE branch, not a placeholder: unpinning
 * writes `{"pinned": false}` rather than removing the key (see
 * `settingsWithPin`), precisely so "somebody chose no" is distinguishable from
 * "nobody ever chose". `{}` means the second and falls back; an explicit
 * `false` means the first and leaves no frozen lane at all — which is the only
 * way a reader can turn the lane OFF, because the fallback would otherwise
 * freeze the identity again on the very next render.
 *
 * Measured at 1440, both themes, through the real PATCH verb: `{}` gives one
 * sticky lane with the divider and the fall-off; `{"pinned": false}` gives zero
 * sticky cells, zero shadowed cells, zero left offsets, and the first cell's
 * left edge sitting exactly on the scroll container's content box.
 */
export function frozenRegisterColumn(
  columns: readonly RegisterColumn[],
): RegisterColumn | null {
  const pinned = pinnedColumn(columns);
  if (pinned) return pinned;
  const refused = columns.some(
    (column) =>
      column.settings &&
      typeof column.settings === "object" &&
      column.settings.pinned === false,
  );
  if (refused) return null;
  return columns.find((column) => column.nativeField === "name") ?? null;
}

export function ContractorRegister<Row extends RegisterEntityRow>({
  rows,
  extraColumns = [],
  badge,
  contact,
  onOpen,
}: {
  rows: Row[];
  /** Period-scoped measurements, drawn after the register's own columns. */
  extraColumns?: ExtraColumn<Row>[];
  /**
   * Anything that rides with the row's NAME rather than taking a column.
   *
   * The archived flag is the case this exists for. It is blank on all but a
   * handful of rows, so a column of its own would buy the table's horizontal
   * scroll for nothing — and the reader is already at the name when they need
   * it. That argument is unchanged by this register; what changed is that it is
   * no longer an argument against every other column, because the reader now
   * chooses which ones are on the table.
   */
  badge?: (row: Row) => React.ReactNode;
  /**
   * HOW TO REACH THEM, drawn under the name in the pinned identity lane.
   *
   * The actionable phone / WhatsApp / email block used to be an ordinary
   * `extraColumn` titled "Reach them", sitting after every register column and
   * scrolling away with them. It belongs beside the identity: a coordinator
   * reading a roster is deciding WHO to ring, and the number is the answer to
   * that question rather than a separate fact about them.
   *
   * It is drawn in exactly one place. The three fields are also available as
   * ordinary register columns (Email, Phone, WhatsApp) for a reader who wants
   * them as sortable text, but the ACTIONABLE form appears here and nowhere
   * else — two copies of a `wa.me` link is two chances to build one out of a
   * national number, which is the thing `contact-links.ts` exists to prevent.
   */
  contact?: (row: Row) => React.ReactNode;
  /** Open the row's profile — jobs, sites, documents and performance. */
  onOpen?: (id: string) => void;
  /**
   * Open the ordinary contractor editor — accepted and no longer drawn HERE.
   *
   * The pencil that used to call it lived in a frozen action lane at the right
   * of every row, which cost eighty-six pixels of a table the owner had already
   * called too wide and put a second, quieter way in beside a chevron that did
   * what the whole row now does. Both are gone. The editor is reached from the
   * profile the row opens, where the rest of a contractor's detail already is.
   *
   * The prop stays declared so the page that has always passed it still
   * type-checks, and so this comment is where somebody looks when they wonder
   * where the pencil went.
   */
  onManage?: (id: string) => void;
}) {
  const [snap, setSnap] = useState<RegisterSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newType, setNewType] = useState("text");
  const [editingCell, setEditingCell] = useState<string | null>(null);
  const [cellDraft, setCellDraft] = useState("");
  /**
   * The id the last refusal said could be restored, or null.
   *
   * Read off `RegisterError.body` rather than parsed out of the sentence: the
   * server puts `{ removed: true, id }` beside the message precisely so a
   * client does not have to read prose to find an id.
   */
  const [removedColumnId, setRemovedColumnId] = useState<string | null>(null);

  /**
   * Reload from the server, never from a locally patched copy.
   *
   * Every verb here answers with the row or the list it changed, and it would
   * be cheaper to splice that into state. It would also be a second model of
   * what the register is: reorder renumbers EVERY column, deleting one
   * renumbers the survivors, and adding one has to land at a position the
   * server chose. One read after each write is the version of this that cannot
   * drift.
   *
   * A COUNTER RATHER THAN A CALLABLE LOADER. The work is declared inside the
   * effect and state is only touched after the await resolves, which is the
   * pattern `use-loader.ts` and the rest of this dashboard use: setting state
   * synchronously in an effect body causes cascading renders, and this repo's
   * lint rules reject it. `active` guards a response that arrives after the
   * screen has moved on.
   */
  const [nonce, setNonce] = useState(0);
  const load = useCallback(() => setNonce((current) => current + 1), []);

  useEffect(() => {
    let active = true;
    async function run() {
      try {
        const next = await fetchRegister("contractors");
        if (!active) return;
        setSnap(next);
        setError("");
      } catch (caught) {
        if (!active) return;
        // The server's own sentence. See `RegisterError`.
        setError(
          caught instanceof Error ? caught.message : "The register could not be loaded.",
        );
      }
    }
    run();
    return () => {
      active = false;
    };
  }, [nonce]);

  /*
   * A press anywhere else closes the open column menu.
   *
   * `pointerdown` rather than `click`, so the menu is gone before the press
   * lands on whatever is underneath it — a menu that closes on `click` eats the
   * first press on the control behind it.
   */
  const gridRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!openMenu) return;
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".contractor-register__menu-anchor")) return;
      setOpenMenu(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [openMenu]);

  /** Run one register verb, reload, and surface the server's refusal verbatim. */
  const run = useCallback(
    async (key: string, work: () => Promise<unknown>) => {
      setBusy(key);
      setError("");
      setRemovedColumnId(null);
      try {
        await work();
        load();
      } catch (caught) {
        if (caught instanceof RegisterError && caught.body.removed === true) {
          setRemovedColumnId(
            typeof caught.body.id === "string" ? caught.body.id : null,
          );
        }
        /*
         * VERBATIM, and this is the whole reason `RegisterError` carries the
         * body. "Native columns cannot be deleted. Hide it instead." is an
         * INSTRUCTION, not a status code — replacing it with wording of our own
         * would leave somebody hunting for a Hide they had already found.
         */
        setError(
          caught instanceof RegisterError
            ? caught.message
            : caught instanceof Error
              ? caught.message
              : "That change could not be saved.",
        );
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  /* ── Resize, as a pointer drag on the header edge ───────────────────────── */

  const dragRef = useRef<{ id: string; startX: number; startWidth: number } | null>(null);
  const [dragWidth, setDragWidth] = useState<{ id: string; width: number } | null>(null);

  useEffect(() => {
    if (!dragWidth) return;
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || !snap) return;
      const next = Math.round(drag.startWidth + (event.clientX - drag.startX));
      const clamped = Math.min(
        Math.max(next, snap.widthRange.min),
        snap.widthRange.max,
      );
      setDragWidth({ id: drag.id, width: clamped });
    };
    const up = () => {
      const drag = dragRef.current;
      const settled = dragWidth;
      dragRef.current = null;
      setDragWidth(null);
      if (!drag || !settled) return;
      /*
       * Committed once, on release. A width write per pointer move would be a
       * request every few milliseconds, and the server does not audit width for
       * the same reason — it is a preference, not structure.
       */
      if (settled.width !== drag.startWidth) {
        void run(`resize:${drag.id}`, () => resizeRegisterColumn(drag.id, settled.width));
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragWidth, run, snap]);

  if (error && !snap) {
    return (
      <section className="panel sites-panel">
        <p className="analytics-empty">{error}</p>
      </section>
    );
  }
  if (!snap) {
    return (
      <section className="panel sites-panel">
        <p className="analytics-empty">Loading the register…</p>
      </section>
    );
  }

  const shown = visibleColumns(snap.columns);
  const hidden = hiddenColumns(snap.columns);
  const widthOf = (column: RegisterColumn) =>
    dragWidth && dragWidth.id === column.id ? dragWidth.width : column.width;

  /*
   * WHAT THE IDENTITY LANE IS AND WHAT IT IS CALLED.
   *
   * Matched on `nativeField`, never on position: the reader may have put the
   * column anywhere, and it is found here whether it is shown or hidden because
   * a column's LABEL is a property of the column and not of its visibility.
   * Renaming "Contractor" to "Supplier" therefore renames the lane with it.
   *
   * "Contractor" is the fallback for the only case with no column to ask: a
   * snapshot from before the catalogue seeded.
   */
  const identityColumn =
    snap.columns.find((column) => column.nativeField === "name") ?? null;
  const identityTitle = identityColumn?.title ?? "Contractor";

  /*
   * THE FROZEN LANE, AND THE SCROLLING SET IT IS NOT IN.
   *
   * `frozen` is a column of this register — the identity by default and
   * whichever column the reader pinned instead — and it is filtered OUT of
   * `scrolling` so it is drawn once. Pinning implies visible, so a pinned
   * column that is nonetheless recorded hidden still gets its lane: the lane is
   * the strongest statement anybody has made about it.
   */
  const frozen = frozenRegisterColumn(snap.columns);
  const scrolling = shown.filter((column) => !frozen || column.id !== frozen.id);
  const lanes = gridLanes(scrolling, frozen, identityColumn, extraColumns, snap.columns);

  /** Move one column to a new slot and send the WHOLE order. */
  function move(column: RegisterColumn, delta: number) {
    if (!snap) return;
    const index = snap.columns.findIndex((entry) => entry.id === column.id);
    if (index < 0) return;
    /*
     * `orderAfterMove` operates on the FULL column list, hidden ones included,
     * and returns every key — which is what `reorderRegisterColumns` wants. A
     * pair of indices could not express this: a list cannot hold two columns in
     * one place, so the invalid state is unrepresentable rather than validated.
     */
    const order = orderAfterMove(snap.columns, column.key, index + delta);
    void run(`move:${column.id}`, () => reorderRegisterColumns("contractors", order));
  }

  function rename(column: RegisterColumn) {
    const next = window.prompt(`Rename "${column.title}" to:`, column.title);
    if (next === null) return;
    const title = next.trim();
    if (!title || title === column.title) return;
    void run(`rename:${column.id}`, () => renameRegisterColumn(column.id, title));
  }

  return (
    <section className="panel sites-panel contractor-register" ref={gridRef}>
      <header className="contractor-register__toolbar">
        <div>
          <strong>Register columns</strong>
          <span className="drawer-label">
            {shown.length} shown
            {hidden.length ? `, ${hidden.length} hidden` : ""}
          </span>
        </div>
        <div className="contractor-register__actions">
          <button
            type="button"
            className="secondary-button"
            aria-expanded={showPanel}
            onClick={() => setShowPanel((open) => !open)}
          >
            <Icon name="settings" size={16} />
            Columns
          </button>
          {/*
            Adding is gated on `canConfigure`, which the SERVER resolved from
            `board.edit`. Not on the role name: a role whose `board.edit` was
            revoked in Roles is still called "Admin", and a control drawn from
            the name would be a button that is always refused.
          */}
          {snap.canConfigure && (
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                setAdding((open) => !open);
                setNewTitle("");
              }}
            >
              <Icon name="plus" size={16} />
              Add column
            </button>
          )}
        </div>
      </header>

      {error && (
        <p className="form-error contractor-register__error" role="alert">
          {error}
          {/*
            THE REFUSAL THAT COMES WITH A WAY OUT.

            A removed CUSTOM column keeps its key and its cells, so adding one
            back under the same name is answered 409 with `removed: true` and the
            id — an instruction, not a dead end. Offering the Restore here is
            what turns the sentence into the action it describes; without it the
            reader is told the column "can be restored" and given nowhere to do
            it.
          */}
          {removedColumnId && (
            <button
              type="button"
              className="secondary-button contractor-register__error-action"
              disabled={busy === "restore"}
              onClick={() =>
                void run("restore", async () => {
                  await restoreRegisterColumn(removedColumnId);
                  setAdding(false);
                  setNewTitle("");
                })
              }
            >
              Restore it
            </button>
          )}
        </p>
      )}

      {adding && snap.canConfigure && (
        <form
          className="contractor-register__add"
          onSubmit={(event) => {
            event.preventDefault();
            const title = newTitle.trim();
            if (!title) return;
            void run("add", async () => {
              await addRegisterColumn("contractors", title, newType);
              setAdding(false);
              setNewTitle("");
            });
          }}
        >
          <label htmlFor="contractor-register-title">
            Column name
            <input
              id="contractor-register-title"
              value={newTitle}
              maxLength={80}
              onChange={(event) => setNewTitle(event.target.value)}
              placeholder="Preferred payment method"
            />
          </label>
          <label htmlFor="contractor-register-type">
            Type
            <select
              id="contractor-register-type"
              value={newType}
              onChange={(event) => setNewType(event.target.value)}
            >
              {/*
                The types come from the ANSWER, so this control cannot offer one
                the server would refuse — a register is not a board and has no
                formula column to offer.
              */}
              {snap.types.map((type) => (
                <option key={type} value={type}>
                  {type.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="primary-button" disabled={busy === "add"}>
            {busy === "add" ? "Adding…" : "Add"}
          </button>
          <button type="button" className="secondary-button" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </form>
      )}

      {/*
        THE COLUMNS PANEL — and the ONLY place hidden columns are listed.

        What used to be here was a checkbox list of this register's own, and
        under the table sat a second surface: a permanent "Hidden columns" block
        of chips. On the live register — where the owner had hidden twenty-five
        of the twenty-five — that block was twenty-five buttons parked below the
        rows for good, so the page never ended and the only thing it listed was
        the half that was NOT on the table. Both are gone. `RegisterColumnsPanel`
        draws ONE checklist of every column with a tick against the ones on the
        register — not two lists side by side, which was the shape before it and
        which could not say where a column was without the reader comparing
        them. The Sites register mounts the same component, and
        `register_columns.hidden_at` has one rendering.

        AND IT IS WHERE PIN LIVES. Every optional handler below is one verb the
        panel draws per column; a register that passes only `onSetHidden` gets a
        tidy checklist and silently loses reorder, rename, resize, remove — and
        the pin, which is the only control that decides which column is frozen.

        Gated on `canConfigure` for the same reason every other control here is:
        a reader who may not rearrange the register is shown no controls that
        would only ever be refused.
      */}
      {showPanel && snap.canConfigure && (
        <div className="contractor-register__panel">
          <p className="drawer-label">
            Every column on this register. Hidden ones are still recorded — hiding
            is how a built-in column is removed from view without throwing the
            contractor&rsquo;s data away.
          </p>
          {/*
            EVERY VERB, NOT JUST THE CHECKBOX. The panel's per-column menu is
            optional prop by optional prop, so a register that hands it only
            `onSetHidden` gets a tidy checklist and silently loses reorder,
            rename, resize, pin and remove — which is what this screen did, and
            it is where Pin lives. The handlers are the same ones the header
            menu calls; there is no second implementation of any of them.
          */}
          <RegisterColumnsPanel
            columns={snap.columns}
            busy={busy !== null}
            onSetHidden={(column, next) =>
              void run(`hide:${column.id}`, () => setRegisterColumnHidden(column.id, next))
            }
            onMove={move}
            onRename={rename}
            onResize={(column, width) =>
              void run(`width:${column.id}`, () => resizeRegisterColumn(column.id, width))
            }
            /*
             * WHAT IS ACTUALLY FROZEN, which on a register nobody has pinned is
             * the fallback identity column rather than anything carrying a
             * stored flag. Without it the panel offers "Pin" on the column
             * already sitting in the frozen lane, and turning the lane off
             * would take two presses: one to make the implicit state explicit,
             * another to reverse it.
             */
            frozenKey={frozen ? frozen.key : null}
            onPin={(column, next) =>
              void run(`pin:${column.id}`, () =>
                pinRegisterColumn("contractors", column.id, next),
              )
            }
            onRemove={(column) =>
              void run(`remove:${column.id}`, () => removeRegisterColumn(column.id))
            }
          />
        </div>
      )}

      <div className="table-scroll" tabIndex={0} role="region" aria-label="Contractor register">
        <table className="data-table sites-table analytics-table--mobile-cards contractor-register__table">
          <caption className="visually-hidden">
            The contractor register. Columns can be renamed, reordered, hidden and
            added.
          </caption>
          <thead>
            {/*
              ONE `.map`, OVER THE SAME `lanes` THE BODY USES. A header loop
              over one list beside a cell loop over another is a table whose
              labels quietly stop matching its values; see `GridLane`.
            */}
            <tr>
              {lanes.map((lane) => {
                const column = lane.column;
                /*
                 * The index the Move controls read is the position among the
                 * SCROLLING columns, so "Move left" is greyed on the one that
                 * is already leftmost on the table rather than on the one that
                 * happens to be first in a list containing the frozen lane.
                 */
                const scrollIndex = column
                  ? scrolling.findIndex((entry) => entry.id === column.id)
                  : -1;
                /*
                 * THE WIDTH LIVES ON THE HEADER CELL, NOT IN A `<colgroup>`.
                 *
                 * A `<col>` constrains the table at every width, including the
                 * one where this table stops being a table:
                 * `.analytics-table--mobile-cards` turns `tbody` into a grid on
                 * a phone, and the column widths went on applying to a layout
                 * that no longer has columns — measured at 390px, every card
                 * collapsed into a 20-pixel sliver. The same rule hides `thead`
                 * absolutely, so a width declared HERE stops constraining
                 * anything the moment the cards take over, which is exactly the
                 * behaviour wanted. `minWidth` as well as `width`, or the
                 * browser's auto layout ignores a drag that made a column
                 * narrower than its content.
                 *
                 * The FROZEN lane declares none of it: the identity is a stack
                 * of a name, a badge and up to three contact rows, and its
                 * width belongs with the rule that lays that stack out. See
                 * `.contractor-register__lane--start` in `globals.css`.
                 */
                const sized =
                  column && !lane.frozen
                    ? { width: `${widthOf(column)}px`, minWidth: `${widthOf(column)}px` }
                    : undefined;
                return (
                  <th
                    key={lane.key}
                    scope="col"
                    /*
                     * `--start` rather than `--left`, because the property that
                     * pins it is `inset-inline-start` in spirit — and because
                     * "left" would be a lie the day this product is read
                     * right-to-left.
                     */
                    className={
                      lane.frozen
                        ? "contractor-register__lane contractor-register__lane--start"
                        : undefined
                    }
                    style={sized}
                  >
                    {column && snap.canConfigure ? (
                      <span className="contractor-register__head">
                        <span className="contractor-register__head-title">{lane.title}</span>
                        <span className="contractor-register__menu-anchor">
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`Options for ${lane.title}`}
                            aria-expanded={openMenu === column.id}
                            onClick={() =>
                              setOpenMenu((open) => (open === column.id ? null : column.id))
                            }
                          >
                            <Icon name="more" size={15} />
                          </button>
                          {openMenu === column.id && (
                            <div className="contractor-register__menu" role="menu">
                              <button type="button" role="menuitem" onClick={() => rename(column)}>
                                Rename
                              </button>
                              {/*
                                A FROZEN COLUMN CANNOT BE MOVED OR HIDDEN, and
                                the controls say so rather than disappearing.
                                It is the lane — there is nowhere left of it to
                                move to — and pinning implies visible, so a Hide
                                offered here would be a press that unhides
                                itself on the next load. Unpin is in the Columns
                                panel, beside the pin that put it there.
                              */}
                              <button
                                type="button"
                                role="menuitem"
                                disabled={lane.frozen || scrollIndex <= 0}
                                onClick={() => move(column, -1)}
                              >
                                Move left
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                disabled={lane.frozen || scrollIndex === scrolling.length - 1}
                                onClick={() => move(column, 1)}
                              >
                                Move right
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                disabled={lane.frozen}
                                onClick={() =>
                                  void run(`hide:${column.id}`, () =>
                                    setRegisterColumnHidden(column.id, true),
                                  )
                                }
                              >
                                Hide
                              </button>
                              {/*
                                Offered on a native column too, and refused by
                                the server with an instruction rather than a
                                status code. Hiding the control would hide the
                                instruction with it, and "remove this column"
                                and "stop showing me this column" are the same
                                sentence in a reader's head.
                              */}
                              <button
                                type="button"
                                role="menuitem"
                                className="contractor-register__menu-danger"
                                onClick={() =>
                                  void run(`delete:${column.id}`, () =>
                                    removeRegisterColumn(column.id),
                                  )
                                }
                              >
                                Remove
                              </button>
                            </div>
                          )}
                        </span>
                        {/* A lane has no draggable edge; its width is the
                            identity stack's, not a preference. */}
                        {!lane.frozen && (
                          <span
                            className="contractor-register__resize"
                            role="separator"
                            aria-label={`Resize ${lane.title}`}
                            onPointerDown={(event) => {
                              event.preventDefault();
                              dragRef.current = {
                                id: column.id,
                                startX: event.clientX,
                                startWidth: column.width,
                              };
                              setDragWidth({ id: column.id, width: column.width });
                            }}
                          />
                        )}
                      </span>
                    ) : (
                      lane.title
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className={onOpen ? "contractor-register__row is-openable" : "contractor-register__row"}
                onClick={
                  onOpen
                    ? (event) => {
                        /*
                         * See `ROW_INTERACTIVE_SELECTOR`. The press is ignored
                         * when it landed on something that already does
                         * something — the `tel:` link, the WhatsApp link, the
                         * `mailto:`, a column menu, an editable cell — and
                         * opens the contractor otherwise.
                         */
                        const target = event.target;
                        if (target instanceof Element && target.closest(ROW_INTERACTIVE_SELECTOR)) {
                          return;
                        }
                        onOpen(row.id);
                      }
                    : undefined
                }
              >
                {/*
                  THE SAME `lanes` THE HEADER MAPPED, in the same order. One
                  ordered definition, drawn twice.
                */}
                {lanes.map((lane) => {
                  const column = lane.column;
                  const laneClass = lane.frozen
                    ? "contractor-register__lane contractor-register__lane--start"
                    : undefined;

                  /*
                    THE IDENTITY. Who this is, whether they are still on the
                    register, and how to reach them — in that order, because a
                    number nobody has a name for is the one that gets dialled
                    last. It rides with the identity COLUMN, so it is here
                    whether that column is the frozen lane or an ordinary cell
                    somewhere in the middle of the scroll.

                    The name is a real `<button>`, not the row's click handler
                    wearing a pointer: the row is a `<tr>` and a `<tr>` cannot
                    be focused, labelled or pressed with a keyboard. With the
                    action lane gone this is the ONLY keyboard route into a
                    contractor, so it is a real control with a real focus ring
                    and the row handler is the convenience laid over it.
                    Nothing is nested — no button inside a button, no anchor
                    inside an anchor — which is why the row is not itself a
                    control.
                  */
                  if (lane.identity) {
                    return (
                      <td key={lane.key} className={laneClass} data-label={identityTitle}>
                        <span className="contractor-register__identity">
                          <span className="site-name-cell">
                            {onOpen ? (
                              <button
                                type="button"
                                className="contractor-register__cell contractor-register__cell--name"
                                onClick={() => onOpen(row.id)}
                              >
                                <strong>{row.name}</strong>
                              </button>
                            ) : (
                              <strong>{row.name}</strong>
                            )}
                            {badge?.(row)}
                          </span>
                          {contact?.(row)}
                        </span>
                      </td>
                    );
                  }

                  /* A period-scoped figure. Not a stored value, so it never
                     reaches the one reader below. */
                  if (lane.extra) {
                    return (
                      <td key={lane.key} className={laneClass} data-label={lane.title}>
                        {lane.extra.render(row)}
                      </td>
                    );
                  }
                  if (!column) return null;

                  /*
                   * THE ONE READER. Native reads the contractor row by its field
                   * name, custom reads the values map by its key — and this is
                   * the only call site in the component, so the two kinds cannot
                   * drift apart.
                   */
                  const raw = registerCellValue(
                    column,
                    row as unknown as Record<string, unknown>,
                    snap.values,
                    row.id,
                  );
                  const cellKey = `${row.id}:${column.key}`;
                  const editable = !column.native && snap.canEditValues;
                  /*
                   * THE NAME COLUMN GETS NO SPECIAL CASE HERE, and the reason is
                   * the identity branch above.
                   *
                   * It used to be the row's identity and its way in: matched on
                   * `nativeField === "name"` and drawn as a button that opened
                   * the profile. That was right while the name was guaranteed
                   * to be on the table, and it stopped being right the moment
                   * an operator hid the column — which is exactly what happened
                   * on the live register, leaving rows with no name and no way
                   * in. `lane.identity` now decides that, on the column rather
                   * than on its position, so the identity rendering follows the
                   * column through a pin, an unpin and a reorder alike.
                   */
                  return (
                    <td key={lane.key} className={laneClass} data-label={column.title}>
                      {editingCell === cellKey ? (
                        <input
                          autoFocus
                          className="contractor-register__cell-input"
                          value={cellDraft}
                          onChange={(event) => setCellDraft(event.target.value)}
                          onBlur={() => {
                            const next = cellDraft.trim();
                            setEditingCell(null);
                            if (next === (raw ?? "")) return;
                            void run(`cell:${cellKey}`, () =>
                              writeRegisterCell("contractors", column, row.id, next || null),
                            );
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur();
                            if (event.key === "Escape") setEditingCell(null);
                          }}
                        />
                      ) : editable ? (
                        <button
                          type="button"
                          className="contractor-register__cell"
                          onClick={() => {
                            setCellDraft(raw ?? "");
                            setEditingCell(cellKey);
                          }}
                        >
                          {formatRegisterCell(column, raw)}
                        </button>
                      ) : (
                        <span>{formatRegisterCell(column, raw)}</span>
                      )}
                    </td>
                  );
                })}
                {/*
                  AND NOTHING AFTER THE LAST LANE.

                  A frozen action lane used to close every row: a chevron that
                  opened the contractor and a pencil that opened the editor,
                  eighty-six pixels of a table the owner had already called too
                  wide, held there on every row at every width. The chevron
                  duplicated a press the whole row answers; the pencil moved to
                  the profile the row opens. There is no permanent actions
                  column on this table and no sticky lane at the right — which
                  is the point, not an omission.
                */}
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td
                  className="analytics-empty"
                  /*
                   * Every lane the header drew, counted from the same list the
                   * header drew it from. A colSpan derived a second time is a
                   * colSpan that goes wrong the first time the two disagree —
                   * short, and the empty message ends mid-table beside a stray
                   * bordered cell.
                   */
                  colSpan={lanes.length}
                >
                  No contractors are registered yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/*
        SHOW HIDDEN — MOVED INTO THE COLUMNS PANEL, and the block that used to
        stand here is gone.

        The reasoning it carried is still true and still honoured: a "show
        hidden" control cannot offer to bring back a column it was never told
        about, which is why `GET /api/registers` returns hidden columns carrying
        `hidden: true` rather than filtering them out, and why un-hiding is a
        single press. What was wrong was WHERE it said so. This drew a
        permanent row of chips beneath the table, one per hidden column, so a
        register with twenty-five hidden columns ended in twenty-five buttons
        that never went away and never mentioned the columns that WERE on the
        table. The register now ends with its rows, and both halves of the
        answer live together in the panel behind the Columns button.
      */}
    </section>
  );
}
