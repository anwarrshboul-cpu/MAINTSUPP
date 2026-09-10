/**
 * SECTION — Your contractors or ours. New in Homepage V3.
 *
 * THE OBJECTION THIS ANSWERS. The single most common reason a multi-site
 * operator stops reading a coordination pitch is the belief that signing means
 * losing the trades who already know their sites — the electrician who has a
 * key, the shutter engineer who knows which unit has the awkward lintel. Until
 * V3 the site answered that only in the eighth FAQ on a different page, which
 * is three clicks after the reader has already decided.
 *
 * It sits between How It Works and Pricing on purpose: the reader has just seen
 * the process and is about to see what it costs, and "do I have to change
 * anything" is the question in between. The FAQ answer stays — it is the same
 * position, written for someone who arrived at the question from elsewhere —
 * and the two are worded from the same facts.
 *
 * WHAT IS NOT CLAIMED HERE. No coverage promise, no response time, and no
 * count of contractors on the panel. Depth is strongest in London and the South
 * East and is mobilised regionally, which the FAQ says plainly; a number here
 * would be a claim that has to stay true on the day somebody asks for it.
 */

/** Icon path markup, in the raw-string form the other sections use. */
const P = {
  handshake:
    '<path d="m11 17 2 2a1 1 0 0 0 1.4 0l3.6-3.6"/><path d="M2 12.5 6 8l4 3.5a2 2 0 0 0 2.6 0L15 9.5"/><path d="M22 11.5 18 7l-3.5 2"/><path d="M6 8 2 12.5l4 4.5M18 7l4 4.5-4 4.5"/>',
  network:
    '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="18" r="2.5"/><circle cx="19" cy="18" r="2.5"/><path d="M12 7.5v4M10.2 13.2 6.6 16M13.8 13.2l3.6 2.8"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
};

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
 * TWO ROUTES, NOT TWO PRODUCTS.
 *
 * Neither card is a plan, a tier or a price — they are two sources of labour
 * under one process, which is why they carry no button and no figure. The
 * pricing section is the only place on the page that quotes a number, and a
 * "from £" on a card here would be a second price table by another name.
 */
const ROUTES = [
  {
    id: "yours",
    icon: P.handshake,
    title: "Your contractors",
    lede: "Keep the trades who already know your sites.",
    points: [
      "Onboarded on insurance, qualifications and documentation",
      "Your agreed rates, unchanged — we do not renegotiate them",
      "Scored on the same performance measures as everyone else",
      "No transfer, no notice period, no exclusivity",
    ],
  },
  {
    id: "ours",
    icon: P.network,
    title: "Our vetted network",
    lede: "Cover for the trade, the region or the hour you have nobody for.",
    points: [
      "A vetted UK panel, sourced by trade and by region",
      "Documents checked before any work is released",
      "Performance-managed, and replaced where the scores say so",
      "Used for one trade or the whole portfolio, as you choose",
    ],
  },
] as const;

export function ContractorChoice() {
  return (
    <section className="section" id="your-contractors">
      <div className="wrap">
        <div className="reveal">
          <p className="eyebrow">Your contractors or ours</p>
          <h2 className="h2">Keep the trades you trust. Use ours for the rest.</h2>
          <p className="lede">
            Coming to Maintsupp does not mean replacing your contractors. Bring the ones
            who already know your sites, use our vetted panel where you have no cover, and
            run both through one process — with one report at the end of the month.
          </p>
        </div>

        <ul className="choice reveal" role="list">
          {ROUTES.map((route) => (
            <li className="choice__card" key={route.id}>
              <span className="choice__ic">
                <Ic path={route.icon} />
              </span>
              <h3>{route.title}</h3>
              <p className="choice__lede">{route.lede}</p>
              <ul className="choice__list" role="list">
                {route.points.map((point) => (
                  <li key={point}>
                    <Ic path={P.check} cls="ic--sm" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>

        {/*
          THE SPLIT IS THE NORMAL CASE, so it is stated rather than left to be
          inferred from two cards sitting side by side. Without this line the
          section reads as a choice between two options at sign-up, which is
          exactly the decision a reader is worried about being locked into.
        */}
        <p className="note choice__note reveal">
          Most portfolios run a mix, and the split is yours to set — per trade, per region
          or per site, changed whenever you want it changed. Whichever panel a contractor
          comes from, they invoice you directly at their own agreed rates: the coordination
          fee is the only thing Maintsupp charges for.
        </p>
      </div>
    </section>
  );
}
