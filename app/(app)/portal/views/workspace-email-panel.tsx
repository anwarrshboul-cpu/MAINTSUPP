"use client";

/**
 * Settings → Notifications (§33): what this workspace emails, and to whom.
 *
 * THIS CARD USED TO BE THREE SWITCHES THAT DID NOTHING. "Urgent maintenance
 * requests", "Compliance expiry alerts" and "Daily operations digest" were
 * saved into `workspace_settings.alerts` and read by nothing: every new job
 * alerted the operations inbox whatever the first said, the second promised a
 * 90/30/7 cadence no scheduler ran, and the digest did not exist. They are gone
 * rather than wired, and the reason is the first one: those alerts go to the
 * OPERATIONS inbox — the people who dispatch the work — and a switch in a
 * workspace's settings that could silence an urgent-job alert to them is not a
 * convenience to hand out without the owner deciding it. The stored `alerts`
 * values are left in place, untouched (the settings save spreads them through).
 *
 * What a person CAN choose — the emails addressed to them — lives in Account →
 * Notifications, where it is stored and honoured by `sendNotification`.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "../../../components";
import "./workspace-email-panel.css";

type Delivery = { deliverable: boolean; mode: string; reason: string | null };

const WORKSPACE_EMAILS = [
  {
    label: "New jobs",
    detail: "Jobs raised through the job forms and the public report form, as they arrive. Urgent ones say so in the subject.",
    to: "Operations inbox",
  },
  {
    label: "Contractor updates",
    detail: "A contractor opening a job link, uploading evidence, or reporting the work done or blocked.",
    to: "Operations inbox",
  },
  {
    label: "Reminders",
    detail: "Certificate and job reminders, each on its rule's own schedule.",
    to: "The people each rule names",
  },
  {
    label: "Scheduled reports",
    detail: "Report emails set up on the Reports page.",
    to: "The members each schedule names",
  },
] as const;

export function WorkspaceEmailPanel() {
  const [delivery, setDelivery] = useState<Delivery | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/account/notifications", { headers: { Accept: "application/json" } });
        const payload = (await response.json()) as { delivery?: Delivery };
        if (response.ok && payload.delivery) setDelivery(payload.delivery);
      } catch {
        /* The list below is still true; only the delivery line is missing. */
      }
    })();
  }, []);

  return (
    <section className="panel settings-card" aria-labelledby="workspace-email-heading">
      <div className="settings-card__heading">
        <span>
          <Icon name="bell" size={19} />
        </span>
        <div>
          <h2 id="workspace-email-heading">Notifications</h2>
          <p>What this workspace emails, and to whom.</p>
        </div>
      </div>
      {delivery && !delivery.deliverable && (
        <p className="workspace-email__status" role="status">
          {delivery.reason}
        </p>
      )}
      <ul className="workspace-email__list">
        {WORKSPACE_EMAILS.map((entry) => (
          <li key={entry.label} className="setting-row">
            <span>
              <strong>{entry.label}</strong>
              <small>{entry.detail}</small>
            </span>
            <em className="workspace-email__to">{entry.to}</em>
          </li>
        ))}
      </ul>
      <p className="workspace-email__foot">
        Each person chooses which of the emails addressed to them they receive, in{" "}
        <Link href="/dashboard/account/notifications">Account → Notifications</Link>.
      </p>
    </section>
  );
}
