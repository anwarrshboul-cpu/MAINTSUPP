"use client";

/**
 * HOLD AND DRAG A GROUP ON THE JOBS BOARD (2026-10-06).
 *
 * The owner: "on the jobs we are able to add the groups, move the groups …
 * we just hold the mouse and we can keep holding and move the job above or
 * below, even for the groups". Rows already drag (`board-row-drag-gesture.ts`);
 * this is the same gesture for a group's header, kept out of `live-board.tsx`
 * because that file sits at its size ceiling.
 *
 * The header becomes draggable; hovering another group shows a line along
 * its top or bottom edge (`data-group-drop` on that section — the CSS is in
 * `board-visibility.css`), and the drop sends ONE request,
 * `PATCH /api/board { action: "move_group", groupId, beforeGroupId }`, which
 * renumbers the board's groups on the server and returns them.
 *
 * Native HTML drag-and-drop, which is what a held mouse is. A phone does not
 * drag headers: the group's menu keeps Move up / Move down for that.
 * A header is never draggable while it is being renamed, or while the board
 * is grouped by a column (those groups are column values, not stored groups).
 */

import { useCallback, useRef, useState } from "react";
import type { DragEvent } from "react";

type Group = { id: string; name: string };

export function useBoardGroupDrag<G extends Group>({
  groups,
  url,
  enabled,
  onGroups,
  onNotify,
}: {
  groups: G[];
  /** `/api/board` for this board, as `boardUrl` builds it. */
  url: string;
  enabled: boolean;
  onGroups: (next: G[]) => void;
  onNotify: (message: string) => void;
}) {
  const dragged = useRef<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const overRef = useRef<{ id: string; after: boolean } | null>(null);
  const mark = (next: { id: string; after: boolean } | null) => {
    overRef.current = next;
    setOver(next);
  };

  const save = useCallback(
    async (groupId: string, beforeGroupId: string | null) => {
      const moving = groups.find((group) => group.id === groupId);
      try {
        const response = await fetch(url, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "move_group", groupId, beforeGroupId }),
        });
        const payload = (await response.json()) as { groups?: G[]; error?: string };
        if (!response.ok || !payload.groups) throw new Error(payload.error || "The group could not be moved.");
        onGroups(payload.groups);
        onNotify(`${moving?.name ?? "Group"} moved.`);
      } catch (error) {
        onNotify(error instanceof Error ? error.message : "The group could not be moved.");
      }
    },
    [groups, onGroups, onNotify, url],
  );

  /** Spread onto a group's `<header>`: the part you hold. */
  const headerProps = (group: G, draggable: boolean) => {
    const on = enabled && draggable;
    return {
      draggable: on,
      onDragStart: (event: DragEvent<HTMLElement>) => {
        if (!on) return;
        /* A drag that began in the rename box is a text selection. */
        const target = event.target as HTMLElement;
        if (target.closest("input, textarea, [contenteditable]")) {
          event.preventDefault();
          return;
        }
        dragged.current = group.id;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", group.name);
      },
      onDragEnd: () => {
        dragged.current = null;
        mark(null);
      },
    };
  };

  /** Spread onto a group's `<section>`: where another group can land. */
  const sectionProps = (group: G) => ({
    "data-group-drop": over?.id === group.id ? (over.after ? "after" : "before") : undefined,
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!dragged.current || dragged.current === group.id) return;
      event.preventDefault();
      const box = event.currentTarget.getBoundingClientRect();
      mark({ id: group.id, after: event.clientY > box.top + box.height / 2 });
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      const source = dragged.current;
      if (!source) return;
      event.preventDefault();
      const at = overRef.current;
      dragged.current = null;
      mark(null);
      if (!at || source === at.id) return;
      const others = groups.filter((entry) => entry.id !== source);
      const index = others.findIndex((entry) => entry.id === at.id) + (at.after ? 1 : 0);
      void save(source, others[index]?.id ?? null);
    },
  });

  return { headerProps, sectionProps };
}
