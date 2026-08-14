"use client";

import { useState } from "react";

/**
 * Copies the contractor's share link.
 *
 * The origin is read in the click handler, never during render: `window` does
 * not exist on the server, and deriving the URL while rendering would either
 * crash the page or produce markup that disagrees with the client's and gets
 * thrown away as a hydration mismatch.
 *
 * `navigator.clipboard` is only defined in a secure context, so on a phone
 * opening the portal over plain http on the office LAN it is simply missing.
 * The fallback is not an error message — it is the URL itself, in a focused
 * field, ready to be copied by hand.
 */
export default function CopyLinkButton({
  shareToken,
  shareEnabled,
}: {
  shareToken: string;
  shareEnabled: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState<string | null>(null);

  async function copy() {
    const url = `${window.location.origin}/job/${shareToken}`;
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setManual(null);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setManual(url);
    }
  }

  return (
    <div>
      <button type="button" className="p-btn p-btn--ghost" onClick={copy}>
        {copied ? "Link copied" : "Copy Link"}
      </button>

      {manual ? (
        <input
          className="p-copyfield"
          readOnly
          value={manual}
          aria-label="Share link — copy this"
          onFocus={(event) => event.currentTarget.select()}
          autoFocus
        />
      ) : null}

      <div aria-live="polite" className="p-small p-muted">
        {copied ? "Share link copied to the clipboard." : null}
      </div>

      {!shareEnabled ? (
        <p className="p-note">
          {/* The token still exists, so the button still works — but the API
              refuses the link until somebody re-enables sharing, and sending it
              out would be sending a dead link. */}
          Sharing is switched off for this job. The link will not open.
        </p>
      ) : null}
    </div>
  );
}
