"use client";

/**
 * THE NARRATIVE PANEL — where a person takes responsibility for the prose.
 *
 * Module 4 §4.3 asks for four things on screen and this component is all four:
 * every AI-drafted block editable inline, a Regenerate button per block, a
 * visible "AI draft — not yet reviewed" badge, and finalisation blocked while
 * any badge is still showing.
 *
 * ── THE BADGE IS THE PRODUCT ───────────────────────────────────────────────
 *
 * Everything else here is a text box. The badge is the part that changes what
 * happens: it is the difference between a document somebody read and a document
 * a machine wrote, and it clears on an EDIT as well as on an accept because
 * editing a sentence is the strongest possible evidence that a human read it.
 * It is a word, not a colour — the state survives greyscale, and a reader who
 * cannot distinguish amber from grey still sees "AI draft — not yet reviewed".
 *
 * ── WHAT HAPPENS WHEN NO PROVIDER IS CONFIGURED ────────────────────────────
 *
 * The panel says so, in the sentence the server wrote, and Regenerate is
 * disabled with that sentence as its title. It does not hide the feature and it
 * does not offer a button that silently does nothing. Everything else keeps
 * working: every block is typed by hand, and the executive summary can be
 * filled from the engine's computed summary in one click.
 *
 * ── WHY THE ORPHAN REFUSAL IS SHOWN IN FULL ────────────────────────────────
 *
 * When the server refuses a draft it returns the tokens it objected to, and
 * they are rendered. An operator told "generation failed" clicks again; an
 * operator shown "the draft said 88% and the data does not contain it"
 * understands what the safeguard is for and — far more usefully — sometimes
 * discovers that the data is the thing that is wrong.
 */

import { useCallback, useEffect, useState } from "react";
import narrativePanelCss from "./narrative-panel.css?url";
import { AI_DRAFT_BADGE } from "../../../lib/reporting/narrative-blocks";
import type {
  NarrativeBlock,
  NarrativeBlockState,
} from "../../../lib/reporting/narrative-blocks";

type ProviderStatus = {
  available: boolean;
  providerLabel: string | null;
  message: string;
};

type OrphanFigure = { kind: string; token: string; canonical: string; index: number };
type Hedge = { word: string; index: number };

type BlockNotice = {
  tone: "error" | "warning" | "ok";
  message: string;
  orphans: OrphanFigure[];
  hedges: Hedge[];
};

type PanelResponse = {
  blocks?: NarrativeBlock[];
  provider?: ProviderStatus;
  reviewComplete?: boolean;
  error?: string;
};

type WriteResponse = PanelResponse & {
  block?: NarrativeBlock;
  validation?: { ok: boolean; orphans: OrphanFigure[]; hedges: Hedge[] } | null;
  orphans?: OrphanFigure[];
  hedges?: Hedge[];
};

const STATE_LABEL: Record<NarrativeBlockState, string> = {
  empty: "Not written",
  "ai-draft": AI_DRAFT_BADGE,
  reviewed: "Reviewed",
};

export function NarrativePanel({
  documentId,
  canEdit,
}: {
  /** Null until the draft has been saved and has a row to hang blocks on. */
  documentId: string | null;
  /** `document.edit`. Read-only callers still see the blocks and the badges. */
  canEdit: boolean;
}) {
  const [blocks, setBlocks] = useState<NarrativeBlock[]>([]);
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notices, setNotices] = useState<Record<string, BlockNotice>>({});
  const [busy, setBusy] = useState<string | null>(null);
  /*
   * The first render IS the loading state, rather than an effect that sets it.
   * The compiler lint refuses a setState that runs synchronously in an effect
   * body — the same note as `holds-panel.tsx`.
   */
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const applyBlocks = useCallback((next: NarrativeBlock[]) => {
    setBlocks(next);
    /* The textareas follow the server on a reload, but a half-typed edit is
       never thrown away by a background refresh — only by an explicit action. */
    setDrafts((current) => {
      const merged: Record<string, string> = {};
      for (const block of next) {
        merged[block.key] = current[block.key] ?? block.prose;
      }
      return merged;
    });
  }, []);

  const load = useCallback(async () => {
    if (!documentId) {
      setLoading(false);
      return;
    }
    try {
      const response = await fetch(
        `/api/reports/documents/${encodeURIComponent(documentId)}/narrative`,
      );
      const payload = (await response.json()) as PanelResponse;
      if (!response.ok) throw new Error(payload.error ?? "The narrative could not be read.");
      applyBlocks(payload.blocks ?? []);
      setProvider(payload.provider ?? null);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The narrative could not be read.");
    } finally {
      setLoading(false);
    }
  }, [applyBlocks, documentId]);

  /* eslint-disable react-hooks/set-state-in-effect -- `load` awaits the fetch
     before it touches state, so nothing runs synchronously in the effect body;
     the rule cannot see through the promise. */
  useEffect(() => {
    void load();
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const noticeFor = useCallback((key: string, notice: BlockNotice | null) => {
    setNotices((current) => {
      const next = { ...current };
      if (notice) next[key] = notice;
      else delete next[key];
      return next;
    });
  }, []);

  const act = useCallback(
    async (key: string, action: string, extra: Record<string, unknown> = {}) => {
      if (!documentId) return;
      setBusy(key);
      noticeFor(key, null);
      try {
        const response = await fetch(
          `/api/reports/documents/${encodeURIComponent(documentId)}/narrative`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action, blockKey: key, ...extra }),
          },
        );
        const payload = (await response.json()) as WriteResponse;

        if (!response.ok) {
          noticeFor(key, {
            tone: "error",
            message: payload.error ?? "That could not be saved.",
            orphans: payload.orphans ?? [],
            hedges: payload.hedges ?? [],
          });
          if (payload.provider) setProvider(payload.provider);
          return;
        }

        if (payload.blocks) applyBlocks(payload.blocks);
        if (payload.block) {
          setDrafts((current) => ({ ...current, [payload.block!.key]: payload.block!.prose }));
        }
        const hedges = payload.validation?.hedges ?? [];
        if (hedges.length > 0) {
          noticeFor(key, {
            tone: "warning",
            message:
              "Saved. This wording rounds or hedges a quantity, which the report's own rules ask you to avoid:",
            orphans: [],
            hedges,
          });
        }
      } catch (caught) {
        noticeFor(key, {
          tone: "error",
          message: caught instanceof Error ? caught.message : "That could not be saved.",
          orphans: [],
          hedges: [],
        });
      } finally {
        setBusy(null);
      }
    },
    [applyBlocks, documentId, noticeFor],
  );

  const awaiting = blocks.filter((block) => block.state === "ai-draft").length;
  const generateHint = provider?.available
    ? undefined
    : (provider?.message ?? "AI drafting is not configured on this deployment.");

  if (!documentId) {
    return (
      <section className="narrative-panel" aria-labelledby="narrative-heading">
        <link rel="stylesheet" href={narrativePanelCss} />
        <header className="narrative-panel__head">
          <h3 id="narrative-heading">Narrative</h3>
          <p className="narrative-panel__summary">
            Save the draft first. The narrative blocks are written against a saved document so
            that every figure in them can be checked against the figures that document holds.
          </p>
        </header>
      </section>
    );
  }

  return (
    <section className="narrative-panel" aria-labelledby="narrative-heading">
      <link rel="stylesheet" href={narrativePanelCss} />

      <header className="narrative-panel__head">
        <h3 id="narrative-heading">Narrative</h3>
        <p className="narrative-panel__summary">
          {loading
            ? "Reading the narrative blocks…"
            : awaiting === 0
              ? `${blocks.length} ${blocks.length === 1 ? "block" : "blocks"} · nothing is awaiting review, so the narrative does not block finalising.`
              : `${awaiting} of ${blocks.length} ${blocks.length === 1 ? "block is" : "blocks are"} an unreviewed AI draft. Finalising is blocked until each one is edited or accepted.`}
        </p>
        <p className="narrative-panel__rule">
          Every figure in a generated block is checked against this report&rsquo;s own data before
          it is stored. A draft containing a figure the data does not hold is refused, not saved.
        </p>
      </header>

      {provider ? (
        <p
          className={`narrative-panel__provider${provider.available ? "" : " narrative-panel__provider--off"}`}
          role="status"
        >
          {provider.message}
        </p>
      ) : null}

      {error ? (
        <p className="narrative-panel__error" role="alert">
          {error}
        </p>
      ) : null}

      <ol className="narrative-panel__list">
        {blocks.map((block) => {
          const notice = notices[block.key];
          const value = drafts[block.key] ?? block.prose;
          const dirty = value.trim() !== block.prose.trim();
          const working = busy === block.key;
          return (
            <li key={block.key} className="narrative-panel__item" data-state={block.state}>
              <div className="narrative-panel__item-head">
                <h4 className="narrative-panel__title">{block.title}</h4>
                <span
                  className={`narrative-panel__badge narrative-panel__badge--${block.state}`}
                  data-state={block.state}
                >
                  {STATE_LABEL[block.state]}
                </span>
              </div>

              <label className="narrative-panel__field">
                <span className="narrative-panel__field-label">Prose</span>
                <textarea
                  value={value}
                  rows={4}
                  disabled={!canEdit || working}
                  placeholder="Write this paragraph, or generate a draft and edit it."
                  onChange={(event) =>
                    setDrafts((current) => ({ ...current, [block.key]: event.target.value }))
                  }
                />
              </label>

              {notice ? (
                <div
                  className={`narrative-panel__notice narrative-panel__notice--${notice.tone}`}
                  role={notice.tone === "error" ? "alert" : "status"}
                >
                  <p>{notice.message}</p>
                  {notice.orphans.length > 0 ? (
                    <ul className="narrative-panel__tokens">
                      {notice.orphans.map((orphan, index) => (
                        <li key={`${orphan.token}-${index}`}>
                          <code>{orphan.token}</code>
                          <span> — {orphan.kind} not present in the data</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {notice.hedges.length > 0 ? (
                    <ul className="narrative-panel__tokens">
                      {notice.hedges.map((hedge, index) => (
                        <li key={`${hedge.word}-${index}`}>
                          <code>{hedge.word}</code>
                          <span> — states a quantity without a figure behind it</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              {canEdit ? (
                <div className="narrative-panel__actions">
                  <button
                    type="button"
                    className="narrative-panel__button narrative-panel__button--primary"
                    disabled={working || !dirty}
                    onClick={() => void act(block.key, "edit", { prose: value })}
                  >
                    {working ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    className="narrative-panel__button"
                    disabled={working || !provider?.available}
                    title={generateHint}
                    onClick={() => void act(block.key, "generate")}
                  >
                    {block.prose ? "Regenerate" : "Generate"}
                  </button>
                  {block.state === "ai-draft" ? (
                    <button
                      type="button"
                      className="narrative-panel__button narrative-panel__button--accept"
                      disabled={working}
                      onClick={() => void act(block.key, "accept")}
                    >
                      Accept as reviewed
                    </button>
                  ) : null}
                  {block.kind === "executive-summary" ? (
                    <button
                      type="button"
                      className="narrative-panel__button"
                      disabled={working}
                      title="Fill this block from the summary the engine computed from the figures. No model is involved."
                      onClick={() => void act(block.key, "use-computed")}
                    >
                      Use the computed summary
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="narrative-panel__button narrative-panel__button--quiet"
                    disabled={working || !block.prose}
                    onClick={() => void act(block.key, "clear")}
                  >
                    Clear
                  </button>
                </div>
              ) : null}

              <p className="narrative-panel__meta">
                {block.state === "ai-draft"
                  ? `Drafted${block.providerId ? ` by ${block.providerId}` : ""}. Read it, then edit or accept it.`
                  : block.source === "deterministic"
                    ? "Computed from the figures in this report. Nothing in it was generated."
                    : block.source === "human"
                      ? `Written${block.updatedByEmail ? ` by ${block.updatedByEmail}` : ""}.`
                      : "Nothing written yet."}
              </p>
            </li>
          );
        })}
      </ol>

      {!loading && blocks.length === 0 ? (
        <p className="narrative-panel__summary">
          This period has no narrative blocks — there are no holds, no open items past target and
          no special projects to describe.
        </p>
      ) : null}
    </section>
  );
}
