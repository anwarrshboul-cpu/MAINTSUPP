"use client";

/**
 * Settings → Navigation icons — which glyph each sidebar entry wears.
 *
 * WHY THIS IS A SETTINGS PANEL AND NOT A CONTROL IN THE SIDEBAR EDITOR.
 *
 * The sidebar editor is a drag-and-drop surface: every row is a drag handle, and a
 * `<select>` nested inside one fights the pointer handlers around it. It also has a
 * pinned radio group (`name="section-icon"` in `section-manager.tsx`), and a single
 * radio-group name cannot serve two pickers on one page.
 *
 * More to the point, a glyph is the same KIND of decision as a brand colour and a
 * typeface: a workspace-wide presentation choice made once by whoever administers
 * the workspace. It belongs where the other two now live.
 *
 * WHERE THE CHOICE IS STORED, AND WHY THERE IS NO NEW TABLE.
 *
 * `navigation_layouts.items` already holds per-organisation overrides of a built-in
 * section's presentation — `label` is the precedent, "a user's rename, or null to
 * keep whatever the product calls it". An icon is the same field with a different
 * payload, and that row already has the three-layer merge, the `navigation.edit`
 * gate, the audit trail and the transport. A table of its own would have bought a
 * migration, a schema-fingerprint change and a second place for the sidebar to
 * disagree with itself.
 *
 * WHY SAVING HERE ALSO FIXES THE ORDER, AND WHY THAT IS SAID ON THE SCREEN.
 *
 * A stored arrangement is a whole layer: `applyLayer` reads it as an order as well as
 * a set of overrides, so a partial one would reorder the sidebar. Writing an icon
 * therefore writes the arrangement the workspace is *already* seeing, which makes the
 * current order explicit as the workspace default. That is exactly what dragging one
 * row in the sidebar editor already does — but somebody changing a glyph would not
 * expect it, so the panel says so rather than letting them find out.
 *
 * ONE READ OF `/api/navigation`, THROUGH THE SHARED STORE.
 * `tests/shared-context-and-navigation-reads.test.mjs` allows exactly one module to
 * fetch that endpoint, and it is `navigation-store.ts`. This panel goes through it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { Icon, type IconName } from "../../../components";
import { ICON_NAMES, isIconName } from "../../../api/workspace-sections/catalogue";
import {
  resolveNavigation,
  sanitiseArrangement,
  toArrangement,
  type NavArrangementItem,
  type NavCatalogueEntry,
} from "../../../api/navigation/layout";
import { fetchNavigation, forgetNavigation } from "../navigation-store";
import type { SidebarNavEntry } from "../sidebar-nav";
import "./nav-icons-panel.css";

export function NavIconsPanel({ catalogue }: { catalogue: SidebarNavEntry[] }) {
  const [workspace, setWorkspace] = useState<NavArrangementItem[] | null>(null);
  const [locked, setLocked] = useState<string[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  /** A 403-shaped answer is not an outage. See `portal-modules-panel.tsx`. */
  const [withheld, setWithheld] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async (options?: { force?: boolean }) => {
    try {
      const payload = await fetchNavigation(options);
      if (payload.canEditDefault !== true) {
        /*
         * `navigation.edit` is Super Admin only. For every other role this panel is
         * not a refusal to report but an answer to respect, so it renders nothing —
         * the same choice `portal-modules-panel.tsx` makes, and the opposite of
         * `brand-colours-panel.tsx`, which shows read-only because a palette is what
         * the page in front of you is painted with.
         */
        setWithheld(true);
        return;
      }
      setCanEdit(true);
      setWorkspace(sanitiseArrangement(payload.arrangement?.workspace));
      setLocked(Array.isArray(payload.locked) ? (payload.locked as string[]) : []);
      setDraft({});
      setFailure(null);
    } catch {
      setFailure("Could not load the navigation icons.");
    }
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- `load` awaits the fetch before
     it touches state, so nothing here sets state synchronously in the effect body;
     the rule cannot see through the promise. The same disable sits over the identical
     pattern in `brand-colours-panel.tsx` and `portal-modules-panel.tsx`. */
  useEffect(() => {
    void load();
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /*
   * The arrangement the workspace is currently seeing, resolved with the SAME
   * function the sidebar uses. Not a second merge: two implementations of this would
   * drift, and the first symptom of drift is a panel that disagrees with the sidebar
   * beside it about what the sidebar looks like.
   */
  const resolved = useMemo(() => {
    if (!workspace) return null;
    const entries: NavCatalogueEntry[] = catalogue.map((entry) => ({
      key: entry.key,
      label: entry.label,
      group: entry.group,
    }));
    return resolveNavigation({
      catalogue: entries,
      workspaceItems: workspace,
      userItems: null,
      locked,
    });
  }, [workspace, catalogue, locked]);

  const builtInIcon = useMemo(() => {
    const map = new Map<string, IconName>();
    for (const entry of catalogue) map.set(entry.key, entry.icon);
    return map;
  }, [catalogue]);

  if (withheld) return null;

  if (failure && !resolved) {
    return (
      <section className="panel settings-card">
        <div className="settings-card__heading">
          <span>
            <Icon name="grid" size={19} />
          </span>
          <div>
            <h2>Navigation icons</h2>
            <p>{failure}</p>
          </div>
        </div>
      </section>
    );
  }

  if (!resolved || !canEdit) return null;

  const rows = resolved.flat;
  const chosenFor = (key: string) => draft[key] ?? currentFor(key);
  function currentFor(key: string): string {
    const item = rows.find((row) => row.key === key);
    return isIconName(item?.icon) ? (item.icon as string) : "";
  }

  const pending = Object.entries(draft).filter(([key, value]) => value !== currentFor(key));

  const save = async () => {
    setBusy(true);
    setStatus(null);
    setFailure(null);
    try {
      /*
       * The whole arrangement, with the icons replaced. `toArrangement` serialises
       * what the sidebar is showing now, so the order that gets written is the order
       * already on screen — nothing moves as a side effect of choosing a glyph.
       */
      const items = toArrangement(resolved.groups).map((item) => {
        if (item.kind !== "section") return item;
        const chosen = draft[item.key];
        if (chosen === undefined) return item;
        return { ...item, icon: chosen === "" ? null : chosen };
      });

      const response = await fetch("/api/navigation", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "workspace", items, locked }),
      });
      const body = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!response.ok) {
        setFailure(body?.error ?? "Could not save the navigation icons.");
        return;
      }
      /* The cached answer is now wrong rather than stale — the store's own rule. */
      forgetNavigation();
      await load({ force: true });
      setStatus("Saved. Reloading so the sidebar matches…");
      setTimeout(() => window.location.reload(), 600);
    } catch {
      setFailure("Could not save the navigation icons.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel settings-card">
      <div className="settings-card__heading">
        <span>
          <Icon name="grid" size={19} />
        </span>
        <div>
          <h2>Navigation icons</h2>
          <p>
            The glyph each sidebar entry wears, for everybody in this workspace.
          </p>
          {/* See the header: a real consequence, said rather than discovered. */}
          <p className="nav-icons__scope">
            Saving also records the sidebar’s current order as this workspace’s
            default — the same thing dragging a row in the sidebar editor does.
            Choosing “Product default” for every entry and saving leaves the glyphs
            as MAINTSUPP ships them.
          </p>
        </div>
      </div>

      <div className="nav-icons">
        {rows.map((row) => {
          const chosen = chosenFor(row.key);
          const drawn = isIconName(chosen)
            ? (chosen as IconName)
            : builtInIcon.get(row.key) ?? "grid";
          return (
            <div className="nav-icon-row" key={row.key}>
              <span className="nav-icon-row__glyph" aria-hidden="true">
                <Icon name={drawn} size={18} />
              </span>
              <div className="nav-icon-row__body">
                <strong>{row.label}</strong>
                {chosen === "" ? (
                  /* Said plainly, so "we have not chosen one" is distinguishable
                     from "we chose this and it happens to match". */
                  <small>Product default</small>
                ) : (
                  <small>Chosen for this workspace</small>
                )}
              </div>
              <select
                aria-label={`Icon for ${row.label}`}
                className="nav-icon-row__select"
                value={chosen}
                disabled={busy}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, [row.key]: event.target.value }))
                }
              >
                <option value="">Product default</option>
                {/*
                  * `ICON_NAMES` is the SERVER's allowlist — the same constant
                  * `PUT /api/navigation` refuses anything outside, and the same one
                  * `workspace_sections` writes through. Offering a list this file
                  * owned would be a second source of truth for a safety boundary.
                  */}
                {ICON_NAMES.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>

      <div className="nav-icons__actions">
        <button
          type="button"
          className="primary-button"
          disabled={busy || pending.length === 0}
          onClick={() => void save()}
        >
          <Icon name="check" size={17} />
          {busy ? "Saving…" : "Save icons"}
        </button>
        {status ? <span className="nav-icons__status">{status}</span> : null}
        {failure ? (
          <span className="nav-icons__failure" role="alert">
            {failure}
          </span>
        ) : null}
      </div>
    </section>
  );
}

export default NavIconsPanel;
