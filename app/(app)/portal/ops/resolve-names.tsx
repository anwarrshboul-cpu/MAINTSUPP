"use client";

/**
 * CONTRACTORS → RESOLVE NAMES — §3.6.
 *
 * The screen that turns "£3,161 of £26,557 names a contractor, £83 resolves to
 * a record" into a number worth ranking. Every distinct free-text contractor
 * string on the jobs, highest spend first, with a proposed match and four
 * actions.
 *
 * ── NOTHING HAPPENS WITHOUT A PREVIEW ─────────────────────────────────────
 *
 * §3.6: "Shows the jobs and spend each action will affect BEFORE applying…
 * Never auto-links without confirmation — a wrong merge quietly corrupts
 * contractor scoring." So every button here is a two-step: the first press asks
 * the server what the action WOULD do and renders the answer, the second
 * applies it. The route defaults to preview as well, so a client that forgets
 * the second step cannot change anything by accident.
 *
 * ── ATTRIBUTION, BEFORE AND AFTER ─────────────────────────────────────────
 *
 * The header prints all three figures — total, named, attributed — because §1.4
 * forbids a percentage whose denominator is not on screen, and because "12%"
 * with no denominator is the sentence that let this problem sit unfixed.
 *
 * ── MOBILE ────────────────────────────────────────────────────────────────
 *
 * A card per name, not a table: the row carries a long string, two figures,
 * three or four suggestion chips and three actions, and §1.8's rule for a wide
 * table on a narrow screen is "stacked cards, one record per card, same fields,
 * primary value first". Written that way from the start, then widened.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import toolsCss from "./overview-tools.css?url";
import { EmptyState, ErrorState, OpsCard, SkeletonRow, money, plural } from "./ops-primitives";

type Suggestion = { id: string; name: string; score: number };

type UnlinkedName = {
  name: string;
  key: string;
  jobs: number;
  spend: number;
  reason: "none" | "ambiguous";
  candidates: Array<{ id: string; name: string }>;
  suggestions: Suggestion[];
  ignored: boolean;
};

type AliasRow = {
  id: string;
  alias: string;
  normalised: string;
  contractorId: string;
  contractorName: string;
  jobs: number;
  spend: number;
  createdAt: string;
  createdBy: string | null;
};

type Payload = {
  names: UnlinkedName[];
  aliases: AliasRow[];
  contractors: Array<{ id: string; name: string }>;
  totals: {
    totalSpend: number;
    namedSpend: number;
    attributedSpend: number;
    unlinkedSpend: number;
    distinctUnlinked: number;
  };
  canEdit: boolean;
};

type Action = "link" | "create" | "ignore" | "unlink";

type Preview = {
  action: Action;
  name: string;
  contractorId: string | null;
  contractorName?: string;
  jobs: number;
  spend: number;
  alreadyAttributed?: number;
  exactReversal?: boolean;
  willChange: string;
  sample?: Array<{ id: string; contractor: string | null; cost: number | null }>;
};

const ENDPOINT = "/api/overview/contractor-aliases";

/** A percentage that always travels beside the two numbers it came from. */
function share(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

export function ResolveNames({ onChanged }: { onChanged?: () => void } = {}) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    fetch(ENDPOINT, { headers: { Accept: "application/json" } })
      .then(async (response) => {
        const read = (await response.json().catch(() => null)) as
          | (Payload & { error?: string })
          | null;
        if (!live) return;
        if (!response.ok || !read || read.error) {
          setError(read?.error ?? "The contractor names could not be loaded.");
          return;
        }
        setError(null);
        setPayload(read);
      })
      .catch(() => {
        if (live) setError("The contractor names could not be loaded.");
      });
    return () => {
      live = false;
    };
  }, [nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  const send = useCallback(
    async (action: Action, name: string, contractorId: string | null, apply: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            action,
            name,
            ...(contractorId ? { contractorId } : {}),
            mode: apply ? "apply" : "preview",
          }),
        });
        const read = (await response.json().catch(() => null)) as
          | (Preview & { error?: string; ok?: boolean; jobsChanged?: number })
          | null;
        if (!response.ok || !read || read.error) {
          setError(read?.error ?? "That action could not be completed.");
          return;
        }
        if (!apply) {
          setPreview({ ...read, action, name, contractorId });
          return;
        }
        setPreview(null);
        setNotice(
          `${plural(read.jobsChanged ?? 0, "job")} changed. This is reversible — use Unlink.`,
        );
        setNonce((value) => value + 1);
        onChanged?.();
      } catch {
        setError("That action could not be completed.");
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  const totals = payload?.totals;
  const headline = useMemo(() => {
    if (!totals) return null;
    return (
      <>
        {money(totals.namedSpend)} of {money(totals.totalSpend)} (
        {share(totals.namedSpend, totals.totalSpend)}) names a contractor.{" "}
        <strong>{money(totals.attributedSpend)}</strong> (
        {share(totals.attributedSpend, totals.totalSpend)}) is attributed to a contractor
        record. {plural(totals.distinctUnlinked, "name")} still unresolved, carrying{" "}
        {money(totals.unlinkedSpend)}.
      </>
    );
  }, [totals]);

  if (error && !payload) {
    return (
      <>
        <link rel="stylesheet" href={toolsCss} precedence="default" />
        <OpsCard title="Resolve contractor names">
          <ErrorState what={error} onRetry={reload} />
        </OpsCard>
      </>
    );
  }

  if (!payload) {
    return (
      <>
        <link rel="stylesheet" href={toolsCss} precedence="default" />
        <OpsCard title="Resolve contractor names">
          <SkeletonRow lines={5} height={240} />
        </OpsCard>
      </>
    );
  }

  const readOnly = !payload.canEdit;
  const listed = payload.names;

  return (
    <div className="ovt">
      <link rel="stylesheet" href={toolsCss} precedence="default" />
      <OpsCard
        title="Resolve contractor names"
        subtitle="A name typed onto a job is not a contractor record until somebody says it is. Until then the register reports zero, which is a claim about the data and not about the contractor."
      >
        <p className="ovt-attribution">{headline}</p>

        {readOnly ? (
          <p className="ovt__notice" role="status">
            You can see the unresolved names but not act on them. Linking needs the Settings
            capability.
          </p>
        ) : null}
        {notice ? (
          <p className="ovt__notice" role="status">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="ovt__error" role="alert">
            {error}
          </p>
        ) : null}

        {preview ? (
          <div className="ovt-preview-panel" role="alertdialog" aria-label="Confirm this change">
            <strong>{preview.willChange}</strong>
            <span>
              {plural(preview.jobs, "job")} · {money(preview.spend)}
              {preview.alreadyAttributed
                ? ` · ${preview.alreadyAttributed} already attributed and left alone`
                : ""}
              {preview.exactReversal === false
                ? " · no link record found, so this falls back to matching by name"
                : ""}
            </span>
            {preview.sample?.length ? (
              <ul>
                {preview.sample.map((job) => (
                  <li key={job.id}>
                    <span>{job.id}</span>
                    <span>{job.cost === null ? "no cost" : money(job.cost)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="ovt-preview-panel__actions">
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() =>
                  void send(preview.action, preview.name, preview.contractorId, true)
                }
              >
                {busy ? "Applying…" : "Confirm"}
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

        {listed.length ? (
          <ul className="ovt-names">
            {listed.map((row) => {
              const choice = picked[row.key] ?? row.suggestions[0]?.id ?? row.candidates[0]?.id ?? "";
              return (
                <li key={row.key} className="ovt-name">
                  <div className="ovt-name__head">
                    <span className="ovt-name__text">{row.name}</span>
                    <span className="ovt-name__figures">
                      <span>{money(row.spend)}</span>
                      <span>{plural(row.jobs, "job")}</span>
                    </span>
                  </div>
                  <p className="ovt-name__why">
                    {row.ignored
                      ? "Dismissed. It stays on the jobs and stays out of this list until you restore it."
                      : row.reason === "ambiguous"
                        ? `${plural(row.candidates.length, "register record")} answer to this name, so attributing it automatically would double-count the money. Pick the one it means.`
                        : "No register record answers to this name."}
                  </p>

                  {row.suggestions.length ? (
                    <div className="ovt-name__suggestions">
                      {row.suggestions.map((suggestion) => (
                        <button
                          key={suggestion.id}
                          type="button"
                          className="ovt-suggestion"
                          disabled={readOnly || busy}
                          onClick={() =>
                            setPicked((current) => ({ ...current, [row.key]: suggestion.id }))
                          }
                          aria-pressed={choice === suggestion.id}
                        >
                          {suggestion.name} <b>{Math.round(suggestion.score * 100)}%</b>
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {readOnly ? null : (
                    <div className="ovt-name__actions">
                      <label className="ovt-picker">
                        <span className="visually-hidden">
                          Contractor record to link {row.name} to
                        </span>
                        <select
                          value={choice}
                          disabled={busy}
                          onChange={(event) =>
                            setPicked((current) => ({ ...current, [row.key]: event.target.value }))
                          }
                        >
                          <option value="">Choose a contractor…</option>
                          {payload.contractors.map((contractor) => (
                            <option key={contractor.id} value={contractor.id}>
                              {contractor.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={busy || !choice}
                        onClick={() => void send("link", row.name, choice, false)}
                      >
                        Link to existing
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => void send("create", row.name, null, false)}
                      >
                        Create new contractor
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy}
                        onClick={() =>
                          void send(row.ignored ? "unlink" : "ignore", row.name, null, false)
                        }
                      >
                        {row.ignored ? "Restore" : "Ignore"}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState>
            Every contractor name on the jobs resolves to a register record. Nothing to fix.
          </EmptyState>
        )}

        {payload.aliases.length ? (
          <>
            <h3 className="ovt-preview__title">
              Names already mapped — every one of them reversible
            </h3>
            <ul className="ovt-aliases">
              {payload.aliases.map((alias) => (
                <li key={alias.id} className="ovt-alias">
                  <span>
                    <strong>{alias.alias}</strong> → {alias.contractorName} ·{" "}
                    {plural(alias.jobs, "job")} · {money(alias.spend)}
                  </span>
                  {readOnly ? null : (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => void send("unlink", alias.alias, null, false)}
                    >
                      Unlink
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </OpsCard>
    </div>
  );
}
