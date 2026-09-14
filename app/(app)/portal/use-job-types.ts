"use client";

/**
 * THE ORGANISATION'S JOB TYPES, IN THE BROWSER — read once, shared, re-read
 * when they change.
 *
 * Several places on one page want the list at once: the new-request dialog's
 * picker, the drawer's Job type field, the Settings card and the Jobs drill's
 * chip labels. Each mounting its own `fetch` would be four identical round
 * trips, and on the Jobs board — which already opens eight requests at once
 * and is where the pooler's capacity runs out first — that is not free. So
 * there is ONE store here, the way `client-capabilities.ts` memoises
 * `/api/context`, and every hook reads it.
 *
 * WHEN IT RE-READS. A write through `/api/job-types` announces itself with the
 * window event `maintsupp:job-types-changed` (see `announceJobTypesChanged`),
 * and the store fetches again. A client switch reloads the page, so the cache
 * can never outlive the workspace it describes.
 *
 * WHAT IT DOES NOT DO. It never decides what a job may be set to — the server
 * does that (`resolveJobTypeWrite`), including the rule that a deactivated type
 * is kept on a job that already has it and refused for anything new. The
 * helpers below only decide what to OFFER, and they offer by the same rule.
 */

import { useMemo, useSyncExternalStore } from "react";
import { UNCLASSIFIED_LABEL, type JobType } from "../../lib/job-type-contract";

/** The window event a write through `/api/job-types` dispatches. */
export const JOB_TYPES_CHANGED = "maintsupp:job-types-changed";

type Snapshot = {
  /** Every type, deactivated included, in the administrator's order. */
  jobTypes: JobType[];
  /** True once a read has succeeded at least once. */
  loaded: boolean;
  /** The last read's failure, cleared by the next success. */
  error: string | null;
};

const EMPTY: Snapshot = { jobTypes: [], loaded: false, error: null };

let snapshot: Snapshot = EMPTY;
let inflight: Promise<void> | null = null;
/** Bumped by every read that starts, so a slow answer cannot overwrite a newer one. */
let generation = 0;
/** How many mounted readers asked for the list (as opposed to merely listening). */
let loaders = 0;
const listeners = new Set<() => void>();

function publish(next: Snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

async function read(): Promise<void> {
  const mine = ++generation;
  try {
    const response = await fetch("/api/job-types", { headers: { Accept: "application/json" } });
    const payload = (await response.json().catch(() => ({}))) as {
      jobTypes?: JobType[];
      error?: string;
    };
    if (mine !== generation) return;
    if (!response.ok || !Array.isArray(payload.jobTypes)) {
      publish({ ...snapshot, error: payload.error ?? "The job types could not be read." });
      return;
    }
    publish({ jobTypes: payload.jobTypes, loaded: true, error: null });
  } catch {
    if (mine === generation) {
      publish({ ...snapshot, error: "The job types could not be read." });
    }
  }
}

/** Fetch the list again. Concurrent callers share the one request in flight. */
export function refreshJobTypes(): Promise<void> {
  if (!inflight) {
    inflight = read().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/**
 * Hand the store a list the caller already holds — the answer to its own write
 * — so the screen that made the change does not wait a round trip to show it.
 */
export function primeJobTypes(jobTypes: JobType[]) {
  generation += 1;
  publish({ jobTypes, loaded: true, error: null });
}

/** Tell every reader on the page that the types changed. They re-read. */
export function announceJobTypesChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(JOB_TYPES_CHANGED));
}

function onChanged() {
  void refreshJobTypes();
}

/* A subscriber that does not ask for the list: it hears a read somebody else
   made, and never starts one of its own. */
function subscribeQuietly(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/*
 * A subscriber that WANTS the list: the first one reads it, and while any of
 * them is mounted the store listens for the change event. Counted apart from
 * `listeners`, because a quiet subscriber mounted first must not stop the
 * event being heard once a loading one arrives. A failed read is retried by
 * the next reader to mount rather than cached for the life of the page.
 */
function subscribeAndLoad(listener: () => void) {
  listeners.add(listener);
  loaders += 1;
  if (loaders === 1) window.addEventListener(JOB_TYPES_CHANGED, onChanged);
  if (!snapshot.loaded && !inflight) void refreshJobTypes();
  return () => {
    listeners.delete(listener);
    loaders -= 1;
    if (loaders === 0) window.removeEventListener(JOB_TYPES_CHANGED, onChanged);
  };
}

const serverSnapshot = () => EMPTY;
const clientSnapshot = () => snapshot;

/**
 * The organisation's job types.
 *
 * `enabled: false` reads whatever the store already holds without fetching —
 * for a caller that only needs the list in a rare state (the Jobs drill, which
 * only names a type when the URL carries one) and should not add a request to
 * every page load for it.
 */
export function useJobTypes(enabled = true) {
  const current = useSyncExternalStore(
    enabled ? subscribeAndLoad : subscribeQuietly,
    clientSnapshot,
    serverSnapshot,
  );
  const activeJobTypes = useMemo(
    () => current.jobTypes.filter((type) => type.active),
    [current.jobTypes],
  );
  return {
    jobTypes: current.jobTypes,
    activeJobTypes,
    loaded: current.loaded,
    error: current.error,
    refresh: refreshJobTypes,
  };
}

/**
 * What a picker for ONE job offers: every active type, plus the job's own type
 * when it has been deactivated — so re-saving an old job never silently drops
 * what it was filed under, and a retired type is never offered to anything
 * else. The same rule `resolveJobTypeWrite` enforces on the server.
 */
export function jobTypeChoices(
  jobTypes: readonly JobType[],
  currentId: string | null | undefined,
): JobType[] {
  return jobTypes.filter((type) => type.active || (currentId ? type.id === currentId : false));
}

/**
 * What to call a job's type on screen. Null is "Unclassified"; a retired type
 * is named and marked; an id the list does not hold (yet) is said honestly
 * rather than shown as Unclassified, which would be a claim.
 */
export function jobTypeLabel(
  jobTypes: readonly JobType[],
  id: string | null | undefined,
  options: { loaded?: boolean } = {},
): string {
  if (!id) return UNCLASSIFIED_LABEL;
  const type = jobTypes.find((candidate) => candidate.id === id);
  if (type) return type.active ? type.label : `${type.label} (deactivated)`;
  return options.loaded === false ? "…" : "Unknown type";
}
