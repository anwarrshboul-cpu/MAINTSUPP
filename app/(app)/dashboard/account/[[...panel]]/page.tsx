import type { Metadata } from "next";
import { requireModuleAccess, requirePageSession } from "../../../../lib/page-guard";
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
  /*
   * Every panel behind this route reads the signed-in person's own account, so
   * an anonymous visitor has nothing to be shown here and must not be sent the
   * shell while we work that out. See `app/lib/page-guard.ts`.
   */
  await requirePageSession(
    panel?.length
      ? `/dashboard/account/${panel.join("/")}`
      : "/dashboard/account",
  );
  const requested = panel?.[0] ?? "";
  /*
   * `trash` IS the Recycle Bin module, at its second address.
   *
   * `views/recycle-bin-section.tsx` says so in its own header: the section "adds
   * a door, not a room", and renders the same `AccountTrashPanel` this panel
   * renders. Gating the section and leaving this open would make the switch
   * cosmetic for anyone who knows the URL — which is the failure §19 is asking
   * us to avoid, not a smaller version of it.
   *
   * Only `trash` is checked. The other panels are the signed-in person's own
   * account and belong to no module; sending them through the registry would
   * invent switches the product does not have.
   */
  if (requested === "trash") {
    await requireModuleAccess("recycle-bin", "/dashboard/account/trash");
  }
  // An unknown segment falls back to the profile rather than 404ing, so a stale
  // bookmark lands somewhere useful.
  return <AccountShell panel={ACCOUNT_PANEL_KEYS.has(requested) ? requested : ""} />;
}
