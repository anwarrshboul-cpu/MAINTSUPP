import type { ReactNode } from "react";

/**
 * SECTION 3 — Who we help.
 *
 * Six operator types, each with a real line icon.
 *
 * WHAT THIS REPLACES: the `Sectors` section, which was five photo tiles with a
 * detail panel under them — a whole interactive component to say who the
 * product is for. The spec asks for six cards and one supporting line, and the
 * photographs go with the panel: `sector-retail`, `-kiosks`, `-gyms`,
 * `-cinemas` and `-commercial` are deleted with it.
 *
 * ICONS, NOT LETTERS. The brief is explicit that a letter in a box is not an
 * icon. These are drawn in the same idiom as every other glyph on the page —
 * 24×24, no fill, 1.7 stroke, round caps and joins, which is Lucide's grid and
 * the geometry `.ic` is sized for. Each one is the object itself (a shopfront,
 * a canopy, a branching tree) rather than a generic square, because six cards
 * carrying six variations of "building" tell the reader nothing.
 *
 * `aria-hidden` on every icon: each sits directly above its own label, so a
 * screen reader that announced both would read everything twice.
 */

const ICONS: Record<string, ReactNode> = {
  /* Storefront — awning, door, window. */
  storefront: (
    <>
      <path d="M3 9V6l2-3h14l2 3v3" />
      <path d="M3 9h18a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0Z" />
      <path d="M4.5 11.7V21h15v-9.3" />
      <path d="M9.5 21v-5.5h5V21" />
    </>
  ),
  /* Market stall — a canopy over an open counter, which is what a kiosk is. */
  kiosk: (
    <>
      <path d="M4 10v10h16V10" />
      <path d="M2 10 4 4h16l2 6Z" />
      <path d="M8 4v6M16 4v6" />
      <path d="M8 20v-5h8v5" />
    </>
  ),
  /* Branches — one parent, three sites. A franchise group in one glyph. */
  branches: (
    <>
      <rect x="9" y="2" width="6" height="5" rx="1" />
      <rect x="2" y="17" width="5" height="5" rx="1" />
      <rect x="9.5" y="17" width="5" height="5" rx="1" />
      <rect x="17" y="17" width="5" height="5" rx="1" />
      <path d="M12 7v5M4.5 17v-2.5h15V17M12 12v2.5" />
    </>
  ),
  /* Heart with a pulse trace across it. */
  heartPulse: (
    <>
      <path d="M12 20.5S3.5 15 3.5 8.9A4.4 4.4 0 0 1 12 6.8a4.4 4.4 0 0 1 8.5 2.1c0 1.5-.5 2.9-1.3 4.1" />
      <path d="M21.5 15.5h-4l-1.5 2.5-2.5-5-1.5 2.5H9" />
    </>
  ),
  /* Dumbbell. */
  dumbbell: (
    <>
      <path d="M6.5 7v10M17.5 7v10" />
      <path d="M3.5 10v4M20.5 10v4" />
      <path d="M6.5 12h11" />
    </>
  ),
  /* Office block — a tower with a lower wing, distinct from the shopfront. */
  office: (
    <>
      <path d="M3 21V6a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v15" />
      <path d="M13 21V11h7a1 1 0 0 1 1 1v9" />
      <path d="M2 21h20" />
      <path d="M6 9h1.5M9.5 9H11M6 13h1.5M9.5 13H11M6 17h1.5M9.5 17H11M16.5 15H18" />
    </>
  ),
};

const AUDIENCES = [
  {
    icon: "storefront",
    label: "Retail chains",
    body: "Stores where a shutter that will not lift is a day of lost trade.",
  },
  {
    icon: "kiosk",
    label: "Shopping-centre kiosks",
    body: "Units inside a landlord's estate, with permits and out-of-hours access.",
  },
  {
    icon: "branches",
    label: "Franchise groups",
    body: "One standard to hold across sites you do not all operate yourself.",
  },
  {
    icon: "heartPulse",
    label: "Clinics & wellness",
    body: "Sites where compliance paperwork is inspected, not just filed.",
  },
  {
    icon: "dumbbell",
    label: "Gyms & studios",
    body: "Long opening hours, heavy equipment and plant that runs all day.",
  },
  {
    icon: "office",
    label: "Small commercial offices",
    body: "Portfolios too small for an in-house team and too large to wing it.",
  },
] as const;

export function WhoWeHelp() {
  return (
    <section className="section section--tint" id="sectors">
      <div className="wrap">
        <div className="reveal">
          <p className="eyebrow">Who we help</p>
          <h2 className="h2">Built for multi-site operators without an in-house FM team.</h2>
        </div>

        <ul className="whogrid reveal">
          {AUDIENCES.map((entry) => (
            <li className="whocard" key={entry.label}>
              <span className="whocard__ic">
                <svg
                  className="ic"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  {ICONS[entry.icon]}
                </svg>
              </span>
              <h3>{entry.label}</h3>
              <p>{entry.body}</p>
            </li>
          ))}
        </ul>

        <p className="note whogrid__note reveal">
          Typically 5–50 locations spread across regions — managed today through scattered
          calls and spreadsheets.
        </p>
      </div>
    </section>
  );
}
