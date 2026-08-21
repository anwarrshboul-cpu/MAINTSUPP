"use client";

/**
 * The pieces the three admin screens share.
 *
 * Chiefly one idea: an admin screen has four states, not two. Loading, loaded,
 * *refused*, and unavailable. The refused state matters because these screens
 * are reachable by anybody who can guess the URL — the server answers 403 and
 * the screen has to say so plainly rather than render an empty table that looks
 * like "your workspace has no users". An empty table and a forbidden table mean
 * completely different things to whoever is looking at it.
 *
 * Nothing here invents a row. Every list renders exactly what the API returned,
 * and an empty response produces an empty state that says the workspace is
 * empty.
 */

import { useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "../../../components";
import { formatShortDate } from "../../../lib/format-date";
import { chipStyle } from "../chip-ink";
import "./admin-console.css";

export type Capability = string;

export type AdminActor = {
  email: string;
  role: string;
  roleLabel: string;
  capabilities: Record<Capability, boolean>;
};

type Loaded<T> = {
  data: T | null;
  loading: boolean;
  /** The server refused on a capability. Carries its message verbatim. */
  denied: string | null;
  /** Anything else that went wrong. */
  error: string | null;
};

/**
 * Fetches an admin endpoint and separates "you may not" from "it broke".
 *
 * The 403 body from `permissions.ts` always carries `denied: true`, so the two
 * are distinguishable without matching on prose.
 */
export function useAdminResource<T>(url: string) {
  const [state, setState] = useState<Loaded<T>>({
    data: null,
    loading: true,
    denied: null,
    error: null,
  });

  const load = useCallback(async () => {
    setState((current) => ({ ...current, loading: true }));
    try {
      const response = await fetch(url, { headers: { accept: "application/json" } });
      const payload = (await response.json().catch(() => null)) as
        | (T & { error?: string; denied?: boolean })
        | null;

      if (response.status === 403) {
        setState({
          data: null,
          loading: false,
          denied: payload?.error ?? "You do not have permission to open this screen.",
          error: null,
        });
        return;
      }
      if (!response.ok) {
        setState({
          data: null,
          loading: false,
          denied: null,
          error: payload?.error ?? "That could not be loaded.",
        });
        return;
      }
      setState({ data: payload as T, loading: false, denied: null, error: null });
    } catch {
      setState({
        data: null,
        loading: false,
        denied: null,
        error: "The workspace could not be reached.",
      });
    }
  }, [url]);

  /* eslint-disable react-hooks/set-state-in-effect -- `load` is async, so its
     setState lands after an await rather than synchronously in the effect body;
     the rule cannot see through the promise. Fetching the actor's permissions
     from the server is exactly the external-system synchronisation effects are
     for, and it must not be done during render: the answer decides whether the
     screen renders at all. */
  useEffect(() => {
    void load();
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return { ...state, reload: load, setState };
}

/** Sends a change and returns the server's message either way. */
export async function adminWrite(
  url: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body?: unknown,
): Promise<{
  ok: boolean;
  message: string;
  status: number;
  /**
   * The server's reply, for the few writes that answer with something.
   *
   * Most do not — "Saved." is the whole result. An invitation is the exception:
   * the link is minted once and returned once, because only its hash is
   * stored, and this helper used to discard it. That single dropped field was
   * the whole reason invitations did not work: the admin got "Saved.", the
   * link went in the bin, and nobody could be told how to accept.
   */
  payload?: Record<string, unknown> | null;
}> {
  try {
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      ok?: boolean;
    } | null;
    if (!response.ok) {
      return {
        ok: false,
        // The server's own words. A guard-rail explains itself far better than
        // a generic "that didn't work" ever could.
        message: payload?.error ?? "That change was refused.",
        status: response.status,
      };
    }
    return { ok: true, message: "Saved.", status: response.status, payload };
  } catch {
    return { ok: false, message: "The workspace could not be reached.", status: 0 };
  }
}

export function AdminNotice({
  tone,
  icon,
  title,
  children,
}: {
  tone: "denied" | "error" | "empty" | "info";
  icon: IconName;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={`admin-notice admin-notice--${tone}`} role={tone === "error" ? "alert" : undefined}>
      <span className="admin-notice__icon">
        <Icon name={icon} size={22} />
      </span>
      <div>
        <strong>{title}</strong>
        {children ? <p>{children}</p> : null}
      </div>
    </div>
  );
}

export function AdminLoading({ label }: { label: string }) {
  return (
    <div className="admin-notice admin-notice--info" aria-live="polite">
      <span className="admin-notice__icon">
        <Icon name="clock" size={22} />
      </span>
      <div>
        <strong>{label}</strong>
      </div>
    </div>
  );
}

/** A stable colour per person, so the same face keeps the same badge. */
const AVATAR_COLOURS = [
  "#12b4a8",
  "#f08b23",
  "#5c82af",
  "#38be7b",
  "#b46bd4",
  "#da4646",
  "#eeab25",
];

export function avatarColour(seed: string, preferred?: string | null) {
  if (preferred && /^#[0-9a-fA-F]{6}$/.test(preferred)) return preferred;
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 100000;
  }
  return AVATAR_COLOURS[hash % AVATAR_COLOURS.length];
}

export function initials(name: string | null, email: string) {
  const source = name ?? email.split("@")[0];
  /* Only letters and digits become an initial. Several seeded accounts are
     named like "Super Admin (testing)", and splitting on whitespace alone made
     the badge read "S(" — a bracket is not an initial. */
  const parts = source.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function Avatar({
  name,
  email,
  colour,
  muted,
}: {
  name: string | null;
  email: string;
  colour?: string | null;
  muted?: boolean;
}) {
  return (
    <span
      className={`admin-avatar${muted ? " admin-avatar--muted" : ""}`}
      /*
       * The initials are text, and the ground is a seeded colour rather than a
       * design choice, so the label has to be measured against whichever
       * colour the hash picked. It was a fixed white in the stylesheet, which
       * is 4.25:1 on the amber and 3.4:1 on the purple.
       */
      style={chipStyle(avatarColour(email, colour))}
      aria-hidden="true"
    >
      {initials(name, email)}
    </span>
  );
}

/**
 * A timestamp as a person would say it.
 *
 * Returns "Never" for null rather than a dash or today's date — a workspace
 * that has never been touched should say so.
 */
export function relativeTime(value: string | null | undefined) {
  if (!value) return "Never";
  const parsed = Date.parse(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  if (!Number.isFinite(parsed)) return value;
  const minutes = Math.round((Date.now() - parsed) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} day${days === 1 ? "" : "s"} ago`;
  // Past a month the relative form stops helping and the date is the better
  // answer — through the shared formatter, so it reads as it does everywhere.
  return formatShortDate(new Date(parsed));
}

/** Small dismissable strip for the result of the last write. */
export function AdminFlash({
  flash,
  onDismiss,
}: {
  flash: { ok: boolean; message: string } | null;
  onDismiss: () => void;
}) {
  if (!flash) return null;
  return (
    <div
      className={`admin-flash${flash.ok ? " admin-flash--ok" : " admin-flash--refused"}`}
      role="status"
      aria-live="polite"
    >
      <Icon name={flash.ok ? "check" : "shield"} size={17} />
      <span>{flash.message}</span>
      <button type="button" className="admin-flash__close" onClick={onDismiss} aria-label="Dismiss">
        <Icon name="close" size={15} />
      </button>
    </div>
  );
}
