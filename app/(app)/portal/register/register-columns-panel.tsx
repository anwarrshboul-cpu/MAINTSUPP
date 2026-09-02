"use client";

/**
 * THE ONE COLUMNS PANEL, for every register.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * There were two of these and a third surface doing half the job. `RegisterGrid`
 * (Sites) drew a Shown/Hidden panel; `ContractorRegister` drew a checkbox list
 * of its own; and the Contractors page ALSO drew a permanent "Hidden columns"
 * block of chips under the table, which on a register whose operator had hidden
 * twenty-five columns was twenty-five buttons sitting below the rows forever.
 * Three renderings of one fact — `register_columns.hidden_at` — is three places
 * for the fact to be shown differently, and the chip block was the proof: it
 * listed only the HIDDEN half, so "what is on this table" had no home at all.
 *
 * So the panel is a component rather than a shape two grids happen to agree on.
 * Both registers mount THIS. There is still exactly one hidden-column state and
 * it is the server's — the panel holds none of its own, takes the columns it is
 * given, and reports a press back to the grid, which calls
 * `setRegisterColumnHidden` and re-reads. A panel that remembered which columns
 * were hidden would be a second answer to a question the database already
 * answers.
 *
 * ── WHY THE CLASS NAMES ARE THE BARE ONES ────────────────────────────────
 *
 * `.register-columns-panel` is styled in `brand-overrides.css` and was, until
 * this file, the Sites grid's alone; `globals.css` carried a parallel
 * `.contractor-register__panel` list for the other one. The namespacing note in
 * `globals.css` is right that two DIFFERENT components must not answer to one
 * selector — but that is an argument for one component, which is what this is.
 * The Contractors-only list rules are gone with the markup they styled.
 */

import type { RegisterColumn } from "./register-client";

export function RegisterColumnsPanel({
  columns,
  busy,
  onSetHidden,
}: {
  /** EVERY column the register has, hidden ones included, in stored order. */
  columns: RegisterColumn[];
  /** True while any register write is in flight. Presses are refused, not queued. */
  busy: boolean;
  /** Show or hide one column. The grid owns the call and the re-read. */
  onSetHidden: (column: RegisterColumn, hidden: boolean) => void;
}) {
  /*
   * Split here rather than by asking the caller for two lists, because the
   * split IS the panel's subject: a column is on the table or it is not, and
   * a caller that could hand over a column in neither list — or in both —
   * would be a state this panel cannot draw.
   */
  const shown = columns.filter((column) => !column.hidden);
  const hidden = columns.filter((column) => column.hidden);

  return (
    <div className="register-columns-panel">
      <div>
        <h4>Shown</h4>
        {shown.length ? (
          <ul>
            {shown.map((column) => (
              <li key={column.id}>
                <span>
                  {column.title}
                  {column.native ? <small> built-in</small> : null}
                </span>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  /*
                   * The column's TITLE in the accessible name, not just "Hide".
                   * A screen reader moving through this list otherwise hears
                   * "Hide, Hide, Hide" twenty-five times with nothing to say
                   * which one is about to leave the table.
                   */
                  aria-label={`Hide ${column.title}`}
                  onClick={() => onSetHidden(column, true)}
                >
                  Hide
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="form-hint">Nothing is on the table.</p>
        )}
      </div>
      <div>
        <h4>Hidden</h4>
        {hidden.length ? (
          <ul>
            {hidden.map((column) => (
              <li key={column.id}>
                <span>
                  {column.title}
                  {column.native ? <small> built-in</small> : null}
                </span>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  aria-label={`Show ${column.title}`}
                  onClick={() => onSetHidden(column, false)}
                >
                  Show
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="form-hint">Nothing is hidden.</p>
        )}
        {/*
          A CUSTOM column removed with the Delete verb is SOFT-removed: its
          cells survive and `restoreRegisterColumn` brings both back. It stops
          appearing in either list above, so the only way to offer the undo is
          to say so here.
        */}
        <p className="form-hint">
          Deleting a column you added keeps its cells — ask an administrator to restore it.
        </p>
      </div>
    </div>
  );
}
