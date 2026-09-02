"use client";

/**
 * W05-08 / W06-05 — the configurable register, as a screen.
 *
 * `register-client.ts` next door is the browser's half of the API and holds the
 * rules; this is the one component that draws them. A screen that wants a
 * configurable register mounts THIS rather than hand-rolling its own
 * `fetch("/api/registers")`, because there are four things a register grid has
 * to get right and every one of them is invisible when it is wrong:
 *
 *  1. NATIVE AND CUSTOM CELLS COME FROM DIFFERENT PLACES. A native column's
 *     value is on the site or contractor ROW; a custom column's is in
 *     `snap.values`. They are drawn side by side and look identical, so a grid
 *     that reads `values` for everything renders all forty native site columns
 *     BLANK — which looks like missing data rather than like a bug. Every cell
 *     here goes through `registerCellValue`, which is the only function allowed
 *     to decide which store to read.
 *
 *  2. CONTROLS ARE GATED ON THE SNAPSHOT'S OWN ANSWER — `canConfigure`
 *     (`board.edit`) and `canEditValues` (`sites.edit`) — never on a role name.
 *     Roles are resolved to capabilities on the server and a second opinion
 *     here would be a permission model that disagrees with itself.
 *
 *  3. A REFUSAL IS SHOWN IN THE SERVER'S OWN WORDS. "Native columns cannot be
 *     deleted. Hide it instead." is an INSTRUCTION, not a status code, and a
 *     grid that swallowed it and printed "Something went wrong" would throw
 *     away the only sentence that tells the user what to do next.
 *
 *  4. REORDER SENDS THE WHOLE ORDER. `orderAfterMove` produces it. A pair of
 *     indices cannot express "these two columns are both third", so the invalid
 *     state is unrepresentable rather than validated.
 *
 * WHY BUTTONS AND NOT A DRAG. Reordering and resizing are done from the column
 * menu. A drag gesture is the obvious design and it is the one that does not
 * work: this grid is inside a horizontally scrolling table on a phone, where a
 * horizontal drag IS the scroll, and a drag has no keyboard equivalent at all.
 * Move left / Move right / Wider / Narrower are reachable with a keyboard, work
 * identically under a finger, and send exactly the same request.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../../components";
import { formatDate, formatMoney } from "../sites/site-types";
import { RegisterColumnsPanel } from "./register-columns-panel";
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
  type RegisterKey,
  type RegisterSnapshot,
} from "./register-client";

/** One row the register draws. `id` is what both stores are keyed by. */
export type RegisterRow = Record<string, unknown> & { id: string };

/**
 * How far one press of Wider or Narrower moves a column.
 *
 * Twenty pixels: small enough that a reader can settle on a width, large enough
 * that reaching the 60–640 range's ends is not thirty presses. The server
 * clamps to `widthRange`, so an overshoot stops rather than failing.
 */
const WIDTH_STEP = 20;

/**
 * What a cell SAYS, given what the column holds.
 *
 * Formatting happens here, at the edge, and only here. Money is integer pence
 * on the row — `serviceChargePence`, `annualBudgetPence`, every contractor rate
 * — so a `currency` column that printed the raw value would report a £1,234.56
 * service charge as 123456. A date is a bare `YYYY-MM-DD` and goes through the
 * platform's one formatter, which never hands a date-only value to `Date` and
 * so cannot shift it a day for a reader west of Greenwich.
 *
 * An ARRAY arrives as JSON, because `registerCellValue` stringifies one rather
 * than guessing at a separator. Joined for display; the stored value is
 * untouched.
 *
 * An EMPTY value is an em dash and never a blank cell. A blank reads as a
 * rendering fault; a dash says "nothing recorded", which is a fact.
 */
function cellText(column: RegisterColumn, raw: string | null): string {
  if (raw === null || raw === "") return "—";
  if (column.type === "currency") {
    const pence = Number(raw);
    return Number.isFinite(pence) ? formatMoney(pence) : raw;
  }
  if (column.type === "date") return formatDate(raw) || raw;
  if (column.type === "checkbox") return raw === "true" || raw === "1" ? "Yes" : "No";
  if (column.type === "multi_select" && raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) && parsed.length ? parsed.join(", ") : "—";
    } catch {
      return raw;
    }
  }
  return raw;
}

export function RegisterGrid({
  register,
  rows,
  caption,
  title = "Register columns",
  emptyMessage = "No rows yet.",
}: {
  register: RegisterKey;
  rows: RegisterRow[];
  caption: string;
  title?: string;
  emptyMessage?: string;
}) {
  const [snapshot, setSnapshot] = useState<RegisterSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const columnsButton = useRef<HTMLButtonElement>(null);

  /*
   * PERSISTENCE IS THE SERVER'S. There is no local copy of the layout and no
   * `localStorage` key: the columns, their order, their widths and what is
   * hidden all live in `register_columns`, so a reload — or the same person on
   * a second device, or a colleague — sees the register as it was configured
   * rather than as their own browser last remembered it. This effect is the
   * whole of "persists across reload".
   */
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let live = true;
    /*
     * An async IIFE rather than a call to an async helper, which is the shape
     * the lint rules here require: `setState` reached synchronously from an
     * effect body cascades a render, and the rule cannot see that everything
     * below is behind an await. The same arrangement the manage drawer's option
     * fetch uses. `live` drops a response that arrives after unmount.
     */
    (async () => {
      try {
        const next = await fetchRegister(register);
        if (live) setSnapshot(next);
      } catch (caught) {
        // The server's own sentence, verbatim. See the note at the top.
        if (live) {
          setError(
            caught instanceof RegisterError ? caught.message : "The register could not be loaded.",
          );
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [register, reloadToken]);

  /*
   * ONE PLACE THAT TALKS TO THE API.
   *
   * Every configuration action is the same three steps — clear the last
   * refusal, run the call, show the server's words if it says no — and writing
   * them out nine times is nine chances for one of them to swallow a message.
   * `RegisterError.message` carries the instruction ("Native columns cannot be
   * deleted. Hide it instead."); anything else is an outage and says so.
   */
  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      /*
       * RE-READ RATHER THAN PATCH THE LOCAL COPY. Several of these calls change
       * columns the caller did not name — a reorder renumbers every position,
       * a resize is clamped by the server, an add invents a key from a title —
       * so the snapshot the server holds is the only one that is right, and
       * merging a response into a stale array is how a grid comes to show an
       * order the database does not have.
       */
      setReloadToken((token) => token + 1);
    } catch (caught) {
      setError(
        caught instanceof RegisterError
          ? caught.message
          : "That change could not be saved. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }, []);

  const columns = useMemo(() => snapshot?.columns ?? [], [snapshot]);
  const shown = useMemo(() => visibleColumns(columns), [columns]);
  const hidden = useMemo(() => hiddenColumns(columns), [columns]);
  const canConfigure = Boolean(snapshot?.canConfigure);
  const canEditValues = Boolean(snapshot?.canEditValues);

  /* Escape closes whichever layer is open, innermost first. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (menuFor) setMenuFor(null);
      else if (adding) setAdding(false);
      else if (panelOpen) {
        setPanelOpen(false);
        columnsButton.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuFor, adding, panelOpen]);

  const move = (column: RegisterColumn, by: number) => {
    const at = columns.findIndex((entry) => entry.key === column.key);
    if (at < 0) return;
    // The WHOLE order, every time. See `orderAfterMove`.
    void run(() => reorderRegisterColumns(register, orderAfterMove(columns, column.key, at + by)));
  };

  const rename = (column: RegisterColumn) => {
    /*
     * Renaming a NATIVE column is allowed precisely because it changes the
     * LABEL and nothing else: "Store" becomes "Branch" on this register while
     * `sites.name` and every join, import and other screen reading it carry on
     * unchanged.
     */
    const next = window.prompt(`Rename "${column.title}" on this register.`, column.title);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === column.title) return;
    void run(() => renameRegisterColumn(column.id, trimmed));
  };

  if (!snapshot) {
    return (
      <div className="register-grid">
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : (
          <p className="analytics-empty">Loading the register…</p>
        )}
      </div>
    );
  }

  return (
    <div className="register-grid">
      <div className="register-grid__toolbar">
        <div>
          <strong>{title}</strong>
          <small>
            {shown.length} shown{hidden.length ? `, ${hidden.length} hidden` : ""}
          </small>
        </div>
        {/*
          BOTH CONTROLS ARE GATED ON `canConfigure`, which is the snapshot's own
          answer for `board.edit` — not on a role read from the session. A
          viewer sees the register exactly as it is configured and no buttons
          that would only ever 403.
        */}
        {canConfigure ? (
          <div className="register-grid__actions">
            <button
              ref={columnsButton}
              type="button"
              className="secondary-button"
              aria-expanded={panelOpen}
              onClick={() => setPanelOpen((open) => !open)}
            >
              <Icon name="settings" size={16} />
              Columns
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setAdding(true);
                setNewTitle("");
              }}
            >
              <Icon name="plus" size={16} />
              Add column
            </button>
          </div>
        ) : null}
      </div>

      {/*
        THE SERVER'S OWN SENTENCE, unedited. `role="alert"` so a refusal reaches
        a screen reader without the user having to go looking for it.
      */}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {adding && canConfigure ? (
        <form
          className="register-add-column"
          onSubmit={(event) => {
            event.preventDefault();
            const wanted = newTitle.trim();
            if (!wanted) return;
            // The server generates the KEY from the title; the title is all a
            // person should have to think about.
            void run(async () => {
              await addRegisterColumn(register, wanted);
              setAdding(false);
              setNewTitle("");
            });
          }}
        >
          <label className="form-field">
            <span>New column</span>
            <input
              type="text"
              value={newTitle}
              autoFocus
              placeholder="Fire risk assessor, Alarm code, Landlord contact…"
              onChange={(event) => setNewTitle(event.target.value)}
            />
          </label>
          <button className="primary-button" type="submit" disabled={busy || !newTitle.trim()}>
            Add
          </button>
          <button className="secondary-button" type="button" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </form>
      ) : null}

      {/*
        THE COLUMNS PANEL — everything this register has, shown and hidden.

        The hidden list is the half that matters. "Remove" on a native column
        MEANS hide, so without somewhere to see what is hidden a column would be
        removable and unrecoverable, which is a delete wearing a different word.

        The markup MOVED to `register-columns-panel.tsx` and is not merely
        extracted for tidiness: the Contractors register drew a second panel of
        its own plus a permanent block of "hidden column" chips under its rows,
        so one fact — `register_columns.hidden_at` — had three renderings.
        Both registers now mount the same component, and this grid keeps what
        was always its own: the call, and the re-read after it.
      */}
      {panelOpen && canConfigure ? (
        <RegisterColumnsPanel
          columns={columns}
          busy={busy}
          onSetHidden={(column, next) =>
            void run(() => setRegisterColumnHidden(column.id, next))
          }
        />
      ) : null}

      <div className="table-scroll">
        <table className="analytics-table analytics-table--mobile-cards register-table">
          <caption className="visually-hidden">{caption}</caption>
          <thead>
            <tr>
              {shown.map((column, index) => (
                <th key={column.id} scope="col" style={{ minWidth: `${column.width}px` }}>
                  {canConfigure ? (
                    <div className="register-column">
                      <button
                        type="button"
                        className="register-column__name"
                        aria-expanded={menuFor === column.id}
                        aria-haspopup="menu"
                        onClick={() => setMenuFor((open) => (open === column.id ? null : column.id))}
                      >
                        <span>{column.title}</span>
                        <Icon name="more" size={14} />
                      </button>
                      {menuFor === column.id ? (
                        <div className="register-column-menu" role="menu">
                          <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuFor(null); rename(column); }}>
                            Rename
                          </button>
                          <button type="button" role="menuitem" disabled={busy || index === 0} onClick={() => { setMenuFor(null); move(column, -1); }}>
                            Move left
                          </button>
                          <button type="button" role="menuitem" disabled={busy || index === shown.length - 1} onClick={() => { setMenuFor(null); move(column, 1); }}>
                            Move right
                          </button>
                          <button type="button" role="menuitem" disabled={busy} onClick={() => void run(() => resizeRegisterColumn(column.id, column.width + WIDTH_STEP))}>
                            Wider
                          </button>
                          <button type="button" role="menuitem" disabled={busy} onClick={() => void run(() => resizeRegisterColumn(column.id, column.width - WIDTH_STEP))}>
                            Narrower
                          </button>
                          <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuFor(null); void run(() => setRegisterColumnHidden(column.id, true)); }}>
                            Hide
                          </button>
                          {/*
                            OFFERED ON A NATIVE COLUMN TOO, and it is not a
                            mistake. The server answers 409 "Native columns
                            cannot be deleted. Hide it instead." and that
                            sentence is shown verbatim above — which teaches the
                            rule at the moment somebody tries to break it.
                            Hiding the control instead would leave a person
                            hunting for a Delete that is simply absent on some
                            columns and present on others, with nothing
                            anywhere saying why.
                          */}
                          <button type="button" role="menuitem" className="is-destructive" disabled={busy} onClick={() => { setMenuFor(null); void run(() => removeRegisterColumn(column.id)); }}>
                            Delete
                          </button>
                          {!column.native ? (
                            <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuFor(null); void run(() => restoreRegisterColumn(column.id)); }}>
                              Restore
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    column.title
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                {shown.map((column) => {
                  /*
                    THE ONE READER. Native reads the entity row by its field
                    name, custom reads `snap.values` by the column key — and
                    only `registerCellValue` decides which. Reaching into
                    `values` for all of them renders every native column blank,
                    which looks like missing data rather than like a bug.
                  */
                  const raw = registerCellValue(column, row, snapshot.values, row.id);
                  return (
                    <td key={column.id} data-label={column.title}>
                      {column.native || !canEditValues ? (
                        cellText(column, raw)
                      ) : (
                        /*
                          CUSTOM CELLS ONLY. A native value belongs to the site
                          or the contractor and is written through that entity's
                          own API, where its validation, its uniqueness rules
                          and its audit line already live. `writeRegisterCell`
                          refuses a native column here in the browser rather
                          than making the round trip to be told no.
                        */
                        <input
                          className="register-cell-input"
                          type="text"
                          defaultValue={raw ?? ""}
                          aria-label={`${column.title} for this row`}
                          onBlur={(event) => {
                            const next = event.target.value.trim();
                            if (next === (raw ?? "")) return;
                            void run(() =>
                              writeRegisterCell(register, column, row.id, next === "" ? null : next),
                            );
                          }}
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length ? <p className="analytics-empty">{emptyMessage}</p> : null}
      </div>
    </div>
  );
}
