"use client";

/**
 * Account → Notifications (§33) — the emails this person receives, one switch
 * per kind, stored against their account by `/api/account/notifications`.
 *
 * Two honesty rules shape it (owner decision Q1):
 *   · when this deployment does not deliver email, the page says so ABOVE the
 *     switches, in the server's own words, so nobody reads a switch as a
 *     promise that mail is flowing;
 *   · what a switch cannot stop is listed rather than implied — invitations,
 *     tests a person asks for, and the alerts that go to the operations inbox
 *     rather than to a person.
 */

import { useEffect, useState } from "react";
import { AccountCard, AccountError, AccountHeading, AccountLoading } from "./account-ui";

type Topic = { key: string; label: string; description: string; enabled: boolean };
type Delivery = { deliverable: boolean; mode: string; reason: string | null };

export function AccountNotificationsPanel({ onNotify }: { onNotify: (message: string) => void }) {
  const [topics, setTopics] = useState<Topic[] | null>(null);
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [noAccount, setNoAccount] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/account/notifications", { headers: { Accept: "application/json" } });
        const payload = (await response.json()) as { topics?: Topic[] | null; delivery?: Delivery; error?: string };
        if (!response.ok || !payload.delivery) throw new Error(payload.error || "Your notification settings could not be loaded.");
        setDelivery(payload.delivery);
        setTopics(payload.topics ?? []);
        setNoAccount(payload.topics === null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Your notification settings could not be loaded.");
      }
    })();
  }, []);

  const toggle = async (topic: Topic, enabled: boolean) => {
    setSaving(topic.key);
    setTopics((current) => current?.map((entry) => (entry.key === topic.key ? { ...entry, enabled } : entry)) ?? current);
    try {
      const response = await fetch("/api/account/notifications", {
        method: "PUT",
        headers: { "content-type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ topic: topic.key, enabled }),
      });
      const payload = (await response.json()) as { topics?: Topic[]; error?: string };
      if (!response.ok || !payload.topics) throw new Error(payload.error || "The change could not be saved.");
      setTopics(payload.topics);
      onNotify(`${topic.label}: ${enabled ? "on" : "off"}.`);
    } catch (caught) {
      /* Put the switch back where the server still has it. */
      setTopics((current) => current?.map((entry) => (entry.key === topic.key ? { ...entry, enabled: !enabled } : entry)) ?? current);
      onNotify(caught instanceof Error ? caught.message : "The change could not be saved.");
    } finally {
      setSaving(null);
    }
  };

  return (
    <>
      <AccountHeading
        eyebrow="Account"
        title="Notifications"
        lede="Choose which emails come to you. Each switch is yours alone and follows you into every workspace you belong to."
      />

      {error && <AccountError message={error} />}
      {!error && !delivery && <AccountLoading label="Reading your notification settings" />}

      {delivery && !delivery.deliverable && (
        <AccountCard tone="notice" title="Email is not being delivered here">
          <p className="account-note" role="status">
            {delivery.reason} Your choices are still saved, and apply as soon as email delivery is switched on.
          </p>
        </AccountCard>
      )}

      {delivery && noAccount && (
        <AccountCard tone="notice" title="No account to save to">
          <p className="account-note">
            You are signed in as an identity without an account record, so there is nowhere to keep a preference. Sign
            in with your own account to choose your emails.
          </p>
        </AccountCard>
      )}

      {delivery && topics && topics.length > 0 && (
        <AccountCard title="Emails you receive" description="Switched off, an email is not sent to you, and the notification log records why.">
          {topics.map((topic) => (
            <label className="setting-row" key={topic.key}>
              <span>
                <strong>{topic.label}</strong>
                <small>{topic.description}</small>
              </span>
              <input
                type="checkbox"
                checked={topic.enabled}
                disabled={saving === topic.key}
                aria-label={topic.label}
                onChange={(event) => void toggle(topic, event.target.checked)}
              />
              <i aria-hidden="true" />
            </label>
          ))}
        </AccountCard>
      )}

      {delivery && (
        <AccountCard title="Always sent">
          <p className="account-note">
            An invitation to a workspace and a test you send yourself are never held back. Alerts about new jobs, leads,
            contractor updates and the compliance digest go to the operations inbox rather than to a person, so they are
            not on this list. And the same email to the same address about the same thing is sent at most once every 10
            minutes, whatever the switches say.
          </p>
        </AccountCard>
      )}
    </>
  );
}
