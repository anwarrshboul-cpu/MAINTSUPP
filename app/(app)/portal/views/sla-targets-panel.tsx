"use client";

/**
 * SETTINGS → SLA TARGETS — the percentages the live Overview's SLA figures are
 * held to. Dashboard §4.4 and §9 item 25; owner decision 2026-09-23.
 *
 * "Overall" is the Priority & SLA gauge's target; each priority is the target
 * its bar in "SLA Compliance by Priority Tier" is drawn against. Until a
 * workspace saves one, every key is the shipped 95% and says "default".
 *
 * A save is a new VERSION of each changed key — the previous one is kept, with
 * when it applied and who set it, in "Earlier versions" below. Nothing about
 * which jobs count as within SLA changes here: this sets the line, not the
 * measurement, so the Jobs board and the Overview still agree on every job.
 *
 * `settings.edit` to change (owner and admin, per §4.4); anyone who can see the
 * Overview may read them, so a member sees the numbers the card is held to
 * rather than an empty card. Usable at 375px: one column, 44px inputs.
 */

import { useCallback, useEffect, useState } from "react";

import { Icon } from "../../../components";
import { PRIORITY_DISPLAY_LABEL } from "../dashboard-meters";
import "./sla-targets-panel.css";

type TargetKey = "overall" | "urgent" | "medium" | "low" | "not_recorded";

type Entry = {
  key: TargetKey;
  percent: number;
  source: "default" | "workspace";
  version: number | null;
  effectiveFrom: string | null;
  updatedBy: string | null;
};

type HistoryRow = {
  key: TargetKey;
  percent: number | null;
  version: number;
  effectiveFrom: string;
  supersededAt: string | null;
  updatedBy: string | null;
};

type Payload = {
  targets: { entries: Entry[] };
  history: HistoryRow[];
  defaultPercent: number;
  range: { min: number; max: number };
  canEdit: boolean;
  error?: string;
};

function keyLabel(key: TargetKey): string {
  if (key === "overall") return "Overall";
  return (PRIORITY_DISPLAY_LABEL as Record<string, string>)[key] ?? key;
}

function keyUse(key: TargetKey): string {
  return key === "overall" ? "The Priority & SLA gauge" : "Its bar in SLA Compliance by Priority Tier";
}

function when(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function SlaTargetsPanel() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/sla-targets", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as Payload | null;
      if (!response.ok || !body) {
        setFailure(body?.error ?? "Could not load the SLA targets.");
        return;
      }
      setPayload(body);
      setDraft(Object.fromEntries(body.targets.entries.map((entry) => [entry.key, String(entry.percent)])));
      setFailure(null);
    } catch {
      setFailure("Could not load the SLA targets.");
    }
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- `load` awaits the fetch
     before it touches state, exactly as the logo and brand-colour panels
     beside this one do; reading the stored targets on mount is what an effect
     is for. */
  useEffect(() => {
    void load();
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!payload) {
    return failure ? (
      <section className="panel settings-card">
        <div className="settings-card__heading">
          <span>
            <Icon name="clock" size={19} />
          </span>
          <div>
            <h2>SLA targets</h2>
            <p role="alert">{failure}</p>
          </div>
        </div>
      </section>
    ) : null;
  }

  const { canEdit, range } = payload;
  const entries = payload.targets.entries;
  const changed = entries.filter((entry) => draft[entry.key]?.trim() !== String(entry.percent));
  const invalid = changed.filter((entry) => {
    const value = Number(draft[entry.key]);
    return !Number.isInteger(value) || value < range.min || value > range.max;
  });

  const save = async () => {
    if (changed.length === 0 || invalid.length > 0) return;
    setBusy(true);
    setFailure(null);
    setStatus(null);
    try {
      const targets = Object.fromEntries(changed.map((entry) => [entry.key, Number(draft[entry.key])]));
      const response = await fetch("/api/sla-targets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets }),
      });
      const body = (await response.json().catch(() => null)) as
        | (Payload & { changes?: Array<{ key: TargetKey; from: number; to: number; version: number }> })
        | null;
      if (!response.ok || !body) {
        setFailure(body?.error ?? "The SLA targets could not be saved.");
        return;
      }
      setPayload((current) => (current ? { ...current, targets: body.targets, history: body.history } : current));
      setDraft(Object.fromEntries(body.targets.entries.map((entry) => [entry.key, String(entry.percent)])));
      const count = body.changes?.length ?? 0;
      setStatus(
        count === 0
          ? "Nothing changed."
          : `Saved ${count} ${count === 1 ? "target" : "targets"} as a new version. The Overview uses ${count === 1 ? "it" : "them"} from now on.`,
      );
    } catch {
      setFailure("The SLA targets could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel settings-card sla-targets" aria-labelledby="sla-targets-title">
      <div className="settings-card__heading">
        <span>
          <Icon name="clock" size={19} />
        </span>
        <div>
          <h2 id="sla-targets-title">SLA targets</h2>
          <p>
            The share of open jobs within their due date that the Overview holds each priority to. Every change is kept
            as a new version; earlier ones stay listed below.
          </p>
        </div>
      </div>

      <div className="sla-targets__rows">
        {entries.map((entry) => {
          const id = `sla-target-${entry.key}`;
          const bad = invalid.some((row) => row.key === entry.key);
          return (
            <div key={entry.key} className="sla-targets__row">
              <label htmlFor={id} className="sla-targets__label">
                <strong>{keyLabel(entry.key)}</strong>
                <small>{keyUse(entry.key)}</small>
                <small className="sla-targets__source">
                  {entry.source === "default"
                    ? `Default (${payload.defaultPercent}%)`
                    : `Version ${entry.version} · from ${when(entry.effectiveFrom)}${entry.updatedBy ? ` · ${entry.updatedBy}` : ""}`}
                </small>
              </label>
              {canEdit ? (
                <span className="sla-targets__field">
                  <input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    min={range.min}
                    max={range.max}
                    step={1}
                    value={draft[entry.key] ?? ""}
                    aria-invalid={bad || undefined}
                    aria-describedby={bad ? `${id}-error` : undefined}
                    onChange={(event) => setDraft((current) => ({ ...current, [entry.key]: event.target.value }))}
                  />
                  <span aria-hidden="true">%</span>
                </span>
              ) : (
                <strong id={id} className="sla-targets__value">
                  {entry.percent}%
                </strong>
              )}
              {bad ? (
                <p id={`${id}-error`} className="sla-targets__error" role="alert">
                  A whole percentage from {range.min} to {range.max}.
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      {canEdit ? (
        <div className="sla-targets__actions">
          <button
            className="primary-button"
            type="button"
            onClick={() => void save()}
            disabled={busy || changed.length === 0 || invalid.length > 0}
          >
            <Icon name="check" size={17} />
            {busy ? "Saving…" : "Save SLA targets"}
          </button>
        </div>
      ) : (
        <p className="sla-targets__note">Only an owner or admin can change these.</p>
      )}
      {status ? (
        <p className="sla-targets__status" role="status">
          {status}
        </p>
      ) : null}
      {failure ? (
        <p className="sla-targets__error" role="alert">
          {failure}
        </p>
      ) : null}

      {payload.history.length > 0 ? (
        <details className="sla-targets__history">
          <summary>Earlier versions</summary>
          <ul>
            {payload.history.map((row) => (
              <li key={`${row.key}-${row.version}-${row.effectiveFrom}`}>
                <strong>{keyLabel(row.key)}</strong> {row.percent ?? "—"}% · version {row.version} · from{" "}
                {when(row.effectiveFrom)}
                {row.supersededAt ? ` to ${when(row.supersededAt)}` : " · in effect"}
                {row.updatedBy ? ` · ${row.updatedBy}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
