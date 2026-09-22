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
  /* Decision J — the public website's header menu and footer links. One of
     them, installation-wide, keyed "public". */
  site_navigation: { label: "Website navigation", scope: "installation", capability: "platform", keys: ["public"] },
  /* Decision L — the copy of the pages that ship with the site, held as
     overrides on the words in `app/(marketing)/_sections/copy.ts`. One of them,
     installation-wide, keyed "public". */
  site_content: { label: "Website page copy", scope: "installation", capability: "platform", keys: ["public"] },
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

/* `renamed` closes an address's history when its page MOVED to another one (§6):
   the page lives on at the new address, so this is not a deletion to undo. */
export type ChangeKind = "baseline" | "saved" | "restored" | "deleted" | "renamed";

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
/**
 * Decision J — the website's navigation: the whole stored document, or
 * `present: false` for "no row" (the built-in navigation, after a reset).
 * `navigation` is typed loosely here because this module imports nothing;
 * `app/lib/site-navigation.ts` owns the shape.
 */
export type SiteNavigationSnapshot = { present: boolean; navigation: SiteNavigationShape | null };
type SiteNavigationShape = {
  primary: Array<{ id: string; label: string; href: string; hidden: boolean }>;
  footer: Array<{ id: string; heading: string; links: Array<{ id: string; label: string; href: string; hidden: boolean }> }>;
};

export function siteNavigationSnapshot(navigation: SiteNavigationShape | null): SiteNavigationSnapshot {
  return navigation ? { present: true, navigation } : { present: false, navigation: null };
}

/**
 * Decision L — the built-in pages' copy: the whole stored document of OVERRIDES,
 * or `present: false` for "no row", which is every page exactly as it ships (what
 * a reset leaves behind). Typed loosely here for the reason above;
 * `app/lib/site-content.ts` owns the shape and validates a restore again.
 */
export type SiteContentSnapshot = { present: boolean; content: SiteContentShape | null };
type SiteContentShape = {
  pages: Record<
    string,
    {
      seo?: Record<string, string>;
      sections?: Record<string, { hidden?: boolean; fields?: Record<string, unknown> }>;
      order?: string[];
    }
  >;
};

export function siteContentSnapshot(content: SiteContentShape | null): SiteContentSnapshot {
  return content ? { present: true, content } : { present: false, content: null };
}

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
  if (subject === "site_navigation") return summariseNavigation(before as SiteNavigationSnapshot | null, after as SiteNavigationSnapshot);
  if (subject === "site_content") return summariseContent(before as SiteContentSnapshot | null, after as SiteContentSnapshot);
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

/**
 * A copy save in one line, by the names the document uses: which fields were
 * edited, which sections were hidden or shown again, whether the homepage was
 * reordered, and which pages' search-engine text changed.
 *
 * "home: hero.titleLead, pricing.heading, title; hid caseStudy; reordered. faqs:
 * questions.items." Field KEYS rather than the editor's labels, because this
 * module imports nothing — the labels live in `app/lib/site-content.ts`, and a
 * summary that had to be kept in step with them would go stale in silence.
 */
function summariseContent(before: SiteContentSnapshot | null, after: SiteContentSnapshot): string {
  if (!after.present || !after.content) return "Reset to the words the site ships with.";
  const fieldsOf = (snapshot: SiteContentSnapshot | null) => {
    const out = new Map<string, string>();
    if (!snapshot?.present || !snapshot.content) return out;
    for (const [page, body] of Object.entries(snapshot.content.pages ?? {})) {
      for (const [name, value] of Object.entries(body.seo ?? {})) out.set(`${page}\u0000${name}`, String(value));
      for (const [section, state] of Object.entries(body.sections ?? {})) {
        if (state.hidden === true) out.set(`${page}\u0000hidden:${section}`, "hidden");
        for (const [field, value] of Object.entries(state.fields ?? {})) {
          out.set(`${page}\u0000${section}.${field}`, JSON.stringify(value));
        }
      }
      if (body.order?.length) out.set(`${page}\u0000order`, body.order.join(","));
    }
    return out;
  };
  const now = fieldsOf(after);
  const was = fieldsOf(before);
  const perPage = new Map<string, { edited: string[]; hid: string[]; showed: string[]; reordered: boolean }>();
  const entryFor = (page: string) => {
    const found = perPage.get(page) ?? { edited: [], hid: [], showed: [], reordered: false };
    perPage.set(page, found);
    return found;
  };
  for (const [key, value] of now) {
    if (was.get(key) === value) continue;
    const [page, name] = key.split("\u0000");
    const entry = entryFor(page);
    if (name.startsWith("hidden:")) entry.hid.push(name.slice(7));
    else if (name === "order") entry.reordered = true;
    else entry.edited.push(name);
  }
  for (const key of was.keys()) {
    if (now.has(key)) continue;
    const [page, name] = key.split("\u0000");
    const entry = entryFor(page);
    if (name.startsWith("hidden:")) entry.showed.push(name.slice(7));
    else if (name === "order") entry.reordered = true;
    else entry.edited.push(`${name} (back to the shipped words)`);
  }
  const pages = [...perPage]
    .map(([page, entry]) => {
      const parts: string[] = [];
      if (entry.edited.length) parts.push(listed(entry.edited.sort()));
      if (entry.hid.length) parts.push(`hid ${listed(entry.hid.sort())}`);
      if (entry.showed.length) parts.push(`showed ${listed(entry.showed.sort())}`);
      if (entry.reordered) parts.push("reordered the sections");
      return `${page}: ${parts.join("; ")}`;
    })
    .sort();
  const total = now.size;
  if (!pages.length) return `Saved with nothing changed — ${total} override${total === 1 ? "" : "s"} in force.`;
  return `${pages.join(". ")}. ${total} override${total === 1 ? "" : "s"} in force.`;
}

/**
 * A navigation save in one line: what moved, by link label, then the shape.
 * "Added Careers; renamed Pricing; hid Case Study — header 5 links shown, footer 21; 1 hidden."
 */
function summariseNavigation(before: SiteNavigationSnapshot | null, after: SiteNavigationSnapshot): string {
  if (!after.present || !after.navigation) return "Reset to the built-in navigation.";
  const linksOf = (shape: SiteNavigationShape | null) =>
    shape ? [...shape.primary.map((link) => ({ ...link, list: "header" })), ...shape.footer.flatMap((group) => group.links.map((link) => ({ ...link, list: group.id })))] : [];
  const now = linksOf(after.navigation);
  const was = new Map(linksOf(before?.present ? before.navigation : null).map((link) => [link.id, link]));
  const parts: string[] = [];
  const say = (verb: string, labels: string[]) => {
    if (labels.length) parts.push(`${verb} ${listed(labels)}`);
  };
  if (before?.present && before.navigation) {
    const kept = now.filter((link) => was.has(link.id));
    say("added", now.filter((link) => !was.has(link.id)).map((link) => link.label));
    say("removed", [...was.values()].filter((link) => !now.some((entry) => entry.id === link.id)).map((link) => link.label));
    say("renamed", kept.filter((link) => was.get(link.id)?.label !== link.label).map((link) => link.label));
    say("re-pointed", kept.filter((link) => was.get(link.id)?.href !== link.href).map((link) => link.label));
    say("hid", kept.filter((link) => link.hidden && !was.get(link.id)?.hidden).map((link) => link.label));
    say("showed", kept.filter((link) => !link.hidden && was.get(link.id)?.hidden).map((link) => link.label));
    say("moved", kept.filter((link) => was.get(link.id)?.list !== link.list).map((link) => link.label));
    /* A list is "reordered" when the links it had before and still has now come
       in a different order — an addition or a removal alone does not count. */
    const beforeLinks = [...was.values()];
    const sequence = (links: Array<{ id: string; list: string }>, list: string, keep: Set<string>) =>
      links.filter((link) => link.list === list && keep.has(link.id)).map((link) => link.id).join(",");
    const reordered = ["header", ...after.navigation.footer.map((group) => group.id)].filter((list) => {
      const inBoth = new Set(
        now.filter((link) => link.list === list && beforeLinks.some((entry) => entry.id === link.id && entry.list === list)).map((link) => link.id),
      );
      return sequence(beforeLinks, list, inBoth) !== sequence(now, list, inBoth);
    });
    if (reordered.length) parts.push(`reordered ${listed(reordered)}`);
    const headings = after.navigation.footer.filter((group) => before.navigation?.footer.find((entry) => entry.id === group.id)?.heading !== group.heading).map((group) => group.heading);
    say("renamed the heading", headings);
  } else {
    parts.push("Saved the website navigation");
  }
  const every = [...after.navigation.primary, ...after.navigation.footer.flatMap((group) => group.links)];
  const header = after.navigation.primary.filter((link) => !link.hidden).length;
  const footer = every.length - after.navigation.primary.length - after.navigation.footer.flatMap((group) => group.links).filter((link) => link.hidden).length;
  const hidden = every.filter((link) => link.hidden).length;
  const shape = `header ${header} link${header === 1 ? "" : "s"} shown, footer ${footer}${hidden ? `; ${hidden} hidden` : ""}.`;
  const said = parts.length ? parts.join("; ") : "Saved with no change";
  return `${said[0].toUpperCase()}${said.slice(1)} — ${shape}`;
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
    case "site_navigation":
      return { url: "/api/site-navigation", body: { restoreVersion: version } };
    case "site_content":
      return { url: "/api/site-content", body: { restoreVersion: version } };
  }
}

/** A version number from a request body, or null. */
export function restoreVersionFrom(body: unknown): number | null {
  const raw = (body as { restoreVersion?: unknown } | null)?.restoreVersion;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? raw : null;
}
