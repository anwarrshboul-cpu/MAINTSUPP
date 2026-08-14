/**
 * The account area's panel list.
 *
 * A plain module rather than part of `account-shell.tsx` because the route is a
 * server component: importing a value out of a `"use client"` file gives back a
 * client reference, not the array, so the route could not read the keys from
 * there. Both the shell's rail and the route's slug check read this.
 *
 * The order and grouping are the avatar menu's own — Account then Explore, in
 * monday's item order — so the menu and the rail never disagree about where
 * something lives.
 */

import type { IconName } from "../../../components";

export type AccountPanelDefinition = {
  /** URL segment under `/dashboard/account`. Empty string is My profile. */
  key: string;
  label: string;
  icon: IconName;
  group: "Account" | "Explore";
  /** The monday.com label this screen stands in for. */
  monday: string;
};

export const ACCOUNT_PANELS: readonly AccountPanelDefinition[] = [
  { key: "", label: "My profile", icon: "user", group: "Account", monday: "My profile" },
  { key: "developers", label: "Developers", icon: "tool", group: "Account", monday: "Developers" },
  { key: "workspaces", label: "Workspaces", icon: "building", group: "Account", monday: "Spaces" },
  { key: "trash", label: "Trash", icon: "close", group: "Account", monday: "Trash" },
  { key: "archive", label: "Archive", icon: "folder", group: "Account", monday: "Archive" },
  { key: "integrations", label: "Integrations", icon: "grid", group: "Explore", monday: "App marketplace" },
  { key: "mobile", label: "Mobile access", icon: "download", group: "Explore", monday: "Mobile app" },
  { key: "beta", label: "Beta features", icon: "spark", group: "Explore", monday: "monday.labs" },
  { key: "shortcuts", label: "Shortcuts", icon: "list", group: "Explore", monday: "Shortcuts" },
  { key: "invite", label: "Invite members", icon: "plus", group: "Explore", monday: "Invite members" },
  { key: "help", label: "Get help", icon: "message", group: "Explore", monday: "Get help" },
  { key: "theme", label: "Change theme", icon: "moon", group: "Explore", monday: "Change theme" },
  { key: "billing", label: "Plan & billing", icon: "document", group: "Explore", monday: "Upgrade account" },
];

export const ACCOUNT_PANEL_KEYS = new Set(ACCOUNT_PANELS.map((entry) => entry.key));
