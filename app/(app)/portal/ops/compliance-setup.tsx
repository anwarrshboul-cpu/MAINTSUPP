"use client";

/**
 * THE REGISTER'S SETUP TOOLS — 2B, 2C and 2D, on one screen because they are one
 * job.
 *
 * ── WHY THESE THREE ARE TOGETHER ──────────────────────────────────────────
 *
 * Somebody arriving here is doing a single piece of work: getting this
 * workspace's compliance register to describe this workspace's estate. That job
 * has three parts and they are useless apart —
 *
 *   • the TEMPLATE says what every site is asked for, and every other name those
 *     certificates go by (2C);
 *   • the BACKFILL applies it to sites that predate it, previewed and
 *     reversible (2D);
 *   • ADD A SITE, because the commonest reason a store is missing from the
 *     register is that it is missing from `sites`, and being sent to another
 *     screen to fix that loses the filters, the scroll position and the thread
 *     of what you were doing (2B).
 *
 * ── WHY THE TEMPLATE IS NOT JUST A LIST OF NAMES ──────────────────────────
 *
 * Because the data says a list would not have helped. Staging's Demo Client
 * holds 204 compliance requirements over twelve stores where about 66 is the
 * honest number. Six of the eight names that estate uses are ordinary trade
 * synonyms for a board slot, and one — "Fire risk assessment" against "Fire Risk
 * Assessment" — differs by a single capital letter. So each row carries OTHER
 * NAMES, and the resolver in `app/lib/compliance-vocabulary.ts` is what the
 * profile writer matches through.
 *
 * ── SAVING THE TEMPLATE CHANGES NO COMPLIANCE ROW ─────────────────────────
 *
 * Deliberately, and the screen says so in as many words. `PUT
 * /api/compliance/template` writes a setting; `POST /api/compliance/backfill`
 * writes rows and previews first. A settings save that silently rewrote sixty
 * rows of somebody's real register would be a migration disguised as a
 * preference — which is exactly the accident this whole batch exists to undo.
 */

import { useCallback, useEffect, useState } from "react";
import { announceDataChanged } from "./ops-url-state";
import setupCss from "./compliance-setup.css?url";
import { EmptyState, ErrorState, OpsCard, SkeletonRow, plural } from "./ops-primitives";
import {
  BUILT_IN_KIND_ALIASES,
  DEFAULT_COMPLIANCE_TEMPLATE,
  type ComplianceTemplate,
  type TemplateKind,
} from "../../../lib/compliance-vocabulary";
import { checkPostcode } from "../../../lib/uk-postcode";

type TemplatePayload = {
  template: ComplianceTemplate;
  builtInAliases: Record<string, readonly string[]>;
};

type BackfillPlan = {
  siteId: string;
  siteName: string;
  create: string[];
  held: string[];
  aliased: Array<{ kind: string; matchedAs: string }>;
};

type BackfillPreview = {
  dryRun: boolean;
  batchId?: string;
  totals: { sites: number; sitesChanged: number; create: number; held: number; aliased: number };
  plans?: BackfillPlan[];
  created?: number;
  revert?: { action: string; batchId: string };
};

/** Split a comma-separated box into names, without losing one to a stray comma. */
function parseAliases(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function ComplianceSetup({ onChanged }: { onChanged?: () => void }) {
  const [payload, setPayload] = useState<TemplatePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    fetch("/api/compliance/template", { headers: { Accept: "application/json" } })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | (TemplatePayload & { error?: string })
          | null;
        if (!live) return;
        if (!response.ok || !body || body.error) {
          setError(body?.error ?? "The compliance template could not be loaded.");
          return;
        }
        setError(null);
        setPayload(body);
      })
      .catch(() => {
        /* A failed read is reported, never turned into an empty template. An
           empty template on screen is indistinguishable from a workspace that
           tracks nothing, and somebody would then "fix" it by saving. */
        if (live) setError("The compliance template could not be loaded.");
      });
    return () => {
      live = false;
    };
  }, [nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  /* A created site or an applied backfill changes the register — and so the
     Compliance dashboard block above it, which re-reads through the same
     signal every aggregate on the page answers. */
  const changed = useCallback(() => {
    onChanged?.();
    announceDataChanged();
  }, [onChanged]);

  return (
    <div className="ops-rows">
      {/* Hoisted once however many of the three cards render, the same way every
          other ops surface loads its stylesheet. */}
      <link rel="stylesheet" href={setupCss} precedence="default" />
      <AddSiteInline onCreated={changed} />
      {error ? (
        <OpsCard title="Requirement template">
          <ErrorState what={error} onRetry={reload} />
        </OpsCard>
      ) : !payload ? (
        <OpsCard title="Requirement template">
          <SkeletonRow lines={4} height={120} />
        </OpsCard>
      ) : (
        <>
          <TemplateEditor payload={payload} onSaved={reload} />
          <BackfillPanel onApplied={changed} />
        </>
      )}
    </div>
  );
}

/* ── 2C. The template ─────────────────────────────────────────────────────── */

function TemplateEditor({
  payload,
  onSaved,
}: {
  payload: TemplatePayload;
  onSaved: () => void;
}) {
  const [kinds, setKinds] = useState<TemplateKind[]>(payload.template.kinds);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const update = (index: number, patch: Partial<TemplateKind>) => {
    setKinds((current) =>
      current.map((entry, position) => (position === index ? { ...entry, ...patch } : entry)),
    );
  };

  const save = async () => {
    setBusy(true);
    setProblem(null);
    setMessage(null);
    try {
      const response = await fetch("/api/compliance/template", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template: { kinds } }),
      });
      const body = (await response.json().catch(() => null)) as
        | { template?: ComplianceTemplate; error?: string }
        | null;
      if (!response.ok || !body || body.error) {
        /* The server's sentence, not a generic one. It names the word that is
           claimed twice, which is the only part an operator can act on. */
        setProblem(body?.error ?? "The template could not be saved.");
        return;
      }
      if (body.template) setKinds(body.template.kinds);
      setMessage("Saved. No compliance record was changed.");
      onSaved();
    } catch {
      setProblem("The template could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <OpsCard
      title="Requirement template"
      subtitle={`${plural(kinds.filter((entry) => entry.enabled).length, "requirement")} asked of every site`}
    >
      <p className="ops-card__note">
        Saving this changes what NEW sites are asked for and how existing
        certificate names are recognised. It does not create, rename or delete a
        single compliance record — use Backfill below for that, which previews
        first.
      </p>

      <ul className="compliance-template">
        {kinds.map((entry, index) => {
          const shipped = BUILT_IN_KIND_ALIASES[entry.kind] ?? [];
          return (
            <li key={`${entry.kind}-${index}`} className="compliance-template__row">
              <div className="compliance-template__head">
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={entry.enabled}
                    onChange={(event) => update(index, { enabled: event.target.checked })}
                  />
                  <span>
                    Ask every site for this
                    <span className="visually-hidden"> — {entry.kind}</span>
                  </span>
                </label>
                {entry.board ? (
                  /* One of the twelve the Store Documentation board tracks. It
                     can be switched off but not removed: the board has a column
                     for it, and a register with no name for a column it can see
                     would show a certificate it cannot label. */
                  <span className="compliance-template__badge" title="Tracked by the Store Documentation board">
                    On the board
                  </span>
                ) : null}
              </div>

              <label className="form-field">
                <span>Requirement</span>
                <input
                  type="text"
                  value={entry.kind}
                  readOnly={entry.board}
                  aria-describedby={entry.board ? `template-board-${index}` : undefined}
                  onChange={(event) => update(index, { kind: event.target.value })}
                />
                {entry.board ? (
                  <p id={`template-board-${index}`} className="form-hint">
                    Named by the Store Documentation board, so it cannot be renamed here.
                  </p>
                ) : null}
              </label>

              <label className="form-field">
                <span>Other names for it</span>
                <input
                  type="text"
                  value={entry.aliases.join(", ")}
                  placeholder="Separate with commas"
                  aria-describedby={`template-alias-${index}`}
                  onChange={(event) =>
                    update(index, { aliases: parseAliases(event.target.value) })
                  }
                />
                <p id={`template-alias-${index}`} className="form-hint">
                  {shipped.length
                    ? /*
                       * The shipped names are shown SEPARATELY from the box
                       * rather than pre-filled into it. Merging them would
                       * invite somebody to tidy up a list they never wrote and
                       * cannot delete — the resolver applies them whether or
                       * not this box repeats them.
                       */
                      `Already recognised: ${shipped.join(", ")}. Add any others this estate uses.`
                    : "Any other wording your certificates use for this requirement."}
                </p>
              </label>
            </li>
          );
        })}
      </ul>

      <div className="ops-actions">
        <button type="button" className="primary-button" disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save template"}
        </button>
        <button
          type="button"
          className="ops-option"
          disabled={busy}
          onClick={() => setKinds(DEFAULT_COMPLIANCE_TEMPLATE.kinds)}
        >
          Reset to the standard twelve
        </button>
      </div>

      {problem ? (
        <p className="form-hint form-hint--problem" role="alert">
          {problem}
        </p>
      ) : null}
      {message ? (
        <p className="form-hint" role="status">
          {message}
        </p>
      ) : null}
    </OpsCard>
  );
}

/* ── 2D. The backfill ─────────────────────────────────────────────────────── */

function BackfillPanel({ onApplied }: { onApplied?: () => void }) {
  const [preview, setPreview] = useState<BackfillPreview | null>(null);
  const [applied, setApplied] = useState<BackfillPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [undone, setUndone] = useState<string | null>(null);

  const call = async (body: Record<string, unknown>) => {
    const response = await fetch("/api/compliance/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as
      | (BackfillPreview & { error?: string; removed?: number; kept?: number })
      | null;
    if (!response.ok || !payload || payload.error) {
      throw new Error(payload?.error ?? "The backfill could not be run.");
    }
    return payload;
  };

  const run = async (dryRun: boolean) => {
    setBusy(true);
    setProblem(null);
    setUndone(null);
    try {
      const result = await call({ dryRun });
      if (dryRun) {
        setPreview(result);
        setApplied(null);
      } else {
        setApplied(result);
        setPreview(null);
        onApplied?.();
      }
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "The backfill could not be run.");
    } finally {
      setBusy(false);
    }
  };

  const undo = async (batchId: string) => {
    setBusy(true);
    setProblem(null);
    try {
      const result = (await call({ action: "revert", batchId })) as unknown as {
        removed: number;
        kept: number;
      };
      setApplied(null);
      setUndone(
        result.kept > 0
          ? /* The kept rows are the point. "Removed 130" alone would leave
               somebody believing the undo was total when it deliberately was
               not. */
            `Removed ${result.removed}. ${plural(result.kept, "record")} were kept because somebody had already worked on them.`
          : `Removed ${result.removed}. Nothing had been worked on, so the batch is fully undone.`,
      );
      onApplied?.();
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "The batch could not be undone.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <OpsCard title="Backfill" subtitle="Give existing sites the requirements in this template">
      <p className="ops-card__note">
        Preview first. Nothing is written until you apply, and an applied batch
        can be undone — except for any record somebody has since attached a
        certificate to, dated, or confirmed, which is kept.
      </p>

      <div className="ops-actions">
        <button type="button" className="ops-option" disabled={busy} onClick={() => run(true)}>
          {busy ? "Working…" : "Preview"}
        </button>
        {preview ? (
          <button type="button" className="primary-button" disabled={busy} onClick={() => run(false)}>
            Apply to {plural(preview.totals.sitesChanged, "site")}
          </button>
        ) : null}
      </div>

      {problem ? (
        <p className="form-hint form-hint--problem" role="alert">
          {problem}
        </p>
      ) : null}
      {undone ? (
        <p className="form-hint" role="status">
          {undone}
        </p>
      ) : null}

      {preview ? (
        preview.totals.create === 0 ? (
          <EmptyState>
            Every site already holds every requirement in this template
            {preview.totals.aliased > 0
              ? `, including ${plural(preview.totals.aliased, "record")} recorded under a different name`
              : ""}
            . Nothing would be created.
          </EmptyState>
        ) : (
          <>
            <p className="ops-card__note" role="status">
              {plural(preview.totals.create, "record")} would be created across{" "}
              {plural(preview.totals.sitesChanged, "site")}. {preview.totals.held} already
              match by name
              {preview.totals.aliased > 0
                ? `, and ${preview.totals.aliased} are already held under a different name and will NOT be duplicated`
                : ""}
              .
            </p>
            <ul className="compliance-template__plans">
              {(preview.plans ?? [])
                .filter((plan) => plan.create.length || plan.aliased.length)
                .map((plan) => (
                  <li key={plan.siteId}>
                    <strong>{plan.siteName}</strong>
                    {plan.create.length ? <span> — add {plan.create.join(", ")}</span> : null}
                    {plan.aliased.length ? (
                      /* The line that would have stopped the run that made 144
                         duplicates. It names both words, so somebody can see
                         the machine understood their vocabulary. */
                      <span className="compliance-template__aliased">
                        {" "}
                        · already held as{" "}
                        {plan.aliased
                          .map((entry) => `${entry.matchedAs} (${entry.kind})`)
                          .join(", ")}
                      </span>
                    ) : null}
                  </li>
                ))}
            </ul>
          </>
        )
      ) : null}

      {applied?.revert ? (
        <p className="ops-card__note" role="status">
          Created {plural(applied.created ?? 0, "record")}.{" "}
          <button
            type="button"
            className="ops-link"
            disabled={busy}
            onClick={() => undo(applied.revert!.batchId)}
          >
            Undo this batch
          </button>
        </p>
      ) : null}
    </OpsCard>
  );
}

/* ── 2B. Add a site without leaving the register ──────────────────────────── */

function AddSiteInline({ onCreated }: { onCreated?: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [town, setTown] = useState("");
  const [postcode, setPostcode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const postcodeCheck = checkPostcode(postcode);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setProblem("A site needs a name.");
      return;
    }
    setBusy(true);
    setProblem(null);
    setDone(null);
    try {
      const response = await fetch("/api/sites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          code: code.trim(),
          /*
           * `addressLine1` is REQUIRED by the route and there is nowhere on this
           * short form to type one, so the town stands in for it. Sending an
           * empty string would be refused, and inventing a placeholder address
           * would put a fiction in a legally significant column — the town is
           * at least true. Whatever is missing is exactly what the
           * missing-details list on the Sites page exists to chase.
           */
          addressLine1: town.trim() || name.trim(),
          city: town.trim(),
          postcode: postcodeCheck.value,
          /* The route's own defaults for everything else. This form is
             deliberately four fields: it exists so somebody does not lose their
             filters, not to replace the Sites editor. */
          status: "active",
          siteTypeValue: "Store",
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | { error?: string; site?: { name?: string } }
        | null;
      if (!response.ok || !body || body.error) {
        setProblem(body?.error ?? "The site could not be created.");
        return;
      }
      /*
       * The compliance profile is created by the route, in the same request,
       * and rolled back with the site if it fails — see `ensureComplianceProfile`
       * in `app/api/sites/route.ts`. So a site that appears here appears in the
       * register too, which is the entire reason this form is on this page.
       */
      setDone(`${name.trim()} was added, with its compliance requirements.`);
      setName("");
      setCode("");
      setTown("");
      setPostcode("");
      onCreated?.();
    } catch {
      setProblem("The site could not be created.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <OpsCard title="Add a site" subtitle="Without leaving the register">
      {!open ? (
        <button type="button" className="ops-option" onClick={() => setOpen(true)}>
          Add a site
        </button>
      ) : (
        <form className="form-grid" onSubmit={submit}>
          <div className="form-field">
            <label htmlFor="inline-site-name">
              Site name<span aria-hidden="true"> *</span>
            </label>
            <input
              id="inline-site-name"
              type="text"
              value={name}
              required
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="form-field">
            <label htmlFor="inline-site-code">Code</label>
            <input
              id="inline-site-code"
              type="text"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </div>
          <div className="form-field">
            <label htmlFor="inline-site-town">Town or city</label>
            <input
              id="inline-site-town"
              type="text"
              value={town}
              onChange={(event) => setTown(event.target.value)}
            />
          </div>
          <div className="form-field">
            <label htmlFor="inline-site-postcode">Postcode</label>
            <input
              id="inline-site-postcode"
              type="text"
              value={postcode}
              placeholder="SW1A 1AA"
              aria-describedby={postcodeCheck.problem ? "inline-site-postcode-problem" : undefined}
              aria-invalid={postcodeCheck.problem ? true : undefined}
              onChange={(event) => setPostcode(event.target.value)}
              onBlur={() => setPostcode(postcodeCheck.value)}
            />
            {postcodeCheck.problem ? (
              <p id="inline-site-postcode-problem" className="form-hint form-hint--problem" role="status">
                {postcodeCheck.problem}
              </p>
            ) : null}
          </div>

          <div className="ops-actions">
            <button type="submit" className="primary-button" disabled={busy}>
              {busy ? "Adding…" : "Add site"}
            </button>
            <button type="button" className="ops-option" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {problem ? (
        <p className="form-hint form-hint--problem" role="alert">
          {problem}
        </p>
      ) : null}
      {done ? (
        <p className="form-hint" role="status">
          {done}
        </p>
      ) : null}
    </OpsCard>
  );
}
