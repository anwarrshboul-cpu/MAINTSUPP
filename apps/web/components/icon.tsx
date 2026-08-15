import type { ReactNode, SVGProps } from "react";

/**
 * The stroked icon set, ported from the legacy portal's `app/components.tsx`.
 *
 * WHY IT IS COPIED RATHER THAN IMPORTED. The legacy app and this one are two
 * separate builds with two separate module graphs — apps/web has no path into
 * the repo root, and giving it one would drag the legacy app's Vite/RSC
 * toolchain into a Next build. The component itself imports nothing but React
 * types, so a copy costs a file and buys independence.
 *
 * WHY THE SET IS TRIMMED. The original carries 45 glyphs because the legacy
 * portal has 45 screens' worth of chrome — an updates composer, a theme
 * toggle, a file register. Phase 2 has one dashboard so far, so this holds the
 * glyphs that dashboard names plus the obvious neighbours a second screen will
 * reach for. Adding one is a copy of its `<path>` out of the legacy file into
 * the map below and its name into `IconName`; nothing else has to change.
 *
 * NO `"use client"`. Every one of these is markup with no state, so when a
 * server component renders an `<Icon>` the paths are serialised into the HTML
 * and the browser is sent no JavaScript at all for them. That is the same
 * reasoning the analytics screen states about not shipping a charting library.
 */
export type IconName =
  | "activity"
  | "alert"
  | "building"
  | "calendar"
  | "chart"
  | "check"
  | "chevron"
  | "clock"
  | "document"
  | "download"
  | "filter"
  | "inbox"
  | "shield"
  | "spark"
  | "store"
  | "users"
  | "wrench";

const paths: Record<IconName, ReactNode> = {
  activity: <path d="M3 12h4l2.2-6 4.1 12 2.2-6H21" />,
  alert: (
    <>
      <path d="M10.3 3.6 2.4 17.2A2 2 0 0 0 4.1 20h15.8a2 2 0 0 0 1.7-2.8L13.7 3.6a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  building: (
    <path d="M4 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M16 8h3a1 1 0 0 1 1 1v12M8 7h4M8 11h4M8 15h4M3 21h18" />
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M16 3v4M8 3v4M3 10h18" />
    </>
  ),
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m9 18 6-6-6-6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  document: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6M8 13h8M8 17h6" />
    </>
  ),
  download: <path d="M12 3v12m-5-5 5 5 5-5M4 21h16" />,
  filter: <path d="M4 5h16l-6 7v5l-4 2v-7Z" />,
  inbox: (
    <>
      <path d="M4 4h16v14H4z" />
      <path d="M4 13h4l2 3h4l2-3h4" />
    </>
  ),
  shield: (
    <>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="m9 12 2 2 4-4" />
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
