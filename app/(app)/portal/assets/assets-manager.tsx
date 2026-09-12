"use client";

/**
 * THE ASSETS SECTION — one screen, three views, two mount points.
 *
 * ── TWO MOUNT POINTS, ONE IMPLEMENTATION ───────────────────────────────────
 *
 * The portfolio page (`/dashboard/assets`) and a site's own Assets tab are the
 * SAME component with `siteId` set. The brief's rule — "do not duplicate two
 * different implementations; the site view simply scopes the same Assets system
 * to one site" — is enforced by there being nothing to duplicate: the site view
 * passes a prop, the server narrows the rows, and the list hides the Site
 * column because a column whose every cell reads "Kingsway Central" carries no
 * information.
 *
 * ── THE URL ────────────────────────────────────────────────────────────────
 *
 * `?asset=` addresses the detail view, exactly as `?site=` addresses a site
 * profile and for the same reasons written down there: the three views replace
 * each other out of `useState`, so without it a reload went back to the list,
 * "the Bullring's LED transformer" could not be sent to anybody, and Back left
 * the screen entirely.
 *
 * A query parameter rather than a path segment because the portal is one
 * client-routed page and the PATH is how it picks its section —
 * `portal-app.tsx` reads `location.pathname` on `popstate` and would read
 * `/dashboard/assets/unit-abc` as a section it does not have.
 *
 * `?site=` is read too, but only as an incoming filter: the Overview links here
 * for one store. It is deliberately a single site and not a list, matching the
 * control this screen actually has.
 *
 * THE EDITOR IS NOT ADDRESSED. A half-typed form is not a place, and a URL that
 * reopened one would restore the shell of an edit without any of the typing.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLoader } from "../sites/use-loader";
import { api } from "../sites/site-types";
import { useCapability } from "../../../lib/client-capabilities";
import { parseSpecs } from "../../../lib/asset-model";
import { AssetsList } from "./assets-list";
import { AssetDetail } from "./asset-detail";
import { AssetForm } from "./asset-form";
import {
  emptyAssetForm,
  toAssetForm,
  type AssetDetailPayload,
  type AssetForm as AssetFormValues,
  type AssetListPayload,
} from "./asset-types";

const ASSET_PARAM = "asset";

type Mode =
  | { kind: "list" }
  | { kind: "detail"; assetId: string }
  | { kind: "form"; assetId: string | null; initial: AssetFormValues };

/** The current URL with the asset parameter set, or cleared when null. */
function assetHref(assetId: string | null) {
  const params = new URLSearchParams(window.location.search);
  if (assetId) params.set(ASSET_PARAM, assetId);
  else params.delete(ASSET_PARAM);
  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ""}`;
}

export function AssetsManager({
  siteId = null,
  embedded = false,
  onNotify,
}: {
  /**
   * The one site this register is confined to, or null for the portfolio.
   *
   * Passed by a site's Assets tab. It is a REQUEST, not a permission: the
   * server intersects it with the caller's own site scope, so naming a store
   * somebody may not see returns nothing rather than widening anything.
   */
  siteId?: string | null;
  /**
   * Drawn inside another screen's page, rather than being the page.
   *
   * Set by a site's Assets tab. It suppresses this screen's own page header —
   * the site's `<h1>` is already above it — and drops the detail and editor
   * headings to `<h2>`, because a document with two level-one headings is an
   * axe failure and a screen reader's outline that lies about what the page is.
   */
  embedded?: boolean;
  onNotify: (message: string) => void;
}) {
  const [mode, setMode] = useState<Mode>({ kind: "list" });

  /*
   * `useCapability` is three-valued: null means "still loading", and treating
   * that as a denial would flash a read-only screen at every editor on every
   * page load. Only an explicit `false` hides the controls — and the server
   * refuses regardless, so this is about not drawing a button that 403s.
   */
  const canEdit = useCapability("sites.edit") !== false;

  /* An incoming `?site=` narrows the portfolio to one store. A list is not one
     site, so anything carrying a separator is ignored rather than half-read. */
  const urlSite = useMemo(() => {
    if (typeof window === "undefined") return "";
    const wanted = new URLSearchParams(window.location.search).get("site") ?? "";
    return wanted.includes("|") ? "" : wanted.trim();
  }, []);

  const effectiveSiteId = siteId ?? (urlSite || null);

  const listUrl = effectiveSiteId
    ? `/api/assets?siteId=${encodeURIComponent(effectiveSiteId)}`
    : "/api/assets";

  const list = useLoader<AssetListPayload>(
    useCallback(() => api<AssetListPayload>(listUrl), [listUrl]),
    "The asset register could not be loaded.",
  );

  /*
   * The URL is read on mount and on every Back and Forward, and it is the only
   * thing that opens or closes the detail view.
   *
   * Deferred through a zero timer for the reason the Sites screen defers its
   * own: state written synchronously in an effect body cascades a render and
   * the lint rules here reject it. `popstate` needs no timer — it is already an
   * event rather than a render.
   */
  useEffect(() => {
    const sync = () => {
      const wanted = new URLSearchParams(window.location.search).get(ASSET_PARAM);
      setMode((current) => {
        if (wanted) {
          return current.kind === "detail" && current.assetId === wanted
            ? current
            : { kind: "detail", assetId: wanted };
        }
        /* Only the detail view is addressed, so only the detail view is closed
           by the parameter going away. An open editor is left alone. */
        return current.kind === "detail" ? { kind: "list" } : current;
      });
    };
    const timer = window.setTimeout(sync, 0);
    window.addEventListener("popstate", sync);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  const openAsset = useCallback((assetId: string) => {
    window.history.pushState(null, "", assetHref(assetId));
    setMode({ kind: "detail", assetId });
  }, []);

  const leaveAsset = useCallback((next: Mode) => {
    window.history.pushState(null, "", assetHref(null));
    setMode(next);
  }, []);

  if (mode.kind === "detail") {
    return (
      <AssetDetailLoader
        assetId={mode.assetId}
        canEdit={canEdit}
        embedded={embedded}
        onNotify={onNotify}
        onClose={() => leaveAsset({ kind: "list" })}
        onOpenAsset={openAsset}
        onEdit={(assetId, initial) => leaveAsset({ kind: "form", assetId, initial })}
        onArchived={() => {
          leaveAsset({ kind: "list" });
          list.reload();
        }}
      />
    );
  }

  if (mode.kind === "form") {
    return (
      <section className="section-stack">
        <header className="section-header">
          {/*
            An `<h1>` when this IS the page, for the reason the Sites editor
            carries one: these views REPLACE each other, so while the form is
            open the register's own heading is not rendered and the document
            would have no level-one heading at all — `page-has-heading-one`.
            Embedded inside a site it is an `<h2>`, because that page's `<h1>`
            is the site and there must only ever be one.
          */}
          {embedded ? (
            <h2>{mode.assetId ? "Edit asset" : "Add an asset"}</h2>
          ) : (
            <h1>{mode.assetId ? "Edit asset" : "Add an asset"}</h1>
          )}
        </header>
        <AssetForm
          assetId={mode.assetId}
          initial={mode.initial}
          categories={list.data?.categories ?? []}
          statuses={list.data?.statuses ?? []}
          kinds={list.data?.kinds ?? []}
          sites={list.data?.sites ?? []}
          suppliers={list.data?.suppliers ?? []}
          /*
           * EVERY asset the register holds, with its site, and the form narrows
           * them to whichever site is currently selected. Filtering here on the
           * site the form OPENED with meant that changing the site left a list
           * of candidates from the old one — offered, chosen, and then refused
           * by the server on save, which is a menu of dead ends.
           */
          parents={(list.data?.assets ?? []).map((row) => ({
            id: row.id,
            name: row.name,
            assetNumber: row.assetNumber,
            siteId: row.siteId,
          }))}
          onCancel={() => setMode({ kind: "list" })}
          onSaved={(message) => {
            onNotify(message);
            setMode({ kind: "list" });
            list.reload();
          }}
        />
      </section>
    );
  }

  return (
    <AssetsList
      data={list.data}
      error={list.error}
      loading={!list.data && !list.error}
      onRetry={list.reload}
      onOpenAsset={openAsset}
      onAddAsset={() =>
        setMode({
          kind: "form",
          assetId: null,
          /* Adding from inside a site pre-selects it. Making somebody choose
             the store they are already looking at is the friction the brief
             names outright. */
          initial: emptyAssetForm(effectiveSiteId ?? ""),
        })
      }
      fixedSiteId={effectiveSiteId}
    />
  );
}

/**
 * The detail view's own fetch.
 *
 * Separate from the list's because it is a different endpoint with a different
 * shape, and because opening an asset must not re-download the register. It
 * reloads on `assetId`, so following a parent or child link inside the detail
 * view fetches the new record without a trip through the list.
 */
function AssetDetailLoader({
  assetId,
  canEdit,
  embedded,
  onNotify,
  onClose,
  onOpenAsset,
  onEdit,
  onArchived,
}: {
  assetId: string;
  canEdit: boolean;
  embedded: boolean;
  onNotify: (message: string) => void;
  onClose: () => void;
  onOpenAsset: (assetId: string) => void;
  onEdit: (assetId: string, initial: AssetFormValues) => void;
  onArchived: () => void;
}) {
  const { data, error, setError, reload } = useLoader<AssetDetailPayload>(
    useCallback(
      () => api<AssetDetailPayload>(`/api/assets?id=${encodeURIComponent(assetId)}`),
      [assetId],
    ),
    "That asset could not be loaded.",
  );

  async function archive() {
    if (!data) return;
    if (
      !window.confirm(
        `Move "${data.asset.name}" to the recycle bin?\n\n` +
          "Its history, photographs and files are kept, and it can be restored for 30 days.\n" +
          "Anything recorded as part of it stays on the register.",
      )
    ) {
      return;
    }
    try {
      await api("/api/assets", { method: "DELETE", body: { id: data.asset.id } });
      onNotify(`${data.asset.name} moved to the recycle bin.`);
      onArchived();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The asset could not be removed.");
    }
  }

  if (error) {
    return (
      <section className="section-stack">
        <header className="section-header">
          {embedded ? <h2>Asset</h2> : <h1>Asset</h1>}
        </header>
        <p className="ops-error" role="alert">
          {error}
        </p>
        <div className="section-header__actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Back to assets
          </button>
          <button type="button" className="primary-button" onClick={reload}>
            Try again
          </button>
        </div>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="section-stack">
        <header className="section-header">
          {embedded ? <h2>Asset</h2> : <h1>Asset</h1>}
        </header>
        <p className="ops-empty">Loading…</p>
      </section>
    );
  }

  return (
    <AssetDetail
      data={data}
      canEdit={canEdit}
      embedded={embedded}
      onClose={onClose}
      onOpenAsset={onOpenAsset}
      onChanged={reload}
      onNotify={onNotify}
      onArchive={archive}
      onEdit={() => onEdit(data.asset.id, toAssetForm(data.asset, parseSpecs(data.asset.specs)))}
    />
  );
}
