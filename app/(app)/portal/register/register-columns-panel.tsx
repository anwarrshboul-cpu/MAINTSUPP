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
 * given, and reports a press back to the grid, which makes the call and
 * re-reads. A panel that remembered which columns were hidden would be a second
 * answer to a question the database already answers.
 *
 * ── WHY ONE CHECKLIST AND NOT TWO LISTS ──────────────────────────────────
 *
 * The first version of this component drew Shown on the left and Hidden on the
 * right, which is the obvious design and the wrong one. A column moved between
 * the lists when it was toggled, so the thing under the pointer jumped to the
 * other side of the panel and the reader had to find it again to undo the
 * press. Worse, the two lists made the answer to "is this column on the table?"
 * a matter of WHICH LIST the reader happened to be looking at — twenty-five
 * entries down one side and none down the other, on the live contractors
 * register — so the panel was widest exactly when it was least useful.
 *
 * Every column appears EXACTLY ONCE, in stored order, with a checkbox that says
 * whether it is on the register. Nothing moves when it is toggled. The list is
 * one compact grid of short rows rather than a column of full-width ones,
 * because forty site columns as a single vertical list is a scroll bar over a
 * settings panel, and because the label is the only long thing on a row.
 *
 * ── WHAT THE PANEL DOES AND DOES NOT DO ──────────────────────────────────
 *
 * It renders and it reports. Every verb — show, hide, move, rename, resize,
 * pin, remove — is a CALLBACK the grid supplies, and the grid owns the request
 * and the re-read afterwards. That is not ceremony: several of these calls
 * change columns the caller did not name (a reorder renumbers every position, a
 * resize is clamped by the server, a pin unpins another column and shows this
 * one), so the snapshot the server holds is the only one that is right and the
 * panel must not be holding a second copy to merge into.
 *
 * EVERY VERB BUT SHOW/HIDE IS OPTIONAL, and a verb with no callback draws no
 * control. A register that has not wired Pin should show no Pin rather than a
 * button that does nothing — and a host adding one later gets the control by
 * passing a function, with nothing to restyle.
 *
 * IT DOES ASK ONE QUESTION OF ITS OWN, and it asks it of the shared rule rather
 * than answering it here. Move earlier and Move later are drawn disabled when
 * the press would not change the TABLE, which is not the same as "this column
 * is first in the list" — the list holds hidden columns and the frozen lane,
 * and neither is a place the reader can see a column move to or from. That was
 * the panel's one piece of local reasoning (`index === 0`) and it was wrong on
 * the register the owner has, so it now calls `canMoveRegisterColumn`, the same
 * function `orderAfterStep` moves by. Pure, stateless, and one answer: a
 * disabled button and a write that disagree is the defect this whole file is
 * organised against.
 *
 * ── WHY `<details>` AND NOT AN OPEN/CLOSED `useState` ─────────────────────
 *
 * The per-column menu is a native `<details>`. A `useState` holding which menu
 * is open would be the panel's first piece of state, and the rule above — the
 * panel remembers nothing — is much easier to keep when there is no `useState`
 * in the file at all than when there is one that a later change can quietly
 * widen. `<details>` also arrives with the keyboard behaviour, the ARIA and the
 * Escape handling already correct, and it expands IN FLOW rather than over the
 * panel, so nothing is clipped by the grid it sits in and no menu can open past
 * the edge of a phone.
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

import { canMoveRegisterColumn, type RegisterColumn } from "./register-client";

/**
 * How far one press of Wider or Narrower moves a column.
 *
 * The same twenty pixels the Sites grid's own column menu steps by, stated
 * again rather than imported because the grid imports the panel and the arrow
 * must not point back. A column resized from the header menu and one resized
 * from this panel have to move the same distance — two step sizes would read as
 * one of the controls being broken. The server clamps to `widthRange`, so a
 * press at either end of the range stops rather than failing.
 */
const WIDTH_STEP = 20;

/**
 * The checklist's layout, inline, and the reason it is not in a stylesheet.
 *
 * `repeat(auto-fill, minmax(min(100%, 172px), 1fr))` is the responsive rule
 * this panel needs and the whole of it: wide gives five or six across, narrow
 * gives fewer, and a container narrower than one item gives exactly one. The
 * `min(100%, …)` is what makes that last case WRAP rather than overflow — a
 * bare `minmax(172px, 1fr)` forces a 172px track inside a 150px panel and
 * pushes the grid out through the side of the page, which is the failure this
 * idiom exists to prevent (`brand-overrides.css` carries the same note over the
 * same fix). There is not one media query in it, so there is no width for it to
 * break at and nothing here can disagree with the five the stylesheets are
 * allowed to use.
 *
 * Inline because this component's stylesheets are being changed by another
 * hand in the same piece of work and a layout the panel cannot render without
 * should not be the half that arrives separately. It is layout only — no
 * colour, no border, no type — so moving it into `.register-columns-panel__grid`
 * later is a copy and a delete.
 */
const GRID_LAYOUT = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 172px), 1fr))",
  gap: "6px",
} as const;

export function RegisterColumnsPanel({
  columns,
  busy,
  onSetHidden,
  onMove,
  onRename,
  onResize,
  onPin,
  onRemove,
  frozenKey,
}: {
  /** EVERY column the register has, hidden ones included, in stored order. */
  columns: RegisterColumn[];
  /** True while any register write is in flight. Presses are refused, not queued. */
  busy: boolean;
  /** Show or hide one column. The grid owns the call and the re-read. */
  onSetHidden: (column: RegisterColumn, hidden: boolean) => void;
  /**
   * Move one column one place EARLIER (-1) or LATER (+1).
   *
   * A DIRECTION, NOT A DISTANCE, and the difference is the defect this signature
   * used to describe. It said "`delta` places through the FULL order, hidden
   * columns included", and that is exactly what the grid did: on a register with
   * 22 hidden columns, a press swapped a column on the table with a hidden
   * neighbour, so the metadata changed, this checklist showed it, and the table
   * did not move. `orderAfterStep` now owns what one press means — past the next
   * column ON THE TABLE — and the grid still builds the whole order from it,
   * since a list cannot express two columns in one place.
   */
  onMove?: (column: RegisterColumn, delta: number) => void;
  /**
   * Rename one column. Takes NO title: the grid already owns the prompt, its
   * wording and its trimming, and a second one here would be a second set of
   * rules about what an empty answer means.
   */
  onRename?: (column: RegisterColumn) => void;
  /** Resize to an absolute width. The server clamps, so an overshoot stops. */
  onResize?: (column: RegisterColumn, width: number) => void;
  /**
   * Freeze this column at the left of the register, or release it. Pinning
   * unpins whatever else was pinned AND shows this column — both on the server,
   * both in the same write — so the panel neither has to nor may do either.
   */
  onPin?: (column: RegisterColumn, pinned: boolean) => void;
  /**
   * The column the register is ACTUALLY freezing, when that is not the one the
   * data says is pinned.
   *
   * A register where nobody has ever pressed Pin still has a frozen lane: the
   * grid falls back to the identity column, because a row that does not say
   * whose row it is was the defect the lane was built for. On such a register
   * `column.pinned` is `false` for every column — including the one visibly
   * frozen — so a control labelled from `pinned` alone reads "Pin" on the
   * column that is already pinned, and turning the lane off takes two presses:
   * one to make the implicit state explicit, another to reverse it.
   *
   * The grid passes the key of whatever it is really freezing. Sites passes
   * nothing, and should: it persists a pin but draws no frozen lane, so there
   * the stored flag IS the whole truth and inventing one here would be a label
   * describing something the reader cannot see.
   *
   * IT ALSO DECIDES WHICH MOVES ARE OFFERED. A column drawn in a lane of its
   * own is not in the run the table orders, so no press on it — and no press
   * carrying another column over it — can change what the reader sees. Passed
   * on to `canMoveRegisterColumn` so the disabled state and the write agree;
   * omitted (Sites) it falls back to the stored pin, which is exactly what that
   * grid hoists to the front of its own run.
   */
  frozenKey?: string | null;
  /**
   * Remove a CUSTOM column. Soft: the cells survive and a restore brings both
   * back. Never offered on a native column — see the note by the control.
   */
  onRemove?: (column: RegisterColumn) => void;
}) {
  /*
   * Counted here rather than taken as props, so the two numbers cannot
   * disagree with the list they are describing. `columns` is the register.
   */
  const shownCount = columns.filter((column) => !column.hidden).length;

  return (
    <div className="register-columns-panel">
      <ul className="register-columns-panel__grid" style={GRID_LAYOUT}>
        {columns.map((column) => {
          /*
           * PINNED AS THE READER SEES IT, not only as the row records it.
           * `frozenKey` is how a fallback lane tells this panel that it is
           * frozen without a stored flag — see the prop. Everything the reader
           * is shown about the pin is derived from this one value, so the
           * badge, the hint, the button's word and the direction of the press
           * cannot disagree with each other or with the table.
           */
          const pinnedHere =
            column.pinned || (frozenKey != null && column.key === frozenKey);
          return (
          <li
            key={column.id}
            className={`register-columns-panel__item${column.hidden ? " is-hidden" : ""}${
              pinnedHere ? " is-pinned" : ""
            }`}
          >
            <label className="register-columns-panel__check">
              <input
                type="checkbox"
                checked={!column.hidden}
                disabled={busy}
                /*
                 * THE COLUMN'S TITLE IN THE ACCESSIBLE NAME, and what ticking it
                 * means. A screen reader moving down this grid otherwise hears
                 * "checkbox, checked" forty times with nothing to say which
                 * column it is about or what the tick is claiming. The visible
                 * label is inside the name rather than replaced by it, which is
                 * what lets somebody say "tick Postcode" to a voice control.
                 */
                aria-label={`Show ${column.title} on the register`}
                /*
                 * HIDING A PINNED COLUMN KEEPS THE PIN, and this tooltip used to
                 * promise the reader the opposite — "Hiding it will unpin it" —
                 * which was true of the server that shipped before
                 * `frozenRegisterColumn` learnt that visibility beats pinning.
                 * It is not true now: `PATCH /api/registers` leaves the pin
                 * alone on hide, because a hidden column is never drawn as a
                 * lane whatever its settings carry, so there is no contradiction
                 * left for the write to resolve. What the operator needs told is
                 * therefore the opposite fact — the press is REVERSIBLE, and
                 * ticking the box again brings the column back still pinned,
                 * into the frozen lane on Contractors and to the front of the
                 * run on Sites. Worded for BOTH, because this component is the
                 * one panel and a sentence naming a frozen lane would be false
                 * on the register that has none. The checkbox is not disabled:
                 * taking a column off the register is something an operator is
                 * entitled to do to any column.
                 */
                title={
                  pinnedHere
                    ? `${column.title} is pinned. Hiding it takes it off the register and keeps the pin; showing it again brings it back pinned.`
                    : undefined
                }
                onChange={(event) => onSetHidden(column, !event.target.checked)}
              />
              <span className="register-columns-panel__label">{column.title}</span>
            </label>

            {/*
              THE BADGE SAYS WHERE THE VALUE LIVES, which is the one thing about
              a column a reader cannot see from its name. A built-in column is a
              view onto a real field on the site or contractor row: it can be
              renamed, moved, resized, pinned and hidden, and it can never be
              deleted, because deleting it would be an offer to throw away the
              postcode along with the decision to stop looking at it.
            */}
            {column.native ? (
              <small className="register-columns-panel__badge">Built in</small>
            ) : null}
            {pinnedHere ? (
              <small className="register-columns-panel__pin">Pinned</small>
            ) : null}

            {/*
              ONE MENU PER COLUMN, holding every verb that is not the checkbox.
              Kept behind a disclosure rather than laid out beside the label
              because six controls per row on forty rows is a settings panel
              nobody can find a column in — and because the checkbox is what
              almost every visit here is for.
            */}
            {onMove || onRename || onResize || onPin || onRemove ? (
              <details className="register-columns-panel__menu">
                <summary className="register-columns-panel__more">
                  {/*
                    Named for the column, not "Options". A `<summary>` with no
                    text is an unnamed control, and forty of them named the same
                    thing is the same problem the checkbox's label solves.
                  */}
                  <span className="visually-hidden">{`Options for ${column.title}`}</span>
                  <span aria-hidden="true">···</span>
                </summary>
                <div className="register-columns-panel__actions">
                  {/*
                    DISABLED WHEN THE PRESS WOULD NOT MOVE THE TABLE, which is
                    not the same question as `index === 0`.

                    That test read the FULL list, so on a register with hidden
                    columns interleaved it left both buttons live on a column
                    that was already first or last ON THE TABLE — and on the
                    frozen column, which is drawn in a lane of its own and has no
                    place in the run to change. Every one of those presses wrote
                    a new order the reader could not see. `canMoveRegisterColumn`
                    is the same rule `orderAfterStep` moves by, asked before the
                    control is offered rather than discovered afterwards, so the
                    button and the write cannot disagree.
                  */}
                  {onMove ? (
                    <>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy || !canMoveRegisterColumn(columns, column, -1, frozenKey)}
                        aria-label={`Move ${column.title} earlier`}
                        onClick={() => onMove(column, -1)}
                      >
                        Move earlier
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy || !canMoveRegisterColumn(columns, column, 1, frozenKey)}
                        aria-label={`Move ${column.title} later`}
                        onClick={() => onMove(column, 1)}
                      >
                        Move later
                      </button>
                    </>
                  ) : null}

                  {onRename ? (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      aria-label={`Rename ${column.title}`}
                      onClick={() => onRename(column)}
                    >
                      Rename
                    </button>
                  ) : null}

                  {onResize ? (
                    <>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy}
                        aria-label={`Make ${column.title} wider`}
                        onClick={() => onResize(column, column.width + WIDTH_STEP)}
                      >
                        Wider
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy}
                        aria-label={`Make ${column.title} narrower`}
                        onClick={() => onResize(column, column.width - WIDTH_STEP)}
                      >
                        Narrower
                      </button>
                    </>
                  ) : null}

                  {/*
                    PIN, AND ITS NAME SAYS WHICH WAY IT WILL GO. "Pin" on an
                    already-pinned column would be a control whose label is the
                    state rather than the action, and a screen reader user has
                    no strip of frozen colour to read the state from.
                  */}
                  {onPin ? (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      aria-label={
                        pinnedHere
                          ? `Unpin ${column.title} from the left of the register`
                          : `Pin ${column.title} to the left of the register`
                      }
                      onClick={() => onPin(column, !pinnedHere)}
                    >
                      {pinnedHere ? "Unpin" : "Pin"}
                    </button>
                  ) : null}

                  {/*
                    REMOVE IS FOR CUSTOM COLUMNS ONLY, and the control is absent
                    rather than refused. The header menu offers Delete on a
                    native column deliberately, so the server's instruction —
                    "Native columns cannot be deleted. Hide it instead." — is
                    read at the moment somebody tries; here the tick that does
                    exactly that is two centimetres to the left, so a refusal
                    would teach nothing the row is not already showing.
                  */}
                  {onRemove && !column.native ? (
                    <button
                      type="button"
                      className="secondary-button is-destructive"
                      disabled={busy}
                      aria-label={`Remove ${column.title} from this register`}
                      onClick={() => onRemove(column)}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              </details>
            ) : null}
          </li>
          );
        })}
      </ul>

      {/*
        The two facts a reader of this panel needs that the grid above cannot
        show: what an unticked box costs (nothing), and what Remove costs on the
        one kind of column that has it. A CUSTOM column removed here is
        SOFT-removed — its cells survive and a restore brings both back — and it
        stops appearing in this grid at all, so this is the only place the undo
        can be offered.
      */}
      <p className="form-hint register-columns-panel__note">
        {shownCount} of {columns.length} on the register. Unticking a column keeps
        its data — nothing is deleted. A column you added keeps its cells when it
        is removed; ask an administrator to restore it.
      </p>
    </div>
  );
}
