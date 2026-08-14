import type { ReactNode } from "react";
import {
  CookieNotice,
  ScrollFurniture,
  SiteFooter,
  SiteHeader,
  UtilityBar,
} from "./_sections/chrome";
import { RevealObserver } from "./_sections/reveal";
/*
 * A plain CSS import, not the legacy `import marketingCss from "./marketing.css?url"`.
 *
 * `?url` is a Vite feature: it hands back a URL string that the legacy layout
 * then rendered as a `<link>`. Next has no such resolver — the import would
 * fail to build. Importing the file directly puts it in the route group's own
 * stylesheet, which is loaded for `/` and nothing else.
 *
 * IT MUST BE IMPORTED HERE, IN THE NESTED LAYOUT, NOT IN THE ROOT ONE. The
 * root layout imports globals.css for /portal and /job, and the two files both
 * define `.wrap`, `.btn`, `.tabs`, `body`, `h1` and `h2`. Next emits a parent
 * layout's CSS before its children's, so importing here is what puts the
 * marketing rules last and lets them win. The isolation block at the top of
 * marketing.css handles the declarations globals.css makes that this file has
 * no opinion on and so would not otherwise overwrite.
 */
import "./marketing.css";

/**
 * Marketing layout — the legacy `app/(marketing)/layout.tsx`.
 *
 * Deliberately does NOT import globals.css itself. That file is the portal and
 * share-link stylesheet; the marketing site ships its own complete design
 * system and shares nothing with it but the brand.
 *
 * `.m-root` survives to supply the handful of custom properties the legal pages
 * still use, plus — new here — the inherited body typography, so the page reads
 * correctly even if the stylesheet order above were ever to change.
 */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="m-root">
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
