"use client";

/**
 * Settings → Portal modules — which screens this workspace has at all.
 *
 * Master Specification §19 asks for modules that can be switched off per client,
 * and asks for it to be real: the module leaves the navigation AND the route
 * stops answering. The switches are here; the enforcement is in
 * `app/lib/page-guard.ts` and in `portal-app.tsx`'s catalogue, both reading the
 * one answer `/api/context` resolves, so a control this panel moved and a door
 * the product leaves open cannot disagree.
 *
 * WHY THIS PANEL CAN DECIDE FOR ITSELF THAT IT IS NOT YOURS
 *
 * `navigation.edit` is reserved to Super Admin (`SUPER_ADMIN_ONLY` in
 * `app/lib/permissions.ts`), and owner decision D1 put this control there. So
 * for every other role `GET /api/portal-modules` answers 403 — which is not a
 * failure to report but an answer to respect. A 403 renders NOTHING. Every other
 * refusal still shows its message, because "the server is unwell" and "this is
 * not for you" are different things and a card that says the wrong one sends
 * people to support for no reason.
 *
 * `brand-colours-panel.tsx` beside it takes the other option — it renders
 * read-only for a role that may look but not change — and that is right there,
 * because a palette is what the page in front of you is painted with. The list
 * of modules a client does NOT have is not something to show a client.
 *
 * WHY DRAFT-THEN-SAVE, AND WHY IT RELOADS
 *
 * Same two reasons as the brand colours. A switch that applied on click would
 * need one round trip and one reload per module, and somebody reorganising a
 * workspace moves several. And the sidebar is built from the context read this
 * page load already made, so until the document is fetched again the navigation
 * in front of the person still lists a module they have just switched off.
 * Saying so and reloading is the honest option.
 *
 * WHAT A SWITCH DOES NOT DO
 *
 * It does not delete anything. Jobs switched off is a workspace with no Jobs
 * screen, not a workspace with no jobs — the rows, the boards and the documents
 * are untouched and come back with the switch. That sentence is on the screen,
 * not only in this comment, because the opposite assumption is the one that
 * stops an administrator from trying it.
 */

import { useCallback, useEffect, useState } from "react";

import { Icon } from "../../../components";
import "./portal-modules-panel.css";

type PortalModuleRow = {
  key: string;
  label: string;
  enabled: boolean;
  permitted: boolean;
  disableable: boolean;
  permanentReason: string | null;
  requiredCapability: string | null;
  isDefault: boolean;
};

type ModulesResponse = {
  canEdit: boolean;
  modules: PortalModuleRow[];
  error?: string;
};

export function PortalModulesPanel() {
  const [state, setState] = useState<ModulesResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /** A 403 is an answer, not an outage. See the header. */
  const [withheld, setWithheld] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/portal-modules", { cache: "no-store" });
      if (response.status === 403) {
        setWithheld(true);
        return;
      }
      const body = (await response.json()) as ModulesResponse;
      if (!response.ok) {
        setFailure(body.error ?? "Could not load the portal modules.");
        return;
      }
      setState(body);
      setDraft({});
      setFailure(null);
    } catch {
      setFailure("Could not load the portal modules.");
    }
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- `load` awaits the fetch
     before it touches state, so nothing here sets state synchronously in the
     effect body; the rule cannot see through the promise. The same disable, for
     the same reason, sits over the identical pattern in
     `views/brand-colours-panel.tsx` and `views/audit-log.tsx`. */
  useEffect(() => {
    void load();
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (withheld) return null;

  if (failure && !state) {
    return (
      <section className="panel settings-card">
        <div className="settings-card__heading">
          <span>
            <Icon name="settings" size={19} />
          </span>
          <div>
            <h2>Portal modules</h2>
            <p>{failure}</p>
          </div>
        </div>
      </section>
    );
  }

  if (!state) return null;

  const { modules } = state;
  /* Only what actually changed is sent, so pressing Save without touching
     anything is a no-op rather than a write of all nineteen rows. */
  const pending = Object.entries(draft).filter(
    ([key, enabled]) => modules.find((module) => module.key === key)?.enabled !== enabled,
  );

  const save = async () => {
    setBusy(true);
    setStatus(null);
    setFailure(null);
    try {
      const response = await fetch("/api/portal-modules", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modules: Object.fromEntries(pending) }),
      });
      const body = (await response.json()) as ModulesResponse;
      if (!response.ok) {
        setFailure(body.error ?? "Could not save the portal modules.");
        return;
      }
      setState(body);
      setDraft({});
      setStatus("Saved. Reloading so the navigation matches…");
      setTimeout(() => window.location.reload(), 600);
    } catch {
      setFailure("Could not save the portal modules.");
    } finally {
      setBusy(false);
    }
  };

  const turningOff = pending.filter(([, enabled]) => !enabled).length;

  return (
    <section className="panel settings-card">
      <div className="settings-card__heading">
        <span>
          <Icon name="settings" size={19} />
        </span>
        <div>
          <h2>Portal modules</h2>
          <p>
            Which screens this workspace has. A module switched off leaves the
            sidebar for everybody here, and its address stops opening.
          </p>
          {/* See the header: the assumption worth correcting on the screen. */}
          <p className="portal-modules__scope">
            Nothing is deleted. The records behind a module stay exactly as they
            are and come back with the switch.
          </p>
        </div>
      </div>

      <div className="portal-modules">
        {modules.map((module) => {
          const enabled = draft[module.key] ?? module.enabled;
          return (
            <div
              className={`portal-module${enabled ? "" : " portal-module--off"}`}
              key={module.key}
            >
              <label className="portal-module__switch" htmlFor={`pm-${module.key}`}>
                <input
                  id={`pm-${module.key}`}
                  type="checkbox"
                  checked={enabled}
                  /* A permanent module's switch is shown and disabled rather
                     than hidden, so the list is the whole product and "cannot be
                     switched off" is visible instead of inferred from a gap. */
                  disabled={!module.disableable || busy}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      [module.key]: event.target.checked,
                    }))
                  }
                />
                <span className="portal-module__track" aria-hidden="true" />
              </label>
              <div className="portal-module__body">
                <strong>{module.label}</strong>
                {module.permanentReason ? (
                  <small className="portal-module__permanent">
                    {module.permanentReason}
                  </small>
                ) : (
                  <small>
                    {/*
                     * Named where a single capability governs the module, and
                     * said plainly where none does. Three of the nineteen
                     * cannot be expressed as one capability — the reasons are in
                     * `app/lib/portal-modules.ts` — and a blank there would read
                     * as "open to everybody", which is not what it means.
                     */}
                    {module.requiredCapability
                      ? `Needs ${module.requiredCapability}.`
                      : "Who may open it is decided by this module's own rule."}
                  </small>
                )}
              </div>
              {module.permitted ? null : (
                /* Your own access, not the workspace's setting. Worth saying:
                   otherwise a Super Admin who cannot see a module they have just
                   switched ON has no way to tell which of the two is why. */
                <span className="portal-module__note">Out of your reach</span>
              )}
            </div>
          );
        })}
      </div>

      <div className="portal-modules__actions">
        {turningOff > 0 ? (
          <p className="portal-modules__warning" role="status">
            <Icon name="alert" size={15} />
            <span>
              {turningOff === 1
                ? "1 module will disappear for everybody in this workspace."
                : `${turningOff} modules will disappear for everybody in this workspace.`}
            </span>
          </p>
        ) : null}
        <button
          type="button"
          /* The same class the Settings screen's own Save uses, so the buttons
             on one page are one control rather than several designs. */
          className="primary-button"
          disabled={busy || pending.length === 0}
          onClick={() => void save()}
        >
          <Icon name="check" size={17} />
          {busy ? "Saving…" : "Save modules"}
        </button>
        {status ? <span className="portal-modules__status">{status}</span> : null}
        {failure ? (
          <span className="portal-modules__failure" role="alert">
            {failure}
          </span>
        ) : null}
      </div>
    </section>
  );
}

export default PortalModulesPanel;
