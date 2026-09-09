import type { FormQuestion } from "../../../db/monday-board-spec";

/**
 * MULTI-PAGE FORMS, AND EVERY REORDER THAT IS NOT A SWAP.
 *
 * ── WHY A PAGE IS A QUESTION AND NOT A NEW FIELD ──────────────────────────
 *
 * monday's form is a flat list with `PAGE_BLOCK` markers in it, and the captured
 * configuration in `db/monday-board-spec.ts` already carries one at the head of
 * `order` — `page_block__classic_default`. So the product has had the vocabulary
 * for pages since the import; what it did not have was a second marker, and any
 * code that could cope with one.
 *
 * Modelling a page as a marker INSIDE `order` rather than as a new
 * `config.pages` array is the difference between a change that ships and one
 * that needs a server release. `PATCH /api/board/form` accepts exactly the
 * sections named in its `PatchBody`, and `formUndoBody()` in form-builder-save.ts
 * must send every one of them — `tests/form-undo.test.mjs` reads both and fails
 * the day they disagree. `questions` and `order` are already in both lists, so a
 * page break persists, restores and undoes with no route change, no new field,
 * and no new hole in the undo contract. A `config.pages` array would have been
 * none of those things.
 *
 * It also degrades honestly. `projectQuestions()` in app/lib/form-projection.ts
 * filters `type !== "PAGE_BLOCK"`, so a form with three pages served by a
 * renderer that has not learnt about pages yet is the same form on one long
 * page — every question, in the same order, all of it answerable. A separate
 * `pages` array would have been silently ignored instead, which is the failure
 * mode that loses a submitter's answers rather than their pagination.
 *
 * ── WHY ORDERING LIVES HERE AND NOT IN THE PANEL ──────────────────────────
 *
 * The Edit panel used to reorder by swapping two entries of a list it had built
 * with the page blocks REMOVED, then re-prefixing every page block it could
 * find:
 *
 *     const pageBlocks = form.config.order.filter(… type === "PAGE_BLOCK" …);
 *     patch({ order: [...pageBlocks, ...order] });
 *
 * With one page block that is correct. With two it collapses the form: both
 * markers are hoisted to the front, page two loses its break, and every question
 * lands on page one. So pages and reordering could not be built separately —
 * they are the same operation over the same array, and that array is the flat
 * one WITH the markers in it. Every function here works on that array, which is
 * exactly what gets PATCHed back.
 */

/** monday's marker. Not a question: it is a container that starts a page. */
export const PAGE_BLOCK = "PAGE_BLOCK";

/** The slice of a stored config these helpers read. Structural, so the real
    `StoredFormConfig` satisfies it and this file imports nothing at runtime. */
export type PagedConfig = {
  order: string[];
  questions: FormQuestion[];
};

export type FormPage = {
  /** The page block's own question id. `null` for the implicit leading page. */
  id: string | null;
  /** What the operator called it. Empty for the implicit page. */
  title: string;
  /** 1-based, as a submitter would count them. */
  number: number;
  /** The questions on this page, in order — page blocks excluded. */
  questions: FormQuestion[];
};

/**
 * The flat order, repaired.
 *
 * Two repairs, both of which mirror what `projectQuestions` already does on the
 * server so the builder and the public form cannot disagree about what exists:
 *
 *   · an id in `order` with no question behind it is dropped, because a
 *     dangling id is what a delete leaves and it must not become a gap; and
 *   · a question that `order` never mentions is APPENDED rather than lost — a
 *     question added by a migration, or by an older build, is still asked.
 *
 * Page blocks are kept. That is the whole point: this is the array the panel
 * edits and the array `PATCH … { order }` receives.
 */
export function fullOrder(config: PagedConfig): string[] {
  const byId = new Map(config.questions.map((question) => [question.id, question]));
  const seen = new Set<string>();
  const order: string[] = [];
  for (const id of config.order) {
    if (!byId.has(id) || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  for (const question of config.questions) {
    if (!seen.has(question.id)) order.push(question.id);
  }
  return order;
}

/** The questions in flat order, page blocks included. */
export function orderedEntries(config: PagedConfig): FormQuestion[] {
  const byId = new Map(config.questions.map((question) => [question.id, question]));
  return fullOrder(config)
    .map((id) => byId.get(id))
    .filter((question): question is FormQuestion => Boolean(question));
}

/**
 * The form as a reader meets it: pages, each with its own questions.
 *
 * A configuration whose order does NOT begin with a page block still produces a
 * page — an implicit one with a null id. That is not a hypothetical: a form
 * whose only page block was deleted, or one derived before this module existed,
 * would otherwise have questions belonging to no page at all, and every caller
 * would need its own answer for them.
 */
export function pagesOf(config: PagedConfig): FormPage[] {
  const pages: FormPage[] = [];
  let current: FormPage | null = null;
  for (const entry of orderedEntries(config)) {
    if (entry.type === PAGE_BLOCK) {
      current = { id: entry.id, title: entry.title, number: pages.length + 1, questions: [] };
      pages.push(current);
      continue;
    }
    if (!current) {
      current = { id: null, title: "", number: 1, questions: [] };
      pages.push(current);
    }
    current.questions.push(entry);
  }
  /* A form with no questions at all still has one page to add them to. */
  if (!pages.length) pages.push({ id: null, title: "", number: 1, questions: [] });
  return pages;
}

/**
 * Question id → the 0-based page it is on.
 *
 * The one function that lets a RENDERER page a form without re-deriving the
 * page model. The renderer works from the projected public payload, which has
 * already dropped hidden questions and the page blocks themselves, so it cannot
 * see where the breaks were; this maps back to them by id. Preview uses it
 * today, and it is what the public page's own paging will use when the renderer
 * learns about pages — one implementation of "which page is this on", so the
 * two mounts cannot disagree about where a form breaks.
 */
export function pageIndexById(config: PagedConfig): Map<string, number> {
  const index = new Map<string, number>();
  let page = 0;
  let started = false;
  for (const entry of orderedEntries(config)) {
    if (entry.type === PAGE_BLOCK) {
      /* The first break opens page 0 rather than advancing past it: every
         captured configuration begins with one, and counting it as a boundary
         would leave page 0 permanently empty. */
      if (started) page += 1;
      started = true;
      continue;
    }
    started = true;
    index.set(entry.id, page);
  }
  return index;
}

/** Every question a submitter is asked, page breaks removed. */
export function questionsOf(config: PagedConfig): FormQuestion[] {
  return orderedEntries(config).filter((entry) => entry.type !== PAGE_BLOCK);
}

/**
 * WHERE A QUESTION MAY BE PUT — the slots, named.
 *
 * A slot is an INDEX INTO THE FLAT ORDER, so "the end of page 2" and "before the
 * first question of page 3" are the same position and are offered once rather
 * than twice. Naming them here is what lets the insertion control and the
 * "Move to…" control be the same list read two ways, instead of two hand-rolled
 * position calculations that drift.
 */
export type OrderSlot = {
  /** Index into `fullOrder` at which the entry would be spliced. */
  index: number;
  /** 1-based page the slot belongs to. */
  page: number;
  /** What the slot is called in a menu — "Before Location", "End of page 2". */
  label: string;
};

export function orderSlots(config: PagedConfig): OrderSlot[] {
  const entries = orderedEntries(config);
  const slots: OrderSlot[] = [];
  let page = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.type === PAGE_BLOCK) {
      /* The slot BEFORE a page break belongs to the page that is ending, and is
         the one a reader means by "at the end of page N". Emitted before the
         page counter moves, or every "end of page" would be off by one. */
      if (page > 0) {
        slots.push({ index, page, label: `At the end of page ${page}` });
      }
      page += 1;
      continue;
    }
    if (page === 0) page = 1;
    slots.push({ index, page, label: `Before “${entry.title}”` });
  }
  slots.push({
    index: entries.length,
    page: Math.max(page, 1),
    label: page > 1 ? `At the end of page ${page}` : "At the end",
  });
  return slots;
}

/**
 * Move one entry to a slot.
 *
 * The index is interpreted against the order BEFORE the removal — which is how
 * a person reads a menu of positions — so the correction below is not an
 * off-by-one guard, it is the translation between the two. Without it, moving a
 * question downwards always landed one place short of the slot it named.
 */
export function moveTo(order: string[], id: string, slotIndex: number): string[] {
  const from = order.indexOf(id);
  if (from < 0) return order;
  const rest = [...order.slice(0, from), ...order.slice(from + 1)];
  const to = Math.max(0, Math.min(rest.length, slotIndex > from ? slotIndex - 1 : slotIndex));
  return [...rest.slice(0, to), id, ...rest.slice(to)];
}

/** Move an entry one place up or down, page breaks counted as places. */
export function nudge(order: string[], id: string, direction: -1 | 1): string[] {
  const from = order.indexOf(id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= order.length) return order;
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** Splice a new id into the flat order at a slot. */
export function insertAt(order: string[], id: string, slotIndex: number): string[] {
  const without = order.filter((entry) => entry !== id);
  const to = Math.max(0, Math.min(without.length, slotIndex));
  return [...without.slice(0, to), id, ...without.slice(to)];
}

/**
 * A page break, as a question.
 *
 * The id is minted rather than taken from a column, because a page is the one
 * entry that binds to nothing on the board — it is chrome, and the submit route
 * never sees it (`projectQuestions` drops the type outright). `page_block_`
 * prefixed so it reads as what it is in a stored blob somebody is debugging.
 */
export function newPageBlock(title: string, suffix: string): FormQuestion {
  return {
    id: `page_block_${suffix}`,
    type: PAGE_BLOCK,
    title: title.trim().slice(0, 120) || "Page",
    description: null,
    visible: true,
    required: false,
    options: null,
    showIf: null,
  };
}

/**
 * Remove a page break WITHOUT removing its questions.
 *
 * Deleting a page has to mean "merge these questions into the page before",
 * never "delete these questions". The questions are already in the flat order
 * on the far side of the marker, so dropping the marker alone is exactly that
 * merge — which is the second reason the flat model is the right one.
 */
export function removePageBlock(config: PagedConfig, pageId: string): PagedConfig {
  return {
    questions: config.questions.filter((question) => question.id !== pageId),
    order: fullOrder(config).filter((id) => id !== pageId),
  };
}
