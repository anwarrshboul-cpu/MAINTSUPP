"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ApprovedPhoto } from "./approved-photo";

/**
 * How it works — the seven-stage stepper, ported from the standalone landing
 * page. Markup, class names and copy are the source's; only the plumbing
 * (innerHTML strings, manual class toggling) becomes React state.
 */

type Stage = {
  /** Rail label. Note stages 1 and 7 are both "Report". */
  name: string;
  heading: string;
  lede: string;
  you: string;
  records: string;
  /** Description of the photograph, carried through to the generated artwork. */
  desc: string;
  alt: string;
};

const STAGES: readonly Stage[] = [
  {
    name: "Report",
    heading: "Fault logged with photos, urgency and access details.",
    lede: "The site logs the requirement with location, photographs, urgency and access information. A reference is issued immediately.",
    you: "You tell us what, where and how urgent.",
    records: "Ticket created with reference and timestamp.",
    desc: "Store manager photographing a fault on a phone",
    alt: "A store manager photographing a fault on a phone",
  },
  {
    name: "Triage",
    heading: "Priority assigned (P1–P4) with a clear decision tree, not guesswork.",
    lede: "Priority, safety implications, access restrictions and the next action are assessed against the agreed framework — not by whoever shouts loudest.",
    you: "We confirm priority, trading impact and trade.",
    records: "Priority confirmed and route decided.",
    desc: "Coordinator at a desk reviewing incoming jobs",
    alt: "A coordinator at a desk reviewing incoming maintenance jobs",
  },
  {
    name: "Approve",
    heading: "Quotes and spend limits approved in writing before work proceeds.",
    lede: "Scope, quote and spend are checked against your approval thresholds before anyone is instructed.",
    you: "You approve quotes above the agreed threshold.",
    records: "Decision, approver and timestamp recorded.",
    desc: "Manager approving a quote on a laptop or tablet",
    alt: "A manager approving a maintenance quote on a laptop",
  },
  {
    name: "Assign",
    heading: "The right vetted contractor selected by trade, region and track record.",
    lede: "A vetted contractor is selected by trade, region, availability and suitability, and issued a work order with scope, access and evidence conditions.",
    you: "Nothing — this is ours to run.",
    records: "Contractor, target date and work-order reference.",
    desc: "Contractor receiving a work order, van or toolbag visible",
    alt: "A contractor reading a work order beside a van and toolbag",
  },
  {
    name: "Attend",
    heading: "Attendance confirmed and chased; engineer details and ETA shared.",
    lede: "The contractor attends, resolves or makes safe, and records findings with before and after photographs.",
    you: "Site provides access as arranged.",
    records: "Attendance time and findings logged.",
    desc: "Engineer working on site in a commercial unit",
    alt: "An engineer working on site in a commercial unit",
  },
  {
    name: "Verify",
    heading: "Before/after photos, reports and certificates checked against scope.",
    lede: "Evidence, certificates, costs and completion details are checked before the job is allowed to close.",
    you: "You can accept or query the closure.",
    records: "Evidence accepted, job closed, cost reconciled.",
    desc: "Completed repair being photographed and checked",
    alt: "A completed repair being photographed and checked against the job record",
  },
  {
    name: "Report",
    heading: "Job closed into the portfolio record and your monthly report.",
    lede: "Live dashboard plus a monthly portfolio report covering jobs, compliance, spend, repeat faults and recommendations.",
    you: "You review and set priorities for next month.",
    records: "Performance measures and recommendations.",
    desc: "Operations team reviewing a report or dashboard screen",
    alt: "An operations team reviewing a monthly portfolio report on screen",
  },
];

const COUNT = STAGES.length;

/** Movement past either end wraps, as the source's modulo arithmetic does. */
function wrap(index: number) {
  return (index + COUNT) % COUNT;
}

/*
 * Step → file, copied from the "How it works" table in the approved pack's
 * README. The order here IS the step order, so index 0 is step 1.
 */
const WORKFLOW_PHOTOS = [
  "/assets/workflow/how-it-works-01-report-full.jpg",
  "/assets/workflow/how-it-works-02-triage-full.webp",
  "/assets/workflow/how-it-works-03-approve-full.webp",
  "/assets/workflow/how-it-works-04-assign-full.webp",
  "/assets/workflow/how-it-works-05-attend-full.webp",
  "/assets/workflow/how-it-works-06-verify-full.webp",
  "/assets/workflow/how-it-works-07-reporting-full.webp",
] as const;

export function Workflow() {
  const [active, setActive] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const stageRef = useRef<HTMLDivElement | null>(null);

  // Swipe across the panel. Listeners are attached natively rather than as
  // React props so they can be passive — the gesture never blocks scrolling,
  // it only decides afterwards whether the movement was horizontal enough.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    let sx = 0;
    let sy = 0;
    let tracking = false;

    function onStart(event: TouchEvent) {
      if (event.touches.length !== 1) return;
      sx = event.touches[0].clientX;
      sy = event.touches[0].clientY;
      tracking = true;
    }

    function onEnd(event: TouchEvent) {
      if (!tracking || event.changedTouches.length === 0) return;
      tracking = false;
      const dx = event.changedTouches[0].clientX - sx;
      const dy = event.changedTouches[0].clientY - sy;
      // Ignore vertical scrolls, and anything too short to be deliberate.
      if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      setActive((current) => wrap(dx < 0 ? current + 1 : current - 1));
    }

    stage.addEventListener("touchstart", onStart, { passive: true });
    stage.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      stage.removeEventListener("touchstart", onStart);
      stage.removeEventListener("touchend", onEnd);
    };
  }, []);

  /** The rail is a column on desktop and a strip on narrow screens, so both
      axes move between stages — exactly as the source's handler does. */
  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const key = event.key;
    let next: number | null = null;

    if (key === "ArrowDown" || key === "ArrowRight") next = index + 1;
    else if (key === "ArrowUp" || key === "ArrowLeft") next = index - 1;
    else if (key === "Home") next = 0;
    else if (key === "End") next = COUNT - 1;

    if (next === null) return;
    event.preventDefault();
    const target = wrap(next);
    setActive(target);
    tabRefs.current[target]?.focus();
  }

  const stage = STAGES[active];
  /*
   * The approved v3 workflow photograph for this stage, taken from the pack's
   * README by STEP NUMBER rather than by name — stages 1 and 7 are both called
   * "Report" and have different pictures, so a name lookup would put step 1's
   * photograph under step 7.
   */
  const approved = WORKFLOW_PHOTOS[active];

  return (
    <section className="section section--tint" id="how">
      <div className="wrap">
        <div className="reveal">
          <p className="eyebrow">How it works</p>
          <h2 className="h2">
            When something breaks, one coordinator owns it until it&rsquo;s verified complete.
          </h2>
          {/*
            This heading and this section absorb four separate process blocks:
            the "We Report / We Coordinate / Work Completed / Sign-off" icon row,
            the standalone chat-and-timeline section, and the early CTA band that
            sat between them. Each described the same seven stages in a different
            shape, which is how a reader ends up scrolling past the fourth
            explanation of something they understood at the first.
          */}
          <p className="lede">
            Follow every job from report to result — reporting, assignment, tracking and
            analysis in one place. Select any stage to see who does what and what the
            system records.
          </p>
        </div>
        <div className="wf reveal">
          <ul className="wf__steps" role="tablist" aria-label="Workflow stages" id="wfSteps">
            {STAGES.map((item, index) => (
              // Keyed on index: two stages share the name "Report".
              <li key={index} role="presentation">
                <button
                  ref={(node) => {
                    tabRefs.current[index] = node;
                  }}
                  type="button"
                  role="tab"
                  id={`wfTab${index}`}
                  aria-controls="wfPanel"
                  aria-selected={index === active}
                  tabIndex={index === active ? 0 : -1}
                  onClick={() => setActive(index)}
                  onKeyDown={(event) => handleKeyDown(event, index)}
                >
                  <span className="wf__num">{index + 1}</span>
                  <span>
                    <strong>{item.name}</strong>
                    <span>{item.heading}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div>
            <div className="wf__stage" ref={stageRef}>
              {/*
                The approved photograph for this stage. `key` remounts it on a
                stage change so the browser starts the next picture cleanly
                rather than showing the previous one until the new one decodes.

                The first stage loads eagerly: it is what is on screen when the
                section is reached, and lazy-loading the visible image is the
                one case where the attribute costs more than it saves.
              */}
              <ApprovedPhoto
                key={approved}
                src={approved}
                alt={stage.alt}
                loading={active === 0 ? "eager" : "lazy"}
                sizes="(min-width: 1100px) 640px, (min-width: 700px) 60vw, 92vw"
                className="wf__photo"
              />
              <div
                className="wf__body"
                id="wfPanel"
                role="tabpanel"
                tabIndex={0}
                aria-labelledby={`wfTab${active}`}
              >
                <span className="badge badge--amber">
                  Stage {active + 1} of {COUNT}
                </span>
                <h3 style={{ marginTop: 12 }}>
                  {stage.name} — {stage.heading}
                </h3>
                <p className="lede">{stage.lede}</p>
                <dl className="wf__meta">
                  <div>
                    <dt>What you do</dt>
                    <dd>{stage.you}</dd>
                  </div>
                  <div>
                    <dt>What we record on your file</dt>
                    <dd>{stage.records}</dd>
                  </div>
                </dl>
              </div>
            </div>
            <div className="wf__bar" id="wfBar" aria-hidden="true">
              {STAGES.map((_, index) => (
                <i key={index} className={index <= active ? "is-done" : undefined} />
              ))}
            </div>
            <div className="wf__ctl">
              <button
                className="btn btn--ghost btn--sm"
                type="button"
                id="wfPrev"
                onClick={() => setActive((current) => wrap(current - 1))}
              >
                <svg
                  className="ic ic--xs"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M19 12H5M11 18l-6-6 6-6" />
                </svg>
                Previous
              </button>
              <span className="wf__count" id="wfCount" aria-hidden="true">
                {active + 1} / {COUNT}
              </span>
              <button
                className="btn btn--ghost btn--sm"
                type="button"
                id="wfNext"
                onClick={() => setActive((current) => wrap(current + 1))}
              >
                Next
                <svg
                  className="ic ic--xs"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </button>
            </div>
            <p className="wf__swipe">Swipe the panel, or use the arrows.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
