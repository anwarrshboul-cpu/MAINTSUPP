import { PhotoSlot } from "./photo";

/**
 * SECTION 4 — What we offer. A merge of two sections into one.
 *
 * WHAT WAS HERE: a four-tab switcher, one tab per service, each with a
 * photograph, a paragraph and a five-point list — a component the reader had to
 * operate to find out what the company does. Under it, a separate `Trades`
 * section repeated the same ground as eight photo tiles with their own detail
 * panel, and a `CtaBand` whose headline is now Section 10's.
 *
 * WHAT SHIPS: the five services as one ruled register, and a single strip of
 * trade thumbnails below them. Both were an accordion; neither needed to be.
 *
 * WHY A REGISTER AND NOT CARDS. They were five cards in an auto-fit grid,
 * which at desktop meant four across and the fifth alone on a second row, and
 * four short cards stretched to the height of the one long body — the section
 * was among the tallest on the page and mostly empty. The words are untouched;
 * they are now one bordered panel with a ruled row each, the service on the
 * left and what it covers on the right. An uneven body length is the normal
 * case for a register rather than the thing that breaks a grid.
 *
 * THE THUMBNAILS ARE THE EXISTING PHOTOGRAPHS. `trade-electrical`,
 * `trade-leaks`, `trade-doors`, `trade-hvac`, `trade-signage` and
 * `trade-fabric` are the files that were already in the repo, reused as they
 * are — the brief forbids adding or replacing any.
 *
 * ALL EIGHT LABELS NOW HAVE A PHOTOGRAPH. Glazing and drainage were the two
 * that did not — for a long time there was no picture of either in the assets
 * folder, and inventing one was exactly what the brief ruled out, so both fell
 * through to `PhotoSlot`'s generated artwork rather than borrowing the
 * refrigeration or CCTV photograph under a label that would then have lied.
 *
 * Both were supplied in the approved pack and installed by
 * `scripts/install-trade-photos.mjs`, through the same slot convention as the
 * other six — which is why nothing in this file changed to adopt them. The
 * fallback stays where it is: it is still what every tile shows before its
 * photograph decodes.
 */

/** Icon path markup, in the source's raw-string form. */
const P = {
  wrench: '<path d="M14.7 6.3a4 4 0 1 0 5 5L21 21H3l9.7-9.7a4 4 0 0 1 2-4.9Z"/>',
  calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  shield: '<path d="M12 21s8-3.5 8-9V5l-8-3-8 3v7c0 5.5 8 9 8 9Z"/><path d="m9 12 2 2 4-4"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 15 3.5-4 3 2.5L20 7"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7Z"/>',
  drop: '<path d="M12 3s6 6.4 6 10.5A6 6 0 0 1 6 13.5C6 9.4 12 3 12 3Z"/>',
  door: '<rect x="4" y="2" width="16" height="20" rx="1"/><path d="M4 8h16M4 14h16M15 18h.01"/>',
  wind: '<path d="M3 8h11a3 3 0 1 0-3-3M3 14h15a3 3 0 1 1-3 3M3 11h18"/>',
  glass: '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 9h18M9 3v18"/>',
  sign: '<path d="M4 4h13l3 3.5L17 11H4Z"/><path d="M12 11v10M8 21h8"/>',
  drain: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16M4 12h16M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  brush:
    '<path d="M9 11V4a2 2 0 0 1 4 0v7"/><path d="M5 11h14v4a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5Z"/>',
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

const SERVICES = [
  {
    icon: P.wrench,
    title: "Reactive Maintenance Coordination",
    body: "Intake, triage, contractor assignment, quote control, attendance chasing and verified close-out.",
  },
  {
    icon: P.calendar,
    title: "Planned Maintenance (PPM)",
    body: "Recurring service schedules, work orders, attendance monitoring and follow-up actions.",
  },
  {
    icon: P.shield,
    title: "Compliance Administration",
    body: "Certificate register, due-date reminders, provider booking, document chasing and remedial tracking. Inspections and certificates are carried out by competent certified providers.",
  },
  {
    icon: P.layers,
    title: "Projects & Store Works",
    body: "Kiosk moves, refreshes, signage and multi-trade works, each separately scoped and quoted.",
  },
  {
    icon: P.chart,
    title: "Reporting & Visibility",
    body: "Monthly KPI, spend, ageing and compliance reporting across the portfolio.",
  },
] as const;

/**
 * The eight faults, each pointing at the photograph that actually shows it.
 *
 * `slot` is the file stem in `public/assets/photos`. Where it names a file that
 * is not there, the slot draws its artwork instead — which is now only the
 * moment before a photograph decodes, since all eight are supplied.
 */
const TRADES = [
  { slot: "trade-electrical", label: "Electrical & lighting", glyph: P.bolt, c1: "#F59E0B", c2: "#B45309" },
  { slot: "trade-leaks", label: "Plumbing & leaks", glyph: P.drop, c1: "#38BDF8", c2: "#0369A1" },
  { slot: "trade-doors", label: "Doors, locks & shutters", glyph: P.door, c1: "#94A3B8", c2: "#334155" },
  { slot: "trade-hvac", label: "HVAC", glyph: P.wind, c1: "#5EEAD4", c2: "#0F766E" },
  { slot: "trade-glazing", label: "Glazing", glyph: P.glass, c1: "#BAE6FD", c2: "#0C4A6E" },
  { slot: "trade-signage", label: "Signage", glyph: P.sign, c1: "#FCD34D", c2: "#92400E" },
  { slot: "trade-drainage", label: "Drainage", glyph: P.drain, c1: "#A5B4FC", c2: "#3730A3" },
  { slot: "trade-fabric", label: "General repairs", glyph: P.brush, c1: "#FDBA74", c2: "#9A3412" },
] as const;

export function Services() {
  return (
    <section className="section" id="services">
      <div className="wrap">
        <div className="reveal">
          <p className="eyebrow">What we offer</p>
          <h2 className="h2">If it breaks at a commercial site, we coordinate the repair.</h2>
        </div>

        {/*
          `role="list"` is not redundant. The stylesheet sets `list-style:none`
          on this <ul>, and Safari/VoiceOver drops the list role when it does —
          which would take the "list of 5 items" announcement with it, and that
          count is the whole point of a register.
        */}
        <ul className="svclist reveal" role="list">
          {SERVICES.map((service) => (
            <li className="svclist__row" key={service.title}>
              <h3 className="svclist__term">
                <span className="svclist__ic">
                  <Ic path={service.icon} />
                </span>
                {service.title}
              </h3>
              <p className="svclist__def">{service.body}</p>
            </li>
          ))}
        </ul>

        {/* The standalone trades section, reduced to the one row it was. */}
        <div className="faults reveal">
          <h3 className="faults__title">Faults we handle most</h3>
          <ul className="faults__row">
            {TRADES.map((trade) => (
              <li className="tile tile--static" key={trade.slot}>
                <PhotoSlot
                  slot={trade.slot}
                  w={600}
                  h={600}
                  art="tool"
                  c1={trade.c1}
                  c2={trade.c2}
                  glyph={trade.glyph}
                  alt={`${trade.label} work on a commercial site`}
                  desc={`${trade.label} work on a commercial site`}
                  className="ph__art"
                />
                <span className="tile__cap">
                  <Ic path={trade.glyph} cls="ic--sm" />
                  {trade.label}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
