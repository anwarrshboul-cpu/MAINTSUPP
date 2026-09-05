import type { Metadata } from "next";
import ConfirmReminderAction from "./confirm-action";

/*
 * A token in a URL is a credential, so this page is never indexed — the same
 * rule the contractor job link follows, for the same reason.
 */
export const metadata: Metadata = {
  title: "Reminder | MAINTSUPP",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * The landing page for an emailed Acknowledge / Snooze / Mark-renewed link.
 *
 * It performs NOTHING. It renders a confirmation, and the button posts. See
 * `app/api/reminders/action/route.ts` for why: mail gateways fetch links before
 * a person opens them, and acting on the GET would let a scanner spend a
 * single-use token and silently stop a compliance cascade.
 */
export default async function ReminderActionPage({
  params,
}: {
  params: Promise<{ action: string; token: string }>;
}) {
  const { action, token } = await params;
  return <ConfirmReminderAction action={action} token={token} />;
}
