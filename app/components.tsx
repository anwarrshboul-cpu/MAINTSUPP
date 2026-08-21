import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "activity"
  | "alert"
  | "arrow"
  | "bell"
  | "building"
  | "camera"
  | "calendar"
  | "chart"
  | "check"
  | "chevron"
  | "clock"
  | "close"
  | "document"
  | "download"
  | "edit"
  | "filter"
  | "folder"
  | "grid"
  | "home"
  | "image"
  | "inbox"
  | "link"
  | "list"
  | "map"
  | "menu"
  | "message"
  | "moon"
  | "more"
  | "paperclip"
  | "plus"
  | "refresh"
  | "reply"
  | "search"
  | "settings"
  | "share"
  | "shield"
  | "sortAsc"
  | "sortDesc"
  | "sortNone"
  | "spark"
  | "store"
  | "sun"
  | "thumb"
  | "tool"
  | "trash"
  | "upload"
  | "updates"
  | "user"
  | "users"
  | "wrench";

const paths: Record<IconName, ReactNode> = {
  activity: (
    <path d="M3 12h4l2.2-6 4.1 12 2.2-6H21" />
  ),
  alert: (
    <>
      <path d="M10.3 3.6 2.4 17.2A2 2 0 0 0 4.1 20h15.8a2 2 0 0 0 1.7-2.8L13.7 3.6a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  arrow: <path d="m5 12 14 0m-5-5 5 5-5 5" />,
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M10 21h4" />
    </>
  ),
  building: (
    <>
      <path d="M4 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M16 8h3a1 1 0 0 1 1 1v12M8 7h4M8 11h4M8 15h4M3 21h18" />
    </>
  ),
  camera: (
    <>
      <path d="M8.5 5 10 3h4l1.5 2H19a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
      <circle cx="12" cy="12.5" r="4" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M16 3v4M8 3v4M3 10h18" />
    </>
  ),
  chart: (
    <>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m9 18 6-6-6-6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  document: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6M8 13h8M8 17h6" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12m-5-5 5 5 5-5M4 21h16" />
    </>
  ),
  filter: (
    <path d="M4 5h16l-6 7v5l-4 2v-7Z" />
  ),
  folder: (
    <path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  home: (
    <>
      <path d="m3 11 9-8 9 8" />
      <path d="M5 10v10h14V10M9 20v-6h6v6" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9" r="1.5" />
      <path d="m21 15-5-5L5 20" />
    </>
  ),
  inbox: (
    <>
      <path d="M4 4h16v14H4z" />
      <path d="M4 13h4l2 3h4l2-3h4" />
    </>
  ),
  /* Two chain links. The copy-link control beside "Share form". */
  link: (
    <>
      <path d="M10 13a4.5 4.5 0 0 0 6.4.4l2.6-2.6a4.5 4.5 0 0 0-6.4-6.4l-1.5 1.5" />
      <path d="M14 11a4.5 4.5 0 0 0-6.4-.4L5 13.2a4.5 4.5 0 0 0 6.4 6.4l1.5-1.5" />
    </>
  ),
  list: (
    <>
      <path d="M9 6h12M9 12h12M9 18h12" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" />
    </>
  ),
  map: (
    <>
      <path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Z" />
      <path d="M9 3v15M15 6v15" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  message: (
    <>
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3 1.5-5A7 7 0 0 1 3 13V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
      <path d="M8 9h8M8 13h5" />
    </>
  ),
  moon: <path d="M20.5 15.2A8.5 8.5 0 0 1 8.8 3.5 8.6 8.6 0 1 0 20.5 15.2Z" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  paperclip: <path d="m20 12-8 8a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.2-8.2" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </>
  ),
  /* Three connected nodes — monday's share glyph, on the "Share form" button. */
  share: (
    <>
      <circle cx="18" cy="5" r="2.6" />
      <circle cx="6" cy="12" r="2.6" />
      <circle cx="18" cy="19" r="2.6" />
      <path d="m8.3 10.8 7.4-4.3m0 11-7.4-4.3" />
    </>
  ),
  shield: (
    <>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  /* The three states of a sortable column header, drawn to the same 24-box so
     swapping between them cannot shift the header by a pixel. */
  sortNone: (
    <>
      <path d="M8 9.5 12 5l4 4.5" />
      <path d="M8 14.5 12 19l4-4.5" />
    </>
  ),
  sortAsc: (
    <>
      <path d="M12 19V5" />
      <path d="m7 10 5-5 5 5" />
    </>
  ),
  sortDesc: (
    <>
      <path d="M12 5v14" />
      <path d="m7 14 5 5 5-5" />
    </>
  ),
  spark: (
    <path d="m12 2 1.5 5.5L19 9l-5.5 1.5L12 16l-1.5-5.5L5 9l5.5-1.5ZM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8Z" />
  ),
  store: (
    <>
      <path d="M4 10v10h16V10M3 4h18l-2 6H5Z" />
      <path d="M9 20v-6h6v6" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  tool: (
    <path d="M14.7 6.3a4 4 0 0 0-5-5L12 3.6 9.6 6 7.3 3.7a4 4 0 0 0 5 5L4 17a2 2 0 1 0 3 3l7.7-8.3a4 4 0 0 0 0-5.4Z" />
  ),
  /* The option editor's remove action — a stroked bin on the shared grid. */
  trash: (
    <>
      <path d="M4 7h16M10 11v6M14 11v6" />
      <path d="M6 7l1 13a1.5 1.5 0 0 0 1.5 1.4h7A1.5 1.5 0 0 0 17 20l1-13M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7" />
    </>
  ),
  upload: (
    <>
      <path d="M12 17V3m-5 5 5-5 5 5M4 21h16" />
    </>
  ),
  updates: (
    <path d="M20.5 14.5a3.5 3.5 0 0 1-3.5 3.5H9l-5.5 3 1.6-4.6A5.5 5.5 0 0 1 3 12V7.5A3.5 3.5 0 0 1 6.5 4h10A3.5 3.5 0 0 1 20 7.5v7Z" />
  ),
  /*
   * The three the Updates panel needed, and the set did not have.
   *
   * `thumb` is `👍 Like`, `reply` is `↩ Reply` and `edit` is the `✎` in
   * monday's composer row — see db/monday-export/UPDATES-PANEL-CAPTURE.md. They
   * are drawn here rather than typed as literal emoji in the panel because
   * every other control in this product is a stroked glyph on the same grid at
   * the same weight, and three emoji among them read as a different product.
   *
   * `thumb` fills from the outside — the cuff and the fingers are one closed
   * path — so `.is-liked` can set `fill` and get a solid thumb without a second
   * icon for the pressed state.
   */
  thumb: (
    <>
      <path d="M7 10.5v9.5H4.5A1.5 1.5 0 0 1 3 18.5v-6.5a1.5 1.5 0 0 1 1.5-1.5Z" />
      <path d="M7 10.5 11.4 3a2.2 2.2 0 0 1 2 3.1L12.2 9h5.9a2 2 0 0 1 2 2.4l-1.4 6.8a2.4 2.4 0 0 1-2.3 1.8H7Z" />
    </>
  ),
  reply: (
    <path d="M9 7 4 12l5 5M4 12h9.5a6 6 0 0 1 6 6v1" />
  ),
  edit: (
    <>
      <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
      <path d="m14.5 5.5 3 3" />
    </>
  ),
  /*
   * Two arcs and two arrowheads — the conventional "re-read this" glyph.
   *
   * Drawn as open arcs rather than a closed ring so it reads as circulation at
   * 17px, which is the size the topbar uses. The arrowheads are separate paths
   * because the shared stroke settings on the parent <svg> give a filled
   * triangle the wrong weight otherwise.
   */
  refresh: (
    <>
      <path d="M20 11a8 8 0 0 0-13.7-5.7L3.5 8" />
      <path d="M4 13a8 8 0 0 0 13.7 5.7l2.8-2.7" />
      <path d="M3.5 3.8V8H7.8" />
      <path d="M20.5 20.2V16h-4.3" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  users: (
    <>
      <path d="M16 21a6 6 0 0 0-12 0M10 11a4 4 0 1 0 0-8" />
      <path d="M18 8a3 3 0 0 1 0 6M20 21a5 5 0 0 0-4-4.6" />
    </>
  ),
  wrench: (
    <path d="M21 3a6 6 0 0 1-8 7.5L6.5 17A2.5 2.5 0 1 1 3 13.5L9.5 7A6 6 0 0 1 17 1l-3 3 3 3Z" />
  ),
};

export function Icon({
  name,
  size = 20,
  ...props
}: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
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

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`brand-lockup${compact ? " brand-lockup--compact" : ""}`}>
      <span className="brand-mark" aria-hidden="true">
        {/*
          `width` and `height` are on the SVG itself, not left to CSS.
          An outermost <svg> with only a viewBox has no intrinsic size, so it
          falls back to the CSS default of 100%/100% — and the rules that size
          `.brand-mark` live in globals.css / brand-overrides.css, which the
          PUBLIC routes deliberately do not load (app/(public)/layout.tsx ships
          no shared stylesheet, for bandwidth). On the shared form that made
          this mark render 582×582 at a 1440px viewport and 320×320 on a phone:
          the enormous "M" with a screen of dead space under it.

          Sizing it at source fixes it on every route at once, including any
          future page that loads no stylesheet. The `.brand-mark` CSS still
          scales it where those sheets ARE loaded, because a width attribute is
          a presentation hint and loses to any CSS rule.
        */}
        <svg viewBox="0 0 40 40" width="40" height="40" fill="none">
          <path
            d="M6 33V9l14 15"
            stroke="currentColor"
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M20 24 34 9v24"
            stroke="#12B4A8"
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      {!compact && (
        <span className="brand-word" aria-label="MAINTSUPP">
          <span>MAINT</span><strong>SUPP</strong>
        </span>
      )}
    </span>
  );
}

export function Avatar({
  name,
  size = "medium",
}: {
  name: string;
  size?: "small" | "medium";
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  return (
    <span className={`avatar avatar--${size}`} aria-label={name} title={name}>
      {initials}
    </span>
  );
}
