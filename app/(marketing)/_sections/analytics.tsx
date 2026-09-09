"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { cookieStore } from "./chrome";

/**
 * Google Tag Manager — consent-gated.
 *
 * THE CONTAINER IS NOT LOADED UNTIL SOMEBODY SAYS YES.
 *
 * The cookie notice promises "essential cookies only unless you accept
 * analytics", and UK PECR means that promise has to be kept by the code, not
 * just by the copy. So `gtm.js` is never requested — not even fetched — until
 * `mt_cookie` reads `accept`. Nothing else in this file talks to Google.
 *
 * `track()` is safe to call at any time regardless of consent: it only pushes
 * onto the in-page `dataLayer` array, which is plain memory until the
 * container exists. Events fired before consent are therefore replayed to GTM
 * the moment it loads, and simply discarded if it never does.
 *
 * NO PERSONAL DATA GOES INTO THE DATA LAYER. Ticket text, names, emails, site
 * addresses and form contents stay out; the events below carry a request id, a
 * priority, a category and a site band, which is what the cookie notice says
 * happens.
 */

export const GTM_ID = "GTM-KF28CXFD";

type DataLayerEvent = Record<string, unknown>;

declare global {
  interface Window {
    dataLayer?: DataLayerEvent[];
  }
}

/** Push a named event onto the data layer. A no-op during SSR. */
export function track(event: string, params: DataLayerEvent = {}): void {
  if (typeof window === "undefined") return;
  window.dataLayer = window.dataLayer ?? [];
  window.dataLayer.push({ event, ...params });
}

export function Analytics() {
  /*
   * Same store the banner itself reads, so the container loads on the click
   * that dismisses the banner rather than on the next navigation.
   * `"pending"` is the server snapshot — localStorage does not exist there.
   */
  const choice = useSyncExternalStore(cookieStore.subscribe, cookieStore.read, () => "pending");
  const consented = choice === "accept";
  const pathname = usePathname();
  const firstPath = useRef(true);

  /* The container itself. Injected once, and only after consent. */
  useEffect(() => {
    if (!consented) return;
    if (document.getElementById("gtm-container")) return;

    window.dataLayer = window.dataLayer ?? [];
    window.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" });

    const script = document.createElement("script");
    script.id = "gtm-container";
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtm.js?id=${GTM_ID}`;
    document.head.appendChild(script);
  }, [consented]);

  /*
   * Client-side navigations.
   *
   * GTM's own pageview fires once, on the initial document. Moving from / to
   * /faqs never reloads the document, so without this the rest of the site is
   * invisible in analytics. The first pathname is skipped because the
   * container's own pageview already covers it.
   */
  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    track("spa_page_view", { page_path: pathname, page_title: document.title });
  }, [pathname]);

  /*
   * Phone and email clicks, caught by delegation rather than by editing every
   * link — they appear in the utility bar, the drawer, the footer and the
   * privacy page, and a listener on the document catches any added later.
   */
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const link = target?.closest<HTMLAnchorElement>(
        'a[href^="tel:"], a[href^="mailto:"]',
      );
      if (!link) return;
      const isPhone = link.getAttribute("href")?.startsWith("tel:");
      track("contact_click", { method: isPhone ? "phone" : "email" });
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  return null;
}
