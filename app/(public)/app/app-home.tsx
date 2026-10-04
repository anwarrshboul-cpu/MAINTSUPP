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
import { keepAlertsOn, sendTestAlert, turnOffAlerts, turnOnAlerts } from "../../lib/push-client";

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

/**
 * The app a link was opened INSIDE, when it was — WhatsApp, Instagram,
 * Facebook, LinkedIn and the rest open links in their own built-in browser,
 * where nothing can be installed. That is the commonest reason "install"
 * seems not to work, so it is detected and answered with one button.
 */
function detectInAppBrowser(): string | null {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent;
  const known: Array<[RegExp, string]> = [
    [/WhatsApp/i, "WhatsApp"],
    [/Instagram/i, "Instagram"],
    [/FBAN|FBAV|FB_IAB|FBIOS/i, "Facebook"],
    [/Messenger/i, "Messenger"],
    [/LinkedInApp/i, "LinkedIn"],
    [/Snapchat/i, "Snapchat"],
    [/musical_ly|TikTok|BytedanceWebview/i, "TikTok"],
    [/\bLine\//i, "LINE"],
    [/GSA\//i, "the Google app"],
    [/Twitter/i, "X"],
  ];
  for (const [pattern, name] of known) if (pattern.test(ua)) return name;
  /* Android's generic in-app browser: a WebView marks itself "; wv)". */
  if (/Android/.test(ua) && /; wv\)/.test(ua)) return "this app";
  return null;
}

function detectInstalled(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
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
  const [inApp, setInApp] = useState<string | null>(null);
  /* The iPhone pointer, until it is dismissed. */
  const [pointer, setPointer] = useState(true);
  const [copied, setCopied] = useState(false);
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
    setInApp(detectInAppBrowser());
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

  /* The iPhone pointer has done its job after a few seconds. */
  useEffect(() => {
    if (!pointer) return;
    const timer = window.setTimeout(() => setPointer(false), 12000);
    return () => window.clearTimeout(timer);
  }, [pointer]);

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
      } else if (await keepAlertsOn(readSavedJobs().map((job) => job.token))) {
        /* Allowed before and not switched off: on by default, no tap. */
        if (active) setPush("on");
      } else if (active) {
        setPush("off");
      }
    })();
    return () => {
      active = false;
    };
  }, [ready, platform, installed, subscriptionNow, tellServer]);

  /* The same switch the portal's banner and Account use (app/lib/push-client.ts),
     so "off" chosen anywhere stays off everywhere on this phone. */
  async function enableAlerts() {
    setPush("working");
    setPushNote(null);
    try {
      const result = await turnOnAlerts(readSavedJobs().map((job) => job.token));
      const parts: string[] = [];
      if (result.account) parts.push("your workspace");
      if (result.jobs) parts.push(`${result.jobs} job${result.jobs === 1 ? "" : "s"}`);
      setPushNote(parts.length ? `Alerts on for ${parts.join(" and ")}.` : "Alerts on.");
      setPush("on");
    } catch (caught) {
      setPushNote(caught instanceof Error ? caught.message : "Alerts could not be switched on.");
      setPush(Notification.permission === "denied" ? "blocked" : "off");
    }
  }

  async function disableAlerts() {
    setPush("working");
    try {
      await turnOffAlerts();
      setPushNote("Alerts are off on this phone.");
    } finally {
      setPush("off");
    }
  }

  async function testAlert() {
    const sent = await sendTestAlert().catch(() => false);
    setPushNote(sent ? "Test sent — it should arrive in a few seconds." : "The test could not be sent.");
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

  /* Android: an intent link opens this page in Chrome, which can install it. */
  const chromeIntent =
    "intent://maintsupp.com/app#Intent;scheme=https;package=com.android.chrome;end";
  /* iPhone (iOS 17+): this scheme hands the page to Safari from inside an app. */
  const safariLink = "x-safari-https://maintsupp.com/app";

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(APP_URL);
      setCopied(true);
    } catch {
      setCopied(false);
    }
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
            <h1>Get the MAINTSUPP app</h1>
            <p>Free. No app store. Report and follow jobs, with alerts on your phone.</p>
          </section>

          <section className="mapp__card mapp__install" aria-labelledby="mapp-install">
            {inApp ? (
              /* Inside WhatsApp & co nothing can be installed: one way out. */
              <>
                <h2 id="mapp-install">
                  Open in {platform === "ios" ? "Safari" : "Chrome"} to install
                </h2>
                <p className="mapp__muted">
                  You opened this inside {inApp}, which can&rsquo;t install apps.
                </p>
                <a
                  className="mapp__btn mapp__btn--big"
                  href={platform === "ios" ? safariLink : chromeIntent}
                >
                  Open in {platform === "ios" ? "Safari" : "Chrome"}
                </a>
                <button type="button" className="mapp__btn mapp__btn--ghost" onClick={copyLink}>
                  {copied ? "Link copied — paste it in your browser" : "Copy the link instead"}
                </button>
              </>
            ) : platform === "ios" ? (
              /* Apple allows no install button: two taps, shown, not described. */
              <>
                <h2 id="mapp-install">Add it in two taps</h2>
                <ol className="mapp__picsteps">
                  <li>
                    <span className="mapp__picicon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 3v12" />
                        <path d="m7 8 5-5 5 5" />
                        <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
                      </svg>
                    </span>
                    <span>
                      Tap <strong>Share</strong>
                      <small>at the bottom of Safari (or ⋯ then Share)</small>
                    </span>
                  </li>
                  <li>
                    <span className="mapp__picicon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="4" />
                        <path d="M12 8v8" />
                        <path d="M8 12h8" />
                      </svg>
                    </span>
                    <span>
                      Tap <strong>Add to Home Screen</strong>
                      <small>then Add — done</small>
                    </span>
                  </li>
                </ol>
              </>
            ) : installPrompt ? (
              <>
                <h2 id="mapp-install">Install in one tap</h2>
                <button type="button" className="mapp__btn mapp__btn--big" onClick={install}>
                  Install MAINTSUPP
                </button>
              </>
            ) : platform === "android" ? (
              <>
                <h2 id="mapp-install">Install in one tap</h2>
                <p className="mapp__muted">
                  Tap <strong>⋮</strong> at the top of Chrome, then <strong>Install app</strong>.
                </p>
              </>
            ) : (
              <>
                <h2 id="mapp-install">Scan to get it on your phone</h2>
                <div className="mapp__desk">
                  <QrCode text={APP_URL} label="QR code that opens maintsupp.com/app" />
                  <p className="mapp__muted">
                    Point your phone&rsquo;s camera at the code. On this computer, Chrome and Edge show
                    an install icon in the address bar.
                  </p>
                </div>
              </>
            )}
            <a className="mapp__skip" href="#mapp-clients">
              Not now — use it in the browser
            </a>
          </section>

          {platform === "ios" && !inApp && pointer && (
            /* Points at Safari's toolbar, where Share is. Decorative and
               click-through, so it never covers a button; gone after 12s. */
            <div className="mapp__pointer" aria-hidden="true">
              <span>Tap Share below</span>
              <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 4v16" />
                <path d="m5 13 7 7 7-7" />
              </svg>
            </div>
          )}

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
