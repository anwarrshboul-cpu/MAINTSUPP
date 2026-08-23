"use client";

/**
 * The three honest tabs beside the rule list: Run history, My connections
 * and Account usage. Each draws exactly what its route returns and says
 * plainly when that is nothing.
 */

import { useEffect, useState } from "react";
import { loadConnections, loadRuns, loadUsage, type ConnectionView, type RunView, type UsageView } from "./automations-data";
import { formatWhen } from "./automations-list";
import { ActionIcon } from "./board-icons";

function Loading({ what }: { what: string }) {
  return <p className="ba-hint auto-panel__loading">Loading {what}…</p>;
}

function Failed({ message }: { message: string }) {
  return (
    <p className="ba-error" role="alert">
      {message}
    </p>
  );
}

export function RunHistory({ boardId, refreshToken }: { boardId: string; refreshToken: number }) {
  const [runs, setRuns] = useState<RunView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadRuns(boardId)
      .then((payload) => {
        if (cancelled) return;
        setRuns(payload.runs);
        setError(null);
      })
      .catch((cause) => !cancelled && setError(cause instanceof Error ? cause.message : "Run history could not be loaded."));
    return () => {
      cancelled = true;
    };
  }, [boardId, refreshToken]);

  if (error) return <Failed message={error} />;
  if (!runs) return <Loading what="run history" />;
  if (!runs.length) {
    return (
      <div className="auto-empty">
        <ActionIcon name="play" size={28} />
        <strong>No automation runs yet</strong>
        <p>Every time a rule fires — or is considered and skipped — it is written down here.</p>
      </div>
    );
  }
  return (
    <div className="auto-table__scroll">
      <table className="auto-table auto-table--runs">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Automation</th>
            <th scope="col">Status</th>
            <th scope="col">Trigger</th>
            <th scope="col">Action</th>
            <th scope="col">Item</th>
            <th scope="col">By</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} data-run-id={run.id} data-run-status={run.status}>
              <td title={run.createdAt}>{formatWhen(run.createdAt)}</td>
              <td className="auto-table__name">
                {/* A run outlives its rule on purpose — the history is the
                    record that the rule existed and what it did. */}
                {run.automationName ?? <em className="auto-chip auto-chip--deleted">Deleted rule</em>}
                {run.depth > 0 && <small className="auto-table__depth" title="Caused by another automation">chain depth {run.depth}</small>}
              </td>
              <td>
                <em className={`auto-chip auto-chip--${run.status}`}>{run.status}</em>
                {run.error && <small className="auto-table__error">{run.error}</small>}
              </td>
              <td>{run.trigger ?? "—"}</td>
              <td>{run.action ?? "—"}</td>
              <td>{run.requestId ?? "—"}</td>
              <td>{run.actorEmail ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Connections() {
  const [payload, setPayload] = useState<{ connections: ConnectionView[]; note: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadConnections()
      .then((result) => !cancelled && setPayload(result))
      .catch((cause) => !cancelled && setError(cause instanceof Error ? cause.message : "Connections could not be loaded."));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <Failed message={error} />;
  if (!payload) return <Loading what="connections" />;
  return (
    <div className="auto-connections">
      <ul className="auto-connections__list">
        {payload.connections.map((connection) => (
          <li key={connection.key} className={`auto-connection${connection.connected ? " is-connected" : ""}`}>
            <span className="auto-connection__icon">
              <ActionIcon name={connection.key === "email" ? "mail" : "plug"} size={20} />
            </span>
            <div className="auto-connection__meta">
              <strong>
                {connection.label}
                {connection.provider ? ` · ${connection.provider}` : ""}
              </strong>
              <span>{connection.detail}</span>
            </div>
            <em className={`auto-chip ${connection.connected ? "auto-chip--success" : "auto-chip--deleted"}`}>
              {connection.connected ? "Connected" : "Not connected"}
            </em>
          </li>
        ))}
      </ul>
      <p className="ba-hint">{payload.note}</p>
    </div>
  );
}

export function Usage({ boardId, refreshToken }: { boardId: string; refreshToken: number }) {
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadUsage(boardId)
      .then((result) => !cancelled && setUsage(result))
      .catch((cause) => !cancelled && setError(cause instanceof Error ? cause.message : "Usage could not be loaded."));
    return () => {
      cancelled = true;
    };
  }, [boardId, refreshToken]);

  if (error) return <Failed message={error} />;
  if (!usage) return <Loading what="usage" />;
  const since = new Date(usage.month.since);
  const monthLabel = Number.isNaN(since.getTime()) ? "this month" : since.toLocaleString(undefined, { month: "long", year: "numeric" });
  return (
    <div className="auto-usage">
      <dl className="auto-usage__grid">
        <div>
          <dt>Rules</dt>
          <dd>{usage.rules}</dd>
        </div>
        <div>
          <dt>Enabled</dt>
          <dd>{usage.enabled}</dd>
        </div>
        <div>
          <dt>Runs, all time</dt>
          <dd>{usage.totalRuns}</dd>
        </div>
        <div>
          <dt>Runs in {monthLabel}</dt>
          <dd>{usage.month.runs}</dd>
        </div>
        <div>
          <dt>Failed in {monthLabel}</dt>
          <dd>{usage.month.failed}</dd>
        </div>
        <div>
          <dt>Skipped in {monthLabel}</dt>
          <dd>{usage.month.skipped}</dd>
        </div>
        <div>
          <dt>Last run</dt>
          <dd>{usage.lastRun ? `${formatWhen(usage.lastRun.at)} · ${usage.lastRun.status}` : "Never"}</dd>
        </div>
      </dl>
      {/* No meter: there is no quota to draw one against, and the route says so. */}
      <p className="ba-hint">{usage.note}</p>
    </div>
  );
}
