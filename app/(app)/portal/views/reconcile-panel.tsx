"use client";

/**
 * THE RECONCILIATION TABLE — Module 3 §4.2.
 *
 * Metric | Expected | Actual | Difference | Pass/Fail, a headline pass rate, a
 * total failure count, a Re-run button and the time of the last run. A failing
 * row expands to show the query the application ran and the record ids behind
 * both sides, because §4.2 is explicit about why that matters: the discrepancy
 * should be diagnosable in one click rather than in an afternoon.
 *
 * ── FAILURES FIRST, AND NOTHING IS COLLAPSED AWAY ─────────────────────────
 *
 * The sections keep the server's order, but a section with a failure in it is
 * open and a section without one is closed. That is the only sorting this page
 * does: a table of 130 green rows with two red ones somewhere in the middle is
 * a table nobody reads, and re-ordering the rows themselves would break the
 * one thing the boundary matrix section is for — reading down the offsets in
 * §3.3's own order and seeing where the count stops matching.
 *
 * ── THREE STATES, NOT TWO ────────────────────────────────────────────────
 *
 * `not-measured` is drawn distinctly from both a pass and a failure, and is
 * excluded from the pass rate. A metric this schema cannot answer — §3.2's
 * twenty contacts, which have no table — is not a success and is not a bug, and
 * showing it as either teaches the reader to distrust the column.
 *
 * ── COLOUR IS NEVER THE ONLY SIGNAL ──────────────────────────────────────
 *
 * Every row carries the word as well as the colour, and the difference column
 * carries a sign. A reader who cannot separate the two hues loses nothing,
 * which is the same rule the job status chips follow.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import reconcileCss from "./reconcile-panel.css?url";

type ReconcileStatus = "pass" | "fail" | "not-measured";

type ReconcileRow = {
  key: string;
  section: string;
  metric: string;
  expected: number | null;
  actual: number | null;
  difference: number | null;
  status: ReconcileStatus;
  query: string;
  note?: string;
  expectedIds?: string[];
  actualIds?: string[];
};

type ReconcileReport = {
  ranAt: string;
  today: string;
  seedBatchId: string;
  organisationId: string;
  rows: ReconcileRow[];
  passed: number;
  failed: number;
  notMeasured: number;
  passRate: number | null;
  seeded: boolean;
};

type ReconcilePayload = {
  report?: ReconcileReport;
  seeded?: boolean;
  note?: string | null;
  environment?: {
    organisationId: string;
    checks: Array<{ name: string; passed: boolean; observed: string; reason: string }>;
  };
  error?: string;
  reason?: string;
  refusedBy?: string[];
  checks?: Array<{ name: string; passed: boolean; observed: string; reason: string }>;
};

const STATUS_WORD: Record<ReconcileStatus, string> = {
  pass: "Pass",
  fail: "Fail",
  "not-measured": "Not measured",
};

/** A signed difference, or an em dash where there is nothing to subtract. */
function differenceText(row: ReconcileRow): string {
  if (row.difference === null) return "—";
  if (row.difference === 0) return "0";
  return row.difference > 0 ? `+${row.difference}` : String(row.difference);
}

function numberText(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-GB");
}

function timeText(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function ReconcilePanel({ today }: { today?: string } = {}) {
  const [payload, setPayload] = useState<ReconcilePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /* Guards against a slow first request overwriting a faster second one — the
     Re-run button is the whole point of this page and is meant to be pressed. */
  const runToken = useRef(0);

  /*
   * The fetch happens BEFORE any state is touched, deliberately.
   *
   * `react-hooks/set-state-in-effect` refuses a synchronous setState in an
   * effect body and is right to: it is what turns one render into three. The
   * "Running…" label is therefore set by the click handler below — an event
   * handler may set state synchronously — and cleared here, which leaves this
   * function awaiting first and setting state once.
   */
  const run = useCallback(async () => {
    const token = (runToken.current += 1);
    let next: ReconcilePayload;
    try {
      const query = today ? `?today=${encodeURIComponent(today)}` : "";
      const response = await fetch(`/api/admin/reconcile${query}`, {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      next = (await response.json()) as ReconcilePayload;
    } catch {
      next = { error: "The reconciliation could not be reached." };
    }
    /* A slow first request must not overwrite a faster second one. The Re-run
       button is the point of this page and is meant to be pressed twice. */
    if (token !== runToken.current) return;
    setPayload(next);
    setLoading(false);
  }, [today]);

  const rerun = () => {
    setLoading(true);
    void run();
  };

  /* No eslint-disable here, unlike `audit-log.tsx` next door, and the
     difference is the point: `run` awaits the fetch before it touches state, so
     there is genuinely no synchronous setState in this effect body to suppress.
     Reading a server-computed reconciliation when the day under test changes is
     the external-system synchronisation an effect is for. */
  useEffect(() => {
    void run();
  }, [run]);

  const report = payload?.report ?? null;

  const sections = useMemo(() => {
    if (!report) return [] as Array<{ name: string; rows: ReconcileRow[]; failed: number }>;
    const order: string[] = [];
    const grouped = new Map<string, ReconcileRow[]>();
    for (const row of report.rows) {
      if (!grouped.has(row.section)) {
        grouped.set(row.section, []);
        order.push(row.section);
      }
      (grouped.get(row.section) as ReconcileRow[]).push(row);
    }
    return order.map((name) => {
      const rows = grouped.get(name) as ReconcileRow[];
      return { name, rows, failed: rows.filter((row) => row.status === "fail").length };
    });
  }, [report]);

  const toggle = (key: string) =>
    setExpanded((current) => ({ ...current, [key]: !current[key] }));

  return (
    <>
      <link rel="stylesheet" href={reconcileCss} />
      <section className="reconcile" aria-label="Seed data reconciliation">
        <header className="reconcile__head">
          <div>
            <h2>Numbers reconciliation</h2>
            <p className="reconcile__sub">
              Every figure is computed twice — once from the generated dataset and once
              by the application&rsquo;s own queries against the database. A row is only
              green when the two agree.
            </p>
          </div>
          <div className="reconcile__actions">
            <button type="button" onClick={rerun} disabled={loading}>
              {loading ? "Running…" : "Re-run"}
            </button>
            {report ? (
              <span className="reconcile__ran">Last run {timeText(report.ranAt)}</span>
            ) : null}
          </div>
        </header>

        {payload?.error ? (
          <div className="reconcile__notice reconcile__notice--stop" role="status">
            <strong>{payload.error}</strong>
            {payload.reason ? <p>{payload.reason}</p> : null}
            {(payload.checks ?? []).map((check) => (
              <p key={check.name} className="reconcile__check">
                <span className={check.passed ? "is-pass" : "is-fail"}>
                  {check.passed ? "Passed" : "Refused"}
                </span>{" "}
                <code>{check.name}</code> read <code>{check.observed}</code> — {check.reason}
              </p>
            ))}
          </div>
        ) : null}

        {report && !report.seeded ? (
          <div className="reconcile__notice" role="status">
            {payload?.note ??
              "No seeded rows were found. Run `npm run seed` before reading these numbers."}
          </div>
        ) : null}

        {report ? (
          <>
            <dl className="reconcile__headline">
              <div>
                <dt>Pass rate</dt>
                <dd className={report.failed > 0 ? "is-fail" : "is-pass"}>
                  {report.passRate === null ? "—" : `${report.passRate}%`}
                </dd>
              </div>
              <div>
                <dt>Failures</dt>
                <dd className={report.failed > 0 ? "is-fail" : "is-pass"}>{report.failed}</dd>
              </div>
              <div>
                <dt>Passing</dt>
                <dd>{report.passed}</dd>
              </div>
              <div>
                <dt>Not measured</dt>
                <dd>{report.notMeasured}</dd>
              </div>
              <div>
                <dt>Measured against</dt>
                <dd>
                  <code>{report.today}</code>
                </dd>
              </div>
              <div>
                <dt>Batch</dt>
                <dd>
                  <code>{report.seedBatchId}</code>
                </dd>
              </div>
            </dl>

            {sections.map((section) => (
              <details
                key={section.name}
                className="reconcile__section"
                open={section.failed > 0}
              >
                <summary>
                  <span>{section.name}</span>
                  <span
                    className={
                      section.failed > 0
                        ? "reconcile__tally is-fail"
                        : "reconcile__tally is-pass"
                    }
                  >
                    {section.failed > 0
                      ? `${section.failed} failing of ${section.rows.length}`
                      : `${section.rows.length} rows`}
                  </span>
                </summary>
                <div className="reconcile__scroll">
                  <table className="reconcile__table">
                    <thead>
                      <tr>
                        <th scope="col">Metric</th>
                        <th scope="col" className="is-number">
                          Expected
                        </th>
                        <th scope="col" className="is-number">
                          Actual
                        </th>
                        <th scope="col" className="is-number">
                          Difference
                        </th>
                        <th scope="col">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {section.rows.map((row) => {
                        const open = Boolean(expanded[row.key]);
                        const detailed =
                          row.status !== "pass" ||
                          Boolean(row.note) ||
                          Boolean(row.actualIds?.length);
                        return (
                          <tr key={row.key} className={`is-${row.status}`}>
                            <th scope="row">
                              {detailed ? (
                                <button
                                  type="button"
                                  className="reconcile__expand"
                                  aria-expanded={open}
                                  onClick={() => toggle(row.key)}
                                >
                                  {row.metric}
                                </button>
                              ) : (
                                row.metric
                              )}
                              {open ? (
                                <div className="reconcile__detail">
                                  <p>
                                    <span className="reconcile__label">Query</span>
                                    <code>{row.query}</code>
                                  </p>
                                  {row.note ? (
                                    <p>
                                      <span className="reconcile__label">Note</span>
                                      {row.note}
                                    </p>
                                  ) : null}
                                  {row.expectedIds?.length ? (
                                    <p>
                                      <span className="reconcile__label">
                                        Expected records
                                      </span>
                                      <code>{row.expectedIds.join(", ")}</code>
                                    </p>
                                  ) : null}
                                  {row.actualIds?.length ? (
                                    <p>
                                      <span className="reconcile__label">Actual records</span>
                                      <code>{row.actualIds.join(", ")}</code>
                                    </p>
                                  ) : null}
                                </div>
                              ) : null}
                            </th>
                            <td className="is-number">{numberText(row.expected)}</td>
                            <td className="is-number">{numberText(row.actual)}</td>
                            <td className="is-number">{differenceText(row)}</td>
                            <td>
                              <span className={`reconcile__pill is-${row.status}`}>
                                {STATUS_WORD[row.status]}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </details>
            ))}
          </>
        ) : null}
      </section>
    </>
  );
}

export default ReconcilePanel;
