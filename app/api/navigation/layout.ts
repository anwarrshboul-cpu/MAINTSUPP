/**
 * Stage 20 — the sidebar layout model.
 *
 * WHY THIS FILE IS SHARED, AND WHY IT IS PURE
 *
 * The layout is resolved twice: once on the server, so `GET /api/navigation`
 * can answer "what does this person's sidebar look like" without a browser, and
 * once in the browser, where the sidebar actually renders. Two implementations
 * of the same merge would drift, and the first symptom of drift is a nav item
 * that exists on one side and not the other — exactly the failure this stage is
 * meant to make impossible. So the merge lives here once, as plain functions
 * with no database and no React, and both sides call it.
 *
 * WHAT IS STORED, AND WHAT IS NOT
 *
 * A stored layout is an *arrangement*, never an inventory. It records order,
 * renames, which items are hidden and which headings exist. It does not record
 * which sections the product has — that is decided at render time by the live
 * catalogue the caller passes in.
 *
 * That distinction is the whole correctness property of this stage. If a saved
 * array were treated as the list of things to draw, then a section added next
 * week would be invisible to every person who had ever touched their sidebar,
 * and it would fail silently: their nav would look fine, it would just be
 * missing something. Instead the catalogue decides existence, the arrangement
 * decides presentation, and anything in the catalogue that no stored layer has
 * an opinion about is *added to the end of its heading, visible*.
 *
 * The rule runs the other way too. A key that a stored layer names but the
 * catalogue does not contain is dropped, because a nav item whose destination
 * no longer exists is a 404 with a friendly label on it.
 */

/** A heading key is namespaced so it can never collide with a section key. */
export const GROUP_PREFIX = "group:";

export function isGroupKey(key: string) {
  return key.startsWith(GROUP_PREFIX);
}

/**
 * The two headings the sidebar has always had, in order.
 *
 * They are built-in rather than user-created so an untouched workspace renders
 * exactly as it did before this stage: "Operations", then "Workspace".
 */
export const BUILT_IN_GROUPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "group:operations", label: "Operations" },
  { key: "group:workspace", label: "Workspace" },
];

export const FALLBACK_GROUP = BUILT_IN_GROUPS[0].key;

/**
 * The built-in order — the third and last layer of resolution.
 *
 * This is the single source of the default order. `portal-app.tsx` derives its
 * `navPrimary` / `navSecondary` from it rather than keeping a second copy, so
 * there is no list to forget to update. Membership of the *catalogue* is still
 * decided by `sectionMeta`, not by this array: a section named here but absent
 * from `sectionMeta` cannot be drawn and is ignored, and a section in
 * `sectionMeta` but missing here is appended to the catalogue rather than lost.
 */
export const BUILT_IN_ORDER: ReadonlyArray<{ key: string; group: string }> = [
  /*
   * The owner's order, and it must match `navPrimary` in portal-app.tsx —
   * a test asserts the two cannot drift, because this copy is what
   * `GET /api/navigation` answers with when there is no browser to ask.
   *
   * It follows the working day: what is happening now, then the paperwork
   * about to expire, then what is booked. Settings sits last as the only
   * entry that changes how the product behaves rather than showing what is
   * in it.
   *
   * "units" is deliberately absent. The Sites screen already lists every unit
   * on the site it belongs to, so the sidebar was offering two entries for one
   * portfolio. The section and its route are untouched.
   */
  { key: "overview", group: "group:operations" },
  { key: "maintenance", group: "group:operations" },
  { key: "store-documentation", group: "group:operations" },
  { key: "compliance", group: "group:operations" },
  { key: "calendar", group: "group:operations" },
  { key: "stores", group: "group:operations" },
  { key: "contractors", group: "group:operations" },
  { key: "documents", group: "group:operations" },
  { key: "reports", group: "group:operations" },
  { key: "settings", group: "group:operations" },
  { key: "team", group: "group:workspace" },
  // Stage 20 administration. Filed under Workspace beside Team rather than
  // Operations: these are about who may use the workspace, not about the work.
  // Each is separately capability-gated, so a client who can be shown Users is
  // not thereby shown Roles.
  { key: "admin-users", group: "group:workspace" },
  { key: "admin-roles", group: "group:workspace" },
  { key: "admin-clients", group: "group:workspace" },
];

/** Server-side labels, used only when no browser catalogue was supplied. */
const BUILT_IN_LABELS: Record<string, string> = {
  "admin-users": "Users",
  "admin-roles": "Roles",
  "admin-clients": "All clients",
  overview: "Overview",
  maintenance: "Jobs",
  calendar: "Planned",
  stores: "Sites",
  "store-documentation": "Store Documentation",
  contractors: "Contractors",
  compliance: "Compliance",
  documents: "Documents",
  reports: "Reports",
  settings: "Settings",
  team: "Team",
};

/** One thing the product can actually navigate to. Supplied by the renderer. */
export type NavCatalogueEntry = {
  key: string;
  /** The label shipped with the product, before any rename. */
  label: string;
  /** The heading it belongs to before anybody rearranged anything. */
  group: string;
};

/**
 * One row of a stored arrangement.
 *
 * `group` is written out because the schema comment promises it, but it is
 * *derived* on read from the item's position relative to the heading above it.
 * Position is the only authority on grouping, which is what lets a drag between
 * two headings mean the obvious thing without a second field to keep in step.
 */
export type NavArrangementItem = {
  key: string;
  kind: "section" | "group";
  /** A user's rename, or null to keep whatever the product calls it. */
  label: string | null;
  hidden: boolean;
  group: string | null;
  position: number;
};

export type ResolvedNavItem = {
  key: string;
  /** What to draw: the rename if there is one, otherwise the built-in label. */
  label: string;
  builtInLabel: string;
  renamed: boolean;
  hidden: boolean;
  locked: boolean;
  group: string;
};

export type ResolvedNavGroup = {
  key: string;
  label: string;
  builtInLabel: string;
  renamed: boolean;
  /** True for a heading the user created, which may therefore be deleted. */
  custom: boolean;
  items: ResolvedNavItem[];
};

export type ResolvedNavigation = {
  groups: ResolvedNavGroup[];
  /** The same items, flat and in render order. Convenient for reordering. */
  flat: ResolvedNavItem[];
  /**
   * Catalogue keys no stored layer had an opinion about. Empty for a layout
   * that has never been edited; non-empty exactly when a section has been
   * added to the product since somebody last saved.
   */
  appeared: string[];
};

const MAX_ITEMS = 200;
const MAX_LABEL = 60;
const MAX_KEY = 80;

/** The catalogue the server falls back to when the caller supplied none. */
export function builtInCatalogue(): NavCatalogueEntry[] {
  return BUILT_IN_ORDER.map((entry) => ({
    key: entry.key,
    label: BUILT_IN_LABELS[entry.key] ?? entry.key,
    group: entry.group,
  }));
}

function cleanLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Control characters would let a label break the row it is drawn in.
  const trimmed = [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    })
    .join("")
    .trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_LABEL);
}

function cleanKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_KEY) return null;
  // Keys address code paths, so keep them to the shape the product generates.
  if (!/^[a-z0-9:_-]+$/i.test(trimmed)) return null;
  return trimmed;
}

/**
 * Coerce anything that arrived over the wire into a well-formed arrangement.
 *
 * Deliberately forgiving about *content* and strict about *shape*: an unknown
 * key survives sanitising and is dropped later by the catalogue merge, because
 * "this key is not a real section" is a question only the catalogue can answer
 * and it must be answered in one place.
 */
export function sanitiseArrangement(value: unknown): NavArrangementItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: NavArrangementItem[] = [];
  for (const raw of value.slice(0, MAX_ITEMS)) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const key = cleanKey(record.key);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const kind = isGroupKey(key) ? "group" : "section";
    items.push({
      key,
      kind,
      label: cleanLabel(record.label),
      // A heading cannot be hidden — hiding one would strand its items with no
      // way to reach them. Delete the heading instead; its items move up.
      hidden: kind === "section" && record.hidden === true,
      group: kind === "section" ? cleanKey(record.group) : null,
      position: items.length,
    });
  }
  return items.map((item, index) => ({ ...item, position: index }));
}

export function sanitiseLocked(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys = new Set<string>();
  for (const raw of value.slice(0, MAX_ITEMS)) {
    const key = cleanKey(raw);
    // Locking a heading is meaningless: headings cannot be hidden anyway.
    if (key && !isGroupKey(key)) keys.add(key);
  }
  return [...keys];
}

type WorkingItem = {
  key: string;
  kind: "section" | "group";
  label: string | null;
  builtInLabel: string;
  hidden: boolean;
  custom: boolean;
};

/** The built-in layer: every catalogue entry under its built-in heading. */
function baseLayer(catalogue: NavCatalogueEntry[]): WorkingItem[] {
  const groups = new Map<string, NavCatalogueEntry[]>();
  const order: string[] = [];
  for (const builtIn of BUILT_IN_GROUPS) {
    groups.set(builtIn.key, []);
    order.push(builtIn.key);
  }
  for (const entry of catalogue) {
    const groupKey = groups.has(entry.group) ? entry.group : FALLBACK_GROUP;
    groups.get(groupKey)!.push(entry);
  }

  const result: WorkingItem[] = [];
  for (const groupKey of order) {
    const builtIn = BUILT_IN_GROUPS.find((item) => item.key === groupKey)!;
    result.push({
      key: groupKey,
      kind: "group",
      label: null,
      builtInLabel: builtIn.label,
      hidden: false,
      custom: false,
    });
    for (const entry of groups.get(groupKey)!) {
      result.push({
        key: entry.key,
        kind: "section",
        label: null,
        builtInLabel: entry.label,
        hidden: false,
        custom: false,
      });
    }
  }
  return result;
}

/**
 * Fold one stored layer onto the layout resolved so far.
 *
 * Two passes, and the second is the important one. The first pass emits what
 * the layer names, in the layer's order — that is the rearranging. The second
 * walks the *base* and reinstates everything the layer never mentioned, each at
 * the end of the heading it already belonged to.
 *
 * "End of its own heading" rather than "next to its old neighbour", and that
 * choice was made the hard way. Anchoring an unmentioned item to whichever item
 * used to precede it means an aggressive reorder drags unrelated items around
 * with it: move Reports to the top, and Settings follows it, and the Workspace
 * heading follows Settings, and half the sidebar ends up under the wrong
 * heading. A group is a stable place to land; a neighbour is not.
 *
 * Nothing is dropped for being absent from a layer. Being absent means "this
 * arrangement has no opinion", which is precisely the case for a section that
 * did not exist when the arrangement was saved.
 */
function applyLayer(base: WorkingItem[], layer: NavArrangementItem[]): WorkingItem[] {
  if (!layer.length) return base;

  const baseByKey = new Map(base.map((item) => [item.key, item]));
  const result: WorkingItem[] = [];
  const placed = new Set<string>();

  for (const entry of layer) {
    if (placed.has(entry.key)) continue;
    const existing = baseByKey.get(entry.key);
    if (entry.kind === "group") {
      // A heading the layer invented is created here; one that already exists
      // keeps its built-in name so a rename can be undone by clearing it.
      result.push({
        key: entry.key,
        kind: "group",
        label: entry.label,
        builtInLabel: existing?.builtInLabel ?? entry.label ?? "Section",
        hidden: false,
        custom: existing ? existing.custom : true,
      });
      placed.add(entry.key);
      continue;
    }
    // A section the catalogue does not contain. Dropped rather than drawn: its
    // destination no longer exists, so the item would be a labelled 404.
    if (!existing) continue;
    result.push({
      ...existing,
      label: entry.label,
      hidden: entry.hidden,
    });
    placed.add(entry.key);
  }

  // Which heading each base item sits under, read off the base's own order.
  const baseGroupOf = new Map<string, string | null>();
  let baseGroup: string | null = null;
  for (const item of base) {
    if (item.kind === "group") {
      baseGroup = item.key;
      baseGroupOf.set(item.key, null);
      continue;
    }
    baseGroupOf.set(item.key, baseGroup);
  }

  /** The index just past the last item belonging to `groupKey` in `result`. */
  function endOfGroup(groupKey: string) {
    const start = result.findIndex((item) => item.key === groupKey);
    if (start < 0) return -1;
    let end = start + 1;
    while (end < result.length && result[end].kind !== "group") end += 1;
    return end;
  }

  for (const item of base) {
    if (placed.has(item.key)) continue;
    placed.add(item.key);
    if (item.kind === "group") {
      // A heading the layer dropped comes back at the bottom, bringing the
      // items that were under it — deleting a heading must not delete sections.
      result.push(item);
      continue;
    }
    const groupKey = baseGroupOf.get(item.key) ?? null;
    const at = groupKey ? endOfGroup(groupKey) : -1;
    if (at < 0) {
      result.push(item);
    } else {
      result.splice(at, 0, item);
    }
  }

  return result;
}

/** Keys the layer names, restricted to those the base already knows. */
function opinionatedKeys(base: WorkingItem[], layer: NavArrangementItem[]) {
  const known = new Set(base.map((item) => item.key));
  return new Set(layer.filter((item) => known.has(item.key)).map((item) => item.key));
}

export type ResolveInput = {
  /** What exists. Supplied by whoever is about to render. */
  catalogue: NavCatalogueEntry[];
  /** The workspace default an admin set, or [] if there is none. */
  workspaceItems: NavArrangementItem[];
  /** This person's own arrangement, or null if they have never saved one. */
  userItems: NavArrangementItem[] | null;
  /** Keys an admin pinned on. Comes from the workspace default row only. */
  locked: string[];
};

/**
 * The three-layer resolution: built-in, then workspace default, then the user.
 *
 * Each layer overrides the one beneath it only for the keys it actually names.
 * That is what makes the layers compose rather than replace: an admin who
 * reorders two items in the workspace default does not thereby freeze the rest
 * of the sidebar, and a user who hides one section does not opt out of every
 * later change to the default.
 */
export function resolveNavigation(input: ResolveInput): ResolvedNavigation {
  const catalogue = input.catalogue.length ? input.catalogue : builtInCatalogue();
  const base = baseLayer(catalogue);
  const lockedKeys = new Set(input.locked);

  const afterWorkspace = applyLayer(base, input.workspaceItems);
  const resolved = applyLayer(afterWorkspace, input.userItems ?? []);

  // Which catalogue entries neither stored layer had an opinion about. This is
  // the "a section appeared since you last saved" set, and it is worth
  // surfacing rather than inferring: it is the difference between a sidebar
  // that quietly went stale and one that told you it had grown.
  const spokenFor = new Set([
    ...opinionatedKeys(base, input.workspaceItems),
    ...opinionatedKeys(base, input.userItems ?? []),
  ]);
  // Nothing has "appeared" for somebody who has never arranged anything — the
  // whole sidebar would be flagged as new, which says nothing at all.
  const arrangedAnything =
    input.workspaceItems.length > 0 || (input.userItems?.length ?? 0) > 0;
  const appeared = arrangedAnything
    ? catalogue.map((entry) => entry.key).filter((key) => !spokenFor.has(key))
    : [];

  // Locks are decided by the workspace default, so a locked item's label is the
  // one the *default* resolves to. Anything the user layer did to it is undone
  // here as well as refused at the API, because a lock that only holds when the
  // request went through the API is not a lock.
  const workspaceLabels = new Map(
    applyLayer(base, input.workspaceItems).map((item) => [item.key, item.label]),
  );

  const flat: ResolvedNavItem[] = [];
  const groups: ResolvedNavGroup[] = [];
  let current: ResolvedNavGroup | null = null;

  for (const item of resolved) {
    if (item.kind === "group") {
      current = {
        key: item.key,
        label: item.label ?? item.builtInLabel,
        builtInLabel: item.builtInLabel,
        renamed: item.label !== null && item.label !== item.builtInLabel,
        custom: item.custom,
        items: [],
      };
      groups.push(current);
      continue;
    }
    if (!current) {
      // A section ahead of every heading — only reachable from a crafted
      // payload. Give it the first built-in heading rather than dropping it.
      const builtIn = BUILT_IN_GROUPS[0];
      current = {
        key: builtIn.key,
        label: builtIn.label,
        builtInLabel: builtIn.label,
        renamed: false,
        custom: false,
        items: [],
      };
      groups.push(current);
    }
    const locked = lockedKeys.has(item.key);
    const label = locked
      ? (workspaceLabels.get(item.key) ?? null) ?? item.builtInLabel
      : item.label ?? item.builtInLabel;
    const resolvedItem: ResolvedNavItem = {
      key: item.key,
      label,
      builtInLabel: item.builtInLabel,
      renamed: label !== item.builtInLabel,
      hidden: locked ? false : item.hidden,
      locked,
      group: current.key,
    };
    current.items.push(resolvedItem);
    flat.push(resolvedItem);
  }

  // Never strand the user. A layout with nothing visible is not a preference,
  // it is a dead end — there would be no way back to the editor that produced
  // it. The first section in render order is forced back on. Enforced here, in
  // the resolver, so it holds for a layout crafted straight into the database
  // as well as for one saved through the API.
  if (flat.length && !flat.some((item) => !item.hidden)) {
    flat[0].hidden = false;
  }

  return { groups, flat, appeared };
}

/** Serialise a resolved layout back into the arrangement that produced it. */
export function toArrangement(groups: ResolvedNavGroup[]): NavArrangementItem[] {
  const items: NavArrangementItem[] = [];
  for (const group of groups) {
    items.push({
      key: group.key,
      kind: "group",
      label: group.renamed ? group.label : null,
      hidden: false,
      group: null,
      position: items.length,
    });
    for (const item of group.items) {
      items.push({
        key: item.key,
        kind: "section",
        label: item.renamed ? item.label : null,
        hidden: item.hidden,
        group: group.key,
        position: items.length,
      });
    }
  }
  return items;
}

export type LockViolation = { key: string; reason: "hidden" | "renamed" };

/**
 * The server-side lock check, and the reason locking is a rule rather than a
 * disabled button.
 *
 * A disabled control is a suggestion: anybody can open a console and `fetch`
 * the same endpoint with `hidden: true`. So the submitted arrangement is
 * checked here, on every save, and a violation fails the whole request rather
 * than being quietly corrected — a client who crafted the payload should be
 * told no, not left believing it worked.
 *
 * `workspaceLabels` is what the workspace default calls each locked item, so
 * the rule is exact: a locked item must be submitted unhidden and with either
 * no rename at all or precisely the rename the workspace default already
 * carries. Reordering a locked item is allowed — a lock is about being able to
 * *see* something, not about where it sits.
 */
export function lockViolations(
  items: NavArrangementItem[],
  locked: string[],
  workspaceLabels: Map<string, string | null>,
): LockViolation[] {
  const lockedKeys = new Set(locked);
  const violations: LockViolation[] = [];
  for (const item of items) {
    if (item.kind !== "section" || !lockedKeys.has(item.key)) continue;
    if (item.hidden) {
      violations.push({ key: item.key, reason: "hidden" });
      continue;
    }
    const allowed = workspaceLabels.get(item.key) ?? null;
    if (item.label !== null && item.label !== allowed) {
      violations.push({ key: item.key, reason: "renamed" });
    }
  }
  // Omitting a locked item is *not* a violation, and that is deliberate. A
  // layer that does not name a key has no opinion about it, so the item falls
  // through to the workspace default — where it is visible. Treating omission
  // as an offence would also break the honest case of a browser whose section
  // catalogue is a deploy behind the admin who set the lock.
  return violations;
}

/** What the workspace default calls each item, for the lock check above. */
export function workspaceLabelMap(
  workspaceItems: NavArrangementItem[],
): Map<string, string | null> {
  return new Map(workspaceItems.map((item) => [item.key, item.label]));
}
