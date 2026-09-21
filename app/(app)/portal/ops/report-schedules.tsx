"use client";

/**
 * SCHEDULED REPORT EMAILS, under the Reports dashboard — §32.
 *
 * Lists this workspace's schedules, makes new ones, pauses, resumes, deletes,
 * and sends one now. Everything it shows about delivery is what the server
 * said: when email is not configured on this deployment the panel says so
 * before anyone waits, and each run's outcome is the recorded one — a run that
 * could not be delivered reads "Not delivered", never "Sent".
 *
 * Draws nothing for a reader without `data.export` (the API answers 403), the
 * capability that already governs taking these figures out of the portal.
 */

import { useCallback, useEffect, useState } from "react";
import css from "./report-schedules.css?url";

type Schedule = {
  id: string;
  name: string;
  period: string;
  periodLabel: string;
  cadence: "daily" | "weekly" | "monthly";
  weekday: number | null;
  monthDay: number | null;
  recipients: string[];
  state: "active" | "paused";
  nextRunOn: string | null;
  lastRunOn: string | null;
  lastOutcome: string | null;
  lastDetail: string | null;
};
type Person = { id: string; name: string; email: string | null };
type Payload = {
  schedules: Schedule[];
  recipientsAvailable: Person[];
  emailDelivery: { deliverable: boolean; reason: string | null };
};

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const PERIODS: Array<[string, string]> = [
  ["last_7_days", "The last 7 days"],
  ["last_30_days", "The last 30 days"],
  ["month_to_date", "This month so far"],
  ["last_month", "Last calendar month"],
];
const OUTCOME_LABELS: Record<string, string> = {
  sent: "Sent",
  "not-delivered": "Not delivered",
  partial: "Partly delivered",
  failed: "Failed",
  refused: "Not sent",
};

function ordinal(day: number) {
  const suffix = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  return `${day}${suffix}`;
}

function cadenceText(schedule: Pick<Schedule, "cadence" | "weekday" | "monthDay">) {
  if (schedule.cadence === "weekly") return `Every ${WEEKDAYS[(schedule.weekday ?? 1) - 1]}`;
  if (schedule.cadence === "monthly") return `Monthly on the ${ordinal(schedule.monthDay ?? 1)}`;
  return "Every day";
}

async function api(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: { Accept: "application/json", "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "That did not work.");
  return body;
}

export function ReportSchedules() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [hidden, setHidden] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: "Weekly spend report", period: "last_7_days", cadence: "weekly", weekday: 1, monthDay: 1, recipients: [] as string[] });

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/reports/schedules", { headers: { Accept: "application/json" } });
      if (response.status === 403 || response.status === 401) {
        setHidden(true);
        return;
      }
      const body = (await response.json().catch(() => ({}))) as Payload & { error?: string };
      if (!response.ok) throw new Error(body.error || "Scheduled reports could not be loaded.");
      setPayload(body);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Scheduled reports could not be loaded.");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const act = async (work: () => Promise<string | null>) => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      const message = await work();
      if (message) setNotice(message);
      await load();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  if (hidden) return null;
  const people = payload?.recipientsAvailable ?? [];
  const nameOf = (id: string) => people.find((person) => person.id === id)?.name ?? "A former member";

  return (
    <section className="report-schedules" aria-label="Scheduled report emails">
      <link rel="stylesheet" href={css} precedence="default" />
      <header>
        <div>
          <h2>Scheduled report emails</h2>
          <p>The figures above, emailed on a schedule. Each person receives only what they could see here themselves.</p>
        </div>
        {!creating && (
          <button type="button" className="report-schedules__primary" onClick={() => setCreating(true)} disabled={!payload}>
            New schedule
          </button>
        )}
      </header>

      {payload && !payload.emailDelivery.deliverable && (
        <p className="report-schedules__warning" role="status">
          {payload.emailDelivery.reason} Schedules still run on time and record each run, but no report reaches anybody until
          email delivery is set up.
        </p>
      )}
      {problem && <p className="report-schedules__problem" role="alert">{problem}</p>}
      {notice && <p className="report-schedules__notice" role="status">{notice}</p>}

      {creating && payload && (
        <form
          className="report-schedules__form"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await api("/api/reports/schedules", {
                method: "POST",
                body: JSON.stringify({
                  name: draft.name,
                  period: draft.period,
                  cadence: draft.cadence,
                  weekday: draft.cadence === "weekly" ? draft.weekday : null,
                  monthDay: draft.cadence === "monthly" ? draft.monthDay : null,
                  recipients: draft.recipients,
                }),
              });
              setCreating(false);
              return "Schedule saved.";
            });
          }}
        >
          <label>
            <span>Name</span>
            <input value={draft.name} maxLength={120} required onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label>
            <span>Covers</span>
            <select value={draft.period} onChange={(e) => setDraft({ ...draft, period: e.target.value })}>
              {PERIODS.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>How often</span>
            <select value={draft.cadence} onChange={(e) => setDraft({ ...draft, cadence: e.target.value })}>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month</option>
            </select>
          </label>
          {draft.cadence === "weekly" && (
            <label>
              <span>On</span>
              <select value={draft.weekday} onChange={(e) => setDraft({ ...draft, weekday: Number(e.target.value) })}>
                {WEEKDAYS.map((day, index) => (
                  <option key={day} value={index + 1}>{day}</option>
                ))}
              </select>
            </label>
          )}
          {draft.cadence === "monthly" && (
            <label>
              <span>On day</span>
              <select value={draft.monthDay} onChange={(e) => setDraft({ ...draft, monthDay: Number(e.target.value) })}>
                {Array.from({ length: 28 }, (_, index) => index + 1).map((day) => (
                  <option key={day} value={day}>{ordinal(day)}</option>
                ))}
              </select>
            </label>
          )}
          <fieldset>
            <legend>Send to</legend>
            {people.length === 0 && <p>No active members to send to.</p>}
            {people.map((person) => (
              <label key={person.id} className="report-schedules__person">
                <input
                  type="checkbox"
                  checked={draft.recipients.includes(person.id)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      recipients: e.target.checked
                        ? [...draft.recipients, person.id]
                        : draft.recipients.filter((id) => id !== person.id),
                    })
                  }
                />
                <span>{person.name}{person.email ? ` · ${person.email}` : ""}</span>
              </label>
            ))}
          </fieldset>
          <div className="report-schedules__actions">
            <button type="button" onClick={() => setCreating(false)}>Cancel</button>
            <button type="submit" className="report-schedules__primary" disabled={busy || draft.recipients.length === 0}>
              Save schedule
            </button>
          </div>
        </form>
      )}

      {payload && payload.schedules.length === 0 && !creating && (
        <p className="report-schedules__empty">No scheduled reports yet.</p>
      )}
      {payload && payload.schedules.length > 0 && (
        <ul className="report-schedules__list">
          {payload.schedules.map((schedule) => (
            <li key={schedule.id}>
              <div>
                <strong>{schedule.name}</strong>
                <span>
                  {cadenceText(schedule)} · {schedule.periodLabel} · to {schedule.recipients.map(nameOf).join(", ")}
                </span>
                <span>
                  {schedule.state === "paused" ? "Paused" : schedule.nextRunOn ? `Next: ${schedule.nextRunOn}` : "Not scheduled"}
                  {schedule.lastRunOn && ` · Last run ${schedule.lastRunOn}: ${OUTCOME_LABELS[schedule.lastOutcome ?? ""] ?? schedule.lastOutcome}`}
                </span>
                {schedule.lastDetail && <small>{schedule.lastDetail}</small>}
              </div>
              <div className="report-schedules__actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const result = (await api("/api/reports/schedules/run", { method: "POST", body: JSON.stringify({ id: schedule.id }) })) as {
                        outcome?: { outcome: string; detail: string } | null;
                      };
                      return result.outcome ? `${OUTCOME_LABELS[result.outcome.outcome] ?? result.outcome.outcome}: ${result.outcome.detail}` : null;
                    })
                  }
                >
                  Send now
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await api("/api/reports/schedules", {
                        method: "PATCH",
                        body: JSON.stringify({ id: schedule.id, state: schedule.state === "active" ? "paused" : "active" }),
                      });
                      return schedule.state === "active" ? "Schedule paused." : "Schedule resumed.";
                    })
                  }
                >
                  {schedule.state === "active" ? "Pause" : "Resume"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(`Delete the scheduled report "${schedule.name}"?`)) return;
                    void act(async () => {
                      await api(`/api/reports/schedules?id=${encodeURIComponent(schedule.id)}`, { method: "DELETE" });
                      return "Schedule deleted.";
                    });
                  }}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
