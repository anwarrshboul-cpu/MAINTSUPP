/**
 * Stage 23 — sections the workspace owner adds, and what they are allowed to be.
 *
 * WHY THIS FILE IS PURE
 *
 * The same reason `app/api/navigation/layout.ts` is pure: two places need these
 * answers. The server needs them so `GET /api/navigation` can put a workspace
 * section into the catalogue without a browser, and the browser needs them so
 * the sidebar it draws and the layout the server resolved cannot disagree. One
 * implementation, no database, no React.
 *
 * WHAT A WORKSPACE SECTION IS, AND WHAT IT IS NOT
 *
 * It is a NAV ENTRY WITH A DESTINATION: a key, a label, an icon, a position and
 * a `surface` naming one of the screens the product already renders. It is not
 * a new screen, and it cannot become one by being saved — that is the whole of
 * "Add must not invent a destination". A row whose surface this file does not
 * recognise is dropped from the catalogue rather than drawn, exactly as a
 * stored arrangement naming an unknown key is dropped.
 *
 * HOW IT MEETS THE OTHER RULE
 *
 * Stage 20's rule is that a saved layout is an ARRANGEMENT, never an inventory.
 * This file does not touch it. `sectionsToCatalogue` produces catalogue entries,
 * the catalogue is what `resolveNavigation` is handed, and the arrangement
 * layers still only decide presentation. So a section added today lands, visible,
 * at the end of its heading for every person who arranged their sidebar last
 * year — with nobody's stored layout migrated — and a section archived today
 * leaves their stored layout alone and simply stops being drawn.
 */

/*
 * A type-only import, and that is not an accident.
 *
 * This module is loaded three ways: by the Worker routes, by the browser, and
 * directly by `node --test`, which strips types rather than compiling and so
 * resolves only what survives erasure. Importing a VALUE from `layout.ts` would
 * make the whole sidebar model a dependency of validating a label. The two
 * runtime facts this file would otherwise want from there — which headings
 * exist, and which one is the fallback — are passed in by the caller instead,
 * so `layout.ts` remains the only place that decides them.
 */
import type { NavCatalogueEntry } from "../navigation/layout";

/**
 * The namespace every workspace-defined key carries.
 *
 * `group:` already namespaces headings for the same reason. Without it an owner
 * could create a section called "settings", and from then on it would be
 * ambiguous whether a stored key meant their section or the built-in one — with
 * the built-in one losing, because the workspace catalogue is appended last.
 */
export const SECTION_PREFIX = "section:";

export function isWorkspaceSectionKey(key: string) {
  return key.startsWith(SECTION_PREFIX);
}

/**
 * The screens a section may point at.
 *
 * EVERY KEY HERE IS A BUILT-IN SECTION KEY, and that is not a naming
 * coincidence — it is the check. A surface is "the screen the built-in section
 * of this name draws", so the set of things a workspace section can be is,
 * literally, the set of screens `portal-app.tsx` already mounts.
 * `tests/stage-twentythree-sections.test.mjs` reads `sectionMeta` and
 * `sectionRoutes` out of that file and asserts every key below appears in both,
 * which turns "Add must not invent a destination" from a rule somebody has to
 * remember into one the suite fails on.
 *
 * `boardKey` is the board a surface reads, or null for a screen with no board
 * behind it. It decides whether the section has VIEWS to choose a default from:
 * views live in `board_views`, keyed by board, so a screen with no board has no
 * tabs and the view API says exactly that rather than offering an owner a
 * default view for a tab strip that does not exist.
 */
export const SECTION_SURFACES = [
  {
    key: "maintenance",
    label: "Job board",
    description: "The live job board, with its groups, columns and view tabs.",
    boardKey: "maintenance",
  },
  {
    key: "store-documentation",
    label: "Document board",
    description: "The Store Documentation board and its compliance tracker.",
    boardKey: "store-documentation",
  },
  {
    key: "documents",
    label: "Document list",
    description: "The central file library — every document and its evidence.",
    boardKey: null,
  },
  {
    key: "stores",
    label: "Site & unit register",
    description: "Sites, and the units and assets on each one.",
    boardKey: null,
  },
  {
    key: "compliance",
    label: "Compliance register",
    description: "Certificates by site, with their expiry tracked.",
    boardKey: null,
  },
  {
    key: "calendar",
    label: "Planned calendar",
    description: "Planned works and renewals on a calendar.",
    boardKey: null,
  },
  {
    key: "contractors",
    label: "Contractor list",
    description: "The supplier network and how each one is performing.",
    boardKey: null,
  },
  {
    key: "reports",
    label: "Reports",
    description: "Spend and portfolio reporting.",
    boardKey: null,
  },
] as const;

export type SurfaceKey = (typeof SECTION_SURFACES)[number]["key"];

/**
 * What a section is when the owner did not say.
 *
 * The job board, because it is the screen the product is about and the one an
 * owner adding "CCTV" is most likely to want a second door into.
 */
export const DEFAULT_SURFACE: SurfaceKey = "maintenance";

export function surfaceDefinition(key: string) {
  return SECTION_SURFACES.find((surface) => surface.key === key) ?? null;
}

export function isSurfaceKey(value: unknown): value is SurfaceKey {
  return typeof value === "string" && surfaceDefinition(value) !== null;
}

/**
 * The icons a section may wear.
 *
 * A second copy of `IconName` from `app/components.tsx`, and a second copy on
 * purpose: this module is imported by the API, which must not pull a `.tsx`
 * component file (and its React import) into a Worker route just to validate a
 * string. `tests/stage-twentythree-sections.test.mjs` reads both files and
 * asserts they agree, which is what makes the copy safe rather than a second
 * source of truth — the same arrangement `BUILT_IN_ORDER` has with `navPrimary`.
 *
 * It matters that this is validated at all: the icon name reaches a `Record`
 * lookup in the renderer, and an unknown one draws nothing, so a typo would
 * produce a nav row with an empty hole where its icon should be.
 */
export const ICON_NAMES = [
  "activity",
  "alert",
  "arrow",
  "bell",
  "building",
  "camera",
  "calendar",
  "chart",
  "check",
  "chevron",
  "clock",
  "close",
  "document",
  "download",
  /* Three added with the Updates panel. They are here because this list and
     `IconName` are asserted to be the same set — a glyph the renderer can draw
     and this file has never heard of is the half of that pair which does no
     harm, but the assertion is what keeps the copy honest and it is exact. */
  "edit",
  "filter",
  "folder",
  "grid",
  "home",
  "image",
  "inbox",
  /* Two added with the form builder's Share dialog, for the same reason as the
     three above: this list and `IconName` are asserted to be the same set. */
  "link",
  "list",
  "map",
  "menu",
  "message",
  "moon",
  "more",
  "paperclip",
  "plus",
  "refresh",
  "reply",
  "search",
  "settings",
  "share",
  "shield",
  "spark",
  "store",
  "sun",
  "thumb",
  "tool",
  "upload",
  "updates",
  "user",
  "users",
  "wrench",
] as const;

export const DEFAULT_ICON = "grid";

export function isIconName(value: unknown): value is (typeof ICON_NAMES)[number] {
  return typeof value === "string" && (ICON_NAMES as readonly string[]).includes(value);
}

/**
 * The board a built-in section reads, or null when it has no board.
 *
 * Because a surface key IS a built-in section key, this is just the surface
 * table read the other way round, and no second list has to be kept in step. A
 * built-in section that names no surface — Overview, Team, Settings, the three
 * administration screens — has no board and therefore no views, which is the
 * true answer rather than an omission.
 */
export function builtInSectionBoard(sectionKey: string): string | null {
  return surfaceDefinition(sectionKey)?.boardKey ?? null;
}

/** One workspace-defined section, as the API returns it. */
export type WorkspaceSection = {
  key: string;
  label: string;
  icon: string;
  surface: SurfaceKey;
  /** The board this section's surface reads, or null if it has no board. */
  boardKey: string | null;
  group: string;
  position: number;
  archived: boolean;
};

const MAX_LABEL = 60;
const MAX_SLUG = 48;

/**
 * A label, with anything that could break the row it is drawn in removed.
 *
 * Control characters are stripped rather than escaped, matching `cleanLabel` in
 * `layout.ts` — one behaviour for one kind of value, so a label that survives a
 * rename in the sidebar also survives being created here.
 */
export function cleanSectionLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_LABEL);
}

/** "CCTV" becomes `section:cctv`; "Fire & Safety" becomes `section:fire-safety`. */
export function slugFromLabel(label: string) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG);
}

/**
 * The key for a section, from an explicit key or from its label.
 *
 * Always namespaced, and always re-slugified even when supplied, so a crafted
 * `key` cannot escape the namespace or carry a character the layout resolver
 * would refuse. `null` when nothing usable is left — a label of only punctuation
 * has no key, and is rejected rather than given a generated one nobody can read.
 */
export function sectionKeyFrom(input: { key?: unknown; label?: unknown }): string | null {
  const explicit = typeof input.key === "string" ? input.key : "";
  const fromKey = slugFromLabel(explicit.replace(SECTION_PREFIX, ""));
  if (fromKey) return `${SECTION_PREFIX}${fromKey}`;
  const label = cleanSectionLabel(input.label);
  const slug = label ? slugFromLabel(label) : "";
  return slug ? `${SECTION_PREFIX}${slug}` : null;
}

/**
 * Whether a heading key is one the sidebar actually has.
 *
 * `groupKeys` comes from `BUILT_IN_GROUPS` in `layout.ts`, in that order, so its
 * first entry is the fallback heading — the same `FALLBACK_GROUP` the resolver
 * uses. Passed in rather than imported so this module stays free of runtime
 * dependencies; see the note on the import above.
 */
export function isGroupChoice(
  value: unknown,
  groupKeys: readonly string[],
): value is string {
  return typeof value === "string" && groupKeys.includes(value);
}

/**
 * Workspace sections as catalogue entries, ready to append to the built-in ones.
 *
 * Three things are dropped rather than drawn, and each is the same rule the
 * layout resolver already applies to arrangements:
 *
 *  - an ARCHIVED section, because it is not currently part of the product;
 *  - one naming a surface this build does not have, because it would be a nav
 *    item with nowhere to go — the case a workspace row rolled forward past a
 *    rollback produces;
 *  - one whose key is not in the section namespace, which can only come from a
 *    row written by hand.
 *
 * Order is by stored position, then label, so two sections created in the same
 * second still have a stable order rather than whatever the database returns.
 */
export function sectionsToCatalogue(
  sections: WorkspaceSection[],
  groupKeys: readonly string[],
): NavCatalogueEntry[] {
  return sections
    .filter(
      (section) =>
        !section.archived &&
        isWorkspaceSectionKey(section.key) &&
        surfaceDefinition(section.surface) !== null,
    )
    .slice()
    .sort((left, right) =>
      left.position === right.position
        ? left.label.localeCompare(right.label)
        : left.position - right.position,
    )
    .map((section) => ({
      key: section.key,
      label: section.label,
      // A heading that no longer exists lands its section under the first one,
      // which is what the resolver does with an unknown group of its own.
      group: isGroupChoice(section.group, groupKeys) ? section.group : groupKeys[0],
    }));
}
