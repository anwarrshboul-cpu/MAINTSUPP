/*
 * MAINTSUPP — the installed app's service worker.
 *
 * Deliberately small. It exists for three things and does nothing else:
 *
 *   1. making the site installable (a fetch handler is part of that test);
 *   2. a friendly screen when the phone has no signal, instead of the
 *      browser's dinosaur;
 *   3. phone notifications — showing them, and opening the right job when one
 *      is tapped.
 *
 * IT CACHES NOTHING THE PORTAL READS. Every page and every /api call goes to
 * the network exactly as it does in a browser tab, so the installed app can
 * never show a stale job, a stale status or another session's data. Only the
 * offline screen is built here, in memory, and it is shown only when the
 * network request for a page has actually failed.
 *
 * Bump VERSION when this file changes; `skipWaiting` + `clients.claim` make the
 * new worker take over on the next load instead of waiting for every tab to
 * close.
 */
const VERSION = "maintsupp-sw-1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      /* Nothing is cached, but an earlier experiment may have left caches. */
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#101920"><title>MAINTSUPP — offline</title>
<style>
  html,body{margin:0;height:100%;background:#101920;color:#e8eef2;
    font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  main{min-height:100%;display:flex;flex-direction:column;align-items:center;
    justify-content:center;gap:14px;padding:24px;text-align:center;box-sizing:border-box}
  svg{width:72px;height:72px}
  h1{margin:0;font-size:20px}
  p{margin:0;color:#9fb0bb;max-width:320px}
  button{margin-top:8px;border:0;border-radius:10px;background:#12b4a8;color:#06201e;
    font:600 16px system-ui,sans-serif;padding:12px 22px;min-height:44px}
</style></head><body><main>
<svg viewBox="0 0 1024 1024" aria-hidden="true"><rect width="1024" height="1024" rx="170" fill="#16232c"/>
<g fill="none" stroke-width="120" stroke-linecap="round" stroke-linejoin="round">
<path d="M176 823V248l336 359" stroke="#fff"/><path d="M512 607l336-359v575" stroke="#12b4a8"/></g></svg>
<h1>You're offline</h1>
<p>MAINTSUPP needs a connection to show your jobs. Check your signal or Wi-Fi and try again.</p>
<button type="button" onclick="location.reload()">Try again</button>
</main></body></html>`;

self.addEventListener("fetch", (event) => {
  const request = event.request;
  /* Only full page loads get the offline screen. Everything else — API calls,
     uploads, images — is left entirely to the browser. */
  if (request.mode !== "navigate" || request.method !== "GET") return;
  event.respondWith(
    fetch(request).catch(
      () =>
        new Response(OFFLINE_HTML, {
          status: 503,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        }),
    ),
  );
});

/* ── Notifications ─────────────────────────────────────────────────────── */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "MAINTSUPP";
  const options = {
    body: data.body || "",
    icon: "/app-icons/icon-192.png",
    badge: "/app-icons/badge-96.png",
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    data: { url: data.url || "/app?source=installed", version: VERSION },
  };
  /* iOS and Chrome both require a visible notification for every push. */
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(
    (event.notification.data && event.notification.data.url) || "/app?source=installed",
    self.location.origin,
  );
  /* Only ever open our own pages, whatever a payload says. */
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin === target.origin && "focus" in client) {
          await client.focus();
          if ("navigate" in client) return client.navigate(target.href);
          return undefined;
        }
      }
      return self.clients.openWindow(target.href);
    })(),
  );
});
