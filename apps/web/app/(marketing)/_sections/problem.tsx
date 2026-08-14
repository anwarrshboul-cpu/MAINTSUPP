"use client";

import { useState } from "react";

/* ── 5. THE PROBLEM — before / after comparison ───────────────────────────── */

/** Icon path markup, copied verbatim from the source's `P` object. */
const P = {
  checkc: '<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>',
  alert:
    '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
};

/** Mirrors the source's `icon(p, cls)` helper, including its stroke settings.
 *  The path markup is kept as the source's raw string so it can be handed
 *  straight to PhotoSlot's `glyph`, which expects that same string. */
function Ic({ path, cls }: { path: string; cls?: string }) {
  return (
    <svg
      className={`ic ${cls ?? ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: path }}
    />
  );
}

type Which = "before" | "after";

/**
 * FIVE PAIRS, stored as pairs.
 *
 * This was two independent arrays of four, which is a quiet trap: the whole
 * point of the control is that the reader flips between two views of the SAME
 * five problems, and nothing kept `before[2]` describing the same problem as
 * `after[2]`. Adding a row to one side would have silently shifted the other
 * side's answers up by one. A pair cannot come apart.
 *
 * The wording is the brief's, verbatim on both sides.
 */
const PAIRS: ReadonlyArray<{ before: string; after: string }> = [
  {
    before: "No single owner — chasing trades yourself",
    after: "One accountable contact who owns every job",
  },
  {
    before: "Compliance risk — expired certificates found too late",
    after: "Certificate register with 90/60/30-day reminders",
  },
  {
    before: "Fragmented contractors and one-off searches",
    after: "Vetted, scored contractor panel by trade and region",
  },
  {
    before: "No visibility of what was actually done",
    after: "Photo evidence, reports and verified close-out",
  },
  {
    before: "Scattered spend across invoices and emails",
    after: "One monthly report: jobs, spend, compliance status",
  },
];

export function Problem() {
  const [which, setWhich] = useState<Which>("before");

  return (
    <section className="section section--tint" id="problem">
      <div className="wrap">
        <div
          className="reveal"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 20,
            alignItems: "flex-end",
            justifyContent: "space-between",
          }}
        >
          <div>
            <p className="eyebrow">The operating problem</p>
            <h2 className="h2">
              Stop managing maintenance through scattered calls and spreadsheets.
            </h2>
          </div>
          <div className="switcher" role="group" aria-label="Compare before and after">
            <button
              type="button"
              id="cmpBefore"
              className={which === "before" ? "is-on" : undefined}
              aria-pressed={which === "before"}
              onClick={() => setWhich("before")}
            >
              Without Maintsupp
            </button>
            <button
              type="button"
              id="cmpAfter"
              className={which === "after" ? "is-on" : undefined}
              aria-pressed={which === "after"}
              onClick={() => setWhich("after")}
            >
              With Maintsupp
            </button>
          </div>
        </div>

        {/* Keyed on the mode so React remounts the cards and the CSS `feedin`
            animation replays on every switch, as it did in the source where the
            grid's innerHTML was rewritten wholesale. */}
        <div className="compare reveal" id="compareGrid" key={which}>
          {PAIRS.map((pair) => (
            <div
              key={pair.before}
              className={`compare__card compare__card--${which === "before" ? "pain" : "gain"}`}
            >
              <Ic path={which === "before" ? P.alert : P.checkc} />
              <h3>{which === "before" ? pair.before : pair.after}</h3>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
