"use client";

/**
 * SITE ACCESS — which of a workspace's sites a member may work.
 *
 * The owner's decision (2026-09-22): the smallest proper administrative UI over
 * `memberships.site_scope`, for the authority that already manages access
 * (`users.edit`). The server is the rule — `PATCH /api/admin/users` with
 * `action: "site_scope"` refuses yourself, an Owner or a Super Admin, an empty
 * list and any site that is not this workspace's, and a site-restricted member
 * never holds `users.edit` (`SITE_RESTRICTED_CEILING`), so nobody confined can
 * widen anybody's access from here. This screen only draws the choice.
 */
import { useMemo, useState } from "react";
import { Icon } from "../../../components";
import { useDialogBehaviour } from "../overlay/dialog-behaviour";

export type SiteRef = { id: string; name: string };

/** "All sites", or how many — with the names for a tooltip. Null is every site; [] is none. */
export function siteAccessSummary(
  scope: string[] | null | undefined,
  sites: readonly SiteRef[],
): { label: string; title: string; restricted: boolean } {
  if (scope === null || scope === undefined) {
    return { label: "All sites", title: "Unrestricted: every site in this workspace", restricted: false };
  }
  const names = new Map(sites.map((site) => [site.id, site.name]));
  const listed = scope.map((id) => names.get(id) ?? "a site no longer in this workspace");
  if (!scope.length) {
    return { label: "No sites", title: "Restricted to no site: they can reach nothing", restricted: true };
  }
  return {
    label: `${scope.length} site${scope.length === 1 ? "" : "s"}`,
    title: `Restricted to: ${listed.join(", ")}`,
    restricted: true,
  };
}

export function SiteAccessDialog({
  person,
  scope,
  sites,
  onClose,
  onSave,
}: {
  person: string;
  scope: string[] | null;
  sites: readonly SiteRef[];
  onClose: () => void;
  /** Resolves to whether the server accepted it; the dialog closes on success. */
  onSave: (next: string[] | null) => Promise<boolean>;
}) {
  const { surface, onKeyDown } = useDialogBehaviour(true, onClose);
  const [mode, setMode] = useState<"all" | "some">(scope === null ? "all" : "some");
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(scope ?? []));
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? sites.filter((site) => site.name.toLowerCase().includes(needle)) : sites;
  }, [filter, sites]);
  const titleId = "site-access-title";
  const invalid = mode === "some" && chosen.size === 0;

  function toggle(id: string) {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    if (invalid) return;
    setSaving(true);
    const accepted = await onSave(mode === "all" ? null : sites.map((site) => site.id).filter((id) => chosen.has(id)));
    setSaving(false);
    if (accepted) onClose();
  }

  return (
    <div className="admin-dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={surface}
        className="admin-dialog site-access-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>Site access</span>
            <h2 id={titleId}>{person}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" size={17} />
          </button>
        </header>
        <form
          className="admin-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset className="site-access-mode">
            <legend>Which sites may they work?</legend>
            <label className="admin-check">
              <input
                type="radio"
                name="site-access-mode"
                checked={mode === "all"}
                onChange={() => setMode("all")}
              />
              Every site in this workspace
            </label>
            <label className="admin-check">
              <input
                type="radio"
                name="site-access-mode"
                checked={mode === "some"}
                onChange={() => setMode("some")}
              />
              Only the sites chosen below
            </label>
          </fieldset>

          <p className="site-access-warning" role="note">
            <Icon name="shield" size={15} />
            <span>
              A member limited to some sites sees and works only those sites&rsquo; jobs, documents, calendar and
              reminders. They also lose every workspace-wide power &mdash; settings, people and roles, teams, board
              structure, integrations, billing, imports and the audit log &mdash; and cannot add sites. The server
              enforces this; nothing is merely hidden.
            </span>
          </p>

          {mode === "some" ? (
            <>
              {sites.length > 8 ? (
                <label className="admin-field">
                  <span>Find a site</span>
                  <input
                    type="search"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder="Site name"
                  />
                </label>
              ) : null}
              <div className="site-access-list" role="group" aria-label="Sites">
                {shown.map((site) => (
                  <label key={site.id} className="admin-check">
                    <input type="checkbox" checked={chosen.has(site.id)} onChange={() => toggle(site.id)} />
                    {site.name}
                  </label>
                ))}
                {!shown.length ? <small className="admin-subtle">No site matches that search.</small> : null}
              </div>
              <small className={invalid ? "site-access-count site-access-count--invalid" : "site-access-count"} aria-live="polite">
                {invalid
                  ? "Choose at least one site. Somebody who may reach no site should be deactivated instead."
                  : `${chosen.size} of ${sites.length} site${sites.length === 1 ? "" : "s"} chosen`}
              </small>
            </>
          ) : null}

          <div className="admin-form__actions">
            <button type="button" className="secondary-button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary-button" disabled={saving || invalid}>
              {saving ? "Saving…" : "Save site access"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
