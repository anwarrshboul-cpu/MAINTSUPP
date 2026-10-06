"use client";

/**
 * THE GROUPED BOARD — Sites and Assets laid out the way the jobs board is.
 *
 * The owner (2026-10-06): sites and assets "can be as a group … later on I can
 * name this group London", groups that can be created, moved, renamed and
 * coloured, and rows that move "if I just hold the mouse … up and down",
 * "same for the groups" — open ones at the top, closed ones at the bottom.
 *
 * One component, mounted by both pages, so the two cannot come to behave
 * differently. It owns the gesture and the group chrome; the page owns what a
 * row looks like (`renderItem`) and where a change is saved (`onArrange` and
 * the group callbacks).
 *
 * ── THE GESTURE ────────────────────────────────────────────────────────────
 *
 * Press and hold a row (or its ⠿ handle) and drag it above or below another
 * row, into another group, or onto an empty group. Press and hold a group's
 * header and drag it above or below another group. A line shows where it will
 * land. Native HTML drag-and-drop, which is what "hold the mouse" is on a
 * desktop; on a phone, where the browser does not drag, every row and group
 * has Move up / Move down / Move to … in its menu, which make exactly the same
 * change.
 *
 * ── OPEN FIRST, CLOSED LAST ───────────────────────────────────────────────
 *
 * Inside every group the rows the page marks `closed` are drawn after the open
 * ones, whatever order they were dragged into. A drag between an open and a
 * closed row is therefore ordered within its own half.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { Icon } from "../../../components";
import boardCss from "./grouped-board.css?url";

export const GROUP_PALETTE = [
  "#579bfc",
  "#00c875",
  "#fdab3d",
  "#a25ddc",
  "#e2445c",
  "#0086c0",
  "#ff642e",
  "#037f4c",
  "#757575",
  "#ff5ac4",
];

export type BoardGroup = {
  /** null is the "No group" lane — rows that belong to no group. */
  id: string | null;
  name: string;
  colour: string;
};

export type BoardItem = { id: string; groupId: string | null; closed?: boolean };

export type Arrangement = {
  /** Every real group id, in the new order. */
  groupOrder: string[];
  /** Every row id, in the new order (group by group, open before closed). */
  itemOrder: string[];
  /** The row that changed group, if one did. */
  moved: { itemId: string; fromGroupId: string | null; toGroupId: string | null } | null;
};

type Drag =
  | { kind: "item"; id: string; from: string | null }
  | { kind: "group"; id: string };

type Target =
  | { kind: "item"; id: string; after: boolean }
  | { kind: "lane"; groupId: string | null }
  | { kind: "group"; id: string; after: boolean };

const laneKey = (id: string | null) => id ?? "__none__";

/** Open rows first, closed rows after, each half keeping the order given. */
function openFirst<T extends BoardItem>(rows: T[]) {
  return [...rows.filter((row) => !row.closed), ...rows.filter((row) => row.closed)];
}

export function GroupedBoard<T extends BoardItem>({
  noun,
  groups,
  items,
  renderItem,
  canArrange,
  canEditGroups,
  onArrange,
  onAddGroup,
  onRenameGroup,
  onRecolourGroup,
  onDeleteGroup,
  storageKey,
  emptyGroupText,
}: {
  /** "site" or "asset" — used in labels: "Move site up". */
  noun: string;
  /** Real groups in their saved order. The "No group" lane is added when needed. */
  groups: BoardGroup[];
  /** Rows in their saved order; `groupId` places each one. */
  items: T[];
  renderItem: (item: T, controls: { handle: React.ReactNode; menu: React.ReactNode }) => React.ReactNode;
  canArrange: boolean;
  canEditGroups: boolean;
  onArrange: (next: Arrangement) => Promise<void> | void;
  onAddGroup?: (name: string, colour: string) => Promise<void> | void;
  onRenameGroup?: (id: string, name: string) => Promise<void> | void;
  onRecolourGroup?: (id: string, colour: string) => Promise<void> | void;
  onDeleteGroup?: (group: BoardGroup, count: number) => Promise<void> | void;
  /** Where the collapsed groups are remembered in this browser. */
  storageKey: string;
  emptyGroupText?: string;
}) {
  /* The order on screen, kept locally so a drop shows at once and the save
     happens behind it. Re-seeded whenever the page hands in new data. */
  const [groupOrder, setGroupOrder] = useState<string[]>(() => groups.map((g) => g.id).filter((id): id is string => Boolean(id)));
  const [placed, setPlaced] = useState<T[]>(items);
  /* New data from the page replaces the local order — adjusted while
     rendering, React's pattern for state derived from props. */
  const [received, setReceived] = useState({ groups, items });
  if (received.groups !== groups || received.items !== items) {
    setReceived({ groups, items });
    setGroupOrder(groups.map((g) => g.id).filter((id): id is string => Boolean(id)));
    setPlaced(items);
  }

  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const toggle = (id: string | null) => {
    setCollapsed((current) => {
      const next = new Set(current);
      const key = laneKey(id);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        /* a private window keeps it for this visit only */
      }
      return next;
    });
  };

  const groupById = useMemo(() => new Map(groups.map((g) => [laneKey(g.id), g])), [groups]);
  const lanes = useMemo(() => {
    const ordered: BoardGroup[] = groupOrder
      .map((id) => groupById.get(id))
      .filter((g): g is BoardGroup => Boolean(g));
    const known = new Set(ordered.map((g) => laneKey(g.id)));
    const orphan = placed.some((row) => !row.groupId || !known.has(laneKey(row.groupId)));
    if (orphan) ordered.push({ id: null, name: "No group", colour: "#9aa5b1" });
    return ordered.map((group) => ({
      group,
      rows: openFirst(
        placed.filter((row) =>
          group.id === null ? !row.groupId || !known.has(laneKey(row.groupId)) : row.groupId === group.id,
        ),
      ),
    }));
  }, [groupOrder, groupById, placed]);

  /* ── the save ─────────────────────────────────────────────────────────── */

  const commit = useCallback(
    (nextGroups: string[], nextRows: T[], moved: Arrangement["moved"]) => {
      setGroupOrder(nextGroups);
      setPlaced(nextRows);
      const byLane = nextGroups.map((id) => openFirst(nextRows.filter((row) => row.groupId === id)));
      const known = new Set(nextGroups);
      const rest = openFirst(nextRows.filter((row) => !row.groupId || !known.has(row.groupId)));
      void onArrange({
        groupOrder: nextGroups,
        itemOrder: [...byLane.flat(), ...rest].map((row) => row.id),
        moved,
      });
    },
    [onArrange],
  );

  const moveItem = useCallback(
    (id: string, toGroup: string | null, beforeId: string | null) => {
      const row = placed.find((entry) => entry.id === id);
      if (!row) return;
      const from = row.groupId ?? null;
      const updated = { ...row, groupId: toGroup } as T;
      const without = placed.filter((entry) => entry.id !== id);
      let index = beforeId ? without.findIndex((entry) => entry.id === beforeId) : -1;
      if (index < 0) {
        /* to the end of the target lane */
        const lastInLane = [...without].reverse().find((entry) => (entry.groupId ?? null) === toGroup);
        index = lastInLane ? without.indexOf(lastInLane) + 1 : without.length;
      }
      const next = [...without.slice(0, index), updated, ...without.slice(index)];
      commit(groupOrder, next, from !== toGroup ? { itemId: id, fromGroupId: from, toGroupId: toGroup } : null);
    },
    [commit, groupOrder, placed],
  );

  const moveGroup = useCallback(
    (id: string, beforeId: string | null) => {
      const without = groupOrder.filter((entry) => entry !== id);
      const index = beforeId ? without.indexOf(beforeId) : without.length;
      const next = [...without.slice(0, index < 0 ? without.length : index), id, ...without.slice(index < 0 ? without.length : index)];
      if (next.join() === groupOrder.join()) return;
      commit(next, placed, null);
    },
    [commit, groupOrder, placed],
  );

  /* ── drag and drop ───────────────────────────────────────────────────── */

  const drag = useRef<Drag | null>(null);
  const [target, setTargetState] = useState<Target | null>(null);
  /* The drop reads the ref: a fast drop can arrive before React has drawn the
     last dragover's state, and a drop that read a stale target did nothing. */
  const targetRef = useRef<Target | null>(null);
  const setTarget = (next: Target | null) => {
    targetRef.current = next;
    setTargetState(next);
  };
  const [dragging, setDragging] = useState<string | null>(null);

  const endDrag = () => {
    drag.current = null;
    setTarget(null);
    setDragging(null);
  };

  const afterHalf = (event: React.DragEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientY > box.top + box.height / 2;
  };

  const drop = () => {
    const source = drag.current;
    const at = targetRef.current;
    endDrag();
    if (!source || !at) return;
    if (source.kind === "item") {
      if (at.kind === "item") {
        if (at.id === source.id) return;
        const lane = lanes.find((entry) => entry.rows.some((row) => row.id === at.id));
        if (!lane) return;
        const rows = lane.rows.filter((row) => row.id !== source.id);
        const index = rows.findIndex((row) => row.id === at.id) + (at.after ? 1 : 0);
        moveItem(source.id, lane.group.id, rows[index]?.id ?? null);
      } else if (at.kind === "lane") {
        moveItem(source.id, at.groupId, null);
      } else if (at.kind === "group") {
        moveItem(source.id, at.id, null);
      }
      return;
    }
    if (source.kind === "group" && at.kind === "group" && at.id !== source.id) {
      const others = groupOrder.filter((id) => id !== source.id);
      const index = others.indexOf(at.id) + (at.after ? 1 : 0);
      moveGroup(source.id, others[index] ?? null);
    }
  };

  /* ── the group chrome ────────────────────────────────────────────────── */

  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState("");

  const rowMenu = (row: T, laneIndex: number, rowIndex: number) => {
    if (!canArrange) return null;
    const lane = lanes[laneIndex];
    const open = menu === `row:${row.id}`;
    return (
      <span className="gboard-menu">
        <button
          type="button"
          className="gboard-icon-button"
          aria-label={`Move this ${noun}`}
          title={`Move this ${noun}`}
          aria-expanded={open}
          onClick={() => setMenu(open ? null : `row:${row.id}`)}
        >
          <Icon name="list" size={15} />
        </button>
        {open ? (
          <span className="gboard-menu__list" role="menu">
            <button
              type="button"
              role="menuitem"
              disabled={rowIndex === 0}
              onClick={() => {
                setMenu(null);
                moveItem(row.id, lane.group.id, lane.rows[rowIndex - 1]?.id ?? null);
              }}
            >
              Move up
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={rowIndex === lane.rows.length - 1}
              onClick={() => {
                setMenu(null);
                moveItem(row.id, lane.group.id, lane.rows[rowIndex + 2]?.id ?? null);
              }}
            >
              Move down
            </button>
            {lanes
              .filter((other) => other.group.id !== lane.group.id && other.group.id !== null)
              .map((other) => (
                <button
                  key={laneKey(other.group.id)}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(null);
                    moveItem(row.id, other.group.id, null);
                  }}
                >
                  Move to {other.group.name}
                </button>
              ))}
          </span>
        ) : null}
      </span>
    );
  };

  return (
    <div className="gboard" onDragEnd={endDrag}>
      <link rel="stylesheet" href={boardCss} precedence="default" />
      {lanes.map(({ group, rows }, laneIndex) => {
        const key = laneKey(group.id);
        const isCollapsed = collapsed.has(key);
        const groupTarget =
          target?.kind === "group" && target.id === group.id ? (target.after ? "after" : "before") : null;
        const laneTarget = target?.kind === "lane" && target.groupId === group.id;
        const real = group.id !== null;
        return (
          <section
            key={key}
            className={`gboard-group${groupTarget ? ` is-drop-${groupTarget}` : ""}${laneTarget ? " is-drop-into" : ""}${dragging === key ? " is-dragging" : ""}`}
            style={{ ["--gboard-colour" as string]: group.colour }}
            aria-label={`${group.name}, ${rows.length} ${rows.length === 1 ? noun : `${noun}s`}`}
          >
            <header
              className="gboard-group__head"
              draggable={canArrange && real && renaming !== group.id}
              onDragStart={(event) => {
                if (!real) return;
                drag.current = { kind: "group", id: group.id! };
                setDragging(key);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", group.name);
              }}
              onDragOver={(event) => {
                const source = drag.current;
                if (!source) return;
                event.preventDefault();
                if (source.kind === "group" && real) {
                  setTarget({ kind: "group", id: group.id!, after: afterHalf(event) });
                } else if (source.kind === "item") {
                  setTarget({ kind: "lane", groupId: group.id });
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                drop();
              }}
            >
              {canArrange && real ? (
                <span className="gboard-handle" aria-hidden="true" title="Hold and drag to move this group">
                  ⠿
                </span>
              ) : null}
              <button
                type="button"
                className="gboard-group__toggle"
                aria-expanded={!isCollapsed}
                aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${group.name}`}
                onClick={() => toggle(group.id)}
              >
                <Icon name="chevron" size={14} />
              </button>
              {renaming === group.id && real ? (
                <form
                  className="gboard-rename"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    const name = draftName.trim();
                    setRenaming(null);
                    if (name && name !== group.name) await onRenameGroup?.(group.id!, name);
                  }}
                >
                  <input
                    aria-label="Group name"
                    value={draftName}
                    autoFocus
                    maxLength={120}
                    onChange={(event) => setDraftName(event.target.value)}
                    onBlur={(event) => event.currentTarget.form?.requestSubmit()}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setRenaming(null);
                    }}
                  />
                </form>
              ) : (
                <h2
                  className="gboard-group__name"
                  onDoubleClick={() => {
                    if (!canEditGroups || !real) return;
                    setDraftName(group.name);
                    setRenaming(group.id);
                  }}
                >
                  {group.name}
                </h2>
              )}
              <span className="gboard-group__count">
                {rows.length} {rows.length === 1 ? noun : `${noun}s`}
                {rows.some((row) => row.closed)
                  ? ` · ${rows.filter((row) => row.closed).length} closed`
                  : ""}
              </span>
              {canEditGroups && real ? (
                <span className="gboard-menu gboard-group__menu">
                  <button
                    type="button"
                    className="gboard-icon-button"
                    aria-label={`Options for ${group.name}`}
                    aria-expanded={menu === `group:${group.id}`}
                    onClick={() => setMenu(menu === `group:${group.id}` ? null : `group:${group.id}`)}
                  >
                    <Icon name="more" size={16} />
                  </button>
                  {menu === `group:${group.id}` ? (
                    <span className="gboard-menu__list" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenu(null);
                          setDraftName(group.name);
                          setRenaming(group.id);
                        }}
                      >
                        Rename group
                      </button>
                      <span className="gboard-swatches" role="group" aria-label="Group colour">
                        {GROUP_PALETTE.map((colour) => (
                          <button
                            key={colour}
                            type="button"
                            className="gboard-swatch"
                            style={{ background: colour }}
                            aria-label={`Colour ${colour}`}
                            aria-pressed={colour.toLowerCase() === group.colour.toLowerCase()}
                            onClick={async () => {
                              setMenu(null);
                              await onRecolourGroup?.(group.id!, colour);
                            }}
                          />
                        ))}
                      </span>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={laneIndex === 0}
                        onClick={() => {
                          setMenu(null);
                          moveGroup(group.id!, groupOrder[groupOrder.indexOf(group.id!) - 1] ?? null);
                        }}
                      >
                        Move group up
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={groupOrder.indexOf(group.id!) === groupOrder.length - 1}
                        onClick={() => {
                          setMenu(null);
                          moveGroup(group.id!, groupOrder[groupOrder.indexOf(group.id!) + 2] ?? null);
                        }}
                      >
                        Move group down
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="is-destructive"
                        onClick={async () => {
                          setMenu(null);
                          await onDeleteGroup?.(group, rows.length);
                        }}
                      >
                        Delete group
                      </button>
                    </span>
                  ) : null}
                </span>
              ) : null}
            </header>

            {isCollapsed ? null : (
              <div
                className="gboard-group__rows"
                onDragOver={(event) => {
                  if (drag.current?.kind !== "item") return;
                  event.preventDefault();
                  if (!rows.length) setTarget({ kind: "lane", groupId: group.id });
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  drop();
                }}
              >
                {rows.length === 0 ? (
                  <p className="gboard-empty">
                    {emptyGroupText ?? `No ${noun}s in this group.`}
                    {canArrange ? ` Drag ${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun} here to add it.` : ""}
                  </p>
                ) : (
                  rows.map((row, rowIndex) => {
                    const rowTarget =
                      target?.kind === "item" && target.id === row.id ? (target.after ? "after" : "before") : null;
                    return (
                      <div
                        key={row.id}
                        className={`gboard-row${rowTarget ? ` is-drop-${rowTarget}` : ""}${dragging === row.id ? " is-dragging" : ""}${row.closed ? " is-closed" : ""}`}
                        draggable={canArrange}
                        onDragStart={(event) => {
                          event.stopPropagation();
                          drag.current = { kind: "item", id: row.id, from: row.groupId ?? null };
                          setDragging(row.id);
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", row.id);
                        }}
                        onDragOver={(event) => {
                          if (drag.current?.kind !== "item") return;
                          event.preventDefault();
                          event.stopPropagation();
                          setTarget({ kind: "item", id: row.id, after: afterHalf(event) });
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          drop();
                        }}
                      >
                        {renderItem(row, {
                          handle: canArrange ? (
                            <span className="gboard-handle" aria-hidden="true" title={`Hold and drag to move this ${noun}`}>
                              ⠿
                            </span>
                          ) : null,
                          menu: rowMenu(row, laneIndex, rowIndex),
                        })}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </section>
        );
      })}

      {canEditGroups && onAddGroup ? (
        adding ? (
          <form
            className="gboard-add"
            onSubmit={async (event) => {
              event.preventDefault();
              const name = draftName.trim();
              if (!name) return;
              setAdding(false);
              setDraftName("");
              await onAddGroup(name, GROUP_PALETTE[groups.length % GROUP_PALETTE.length]);
            }}
          >
            <input
              aria-label="New group name"
              placeholder="Group name, e.g. London"
              value={draftName}
              autoFocus
              maxLength={120}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setAdding(false);
              }}
            />
            <button type="submit" className="primary-button">
              Add group
            </button>
            <button type="button" className="secondary-button" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="secondary-button gboard-add-button"
            onClick={() => {
              setDraftName("");
              setAdding(true);
            }}
          >
            <Icon name="plus" size={15} /> Add new group
          </button>
        )
      ) : null}
    </div>
  );
}
