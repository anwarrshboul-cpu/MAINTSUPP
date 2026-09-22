import type { ReactNode } from "react";
import { readPublicNavigation } from "../lib/site-navigation-public";
import { Analytics } from "./_sections/analytics";
import {
  CookieNotice,
  ScrollFurniture,
  SiteFooter,
  SiteHeader,
  UtilityBar,
} from "./_sections/chrome";
import { RevealObserver } from "./_sections/reveal";
import marketingCss from "./marketing.css?url";

/**
 * Marketing layout — B1, B2.
 *
 * Deliberately does NOT import globals.css or brand-overrides.css. Those are
 * 230KB of dashboard styling that the marketing site never used; loading them
 * here is what made the old homepage slow.
 *
 * `.m-root` survives only to supply the handful of custom properties the legal
 * pages still use. It sets no colour, font or spacing of its own — see the
 * comment above the rule in marketing.css.
 *
 * THE NAVIGATION IS READ HERE, ONCE PER RENDER, AND NEVER COSTS A PAGE ITS
 * LIFE (decision J). `readPublicNavigation` answers from a per-instance cache
 * that is re-read at most every thirty seconds, waits at most a moment for the
 * database, and falls back to the last navigation it had — or the built-in one
 * — when the database cannot answer. Hidden links and links to website pages
 * that are not live are removed on the server, so they never reach the page or
 * its payload. See `app/lib/site-navigation-public.ts`.
 */
export default async function MarketingLayout({ children }: { children: ReactNode }) {
  const navigation = await readPublicNavigation();
  return (
    <div className="m-root">
      <link rel="stylesheet" href={marketingCss} />
      {/* Manrope for headings, Inter for body — the two faces the ported
          design system names. Self-hosting is a later job; preconnect keeps
          the handshake off the critical path in the meantime. */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      {/* eslint-disable-next-line @next/next/no-page-custom-font -- this rule
          targets pages/_document.js; in the app router a layout-level stylesheet
          applies to every route in the group, which is exactly what we want. */}
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Manrope:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap"
      />
      <ScrollFurniture />
      <UtilityBar />
      <SiteHeader navigation={navigation} />
      {children}
      <SiteFooter navigation={navigation} />
      <CookieNotice />
      <RevealObserver />
      <Analytics />
    </div>
  );
}
