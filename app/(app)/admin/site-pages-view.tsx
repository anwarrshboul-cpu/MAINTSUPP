"use client";

/**
 * The website's pages, edited — Master Specification §6–9.
 *
 * BUILT ON THE ADMIN KIT, NOT BESIDE IT. `views/admin-shell.tsx` already owns the
 * four states every platform screen has (loading / loaded / denied / broken), the
 * flash, `adminWrite`, and the `.admin-field` / `.admin-notice` / `.admin-toolbar`
 * styling in `views/admin-console.css`. `tests/platform-admin-shell.test.mjs` has an
 * assertion named for the alternative — "the console does not restate the admin
 * kit's own styling" — so the only new stylesheet here is the block editor's own
 * layout, which the kit has no opinion about.
 *
 * THE EDITOR IS DRIVEN BY THE SERVER'S CATALOGUE, NOT BY A COPY OF IT.
 *
 * `GET /api/site-pages` returns `BLOCK_CATALOGUE` — every block, its label, its
 * fields and each field's rule. This screen renders an input per rule and knows
 * nothing else about what a block is. So a block added in `app/lib/cms-blocks.ts`
 * appears here with its fields and its ceilings, and one retired disappears, with
 * no edit to this file.
 *
 * That is the lesson Phase 6 paid for: a font picker whose options were typed into
 * the panel rather than read from the server is a list that stops agreeing with what
 * the server will accept, and the disagreement shows up as a save that fails for no
 * visible reason.
 *
 * WHY A WHOLE-PAGE SAVE AND NOT FIELD-BY-FIELD.
 *
 * `PUT /api/site-pages` replaces the page and all of its blocks in one write, so the
 * editor stages everything locally and sends it once. A per-field save would mean a
 * page could be half-old and half-new in public while somebody was still typing, and
 * a block reorder has no single field to attach itself to.
 *
 * WHAT THE EDITOR CANNOT DO, SHOWN RATHER THAN HIDDEN. The server also returns
 * `CMS_OMISSIONS`, and this screen prints it. A first slice that lists its own gaps
 * is a first slice; one that leaves the reader to discover them is a feature that
 * claims more than it does.
 */

import { useMemo, useState } from "react";

import { Icon } from "../../components";
import {
  AdminFlash,
  AdminLoading,
  AdminNotice,
  adminWrite,
  useAdminResource,
} from "../portal/views/admin-shell";
import "./site-pages.css";
import { VersionHistory } from "../portal/views/version-history";
import { formatShortDateTime } from "../../lib/format-date";

/* The server's shapes. Mirrored, not imported: `app/lib/cms-blocks.ts` is a server
   module and these are what crosses the wire. */
type FieldRule =
  | { kind: "text"; max: number; required?: boolean }
  | { kind: "href"; required?: boolean }
  | { kind: "lines"; max: number; maxItems: number; required?: boolean }
  | { kind: "pairs"; max: number; maxItems: number; required?: boolean };

type BlockDefinition = {
  kind: string;
  label: string;
  description: string;
  fields: Record<string, FieldRule>;
};

type Block = { id: string; kind: string; position: number; body: Record<string, unknown> };

type Page = {
  id: string;
  slug: string;
  title: string;
  metaTitle: string | null;
  metaDescription: string | null;
  published: boolean;
  publishedAt: string | null;
  updatedByEmail: string | null;
  updatedAt: string;
  blocks: Block[];
};

type Payload = {
  canEdit: boolean;
  pages: Page[];
  catalogue: BlockDefinition[];
  omissions: string[];
};

/** A page being edited. Blocks carry a local key so a reorder does not remount. */
type Draft = {
  original: string | null;
  slug: string;
  title: string;
  metaTitle: string;
  metaDescription: string;
  published: boolean;
  blocks: Array<{ key: string; kind: string; body: Record<string, unknown> }>;
};

let localKey = 0;
const nextKey = () => `b${(localKey += 1)}`;

function draftOf(page: Page | null): Draft {
  if (!page) {
    return {
      original: null,
      slug: "",
      title: "",
      metaTitle: "",
      metaDescription: "",
      published: false,
      blocks: [],
    };
  }
  return {
    original: page.slug,
    slug: page.slug,
    title: page.title,
    metaTitle: page.metaTitle ?? "",
    metaDescription: page.metaDescription ?? "",
    published: page.published,
    blocks: page.blocks.map((block) => ({ key: nextKey(), kind: block.kind, body: { ...block.body } })),
  };
}

const asLines = (value: unknown): string =>
  Array.isArray(value) ? value.filter((entry) => typeof entry === "string").join("\n") : "";

const asPairs = (value: unknown): Array<{ question: string; answer: string }> =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const record = entry as Record<string, unknown>;
        return [
          {
            question: typeof record.question === "string" ? record.question : "",
            answer: typeof record.answer === "string" ? record.answer : "",
          },
        ];
      })
    : [];

/** A human sentence for a rule, so a ceiling is visible before it refuses. */
function hintFor(rule: FieldRule): string {
  if (rule.kind === "href") {
    return "A path beginning / for this site, or a full https:// address. Nothing else is accepted.";
  }
  if (rule.kind === "lines") return `One per line. Up to ${rule.maxItems}, ${rule.max} characters each.`;
  if (rule.kind === "pairs") return `Up to ${rule.maxItems} pairs. Both halves are needed, or the pair is dropped.`;
  return `Up to ${rule.max} characters.`;
}

export function SitePagesView() {
  const { data, loading, denied, error, reload } = useAdminResource<Payload>("/api/site-pages");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [flash, setFlash] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const catalogue = useMemo(() => data?.catalogue ?? [], [data]);
  const definitionOf = (kind: string) => catalogue.find((entry) => entry.kind === kind) ?? null;

  const patchBlock = (key: string, field: string, value: unknown) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            blocks: current.blocks.map((block) =>
              block.key === key ? { ...block, body: { ...block.body, [field]: value } } : block,
            ),
          }
        : current,
    );

  const moveBlock = (key: string, by: number) =>
    setDraft((current) => {
      if (!current) return current;
      const index = current.blocks.findIndex((block) => block.key === key);
      const target = index + by;
      if (index < 0 || target < 0 || target >= current.blocks.length) return current;
      const blocks = [...current.blocks];
      const [moved] = blocks.splice(index, 1);
      blocks.splice(target, 0, moved);
      return { ...current, blocks };
    });

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    const result = await adminWrite("/api/site-pages", "PUT", {
      slug: draft.slug,
      title: draft.title,
      metaTitle: draft.metaTitle || null,
      metaDescription: draft.metaDescription || null,
      published: draft.published,
      blocks: draft.blocks.map((block) => ({ kind: block.kind, body: block.body })),
    });
    setSaving(false);
    setFlash({ ok: result.ok, message: result.message });
    if (result.ok) {
      setDraft(null);
      await reload();
    }
  };

  const remove = async (slug: string) => {
    /* A real delete, so it is confirmed here as well as explained in the audit
       trail. `cms-repository.ts` says why a marketing page is not archived. */
    if (!window.confirm(`Delete /p/${slug}? A published page stops resolving immediately, and this cannot be undone.`)) {
      return;
    }
    const result = await adminWrite(`/api/site-pages?slug=${encodeURIComponent(slug)}`, "DELETE");
    setFlash({ ok: result.ok, message: result.message });
    if (result.ok) {
      setDraft(null);
      await reload();
    }
  };

  if (loading && !data) return <AdminLoading label="Loading the website's pages…" />;

  if (denied) {
    return (
      <AdminNotice tone="denied" icon="shield" title="This screen is for MAINTSUPP platform staff">
        {denied} The server refused this request — the screen is not hidden behind a button.
      </AdminNotice>
    );
  }

  if (error || !data) {
    return (
      <AdminNotice tone="error" icon="alert" title="The website pages could not be loaded">
        {error ?? "That could not be loaded."}
      </AdminNotice>
    );
  }

  return (
    <div className="admin-console cms-admin">
      <AdminFlash flash={flash} onDismiss={() => setFlash(null)} />

      {draft ? (
        <Editor
          draft={draft}
          setDraft={setDraft}
          catalogue={catalogue}
          definitionOf={definitionOf}
          patchBlock={patchBlock}
          moveBlock={moveBlock}
          onSave={save}
          onCancel={() => setDraft(null)}
          onDelete={draft.original ? () => remove(draft.original as string) : null}
          saving={saving}
        />
      ) : null}
      {/* §38b — every saved version of this page, and a way back to any of them.
          A restore goes through the same save (and the same content rules) and is
          recorded as a new version; the editor closes so the list shows the result. */}
      {draft?.original ? (
        <VersionHistory
          subject="site_page"
          subjectKey={draft.original}
          title="Page history"
          onRestored={() => {
            setDraft(null);
            setFlash({ ok: true, message: `Restored /p/${draft.original}. The restore is saved as a new version.` });
            void reload();
          }}
        />
      ) : null}
      {!draft ? (
        <>
          <div className="admin-toolbar">
            <strong>Website pages</strong>
            <span className="admin-toolbar__spacer" />
            <button className="primary-button" type="button" onClick={() => setDraft(draftOf(null))}>
              <Icon name="plus" size={16} /> New page
            </button>
          </div>

          {data.pages.length === 0 ? (
            <AdminNotice tone="empty" icon="document" title="No pages yet">
              The six pages the website has today are built into the code and are not edited here. A page
              created on this screen is published at <code>/p/&lt;slug&gt;</code>.
            </AdminNotice>
          ) : (
            <table className="admin-table cms-admin__list">
              <thead>
                <tr>
                  <th>Page</th>
                  <th>Address</th>
                  <th>State</th>
                  <th>Last saved</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.pages.map((page) => (
                  <tr className={page.published ? undefined : "admin-row--off"} key={page.id}>
                    <td>
                      <strong>{page.title}</strong>
                      <br />
                      <small>
                        {page.blocks.length} block{page.blocks.length === 1 ? "" : "s"}
                      </small>
                    </td>
                    <td>
                      {page.published ? (
                        <a href={`/p/${page.slug}`} rel="noreferrer" target="_blank">
                          /p/{page.slug}
                        </a>
                      ) : (
                        <code>/p/{page.slug}</code>
                      )}
                    </td>
                    <td>
                      <span className={`cms-admin__state cms-admin__state--${page.published ? "live" : "draft"}`}>
                        {page.published ? "Published" : "Draft"}
                      </span>
                    </td>
                    <td>
                      <small>
                        {page.updatedAt.slice(0, 16).replace("T", " ")}
                        {page.updatedByEmail ? ` · ${page.updatedByEmail}` : ""}
                      </small>
                    </td>
                    <td>
                      <button className="secondary-button admin-mini" type="button" onClick={() => setDraft(draftOf(page))}>
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* §38b — pages deleted since history began, each restorable from the
              version before its deletion. */}
          <DeletedPages
            onRestored={(slug) => {
              setFlash({ ok: true, message: `Brought back /p/${slug} as a new version.` });
              void reload();
            }}
          />

          {/* The server's own list of what this slice does not do. Printed rather
              than restated, so it cannot drift from the code that means it. */}
          <AdminNotice tone="info" icon="alert" title="What this editor does not do yet">
            <ul className="cms-admin__omissions">
              {data.omissions.map((omission) => (
                <li key={omission}>{omission}</li>
              ))}
            </ul>
          </AdminNotice>
        </>
      ) : null}
    </div>
  );
}

type DeletedPayload = { deleted: Array<{ key: string; deletedAt: string; deletedBy: string | null; version: number }> };

/** §38b — the pages whose latest version is a deletion, each with its history. */
function DeletedPages({ onRestored }: { onRestored: (slug: string) => void }) {
  const { data, reload } = useAdminResource<DeletedPayload>("/api/versions?subject=site_page&deleted=1");
  if (!data || data.deleted.length === 0) return null;
  return (
    <div className="cms-admin__deleted">
      <strong>Deleted pages</strong>
      <p>
        <small>Restore the version before a page&rsquo;s deletion to bring it back at the same address.</small>
      </p>
      {data.deleted.map((entry) => (
        <div key={entry.key} className="cms-admin__deleted-row">
          <code>/p/{entry.key}</code>{" "}
          <small>
            deleted {formatShortDateTime(entry.deletedAt)}
            {entry.deletedBy ? ` · ${entry.deletedBy}` : ""}
          </small>
          <VersionHistory
            subject="site_page"
            subjectKey={entry.key}
            title="Versions"
            onRestored={() => {
              onRestored(entry.key);
              void reload();
            }}
          />
        </div>
      ))}
    </div>
  );
}

function Editor({
  draft,
  setDraft,
  catalogue,
  definitionOf,
  patchBlock,
  moveBlock,
  onSave,
  onCancel,
  onDelete,
  saving,
}: {
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft | null>>;
  catalogue: BlockDefinition[];
  definitionOf: (kind: string) => BlockDefinition | null;
  patchBlock: (key: string, field: string, value: unknown) => void;
  moveBlock: (key: string, by: number) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: (() => void) | null;
  saving: boolean;
}) {
  const [adding, setAdding] = useState(catalogue[0]?.kind ?? "");

  const addBlock = () => {
    const definition = definitionOf(adding);
    if (!definition) return;
    setDraft((current) =>
      current ? { ...current, blocks: [...current.blocks, { key: nextKey(), kind: definition.kind, body: {} }] } : current,
    );
  };

  return (
    <>
      <div className="admin-toolbar">
        <button className="secondary-button admin-mini" type="button" onClick={onCancel}>
          <Icon name="arrow" size={16} /> All pages
        </button>
        <strong>{draft.original ? `Editing /p/${draft.original}` : "New page"}</strong>
        <span className="admin-toolbar__spacer" />
        {onDelete ? (
          <button className="secondary-button admin-mini admin-mini--danger" type="button" onClick={onDelete}>
            Delete
          </button>
        ) : null}
        <button className="primary-button" disabled={saving} type="button" onClick={onSave}>
          {saving ? "Saving…" : draft.published ? "Save and publish" : "Save as draft"}
        </button>
      </div>

      <div className="admin-panel cms-admin__meta">
        <label className="admin-field">
          <span>Address</span>
          <input
            onChange={(event) => setDraft((current) => (current ? { ...current, slug: event.target.value } : current))}
            placeholder="how-we-work"
            value={draft.slug}
          />
          <small>
            Lowercase letters, digits and single hyphens. The page is served at /p/ plus this. Changing it on a
            published page changes its address, and the old one stops resolving.
          </small>
        </label>

        <label className="admin-field">
          <span>Title</span>
          <input
            onChange={(event) => setDraft((current) => (current ? { ...current, title: event.target.value } : current))}
            value={draft.title}
          />
          <small>The heading at the top of the page, and the browser tab unless a meta title is set.</small>
        </label>

        <label className="admin-field">
          <span>Meta title</span>
          <input
            onChange={(event) =>
              setDraft((current) => (current ? { ...current, metaTitle: event.target.value } : current))
            }
            value={draft.metaTitle}
          />
          <small>
            What a search result shows. Leave it empty to use the title. Do not add &quot;| MAINTSUPP&quot; — it is
            added for you, and typing it would ship it twice.
          </small>
        </label>

        <label className="admin-field admin-field--grow">
          <span>Meta description</span>
          <textarea
            onChange={(event) =>
              setDraft((current) => (current ? { ...current, metaDescription: event.target.value } : current))
            }
            rows={3}
            value={draft.metaDescription}
          />
          <small>The sentence under the title in a search result. Up to 320 characters.</small>
        </label>

        <label className="admin-field cms-admin__publish">
          <span>Published</span>
          <select
            onChange={(event) =>
              setDraft((current) => (current ? { ...current, published: event.target.value === "yes" } : current))
            }
            value={draft.published ? "yes" : "no"}
          >
            <option value="no">Draft — only this console can see it</option>
            <option value="yes">Published — anyone with the address can read it</option>
          </select>
          <small>There is no preview address for a draft. A draft is not reachable from the public website.</small>
        </label>
      </div>

      {draft.blocks.length === 0 ? (
        <AdminNotice tone="empty" icon="document" title="This page has no blocks">
          A page is a stack of blocks. Add the first one below.
        </AdminNotice>
      ) : null}

      {draft.blocks.map((block, index) => {
        const definition = definitionOf(block.kind);
        return (
          <div className="admin-panel cms-admin__block" key={block.key}>
            <div className="cms-admin__block-head">
              <strong>{definition?.label ?? block.kind}</strong>
              <small>{definition?.description ?? "This block is no longer in the catalogue."}</small>
              <span className="admin-toolbar__spacer" />
              <button
                className="secondary-button admin-mini"
                disabled={index === 0}
                onClick={() => moveBlock(block.key, -1)}
                type="button"
              >
                Up
              </button>
              <button
                className="secondary-button admin-mini"
                disabled={index === draft.blocks.length - 1}
                onClick={() => moveBlock(block.key, 1)}
                type="button"
              >
                Down
              </button>
              <button
                className="secondary-button admin-mini"
                onClick={() =>
                  setDraft((current) =>
                    current ? { ...current, blocks: current.blocks.filter((entry) => entry.key !== block.key) } : current,
                  )
                }
                type="button"
              >
                Remove
              </button>
            </div>

            {definition
              ? Object.entries(definition.fields).map(([name, rule]) => (
                  <BlockField
                    key={name}
                    name={name}
                    onChange={(value) => patchBlock(block.key, name, value)}
                    rule={rule}
                    value={block.body[name]}
                  />
                ))
              : null}
          </div>
        );
      })}

      <div className="admin-toolbar">
        <label className="admin-field">
          <span>Add a block</span>
          <select onChange={(event) => setAdding(event.target.value)} value={adding}>
            {catalogue.map((definition) => (
              <option key={definition.kind} value={definition.kind}>
                {definition.label} — {definition.description}
              </option>
            ))}
          </select>
        </label>
        <button className="secondary-button" onClick={addBlock} type="button">
          <Icon name="plus" size={16} /> Add
        </button>
      </div>
    </>
  );
}

/**
 * One field, rendered from its rule.
 *
 * A `text` rule becomes an input or a textarea depending on its ceiling, because a
 * 1,200-character paragraph in a single-line input is unreadable and a 60-character
 * button label in a textarea invites a line break the renderer will not honour.
 */
function BlockField({
  name,
  rule,
  value,
  onChange,
}: {
  name: string;
  rule: FieldRule;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const label = name.replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase());

  if (rule.kind === "pairs") {
    const pairs = asPairs(value);
    return (
      <div className="cms-admin__pairs">
        <span className="cms-admin__pairs-label">
          {label}
          {rule.required ? " (required)" : ""}
        </span>
        {pairs.map((pair, index) => (
          <div className="cms-admin__pair" key={index}>
            <label className="admin-field">
              <span>Question</span>
              <input
                onChange={(event) =>
                  onChange(pairs.map((entry, at) => (at === index ? { ...entry, question: event.target.value } : entry)))
                }
                value={pair.question}
              />
            </label>
            <label className="admin-field admin-field--grow">
              <span>Answer</span>
              <textarea
                onChange={(event) =>
                  onChange(pairs.map((entry, at) => (at === index ? { ...entry, answer: event.target.value } : entry)))
                }
                rows={2}
                value={pair.answer}
              />
            </label>
            <button
              className="secondary-button admin-mini"
              onClick={() => onChange(pairs.filter((_, at) => at !== index))}
              type="button"
            >
              Remove
            </button>
          </div>
        ))}
        <button
          className="secondary-button admin-mini"
          disabled={pairs.length >= rule.maxItems}
          onClick={() => onChange([...pairs, { question: "", answer: "" }])}
          type="button"
        >
          <Icon name="plus" size={16} /> Add a question
        </button>
        <small>{hintFor(rule)}</small>
      </div>
    );
  }

  if (rule.kind === "lines") {
    return (
      <label className="admin-field admin-field--grow">
        <span>
          {label}
          {rule.required ? " (required)" : ""}
        </span>
        <textarea
          onChange={(event) => onChange(event.target.value.split("\n").filter((line) => line.trim()))}
          rows={Math.min(10, Math.max(3, asLines(value).split("\n").length + 1))}
          value={asLines(value)}
        />
        <small>{hintFor(rule)}</small>
      </label>
    );
  }

  const text = typeof value === "string" ? value : "";
  const long = rule.kind === "text" && rule.max > 200;
  return (
    <label className={long ? "admin-field admin-field--grow" : "admin-field"}>
      <span>
        {label}
        {rule.required ? " (required)" : ""}
      </span>
      {long ? (
        <textarea onChange={(event) => onChange(event.target.value)} rows={3} value={text} />
      ) : (
        <input
          onChange={(event) => onChange(event.target.value)}
          placeholder={rule.kind === "href" ? "/contractors" : undefined}
          value={text}
        />
      )}
      <small>{hintFor(rule)}</small>
    </label>
  );
}
