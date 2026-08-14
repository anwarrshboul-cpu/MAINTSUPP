import type { ReactNode } from "react";
import globalsCss from "../globals.css?url";
import brandCss from "../brand-overrides.css?url";
import boardMetricsCss from "../board-metrics.css?url";
import { themeBootScript } from "./portal/theme-boot";

/**
 * Application layout — B2.
 *
 * The dashboard stylesheets load here and nowhere else. Before this split they
 * were in the root layout, so the marketing homepage downloaded 230KB of CSS it
 * never used.
 *
 * THE THEME IS DECIDED HERE, FIRST.
 *
 * `themeBootScript` is a ~400 byte blocking script that reads the stored
 * preference, falls back to `prefers-color-scheme`, and stamps `data-theme` and
 * `color-scheme` on `<html>` and `<body>` before the browser paints. It is the
 * first thing in this group's output, ahead of the stylesheets, so the tokens
 * resolve to the right palette the first time they are read — the theme used to
 * be applied from React effects and painted the wrong one for 28.5ms after
 * first contentful paint.
 *
 * It sits in this layout rather than the root one on purpose. The root layout
 * also wraps the marketing site, which loads none of these stylesheets, pins
 * its own `color-scheme: light` and was verified byte-identical to the design
 * archive; stamping a theme onto it would change a surface that is explicitly
 * out of scope. Everything that loads globals.css loads through here.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {/* Inline, and deliberately so: it is the only way to run code before
          first paint. The content is a module-level constant with no
          interpolation of anything a request can influence. */}
      <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      <link rel="stylesheet" href={globalsCss} />
      <link rel="stylesheet" href={brandCss} />
      <link rel="stylesheet" href={boardMetricsCss} />
      {children}
    </>
  );
}
