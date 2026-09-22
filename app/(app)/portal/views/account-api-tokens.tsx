"use client";

/**
 * Account → Developers → API tokens (§35). Issue, list and revoke the read-only
 * tokens another system uses to read this workspace through `/api/v1`.
 *
 * Rendered only for someone who holds `integrations.manage` (the server refuses
 * everyone else anyway). A new token is shown ONCE, in a box with a copy
 * button, and is gone from this screen the moment it is dismissed — the server
 * keeps only its hash and could not show it again if asked.
 */

import { useEffect, useState, type FormEvent } from "react";
import { useCapability } from "../../../lib/client-capabilities";
import { AccountCard, AccountError, AccountStatus } from "./account-ui";

type TokenRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdByEmail: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  state: "live" | "expired" | "revoked";
};

type TokensPayload = {
  tokens: TokenRow[];
  scopes: Array<{ key: string; label: string }>;
  lifetimes: number[];
};

const day = (value: string | null) => (value ? value.slice(0, 10) : "—");

export function AccountApiTokensCard({ onNotify }: { onNotify?: (message: string) => void }) {
  const allowed = useCapability("integrations.manage");
  const [data, setData] = useState<TokensPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["jobs:read"]);
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ token: string; name: string } | null>(null);
  /* Bumped after an issue or a revoke; the effect below re-reads the list. */
  const [revision, setRevision] = useState(0);
  const load = () => setRevision((current) => current + 1);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/integrations/tokens", { headers: { Accept: "application/json" } });
        const payload = (await response.json()) as TokensPayload & { error?: string };
        if (!response.ok) throw new Error(payload.error || "API tokens could not be loaded.");
        if (!cancelled) {
          setData(payload);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "API tokens could not be loaded.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [allowed, revision]);

  if (!allowed) return null;

  const notify = (message: string) => onNotify?.(message);

  const issue = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await fetch("/api/integrations/tokens", {
        method: "POST",
        headers: { "content-type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ name, scopes, days }),
      });
      const payload = (await response.json()) as { token?: string; error?: string };
      if (!response.ok || !payload.token) throw new Error(payload.error || "The token could not be issued.");
      setIssued({ token: payload.token, name });
      setName("");
      load();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "The token could not be issued.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (row: TokenRow) => {
    if (!window.confirm(`Revoke "${row.name}"? Anything using it stops working at once.`)) return;
    const response = await fetch(`/api/integrations/tokens?id=${encodeURIComponent(row.id)}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    notify(response.ok ? `"${row.name}" is revoked.` : payload.error || "The token could not be revoked.");
    load();
  };

  const copy = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.token);
      notify("Token copied.");
    } catch {
      notify("Copy it from the box by hand — the browser refused the clipboard.");
    }
  };

  return (
    <AccountCard
      title="Manage API tokens"
      description="Read-only access to this workspace's jobs and sites for another system, through /api/v1. A token never reads more than you can, and stops the moment you lose that access."
    >
      {error && <AccountError message={error} />}

      {issued && (
        <div className="account-token-once" role="status">
          <strong>Copy &ldquo;{issued.name}&rdquo; now — it will not be shown again.</strong>
          <code>{issued.token}</code>
          <div className="account-form__actions">
            <button className="primary-button" type="button" onClick={() => void copy()}>
              Copy token
            </button>
            <button className="secondary-button" type="button" onClick={() => setIssued(null)}>
              I have stored it
            </button>
          </div>
        </div>
      )}

      {data && (
        <form className="account-form" onSubmit={(event) => void issue(event)}>
          <div className="account-form__grid">
            <label className="account-field">
              <span>Name</span>
              <input
                required
                minLength={2}
                maxLength={80}
                placeholder="e.g. Finance reporting"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="account-field">
              <span>Expires after</span>
              <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
                {data.lifetimes.map((value) => (
                  <option key={value} value={value}>
                    {value} days
                  </option>
                ))}
              </select>
            </label>
          </div>
          <fieldset className="account-field account-token-scopes">
            <legend>May read</legend>
            {data.scopes.map((scope) => (
              <label key={scope.key}>
                <input
                  type="checkbox"
                  checked={scopes.includes(scope.key)}
                  onChange={(event) =>
                    setScopes((current) =>
                      event.target.checked ? [...current, scope.key] : current.filter((key) => key !== scope.key),
                    )
                  }
                />{" "}
                {scope.label} <code>{scope.key}</code>
              </label>
            ))}
          </fieldset>
          <div className="account-form__actions">
            <button className="primary-button" type="submit" disabled={busy || name.trim().length < 2 || !scopes.length}>
              {busy ? "Issuing…" : "Issue token"}
            </button>
          </div>
        </form>
      )}

      {data && data.tokens.length > 0 && (
        <div className="account-table-wrap">
          <table className="account-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Token</th>
                <th>Reads</th>
                <th>Issued by</th>
                <th>Expires</th>
                <th>Last used</th>
                <th>State</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.tokens.map((row) => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td>
                    <code>{row.prefix}_…</code>
                  </td>
                  <td>{row.scopes.join(", ") || "—"}</td>
                  <td>{row.createdByEmail}</td>
                  <td>{day(row.expiresAt)}</td>
                  <td>{day(row.lastUsedAt)}</td>
                  <td>
                    <AccountStatus
                      ok={row.state === "live"}
                      okLabel="Live"
                      offLabel={row.state === "revoked" ? "Revoked" : "Expired"}
                    />
                  </td>
                  <td>
                    {row.state === "live" && (
                      <button className="secondary-button" type="button" onClick={() => void revoke(row)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.tokens.length === 0 && <p className="account-note">No tokens have been issued in this workspace.</p>}
    </AccountCard>
  );
}
