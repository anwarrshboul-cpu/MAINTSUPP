"use client";

/**
 * Account → Developers → Webhooks (§35b). Add, test, pause, re-key and remove a
 * workspace's signed webhooks and Slack connections, and read what each
 * delivery did.
 *
 * Rendered only for `integrations.manage`. When this deployment cannot store a
 * credential (`MAINTSUPP_SECRETS_KEY` unset — owner decision Q2), the card says
 * so in the server's words and offers no form: an address typed into a box
 * that cannot be saved would be a promise. A new webhook's signing secret is
 * shown ONCE; the server keeps it only sealed.
 */

import { useEffect, useState, type FormEvent } from "react";
import { useCapability } from "../../../lib/client-capabilities";
import { formatShortDateTime } from "../../../lib/format-date";
import { AccountCard, AccountError, AccountStatus } from "./account-ui";

type Endpoint = {
  id: string;
  kind: "webhook" | "slack";
  name: string;
  urlHint: string;
  secretHint: string | null;
  events: string[];
  state: "on" | "paused" | "disabled";
  stateReason: string | null;
  lastOutcome: string | null;
  lastDeliveredAt: string | null;
};

type Delivery = {
  id: string;
  eventType: string;
  status: string;
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  createdAt: string;
};

type Payload = {
  configured: boolean;
  reason: string | null;
  endpoints: Endpoint[];
  events: Array<{ key: string; label: string }>;
  retryPolicy: string;
  signatureHeader: string;
};

/* The product's own formatter, so a time here reads like every other time in the portal. */
const stamp = (value: string | null) => (value ? formatShortDateTime(value) : "—");

export function AccountWebhooksCard({ onNotify }: { onNotify?: (message: string) => void }) {
  const allowed = useCapability("integrations.manage");
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [kind, setKind] = useState<"webhook" | "slack">("webhook");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["job.created", "job.status_changed"]);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [log, setLog] = useState<{ endpointId: string; rows: Delivery[] } | null>(null);
  const reload = () => setRevision((current) => current + 1);
  const notify = (message: string) => onNotify?.(message);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/integrations/webhooks", { headers: { Accept: "application/json" } });
        const payload = (await response.json()) as Payload & { error?: string };
        if (!response.ok) throw new Error(payload.error || "Webhooks could not be loaded.");
        if (!cancelled) {
          setData(payload);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Webhooks could not be loaded.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [allowed, revision]);

  if (!allowed) return null;

  const send = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(path, {
      method,
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(payload.error ?? "That could not be done."));
    return payload;
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const payload = await send("POST", "/api/integrations/webhooks", { kind, name, url, events });
      if (typeof payload.signingSecret === "string") setSecret({ name, value: payload.signingSecret });
      setName("");
      setUrl("");
      notify(`"${name}" added.`);
      reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "The webhook could not be added.");
    } finally {
      setBusy(false);
    }
  };

  const act = async (endpoint: Endpoint, action: "pause" | "resume" | "roll_secret") => {
    try {
      const payload = await send("PATCH", "/api/integrations/webhooks", { id: endpoint.id, action });
      if (typeof payload.signingSecret === "string") setSecret({ name: endpoint.name, value: payload.signingSecret });
      reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "That could not be done.");
    }
  };

  const test = async (endpoint: Endpoint) => {
    try {
      const payload = await send("POST", "/api/integrations/webhooks/test", { id: endpoint.id });
      notify(
        payload.outcome === "delivered"
          ? `Test delivered to ${endpoint.urlHint}.`
          : `Test not delivered: ${String(payload.error ?? `the receiver answered ${String(payload.responseStatus)}`)}`,
      );
      reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "The test could not be sent.");
    }
  };

  const remove = async (endpoint: Endpoint) => {
    if (!window.confirm(`Remove "${endpoint.name}"? Nothing more will be sent to it.`)) return;
    try {
      await send("DELETE", `/api/integrations/webhooks?id=${encodeURIComponent(endpoint.id)}`);
      notify(`"${endpoint.name}" removed.`);
      reload();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "It could not be removed.");
    }
  };

  const showLog = async (endpoint: Endpoint) => {
    try {
      const payload = await send("GET", `/api/integrations/webhooks/deliveries?endpointId=${encodeURIComponent(endpoint.id)}`);
      setLog({ endpointId: endpoint.id, rows: (payload.deliveries as Delivery[]) ?? [] });
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "The log could not be read.");
    }
  };

  const retry = async (delivery: Delivery, endpoint: Endpoint) => {
    try {
      const payload = await send("POST", "/api/integrations/webhooks/deliveries", { id: delivery.id });
      notify(payload.outcome === "delivered" ? "Delivered." : "Tried again; it has not been delivered yet.");
      await showLog(endpoint);
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "It could not be retried.");
    }
  };

  return (
    <AccountCard
      title="Manage webhooks"
      description="Send job.created and job.status_changed to another system — a signed HTTPS webhook (Zapier, Make, your own server) or a Slack channel."
    >
      {error && <AccountError message={error} />}

      {data && !data.configured && (
        <p className="account-note" role="status">
          Not available on this deployment. {data.reason} A webhook&rsquo;s address and signing secret are only ever stored
          encrypted, so nothing can be added until that key is set.
        </p>
      )}

      {secret && (
        <div className="account-token-once" role="status">
          <strong>Signing secret for &ldquo;{secret.name}&rdquo; — copy it now, it will not be shown again.</strong>
          <code>{secret.value}</code>
          <div className="account-form__actions">
            <button className="secondary-button" type="button" onClick={() => setSecret(null)}>
              I have stored it
            </button>
          </div>
        </div>
      )}

      {data?.configured && (
        <form className="account-form" onSubmit={(event) => void add(event)}>
          <div className="account-form__grid">
            <label className="account-field">
              <span>Kind</span>
              <select value={kind} onChange={(event) => setKind(event.target.value === "slack" ? "slack" : "webhook")}>
                <option value="webhook">Signed webhook</option>
                <option value="slack">Slack channel</option>
              </select>
            </label>
            <label className="account-field">
              <span>Name</span>
              <input required minLength={2} maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
            </label>
          </div>
          <label className="account-field">
            <span>{kind === "slack" ? "Slack incoming-webhook address" : "HTTPS address"}</span>
            <input
              required
              type="url"
              placeholder={kind === "slack" ? "https://hooks.slack.com/services/…" : "https://example.com/maintsupp"}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <fieldset className="account-field account-token-scopes">
            <legend>Send</legend>
            {data.events.map((option) => (
              <label key={option.key}>
                <input
                  type="checkbox"
                  checked={events.includes(option.key)}
                  onChange={(event) =>
                    setEvents((current) =>
                      event.target.checked ? [...current, option.key] : current.filter((key) => key !== option.key),
                    )
                  }
                />
                {option.label} <code>{option.key}</code>
              </label>
            ))}
          </fieldset>
          <div className="account-form__actions">
            <button className="primary-button" type="submit" disabled={busy || name.trim().length < 2 || !url || !events.length}>
              {busy ? "Adding…" : "Add"}
            </button>
          </div>
        </form>
      )}

      {data && data.endpoints.length > 0 && (
        <div className="account-table-wrap">
          <table className="account-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Sends to</th>
                <th>Events</th>
                <th>State</th>
                <th>Last delivered</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {data.endpoints.map((endpoint) => (
                <tr key={endpoint.id}>
                  <td>
                    {endpoint.name}
                    <small>{endpoint.kind === "slack" ? "Slack" : `Signed · secret ${endpoint.secretHint ?? "—"}`}</small>
                  </td>
                  <td>
                    <code>{endpoint.urlHint}</code>
                  </td>
                  <td>{endpoint.events.join(", ")}</td>
                  <td>
                    <AccountStatus ok={endpoint.state === "on"} okLabel="On" offLabel={endpoint.state === "paused" ? "Paused" : "Switched off"} />
                    {endpoint.stateReason && <small>{endpoint.stateReason}</small>}
                  </td>
                  <td>{stamp(endpoint.lastDeliveredAt)}</td>
                  <td className="account-webhook-actions">
                    <button className="secondary-button" type="button" onClick={() => void showLog(endpoint)}>
                      Deliveries
                    </button>
                    {endpoint.state === "on" && (
                      <button className="secondary-button" type="button" onClick={() => void test(endpoint)}>
                        Test
                      </button>
                    )}
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void act(endpoint, endpoint.state === "on" ? "pause" : "resume")}
                    >
                      {endpoint.state === "on" ? "Pause" : "Resume"}
                    </button>
                    {endpoint.kind === "webhook" && data.configured && (
                      <button className="secondary-button" type="button" onClick={() => void act(endpoint, "roll_secret")}>
                        New secret
                      </button>
                    )}
                    <button className="secondary-button" type="button" onClick={() => void remove(endpoint)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {log && data && (
        <div className="account-table-wrap">
          <table className="account-table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Answer</th>
                <th>Queued</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {log.rows.length === 0 && (
                <tr>
                  <td colSpan={6}>Nothing has been sent to this endpoint yet.</td>
                </tr>
              )}
              {log.rows.map((delivery) => (
                <tr key={delivery.id}>
                  <td>
                    <code>{delivery.eventType}</code>
                  </td>
                  <td>{delivery.status}</td>
                  <td>{delivery.attempts}</td>
                  <td>{delivery.error ?? (delivery.responseStatus ? `HTTP ${delivery.responseStatus}` : "—")}</td>
                  <td>{stamp(delivery.createdAt)}</td>
                  <td>
                    {delivery.status !== "delivered" && delivery.status !== "delivering" && (
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => {
                          const endpoint = data.endpoints.find((item) => item.id === log.endpointId);
                          if (endpoint) void retry(delivery, endpoint);
                        }}
                      >
                        Retry
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && (
        <p className="account-note">
          {data.retryPolicy} Each request carries <code>{data.signatureHeader}</code> and a{" "}
          <code>Maintsupp-Event-Id</code> to de-duplicate on.
        </p>
      )}
    </AccountCard>
  );
}
