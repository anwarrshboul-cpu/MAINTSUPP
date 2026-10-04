"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import qrcode from "qrcode-generator";
import {
  forgetJob,
  readSavedJobs,
  saveJob,
  tokenFromLink,
  type SavedJob,
} from "../../lib/saved-jobs";

/**
 * The MAINTSUPP app's front door — see ./page.tsx for what this page is.
 *
 * Three things decide what is drawn, all of them facts about THIS device:
 *
 *   · installed or not (`display-mode: standalone`, or iOS's `navigator.standalone`);
 *   · which phone (iPhone needs Share → Add to Home Screen in Safari; Android
 *     and desktop Chrome offer a real Install button through
 *     `beforeinstallprompt`);
 *   · which contractor job links it has opened (app/lib/saved-jobs.ts).
 *
 * Nothing here is cached and nothing is trusted from storage: every saved job
 * is re-read from `/api/job-link/<token>` each time, so a revoked or expired
 * link shows as such and a status is always the board's current one.
 */

type Platform = "ios" | "android" | "desktop";

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type LiveJob = {
  status: string | null;
  location: string | null;
  reference: string | null;
  title: string;
  state: "loading" | "open" | "gone";
};

type PushState =
  | "unsupported"
  | "needs-install"
  | "unconfigured"
  | "off"
  | "on"
  | "blocked"
  | "working";

const APP_URL = "https://maintsupp.com/app";

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "desktop";
  const ua = navigator.userAgent;
  /* iPadOS reports itself as a Mac; a touch screen gives it away. */
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) {
    return "ios";
  }
  if (/Android/.test(ua)) return "android";
  return "desktop";
}

function detectInstalled(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function urlKey(base64: string) {
  const padded = base64.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

/* ── The brand ───────────────────────────────────────────────────────────── */

function Mark({ size = 56 }: { size?: number }) {
  return (
    <svg viewBox="0 0 1024 1024" width={size} height={size} aria-hidden="true">
      <rect width="1024" height="1024" rx="210" fill="#16232c" />
      <g fill="none" strokeWidth="120" strokeLinecap="round" strokeLinejoin="round">
        <path d="M176 823V248l336 359" stroke="#ffffff" />
        <path d="M512 607l336-359v575" stroke="#12b4a8" />
      </g>
    </svg>
  );
}

function Wordmark() {
  return (
    <div className="mapp__brand">
      <Mark />
      <div>
        <p className="mapp__word">
          MAINT<span>SUPP</span>
        </p>
        <p className="mapp__tag">Maintenance coordination</p>
      </div>
    </div>
  );
}

function QrCode({ text, label }: { text: string; label: string }) {
  const { path, span } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const size = qr.getModuleCount();
    const parts: string[] = [];
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        if (qr.isDark(row, col)) parts.push(`M${col + 4} ${row + 4}h1v1h-1z`);
      }
    }
    return { path: parts.join(""), span: size + 8 };
  }, [text]);
  return (
    <svg
      className="mapp__qr"
      viewBox={`0 0 ${span} ${span}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={span} height={span} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}

/* ── The page ────────────────────────────────────────────────────────────── */

export default function AppHome() {
  /* Device facts are read after mount: the server cannot know them, and reading
     them during render would be a hydration mismatch. */
  const [ready, setReady] = useState(false);
  const [platform, setPlatform] = useState<Platform>("desktop");
  const [installed, setInstalled] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [saved, setSaved] = useState<SavedJob[]>([]);
  const [live, setLive] = useState<Record<string, LiveJob>>({});
  const [paste, setPaste] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [push, setPush] = useState<PushState>("unsupported");
  const [pushNote, setPushNote] = useState<string | null>(null);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- reading device facts
       that only exist in the browser is the external synchronisation an effect
       is for; there is no render-time source for any of them. */
    setPlatform(detectPlatform());
    setInstalled(detectInstalled());
    setSaved(readSavedJobs());
    setReady(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPrompt);
    };
    const onInstalled = () => {
      setInstallPrompt(null);
      setInstalled(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  /* A notification for a contractor names the job, never its link: find it. */
  useEffect(() => {
    if (!ready) return;
    const ref = new URL(window.location.href).searchParams.get("ref");
    if (!ref) return;
    const match = saved.find((job) => job.reference === ref);
    if (match) window.location.href = `/j/${match.token}`;
  }, [ready, saved]);

  /* Every saved job, re-read live. */
  useEffect(() => {
    let active = true;
    for (const job of saved.slice(0, 25)) {
      fetch(`/api/job-link/${encodeURIComponent(job.token)}`, {
        headers: { Accept: "application/json" },
      })
        .then(async (response) => {
          if (!active) return;
          if (!response.ok) {
            setLive((current) => ({
              ...current,
              [job.token]: { ...job, status: null, state: "gone" },
            }));
            return;
          }
          const payload = (await response.json()) as {
            job?: {
              reference: string | null;
              title: string;
              description: string;
              location: string | null;
              status: string | null;
            };
          };
          if (!active || !payload.job) return;
          const title = payload.job.description?.trim() || payload.job.title;
          setLive((current) => ({
            ...current,
            [job.token]: {
              reference: payload.job?.reference ?? job.reference,
              title,
              location: payload.job?.location ?? job.location,
              status: payload.job?.status ?? null,
              state: "open",
            },
          }));
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [saved]);

  /* ── Notifications ─────────────────────────────────────────────────────── */

  const subscriptionNow = useCallback(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.pushManager.getSubscription();
  }, []);

  const tellServer = useCallback(
    async (subscription: PushSubscription) => {
      const response = await fetch("/api/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          jobTokens: readSavedJobs().map((job) => job.token),
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        account?: boolean;
        jobs?: number;
      };
      if (!response.ok) throw new Error(payload.error || "Notifications could not be switched on.");
      const parts: string[] = [];
      if (payload.account) parts.push("your workspace");
      if (payload.jobs) parts.push(`${payload.jobs} job${payload.jobs === 1 ? "" : "s"}`);
      return parts.length ? `Alerts on for ${parts.join(" and ")}.` : "Alerts on.";
    },
    [],
  );

  useEffect(() => {
    if (!ready) return;
    let active = true;
    void (async () => {
      const capable =
        "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
      if (!capable) {
        /* iPhone only offers notifications to an app on the home screen. */
        if (active) setPush(platform === "ios" && !installed ? "needs-install" : "unsupported");
        return;
      }
      const config = (await fetch("/api/push")
        .then((response) => response.json())
        .catch(() => ({ configured: false }))) as { configured: boolean };
      if (!active) return;
      if (!config.configured) return setPush("unconfigured");
      if (Notification.permission === "denied") return setPush("blocked");
      const existing = await subscriptionNow().catch(() => null);
      if (!active) return;
      if (existing) {
        setPush("on");
        /* Keep the server's list in step with the jobs saved on this phone. */
        tellServer(existing)
          .then((note) => active && setPushNote(note))
          .catch(() => {});
      } else {
        setPush("off");
      }
    })();
    return () => {
      active = false;
    };
  }, [ready, platform, installed, subscriptionNow, tellServer]);

  async function enableAlerts() {
    setPush("working");
    setPushNote(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPush(permission === "denied" ? "blocked" : "off");
        return;
      }
      const config = (await (await fetch("/api/push")).json()) as { publicKey: string | null };
      if (!config.publicKey) throw new Error("Notifications are not set up yet.");
      const registration = await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlKey(config.publicKey),
        }));
      setPushNote(await tellServer(subscription));
      setPush("on");
    } catch (caught) {
      setPushNote(caught instanceof Error ? caught.message : "Alerts could not be switched on.");
      setPush("off");
    }
  }

  async function disableAlerts() {
    setPush("working");
    try {
      const subscription = await subscriptionNow();
      if (subscription) {
        await fetch("/api/push", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }
      setPushNote("Alerts are off on this phone.");
    } finally {
      setPush("off");
    }
  }

  async function testAlert() {
    const subscription = await subscriptionNow().catch(() => null);
    if (!subscription) return;
    const response = await fetch("/api/push?test=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });
    setPushNote(response.ok ? "Test sent — it should arrive in a few seconds." : "The test could not be sent.");
  }

  /* ── Jobs ──────────────────────────────────────────────────────────────── */

  async function addJob(raw: string) {
    setPasteError(null);
    const token = tokenFromLink(raw);
    if (!token) {
      setPasteError("That doesn't look like a MAINTSUPP job link.");
      return;
    }
    const response = await fetch(`/api/job-link/${encodeURIComponent(token)}`).catch(() => null);
    if (!response || !response.ok) {
      setPasteError("That job link no longer opens. Ask your coordinator for a new one.");
      return;
    }
    const payload = (await response.json()) as {
      job: { reference: string | null; title: string; description: string; location: string | null };
    };
    saveJob({
      token,
      reference: payload.job.reference,
      title: payload.job.description?.trim() || payload.job.title,
      location: payload.job.location,
    });
    setSaved(readSavedJobs());
    setPaste("");
    if (push === "on") {
      const subscription = await subscriptionNow().catch(() => null);
      if (subscription) tellServer(subscription).then(setPushNote).catch(() => {});
    }
  }

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      setPaste(text);
      await addJob(text);
    } catch {
      setPasteError("Paste the link into the box, then tap Add.");
    }
  }

  function remove(token: string) {
    forgetJob(token);
    setSaved(readSavedJobs());
  }

  async function install() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    setInstallPrompt(null);
  }

  /* ── Render ────────────────────────────────────────────────────────────── */

  const alerts = (
    <section className="mapp__card" aria-labelledby="mapp-alerts">
      <h2 id="mapp-alerts">Alerts on this phone</h2>
      {push === "needs-install" && (
        <p className="mapp__muted">
          On iPhone, alerts work once MAINTSUPP is on your home screen. Add it (steps above), open it
          from the icon, and switch them on here.
        </p>
      )}
      {push === "unsupported" && (
        <p className="mapp__muted">This browser can&rsquo;t show MAINTSUPP alerts.</p>
      )}
      {push === "unconfigured" && (
        <p className="mapp__muted">Alerts are being set up — check back soon.</p>
      )}
      {push === "blocked" && (
        <p className="mapp__muted">
          Alerts are blocked for MAINTSUPP. Allow them in your phone&rsquo;s Settings → Notifications,
          then come back here.
        </p>
      )}
      {(push === "off" || push === "working") && (
        <>
          <p className="mapp__muted">
            New jobs, status changes, updates and contractor reports — as they happen. Sign in first
            if you have a client account.
          </p>
          <button
            type="button"
            className="mapp__btn"
            onClick={enableAlerts}
            disabled={push === "working"}
          >
            {push === "working" ? "Switching on…" : "Turn on alerts"}
          </button>
        </>
      )}
      {push === "on" && (
        <div className="mapp__row">
          <span className="mapp__on">● Alerts are on</span>
          <button type="button" className="mapp__btn mapp__btn--ghost" onClick={testAlert}>
            Send a test
          </button>
          <button type="button" className="mapp__btn mapp__btn--ghost" onClick={disableAlerts}>
            Turn off
          </button>
        </div>
      )}
      {pushNote && (
        <p className="mapp__note" role="status">
          {pushNote}
        </p>
      )}
    </section>
  );

  const doors = (
    <>
      <section className="mapp__card" aria-labelledby="mapp-clients">
        <h2 id="mapp-clients">Clients</h2>
        <p className="mapp__muted">Your jobs, sites, documents and reports.</p>
        <div className="mapp__row">
          <a className="mapp__btn" href="/login?next=/dashboard">
            Open the client portal
          </a>
          <a className="mapp__btn mapp__btn--ghost" href="/request">
            Report a job
          </a>
        </div>
      </section>

      <section className="mapp__card" aria-labelledby="mapp-jobs">
        <h2 id="mapp-jobs">Contractors — my jobs</h2>
        {saved.length === 0 ? (
          <p className="mapp__muted">
            Jobs arrive as links from your coordinator. Open a link here, or paste it below, and it
            stays in this list.
          </p>
        ) : (
          <ul className="mapp__jobs">
            {saved.map((job) => {
              const now = live[job.token];
              const gone = now?.state === "gone";
              return (
                <li key={job.token} className={gone ? "is-gone" : undefined}>
                  <a href={gone ? undefined : `/j/${job.token}`} aria-disabled={gone || undefined}>
                    <span className="mapp__jobref">{now?.reference ?? job.reference ?? "Job"}</span>
                    <span className="mapp__jobtitle">{now?.title ?? job.title}</span>
                    <span className="mapp__jobmeta">
                      {now?.location ?? job.location ?? ""}
                      {gone
                        ? " · link expired"
                        : now?.status
                          ? ` · ${now.status}`
                          : now
                            ? ""
                            : " · checking…"}
                    </span>
                  </a>
                  <button
                    type="button"
                    className="mapp__remove"
                    onClick={() => remove(job.token)}
                    aria-label={`Remove ${job.reference ?? "this job"} from this phone`}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <form
          className="mapp__paste"
          onSubmit={(event) => {
            event.preventDefault();
            void addJob(paste);
          }}
        >
          <label htmlFor="mapp-paste">Add a job link</label>
          <div className="mapp__row">
            <input
              id="mapp-paste"
              value={paste}
              onChange={(event) => setPaste(event.target.value)}
              placeholder="https://maintsupp.com/j/…"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" className="mapp__btn">
              Add
            </button>
            <button type="button" className="mapp__btn mapp__btn--ghost" onClick={pasteFromClipboard}>
              Paste
            </button>
          </div>
          {pasteError && (
            <p className="mapp__error" role="alert">
              {pasteError}
            </p>
          )}
        </form>
      </section>
    </>
  );

  return (
    <main className="mapp">
      <header className="mapp__head">
        <Wordmark />
      </header>

      {!ready ? null : installed ? (
        <>
          {doors}
          {alerts}
        </>
      ) : (
        <>
          <section className="mapp__hero">
            <h1>The MAINTSUPP app</h1>
            <p>
              Report and follow maintenance jobs from your phone, with alerts when they move. Free, and
              no app store needed — it installs straight from this page.
            </p>
          </section>

          <section className="mapp__card mapp__install" aria-labelledby="mapp-install">
            <h2 id="mapp-install">Install it</h2>
            {platform === "ios" ? (
              <ol className="mapp__steps">
                <li>
                  Open this page in <strong>Safari</strong>.
                </li>
                <li>
                  Tap the <strong>Share</strong> button{" "}
                  <span className="mapp__glyph" aria-hidden="true">
                    ⬆︎
                  </span>{" "}
                  at the bottom of the screen.
                </li>
                <li>
                  Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
                </li>
                <li>Open MAINTSUPP from the new icon and turn on alerts.</li>
              </ol>
            ) : installPrompt ? (
              <>
                <p className="mapp__muted">One tap — it goes on your home screen like any app.</p>
                <button type="button" className="mapp__btn mapp__btn--big" onClick={install}>
                  Install MAINTSUPP
                </button>
              </>
            ) : platform === "android" ? (
              <ol className="mapp__steps">
                <li>
                  Open this page in <strong>Chrome</strong>.
                </li>
                <li>
                  Tap the <strong>⋮</strong> menu, then <strong>Add to Home screen</strong> or{" "}
                  <strong>Install app</strong>.
                </li>
                <li>Open MAINTSUPP from the new icon and turn on alerts.</li>
              </ol>
            ) : (
              <div className="mapp__desk">
                <QrCode text={APP_URL} label="QR code that opens maintsupp.com/app" />
                <p className="mapp__muted">
                  Scan with your phone&rsquo;s camera to install it there. On this computer, Chrome and
                  Edge show an install icon in the address bar.
                </p>
              </div>
            )}
          </section>

          {doors}
          {alerts}
        </>
      )}

      <footer className="mapp__foot">
        <p>MAINTSUPP · 07852 224644 · info@maintsupp.com</p>
        <p>
          <Link href="/">maintsupp.com</Link>
        </p>
      </footer>
    </main>
  );
}
