"use client";

/**
 * The glyphs the board's action surfaces use, inline.
 *
 * `app/components.tsx` carries the portal's icon set and is not this batch's
 * to edit; the handful it lacks — a bolt for automations, a speech bubble,
 * user-plus, the picker's group glyphs — live here. Same conventions as
 * `Icon`: 24-box, stroked, `aria-hidden`, sized by prop.
 */

import type { SVGProps } from "react";

export type ActionIconName =
  | "bolt"
  | "bubble"
  | "user-plus"
  | "link"
  | "more"
  | "close"
  | "search"
  | "chevron-right"
  | "chevron-down"
  | "check"
  | "plus"
  | "status"
  | "column"
  | "person"
  | "calendar"
  | "move"
  | "comment"
  | "repeat"
  | "subitem"
  | "mail"
  | "slack"
  | "teams"
  | "bell"
  | "clear"
  | "text"
  | "archive"
  | "trash"
  | "copy"
  | "number"
  | "group"
  | "grid"
  | "list"
  | "filter"
  | "fullscreen"
  | "export"
  | "import"
  | "settings"
  | "activity"
  | "shield"
  | "edit"
  | "info"
  | "alert"
  | "play"
  | "clock"
  | "plug";

const paths: Record<ActionIconName, React.JSX.Element> = {
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />,
  bubble: <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5v-8Z" />,
  "user-plus": (
    <>
      <circle cx="10" cy="8" r="3.5" />
      <path d="M3.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.1 0l2.8-2.8a5 5 0 0 0-7.1-7.1L11.5 4.4" />
      <path d="M14 11a5 5 0 0 0-7.1 0l-2.8 2.8a5 5 0 0 0 7.1 7.1l1.3-1.3" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  "chevron-right": <path d="m9 6 6 6-6 6" />,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  check: <path d="m5 12 5 5L20 7" />,
  plus: <path d="M12 5v14M5 12h14" />,
  status: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="3" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  column: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M12 3v18M4 9h16M4 15h16" />
    </>
  ),
  person: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  move: <path d="M4 7h11M4 12h16M4 17h11M18 4l3 3-3 3M18 14l3 3-3 3" />,
  comment: (
    <>
      <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 3v-3H6a2 2 0 0 1-2-2V6Z" />
      <path d="M8 9h8M8 12h5" />
    </>
  ),
  repeat: <path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" />,
  subitem: <path d="M7 4v12a2 2 0 0 0 2 2h9M7 10h11M15 14l3 4-3 4" />,
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </>
  ),
  slack: (
    <>
      <path d="M9 3a2 2 0 0 1 2 2v5H9a2 2 0 1 1 0-4h2M15 21a2 2 0 0 1-2-2v-5h2a2 2 0 1 1 0 4h-2" />
      <path d="M3 15a2 2 0 0 1 2-2h5v2a2 2 0 1 1-4 0v-2M21 9a2 2 0 0 1-2 2h-5V9a2 2 0 1 1 4 0v2" />
    </>
  ),
  teams: (
    <>
      <circle cx="9" cy="8" r="3" />
      <circle cx="17" cy="9" r="2.2" />
      <path d="M3 20a6 6 0 0 1 12 0M14 20a4.5 4.5 0 0 1 7 0" />
    </>
  ),
  bell: <path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2ZM10 20a2 2 0 0 0 4 0" />,
  clear: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="3" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </>
  ),
  text: <path d="M5 6h14M12 6v13M8 19h8" />,
  archive: (
    <>
      <rect x="3" y="4" width="18" height="5" rx="1.5" />
      <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" />
    </>
  ),
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </>
  ),
  number: <path d="M9 4 7 20M17 4l-2 16M4 9h16M3 15h16" />,
  group: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
    </>
  ),
  list: <path d="M4 6h16M4 12h16M4 18h16" />,
  filter: <path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z" />,
  fullscreen: <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />,
  export: <path d="M12 3v12M7 10l5 5 5-5M4 19h16" />,
  import: <path d="M12 15V3M7 8l5-5 5 5M4 19h16" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>
  ),
  activity: <path d="M3 12h4l2.2-6 4.1 12 2.2-6H21" />,
  shield: <path d="M12 3 4 6.5v5c0 4.6 3.2 8.6 8 9.5 4.8-.9 8-4.9 8-9.5v-5Z" />,
  edit: <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3ZM13 8l3 3" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  alert: <path d="M12 3 2 20h20L12 3ZM12 10v4M12 17h.01" />,
  play: <path d="M7 4v16l13-8L7 4Z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  plug: <path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0V7ZM12 17v5" />,
};

export function ActionIcon({
  name,
  size = 16,
  ...props
}: SVGProps<SVGSVGElement> & { name: ActionIconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      width={size}
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}

/** Maps a catalogue icon key onto a glyph; unknown keys fall back to a bolt. */
export function catalogIcon(key: string): ActionIconName {
  const known: Record<string, ActionIconName> = {
    status: "status",
    column: "column",
    person: "person",
    calendar: "calendar",
    move: "move",
    comment: "comment",
    repeat: "repeat",
    subitem: "subitem",
    mail: "mail",
    slack: "slack",
    teams: "teams",
    bell: "bell",
    clear: "clear",
    text: "text",
    archive: "archive",
    trash: "trash",
    copy: "copy",
    number: "number",
    group: "group",
    plus: "plus",
  };
  return known[key] ?? "bolt";
}
