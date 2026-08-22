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
  return (
    <section className="section section--tint" id="problem">
      <div className="wrap">
        <div className="reveal">
          <p className="eyebrow">The operating problem</p>
          <h2 className="h2">
            Stop managing maintenance through scattered calls and spreadsheets.
          </h2>
        </div>

        {/*
          BOTH SIDES, ALWAYS, WITH NO CONTROL TO FIND.

          This was a two-button switcher: "Without Maintsupp" or "With
          Maintsupp", one at a time. A comparison that shows one side at a time
          is not a comparison — the reader had to hold five statements in their
          head, press a button, and match them up from memory, and nothing on
          screen said the two lists were even the same five items in the same
          order. On a phone the switcher was also the only hint that a second
          half existed at all.

          Paired rows instead: each pain sits beside the thing that answers it,
          side by side on desktop and stacked as a labelled pair on a phone. The
          five pairs are the same five, in the same order.
        */}
        <ul className="compare compare--paired reveal">
          {PAIRS.map((pair) => (
            <li className="comparepair" key={pair.before}>
              <div className="compare__card compare__card--pain">
                {/* The column headings live on the first pair only — repeating
                    "Without / With" five times is noise once the pattern is
                    established, and `aria-hidden` keeps the repeat out of the
                    accessible name too. Each card still names its own side for
                    a screen reader via the visually-hidden span below. */}
                <span className="comparepair__side">Without Maintsupp</span>
                <Ic path={P.alert} />
                <h3>{pair.before}</h3>
              </div>
              <span className="comparepair__arrow" aria-hidden="true">
                <svg
                  className="ic ic--sm"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </span>
              <div className="compare__card compare__card--gain">
                <span className="comparepair__side">With Maintsupp</span>
                <Ic path={P.checkc} />
                <h3>{pair.after}</h3>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
