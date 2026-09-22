/**
 * §38 — VERSION HISTORY: what each versioned setting's state looks like, how
 * two states are compared, and how an old state is sent back.
 *
 * The owner's rule: EVERY version is kept, and a restore never rewrites or
 * removes history — it writes the old state back through the setting's own
 * save route (so today's validation, permissions and audit all apply) and that
 * save is recorded as a NEW version saying where it came from.
 *
 * No imports and no database: the history panel (a client component) and the
 * tests load this directly. The database half is `config-versions.ts`.
 */

/** `installation` = one for the whole product (the website), not per workspace. */
export type VersionScope = "workspace" | "installation";

export type VersionSubjectDefinition = {
  label: string;
  scope: VersionScope;
  /**
   * Who may read the history and restore — the same as who may edit the
   * setting: a workspace capability, or `platform` (MAINTSUPP platform staff,
   * `requirePlatformAdmin`'s rule) for installation-wide content.
   */
  capability: "settings.edit" | "navigation.edit" | "platform";
  /** The keys a subject has, or `slug` for any well-formed page slug. */
  keys: readonly string[] | "slug";
};

export const VERSION_SUBJECTS = {
  theme: { label: "Brand colours and fonts", scope: "workspace", capability: "settings.edit", keys: ["tokens"] },
  portal_modules: { label: "Portal modules", scope: "workspace", capability: "navigation.edit", keys: ["switches"] },
  navigation: { label: "Workspace default sidebar", scope: "workspace", capability: "navigation.edit", keys: ["workspace"] },
  dashboard: { label: "Workspace default dashboard", scope: "workspace", capability: "settings.edit", keys: ["overview", "reports"] },
  /* §38b — a website page, keyed by its slug, so history follows the address. */
  site_page: { label: "Website page", scope: "installation", capability: "platform", keys: "slug" },
} as const satisfies Record<string, VersionSubjectDefinition>;

export type VersionSubject = keyof typeof VERSION_SUBJECTS;

export function versionSubject(subject: unknown, key: unknown): { subject: VersionSubject; key: string } | null {
  if (typeof subject !== "string" || !Object.prototype.hasOwnProperty.call(VERSION_SUBJECTS, subject)) return null;
  const definition: VersionSubjectDefinition = VERSION_SUBJECTS[subject as VersionSubject];
  if (typeof key !== "string") return null;
  if (definition.keys === "slug") {
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) && key.length <= 80 ? { subject: subject as VersionSubject, key } : null;
  }
  if (!definition.keys.includes(key)) return null;
  return { subject: subject as VersionSubject, key };
}

export type ChangeKind = "baseline" | "saved" | "restored" | "deleted";

/** JSON with every object's keys sorted, so two equal states always serialise — and hash — the same. */
export function canonicalJson(value: unknown): string {
  const normalise = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalise);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.keys(input as Record<string, unknown>)
          .sort()
          .filter((key) => (input as Record<string, unknown>)[key] !== undefined)
          .map((key) => [key, normalise((input as Record<string, unknown>)[key])]),
      );
    }
    return input;
  };
  return JSON.stringify(normalise(value));
}

/* ── Snapshots: the whole state, enough to put it back exactly ─────────────── */

export type ThemeSnapshot = { tokens: Record<string, string> };
export type ModulesSnapshot = { disabled: string[] };
export type NavigationSnapshot = { present: boolean; items: unknown[]; locked: string[] };
export type DashboardSnapshot = { present: boolean; surface: string; items: unknown[] };
/** §38b — exactly what the page editor saves (`PageInput`), so a restore is that save again. */
export type PageSnapshot = {
  slug: string;
  title: string;
  metaTitle: string | null;
  metaDescription: string | null;
  published: boolean;
  blocks: Array<{ kind: string; body: unknown }>;
};

export function themeSnapshot(overrides: Readonly<Record<string, string>>): ThemeSnapshot {
  return { tokens: Object.fromEntries(Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right))) };
}

export function modulesSnapshot(overrides: Readonly<Record<string, boolean>>): ModulesSnapshot {
  return {
    disabled: Object.entries(overrides)
      .filter(([, enabled]) => enabled === false)
      .map(([key]) => key)
      .sort(),
  };
}

export function navigationSnapshot(row: { items: unknown[]; locked: string[] } | null): NavigationSnapshot {
  return row ? { present: true, items: row.items, locked: [...row.locked].sort() } : { present: false, items: [], locked: [] };
}

export function dashboardSnapshot(surface: string, items: unknown[] | null): DashboardSnapshot {
  return items ? { present: true, surface, items } : { present: false, surface, items: [] };
}

/** A stored page (blocks in position order) or a page about to be saved, as the same shape. */
export function pageSnapshot(page: {
  slug: string;
  title: string;
  metaTitle: string | null;
  metaDescription: string | null;
  published: boolean;
  blocks: Array<{ kind: string; body: unknown; position?: number }>;
}): PageSnapshot {
  const blocks = [...page.blocks]
    .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
    .map((block) => ({ kind: block.kind, body: block.body }));
  return {
    slug: page.slug,
    title: page.title,
    metaTitle: page.metaTitle ?? null,
    metaDescription: page.metaDescription ?? null,
    published: page.published,
    blocks,
  };
}

/* ── Restore bodies: an old state, as the setting's own save route expects it ─ */

/**
 * Every token the product defines, set to the snapshot's value or reset.
 * `currentKeys` is today's catalogue: a token the snapshot never set is reset
 * to the default, and a token retired since is simply not sent.
 */
export function themeRestoreTokens(snapshot: ThemeSnapshot, currentKeys: readonly string[]): Record<string, string | null> {
  return Object.fromEntries(currentKeys.map((key) => [key, snapshot.tokens[key] ?? null]));
}

/** Every module on, except those the snapshot had off. */
export function modulesRestoreSwitches(snapshot: ModulesSnapshot, currentKeys: readonly string[]): Record<string, boolean> {
  return Object.fromEntries(currentKeys.map((key) => [key, !snapshot.disabled.includes(key)]));
}

/* ── Summaries: one line a person can scan ─────────────────────────────────── */

const listed = (keys: string[]) => (keys.length > 4 ? `${keys.slice(0, 4).join(", ")} and ${keys.length - 4} more` : keys.join(", "));

/** A page's shape in a history line: "2 blocks, published." */
export function pageShape(page: PageSnapshot): string {
  return `${page.blocks.length} block${page.blocks.length === 1 ? "" : "s"}, ${page.published ? "published" : "draft"}.`;
}

export function summariseChange(subject: VersionSubject, before: unknown, after: unknown): string {
  if (subject === "theme") {
    const from = (before as ThemeSnapshot | null)?.tokens ?? {};
    const to = (after as ThemeSnapshot).tokens;
    const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].filter((key) => from[key] !== to[key]).sort();
    const reset = keys.filter((key) => to[key] === undefined);
    const changed = keys.filter((key) => to[key] !== undefined);
    const parts = [changed.length ? `Changed ${listed(changed)}` : "", reset.length ? `reset ${listed(reset)}` : ""].filter(Boolean);
    return parts.length ? parts.join("; ") : "No colour or font changed.";
  }
  if (subject === "portal_modules") {
    const from = new Set((before as ModulesSnapshot | null)?.disabled ?? []);
    const to = new Set((after as ModulesSnapshot).disabled);
    const off = [...to].filter((key) => !from.has(key)).sort();
    const on = [...from].filter((key) => !to.has(key)).sort();
    const parts = [off.length ? `Switched off ${listed(off)}` : "", on.length ? `switched on ${listed(on)}` : ""].filter(Boolean);
    return parts.length ? parts.join("; ") : "No module changed.";
  }
  if (subject === "navigation") {
    const state = after as NavigationSnapshot;
    if (!state.present) return "Reset to the built-in order.";
    return `Saved the default sidebar: ${state.items.length} item${state.items.length === 1 ? "" : "s"}, ${state.locked.length} locked.`;
  }
  if (subject === "site_page") {
    const from = before as PageSnapshot | null;
    const to = after as PageSnapshot;
    const parts: string[] = [];
    if (!from) parts.push("Created");
    if (from && from.title !== to.title) parts.push("retitled");
    if (from && from.published !== to.published) parts.push(to.published ? "published" : "unpublished");
    if (from && canonicalJson(from.blocks) !== canonicalJson(to.blocks)) parts.push("content changed");
    if (from && (from.metaTitle !== to.metaTitle || from.metaDescription !== to.metaDescription)) parts.push("search text changed");
    const said = parts.length ? parts.join(", ") : "Saved with no change";
    return `${said[0].toUpperCase()}${said.slice(1)} — ${pageShape(to)}`;
  }
  const state = after as DashboardSnapshot;
  if (!state.present || state.items.length === 0) return `The built-in ${state.surface} layout.`;
  const hidden = state.items.filter((item) => (item as { hidden?: unknown })?.hidden === true).length;
  return `Saved the default ${state.surface} dashboard: ${state.items.length} widget${state.items.length === 1 ? "" : "s"}${hidden ? `, ${hidden} hidden` : ""}.`;
}

/* ── The request a Restore button sends ────────────────────────────────────── */

/**
 * The setting's OWN save route, with `restoreVersion`. The server loads the
 * snapshot itself — this sends only the number — so the "restored from" record
 * is decided on the server, never claimed by the browser.
 */
export function restoreRequest(subject: VersionSubject, key: string, version: number): { url: string; body: Record<string, unknown> } {
  switch (subject) {
    case "theme":
      return { url: "/api/theme", body: { restoreVersion: version } };
    case "portal_modules":
      return { url: "/api/portal-modules", body: { restoreVersion: version } };
    case "navigation":
      return { url: "/api/navigation", body: { scope: "workspace", restoreVersion: version } };
    case "dashboard":
      return { url: "/api/dashboard-layout", body: { scope: "workspace", surface: key, restoreVersion: version } };
    case "site_page":
      return { url: "/api/site-pages", body: { slug: key, restoreVersion: version } };
  }
}

/** A version number from a request body, or null. */
export function restoreVersionFrom(body: unknown): number | null {
  const raw = (body as { restoreVersion?: unknown } | null)?.restoreVersion;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? raw : null;
}
