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
  const [historyDepth, setHistoryDepth] = useState(0);

  /*
   * Refs rather than state for everything the timer touches. A debounced save
   * fires from a closure created 800ms ago; if it read state it would send the
   * body it was created with rather than the latest one, so two edits inside
   * the window would persist only the first.
   */
  const timer = useRef<number | null>(null);
  const pending = useRef<Record<string, unknown> | null>(null);
  const history = useRef<BuilderForm[]>([]);
  const inFlight = useRef(false);
  /* The form as it was before the pending change, captured once per batch so
     Undo restores the state a person recognises rather than the previous
     keystroke. */
  const before = useRef<BuilderForm | null>(null);
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
        setFailure({
          message: payload.error || "That change could not be saved.",
          retryable: payload.retry === true,
        });
        setState("failed");
        return;
      }
      if (payload.form) setForm(payload.form);
      /* Only now is the pre-change form worth keeping: a definition that never
         reached the server is not a state anybody can return to. */
      if (before.current) {
        history.current = [...history.current, before.current].slice(-FORM_HISTORY_LIMIT);
        setHistoryDepth(history.current.length);
        before.current = null;
      }
      succeeded = true;
      setFailure(null);
      setState(pending.current ? "unsaved" : "saved");
    } catch (caught) {
      // Merged, not assigned, for the reason given on the arm above.
      pending.current = { ...body, ...(pending.current ?? {}) };
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
      if (!before.current && form) before.current = form;
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
    const previous = history.current[history.current.length - 1];
    if (!previous) return;
    history.current = history.current.slice(0, -1);
    setHistoryDepth(history.current.length);
    /*
     * Sent as a save of its own, and immediately. Undo that only changed the
     * screen would be a lie the next reload corrects. The named sections are
     * the ones `PATCH /api/board/form` accepts; anything absent is left alone
     * by the route, which is why this can restore a definition without also
     * restating the form's title or its access settings.
     */
    before.current = null;
    pending.current = {
      questions: previous.config.questions,
      order: previous.config.order,
      features: previous.config.features,
      appearance: previous.config.appearance,
    };
    void flush();
  }, [flush]);

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
      if (!history.current.length) return;
      event.preventDefault();
      undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

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
      canUndo: historyDepth > 0,
      dismiss,
    }),
    [save, state, failure, retry, undo, historyDepth, dismiss],
  );
}
