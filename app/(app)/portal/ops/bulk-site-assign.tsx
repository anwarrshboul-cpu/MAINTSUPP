"use client";

/**
 * BULK SITE ASSIGN — §6.4's "Fix these".
 *
 * "31 jobs point at no site in the register — Fix these opens a bulk assign
 * view listing the affected jobs with a site picker so several are assigned in
 * one pass." Several, in one pass, is the whole requirement: the reason those
 * jobs were never repaired is that repairing them one row at a time costs more
 * attention than anybody has.
 *
 * ── THE LIST COMES FROM SOMEBODY ELSE'S ENDPOINT ──────────────────────────
 *
 * `/api/dashboard/records?query=no_site` is the Overview's shared drill-down
 * (`RecordsPayload` in `overview-contract.ts`), and it is deliberately not
 * re-derived here: "31 jobs point at no site" on the card and the rows on this
 * screen have to be the same set, and two queries for one question is how this
 * dashboard came to give two answers. If that endpoint is not there yet, this
 * says so and offers a retry rather than rendering an empty list — an empty
 * list is indistinguishable from "nothing to fix", and somebody would then
 * report the problem as solved.
 *
 * ── NOTHING IS ASSIGNED WITHOUT A COUNT IN FRONT OF IT ────────────────────
 *
 * §8 allows this write precisely because it is explicit, confirmed and
 * reversible. So Assign is a two-step: the first press asks the server what it
 * would do and shows the number, the second applies it. The server defaults to
 * preview as well, so the confirmation is not something the UI could forget.
 *
 * The response carries the reversal, and this screen keeps it: after a
 * successful assign an Undo button is offered, which is the same endpoint with
 * the jobs' previous sites.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import toolsCss from "./overview-tools.css?url";
import { EmptyState, ErrorState, OpsCard, SkeletonRow, plural } from "./ops-primitives";
import type { RecordsPayload, RecordRow } from "./overview-contract";

type PreviewJob = {
  id: string;
  reference: string | null;
  title: string;
  fromSiteId: string | null;
  status: string;
};

type Preview = {
  mode: "preview";
  siteId: string | null;
  siteName: string;
  requested: number;
  willChange: number;
  unchanged: number;
  rejected: number;
  jobs: PreviewJob[];
  summary: string;
};

type Applied = {
  ok: true;
  assigned: number;
  unchanged: number;
  rejected: number;
  siteId: string | null;
  siteName: string;
  summary: string;
  reverse?: Array<{ siteId: string | null; requestIds: string[] }>;
};

type SiteOption = { id: string; name: string };

const ENDPOINT = "/api/overview/site-assign";

export function BulkSiteAssign({ onAssigned }: { onAssigned?: () => void } = {}) {
  const [records, setRecords] = useState<RecordsPayload | null>(null);
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [siteId, setSiteId] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    Promise.all([
      fetch("/api/dashboard/records?query=no_site", { headers: { Accept: "application/json" } })
        .then(async (response) => ({
          ok: response.ok,
          body: (await response.json().catch(() => null)) as
            | (RecordsPayload & { error?: string })
            | null,
        }))
        .catch(() => ({ ok: false, body: null })),
      fetch("/api/sites", { headers: { Accept: "application/json" } })
        .then(async (response) => (await response.json().catch(() => null)) as { sites?: SiteOption[] } | null)
        .catch(() => null),
    ]).then(([drill, siteList]) => {
      if (!live) return;
      if (!drill.ok || !drill.body || drill.body.error) {
        /* Degrade honestly. The list is another agent's endpoint and may not be
           deployed yet; an empty table here would read as "nothing to fix". */
        setUnavailable(true);
        setError(drill.body?.error ?? "The list of jobs with no site is not available yet.");
      } else {
        setUnavailable(false);
        setError(null);
        setRecords(drill.body);
        setChosen(new Set());
      }
      setSites(Array.isArray(siteList?.sites) ? siteList.sites : []);
    });
    return () => {
      live = false;
    };
  }, [nonce]);

  const reload = useCallback(() => {
    setPreview(null);
    setNonce((value) => value + 1);
  }, []);

  const rows: RecordRow[] = useMemo(() => records?.rows ?? [], [records]);
  const allChosen = rows.length > 0 && chosen.size === rows.length;

  const toggle = useCallback((id: string) => {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setPreview(null);
  }, []);

  const send = useCallback(
    async (ids: string[], target: string | null, apply: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ requestIds: ids, siteId: target, mode: apply ? "apply" : "preview" }),
        });
        const read = (await response.json().catch(() => null)) as
          | (Preview & Applied & { error?: string })
          | null;
        if (!response.ok || !read || read.error) {
          setError(read?.error ?? "Those jobs could not be assigned.");
          return;
        }
        if (!apply) {
          setPreview(read);
          return;
        }
        setPreview(null);
        setApplied(read);
        setNonce((value) => value + 1);
        onAssigned?.();
      } catch {
        setError("Those jobs could not be assigned.");
      } finally {
        setBusy(false);
      }
    },
    [onAssigned],
  );

  const undo = useCallback(async () => {
    if (!applied?.reverse?.length) return;
    /* Sequential: one call per origin site, and there is normally exactly one.
       Firing them together would race the same rows through the same table. */
    for (const group of applied.reverse) {
      await send(group.requestIds, group.siteId, true);
    }
    setApplied(null);
  }, [applied, send]);

  if (error && unavailable) {
    return (
      <>
        <link rel="stylesheet" href={toolsCss} precedence="default" />
        <OpsCard title="Assign a site to several jobs">
          <ErrorState what={error} onRetry={reload} />
        </OpsCard>
      </>
    );
  }

  if (!records) {
    return (
      <>
        <link rel="stylesheet" href={toolsCss} precedence="default" />
        <OpsCard title="Assign a site to several jobs">
          <SkeletonRow lines={5} height={240} />
        </OpsCard>
      </>
    );
  }

  const chosenIds = [...chosen];
  const siteName = sites.find((site) => site.id === siteId)?.name ?? "";

  return (
    <div className="ovt">
      <link rel="stylesheet" href={toolsCss} precedence="default" />
      <OpsCard
        title="Assign a site to several jobs"
        subtitle={`${plural(records.total, "job")} point at no site in the register. A job with no site is missing from every site total, every compliance count and every rank on this page.`}
      >
        {error ? (
          <p className="ovt__error" role="alert">
            {error}
          </p>
        ) : null}

        {applied ? (
          <p className="ovt__notice" role="status">
            {applied.summary}
            {applied.reverse?.length ? (
              <>
                {" "}
                <button type="button" className="ovt-btn" disabled={busy} onClick={() => void undo()}>
                  Undo
                </button>
              </>
            ) : null}
          </p>
        ) : null}

        {rows.length ? (
          <>
            <div className="ovt-bar">
              <button
                type="button"
                className="ovt-btn"
                onClick={() => {
                  setChosen(allChosen ? new Set() : new Set(rows.map((row) => row.id)));
                  setPreview(null);
                }}
              >
                {allChosen ? "Clear selection" : `Select all ${rows.length}`}
              </button>
              <span className="ovt-bar__count">{plural(chosen.size, "job")} selected</span>
            </div>

            <ul className="ovt-jobs">
              {rows.map((row) => (
                <li key={row.id} className="ovt-job">
                  <label className="ovt-job__check">
                    <span className="visually-hidden">Select {row.reference ?? row.id}</span>
                    <input
                      type="checkbox"
                      checked={chosen.has(row.id)}
                      onChange={() => toggle(row.id)}
                    />
                  </label>
                  <div>
                    <div className="ovt-job__title">{row.title}</div>
                    <div className="ovt-job__meta">
                      <span>{row.reference ?? row.id}</span>
                      <span>{row.status}</span>
                      <span>{row.priority}</span>
                      <span>{row.siteName}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            {records.truncated ? (
              <p className="ovt-preview__hidden">
                Showing {rows.length} of {records.total}. Assign these, then reload for the rest.
              </p>
            ) : null}

            <div className="ovt-bar">
              <label className="ovt-picker">
                <span className="visually-hidden">Site to assign the selected jobs to</span>
                <select
                  value={siteId}
                  onChange={(event) => {
                    setSiteId(event.target.value);
                    setPreview(null);
                  }}
                >
                  <option value="">Choose a site…</option>
                  {sites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="primary-button"
                disabled={busy || !siteId || !chosen.size}
                onClick={() => void send(chosenIds, siteId, false)}
              >
                Assign to {siteName || "a site"}
              </button>
            </div>

            {preview ? (
              <div
                className="ovt-preview-panel"
                role="alertdialog"
                aria-label="Confirm this assignment"
              >
                <strong>{preview.summary}</strong>
                <span>
                  {plural(preview.willChange, "job")} will change
                  {preview.unchanged ? ` · ${preview.unchanged} already there` : ""}
                  {preview.rejected
                    ? ` · ${preview.rejected} not in this workspace and skipped`
                    : ""}
                </span>
                <ul>
                  {preview.jobs.slice(0, 12).map((job) => (
                    <li key={job.id}>
                      <span>{job.reference ?? job.id}</span>
                      <span>{job.title}</span>
                    </li>
                  ))}
                </ul>
                <div className="ovt-preview-panel__actions">
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy || !preview.willChange}
                    onClick={() => void send(chosenIds, preview.siteId, true)}
                  >
                    {busy ? "Assigning…" : `Confirm — assign ${preview.willChange}`}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => setPreview(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <EmptyState>Every job points at a site in the register. Nothing to fix.</EmptyState>
        )}
      </OpsCard>
    </div>
  );
}
