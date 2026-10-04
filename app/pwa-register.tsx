"use client";

import { useEffect } from "react";

/**
 * Registers the installed app's service worker (`public/sw.js`).
 *
 * Mounted once, in the root layout, so every page — website, portal, the
 * public form and the contractor job link — can be added to a home screen and
 * receive notifications. Registration is idle work: it waits for `load`, so it
 * never competes with the page for the network, and a browser without service
 * workers (or a private window that refuses them) simply skips it.
 *
 * Renders nothing.
 */
export default function PwaRegister() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        /* An app that cannot install is still a working website. */
      });
    };
    /*
     * An alert arriving while MAINTSUPP is open plays the MAINTSUPP sound —
     * the same chime and the same mute switch as the portal's bell
     * (app/(app)/portal/use-notification-chime.ts).
     */
    const onMessage = (event: MessageEvent) => {
      if (!event.data || event.data.type !== "maintsupp-alert") return;
      try {
        if (window.localStorage.getItem("maintsupp:chime:muted") === "1") return;
      } catch {
        /* No storage: not muted. */
      }
      const audio = new Audio("/assets/sounds/maintsupp-notification.mp3");
      audio.volume = 1; /* Full volume (owner, 2026-10-04): the alert must be heard. */
      audio.play().catch(() => {});
    };
    navigator.serviceWorker.addEventListener("message", onMessage);

    if (document.readyState === "complete") {
      register();
      return () => navigator.serviceWorker.removeEventListener("message", onMessage);
    }
    window.addEventListener("load", register, { once: true });
    return () => {
      window.removeEventListener("load", register);
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, []);
  return null;
}
