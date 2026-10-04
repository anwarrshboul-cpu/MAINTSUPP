"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The MAINTSUPP notification chime.
 *
 * It sounds when the bell gains an unread notification this browser has not
 * chimed for before — not on every page load. What it has already announced is
 * remembered per browser, so opening the portal with the same three unread
 * items is silent, and a fourth arriving is not.
 *
 * Browsers refuse audio before the first click or key press. A chime refused
 * for that reason is held and played on that first interaction rather than
 * dropped.
 */
export const NOTIFICATION_CHIME_SRC = "/assets/sounds/maintsupp-notification.mp3";
const SEEN_KEY = "maintsupp:chime:seen";
const MUTED_KEY = "maintsupp:chime:muted";
const SEEN_LIMIT = 500;
const CHIME_VOLUME = 1; // full volume (owner, 2026-10-04)

function readSeen(): string[] | null {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function readMuted(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(MUTED_KEY) === "1";
  } catch {
    return false;
  }
}

function playChime() {
  const audio = new Audio(NOTIFICATION_CHIME_SRC);
  audio.volume = CHIME_VOLUME;
  audio.play().catch(() => {
    const retry = () => {
      window.removeEventListener("pointerdown", retry);
      window.removeEventListener("keydown", retry);
      audio.play().catch(() => {});
    };
    window.addEventListener("pointerdown", retry, { once: true });
    window.addEventListener("keydown", retry, { once: true });
  });
}

/**
 * @param unreadIds the ids the bell currently counts as unread
 * @param ready false until the read/dismissed states have loaded — before
 *   that every candidate looks unread, and chiming for them would be wrong
 */
export function useNotificationChime(unreadIds: string[], ready: boolean) {
  const [muted, setMuted] = useState(readMuted);
  const mutedRef = useRef(muted);
  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);
  const unreadKey = unreadIds.join("|");

  useEffect(() => {
    if (!ready) return;
    const current = unreadKey ? unreadKey.split("|") : [];
    const seen = readSeen();
    const known = new Set(seen ?? []);
    const fresh = current.filter((id) => !known.has(id));
    if (seen !== null && fresh.length === 0) return;
    try {
      window.localStorage.setItem(
        SEEN_KEY,
        JSON.stringify([...(seen ?? []), ...fresh].slice(-SEEN_LIMIT)),
      );
    } catch {
      // Private browsing: the chime still works, it just cannot remember.
    }
    /* A browser with no history has nothing to compare against: record what
       is there and stay quiet, or the first visit would chime for old news. */
    if (seen === null || mutedRef.current) return;
    playChime();
  }, [ready, unreadKey]);

  const toggleMuted = useCallback(() => {
    setMuted((was) => {
      const next = !was;
      try {
        if (next) window.localStorage.setItem(MUTED_KEY, "1");
        else window.localStorage.removeItem(MUTED_KEY);
      } catch {
        // The choice still holds for this visit.
      }
      /* Turning sound on plays it once, so the choice is heard, not guessed. */
      if (!next) playChime();
      return next;
    });
  }, []);

  return { muted, toggleMuted };
}
