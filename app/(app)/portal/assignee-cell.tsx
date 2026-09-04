"use client";

/**
 * The board's "Assigned To" cell — a person picker over the workspace roster.
 *
 * WHAT IT REPLACES. This column was an `OptionCell` fed by
 * `assigneeFilterOptions`, which derives its list from the names already on the
 * board's own rows. On a workspace where nobody has been assigned yet that list
 * is empty, so the dropdown offered exactly one entry — "Unassigned" — and
 * there was no way to assign a job to anybody. See `assignee-directory.ts` for
 * where the real people come from and why they come from there.
 *
 * WHAT IT WRITES. Two columns, together:
 *
 *   · `maintenance_requests.assignee`         — the display name, unchanged in
 *                                               meaning, so every historical
 *                                               row, export, filter and
 *                                               automation keeps working;
 *   · `maintenance_requests.assignee_user_id` — the stable `users.id`.
 *
 * This mirrors the `contractor` / `contractor_id` pair exactly, and for the same
 * reason: a name is what somebody was called, an id is who they are, and a
 * product that only has the first loses a person's whole history the moment
 * they are renamed. The server derives the NAME from the ID (see
 * `PATCH /api/maintenance`), so the two can never disagree — this component
 * sends both, and the one it sends for the name is only a hint.
 *
 * SINGLE ASSIGNEE. Monday allows several people in a People column; this board
 * does not, and `app/lib/automations/catalog.ts:546` already refuses "Add
 * assignee" with "Assigned To holds one person per item on this board". The
 * cardinality is the model's, not this component's, and it is not widened here.
 *
 * THE MENU TRAP. The board runs its own dismissal (pointerdown + Escape,
 * skipping anything inside `[data-board-popover]`) alongside `AnchoredPopover`'s
 * own. `LayerPortal` stamps `data-board-popover` on the surface, so the two do
 * not fight — but `onClose` MUST be idempotent. A toggle here reads the two
 * dismissals as two clicks and re-opens the menu it just closed, which is the
 * bug this comment exists to stop somebody re-introducing.
 */

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components";
import { AnchoredPopover } from "./overlay/anchored";
import { MobileBoardContext, MobileCellSheet } from "./board-primitives";
import {
  filterMembers,
  memberColour,
  memberInitials,
  useAssigneeDirectory,
  type WorkspaceMember,
} from "./assignee-directory";
import "./assignee-cell.css";

export type AssigneeChange = {
  assignee: string | null;
  assigneeUserId: string | null;
};

/**
 * The person a cell is showing, resolved as well as it can be.
 *
 * `assignee_user_id` is authoritative when the roster knows it. A row imported
 * from monday, or assigned before this column existed, carries only the name —
 * so a name that matches exactly one person in the roster is shown as that
 * person (avatar and all) without anything being written to the database. A name
 * that matches nobody is still shown, because it is what the job records and
 * hiding it would be a silent data loss on screen.
 *
 * Pure, and exported, so the resolution rule can be tested without a browser.
 */
export function resolveAssignee(
  members: WorkspaceMember[],
  assignee: string,
  assigneeUserId: string | null,
): WorkspaceMember | null {
  if (assigneeUserId) {
    const byId = members.find((member) => member.id === assigneeUserId);
    if (byId) return byId;
  }
  const needle = assignee.trim().toLowerCase();
  if (!needle) return null;
  const matches = members.filter((member) => member.name.trim().toLowerCase() === needle);
  return matches.length === 1 ? matches[0] : null;
}

function Avatar({ member, size = 24 }: { member: WorkspaceMember; size?: number }) {
  return (
    <span
      className="assignee-avatar"
      style={{ background: memberColour(member), width: size, height: size }}
      aria-hidden="true"
    >
      {memberInitials(member)}
    </span>
  );
}

export function AssigneeCell({
  title,
  assignee,
  assigneeUserId,
  onChange,
}: {
  title: string;
  assignee: string;
  assigneeUserId: string | null;
  onChange: (change: AssigneeChange) => void;
}) {
  const mobile = useContext(MobileBoardContext);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeOverride, setActiveOverride] = useState<number | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { members, loading, error } = useAssigneeDirectory(open);

  const person = useMemo(
    () => resolveAssignee(members, assignee, assigneeUserId),
    [members, assignee, assigneeUserId],
  );
  const visible = useMemo(() => filterMembers(members, search), [members, search]);

  /*
   * "Unassigned" is row 0 and is never filtered out by the search box.
   *
   * Clearing an assignment is the one action that must always be reachable:
   * typing a name that matches nobody left a list with no rows in it and no way
   * to un-assign, which is how a mistyped search became a dead end.
   */
  const rows = useMemo(
    () => [null as WorkspaceMember | null, ...visible],
    [visible],
  );

  /*
   * THE HIGHLIGHTED ROW IS DERIVED, not stored and then corrected.
   *
   * This was two effects: one resetting the search and the highlight when the
   * picker opened, and one moving the highlight onto the current assignee.
   * Both wrote state synchronously inside an effect, which is a cascading
   * render on every open of every picker on the board — `react-hooks/
   * set-state-in-effect` was reporting exactly that, and the second effect
   * needed an exhaustive-deps suppression to stop it fighting the arrow keys.
   *
   * The default IS the current assignee's row, computed from the same `rows`
   * the list renders, so it needs no correction after the roster arrives late:
   * `person` resolves, `defaultActive` recomputes, and the highlight is simply
   * in the right place on the next render. Enter with no typing therefore
   * re-picks whoever is already assigned rather than silently un-assigning.
   *
   * `activeOverride` is what the reader has done since — arrow keys, Home/End,
   * hover, or typing. Null means "follow the assignee", and every path that
   * should forget a manual choice sets it back to null in its own handler,
   * where a state write belongs.
   */
  const defaultActive = useMemo(() => {
    if (!person) return 0;
    const index = rows.findIndex((row) => row?.id === person.id);
    return index === -1 ? 0 : index;
  }, [person, rows]);
  const active = activeOverride ?? defaultActive;

  const commit = (member: WorkspaceMember | null) => {
    setOpen(false);
    const nextId = member?.id ?? null;
    const nextName = member?.name ?? null;
    // An unchanged pick writes nothing: a PATCH that changes no column still
    // files an activity row and still tells the operator "MN-1046 updated."
    if ((assigneeUserId ?? null) === nextId && (assignee || null) === nextName) return;
    onChange({ assignee: nextName, assigneeUserId: nextId });
  };

  /*
   * Arrow / Home / End / Enter, from the search box.
   *
   * The keys are handled on the INPUT rather than on the list because the input
   * holds focus the whole time the picker is open — that is what makes
   * type-to-filter and keyboard selection the same gesture. Escape is left to
   * `AnchoredPopover`, which already closes on it and returns focus to the cell.
   */
  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = active + step;
      setActiveOverride(next < 0 ? rows.length - 1 : next >= rows.length ? 0 : next);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveOverride(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveOverride(rows.length - 1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (active >= 0 && active < rows.length) commit(rows[active]);
    }
  };

  // Keeps the highlighted row in view when the arrow keys walk past the fold.
  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    node?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const rowFor = (member: WorkspaceMember | null, index: number) => (
    <button
      key={member?.id ?? "__unassigned"}
      type="button"
      role="option"
      aria-selected={member ? person?.id === member.id : !person && !assignee}
      data-active={index === active ? "true" : undefined}
      className={`assignee-option${index === active ? " is-active" : ""}`}
      onMouseEnter={() => setActiveOverride(index)}
      onClick={() => commit(member)}
    >
      {member ? (
        <Avatar member={member} />
      ) : (
        <span className="assignee-avatar assignee-avatar--empty" aria-hidden="true">
          <Icon name="user" size={14} />
        </span>
      )}
      <span className="assignee-option__text">
        <strong>{member ? member.name : "Unassigned"}</strong>
        <small>
          {member ? member.title || member.email : "Clear the assignment"}
        </small>
      </span>
      {member?.isMe && <em className="assignee-option__me">You</em>}
      {(member ? person?.id === member.id : !person && !assignee) && (
        <Icon name="check" size={16} />
      )}
    </button>
  );

  const body = (
    <>
      <label className="assignee-search">
        <Icon name="search" size={16} />
        <input
          type="search"
          value={search}
          autoComplete="off"
          placeholder="Search people"
          aria-label={`Search people to assign to ${title}`}
          onChange={(event) => {
            setSearch(event.target.value);
            // Typing is a manual move: the first match leads, not the assignee.
            setActiveOverride(0);
          }}
          onKeyDown={onSearchKeyDown}
        />
      </label>
      <div className="assignee-list" role="listbox" aria-label={title} ref={listRef}>
        {rows.map(rowFor)}
        {loading && !members.length && <p className="assignee-note">Loading people…</p>}
        {/* A refusal is shown, never swallowed: an empty picker that says
            nothing is indistinguishable from a workspace with no people in it. */}
        {error && (
          <p className="assignee-note assignee-note--error" role="alert">
            {error}
          </p>
        )}
        {!loading && !error && !visible.length && members.length > 0 && (
          <p className="assignee-note">Nobody in this workspace matches “{search.trim()}”.</p>
        )}
        {!loading && !error && !members.length && (
          <p className="assignee-note">
            This workspace has no other active members yet. Invite somebody from
            the board&apos;s Invite dialog.
          </p>
        )}
      </div>
    </>
  );

  return (
    <div className="assignee-cell">
      <button
        ref={anchorRef}
        type="button"
        className={`assignee-trigger${person || assignee ? " is-assigned" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={person ? `${person.name}${person.email ? ` · ${person.email}` : ""}` : assignee || "Unassigned"}
        onClick={() => {
            /*
             * Opening starts clean. Done here rather than in an effect on
             * `open` — resetting in the gesture that causes it is one render,
             * and an effect was two.
             */
            const next = !open;
            setOpen(next);
            if (next) {
              setSearch("");
              setActiveOverride(null);
            }
          }}
      >
        {person ? (
          <>
            <Avatar member={person} size={22} />
            <span className="assignee-trigger__name">{person.name}</span>
          </>
        ) : assignee ? (
          <>
            {/* A name with nobody behind it — an import, or somebody who has
                since left. Shown as it is recorded, with a neutral disc, rather
                than dressed up as a member of this workspace. */}
            <span className="assignee-avatar assignee-avatar--unknown" aria-hidden="true">
              {memberInitials({ name: assignee, email: "" })}
            </span>
            <span className="assignee-trigger__name">{assignee}</span>
          </>
        ) : (
          <>
            <span className="assignee-avatar assignee-avatar--empty" aria-hidden="true">
              <Icon name="user" size={13} />
            </span>
            <span className="assignee-trigger__name assignee-trigger__name--empty">
              Unassigned
            </span>
          </>
        )}
      </button>

      {!mobile && (
        <AnchoredPopover
          open={open}
          anchorRef={anchorRef}
          /* IDEMPOTENT — see the header. Never a toggle. */
          onClose={() => setOpen(false)}
          placement="bottom-start"
          layer="popover-raised"
          role="dialog"
          label={`Assign ${title}`}
          className="assignee-popover"
          initialFocus="first"
        >
          {body}
        </AnchoredPopover>
      )}

      {mobile && open && (
        <MobileCellSheet
          title={title}
          subtitle={person ? `Assigned to ${person.name}` : assignee || "Nobody is assigned"}
          onClose={() => setOpen(false)}
          className="mobile-choice-sheet assignee-sheet"
        >
          {body}
        </MobileCellSheet>
      )}
    </div>
  );
}
