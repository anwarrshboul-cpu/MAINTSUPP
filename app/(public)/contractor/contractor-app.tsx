"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { readSavedJobs, saveJob } from "../../lib/saved-jobs";
import {
  alertSupport,
  alertsTurnedOff,
  askAlertPermissionNow,
  keepAlertsOn,
  turnOffAlerts,
  turnOnAlerts,
} from "../../lib/push-client";

/**
 * THE CONTRACTOR'S VIEW OF THE MAINTSUPP APP — the Fix Tracker, for their
 * jobs only.
 *
 * Same app, same icon, same front door (/app) as clients; a contractor who
 * signs in lands here instead of the portal. Three tabs like the office's Fix
 * Tracker — Incoming, Booked, Completed — over the jobs assigned to them
 * (/api/contractor/me). Opening a job goes to the job's full page (photos,
 * uploads, notes, completion, signature), the same page their job links have
 * always opened, minted fresh for them by /api/contractor/jobs/:id/open.
 *
 * ALERTS: asked for inside the Sign-in tap, then switched on silently; an
 * "Allow alerts" button only appears if the phone has not been asked yet.
 */

type Job = {
  id: string;
  location: string;
  description: string;
  title: string;
  status: string | null;
  stage: string | null;
  priority: string | null;
  engineer: string | null;
  requestedAt: string | null;
  dueAt: string | null;
  completedAt: string | null;
  attachmentCount: number | null;
  client: string | null;
};

type Me = { signedIn: true; name: string; jobs: Job[] };
type Tab = "incoming" | "booked" | "completed";

const TABS: Array<[Tab, string]> = [
  ["incoming", "Incoming"],
  ["booked", "Booked"],
  ["completed", "Completed"],
];

/** The office Fix Tracker's own rule (app/(app)/portal/views/fix-tracker.tsx). */
function stateOf(job: Job): Tab {
  const stage = (job.stage ?? "").trim().toLowerCase();
  if (stage === "booked") return "booked";
  if (stage === "completed") return "completed";
  if (stage) return "incoming";
  const status = (job.status ?? "").toLowerCase();
  if (status.includes("completed")) return "completed";
  if (status.includes("scheduled") || status.includes("in progress") || status.includes("booked")) {
    return "booked";
  }
  return "incoming";
}

function age(value: string | null) {
  if (!value) return "";
  const then = new Date(value.includes("T") ? value : `${value}T00:00:00Z`).getTime();
  if (Number.isNaN(then)) return "";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}

function shortDate(value: string | null) {
  if (!value) return "";
  const date = new Date(value.includes("T") ? value : `${value}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function Mark() {
  return (
    <svg viewBox="0 0 1024 1024" width="44" height="44" aria-hidden="true">
      <rect width="1024" height="1024" rx="210" fill="#16232c" />
      <g fill="none" strokeWidth="120" strokeLinecap="round" strokeLinejoin="round">
        <path d="M176 823V248l336 359" stroke="#ffffff" />
        <path d="M512 607l336-359v575" stroke="#12b4a8" />
      </g>
    </svg>
  );
}

/* ── Sign-in ─────────────────────────────────────────────────────────────── */

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [identity, setIdentity] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("maintsupp:contractor-identity");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- browser storage only exists after mount
      if (saved) setIdentity(saved);
    } catch {
      /* Nothing remembered. */
    }
  }, []);

  async function sendCode(event: React.FormEvent) {
    event.preventDefault();
    void askAlertPermissionNow();
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const response = await fetch("/api/contractor/code/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        unavailable?: boolean;
        message?: string;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? "That didn't work. Try again.");
      if (payload.unavailable) {
        setError(payload.message ?? "Codes aren't switched on yet.");
        return;
      }
      setNote(payload.message ?? "A code is on its way.");
      setSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    void askAlertPermissionNow();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/contractor/code/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity, code, remember }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "That code didn't work.");
      try {
        if (remember) window.localStorage.setItem("maintsupp:contractor-identity", identity.trim());
      } catch {
        /* Not remembered. */
      }
      onSignedIn();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That code didn't work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mapp__card" aria-labelledby="ctr-signin">
      <h1 id="ctr-signin" className="ctr__title">
        Contractor sign-in
      </h1>
      {!sent ? (
        <form className="ctr__form" onSubmit={sendCode}>
          <label htmlFor="ctr-identity">Your email or mobile number</label>
          <input
            id="ctr-identity"
            value={identity}
            onChange={(event) => setIdentity(event.target.value)}
            placeholder="name@company.com or 07…"
            autoComplete="username"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
          <label className="ctr__remember">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            Keep me signed in
          </label>
          <button type="submit" className="mapp__btn mapp__btn--big" disabled={busy || !identity.trim()}>
            {busy ? "Sending…" : "Send me a code"}
          </button>
        </form>
      ) : (
        <form className="ctr__form" onSubmit={verify}>
          <label htmlFor="ctr-code">Enter the 6-digit code</label>
          <input
            id="ctr-code"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            className="ctr__code"
            required
          />
          <button type="submit" className="mapp__btn mapp__btn--big" disabled={busy || code.length < 4}>
            {busy ? "Checking…" : "Sign in"}
          </button>
          <button type="button" className="mapp__btn mapp__btn--ghost" onClick={() => setSent(false)}>
            Use a different email or number
          </button>
        </form>
      )}
      {note && <p className="mapp__note">{note}</p>}
      {error && (
        <p className="mapp__error" role="alert">
          {error}
        </p>
      )}
      <p className="mapp__muted ctr__hint">
        Got an app link from your coordinator on WhatsApp? Just open it — it signs you in.
      </p>
      <p className="mapp__muted ctr__hint">
        A client? <a href="/login">Sign in to the client portal</a>
      </p>
    </section>
  );
}

/* ── The jobs ────────────────────────────────────────────────────────────── */

function Jobs({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const [tab, setTab] = useState<Tab>("incoming");
  const [query, setQuery] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<"on" | "ask" | "off" | "none">("none");

  const counts = useMemo(() => {
    const result: Record<Tab, number> = { incoming: 0, booked: 0, completed: 0 };
    for (const job of me.jobs) result[stateOf(job)] += 1;
    return result;
  }, [me.jobs]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return me.jobs.filter(
      (job) =>
        stateOf(job) === tab &&
        (!needle ||
          [job.id, job.location, job.description, job.client ?? ""].some((value) =>
            value.toLowerCase().includes(needle),
          )),
    );
  }, [me.jobs, tab, query]);

  const open = useCallback(async (job: Job) => {
    setOpening(job.id);
    setError(null);
    try {
      /* Reuse a link this phone already holds for the job, if it still opens. */
      const known = readSavedJobs().find((entry) => entry.reference === job.id);
      if (known) {
        const check = await fetch(`/api/job-link/${encodeURIComponent(known.token)}`).catch(() => null);
        if (check?.ok) {
          window.location.href = `/j/${known.token}`;
          return;
        }
      }
      const response = await fetch(`/api/contractor/jobs/${encodeURIComponent(job.id)}/open`, {
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as { url?: string; token?: string; error?: string };
      if (!response.ok || !payload.url || !payload.token) throw new Error(payload.error ?? "That job can't be opened.");
      saveJob({ token: payload.token, reference: job.id, title: job.description || job.title, location: job.location });
      window.location.href = payload.url;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That job can't be opened.");
      setOpening(null);
    }
  }, []);

  /* A notification names a job: open it. */
  useEffect(() => {
    const ref = new URL(window.location.href).searchParams.get("job");
    const job = ref ? me.jobs.find((entry) => entry.id === ref) : null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- opening the job a notification named is navigation, after the job list loaded
    if (job) void open(job);
  }, [me.jobs, open]);

  /* Alerts: on without asking once the phone has allowed them. */
  useEffect(() => {
    let active = true;
    void (async () => {
      if (alertSupport() !== "ready") return;
      if (alertsTurnedOff()) {
        if (active) setAlerts("off");
        return;
      }
      if (Notification.permission === "granted") {
        const on = await keepAlertsOn();
        if (active) setAlerts(on ? "on" : "off");
      } else if (Notification.permission === "default" && active) {
        setAlerts("ask");
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function allowAlerts() {
    try {
      await turnOnAlerts();
      setAlerts("on");
    } catch {
      setAlerts("off");
    }
  }

  return (
    <>
      <header className="ctr__bar">
        <div>
          <p className="ctr__hello">Hello, {me.name}</p>
          <p className="mapp__muted">Your jobs from MAINTSUPP</p>
        </div>
        <button type="button" className="mapp__btn mapp__btn--ghost ctr__out" onClick={onSignOut}>
          Sign out
        </button>
      </header>

      {alerts === "ask" && (
        <div className="ctr__alert">
          <span>Get an alert when a new job comes in</span>
          <button type="button" className="mapp__btn" onClick={() => void allowAlerts()}>
            Allow alerts
          </button>
        </div>
      )}

      <div className="ctr__tabs" role="tablist" aria-label="Jobs">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? "is-active" : undefined}
            onClick={() => setTab(key)}
          >
            {label}
            <em>{counts[key]}</em>
          </button>
        ))}
      </div>

      <input
        className="ctr__search"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search jobs, sites…"
        aria-label="Search your jobs"
      />

      {error && (
        <p className="mapp__error" role="alert">
          {error}
        </p>
      )}

      {shown.length === 0 ? (
        <p className="mapp__muted ctr__empty">
          {tab === "incoming"
            ? "No new jobs right now. You'll get an alert when one comes in."
            : tab === "booked"
              ? "Nothing booked."
              : "No completed jobs yet."}
        </p>
      ) : (
        <ul className="ctr__list">
          {shown.map((job) => (
            <li key={job.id}>
              <button type="button" className="ctr__card" onClick={() => void open(job)} disabled={opening !== null}>
                <span className="ctr__cardhead">
                  <span className="mapp__jobref">{job.id}</span>
                  {job.priority && <span className={`ctr__chip ctr__chip--${job.priority.toLowerCase()}`}>{job.priority}</span>}
                </span>
                <span className="ctr__cardtitle">{job.description?.trim() || job.title}</span>
                <span className="ctr__cardmeta">
                  {job.location}
                  {job.client ? ` · ${job.client}` : ""}
                </span>
                <span className="ctr__cardfoot">
                  <span>{job.status}</span>
                  <span>
                    {tab === "completed"
                      ? shortDate(job.completedAt)
                      : job.dueAt
                        ? `Due ${shortDate(job.dueAt)}`
                        : age(job.requestedAt)}
                  </span>
                </span>
                {opening === job.id && <span className="ctr__opening">Opening…</span>}
              </button>
            </li>
          ))}
        </ul>
      )}

      {alerts === "on" && (
        <p className="mapp__muted ctr__alertsline">
          Alerts are on.{" "}
          <button
            type="button"
            className="ctr__link"
            onClick={() => void turnOffAlerts().then(() => setAlerts("off"))}
          >
            Turn off
          </button>
        </p>
      )}
      {alerts === "off" && alertSupport() === "ready" && (
        <p className="mapp__muted ctr__alertsline">
          Alerts are off.{" "}
          <button type="button" className="ctr__link" onClick={() => void allowAlerts()}>
            Turn on
          </button>
        </p>
      )}
    </>
  );
}

/* ── The page ────────────────────────────────────────────────────────────── */

export default function ContractorApp() {
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/contractor/me", { headers: { Accept: "application/json" } }).catch(
      () => null,
    );
    const payload = response?.ok ? ((await response.json().catch(() => null)) as Me | null) : null;
    setMe(payload && payload.signedIn ? payload : null);
    setChecked(true);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- awaits the server before touching state
    void load();
  }, [load]);

  async function signOut() {
    await fetch("/api/contractor/logout", { method: "POST" }).catch(() => null);
    setMe(null);
  }

  return (
    <main className="mapp ctr">
      <header className="mapp__head">
        <div className="mapp__brand">
          <Mark />
          <div>
            <p className="mapp__word">
              MAINT<span>SUPP</span>
            </p>
            <p className="mapp__tag">Contractor jobs</p>
          </div>
        </div>
      </header>
      {!checked ? (
        <p className="mapp__muted">Loading…</p>
      ) : me ? (
        <Jobs me={me} onSignOut={() => void signOut()} />
      ) : (
        <SignIn onSignedIn={() => void load()} />
      )}
      <footer className="mapp__foot">
        <p>MAINTSUPP · 07852 224644 · info@maintsupp.com</p>
      </footer>
    </main>
  );
}
