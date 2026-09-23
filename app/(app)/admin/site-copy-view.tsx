"use client";

/**
 * The built-in pages' copy, edited — decision L (§77 item 9).
 *
 * The homepage, `/contractors` and `/faqs`: their headings, introductions, notes,
 * the hero's kicker, headline halves, trust chips, button labels and photograph,
 * the shared questions, each page's search-engine title and description, and —
 * on the homepage — which sections are shown and in what order.
 *
 * EVERY RULE IS THE SERVER'S. `GET /api/site-content` carries the pages, the
 * sections, every field with its kind, its ceiling and the words the site ships
 * with, plus the anchors the navigation currently needs. This screen draws them,
 * stages the whole document locally and sends it once; a refusal arrives as the
 * server's own sentence from `validateSiteContent`. The two things checked here as
 * well — the length of a box and whether "Hide" is offered — are drawn from those
 * same numbers, so they cannot disagree with the refusal; they only say so before
 * the Save rather than after.
 *
 * EVERY BOX SHOWS WHAT A VISITOR READS, which is the shipped words until someone
 * changes them. Emptying a box is how the shipped words come back: the server
 * stores only what DIFFERS, so "cleared" and "never edited" are one state. Each
 * changed field says so, with a way back to the original beside it.
 *
 * WHOLE-DOCUMENT SAVE, CONDITIONAL — the save names the revision it was opened
 * at, so a second editor's save in between is refused (409) rather than silently
 * overwritten.
 */

import { useMemo, useState } from "react";

import { Icon } from "../../components";
import { formatShortDateTime } from "../../lib/format-date";
import { useUnsavedChanges } from "../../lib/use-unsaved-changes";
import { AdminFlash, AdminLoading, AdminNotice, adminWrite, useAdminResource } from "../portal/views/admin-shell";
import { VersionHistory } from "../portal/views/version-history";
import { MediaField } from "./media-picker";
import "./site-pages.css";
import "./site-copy.css";

/* The server's shapes, mirrored: what crosses the wire. */
type Question = { q: string; a: string };
type FieldValue = string | string[] | Question[];

type FieldSpec = {
  key: string;
  label: string;
  kind: "line" | "paragraph" | "label" | "lines" | "pairs" | "media";
  max: number;
  maxItems: number | null;
  maxSecond: number | null;
  help: string | null;
  shipped: FieldValue;
};

type SectionSpec = {
  key: string;
  label: string;
  anchor: string | null;
  fixed: string | null;
  fields: FieldSpec[];
};

type PageSpec = {
  key: string;
  label: string;
  path: string;
  seo: { title: string; description: string; socialDescription?: string };
  titleIsAbsolute: boolean;
  sections: SectionSpec[];
};

type StoredSection = { hidden?: boolean; fields?: Record<string, FieldValue> };
type StoredPage = { seo?: Record<string, string>; sections?: Record<string, StoredSection>; order?: string[] };

type Payload = {
  canEdit: boolean;
  stored: boolean;
  revision: number | null;
  updatedAt: string | null;
  updatedByEmail: string | null;
  content: { pages: Record<string, StoredPage> };
  pages: PageSpec[];
  home: { order: string[]; movable: string[] };
  navigationNeeds: Record<string, string>;
  omissions: string[];
  cacheSeconds: number;
};

/** The editor's whole state: what is in every box, plus the page-level decisions. */
type Draft = {
  fields: Record<string, FieldValue>;
  seo: Record<string, string>;
  hidden: Record<string, boolean>;
  order: string[];
};

const at = (page: string, section: string, field: string) => `${page}/${section}/${field}`;
const sectionAt = (page: string, section: string) => `${page}/${section}`;

/** Every box filled with what a visitor reads now: the saved value, or the shipped one. */
function openDraft(data: Payload): Draft {
  const fields: Record<string, FieldValue> = {};
  const seo: Record<string, string> = {};
  const hidden: Record<string, boolean> = {};
  for (const page of data.pages) {
    const stored = data.content.pages[page.key];
    for (const [name, shipped] of Object.entries(page.seo)) {
      seo[`${page.key}/${name}`] = stored?.seo?.[name] ?? (shipped as string);
    }
    for (const section of page.sections) {
      hidden[sectionAt(page.key, section.key)] = stored?.sections?.[section.key]?.hidden === true;
      for (const field of section.fields) {
        const saved = stored?.sections?.[section.key]?.fields?.[field.key];
        fields[at(page.key, section.key, field.key)] = structuredClone(saved ?? field.shipped);
      }
    }
  }
  return {
    fields,
    seo,
    hidden,
    order: data.content.pages.home?.order?.length ? [...data.content.pages.home.order] : [...data.home.movable],
  };
}

/**
 * The document to send. Everything is sent, including values equal to the shipped
 * words — the server drops those, which is what makes an emptied box a revert
 * rather than a blank page.
 */
function documentFrom(data: Payload, draft: Draft) {
  const pages: Record<string, StoredPage> = {};
  for (const page of data.pages) {
    const body: StoredPage = { seo: {}, sections: {} };
    for (const name of Object.keys(page.seo)) body.seo![name] = draft.seo[`${page.key}/${name}`] ?? "";
    for (const section of page.sections) {
      const entry: StoredSection = { fields: {} };
      if (draft.hidden[sectionAt(page.key, section.key)]) entry.hidden = true;
      for (const field of section.fields) {
        entry.fields![field.key] = draft.fields[at(page.key, section.key, field.key)] ?? "";
      }
      body.sections![section.key] = entry;
    }
    if (page.key === "home") body.order = draft.order;
    pages[page.key] = body;
  }
  return { pages };
}

const same = (left: FieldValue, right: FieldValue) => JSON.stringify(left) === JSON.stringify(right);

export function SiteCopyView() {
  const { data, loading, denied, error, reload } = useAdminResource<Payload>("/api/site-content");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [page, setPage] = useState("home");
  const [flash, setFlash] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  /* What the server has, as boxes; recomputed only when the payload changes. */
  const pristine = useMemo(() => (data ? openDraft(data) : null), [data]);
  /* The local copy, kept only while it belongs to the revision it was opened at —
     a save, a reset or a restore moves the revision on and the boxes re-fill from
     the server rather than from a draft written against an older state. */
  const revisionKey = data ? `${data.revision ?? "none"}` : null;
  const working = draft && opened === revisionKey ? draft : pristine;
  const dirty = Boolean(working && pristine && JSON.stringify(working) !== JSON.stringify(pristine));
  const confirmLeave = useUnsavedChanges(dirty);

  const change = (update: (current: Draft) => void) => {
    if (!data) return;
    const base = structuredClone(working ?? openDraft(data));
    update(base);
    setOpened(revisionKey);
    setDraft(base);
  };

  const save = async () => {
    if (!data || !working) return;
    setSaving(true);
    const result = await adminWrite("/api/site-content", "PUT", {
      content: documentFrom(data, working),
      expectedRevision: data.revision,
    });
    setSaving(false);
    setFlash({
      ok: result.ok,
      message: result.ok
        ? `Saved. The site shows it now for you, and for every visitor within ${data.cacheSeconds} seconds.`
        : result.message,
    });
    if (result.ok) {
      setDraft(null);
      setOpened(null);
      await reload();
    }
  };

  const reset = async () => {
    if (!data) return;
    if (!window.confirm("Put every page back to the words the site ships with? What is saved now stays in the version history and can be restored.")) {
      return;
    }
    setSaving(true);
    const result = await adminWrite("/api/site-content", "PUT", { reset: true, expectedRevision: data.revision });
    setSaving(false);
    setFlash({ ok: result.ok, message: result.ok ? "Back to the words the site ships with." : result.message });
    if (result.ok) {
      setDraft(null);
      setOpened(null);
      await reload();
    }
  };

  if (loading && !data) return <AdminLoading label="Loading the website's copy…" />;
  if (denied) {
    return (
      <AdminNotice tone="denied" icon="shield" title="This screen is for MAINTSUPP platform staff">
        {denied} The server refused this request — the screen is not hidden behind a button.
      </AdminNotice>
    );
  }
  if (error || !data || !working) {
    return (
      <AdminNotice tone="error" icon="alert" title="The website copy could not be loaded">
        {error ?? "That could not be loaded."}
      </AdminNotice>
    );
  }

  const spec = data.pages.find((entry) => entry.key === page) ?? data.pages[0];
  const changedCount = pristine
    ? Object.keys(working.fields).filter((key) => !same(working.fields[key], pristine.fields[key])).length
    : 0;

  /** One field's control, by kind. */
  const control = (pageKey: string, section: SectionSpec, field: FieldSpec) => {
    const key = at(pageKey, section.key, field.key);
    const value = working.fields[key];
    const edited = pristine ? !same(value, field.shipped) : false;
    const set = (next: FieldValue) =>
      change((current) => {
        current.fields[key] = next;
      });

    return (
      <div className="site-copy__field" key={field.key}>
        <div className="site-copy__field-head">
          <span className="site-copy__field-label">{field.label}</span>
          {edited && (
            <button
              type="button"
              className="secondary-button admin-mini"
              onClick={() => set(structuredClone(field.shipped))}
            >
              Use the shipped words
            </button>
          )}
        </div>

        {field.kind === "paragraph" && (
          <textarea
            className="site-copy__area"
            rows={4}
            maxLength={field.max}
            value={typeof value === "string" ? value : ""}
            onChange={(event) => set(event.target.value)}
          />
        )}

        {(field.kind === "line" || field.kind === "label") && (
          <input
            maxLength={field.max}
            value={typeof value === "string" ? value : ""}
            onChange={(event) => set(event.target.value)}
          />
        )}

        {field.kind === "media" && (
          <MediaField
            accept="image"
            value={typeof value === "string" ? value : ""}
            onChange={(next) => set(typeof next === "string" ? next : "")}
          />
        )}

        {field.kind === "lines" && Array.isArray(value) && (
          <ol className="site-copy__lines">
            {(field.shipped as string[]).map((shippedLine, index) => (
              <li key={index}>
                <input
                  maxLength={field.max}
                  value={typeof value[index] === "string" ? (value[index] as string) : ""}
                  placeholder={shippedLine}
                  onChange={(event) =>
                    set((value as string[]).map((entry, position) => (position === index ? event.target.value : entry)))
                  }
                />
              </li>
            ))}
          </ol>
        )}

        {field.kind === "pairs" && Array.isArray(value) && (
          <div className="site-copy__pairs">
            {(value as Question[]).map((pair, index) => (
              <div className="site-copy__pair" key={index}>
                <label className="admin-field">
                  <span>Question {index + 1}</span>
                  <input
                    maxLength={field.max}
                    value={pair.q}
                    onChange={(event) =>
                      set((value as Question[]).map((entry, position) => (position === index ? { ...entry, q: event.target.value } : entry)))
                    }
                  />
                </label>
                <label className="admin-field">
                  <span>Answer</span>
                  <textarea
                    rows={3}
                    maxLength={field.maxSecond ?? field.max}
                    value={pair.a}
                    onChange={(event) =>
                      set((value as Question[]).map((entry, position) => (position === index ? { ...entry, a: event.target.value } : entry)))
                    }
                  />
                </label>
                <div className="site-copy__pair-actions">
                  <button
                    type="button"
                    className="secondary-button admin-mini"
                    aria-label={`Move question ${index + 1} up`}
                    disabled={index === 0}
                    onClick={() =>
                      set(
                        (value as Question[]).flatMap((entry, position) =>
                          position === index - 1 ? [(value as Question[])[index], entry] : position === index ? [] : [entry],
                        ),
                      )
                    }
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="secondary-button admin-mini admin-mini--danger"
                    aria-label={`Remove question ${index + 1}`}
                    disabled={(value as Question[]).length <= 3}
                    onClick={() => set((value as Question[]).filter((_, position) => position !== index))}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
            <button
              type="button"
              className="secondary-button"
              disabled={(value as Question[]).length >= (field.maxItems ?? 0)}
              onClick={() => set([...(value as Question[]), { q: "", a: "" }])}
            >
              <Icon name="plus" size={16} /> Add a question
            </button>
          </div>
        )}

        {field.help && <small className="site-copy__help">{field.help}</small>}
      </div>
    );
  };

  const moveSection = (key: string, by: number) =>
    change((current) => {
      const index = current.order.indexOf(key);
      const target = index + by;
      if (index < 0 || target < 0 || target >= current.order.length) return;
      const [moved] = current.order.splice(index, 1);
      current.order.splice(target, 0, moved);
    });

  /** The sections of the page being edited, in the order they are drawn. */
  const sectionsInOrder = (): SectionSpec[] => {
    if (spec.key !== "home") return spec.sections;
    const byKey = new Map(spec.sections.map((section) => [section.key, section]));
    const movable = new Set(data.home.movable);
    const out: SectionSpec[] = [];
    let placed = false;
    for (const key of data.home.order) {
      if (!movable.has(key)) {
        const section = byKey.get(key);
        if (section) out.push(section);
        continue;
      }
      if (placed) continue;
      placed = true;
      for (const moved of working.order) {
        const section = byKey.get(moved);
        if (section) out.push(section);
      }
    }
    return out;
  };

  return (
    <div className="admin-console cms-admin site-copy">
      <AdminFlash flash={flash} onDismiss={() => setFlash(null)} />

      <div className="admin-toolbar">
        <strong>Website copy</strong>
        <span className="admin-subtle">
          {data.stored
            ? `Saved ${data.updatedAt ? formatShortDateTime(data.updatedAt) : ""}${data.updatedByEmail ? ` by ${data.updatedByEmail}` : ""}`
            : "The words the site ships with — nothing has been saved here yet."}
        </span>
        <span className="admin-toolbar__spacer" />
        {dirty && (
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              if (confirmLeave()) {
                setDraft(null);
                setOpened(null);
              }
            }}
          >
            Discard changes
          </button>
        )}
        {data.stored && !dirty && (
          <button className="secondary-button" type="button" disabled={saving} onClick={() => void reset()}>
            Reset every page
          </button>
        )}
        <button className="primary-button" type="button" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save copy"}
        </button>
      </div>

      <nav className="site-copy__tabs" aria-label="Pages">
        {data.pages.map((entry) => (
          <button
            key={entry.key}
            type="button"
            className={`site-copy__tab${entry.key === spec.key ? " site-copy__tab--on" : ""}`}
            aria-current={entry.key === spec.key ? "page" : undefined}
            onClick={() => setPage(entry.key)}
          >
            {entry.label}
            <small>{entry.path}</small>
          </button>
        ))}
      </nav>

      <p className="site-copy__intro" role="status">
        {changedCount === 0
          ? "Every box below holds the words the site ships with."
          : `${changedCount} field${changedCount === 1 ? "" : "s"} differ${changedCount === 1 ? "s" : ""} from the shipped words across the three pages.`}{" "}
        A save shows on the site straight away for you, and for every visitor within {data.cacheSeconds} seconds.
      </p>

      <section className="admin-panel site-copy__panel" aria-labelledby="site-copy-seo">
        <h2 id="site-copy-seo" className="site-copy__heading">
          What search engines and shared links show
        </h2>
        <label className="admin-field">
          <span>Title</span>
          <input
            maxLength={70}
            value={working.seo[`${spec.key}/title`] ?? ""}
            onChange={(event) =>
              change((current) => {
                current.seo[`${spec.key}/title`] = event.target.value;
              })
            }
          />
          <small>
            {spec.titleIsAbsolute
              ? "Used exactly as written — this page opts out of the “| MAINTSUPP” suffix the rest of the site gets."
              : "The site adds “ | MAINTSUPP” once; leave it out here."}
          </small>
        </label>
        <label className="admin-field">
          <span>Description</span>
          <textarea
            className="site-copy__area"
            rows={3}
            maxLength={200}
            value={working.seo[`${spec.key}/description`] ?? ""}
            onChange={(event) =>
              change((current) => {
                current.seo[`${spec.key}/description`] = event.target.value;
              })
            }
          />
          <small>Around 155 characters is what a search result shows.</small>
        </label>
        {spec.seo.socialDescription !== undefined && (
          <label className="admin-field">
            <span>Shared-link description</span>
            <textarea
              className="site-copy__area"
              rows={2}
              maxLength={200}
              value={working.seo[`${spec.key}/socialDescription`] ?? ""}
              onChange={(event) =>
                change((current) => {
                  current.seo[`${spec.key}/socialDescription`] = event.target.value;
                })
              }
            />
            <small>The shorter line that shows when the page is shared. Left alone, it follows the description above.</small>
          </label>
        )}
        <p className="site-copy__fixed">
          <Icon name="shield" size={14} /> The page&apos;s address, its canonical link, what crawlers are told about
          indexing and the site&apos;s structured data are code, not copy, and cannot be changed here.
        </p>
      </section>

      {sectionsInOrder().map((section) => {
        const key = sectionAt(spec.key, section.key);
        const isHidden = working.hidden[key] === true;
        const needed = section.anchor ? data.navigationNeeds[section.anchor] : undefined;
        const movable = spec.key === "home" && !section.fixed;
        return (
          <section
            key={section.key}
            className={`admin-panel site-copy__panel${isHidden ? " site-copy__panel--hidden" : ""}`}
            aria-labelledby={`site-copy-${spec.key}-${section.key}`}
          >
            <div className="site-copy__section-head">
              <h2 id={`site-copy-${spec.key}-${section.key}`} className="site-copy__heading">
                {section.label}
                {section.anchor && <small> #{section.anchor}</small>}
              </h2>
              <div className="site-copy__section-actions">
                {section.fixed ? (
                  <span className="site-copy__lock">
                    <Icon name="shield" size={14} /> Always shown, in this position — {section.fixed}
                  </span>
                ) : (
                  <>
                    <label className="site-copy__toggle" title={needed ?? undefined}>
                      <input
                        type="checkbox"
                        checked={!isHidden}
                        disabled={Boolean(needed) && !isHidden}
                        onChange={(event) =>
                          change((current) => {
                            current.hidden[key] = !event.target.checked;
                          })
                        }
                      />
                      Shown on the page
                    </label>
                    {movable && (
                      <>
                        <button
                          type="button"
                          className="secondary-button admin-mini"
                          aria-label={`Move ${section.label} up`}
                          disabled={working.order.indexOf(section.key) <= 0}
                          onClick={() => moveSection(section.key, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="secondary-button admin-mini"
                          aria-label={`Move ${section.label} down`}
                          disabled={working.order.indexOf(section.key) === working.order.length - 1}
                          onClick={() => moveSection(section.key, 1)}
                        >
                          ↓
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>

            {needed && !section.fixed && (
              <p className="site-copy__note">
                {needed} points at this section, so it cannot be hidden — the link would scroll nowhere. Hide or re-point
                it on the Navigation screen first.
              </p>
            )}

            {section.fields.length === 0 ? (
              <p className="site-copy__note">
                This section has no copy of its own — it is a form, and its labels are code.
              </p>
            ) : (
              section.fields.map((field) => control(spec.key, section, field))
            )}
          </section>
        );
      })}

      <section className="admin-panel site-copy__panel" aria-labelledby="site-copy-omissions">
        <h2 id="site-copy-omissions" className="site-copy__heading">
          What this screen does not do
        </h2>
        <ul className="site-copy__omissions">
          {data.omissions.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      {/* §38 — every saved version of the copy, and a way back to any of them. A
          restore goes through the same save, the same rules and the same media
          check, and is recorded as a new version. */}
      <VersionHistory
        subject="site_content"
        subjectKey="public"
        title="Copy history"
        onRestored={() => {
          setDraft(null);
          setOpened(null);
          setFlash({ ok: true, message: "Restored. The restore is saved as a new version." });
          void reload();
        }}
      />
    </div>
  );
}
