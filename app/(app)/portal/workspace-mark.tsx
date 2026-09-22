"use client";

/**
 * THE WORKSPACE'S OWN MARK — its logo where it has one, the default otherwise.
 *
 * Drawn where the portal already names the workspace: the sidebar's workspace
 * card, the account menu's header and the cover of a report. Never where
 * MAINTSUPP names itself — the MAINTSUPP mark at the top of the sidebar, the
 * marketing site and the report titles are the product's brand, not the
 * customer's, and nothing here replaces them.
 *
 * DECORATIVE BY DEFAULT (`alt=""`): every place it is drawn already prints the
 * workspace's name beside it, so a screen reader would otherwise say the name
 * twice. A caller that shows the logo on its own passes `label`.
 *
 * A logo that fails to load falls back to the default for that URL, rather than
 * leaving the browser's broken-image glyph in the chrome — the same rule the
 * document register follows for a file whose bytes are missing.
 */

import { useEffect, useState, type ReactNode } from "react";
import "./workspace-mark.css";

/**
 * Fired by the logo panel after a change, so the chrome can re-read the
 * workspace context and draw the new mark without a reload.
 */
export const WORKSPACE_LOGO_EVENT = "maintsupp:workspace-logo";

type LogoAddresses = { url: string; printUrl: string | null } | null;

/* One read per page, shared by every preview on it, dropped on a change. */
let pendingLogo: Promise<LogoAddresses> | null = null;

function readLogoAddresses(): Promise<LogoAddresses> {
  if (!pendingLogo) {
    pendingLogo = fetch("/api/branding/logo", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        const body = (await response.json().catch(() => null)) as { logo?: LogoAddresses } | null;
        return body?.logo ?? null;
      })
      .catch(() => {
        pendingLogo = null;
        return null;
      });
  }
  return pendingLogo;
}

/**
 * The workspace logo's addresses, for a surface that is not handed the
 * workspace context — the report preview. `printUrl` is the JPEG the exported
 * PDF and Word file embed, so the preview shows exactly what the download will.
 */
export function useWorkspaceLogo(): LogoAddresses {
  const [logo, setLogo] = useState<LogoAddresses>(null);
  useEffect(() => {
    let live = true;
    const load = () => {
      void readLogoAddresses().then((value) => {
        if (live) setLogo(value);
      });
    };
    const changed = () => {
      pendingLogo = null;
      load();
    };
    load();
    window.addEventListener(WORKSPACE_LOGO_EVENT, changed);
    return () => {
      live = false;
      window.removeEventListener(WORKSPACE_LOGO_EVENT, changed);
    };
  }, []);
  return logo;
}

export function WorkspaceMark({
  logoUrl,
  fallback,
  className,
  label,
}: {
  logoUrl: string | null | undefined;
  fallback: ReactNode;
  className?: string;
  label?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!logoUrl || failedUrl === logoUrl) return <>{fallback}</>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={`workspace-mark${className ? ` ${className}` : ""}`}
      src={logoUrl}
      alt={label ?? ""}
      decoding="async"
      onError={() => setFailedUrl(logoUrl)}
    />
  );
}
