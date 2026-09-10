/**
 * SECTION — What this replaces. New in Homepage V3.
 *
 * WHY IT IS NOT THE PROBLEM SECTION AGAIN. `Problem` is a before/after of
 * SYMPTOMS — "no single owner", "compliance risk", "no visibility" — and it
 * answers "what goes wrong today". This one answers a different question, the
 * one a buyer actually asks before they sign: what do I stop paying for, stop
 * maintaining or stop doing myself? So every row here names a THING that goes
 * away — a spreadsheet, a group chat, a licence, a hire — rather than a feeling
 * about it, and pairs it with the thing that takes its place.
 *
 * The two sections are deliberately adjacent and deliberately different. If a
 * row here ever starts reading like a row of the comparison table above it,
 * one of the two has drifted and the row belongs in the other section.
 *
 * NOTHING HERE PROMISES A SAVING. "Replaces a part-time facilities hire" is a
 * statement about the work; "saves you £28,000 a year" would be a statement
 * about someone's payroll that Maintsupp cannot see. The section says what is
 * replaced and lets the pricing section, which carries the only numbers on the
 * page, say what it costs.
 */

/** Icon path markup, in the raw-string form the other sections use. */
const P = {
  sheet: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12Z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  licence:
    '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 9h20"/><path d="M6 14h5M15 14h3"/>',
  phone:
    '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/>',
  drawer:
    '<path d="M3 7h18v13H3z"/><path d="M3 7l2-4h14l2 4"/><path d="M9 12h6"/>',
};

function Ic({ path }: { path: string }) {
  return (
    <svg
      className="ic"
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
 * SIX PAIRS, STORED AS PAIRS — the same rule the comparison table follows.
 *
 * `gone` and `instead` describe the same row of the reader's operation, so they
 * cannot be two arrays that can slip against each other by one.
 */
const REPLACES: ReadonlyArray<{ icon: string; gone: string; instead: string }> = [
  {
    icon: P.sheet,
    gone: "The maintenance spreadsheet",
    instead:
      "A live job register every site and contractor writes to, with photographs and costs against each job.",
  },
  {
    icon: P.chat,
    gone: "A WhatsApp group per store",
    instead:
      "One intake form, one reference per fault, and one thread that holds the whole history of it.",
  },
  {
    icon: P.phone,
    gone: "Chasing trades yourself",
    instead:
      "Someone whose job is the chasing: quotes controlled, attendance followed up, close-out evidenced before a job is closed.",
  },
  {
    icon: P.user,
    gone: "A part-time facilities hire",
    instead:
      "A named coordinator for the portfolio — with no salary, no laptop and no gap when they take leave.",
  },
  {
    icon: P.drawer,
    gone: "The certificate drawer",
    instead:
      "A register with 90/60/30-day reminders, the provider booked, and remedial work tracked to completion.",
  },
  {
    icon: P.licence,
    gone: "A CAFM licence per user",
    instead:
      "A portal included with the coordination fee, with a login for every store that needs one.",
  },
];

export function WhatThisReplaces() {
  return (
    <section className="section" id="replaces">
      <div className="wrap">
        <div className="reveal">
          <p className="eyebrow">What this replaces</p>
          <h2 className="h2">One coordination layer instead of six half-jobs.</h2>
          <p className="lede">
            Maintsupp is not another system to keep up to date alongside the ones you
            already have. It takes over the work those were standing in for.
          </p>
        </div>

        {/*
          `role="list"` for the same reason the services register carries one:
          the stylesheet sets `list-style:none`, and Safari drops the list role
          when it does — which would take the "list, 6 items" announcement with
          it. Each card is a heading plus a sentence, so the six are also
          reachable by heading navigation.
        */}
        <ul className="replaces reveal" role="list">
          {REPLACES.map((row) => (
            <li className="replaces__card" key={row.gone}>
              <span className="replaces__ic">
                <Ic path={row.icon} />
              </span>
              {/* "Replaces" is rendered, not implied by a strikethrough. A line
                  through the label would be decoration a screen reader either
                  ignores or announces as "deleted", and neither says what the
                  card means. */}
              <h3 className="replaces__gone">
                <span className="replaces__verb">Replaces</span>
                {row.gone}
              </h3>
              <p className="replaces__instead">{row.instead}</p>
            </li>
          ))}
        </ul>

        <p className="note replaces__note reveal">
          Keeping a system you already pay for is fine — several clients keep their own
          asset database and let Maintsupp write into it. What does not stay is the
          version of it that only exists in one person&rsquo;s inbox.
        </p>
      </div>
    </section>
  );
}
