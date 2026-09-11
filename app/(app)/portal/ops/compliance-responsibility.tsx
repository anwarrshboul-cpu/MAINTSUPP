"use client";

/**
 * WHOSE OBLIGATION IS THIS? — the controls that answer it.
 *
 * ── THE WORD ON SCREEN IS "RESPONSIBILITY". THE FIELD IS `duty_holder` ─────
 *
 * And it is not the same axis as the register's OTHER "Responsibility", which
 * is `responsibilityFor()` in `compliance-view.ts` — Contractor, Fire safety
 * partner, Insurance broker — the `?who=` filter, meaning WHO CHASES THIS
 * CERTIFICATE. This file answers WHOSE OBLIGATION IT IS: the client's, the
 * landlord's, the shopping centre's, or nobody's because the asset is not at
 * that unit. A fire alarm service can be chased by the fire safety partner and
 * still be the landlord's liability in a mall.
 *
 * `app/lib/compliance-duty-holder.ts` argues that split at length. What matters
 * here is that nothing in this file re-types either vocabulary. The options and
 * the words come from `DUTY_HOLDER_CHOICES` and `dutyHolderLabel`, imported
 * directly — that module imports nothing at all, which is exactly why it can be
 * pulled into a `"use client"` file without dragging a server graph behind it.
 *
 * ── WHY THE COVERAGE LINE IS NEVER A PERCENTAGE ───────────────────────────
 *
 * "3 of 12 requirements confirmed", or "Not yet confirmed", and no third form.
 * A brand-new site has twelve requirements and no answers; rendering that as
 * "0%" next to the word compliance is read as "this store is failing" by
 * everyone who has ever seen a dashboard, and it is the single defect the whole
 * duty-holder design exists to prevent. The sentence is built by
 * `responsibilityCoverage` on the server and printed verbatim — this file does
 * not do the arithmetic and therefore cannot get it wrong.
 *
 * ── 375px IS THE DESIGN WIDTH ─────────────────────────────────────────────
 *
 * Every control here is stacked at the base width and only becomes a row at
 * 768px. The bulk bar is the part that would otherwise break: four answers plus
 * a count plus a select-all will not sit on one line at 375px, so it wraps, and
 * its buttons keep a 44px touch target rather than shrinking to fit.
 */

import { useCallback, useMemo, useState } from "react";
import { Icon } from "../../../components";
import {
  DUTY_HOLDER_CHOICES,
  DUTY_HOLDER_UNCONFIRMED,
  dutyHolderLabel,
  dutyHolderMeaning,
} from "../../../lib/compliance-duty-holder";
import {
  COMPLIANCE_COLOUR,
  complianceMeaning,
  type ComplianceState,
} from "../../../lib/compliance-status";
import { EmptyState, ErrorState, OpsCard, SkeletonRow, plural } from "./ops-primitives";
import { announceDataChanged, useOpsQuery } from "./ops-url-state";
import responsibilityCss from "./compliance-responsibility.css?url";

/* ── Wire shapes ──────────────────────────────────────────────────────────── */

/**
 * The coverage sentence, already written.
 *
 * `label` is the whole point of this type travelling instead of two integers:
 * the "Not yet confirmed" / "3 of 12" decision is made once, in the module that
 * owns the vocabulary, so the portfolio band, a group header and the queue
 * cannot phrase it three ways.
 */
export type ResponsibilityCoverage = {
  confirmed: number;
  unconfirmed: number;
  neverAsked: number;
  total: number;
  complete: boolean;
  label: string;
};

type QueueRecord = {
  id: string;
  siteId: string;
  kind: string;
  state: ComplianceState;
  expiry: string | null;
  dutyHolder: string | null;
};

type QueueGroup = {
  siteId: string;
  siteName: string;
  coverage: ResponsibilityCoverage;
  records: QueueRecord[];
};

type QueuePayload = {
  coverage: ResponsibilityCoverage;
  outstanding: number;
  registerTotal: number;
  groups: QueueGroup[];
};

/** The endpoint, named once. */
const ENDPOINT = "/api/compliance/responsibilities";

/**
 * The most requirements one Apply may carry.
 *
 * Mirrors `MAX_RECORDS` on the route. Stated on both sides deliberately: the
 * server refuses past it because a client can be anything, and the client knows
 * it so that "Select all" on a 600-row backlog offers a first pass of 500
 * rather than composing a request it can already tell will be refused.
 */
const MAX_PER_REQUEST = 500;

/** The register's own address for a requirement: site × requirement name. */
const pairKey = (siteId: string, kind: string) => `${siteId}::${kind}`;

/* ── The write ────────────────────────────────────────────────────────────── */

type SaveResult =
  | { ok: true; label: string; updated: number; skipped: number }
  | { ok: false; error: string };

async function setResponsibility(
  records: ReadonlyArray<{ siteId: string; kind: string }>,
  dutyHolder: string | null,
): Promise<SaveResult> {
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        dutyHolder,
        records: records.map((record) => ({ siteId: record.siteId, kind: record.kind })),
      }),
    });
    const payload = (await response.json().catch(() => null)) as
      | { error?: string; label?: string; updated?: number; skipped?: number }
      | null;
    if (!response.ok || !payload) {
      return {
        ok: false,
        /* The server's own sentence when there is one. A refusal that says
           "something went wrong" beside a Retry button teaches nobody why. */
        error: payload?.error || `That did not save (${response.status}).`,
      };
    }
    return {
      ok: true,
      label: payload.label ?? "",
      updated: payload.updated ?? 0,
      skipped: payload.skipped ?? 0,
    };
  } catch {
    return { ok: false, error: "That did not save. Check your connection and try again." };
  }
}

/* ── The coverage sentence ────────────────────────────────────────────────── */

/**
 * "3 of 12 requirements confirmed", or "Not yet confirmed".
 *
 * Prints `coverage.label` and adds nothing to it. `tone` exists only so a
 * register group header can render it muted while the portfolio band renders it
 * as a statement; colour is never the sole carrier, because the words say the
 * same thing in both.
 */
export function ResponsibilityCoverageLine({
  coverage,
  tone = "muted",
}: {
  coverage: ResponsibilityCoverage;
  tone?: "muted" | "strong";
}) {
  return (
    <span
      className={`resp-coverage resp-coverage--${tone}`}
      data-complete={coverage.complete ? "true" : "false"}
    >
      <link rel="stylesheet" href={responsibilityCss} precedence="default" />
      <Icon name="shield" size={13} />
      <span className="resp-coverage__text">{coverage.label}</span>
      {coverage.unconfirmed > 0 ? (
        <span className="resp-coverage__waiting">{coverage.unconfirmed} waiting</span>
      ) : null}
    </span>
  );
}

/* ── One requirement's control ────────────────────────────────────────────── */

/**
 * The per-requirement control.
 *
 * A native `<select>`, not a custom menu: it is a five-way choice on a row that
 * may be one of hundreds, and the platform's own picker is the only one that is
 * already a 44px target, already keyboard-operable and already usable at 375px
 * without a portal that has to measure its own scrollbar.
 *
 * ── THE CURRENT VALUE IS ALWAYS REPRESENTABLE ─────────────────────────────
 *
 * A `<select>` whose value is not among its options silently displays the FIRST
 * option instead, so a requirement sitting at the machine placeholder would
 * read "Client" — a lie about state, and one that invites somebody to "change"
 * it to the thing it already appears to say. The placeholder therefore gets its
 * own option, disabled because it is a state and not a choice, carrying
 * `dutyHolderLabel`'s words for it.
 *
 * Clearing back to "never asked" IS offered, as the empty value. Somebody who
 * confirmed the wrong requirement has to be able to take the answer off again,
 * and `null` is a real, different fact from the placeholder — it is what every
 * row that predates the column holds.
 */
export function ResponsibilityControl({
  record,
  onSaved,
  compact = false,
}: {
  record: { siteId: string; kind: string; dutyHolder: string | null };
  /** Called after a save lands, so the meters above can be re-read. */
  onSaved: () => void;
  /** Inside the queue the requirement name is already on the row beside it. */
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = record.dutyHolder;
  const known = DUTY_HOLDER_CHOICES.some((choice) => choice.value === current);

  const save = useCallback(
    async (next: string) => {
      if (next === (current ?? "")) return;
      /*
       * The placeholder is not an answer. Its option is disabled, so this
       * cannot normally fire for it, but a keyboard on some engines will still
       * land on a disabled option — and writing "unconfirmed" back would be a
       * person "confirming" a requirement into the state it is already waiting
       * in. The server refuses it too; this is the half that never asks.
       */
      if (next === DUTY_HOLDER_UNCONFIRMED) return;
      setBusy(true);
      setError(null);
      const result = await setResponsibility([record], next === "" ? null : next);
      setBusy(false);
      if (!result.ok) setError(result.error);
      else onSaved();
    },
    [current, onSaved, record],
  );

  return (
    <span className={`resp-control${compact ? " resp-control--compact" : ""}`}>
      <link rel="stylesheet" href={responsibilityCss} precedence="default" />
      <label className="resp-control__label">
        <span className="visually-hidden">Responsibility for {record.kind}</span>
        <select
          className="resp-control__select"
          /* `current ?? ""` covers all three cases: a real answer has its own
             option, the placeholder has the disabled one below, and null is the
             clear option. `known` decides only whether that extra option is
             rendered — never what the value is. */
          value={current ?? ""}
          disabled={busy}
          title={dutyHolderMeaning(current)}
          onChange={(event) => void save(event.target.value)}
        >
          {/* The current non-answer, when it is one — a state, not a choice. */}
          {!known && current ? (
            <option value={current} disabled>
              {dutyHolderLabel(current)}
            </option>
          ) : null}
          <option value="">{dutyHolderLabel(null)}</option>
          {DUTY_HOLDER_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value} title={dutyHolderMeaning(choice.value)}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      {busy ? <span className="resp-control__busy">Saving…</span> : null}
      {error ? (
        <span className="resp-control__error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/* ── The queue ────────────────────────────────────────────────────────────── */

/**
 * CONFIRM RESPONSIBILITIES — every requirement still waiting, in one pass.
 *
 * What this replaces is opening each store's group on the register, reading
 * twelve rows, and setting the ones that say "not confirmed" — twelve times
 * over for a twelve-store estate, with no way to tell when it is done.
 *
 * GROUPED BY SITE because that is the unit somebody actually knows the answer
 * for: a mall unit's landlord owns the same five certificates at every one of
 * its stores, so "select all at Cabot Circus, mark Landlord" is one decision
 * rather than five. Sites with the most waiting come first, which is the store
 * the queue is opened to clear.
 *
 * The queue holds ONLY requirements at the stored `"unconfirmed"` placeholder.
 * A NULL duty holder — nobody has ever been asked — is a different fact and is
 * deliberately not swept in here; the route's GET explains why at length.
 */
export function ConfirmResponsibilitiesQueue({
  search,
  onSaved,
}: {
  search: string;
  /** Re-read the register's own meters after a change. */
  onSaved: () => void;
}) {
  const queue = useOpsQuery<QueuePayload>(ENDPOINT, search);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const data = queue.data;

  /** Every pair in the queue, in the order it is drawn. */
  const allPairs = useMemo(() => {
    const pairs: Array<{ siteId: string; kind: string }> = [];
    for (const group of data?.groups ?? []) {
      for (const record of group.records) pairs.push({ siteId: record.siteId, kind: record.kind });
    }
    return pairs;
  }, [data]);

  const toggle = useCallback((key: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleSite = useCallback((group: QueueGroup) => {
    setSelected((current) => {
      const next = new Set(current);
      const keys = group.records.map((record) => pairKey(record.siteId, record.kind));
      /* Ticking a site that is already wholly ticked unticks it — one control,
         both directions, rather than a Select and a Clear per store. */
      const allOn = keys.every((key) => next.has(key));
      for (const key of keys) {
        if (allOn) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }, []);

  const refresh = useCallback(() => {
    queue.reload();
    onSaved();
    /* A confirmed responsibility moves a requirement into or out of the score,
       so the Compliance dashboard block above re-reads as well. */
    announceDataChanged();
  }, [onSaved, queue]);

  const apply = useCallback(
    async (dutyHolder: string, label: string) => {
      const pairs = allPairs.filter((pair) => selected.has(pairKey(pair.siteId, pair.kind)));
      if (!pairs.length) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      const result = await setResponsibility(pairs, dutyHolder);
      setBusy(false);
      if (!result.ok) {
        /*
         * The selection survives a failure. Emptying the boxes on a refusal
         * would make the reader re-tick twelve rows before they could find out
         * whether a second attempt works.
         */
        setError(result.error);
        return;
      }
      setSelected(new Set<string>());
      setNotice(
        `${plural(result.updated, "requirement")} set to ${label}.` +
          (result.skipped
            ? ` ${result.skipped} were no longer on the register and were left alone.`
            : ""),
      );
      refresh();
    },
    [allPairs, refresh, selected],
  );

  if (queue.error) {
    return (
      <OpsCard title="Confirm responsibilities">
        <ErrorState what={queue.error} onRetry={queue.reload} />
      </OpsCard>
    );
  }
  if (!data) {
    return (
      <div className="ops-rows">
        <SkeletonRow lines={3} height={96} />
        <SkeletonRow lines={3} height={96} />
      </div>
    );
  }

  const selectable = Math.min(allPairs.length, MAX_PER_REQUEST);

  return (
    <div className="ops-rows resp-queue">
      <link rel="stylesheet" href={responsibilityCss} precedence="default" />

      <OpsCard
        title="Confirm responsibilities"
        subtitle={
          data.outstanding
            ? `${plural(data.outstanding, "requirement")} waiting across ${plural(
                data.groups.length,
                "site",
              )}`
            : undefined
        }
      >
        <ResponsibilityCoverageLine coverage={data.coverage} tone="strong" />
        <p className="ops-card__note">
          A requirement stays out of the compliance percentage until somebody says whose
          obligation it is. Confirming one as the client&rsquo;s brings it into the score;
          landlord, shopping centre and not applicable keep it recorded and out of it.
        </p>
        {notice ? (
          <p className="resp-queue__notice" role="status">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="resp-queue__error" role="alert">
            {error}
          </p>
        ) : null}
        {data.outstanding === 0 ? (
          <EmptyState>
            Nothing is waiting. Every requirement here has been answered for, or is held on the
            Store Documentation board — which is an answer in itself.
          </EmptyState>
        ) : null}
      </OpsCard>

      {data.outstanding > 0 ? (
        <>
          {/*
            THE BULK BAR, and why it is not a dialog. The selection it acts on
            is the thing on screen behind it; a modal would cover the rows a
            reader is checking against while asking them to commit to an answer
            about those rows.
          */}
          <div className="resp-bulk" data-active={selected.size > 0 ? "true" : "false"}>
            <div className="resp-bulk__count">
              <label className="resp-bulk__all">
                <input
                  type="checkbox"
                  checked={selected.size > 0 && selected.size === selectable}
                  onChange={() =>
                    setSelected((current) =>
                      current.size
                        ? new Set<string>()
                        : new Set(
                            allPairs
                              .slice(0, MAX_PER_REQUEST)
                              .map((pair) => pairKey(pair.siteId, pair.kind)),
                          ),
                    )
                  }
                />
                <span>
                  {selected.size ? `${selected.size} selected` : `Select all ${selectable}`}
                </span>
              </label>
              {allPairs.length > MAX_PER_REQUEST ? (
                <span className="resp-bulk__cap">
                  {allPairs.length} waiting; up to {MAX_PER_REQUEST} at a time.
                </span>
              ) : null}
            </div>
            <div className="resp-bulk__actions">
              {DUTY_HOLDER_CHOICES.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  className="ops-option resp-bulk__action"
                  disabled={busy || selected.size === 0}
                  title={dutyHolderMeaning(choice.value)}
                  onClick={() => void apply(choice.value, choice.label)}
                >
                  {busy ? "Saving…" : choice.label}
                </button>
              ))}
            </div>
          </div>

          {data.groups.map((group) => {
            const keys = group.records.map((record) => pairKey(record.siteId, record.kind));
            const allOn = keys.length > 0 && keys.every((key) => selected.has(key));
            return (
              <section key={group.siteId} className="ops-group resp-group">
                {/*
                  `<h3><label><input></label></h3>` — the heading wraps the
                  control rather than the other way round, the same shape the
                  register's disclosure uses and for the same reason: the store
                  name has to stay in the heading outline so a screen-reader
                  user can jump between stores without reading every row.
                */}
                <h3 className="ops-group__heading resp-group__heading">
                  <label className="resp-group__select">
                    <input type="checkbox" checked={allOn} onChange={() => toggleSite(group)} />
                    <span className="resp-group__name">{group.siteName}</span>
                    <span className="ops-group__count">
                      {plural(group.records.length, "waiting", "waiting")}
                    </span>
                  </label>
                </h3>
                <ResponsibilityCoverageLine coverage={group.coverage} />
                <div className="ops-group__body">
                  {group.records.map((record) => {
                    const key = pairKey(record.siteId, record.kind);
                    return (
                      <div key={record.id} className="resp-row">
                        <label className="resp-row__pick">
                          <input
                            type="checkbox"
                            checked={selected.has(key)}
                            onChange={() => toggle(key)}
                          />
                          <span className="resp-row__name">{record.kind}</span>
                        </label>
                        {/* The certificate's own state, so a reader can tell a
                            requirement they hold from one they do not before
                            deciding whose it is. */}
                        <span
                          className="resp-row__state"
                          style={{ ["--resp-state" as string]: COMPLIANCE_COLOUR[record.state] }}
                          title={complianceMeaning(record.state)}
                        >
                          {record.state}
                        </span>
                        <ResponsibilityControl record={record} onSaved={refresh} compact />
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </>
      ) : null}
    </div>
  );
}
