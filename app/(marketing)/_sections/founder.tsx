/*
 * SECTION 9 — Who runs Maintsupp.
 *
 * Sits between the case study and the client portal: the case study says what
 * the service did, and this says who is accountable for it, which is the
 * question a portfolio owner asks next.
 *
 * THE PHOTOGRAPH IS NOT SUPPLIED YET. The brief names the file —
 * /assets/photos/founder-anwar.jpg — and is explicit that no AI face and no
 * stock substitute may stand in for it. Until that file exists NOTHING renders
 * in its place: an earlier version drew an empty dashed frame with a picture
 * icon, which on the page read as a broken image above the heading rather than
 * as a promise of one. The text takes the full width instead.
 *
 * Dropping `founder-anwar.jpg` into `public/assets/photos` and flipping the
 * constant below is the whole of the change needed later — the two-column
 * layout comes back with it (`.founder--photo`).
 */

/**
 * Flip to `true` once `public/assets/photos/founder-anwar.jpg` exists.
 *
 * A constant rather than a runtime existence check: this is a server component
 * rendering static marketing copy, and reaching into the filesystem per request
 * to ask whether a file has arrived yet would be a strange amount of machinery
 * for a question that is answered by looking in the folder.
 */
const FOUNDER_PHOTO_SUPPLIED = false;

const CHIPS = [
  "Founder-led",
  "One named coordinator per portfolio",
  "Mon–Fri, 8:30am–5:30pm",
];

export function Founder() {
  return (
    <section className="section" id="founder">
      <div className="wrap">
        <div className={`founder${FOUNDER_PHOTO_SUPPLIED ? " founder--photo" : ""} reveal`}>
          {FOUNDER_PHOTO_SUPPLIED && (
            <div className="founder__media">
              <img
                className="founder__photo"
                src="/assets/photos/founder-anwar.jpg"
                alt="Anwar Shboul, founder and director of Maintsupp"
                width={900}
                height={1100}
                loading="lazy"
                decoding="async"
              />
            </div>
          )}

          <div className="founder__body">
            {/* No eyebrow above it. Every other section has one, but the
                brief lists exactly what this section holds — heading, name
                line, body, three chips — and an eyebrow reading "Who runs
                Maintsupp" above a heading reading "Who runs Maintsupp" is the
                same words twice, which is worse than the missing flourish. */}
            <h2 className="h2">Who runs Maintsupp</h2>
            <p className="founder__name">Anwar Shboul — Founder &amp; Director</p>
            <p className="lede">
              Maintsupp is founder-led. Anwar has over five years&rsquo; experience in
              facilities management for commercial stores across the UK — intake, triage,
              contractor management and verified close-out, day in, day out. Every client
              portfolio gets one named coordinator who owns each job until it&rsquo;s
              verified complete. You deal with a person accountable for the outcome, not a
              ticket queue.
            </p>
            <ul className="founder__chips">
              {CHIPS.map((chip) => (
                <li className="chip" key={chip}>
                  {chip}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
