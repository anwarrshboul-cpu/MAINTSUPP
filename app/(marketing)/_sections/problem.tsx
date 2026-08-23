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
          A TABLE, ON EVERY WIDTH.

          Two earlier shapes were tried and both were rejected on a phone. A
          two-button switcher showed one side at a time, which is not a
          comparison. Then paired cards — pain, arrow, answer — stacked on a
          phone into a column of alternating red and green boxes with an icon
          floating beside each line, and the reader had to work out from the
          rhythm which box answered which.

          A comparison is a table: two columns with a heading each, five rows,
          and the answer to a problem sits on the same row as the problem at
          every width. Real <table> semantics, so a screen reader announces
          "Without Maintsupp, column 1 of 2" on the cell rather than leaving the
          pairing to be inferred. The column is never told by colour alone: the
          heading names it, the icon shape differs, and the header row stays.

          The "with" column is the logo's cyan — `--teal` / `--teal-text` — not
          a generic green, because this is the page saying "the Maintsupp way".
        */}
        <div className="comparetable-wrap reveal">
          <table className="comparetable">
            <thead>
              <tr>
                {/* `.comparetable__inner` is a two-column grid INSIDE the cell
                    — icon track, then text — so the <th>/<td> keep their
                    table display (and therefore their table semantics) while
                    the icon can never sit on top of the text however narrow
                    the column gets. */}
                <th scope="col" className="comparetable__th comparetable__th--pain">
                  <span className="comparetable__inner">
                    <span className="comparetable__ic" aria-hidden="true">
                      <Ic path={P.alert} cls="ic--sm" />
                    </span>
                    <span>Without Maintsupp</span>
                  </span>
                </th>
                <th scope="col" className="comparetable__th comparetable__th--gain">
                  <span className="comparetable__inner">
                    <span className="comparetable__ic" aria-hidden="true">
                      <Ic path={P.checkc} cls="ic--sm" />
                    </span>
                    <span>With Maintsupp</span>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {PAIRS.map((pair) => (
                <tr key={pair.before}>
                  <td className="comparetable__cell comparetable__cell--pain">
                    <span className="comparetable__inner">
                      <span className="comparetable__ic" aria-hidden="true">
                        <Ic path={P.alert} cls="ic--sm" />
                      </span>
                      <span className="comparetable__text">{pair.before}</span>
                    </span>
                  </td>
                  <td className="comparetable__cell comparetable__cell--gain">
                    <span className="comparetable__inner">
                      <span className="comparetable__ic" aria-hidden="true">
                        <Ic path={P.checkc} cls="ic--sm" />
                      </span>
                      <span className="comparetable__text">{pair.after}</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
