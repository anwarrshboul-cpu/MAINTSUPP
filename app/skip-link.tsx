"use client";

import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { usePathname } from "next/navigation";

/**
 * "SKIP TO MAIN CONTENT" — the first thing a keyboard reaches on every page.
 *
 * Mounted once, in the root layout, so the marketing site, the portal, /admin
 * and the public pages all have it without any of them agreeing on an id. It
 * moves focus to the page's `<main>` — every route group renders exactly one —
 * making it focusable for the jump if it is not already.
 *
 * The link names a REAL target, because a skip link that points nowhere is
 * both an axe fault (`skip-link`) and, since it then stands outside every
 * landmark, a second one (`region`). A `<main>` without an id is given `main`;
 * one that already has an id (the marketing home's `#top`) keeps it and the
 * link follows. Re-checked on every route change, since a new page brings a new
 * `<main>`. Server-rendered as `#main`, which is what most pages end up with.
 *
 * Styled inline, not by a stylesheet: the root layout is deliberately
 * stylesheet-free, and the public pages load no shared CSS at all (they are
 * opened on mobile data). Hidden the accessible way until focused — still in
 * the tab order, still read — then drawn as a high-contrast pill with a ring.
 */

const HIDDEN: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

const SHOWN: CSSProperties = {
  position: "fixed",
  top: 8,
  left: 8,
  zIndex: 2147483000,
  padding: "10px 16px",
  borderRadius: 8,
  background: "#101820",
  color: "#ffffff",
  font: "600 14px/1.2 system-ui, -apple-system, 'Segoe UI', sans-serif",
  textDecoration: "none",
  outline: "3px solid #12b4a8",
  outlineOffset: 2,
};

function jumpToMain(event: MouseEvent<HTMLAnchorElement>) {
  const main = document.querySelector<HTMLElement>("main");
  if (!main) return;
  event.preventDefault();
  if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
  // The jump itself is the indicator; a ring round the whole page is noise.
  main.style.outline = "none";
  main.focus();
}

export function SkipLink() {
  const [shown, setShown] = useState(false);
  const link = useRef<HTMLAnchorElement | null>(null);
  const pathname = usePathname();
  useEffect(() => {
    const main = document.querySelector<HTMLElement>("main");
    if (!main || !link.current) return;
    if (!main.id) main.id = "main";
    // Written to the DOM, not through state: the prop stays `#main`, so React
    // has no reason to write it back.
    link.current.setAttribute("href", `#${main.id}`);
  }, [pathname]);
  return (
    <a
      ref={link}
      href="#main"
      className="skip-link"
      style={shown ? SHOWN : HIDDEN}
      onFocus={() => setShown(true)}
      onBlur={() => setShown(false)}
      onClick={jumpToMain}
    >
      Skip to main content
    </a>
  );
}
