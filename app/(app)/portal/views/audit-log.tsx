"use client";

/**
 * The audit viewer — the screen behind /dashboard/audit.
 *
 * Read-only, and visibly so: there is no control on this page that writes,
 * because the log it shows is append-only. Nothing here invents a row either —
 * a fresh workspace has no events and says so, rather than being padded with
 * examples that would make the screen look busy and the log worthless.
 *
 * Newest first, always. The filters narrow; they never reorder, because "what
 * happened most recently" is the question this page exists to answer and a
 * sortable column would let a reader lose that without noticing.
 *
 * Where an event carries a before/after `detail`, the row expands into a small
 * two-column table. That is the difference between "somebody changed the team"
 * and "somebody changed its colour from teal to red", and it is the only reason
 * the detail column is stored as JSON rather than as prose.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../../../components";
import auditCss from "./audit-log.css?url";

type AuditEvent = {
  id: string;
  organisationId: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  summary: string;
  detail: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
};

type AuditPayload = {
  events: AuditEvent[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
  actions: string[];
  workspaces: Array<{ id: string; name: string }>;
  viewer: { email: string; role: string; crossOrganisation: boolean };
  error?: string;
};

type Filters = {
  organisationId: string;
  actor: string;
  action: string;
  from: string;
  to: string;
};

const EMPTY_FILTERS: Filters = {
  organisationId: "",
  actor: "",
  action: "",
  from: "",
  to: "",
};

/**
 * The family an action belongs to — the part before the first dot.
 *
 * Used both to group the filter list and to tint the chip. Tint is decoration:
 * the chip always carries the verb in words as well.
 */
function actionFamily(action: string) {
  return action.split(".")[0] ?? action;
}

/**
 * Both stored shapes, read as UTC.
 *
 * `created_at` arrives either as "2026-08-07T14:35:37.123Z" or, from the
 * column's own default, as "2026-08-07 14:35:37". `new Date()` treats the
 * second form as *local* time, which would shift a whole class of events by the
 * viewer's offset — an hour's error in an audit log is not a cosmetic one. The
 * separator is normalised and the zone made explicit before parsing.
 */
function formatWhen(value: string) {
  const normalised = /^\d{4}-\d{2}-\d{2} /.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const date = new Date(normalised);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** A `changeDetail()` payload, if this event carries one. */
function asChange(detail: unknown) {
  if (!detail || typeof detail !== "object") return null;
  const record = detail as Record<string, unknown>;
  const changed = record.changed;
  if (!Array.isArray(changed) || !changed.length) return null;
  const before = (record.before ?? {}) as Record<string, unknown>;
  const after = (record.after ?? {}) as Record<string, unknown>;
  return changed
    .filter((key): key is string => typeof key === "string")
    .map((key) => ({
      field: key,
      before: before?.[key] ?? (record.before === null ? null : before?.[key]),
      after: after?.[key] ?? (record.after === null ? null : after?.[key]),
    }));
}

/** Everything in `detail` that is not part of the before/after pair. */
function asFacts(detail: unknown) {
  if (!detail || typeof detail !== "object") return [];
  return Object.entries(detail as Record<string, unknown>).filter(
    ([key]) => key !== "changed" && key !== "before" && key !== "after",
  );
}

export function AuditLog() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  /**
   * The answer, stamped with the query it answers.
   *
   * "Loading" is then derived rather than stored: a separate flag can disagree
   * with the data beside it, and the disagreement shows up as a table that
   * claims to be current while displaying the previous filter's rows.
   */
  const [result, setResult] = useState<{ query: string; payload: AuditPayload } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (filters.organisationId) params.set("organisationId", filters.organisationId);
    if (filters.actor.trim()) params.set("actor", filters.actor.trim());
    if (filters.action) params.set("action", filters.action);
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    params.set("page", String(page));
    return params.toString();
  }, [filters, page]);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/audit?${query}`, { cache: "no-store" });
      const payload = (await response.json()) as AuditPayload;
      if (!response.ok) {
        throw new Error(payload.error ?? "The audit log could not be read.");
      }
      setResult({ query, payload });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The audit log could not be read.");
    }
  }, [query]);

  /* eslint-disable react-hooks/set-state-in-effect -- `load` awaits before it
     touches state, so nothing here sets state synchronously in the effect body;
     the rule cannot see through the promise. Reading a server-held log when the
     filters change is precisely the external-system synchronisation an effect
     is for. */
  useEffect(() => {
    void load();
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /* Changing a filter returns to page 1: staying on page 4 of a narrower result
     shows an empty table and reads as "there is nothing", which is wrong. */
  const setFilter = (patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
  };

  const data = result?.payload ?? null;
  const loading = !result || result.query !== query;
  const events = data?.events ?? [];
  const filtered = Boolean(
    filters.organisationId || filters.actor || filters.action || filters.from || filters.to,
  );
  const workspaceName = (id: string | null) =>
    data?.workspaces.find((workspace) => workspace.id === id)?.name ??
    (id ? "Another workspace" : "No workspace");

  const stylesheet = <link rel="stylesheet" href={auditCss} precedence="default" />;

  return (
    <section className="audit">
      {stylesheet}

      <header className="audit__head">
        <div>
          <h2>Audit log</h2>
          <p>
            Who did what, in order, newest first. Entries are written when the action
            happens and are never edited or removed — this page can only read them.
          </p>
        </div>
        <span className="audit__count">
          {data ? `${data.total} event${data.total === 1 ? "" : "s"}` : "…"}
        </span>
      </header>

      {/* Shown beside the filters rather than instead of them: a permission
          refusal or a failed read must still leave the reader able to change
          what they asked for. */}
      {error && (
        <p className="audit__error" role="alert">
          <Icon name="alert" size={16} /> {error}
        </p>
      )}

      <form className="audit__filters" onSubmit={(event) => event.preventDefault()}>
        {data && data.workspaces.length > 1 && (
          <label className="audit__filter">
            <span>Workspace</span>
            <select
              value={filters.organisationId}
              onChange={(event) => setFilter({ organisationId: event.target.value })}
            >
              <option value="">Every workspace I can see</option>
              {data.workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="audit__filter">
          <span>Actor</span>
          <input
            value={filters.actor}
            placeholder="email contains…"
            onChange={(event) => setFilter({ actor: event.target.value })}
          />
        </label>

        <label className="audit__filter">
          <span>Action</span>
          <select
            value={filters.action}
            onChange={(event) => setFilter({ action: event.target.value })}
          >
            <option value="">Every action</option>
            {/* Families first, so "everything a team did" is one click. */}
            {[...new Set((data?.actions ?? []).map(actionFamily))].sort().map((family) => (
              <option key={`family-${family}`} value={family}>
                All {family} events
              </option>
            ))}
            {(data?.actions ?? []).map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </select>
        </label>

        <label className="audit__filter">
          <span>From</span>
          <input
            type="date"
            value={filters.from}
            onChange={(event) => setFilter({ from: event.target.value })}
          />
        </label>

        <label className="audit__filter">
          <span>To</span>
          <input
            type="date"
            value={filters.to}
            onChange={(event) => setFilter({ to: event.target.value })}
          />
        </label>

        {filtered && (
          <button
            type="button"
            className="audit__clear"
            onClick={() => {
              setFilters(EMPTY_FILTERS);
              setPage(1);
            }}
          >
            <Icon name="close" size={14} /> Clear filters
          </button>
        )}
      </form>

      {loading && !data ? (
        error ? null : <p className="audit__loading">Reading the log…</p>
      ) : !events.length ? (
        <div className="audit__empty">
          <Icon name="shield" size={26} />
          <h3>{filtered ? "Nothing matches those filters" : "No events recorded yet"}</h3>
          <p>
            {filtered
              ? "Widen the date range or clear the filters."
              : "This log fills itself as people sign in, invite each other, change roles and delete things. It stays empty until one of those happens — nothing is written here to fill the page."}
          </p>
        </div>
      ) : (
        <div className="audit__table-wrap">
          <table className="audit__table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">What happened</th>
                <th scope="col">Where</th>
                <th scope="col" className="audit__col-detail">
                  Detail
                </th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => {
                const change = asChange(event.detail);
                const facts = asFacts(event.detail);
                const open = expanded === event.id;
                const hasDetail = Boolean(change?.length || facts.length || event.ipAddress);
                return (
                  /* A fragment per event because the expanded detail is a
                     second <tr>: a row cannot contain another row, and nesting
                     the detail inside the first cell would break the column
                     alignment the table exists for. */
                  <Fragment key={event.id}>
                    <tr className={open ? "is-open" : undefined}>
                      <td className="audit__when">{formatWhen(event.createdAt)}</td>
                      <td className="audit__actor">
                        <span>{event.actorEmail ?? "unknown"}</span>
                        {event.actorRole && (
                          <em>{event.actorRole.replace("_", " ")}</em>
                        )}
                      </td>
                      <td>
                        <span
                          className={`audit__chip audit__chip--${actionFamily(event.action)}`}
                        >
                          {event.action}
                        </span>
                      </td>
                      <td className="audit__summary">{event.summary}</td>
                      <td className="audit__where">
                        <span>{workspaceName(event.organisationId)}</span>
                        {event.entityType && (
                          <em>
                            {event.entityType}
                            {/* The id keeps its own case: upper-casing an
                                opaque identifier makes it harder to match
                                against the one in the URL or the database. */}
                            {event.entityId ? (
                              <code>{event.entityId.slice(0, 14)}</code>
                            ) : null}
                          </em>
                        )}
                      </td>
                      <td className="audit__col-detail">
                        {hasDetail ? (
                          <button
                            type="button"
                            className="audit__expand"
                            aria-expanded={open}
                            onClick={() => setExpanded(open ? null : event.id)}
                          >
                            {open ? "Hide" : change?.length ? "What changed" : "Show"}
                          </button>
                        ) : (
                          <span className="audit__none">—</span>
                        )}
                      </td>
                    </tr>
                    {open && (
                      <tr className="audit__detail-row">
                        <td colSpan={6}>
                          {change?.length ? (
                            <table className="audit__change">
                              <thead>
                                <tr>
                                  <th scope="col">Field</th>
                                  <th scope="col">Before</th>
                                  <th scope="col">After</th>
                                </tr>
                              </thead>
                              <tbody>
                                {change.map((row) => (
                                  <tr key={row.field}>
                                    <th scope="row">{row.field}</th>
                                    <td className="audit__before">{formatValue(row.before)}</td>
                                    <td className="audit__after">{formatValue(row.after)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          ) : null}
                          {facts.length ? (
                            <dl className="audit__facts">
                              {facts.map(([key, value]) => (
                                <div key={key}>
                                  <dt>{key}</dt>
                                  <dd>{formatValue(value)}</dd>
                                </div>
                              ))}
                            </dl>
                          ) : null}
                          {(event.ipAddress || event.userAgent) && (
                            <p className="audit__origin">
                              {event.ipAddress ? `From ${event.ipAddress}` : "Origin unknown"}
                              {event.userAgent ? ` · ${event.userAgent}` : ""}
                            </p>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data && data.pageCount > 1 && (
        <nav className="audit__pager" aria-label="Audit log pages">
          <button
            type="button"
            disabled={data.page <= 1 || loading}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            Newer
          </button>
          <span>
            Page {data.page} of {data.pageCount}
          </span>
          <button
            type="button"
            disabled={data.page >= data.pageCount || loading}
            onClick={() => setPage((value) => value + 1)}
          >
            Older
          </button>
        </nav>
      )}
    </section>
  );
}

export default AuditLog;
