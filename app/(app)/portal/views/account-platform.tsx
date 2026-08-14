"use client";

/**
 * Developers and Integrations — monday's "Developers" and "App marketplace".
 *
 * Both read `/api/account/platform`, which answers from the Worker's own
 * runtime: a connector is "configured" only when its binding or key is actually
 * present. That is why these screens can be complete without listing a single
 * app that does not exist — the absent ones are shown as absent, with the
 * reason, rather than omitted or promised.
 */

import { useEffect, useState } from "react";
import {
  AccountCard,
  AccountEmpty,
  AccountError,
  AccountHeading,
  AccountLoading,
  AccountStats,
  AccountStatus,
} from "./account-ui";

type PlatformPayload = {
  developers: {
    credentials: Array<{
      key: string;
      name: string;
      available: boolean;
      summary: string;
      stats?: Array<{ label: string; value: number }>;
      managedAt?: string;
      endpoint?: string;
    }>;
    webhooks: {
      outbound: { available: boolean; reason: string };
      inbound: { available: boolean; reason: string };
    };
    publicEndpoints: Array<{
      method: string;
      path: string;
      description: string;
    }>;
    notificationDelivery: Array<{
      channel: string;
      status: string;
      count: number;
    }>;
  };
  integrations: Array<{
    key: string;
    name: string;
    category: string;
    configured: boolean;
    detail: string;
    action?: { label: string; href: string };
  }>;
};

function usePlatform() {
  const [data, setData] = useState<PlatformPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/account/platform", {
          headers: { Accept: "application/json" },
        });
        const payload = (await response.json()) as {
          platform?: PlatformPayload;
          error?: string;
        };
        if (!response.ok || !payload.platform) {
          throw new Error(payload.error || "The platform status is unavailable.");
        }
        setData(payload.platform);
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "The platform status is unavailable.",
        );
      }
    })();
  }, []);

  return { data, error };
}

export function AccountDevelopersPanel() {
  const { data, error } = usePlatform();

  return (
    <>
      <AccountHeading
        eyebrow="Account"
        title="Developers"
        lede="Credentials, webhooks and the endpoints this workspace exposes. Everything below is read from the running Worker."
      />

      {error && <AccountError message={error} />}
      {!data && !error && <AccountLoading label="Reading the runtime" />}

      {data?.developers.credentials.map((credential) => (
        <AccountCard
          key={credential.key}
          title={credential.name}
          description={credential.summary}
          aside={<AccountStatus ok={credential.available} okLabel="Available" offLabel="Not implemented" />}
        >
          {credential.stats && <AccountStats items={credential.stats} />}
          {(credential.managedAt || credential.endpoint) && (
            <dl className="account-definitions">
              {credential.managedAt && (
                <div>
                  <dt>Issued from</dt>
                  <dd>{credential.managedAt}</dd>
                </div>
              )}
              {credential.endpoint && (
                <div>
                  <dt>Endpoint</dt>
                  <dd>
                    <code>{credential.endpoint}</code>
                  </dd>
                </div>
              )}
            </dl>
          )}
        </AccountCard>
      ))}

      {data && (
        <AccountCard
          title="Webhooks"
          description="monday lists subscriptions here. This product has none in either direction, and the reason for each is worth stating rather than leaving as a blank list."
          tone="notice"
        >
          <dl className="account-definitions">
            <div>
              <dt>
                Outbound{" "}
                <AccountStatus
                  ok={data.developers.webhooks.outbound.available}
                  okLabel="Available"
                  offLabel="None"
                />
              </dt>
              <dd>{data.developers.webhooks.outbound.reason}</dd>
            </div>
            <div>
              <dt>
                Inbound{" "}
                <AccountStatus
                  ok={data.developers.webhooks.inbound.available}
                  okLabel="Available"
                  offLabel="None"
                />
              </dt>
              <dd>{data.developers.webhooks.inbound.reason}</dd>
            </div>
          </dl>
        </AccountCard>
      )}

      {data && (
        <AccountCard
          title="Externally reachable endpoints"
          description="The only two routes that answer without a workspace session."
        >
          <div className="account-table-wrap">
            <table className="account-table">
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Path</th>
                  <th>Authentication</th>
                </tr>
              </thead>
              <tbody>
                {data.developers.publicEndpoints.map((endpoint) => (
                  <tr key={endpoint.path}>
                    <td>
                      <code>{endpoint.method}</code>
                    </td>
                    <td>
                      <code>{endpoint.path}</code>
                    </td>
                    <td>{endpoint.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AccountCard>
      )}

      {data && (
        <AccountCard
          title="Outbound delivery"
          description="Every notification this workspace has attempted, by channel and outcome, from notification_log."
        >
          {data.developers.notificationDelivery.length === 0 ? (
            <AccountEmpty icon="bell" title="Nothing has been sent">
              No notification has been attempted for this workspace yet.
            </AccountEmpty>
          ) : (
            <div className="account-table-wrap">
              <table className="account-table">
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th>Outcome</th>
                    <th>Count</th>
                  </tr>
                </thead>
                <tbody>
                  {data.developers.notificationDelivery.map((row) => (
                    <tr key={`${row.channel}-${row.status}`}>
                      <td>{row.channel}</td>
                      <td>{row.status}</td>
                      <td>{row.count.toLocaleString("en-GB")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AccountCard>
      )}
    </>
  );
}

export function AccountIntegrationsPanel() {
  const { data, error } = usePlatform();
  const categories = data
    ? [...new Set(data.integrations.map((entry) => entry.category))]
    : [];

  return (
    <>
      <AccountHeading
        eyebrow="Explore"
        title="Integrations"
        lede="monday's App marketplace slot. There is no marketplace to browse — this is what MAINTSUPP is genuinely plugged into, and whether each connection is live right now."
      />

      {error && <AccountError message={error} />}
      {!data && !error && <AccountLoading label="Checking connections" />}

      {categories.map((category) => (
        <AccountCard key={category} title={category}>
          <div className="account-list">
            {data?.integrations
              .filter((entry) => entry.category === category)
              .map((entry) => (
                <div key={entry.key} className="account-list__row">
                  <div>
                    <strong>{entry.name}</strong>
                    <span>{entry.detail}</span>
                  </div>
                  <div className="account-list__actions">
                    <AccountStatus ok={entry.configured} />
                    {entry.action && (
                      <a className="secondary-button" href={entry.action.href}>
                        {entry.action.label}
                      </a>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </AccountCard>
      ))}

      {data && (
        <AccountCard tone="notice" title="Adding a connector">
          <p className="account-note">
            There is no plug-in system: a connector is code in this repository plus
            a binding or a key on the Worker. Nothing can be installed from this
            screen, which is why there is no install button on it.
          </p>
        </AccountCard>
      )}
    </>
  );
}
