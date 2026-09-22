"use client";

/**
 * Settings → Workspace logo — the workspace's own mark on its own portal.
 *
 * WHAT IT CHANGES, said on the card rather than discovered: the mark beside the
 * workspace's name in the sidebar and the account menu, and the cover of the
 * reports this portal issues to the workspace. What it never changes is
 * MAINTSUPP's own brand — the MAINTSUPP mark at the top of the sidebar, the
 * website, and the report titles stay as they are.
 *
 * A WORKSPACE DECISION, like the brand colours beside it: it needs
 * `settings.edit`, it is written to the audit log, and everybody in the
 * workspace sees it. A member without the capability sees the current logo and
 * is told why there is nothing to press.
 *
 * ONE WAY IN. The file goes through `uploadWorkspaceLogo()` in
 * `app/lib/client-upload.ts`, which owns the ~1 MiB form ceiling and sends a
 * larger logo in parts on the #78 direct-upload path; the stages it reports are
 * the same words every other upload in the product uses.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "../../../components";
import {
  describeUploadStage,
  uploadWorkspaceLogo,
  type UploadStage,
  type WorkspaceLogo,
} from "../../../lib/client-upload";
import { WORKSPACE_LOGO_EVENT, WorkspaceMark } from "../workspace-mark";
import "./workspace-logo-panel.css";

type LogoState = {
  canEdit: boolean;
  logo: WorkspaceLogo | null;
  limits: { accept: string; maxBytes: number; minEdge: number; maxEdge: number };
  error?: string;
};

function sizeLabel(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function announce() {
  window.dispatchEvent(new Event(WORKSPACE_LOGO_EVENT));
}

export function WorkspaceLogoPanel() {
  const [state, setState] = useState<LogoState | null>(null);
  const [stage, setStage] = useState<UploadStage | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/branding/logo", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as LogoState | null;
      if (!response.ok || !body) {
        setFailure(body?.error ?? "Could not load the workspace logo.");
        return;
      }
      setState(body);
      setFailure(null);
    } catch {
      setFailure("Could not load the workspace logo.");
    }
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- `load` awaits the fetch
     before it touches state, exactly as `brand-colours-panel.tsx` does beside
     it; reading the stored logo on mount is what an effect is for. */
  useEffect(() => {
    void load();
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!state) {
    return failure ? (
      <section className="panel settings-card">
        <div className="settings-card__heading">
          <span>
            <Icon name="image" size={19} />
          </span>
          <div>
            <h2>Workspace logo</h2>
            <p>{failure}</p>
          </div>
        </div>
      </section>
    ) : null;
  }

  const { canEdit, logo, limits } = state;

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setFailure(null);
    setStatus(null);
    try {
      const saved = await uploadWorkspaceLogo(file, { onStage: setStage });
      setState((current) => (current ? { ...current, logo: saved } : current));
      setStatus(logo ? "Logo replaced." : "Logo added.");
      announce();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The logo could not be uploaded.");
    } finally {
      setBusy(false);
      setStage(null);
      if (input.current) input.current.value = "";
    }
  };

  const remove = async () => {
    if (!window.confirm("Remove the workspace logo? The portal shows the default mark again.")) return;
    setBusy(true);
    setFailure(null);
    setStatus(null);
    try {
      const response = await fetch("/api/branding/logo", { method: "DELETE" });
      const body = (await response.json().catch(() => null)) as LogoState | null;
      if (!response.ok) {
        setFailure(body?.error ?? "Could not remove the logo.");
        return;
      }
      setState((current) => (current ? { ...current, logo: null } : current));
      setStatus("Logo removed. The default mark is shown again.");
      announce();
    } catch {
      setFailure("Could not remove the logo.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel settings-card">
      <div className="settings-card__heading">
        <span>
          <Icon name="image" size={19} />
        </span>
        <div>
          <h2>Workspace logo</h2>
          <p>
            {canEdit
              ? "Shown beside this workspace’s name in the sidebar and the account menu, and on the cover of the reports it is issued."
              : "Shown beside this workspace’s name and on its reports. You do not have permission to change it."}
          </p>
          <p className="workspace-logo__scope">
            It never replaces the MAINTSUPP mark. PNG, JPEG or WebP, up to {sizeLabel(limits.maxBytes)},
            between {limits.minEdge} and {limits.maxEdge} pixels on each side. A wide logo on a
            transparent or white background reads best.
          </p>
        </div>
      </div>

      <div className="workspace-logo">
        <div className="workspace-logo__preview">
          <WorkspaceMark
            logoUrl={logo?.url}
            label="Current workspace logo"
            className="workspace-logo__image"
            fallback={
              <span className="workspace-logo__fallback">
                <Icon name="building" size={24} />
                <small>Default mark</small>
              </span>
            }
          />
        </div>
        <div className="workspace-logo__body">
          {logo ? (
            <>
              <strong>{logo.originalName}</strong>
              <small>
                {logo.width} × {logo.height} px · {sizeLabel(logo.byteSize)}
              </small>
            </>
          ) : (
            <>
              <strong>No logo</strong>
              <small>The portal shows the default mark.</small>
            </>
          )}
        </div>
      </div>

      {canEdit ? (
        <div className="workspace-logo__actions">
          <input
            ref={input}
            className="workspace-logo__input"
            type="file"
            accept={limits.accept}
            /* Reached through the button below, which is the one tab stop;
               the input itself stays out of the tab order. */
            tabIndex={-1}
            aria-label={logo ? "Replace the workspace logo" : "Upload a workspace logo"}
            disabled={busy}
            onChange={(event) => void choose(event.target.files?.[0])}
          />
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            <Icon name="upload" size={17} />
            {logo ? "Replace logo" : "Upload logo"}
          </button>
          {logo ? (
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void remove()}>
              <Icon name="trash" size={17} />
              Remove logo
            </button>
          ) : null}
          {stage ? (
            <span className="workspace-logo__status" role="status">
              {describeUploadStage(stage)}
            </span>
          ) : status ? (
            <span className="workspace-logo__status" role="status">
              {status}
            </span>
          ) : null}
          {failure ? (
            <span className="workspace-logo__failure" role="alert">
              {failure}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export default WorkspaceLogoPanel;
