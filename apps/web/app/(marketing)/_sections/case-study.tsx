import { PhotoSlot } from "./photo";

/**
 * SECTION 8 — Case study.
 *
 * New, and deliberately anonymous: no client name, no logo, no identifying
 * detail beyond the shape of the portfolio. The brief is explicit about that,
 * and it is also the only version of this section that can go live without a
 * signed reference.
 *
 * THE PHOTOGRAPH IS REUSED, NOT NEW. `evidence-closeout` — an engineer
 * photographing completed work on a phone — comes from the `Evidence` section,
 * which this rebuild removes. It is the right picture for this section on its
 * own merits: the claim being made is "photo-verified close-outs", and that is
 * a photograph of exactly that happening. Nothing was generated or replaced.
 *
 * The three figures are the three the business can actually stand behind. There
 * is no percentage here, and no "average response time" — the removed stat-tile
 * block near the top of the old page carried several of both, none of them
 * traceable to a number anybody could produce on request.
 */

/*
 * The brief's three chips, in the brief's words.
 *
 * The third read "100% · photo-verified close-outs" in the first cut of this
 * section. Nobody asked for that number and nobody can produce it: it is the
 * same species as the stat tiles this rebuild deleted for being unverifiable.
 * The brief says "Photo-verified close-outs", which is a description of how the
 * work is closed, and is true without arithmetic.
 */
const STATS = [
  { value: "21", label: "stores coordinated" },
  { value: "One", label: "monthly report" },
  { value: "Photo-verified", label: "close-outs" },
] as const;

export function CaseStudy() {
  return (
    <section className="section" id="case-study">
      <div className="wrap">
        <div className="reveal">
          <p className="eyebrow">Case study</p>
          <h2 className="h2">21 stores. One point of contact.</h2>
        </div>

        <div className="casestudy reveal">
          <div className="casestudy__body">
            <p className="lede">
              A UK fragrance retailer with 21 stores and kiosks needed one accountable
              contact for every repair, compliance date and store project. Maintsupp runs
              intake and triage, assigns vetted contractors, chases attendance, verifies
              completion with photo evidence, and reports monthly on jobs, spend and
              compliance status.
            </p>
            <ul className="kpis casestudy__stats">
              {STATS.map((stat) => (
                <li className="kpi" key={stat.label}>
                  <span className="kpi__val">{stat.value}</span>
                  <span className="kpi__lab">{stat.label}</span>
                </li>
              ))}
            </ul>
          </div>

          <PhotoSlot
            slot="evidence-closeout"
            w={1200}
            h={900}
            art="tool"
            alt="An engineer photographing completed work on a phone as close-out evidence"
            desc="An engineer photographing completed work on a phone"
            className="casestudy__photo"
          />
        </div>
      </div>
    </section>
  );
}
