"use client";

/**
 * WHAT `aria-modal="true"` PROMISES, IN ONE PLACE.
 *
 * Escape closes, focus moves inside on open and returns to the opener on
 * close, Tab and Shift+Tab stay in, a press on the backdrop closes, and the
 * body takes the one shared scroll lock. A surface that declares itself modal
 * and does none of this is telling assistive technology something untrue.
 *
 * EXTRACTED, not written fresh: this is `board-modal.tsx`'s own
 * `useDialogBehaviour`, moved here unchanged so the Overview's data tools can
 * use the same implementation rather than a second one that drifts. The board
 * modal and drawer still call it; nothing about their behaviour changes.
 *
 * The Overview's tools needed it because they had none of it. They rendered
 * `role="dialog" aria-modal="true"` with only a close button and a backdrop
 * click: Escape did nothing, focus never left the button that opened them, and
 * Tab walked straight out into the page behind. They also sat at a hardcoded
 * `z-index: 60` — under the sidebar at 410 and the topbar at 300 — so the
 * "modal" could be clicked straight past into a different section. Render
 * through `LayerPortal layer="modal"` and that is fixed by construction rather
 * than by a bigger number.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useBodyScrollLock } from "./anchored";

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/* Generic in the surface's element: most dialogs are a `<div>`, the job panel is a `<section>`. */
export function useDialogBehaviour<T extends HTMLElement = HTMLDivElement>(open: boolean, onClose: () => void) {
  const surface = useRef<T | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useBodyScrollLock(open);

  // Focus in on open; back to the opener on close.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement as HTMLElement | null;
    const node = surface.current;
    if (node && !node.contains(document.activeElement)) {
      const first = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).find(
        (candidate) => !candidate.closest("[data-autofocus-skip]"),
      );
      (node.querySelector<HTMLElement>("[data-autofocus]") ?? first ?? node).focus({
        preventScroll: true,
      });
    }
    return () => {
      const active = document.activeElement;
      if (!active || active === document.body || node?.contains(active)) {
        opener?.focus?.({ preventScroll: true });
      }
    };
  }, [open]);

  // Escape from anywhere, unless a popover above us has already taken it.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      // A raised popover (a picker inside the modal) owns its own Escape.
      if (target?.closest('.ms-layer[data-layer="popover-raised"], .ms-layer[data-layer="popover"], .ms-layer[data-layer="submenu"]')) return;
      closeRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const onBackdrop = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    /*
     * The close restores focus to the opener, and then pointerdown's DEFAULT
     * action moved it straight to <body> — the backdrop is not focusable, so
     * the browser focuses the nearest thing that is. Measured: Escape and the
     * close button both returned focus to the footer button that opened the
     * dialog; a backdrop press left it on BODY, which drops a keyboard reader
     * at the top of the document.
     */
    event.preventDefault();
    closeRef.current();
  }, []);

  // Keep Tab inside the dialog.
  const onKeyDown = useCallback((event: React.KeyboardEvent<T>) => {
    if (event.key !== "Tab") return;
    const node = surface.current;
    if (!node) return;
    const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (candidate) => candidate.offsetParent !== null,
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  return { surface, onBackdrop, onKeyDown };
}
