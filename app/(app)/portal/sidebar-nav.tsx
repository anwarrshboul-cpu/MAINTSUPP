"use client";

/**
 * Stage 20 — the customisable sidebar.
 *
 * The sidebar used to be two literal arrays. It is now a rendering of whatever
 * `resolveNavigation` returns, and the arrays survive only as the built-in
 * layer underneath everything else. Read `app/api/navigation/layout.ts` first:
 * it holds the merge, and this file is mostly the hands on it.
 *
 * THE CATALOGUE COMES FROM THE CALLER, ON PURPOSE
 *
 * `portal-app.tsx` derives the catalogue from `sectionMeta` — the map it uses
 * to draw a section — and hands it in. So the list of things that can appear in
 * the nav is, by construction, the list of things the app can actually render.
 * A section added to `sectionMeta` appears here with no change to this file and
 * no migration of anybody's saved layout; a key in somebody's saved layout that
 * is no longer in `sectionMeta` is dropped rather than drawn as a link to a
 * page that no longer exists. "Add" can only ever put back something from this
 * catalogue, which is why it cannot invent a destination that 404s.
 *
 * NOTHING HERE IS A SECURITY BOUNDARY
 *
 * The lock affordances below are conveniences. The rule is enforced in
 * `PUT /api/navigation`, which rejects a payload that hides or renames a locked
 * item whatever the buttons in this file are doing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon, type IconName } from "../../components";
import sidebarNavCss from "./sidebar-nav.css?url";
import {
  BUILT_IN_GROUPS,
  GROUP_PREFIX,
  isGroupKey,
  resolveNavigation,
  type NavArrangementItem,
  type NavCatalogueEntry,
} from "../../api/navigation/layout";

export type SidebarNavEntry = NavCatalogueEntry & { icon: IconName };

type Arrangement = {
  workspace: NavArrangementItem[];
  user: NavArrangementItem[] | null;
};

type Scope = "user" | "workspace";

type NavigationResponse = {
  arrangement?: { workspace?: unknown; user?: unknown };
  locked?: unknown;
  canEditDefault?: boolean;
  canEditOwn?: boolean;
};

const EMPTY: Arrangement = { workspace: [], user: null };

/** Rebuild `position` after every structural change so the array stays honest. */
function renumber(rows: NavArrangementItem[]): NavArrangementItem[] {
  let group: string | null = null;
  return rows.map((row, index) => {
    if (row.kind === "group") {
      group = row.key;
      return { ...row, group: null, position: index };
    }
    return { ...row, group, position: index };
  });
}

/** The rows belonging to a heading: the heading itself and all items under it. */
function groupBlock(rows: NavArrangementItem[], key: string) {
  const start = rows.findIndex((row) => row.key === key);
  if (start < 0) return null;
  let end = start + 1;
  while (end < rows.length && rows[end].kind !== "group") end += 1;
  return { start, end };
}

export function SidebarNav({
  catalogue,
  activeSection,
  onSelect,
  badges,
  badgeDescriptions,
  onNotify,
}: {
  /** What the app can actually navigate to, in built-in order. */
  catalogue: SidebarNavEntry[];
  activeSection: string;
  onSelect: (key: string) => void;
  /** Counts drawn as a pill, keyed by section. */
  badges?: Record<string, number>;
  /**
   * What each badge counts, keyed the same way — "urgent jobs", not "unread".
   *
   * A bare red bubble on a nav item is the same shape the notification bell
   * uses, so it reads as an unread count, and it was being reported as a
   * notification badge that would not clear. It never could: `maintenance`
   * carries the number of open Urgent jobs, and marking notifications read has
   * nothing to do with it. The number is right; only its silence was wrong.
   *
   * Optional, so a caller that adds a badge without a description still gets a
   * badge rather than a crash — it just stays as mute as this one was.
   */
  badgeDescriptions?: Record<string, string>;
  onNotify?: (message: string) => void;
}) {
  const [arrangement, setArrangement] = useState<Arrangement>(EMPTY);
  const [locked, setLocked] = useState<string[]>([]);
  const [canEditDefault, setCanEditDefault] = useState(false);
  const [canEditOwn, setCanEditOwn] = useState(true);
  const [editing, setEditing] = useState(false);
  const [scope, setScope] = useState<Scope>("user");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  /*
   * The dragged key lives in a ref as well as in state, and the ref is what the
   * drop handler reads. State drives the dimmed row; a ref is the only thing
   * guaranteed to be correct by the time `drop` fires, because `dragstart` and
   * `drop` can land in the same tick and React will not have re-rendered in
   * between. A drop that silently does nothing is the worst kind of bug in a
   * drag interface, so it does not depend on a render having happened.
   */
  const dragKeyRef = useRef<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const beginDrag = useCallback((key: string) => {
    dragKeyRef.current = key;
    setDragKey(key);
  }, []);
  const endDrag = useCallback(() => {
    dragKeyRef.current = null;
    setDragKey(null);
  }, []);
  const [dropHint, setDropHint] = useState<{ key: string; before: boolean } | null>(
    null,
  );
  const [status, setStatus] = useState("");
  const saveTimer = useRef<number | null>(null);
  const pending = useRef<{ scope: Scope; items: NavArrangementItem[]; locked: string[] } | null>(
    null,
  );

  const catalogueKeys = useMemo(
    () => catalogue.map((entry) => entry.key).join(","),
    [catalogue],
  );
  const iconFor = useMemo(() => {
    const map = new Map<string, IconName>();
    for (const entry of catalogue) map.set(entry.key, entry.icon);
    return map;
  }, [catalogue]);
  const builtInLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of catalogue) map.set(entry.key, entry.label);
    for (const group of BUILT_IN_GROUPS) map.set(group.key, group.label);
    return map;
  }, [catalogue]);

  const load = useCallback(async () => {
    const response = await fetch(
      `/api/navigation?sections=${encodeURIComponent(catalogueKeys)}`,
      { headers: { Accept: "application/json" } },
    );
    if (!response.ok) return;
    const payload = (await response.json()) as NavigationResponse;
    setArrangement({
      workspace: Array.isArray(payload.arrangement?.workspace)
        ? (payload.arrangement!.workspace as NavArrangementItem[])
        : [],
      user: Array.isArray(payload.arrangement?.user)
        ? (payload.arrangement!.user as NavArrangementItem[])
        : null,
    });
    setLocked(Array.isArray(payload.locked) ? (payload.locked as string[]) : []);
    setCanEditDefault(payload.canEditDefault === true);
    setCanEditOwn(payload.canEditOwn !== false);
  }, [catalogueKeys]);

  /* Deferred by a zero-delay timer, matching every other loader in the portal:
     the first paint is the built-in order, and the stored arrangement replaces
     it a tick later. A layout that fails to load must never take the sidebar
     with it — the built-in order is already on screen and simply stays. */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  /*
   * The three layers, merged for rendering.
   *
   * When an admin is editing the workspace default their own arrangement is
   * deliberately taken out of the stack — otherwise they would be editing the
   * default while looking at their personal overrides of it, and every change
   * would appear not to work.
   */
  const resolved = useMemo(
    () =>
      resolveNavigation({
        catalogue,
        workspaceItems: arrangement.workspace,
        userItems: scope === "workspace" && editing ? null : arrangement.user,
        locked,
      }),
    [catalogue, arrangement, locked, scope, editing],
  );

  const rows = useMemo(() => {
    const flat: NavArrangementItem[] = [];
    for (const group of resolved.groups) {
      flat.push({
        key: group.key,
        kind: "group",
        label: group.renamed || group.custom ? group.label : null,
        hidden: false,
        group: null,
        position: flat.length,
      });
      for (const item of group.items) {
        flat.push({
          key: item.key,
          kind: "section",
          label: item.renamed ? item.label : null,
          hidden: item.hidden,
          group: group.key,
          position: flat.length,
        });
      }
    }
    return flat;
  }, [resolved]);

  const appeared = useMemo(() => new Set(resolved.appeared), [resolved]);

  const flush = useCallback(async () => {
    const job = pending.current;
    if (!job) return;
    pending.current = null;
    const response = await fetch("/api/navigation", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: job.scope,
        items: job.items,
        ...(job.scope === "workspace" ? { locked: job.locked } : {}),
      }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      onNotify?.(payload.error || "The sidebar layout could not be saved.");
      // The server refused, so the server is right. Re-read rather than leaving
      // the screen showing an arrangement that was never stored.
      await load().catch(() => {});
    }
  }, [load, onNotify]);

  const schedule = useCallback(
    (items: NavArrangementItem[], lockedKeys: string[], nextScope: Scope) => {
      pending.current = { scope: nextScope, items, locked: lockedKeys };
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        void flush();
      }, 400);
    },
    [flush],
  );

  useEffect(
    () => () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  const commit = useCallback(
    (next: NavArrangementItem[], message: string, lockedKeys = locked) => {
      const items = renumber(next);
      setArrangement((prev) =>
        scope === "workspace"
          ? { ...prev, workspace: items }
          : { ...prev, user: items },
      );
      if (lockedKeys !== locked) setLocked(lockedKeys);
      setStatus(message);
      schedule(items, lockedKeys, scope);
    },
    [locked, schedule, scope],
  );

  const labelOf = useCallback(
    (row: NavArrangementItem) =>
      row.label ?? builtInLabels.get(row.key) ?? row.key,
    [builtInLabels],
  );

  /* ── reordering ─────────────────────────────────────────────────────────── */

  /**
   * Move one row up or down.
   *
   * A heading moves as a block, taking its items with it. A section swaps with
   * its neighbour, and crossing a heading is how it changes group — moving up
   * past a heading lands it at the bottom of the group above, which is what the
   * same drag would do.
   */
  const move = useCallback(
    (key: string, delta: -1 | 1) => {
      const next = [...rows];
      const index = next.findIndex((row) => row.key === key);
      if (index < 0) return;
      const row = next[index];

      if (row.kind === "group") {
        const block = groupBlock(next, key);
        if (!block) return;
        const slice = next.splice(block.start, block.end - block.start);
        if (delta === -1) {
          // Land immediately before the heading that now precedes us.
          let target = block.start - 1;
          while (target > 0 && next[target].kind !== "group") target -= 1;
          if (target < 0) {
            next.splice(block.start, 0, ...slice);
            return;
          }
          next.splice(target, 0, ...slice);
        } else {
          let target = block.start;
          if (target >= next.length) {
            next.splice(block.start, 0, ...slice);
            return;
          }
          target += 1;
          while (target < next.length && next[target].kind !== "group") target += 1;
          next.splice(target, 0, ...slice);
        }
        commit(next, `${labelOf(row)} section moved.`);
        return;
      }

      const neighbourIndex = index + delta;
      if (neighbourIndex < 0 || neighbourIndex >= next.length) return;
      const neighbour = next[neighbourIndex];
      // Never above the first heading: an item with no heading over it has no
      // group, and the resolver would have to invent one.
      if (delta === -1 && neighbourIndex === 0 && neighbour.kind === "group") return;
      next.splice(index, 1);
      next.splice(neighbourIndex, 0, row);
      const landed = renumber(next).find((item) => item.key === key);
      commit(
        next,
        `${labelOf(row)} moved ${delta === -1 ? "up" : "down"}${
          landed?.group && landed.group !== row.group
            ? ` into ${builtInLabels.get(landed.group) ??
              next.find((item) => item.key === landed.group)?.label ??
              "another section"}`
            : ""
        }.`,
      );
    },
    [builtInLabels, commit, labelOf, rows],
  );

  /** Drag-and-drop lands a row before or after whichever row it was dropped on. */
  const dropOn = useCallback(
    (targetKey: string, before: boolean) => {
      const key = dragKeyRef.current;
      endDrag();
      setDropHint(null);
      if (!key || key === targetKey) return;
      const next = [...rows];
      const from = next.findIndex((row) => row.key === key);
      if (from < 0) return;
      const row = next[from];
      const slice =
        row.kind === "group"
          ? (() => {
              const block = groupBlock(next, key);
              return block ? next.splice(block.start, block.end - block.start) : [];
            })()
          : next.splice(from, 1);
      if (!slice.length) return;
      // A heading may not be dropped inside another heading's items, and a
      // section may not be dropped above the first heading.
      let at = next.findIndex((item) => item.key === targetKey);
      if (at < 0) {
        next.push(...slice);
      } else {
        at = before ? at : at + 1;
        if (row.kind === "section" && at === 0) at = 1;
        next.splice(at, 0, ...slice);
      }
      commit(next, `${labelOf(row)} moved.`);
    },
    [commit, endDrag, labelOf, rows],
  );

  /* ── hide, show, rename, group, lock ────────────────────────────────────── */

  const setHidden = useCallback(
    (key: string, hidden: boolean) => {
      if (hidden && locked.includes(key) && scope !== "workspace") {
        onNotify?.("That item is locked by an administrator and cannot be hidden.");
        return;
      }
      const next = rows.map((row) =>
        row.key === key ? { ...row, hidden } : row,
      );
      const stillVisible = next.filter(
        (row) => row.kind === "section" && !row.hidden,
      );
      if (!stillVisible.length) {
        // The last visible item. Refused here as well as forced back on by the
        // resolver, because "you cannot empty your own sidebar" is easier to
        // understand as a message than as a row that silently reappears.
        onNotify?.("At least one item has to stay in the sidebar.");
        return;
      }
      const label = labelOf(rows.find((row) => row.key === key)!);
      commit(next, hidden ? `${label} hidden.` : `${label} restored.`);
      // Never strand the user on a page they just removed the way back to.
      if (hidden && key === activeSection) {
        const fallback = stillVisible[0]?.key;
        if (fallback) onSelect(fallback);
      }
    },
    [activeSection, commit, labelOf, locked, onNotify, onSelect, rows, scope],
  );

  const applyRename = useCallback(
    (key: string, raw: string) => {
      setRenaming(null);
      if (locked.includes(key) && scope !== "workspace") {
        onNotify?.("That item is locked by an administrator and cannot be renamed.");
        return;
      }
      const value = raw.trim().slice(0, 60);
      const builtIn = builtInLabels.get(key) ?? null;
      const custom = isGroupKey(key) && !builtIn;
      // Clearing a rename restores the product's own name — except for a
      // heading the user created, which has no name to fall back to.
      const label = !value ? (custom ? "Section" : null) : value === builtIn ? null : value;
      const next = rows.map((row) => (row.key === key ? { ...row, label } : row));
      commit(next, `Renamed to ${label ?? builtIn ?? "its original name"}.`);
    },
    [builtInLabels, commit, locked, onNotify, rows, scope],
  );

  const addGroup = useCallback(() => {
    const key = `${GROUP_PREFIX}custom-${Math.random().toString(36).slice(2, 8)}`;
    const next = [
      ...rows,
      {
        key,
        kind: "group" as const,
        label: "New section",
        hidden: false,
        group: null,
        position: rows.length,
      },
    ];
    commit(next, "Heading added.");
    setRenaming(key);
    setRenameDraft("New section");
  }, [commit, rows]);

  const removeGroup = useCallback(
    (key: string) => {
      // Only the heading goes. Its items merge into the group above, so
      // deleting a heading can never take nav items away with it.
      const index = rows.findIndex((row) => row.key === key);
      if (index <= 0) return;
      const next = rows.filter((row) => row.key !== key);
      commit(next, "Heading removed. Its items moved up.");
    },
    [commit, rows],
  );

  const toggleLock = useCallback(
    (key: string) => {
      const next = locked.includes(key)
        ? locked.filter((item) => item !== key)
        : [...locked, key];
      // Locking implies visible: an item nobody may hide cannot start hidden.
      const items = rows.map((row) =>
        row.key === key && next.includes(key)
          ? { ...row, hidden: false, label: null }
          : row,
      );
      commit(items, next.includes(key) ? "Item locked on." : "Item unlocked.", next);
    },
    [commit, locked, rows],
  );

  const reset = useCallback(async () => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    pending.current = null;
    const response = await fetch("/api/navigation", { method: "DELETE" });
    if (!response.ok) {
      onNotify?.("The sidebar could not be reset.");
      return;
    }
    setScope("user");
    await load().catch(() => {});
    setStatus("Sidebar reset to the workspace default.");
    onNotify?.("Sidebar reset to the workspace default.");
  }, [load, onNotify]);

  /* ── keyboard ───────────────────────────────────────────────────────────── */

  /**
   * The keyboard equivalent of dragging.
   *
   * Alt+Up / Alt+Down moves the focused row. The modifier is there so plain
   * arrow keys still do what they do everywhere else, and the visible ▲ ▼
   * buttons carry the same action for anybody who never discovers the shortcut.
   * Every move writes to the live region below, so the outcome is spoken rather
   * than only seen.
   */
  const onRowKeyDown = useCallback(
    (event: ReactKeyboardEvent, key: string) => {
      if (!editing) return;
      if ((event.altKey || event.metaKey) && event.key === "ArrowUp") {
        event.preventDefault();
        move(key, -1);
        return;
      }
      if ((event.altKey || event.metaKey) && event.key === "ArrowDown") {
        event.preventDefault();
        move(key, 1);
      }
    },
    [editing, move],
  );

  const hiddenItems = resolved.flat.filter((item) => item.hidden);
  const editable = editing && (scope === "user" ? canEditOwn : canEditDefault);

  return (
    <>
      <link rel="stylesheet" href={sidebarNavCss} precedence="default" />
      <nav className="portal-nav" aria-label="Main navigation">
        {resolved.groups.map((group, groupIndex) => {
          const shown = group.items.filter(
            (item) => !item.hidden || editing || item.key === activeSection,
          );
          // An empty heading is noise outside edit mode; inside it, it is a
          // drop target and has to stay.
          if (!shown.length && !editing) return null;
          return (
            <div className="nav-group" key={group.key}>
              <div
                className={`nav-label${groupIndex > 0 ? " nav-label--spaced" : ""}${
                  editing ? " nav-label--editing" : ""
                }${dropHint?.key === group.key ? " is-drop-target" : ""}`}
                data-nav-group={group.key}
                draggable={editable}
                onDragStart={(event) => {
                  if (!editable) return;
                  // Firefox refuses to start a drag with an empty payload.
                  event.dataTransfer.setData("text/plain", group.key);
                  beginDrag(group.key);
                }}
                onDragOver={(event) => {
                  if (!editable || !dragKeyRef.current) return;
                  event.preventDefault();
                  setDropHint({ key: group.key, before: true });
                }}
                onDrop={(event) => {
                  if (!editable) return;
                  event.preventDefault();
                  // Dropping a *section* on a heading means "put it in here",
                  // so it lands after the heading as its first item. Dropping a
                  // *heading* on a heading means "put this group above that
                  // one", so it lands before.
                  const dragged = dragKeyRef.current;
                  dropOn(group.key, dragged ? isGroupKey(dragged) : true);
                }}
                onKeyDown={(event) => onRowKeyDown(event, group.key)}
                tabIndex={editable ? 0 : -1}
                aria-label={editable ? `${group.label} heading` : undefined}
              >
                {renaming === group.key ? (
                  <input
                    className="nav-rename"
                    autoFocus
                    aria-label={`Rename ${group.builtInLabel} heading`}
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onBlur={() => applyRename(group.key, renameDraft)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") applyRename(group.key, renameDraft);
                      if (event.key === "Escape") setRenaming(null);
                      event.stopPropagation();
                    }}
                  />
                ) : (
                  <span className="nav-label__text">{group.label}</span>
                )}
                {editable && renaming !== group.key && (
                  <span className="nav-row-actions nav-row-actions--group">
                    <button
                      type="button"
                      aria-label={`Move ${group.label} heading up`}
                      onClick={() => move(group.key, -1)}
                    >
                      <Icon name="chevron" size={13} className="nav-caret nav-caret--up" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${group.label} heading down`}
                      onClick={() => move(group.key, 1)}
                    >
                      <Icon name="chevron" size={13} className="nav-caret nav-caret--down" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Rename ${group.label} heading`}
                      onClick={() => {
                        setRenaming(group.key);
                        setRenameDraft(group.label);
                      }}
                    >
                      <Icon name="tool" size={13} />
                    </button>
                    {group.custom && (
                      <button
                        type="button"
                        aria-label={`Remove ${group.label} heading`}
                        onClick={() => removeGroup(group.key)}
                      >
                        <Icon name="close" size={13} />
                      </button>
                    )}
                  </span>
                )}
              </div>

              {shown.map((item) => {
                const transient = item.hidden && !editing;
                const count = badges?.[item.key] ?? 0;
                const countLabel = badgeDescriptions?.[item.key];
                const isDrop = dropHint?.key === item.key;
                return (
                  <div
                    className={`nav-row${editing ? " nav-row--editing" : ""}${
                      isDrop ? ` is-drop-${dropHint!.before ? "before" : "after"}` : ""
                    }${dragKey === item.key ? " is-dragging" : ""}`}
                    key={item.key}
                    draggable={editable}
                    onDragStart={(event) => {
                      if (!editable) return;
                      event.dataTransfer.setData("text/plain", item.key);
                      beginDrag(item.key);
                    }}
                    onDragEnd={() => {
                      endDrag();
                      setDropHint(null);
                    }}
                    onDragOver={(event) => {
                      if (!editable || !dragKeyRef.current) return;
                      event.preventDefault();
                      const box = event.currentTarget.getBoundingClientRect();
                      setDropHint({
                        key: item.key,
                        before: event.clientY < box.top + box.height / 2,
                      });
                    }}
                    onDrop={(event) => {
                      if (!editable) return;
                      event.preventDefault();
                      dropOn(item.key, dropHint?.before ?? true);
                    }}
                  >
                    {renaming === item.key ? (
                      <input
                        className="nav-rename nav-rename--item"
                        autoFocus
                        aria-label={`Rename ${item.builtInLabel}`}
                        value={renameDraft}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onBlur={() => applyRename(item.key, renameDraft)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") applyRename(item.key, renameDraft);
                          if (event.key === "Escape") setRenaming(null);
                          event.stopPropagation();
                        }}
                      />
                    ) : (
                      <button
                        className={`${activeSection === item.key ? "is-active" : ""}${
                          transient ? " is-transient" : ""
                        }${item.hidden && editing ? " is-hidden" : ""}`}
                        type="button"
                        data-nav-key={item.key}
                        data-nav-hidden={item.hidden ? "true" : "false"}
                        data-nav-locked={item.locked ? "true" : "false"}
                        title={
                          transient
                            ? `${item.label} is hidden from your sidebar — you are on it now`
                            : undefined
                        }
                        tabIndex={0}
                        onKeyDown={(event) => onRowKeyDown(event, item.key)}
                        onClick={() => {
                          if (editing) return;
                          onSelect(item.key);
                        }}
                        onDoubleClick={() => {
                          if (!editable || item.locked) return;
                          setRenaming(item.key);
                          setRenameDraft(item.label);
                        }}
                      >
                        <span className="nav-icon">
                          <Icon name={iconFor.get(item.key) ?? "grid"} size={19} />
                        </span>
                        <span className="nav-row__label">{item.label}</span>
                        {appeared.has(item.key) && editing && (
                          <span className="nav-new" title="New since you last arranged this">
                            New
                          </span>
                        )}
                        {item.locked && editing && (
                          <span className="nav-lock" title="Locked by an administrator">
                            <Icon name="shield" size={13} />
                          </span>
                        )}
                        {!editing && count > 0 && (
                          <span
                            className="nav-count"
                            title={countLabel ? count + " " + countLabel : undefined}
                            aria-label={countLabel ? count + " " + countLabel : undefined}
                          >
                            {count}
                          </span>
                        )}
                      </button>
                    )}

                    {editable && renaming !== item.key && (
                      <span className="nav-row-actions">
                        <button
                          type="button"
                          aria-label={`Move ${item.label} up`}
                          onClick={() => move(item.key, -1)}
                        >
                          <Icon name="chevron" size={13} className="nav-caret nav-caret--up" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${item.label} down`}
                          onClick={() => move(item.key, 1)}
                        >
                          <Icon
                            name="chevron"
                            size={13}
                            className="nav-caret nav-caret--down"
                          />
                        </button>
                        <button
                          type="button"
                          aria-label={`Rename ${item.label}`}
                          disabled={item.locked && scope !== "workspace"}
                          onClick={() => {
                            setRenaming(item.key);
                            setRenameDraft(item.label);
                          }}
                        >
                          <Icon name="tool" size={13} />
                        </button>
                        <button
                          type="button"
                          aria-label={
                            item.hidden ? `Show ${item.label}` : `Hide ${item.label}`
                          }
                          disabled={item.locked && scope !== "workspace"}
                          onClick={() => setHidden(item.key, !item.hidden)}
                        >
                          <Icon name={item.hidden ? "plus" : "close"} size={13} />
                        </button>
                        {scope === "workspace" && canEditDefault && (
                          <button
                            type="button"
                            className={item.locked ? "is-locked" : ""}
                            aria-label={
                              item.locked
                                ? `Unlock ${item.label}`
                                : `Lock ${item.label} on for everyone`
                            }
                            aria-pressed={item.locked}
                            onClick={() => toggleLock(item.key)}
                          >
                            <Icon name="shield" size={13} />
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}

        {editing && (
          <div className="nav-editor">
            {/*
              "Add" is a restore, never a creation. Everything offered here came
              out of the catalogue the app renders from, so nothing in this list
              can lead anywhere that does not exist.
            */}
            <span className="nav-label nav-label--spaced">Hidden items</span>
            {hiddenItems.length === 0 ? (
              <p className="nav-editor__empty">Nothing is hidden.</p>
            ) : (
              <div className="nav-editor__chips">
                {hiddenItems.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className="nav-chip"
                    data-nav-restore={item.key}
                    onClick={() => setHidden(item.key, false)}
                  >
                    <Icon name="plus" size={12} />
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="nav-editor__tools">
              <button type="button" className="nav-editor__tool" onClick={addGroup}>
                <Icon name="plus" size={13} />
                <span>New heading</span>
              </button>
              <button
                type="button"
                className="nav-editor__tool"
                data-nav-reset
                onClick={() => void reset()}
              >
                <Icon name="updates" size={13} />
                <span>Reset to workspace default</span>
              </button>
            </div>

            {canEditDefault && (
              <label className="nav-editor__scope">
                <input
                  type="checkbox"
                  checked={scope === "workspace"}
                  onChange={(event) => {
                    if (saveTimer.current) window.clearTimeout(saveTimer.current);
                    void flush();
                    setScope(event.target.checked ? "workspace" : "user");
                    setRenaming(null);
                  }}
                />
                <span>
                  Editing the workspace default
                  <small>
                    Everyone starts from this. Locked items cannot be hidden or
                    renamed by anybody.
                  </small>
                </span>
              </label>
            )}

            <p className="nav-editor__hint">
              Drag to reorder, or focus an item and press Alt + ↑ / ↓. Double-click
              a name to rename it.
            </p>
          </div>
        )}

        <button
          type="button"
          className={`nav-customise${editing ? " is-active" : ""}`}
          data-nav-customise
          aria-pressed={editing}
          onClick={() => {
            if (editing) {
              if (saveTimer.current) window.clearTimeout(saveTimer.current);
              void flush();
              setScope("user");
              setRenaming(null);
            }
            setEditing((value) => !value);
          }}
        >
          <span className="nav-icon">
            <Icon name={editing ? "check" : "tool"} size={16} />
          </span>
          <span>{editing ? "Done" : "Customise sidebar"}</span>
        </button>

        {/* Every reorder, rename, hide and restore is announced here — the
            keyboard path is only equivalent to dragging if its result is
            perceivable without watching the list move. */}
        <span className="nav-status" role="status" aria-live="polite">
          {status}
        </span>
      </nav>
    </>
  );
}

export default SidebarNav;
