import type { ReactNode } from "react";
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
 */
export default function MarketingLayout({ children }: { children: ReactNode }) {
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
      <SiteHeader />
      {children}
      <SiteFooter />
      <CookieNotice />
      <RevealObserver />
    </div>
  );
}
