"use client";

import marketingCss from "./(marketing)/marketing.css?url";

/**
 * The 404's stylesheet — drawn by a CLIENT component, and only for this reason.
 *
 * The root not-found is not only rendered on a 404. Every route's payload
 * carries it as the fallback of the root `NotFoundBoundary`, so any host element
 * it contains is serialised into the payload of `/dashboard`, `/login` and every
 * other page, 404 or not. A `<link rel="stylesheet">` written there directly is
 * one React turns into a preload hint (`:HL[…marketing….css,"style"]`), and the
 * server writes that into every page's head as `<link rel="preload" as="style">`.
 * On any page that is not a marketing page the browser then downloads a
 * stylesheet nothing uses and warns about it in the console — measured on
 * Production 2026-09-23 on every signed-in route, at every width.
 *
 * From here the payload carries only a reference to this component, which
 * produces no hint. A real 404 still renders the same `<link>` in its HTML, so
 * the page is styled on first paint exactly as before.
 */
export function NotFoundStyles() {
  return <link rel="stylesheet" href={marketingCss} />;
}
