import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BuilderForm } from "./form-builder-model";

/**
 * AUTOSAVE THAT CANNOT LOSE AN AFTERNOON.
 *
 * The form editor has always saved on every change and never had a Save
 * button, which is the right model. What it did not have was any way to tell
 * whether a save had happened. `busy` existed and reached exactly two places —
 * `aria-busy` on an input, and `disabled` on a switch — so a save that failed
 * put a sentence in a banner and a save that succeeded said nothing at all.
 * There was no debounce, no history, and no way back.
 *
 * That is a bad arrangement on any write path and an actively dangerous one on
 * THIS write path. The board's configuration writes fail under load: Supabase's
 * session-mode pooler refuses connections when the project is at its client
 * limit, 181 times in twenty days on the live project, and every route that
 * touches Postgres fails together while it lasts — see `busyRefusal` in
 * `app/lib/tenant-db.ts`. So "the save quietly did not happen" is not a
 * hypothetical here; it is the measured failure mode, and it is the one that
 * costs somebody their afternoon.
 *
 * ── WHAT THIS OWNS ────────────────────────────────────────────────────────
 *
 *   - one state a toolbar can render: saved / saving / unsaved / failed
 *   - a debounce for typing, and none at all for a discrete action
 *   - a history stack, so a save is reversible
 *   - the browser's own unsaved-changes warning, armed only when it is true
 *
 * It deliberately does NOT own the form. `setForm` stays with the component,
 * because the server returns the whole saved form and taking its answer rather
 * than a locally guessed one is what stops the panel drifting from what was
 * stored.
 */

/** How many steps back Undo can go. The brief asks for at least twenty. */
export const FORM_HISTORY_LIMIT = 25;

/** Debounce for keystrokes. A discrete action does not wait — see `save`. */
export const FORM_SAVE_DEBOUNCE_MS = 800;

/**
 * THE SECTIONS A PATCH ACCEPTS THAT AN UNDO CANNOT PUT BACK.
 *
 * Named, exported and tested rather than left as an absence, because "undo
 * covers everything except…" is only trustworthy if the exceptions are written
 * down where a reader — and `tests/form-undo.test.mjs` — can check them against
 * `PatchBody` in `app/api/board/form/route.ts`.
 *
 *   - `password`  the browser is only ever told `hasPassword`. The hash never
 *                 leaves the server (deliberately: see `serialiseForm`), and no
 *                 amount of history gives us back a plaintext we never had.
 *   - `regenerateToken`  a verb, not a field. It MINTS new locators and the old
 *                 pair is gone from the row; there is no PATCH that sets a share
 *                 token back to a chosen value, and inventing one would mean a
 *                 revoked link could be un-revoked by anyone with `board.edit`.
 *
 * Neither leaves a hole in the history, because neither changes what
 * `formUndoBody` projects: a save that only sets a password, or only rotates
 * the link, produces NO undo step at all rather than one that silently does
 * nothing when pressed.
 */
export const FORM_UNRESTORABLE_SECTIONS = ["password", "regenerateToken"] as const;

/**
 * A WHOLE FORM DEFINITION AS A PATCH BODY — the one description of "everything
 * a person can change and therefore everything an Undo has to put back".
 *
 * This exists because the first Undo restored four keys — `questions`, `order`,
 * `features`, `appearance` — and the editor writes twelve. So changing the
 * response limit, the close date, the title, the description, the language, the
 * tags, or deactivating the form, all produced an Undo button that appeared to
 * work: it sent a PATCH, the toolbar said "All changes saved", and the field the
 * person had just changed stayed changed. Reported against `responseLimit`;
 * seven other fields had the same hole and no reporter.
 *
 * Naming the fields to INCLUDE rather than spreading the form and deleting what
 * cannot be sent is the same rule `publicForm()` follows on the server, for the
 * same reason: `responseCount`, `shareToken`, `shortToken`, `shareUrl`,
 * `presentedUrl`, `hasPassword`, `boardKey` and `filesIntoThisBoard` are all
 * server-derived, and a spread would post them back as if they were settings.
 *
 * `PATCH /api/board/form` applies only the sections it is sent and leaves the
 * rest of the row exactly as stored, which is what lets this be a complete
 * restore rather than a whole-document PUT that would clobber the two fields
 * above it deliberately does not carry.
 */
export function formUndoBody(form: BuilderForm): Record<string, unknown> {
  return {
    title: form.title,
    description: form.description,
    active: form.active,
    requireLogin: form.requireLogin,
    responseLimit: form.responseLimit,
    closeAt: form.closeAt,
    /* The question list itself — add, remove, retitle, the required flag, the
       per-question help text, `showIf` and every per-question setting all live
       inside these objects, so they travel with it. */
    questions: form.config.questions,
    /* Reorder. Sent alongside `questions` because a removal that did not also
       send the order would leave a dangling id, and `orderedQuestions` would
       then draw the survivors in the wrong sequence. */
    order: form.config.order,
    /* Availability, the welcome page, the confirmation page, the redirect and
       the routing (`features.board.itemGroupId`) are all keys of this object. */
    features: form.config.features,
    /* The Design panel, whole. */
    appearance: form.config.appearance,
    accessibility: form.config.accessibility,
    tags: form.config.tags,
  };
}

/**
 * Whether two saved forms are the same DEFINITION.
 *
 * Compared over `formUndoBody` rather than over the whole form, which is the
 * point: it is exactly the set of fields an Undo can put back, so two forms
 * that compare equal here are two forms no Undo could tell apart. That makes
 * this the right test for "is there anything to remember?" —
 *
 *   - a submission arriving between two saves moves `responseCount` and must
 *     not become a history step;
 *   - a password change or a link rotation must not become one either, because
 *     Undo cannot reverse them (see `FORM_UNRESTORABLE_SECTIONS`) and a step
 *     that does nothing when pressed is worse than no step;
 *   - typing a character and deleting it again inside one debounce window
 *     persists, but persists the state it started from.
 *
 * Both sides are built by the same function from the same server projection, so
 * key order is stable and a string comparison is sound. It can only ever be
 * WRONG in the safe direction: two different definitions cannot serialise
 * identically, so the failure mode is one history step too many, never one too
 * few.
 */
export function sameFormDefinition(a: BuilderForm, b: BuilderForm): boolean {
  return JSON.stringify(formUndoBody(a)) === JSON.stringify(formUndoBody(b));
}

export type FormSaveState = "saved" | "saving" | "unsaved" | "failed";

export type FormSaveFailure = {
  message: string;
  /**
   * Whether repeating the request could work, from the SERVER's own `retry`
   * flag rather than inferred from a status code. A full connection pool and a
   * revoked permission are both refusals; only one of them is worth a button.
   */
  retryable: boolean;
};

export type FormSave = {
  /**
   * Queue a change.
   *
   * `immediate` for anything discrete — adding, removing, reordering, toggling
   * — because those are single decisions and waiting 800ms to persist one is
   * just a window in which it can be lost. Typing debounces, because saving on
   * every keystroke is a request per character against a pooler that is
   * already the bottleneck.
   */
  save: (body: Record<string, unknown>, options?: { immediate?: boolean }) => void;
  state: FormSaveState;
  failure: FormSaveFailure | null;
  /** Re-send the change that failed, unchanged. */
  retry: () => void;
  /** Restore the previous definition. Itself a save. */
  undo: () => void;
  canUndo: boolean;
  /** Dismiss a failure without retrying it. The change stays in `pending`. */
  dismiss: () => void;
};

/**
 * The word a person reads. Kept here so the toolbar, a toast and a screen
 * reader cannot describe the same state three ways.
 */
export function formSaveLabel(state: FormSaveState): string {
  switch (state) {
    case "saving":
      return "Saving…";
    case "unsaved":
      return "Not saved";
    case "failed":
      return "Not saved";
    default:
      return "All changes saved";
  }
}

type Options = {
  boardId: string;
  form: BuilderForm | null;
  setForm: (form: BuilderForm) => void;
};

export function useFormSave({ boardId, form, setForm }: Options): FormSave {
  const [state, setState] = useState<FormSaveState>("saved");
  const [failure, setFailure] = useState<FormSaveFailure | null>(null);
  /**
   * How far back Undo can go AND WHOSE HISTORY IT IS.
   *
   * The board is carried alongside the depth because `boardId` changes without
   * this hook unmounting — `form-builder.tsx` says so in as many words, and
   * fixing that on the load path is what `pending` there is for. A depth on its
   * own would leave the Undo button live after the switch, pointed at a stack
   * of ANOTHER register's definitions; pressing it would have written one
   * board's questions, title and share settings over another board's form. The
   * pair is state rather than a ref because `canUndo` is read during render.
   */
  const [undoable, setUndoable] = useState<{ depth: number; board: string | null }>({
    depth: 0,
    board: null,
  });

  /*
   * Refs rather than state for everything the timer touches. A debounced save
   * fires from a closure created 800ms ago; if it read state it would send the
   * body it was created with rather than the latest one, so two edits inside
   * the window would persist only the first.
   */
  const timer = useRef<number | null>(null);
  const pending = useRef<Record<string, unknown> | null>(null);
  const history = useRef<BuilderForm[]>([]);
  /* The register `history` was recorded against. Mirrored into `undoable`. */
  const historyBoard = useRef<string | null>(null);
  const inFlight = useRef(false);
  /*
   * WHERE AN UNDO WOULD GO BACK TO, TRACKED AS TWO SLOTS RATHER THAN ONE.
   *
   * There was one — `before` — captured on the first `save` of a batch and
   * cleared when that batch's response came back. That is correct exactly while
   * saves do not overlap, and they do overlap: `save` fires immediately for
   * every discrete action, so a second toggle pressed during the first one's
   * round trip queues a batch whose restore point nobody has captured. What
   * happened then was that the single slot had already been consumed by the
   * request in the air, so the second change entered NO history at all — two
   * edits, one step back, and one persisted state silently unreachable.
   *
   *   - `inFlightBefore` belongs to the request currently in the air.
   *   - `pendingBefore` belongs to the batch composing in `pending`.
   *   - `awaitingBefore` says the batch in `pending` began DURING a request, so
   *     its restore point is that request's answer — a state that does not
   *     exist yet. It is filled in when the response lands, which is what keeps
   *     the two entries in chronological order rather than inverted.
   */
  const pendingBefore = useRef<BuilderForm | null>(null);
  const inFlightBefore = useRef<BuilderForm | null>(null);
  const awaitingBefore = useRef(false);
  /*
   * The tail re-flush below has to reach THIS function, and a `useCallback`
   * that names itself is a cycle the React Compiler cannot memoise — it fails
   * `react-hooks/preserve-manual-memoization` outright. Held in a ref instead,
   * which is also the more honest description of what is wanted: not recursion,
   * but "whatever the current flush is, run it again once this one is done".
   */
  const flushRef = useRef<() => void>(() => {});

  const flush = useCallback(async () => {
    const body = pending.current;
    if (!body || inFlight.current) return;
    pending.current = null;
    /* The batch's restore point travels WITH the request it belongs to, so a
       batch queued while this one is in the air starts with an empty slot of
       its own rather than inheriting — or overwriting — this one's. */
    inFlightBefore.current = pendingBefore.current;
    pendingBefore.current = null;
    inFlight.current = true;
    setState("saving");
    /*
     * WHETHER THIS ATTEMPT SUCCEEDED, tracked in a local rather than read back
     * off `state` in the tail guard below.
     *
     * The first version asked `state !== "failed"` there and it was wrong in a
     * way only a browser could show: `state` in that closure is whatever it was
     * when the callback was BUILT, which is "saved". So a failed save — which
     * puts its body back in `pending` so Retry has something to send — was
     * immediately re-sent by the guard, and the second attempt succeeded and
     * cleared the banner. The editor swallowed the induced 503 and reported
     * "All changes saved", which is precisely the silent failure this whole
     * module exists to make impossible. Caught by intercepting the PATCH in
     * Chromium and watching the indicator, not by reading the code.
     */
    let succeeded = false;
    try {
      const response = await fetch(`/api/board/form?board=${encodeURIComponent(boardId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        form?: BuilderForm;
        error?: string;
        retry?: boolean;
      };
      if (!response.ok) {
        /*
         * THE CHANGE IS KEPT. Putting it back in `pending` is what makes Retry
         * mean something and what stops a failed save discarding the edit —
         * the whole point of the exercise. `state` goes to "failed" rather
         * than "unsaved" so the toolbar can offer the reason and the button.
         *
         * MERGED UNDER anything queued while this request was in the air, not
         * assigned over it. `body` was captured before the fetch; a straight
         * assignment discarded every edit made during the round trip. Add a
         * question, reorder it while the PATCH is in flight, have the PATCH
         * fail: the reorder vanished, Retry re-sent only the add, it
         * succeeded, and the toolbar said "All changes saved" — the silent
         * loss this module exists to prevent, arriving through its own
         * recovery path. Later keys win, because they are later.
         */
        pending.current = { ...body, ...(pending.current ?? {}) };
        /*
         * AND SO DOES ITS RESTORE POINT. The failed change and anything queued
         * behind it are now ONE batch, so the state to go back to is the
         * EARLIER of the two — the one this request started from. Taking the
         * later one would leave the failed edit unreachable by Undo after a
         * successful Retry, which is the same lost step in a different disguise.
         */
        pendingBefore.current = inFlightBefore.current ?? pendingBefore.current;
        inFlightBefore.current = null;
        /* A concrete restore point beats a promised one: the answer that was
           going to supply it never came. */
        if (pendingBefore.current) awaitingBefore.current = false;
        setFailure({
          message: payload.error || "That change could not be saved.",
          retryable: payload.retry === true,
        });
        setState("failed");
        return;
      }
      if (payload.form) setForm(payload.form);
      /*
       * Only now is the pre-change form worth keeping: a definition that never
       * reached the server is not a state anybody can return to.
       *
       * `settled` falls back to the restore point for the `{ ok, unchanged }`
       * answer the route gives a body it recognised nothing in — the state did
       * not move, so the state it did not move from is what the next batch
       * would undo to.
       */
      const restorePoint = inFlightBefore.current;
      const settled = payload.form ?? restorePoint;
      inFlightBefore.current = null;
      if (restorePoint && settled && !sameFormDefinition(restorePoint, settled)) {
        /*
         * HISTORY BELONGS TO ONE REGISTER — see `undoable` above. Reset rather
         * than appended when the board has moved, so the first save on the new
         * register starts a stack of its own instead of extending the previous
         * one's, and a snapshot that names another board is never pushed at all.
         */
        if (historyBoard.current !== boardId) {
          history.current = [];
          historyBoard.current = boardId;
        }
        if (!restorePoint.boardKey || restorePoint.boardKey === boardId) {
          history.current = [...history.current, restorePoint].slice(-FORM_HISTORY_LIMIT);
        }
        setUndoable({ depth: history.current.length, board: boardId });
      }
      /*
       * THE QUEUED BATCH'S RESTORE POINT IS THIS ANSWER, and this is the line
       * that keeps two overlapping saves in chronological order. Edit A goes to
       * the server, edit B is made while it is in the air; B's "before" is not
       * the form B was typed over — that one is already stale — it is the form
       * the server made of A. Filled in here because here is the first moment
       * it exists.
       */
      if (awaitingBefore.current && settled) {
        pendingBefore.current = settled;
        awaitingBefore.current = false;
      }
      succeeded = true;
      setFailure(null);
      setState(pending.current ? "unsaved" : "saved");
    } catch (caught) {
      // Merged, not assigned, for the reason given on the arm above.
      pending.current = { ...body, ...(pending.current ?? {}) };
      // And the earlier restore point survives with it, likewise.
      pendingBefore.current = inFlightBefore.current ?? pendingBefore.current;
      inFlightBefore.current = null;
      if (pendingBefore.current) awaitingBefore.current = false;
      // Nothing answered at all, so there is nothing to distinguish — a
      // dropped connection is always worth one more try.
      setFailure({
        message: caught instanceof Error ? caught.message : "That change could not be saved.",
        retryable: true,
      });
      setState("failed");
    } finally {
      inFlight.current = false;
      /* A change queued WHILE this one was in flight has to go now, or it sits
         in `pending` with no timer behind it and the editor reports "Not
         saved" for ever. Gated on this attempt having SUCCEEDED, so a failure
         waits for the person to press Retry instead of quietly repeating
         itself — see the note on `succeeded`. */
      if (succeeded && pending.current) flushRef.current();
    }
  }, [boardId, setForm]);

  useEffect(() => {
    flushRef.current = () => void flush();
  }, [flush]);

  const save = useCallback(
    (body: Record<string, unknown>, options: { immediate?: boolean } = {}) => {
      /*
       * WHERE THIS BATCH WOULD UNDO TO, decided once per batch so that one
       * Undo returns one state a person recognises rather than one keystroke.
       *
       * The two arms are the whole of the overlap fix. With nothing in the air,
       * `form` IS the last persisted state, because this editor never applies a
       * change locally — it replaces its state from the server's answer. With a
       * request in the air, `form` is a state that is already being replaced,
       * so the slot is left empty and marked: the answer will fill it.
       */
      if (inFlight.current) {
        if (!pendingBefore.current) awaitingBefore.current = true;
      } else if (!pendingBefore.current && form) {
        pendingBefore.current = form;
        awaitingBefore.current = false;
      }
      pending.current = { ...(pending.current ?? {}), ...body };
      setState("unsaved");
      if (timer.current !== null) window.clearTimeout(timer.current);
      if (options.immediate) {
        timer.current = null;
        void flush();
        return;
      }
      timer.current = window.setTimeout(() => {
        timer.current = null;
        void flush();
      }, FORM_SAVE_DEBOUNCE_MS);
    },
    [flush, form],
  );

  const retry = useCallback(() => {
    setFailure(null);
    void flush();
  }, [flush]);

  const dismiss = useCallback(() => setFailure(null), []);

  const undo = useCallback(() => {
    /*
     * REFUSED WHILE A SAVE IS IN THE AIR, which is what the toolbar already
     * draws — it hides the button while `state === "saving"`. The keyboard
     * shortcut has to obey the same rule or it is a second, less careful Undo:
     * the step this one would take back is the one currently being written, and
     * its restore point is not in `history` yet.
     */
    if (inFlight.current) return;
    const previous = history.current[history.current.length - 1];
    if (!previous || historyBoard.current !== boardId) return;
    history.current = history.current.slice(0, -1);
    setUndoable({ depth: history.current.length, board: boardId });
    /*
     * AN UNDO IS NOT ITSELF A CHANGE TO REMEMBER. Clearing all three slots is
     * what stops the state being left behind from entering the stack: with it
     * there, a second Undo would walk FORWARD into the state the first one was
     * pressed to escape, and the history would read as an inversion rather than
     * a line. The pending timer goes too — a debounced keystroke that has not
     * been sent is superseded by a complete definition.
     */
    pendingBefore.current = null;
    inFlightBefore.current = null;
    awaitingBefore.current = false;
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    /*
     * Sent as a save of its own, and immediately. Undo that only changed the
     * screen would be a lie the next reload corrects. `formUndoBody` decides
     * what a complete restore is — every section `PATCH /api/board/form`
     * accepts except the two it cannot, which are named and explained on
     * `FORM_UNRESTORABLE_SECTIONS`. Anything absent is left alone by the route,
     * which is why this can restore a definition without also overwriting the
     * password or the share token.
     */
    pending.current = formUndoBody(previous);
    void flush();
  }, [flush, boardId]);

  /*
   * THE BROWSER'S OWN WARNING, ARMED ONLY WHEN IT IS TRUE.
   *
   * A `beforeunload` handler that is always registered makes every navigation
   * ask, which teaches people to dismiss it — and then it is worth nothing on
   * the day it matters. Registered only while something is genuinely unsaved.
   */
  useEffect(() => {
    if (state !== "unsaved" && state !== "failed") return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Assigning returnValue is what still triggers the prompt in Chrome and
      // Safari; `preventDefault` alone is the spec but not yet the behaviour.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state]);

  /* Ctrl/Cmd+Z while the editor has focus. Ignored where the browser's own
     undo is the right one — inside a field somebody is typing in. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      /* The same three refusals `undo` makes, asked before `preventDefault` —
         a shortcut that swallows the key and then does nothing takes the
         browser's own Undo away and gives nothing back. */
      if (inFlight.current || historyBoard.current !== boardId) return;
      if (!history.current.length) return;
      event.preventDefault();
      undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, boardId]);

  /*
   * A PENDING CHANGE MUST NOT BE DROPPED BECAUSE THE BOARD SWITCHED.
   *
   * This cleared the timer and said in a comment that it flushed. It did not,
   * and the gap was reachable: `FormBuilder` is mounted only while the Form tab
   * is the active view (`board-view-pane.tsx`), so clicking another tab
   * unmounts it — and `beforeunload` does not fire for an in-app navigation. A
   * Design change made inside the 800ms window and followed by a tab click was
   * simply gone, with nothing on screen having said so. It could not be lost
   * that way before this module existed, because the write was immediate.
   *
   * Flushed through the ref, so it reaches the current `flush` rather than a
   * stale closure. React's development StrictMode mounts, unmounts and remounts
   * once; a flush here is idempotent in that case because `flush` clears
   * `pending` before it sends and refuses to run while `inFlight`.
   */
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      if (pending.current) flushRef.current();
    },
    [],
  );

  return useMemo(
    () => ({
      save,
      state,
      failure,
      retry,
      undo,
      /* Both halves, or the button is live for the wrong register — see
         `undoable`. */
      canUndo: undoable.depth > 0 && undoable.board === boardId,
      dismiss,
    }),
    [save, state, failure, retry, undo, undoable, boardId, dismiss],
  );
}
