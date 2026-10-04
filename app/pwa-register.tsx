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
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);
  return null;
}
