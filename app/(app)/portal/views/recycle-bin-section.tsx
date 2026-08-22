"use client";

/**
 * The Recycle Bin, as a portal section.
 *
 * WHY THIS FILE IS FOUR LINES OF SUBSTANCE
 *
 * The bin already existed in full: one table with a 30-day retention, one
 * `/api/trash` that lists, restores and purges under three different
 * capabilities, one sweep, and one screen with filters, expiry countdowns and
 * the deletion history beneath it. What it did not have was a way in. It sat
 * behind the avatar, nine items down a menu, and the client's report was simply
 * that there was no way to get deleted rows back.
 *
 * So this adds a door, not a room. It renders the SAME `AccountTrashPanel` over
 * the SAME API. A second bin — its own table, its own restore path, its own
 * retention — is the one outcome that would make deletion less safe rather than
 * more, because two mechanisms drift and the one nobody is looking at is the
 * one holding the row somebody needs.
 *
 * The panel wants a time zone to render "deleted 3 days ago" in. The account
 * area has one to hand; the portal does not, so it asks for the same profile
 * field the account screen reads, and renders in the browser's own zone until
 * the answer arrives. A minute of local time on a list of dates is not worth
 * blocking the screen for.
 */

import { useEffect, useState } from "react";
import { AccountTrashPanel } from "./account-workspace";
/*
 * The panel's stylesheet, which the account shell imports for its own copy.
 *
 * A component that renders somebody else's markup has to bring that markup's
 * CSS with it. Without this the bin drew here with none of it: the table lost
 * the `overflow-x: auto` that lets it scroll inside its own strip, and a 636px
 * table pushed the page 258px wider than a phone at 390. Vite dedupes the two
 * imports, so the account area is unaffected.
 */
import "./account-views.css";

export function RecycleBinSection({ onNotify }: { onNotify: (message: string) => void }) {
  const [timezone, setTimezone] = useState<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/account", {
          headers: { Accept: "application/json" },
        });
        if (!response.ok) return;
        const payload = (await response.json()) as {
          account?: { profile?: { timezone?: string | null } };
        };
        const zone = payload.account?.profile?.timezone;
        if (active && zone) setTimezone(zone);
      } catch {
        // The panel renders in the browser's zone. Nothing here is worth an
        // error state of its own.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return <AccountTrashPanel timezone={timezone} onNotify={onNotify} />;
}
