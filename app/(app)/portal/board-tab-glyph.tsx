"use client";

/**
 * The mark at the head of a board tab.
 *
 * Extracted from `board-chrome.tsx` because that file is held to 500 lines by
 * `stage-eight-board-split.test.mjs`, and because none of this is chrome
 * BEHAVIOUR — it is what a tab looks like, and it changes for different
 * reasons than the tab strip does.
 */

import { Icon, type IconName } from "../../components";
import type { BoardView } from "./board-chrome";

const ICONS: Record<string, IconName> = {
  grid: "grid",
  document: "document",
  list: "list",
  calendar: "calendar",
  chart: "chart",
  image: "image",
  inbox: "inbox",
  spark: "spark",
};

export function iconFor(name: string | null): IconName {
  return (name && ICONS[name]) || "grid";
}

/**
 * What monday draws at the head of a tab.
 *
 * Two decorations, both recorded in the board capture. The Form is PINNED and
 * carries a pin. Fix Tracker (app 22247989) and Build Vibe view (app 15528052)
 * are monday APPS rather than view types, so monday gives them an app glyph
 * *instead of* a view icon — the tab has no view type to draw one from. Keeping
 * the distinction tells an admin at a glance which tabs would go if the app
 * were uninstalled.
 *
 * Neither glyph joins the shared icon set: neither means anything outside a
 * board tab strip.
 */
export function TabGlyph({ view }: { view: BoardView }) {
  const glyph = view.settings?.glyph;
  if (!glyph) return <Icon name={iconFor(view.icon)} size={15} />;

  const shared = {
    width: 15,
    height: 15,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    role: "img",
  };

  return glyph === "pin" ? (
    <svg {...shared} className="board-views__glyph" aria-label="Pinned view">
      <path d="M9.5 3.5h5l-.8 5.2 2.8 2.6v1.9H7.5v-1.9l2.8-2.6-.8-5.2Z" />
      <path d="M12 13.2V20.5" />
    </svg>
  ) : (
    /*
      A framed spark, not a four-square grid: the grid is already the Main
      table's and the Table's view icon, and at 15px two square-based marks are
      the same mark. The frame reads as the app's own tile, which is what
      monday puts there.
    */
    <svg {...shared} className="board-views__glyph" aria-label="monday app">
      <rect x="3" y="3" width="18" height="18" rx="4.5" />
      <path d="M12 7.6l1.2 3.2 3.2 1.2-3.2 1.2L12 16.4l-1.2-3.2L7.6 12l3.2-1.2Z" />
    </svg>
  );
}
