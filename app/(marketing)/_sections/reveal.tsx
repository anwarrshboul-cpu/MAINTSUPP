"use client";

/**
 * Reveal-on-scroll observer — ported from the source's `initReveal`.
 *
 * `.reveal` is `opacity: 0` until `.is-in` is added, so without this every
 * section carrying the class renders invisible. One observer for the whole
 * page rather than one per section: `.reveal` elements are added and removed
 * as tabs and steppers change, so the observer re-scans on mutation.
 *
 * Reduced motion is honoured the way the source honoured it — everything is
 * revealed immediately and no observer is created.
 */

import { useEffect } from "react";

export function RevealObserver() {
  useEffect(() => {
    const reveal = (element: Element) => element.classList.add("is-in");

    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      document.querySelectorAll(".reveal").forEach(reveal);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          reveal(entry.target);
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );

    const scan = () => {
      document
        .querySelectorAll(".reveal:not(.is-in)")
        .forEach((element) => observer.observe(element));
    };

    scan();

    // Tabs and steppers swap `.reveal` elements in after the first pass, and an
    // element that appears already on screen never fires an intersection —
    // re-scanning on mutation is what stops those staying invisible.
    const mutations = new MutationObserver(scan);
    mutations.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, []);

  return null;
}
