import type { Metadata } from "next";
import { ACCOUNT_PANEL_KEYS } from "../../../portal/views/account-panels";
import { AccountShell } from "../../../portal/views/account-shell";

export const dynamic = "force-dynamic";

/**
 * Every screen behind the avatar menu, under one route.
 *
 * A static `account` segment beside the dashboard's optional catch-all, so
 * `/dashboard/account/...` resolves here and `/dashboard/...` is untouched —
 * the section map in that page belongs to the sidebar work and this adds
 * nothing to it.
 */
export const metadata: Metadata = {
  title: "Account",
};

export default async function AccountPage({
  params,
}: {
  params: Promise<{ panel?: string[] }>;
}) {
  const { panel } = await params;
  const requested = panel?.[0] ?? "";
  // An unknown segment falls back to the profile rather than 404ing, so a stale
  // bookmark lands somewhere useful.
  return <AccountShell panel={ACCOUNT_PANEL_KEYS.has(requested) ? requested : ""} />;
}
