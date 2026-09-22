"use client";

/**
 * §69 — AN EDITOR WITH UNSAVED CHANGES SAYS SO BEFORE THEY ARE LOST.
 *
 * While `dirty` is true:
 *   - closing the tab, reloading or typing another address asks first (the
 *     browser's own `beforeunload` prompt — its wording is the browser's);
 *   - following a link inside the portal asks first. The portal navigates
 *     client-side, which `beforeunload` never sees, so a capture-phase click
 *     listener stands in front of every same-origin link and cancels the
 *     navigation if the person chooses to stay.
 * The returned `confirmLeave()` is for the editor's own Cancel / Back buttons: it
 * answers true straight away when nothing is unsaved.
 *
 * Nothing warns once a save has landed — the caller's `dirty` goes false.
 */

import { useCallback, useEffect } from "react";

export const UNSAVED_CHANGES_MESSAGE = "You have unsaved changes. Leave without saving them?";

export function useUnsavedChanges(dirty: boolean): () => boolean {
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Some browsers still need a returnValue to show their prompt.
      event.returnValue = "";
    };
    const leaveByLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      // Another site is a full unload, which `beforeunload` already covers.
      if (url.origin !== window.location.origin) return;
      // A jump within this page loses nothing.
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      if (!window.confirm(UNSAVED_CHANGES_MESSAGE)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", leaveByLink, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", leaveByLink, true);
    };
  }, [dirty]);

  return useCallback(() => !dirty || window.confirm(UNSAVED_CHANGES_MESSAGE), [dirty]);
}
