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
 * ── THE TWO LANES THAT ARE NOT COLUMNS ───────────────────────────────────
 *
 * The table has a pinned lane at each end, and neither is a register column.
 * That is the whole point of them.
 *
 * THE IDENTITY LANE, first and stuck to the left, carries who the contractor is
 * and how to reach them. It exists because the register let an operator hide
 * the `name` column — and the live register did exactly that, leaving rows of
 * rates and postcodes with no name anywhere on them. A lane that is not a
 * column cannot be hidden, renamed away or reordered off the front, so the row
 * always says whose row it is however the other twenty-five are arranged.
 *
 * THE ACTION LANE, last and stuck to the right, carries the details chevron.
 * Before this it was an ordinary last cell, which on a table twenty-four
 * columns wide meant scrolling four thousand pixels sideways to open a
 * contractor. Pinned, the affordance is where the reader is.
 *
 * Both lanes are OPAQUE and above the scrolling cells — see
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
 * `div` the guard would otherwise have to walk past.
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
  '[contenteditable="true"]',
].join(", ");

export function ContractorRegister<Row extends RegisterEntityRow>({
  rows,
  extraColumns = [],
  badge,
  contact,
  onOpen,
  onManage,
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
  /** Open the ordinary contractor editor — the only way to write a native field. */
  onManage: (id: string) => void;
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
   * WHAT THE PINNED IDENTITY LANE IS CALLED.
   *
   * Taken from the `name` column's title when the register has one, so renaming
   * "Contractor" to "Supplier" renames the lane with it — the rename verb keeps
   * meaning what it says even for the one lane it cannot move or hide. Matched
   * on `nativeField`, never on position: the reader may have put the column
   * anywhere, and it is found here whether it is shown or hidden because the
   * LABEL is a property of the column and not of its visibility.
   *
   * "Contractor" is the fallback for the only case with no column to ask: a
   * snapshot from before the catalogue seeded.
   */
  const identityTitle =
    snap.columns.find((column) => column.nativeField === "name")?.title ?? "Contractor";

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
        draws shown and hidden side by side, the Sites register mounts the same
        component, and `register_columns.hidden_at` has one rendering.

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
          <RegisterColumnsPanel
            columns={snap.columns}
            busy={busy !== null}
            onSetHidden={(column, next) =>
              void run(`hide:${column.id}`, () => setRegisterColumnHidden(column.id, next))
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
            <tr>
              {/*
                THE PINNED IDENTITY LANE'S HEADER. `--start` rather than
                `--left`, because the property that pins it is `inset-inline
                -start` in spirit — and because "left" would be a lie the day
                this product is read right-to-left.
              */}
              <th scope="col" className="contractor-register__lane contractor-register__lane--start">
                {identityTitle}
              </th>
              {shown.map((column: RegisterColumn, index: number) => (
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
                 */
                <th
                  key={column.id}
                  scope="col"
                  style={{ width: `${widthOf(column)}px`, minWidth: `${widthOf(column)}px` }}
                >
                  <span className="contractor-register__head">
                    <span className="contractor-register__head-title">{column.title}</span>
                    {snap.canConfigure && (
                      <span className="contractor-register__menu-anchor">
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Options for ${column.title}`}
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
                            <button
                              type="button"
                              role="menuitem"
                              disabled={index === 0}
                              onClick={() => move(column, -1)}
                            >
                              Move left
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              disabled={index === shown.length - 1}
                              onClick={() => move(column, 1)}
                            >
                              Move right
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() =>
                                void run(`hide:${column.id}`, () =>
                                  setRegisterColumnHidden(column.id, true),
                                )
                              }
                            >
                              Hide
                            </button>
                            {/*
                              Offered on a native column too, and refused by the
                              server with an instruction rather than a status
                              code. Hiding the control would hide the
                              instruction with it, and "remove this column" and
                              "stop showing me this column" are the same
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
                    )}
                    {snap.canConfigure && (
                      <span
                        className="contractor-register__resize"
                        role="separator"
                        aria-label={`Resize ${column.title}`}
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
                </th>
              ))}
              {extraColumns.map((column) => (
                <th key={column.key} scope="col">
                  {column.title}
                </th>
              ))}
              {/*
                THE ACTION LANE'S HEADER, named in TEXT rather than by
                `aria-label`.

                It carried `aria-label="Actions"` and nothing inside it, which
                axe flags as `empty-table-header`: a header cell's accessible
                name is meant to come from its content, because that is what a
                screen reader announces when it reaches a cell in this column.
                `.visually-hidden` gives it the content without giving the
                column a heading nobody needs to read.
              */}
              <th scope="col" className="contractor-register__lane contractor-register__lane--end">
                <span className="visually-hidden">Actions</span>
              </th>
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
                  THE PINNED IDENTITY LANE. Who this is, whether they are still
                  on the register, and how to reach them — in that order,
                  because a number nobody has a name for is the one that gets
                  dialled last.

                  The name is a real `<button>`, not the row's click handler
                  wearing a pointer: the row is a `<tr>` and a `<tr>` cannot be
                  focused, labelled or pressed with a keyboard. This is the
                  focusable trigger; the row handler is the convenience laid
                  over it. Nothing is nested — no button inside a button, no
                  anchor inside an anchor — which is why the row is not itself
                  a control.
                */}
                <td
                  className="contractor-register__lane contractor-register__lane--start"
                  data-label={identityTitle}
                >
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
                {shown.map((column) => {
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
                   * THE NAME COLUMN GETS NO SPECIAL CASE HERE ANY MORE, and
                   * the reason is the pinned lane above.
                   *
                   * It used to be the row's identity and its way in: matched on
                   * `nativeField === "name"` and drawn as a button that opened
                   * the profile. That was right while the name was guaranteed
                   * to be on the table, and it stopped being right the moment
                   * an operator hid the column — which is exactly what happened
                   * on the live register, leaving rows with no name and no way
                   * in. The identity moved to a lane nobody can hide; `name`
                   * is now an ordinary text column, seeded hidden precisely
                   * because the lane already prints it, and shown only by
                   * somebody who wants a second, sortable copy.
                   */
                  return (
                    <td key={column.id} data-label={column.title}>
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
                {extraColumns.map((column) => (
                  <td key={column.key} data-label={column.title}>
                    {column.render(row)}
                  </td>
                ))}
                {/*
                  THE PINNED ACTION LANE.

                  Two buttons and not one, because they are two different
                  places. The chevron OPENS the contractor — jobs, sites,
                  documents, performance — and is the visible twin of the row
                  press, kept at the right edge so the affordance is reachable
                  without scrolling to the last column. The pencil opens the
                  ordinary editor, which is the only way to write a native
                  field; it is the row's only route to that editor, so it stays.

                  Each stops the press from reaching the row. Redundant with
                  `ROW_INTERACTIVE_SELECTOR`, which already exempts a
                  `<button>` — and kept anyway, because it costs a line and
                  states the intent at the place a reader will look for it.
                */}
                <td
                  data-label="Actions"
                  className="contractor-register__lane contractor-register__lane--end"
                >
                  <span className="contractor-register__row-actions">
                    {onOpen && (
                      <button
                        className="icon-button table-open"
                        type="button"
                        aria-label={`Open ${row.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpen(row.id);
                        }}
                      >
                        <Icon name="chevron" size={16} />
                      </button>
                    )}
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`Edit ${row.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onManage(row.id);
                      }}
                    >
                      <Icon name="edit" size={15} />
                    </button>
                  </span>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td
                  className="analytics-empty"
                  /*
                   * The register's own columns, the page's figures, and the two
                   * lanes that are not columns — the identity lane at the front
                   * and the action lane at the back. A colSpan that forgot them
                   * would leave the empty message short of the table's width
                   * and a stray bordered cell beside it.
                   */
                  colSpan={shown.length + extraColumns.length + 2}
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
