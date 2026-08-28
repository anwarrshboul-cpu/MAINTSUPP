"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ApprovedPhoto } from "./approved-photo";

/**
 * How it works — the seven-stage stepper, ported from the standalone landing
 * page. Markup, class names and copy are the source's; only the plumbing
 * (innerHTML strings, manual class toggling) becomes React state.
 *
 * ONE CARD, NO LIST. The port carried the source's left-hand rail of seven
 * tab buttons beside the stage card. On a desktop that rail repeated every
 * stage name and heading the card was about to show, and on a phone it became
 * a strip above the card that nobody used because the card has its own
 * arrows and takes a swipe. It is gone, and the card takes the full width.
 * Keyboard users lost nothing: the card itself is focusable and the arrow
 * keys move between stages on it, exactly as they did on the rail.
 */

type Stage = {
  /** The stage's name — the one red word. Note stages 1 and 7 are both "Report". */
  name: string;
  heading: string;
  lede: string;
  you: string;
  records: string;
  /** Description of the photograph, carried through to the generated artwork. */
  desc: string;
  alt: string;
  /**
   * `object-position` for this stage's photograph, where centring it would cut
   * the subject. The frame is far wider than the 16:9 pictures at desktop, so
   * the crop is VERTICAL — roughly the middle half of the image survives — and
   * a subject whose head sits in the upper third loses it to a centred crop.
   * Left unset wherever centre is already the right band.
   */
  focus?: string;
};

const STAGES: readonly Stage[] = [
  {
    name: "Report",
    heading: "Logged with the detail that matters",
    lede: "The site logs the requirement with location, photographs, urgency and access information. A reference is issued immediately.",
    you: "You tell us what, where and how urgent.",
    records: "Ticket created with reference and timestamp.",
    desc: "Store manager photographing a fault on a phone",
    alt: "A store manager photographing a water-stained ceiling fault on a phone",
    /* The fault itself is in the ceiling, at the very top of the frame — a
       centred crop throws away the thing being reported. */
    focus: "center top",
  },
  {
    name: "Triage",
    heading: "Priority set by someone accountable",
    lede: "Priority, safety implications, access restrictions and the next action are assessed against the agreed framework — not by whoever shouts loudest.",
    you: "We confirm priority, trading impact and trade.",
    records: "Priority confirmed and route decided.",
    desc: "Coordinator at a desk reviewing incoming jobs",
    alt: "A coordinator in a headset reviewing incoming jobs across two monitors",
    /* Her headset and the tops of both monitors sit above the middle band. */
    focus: "center 30%",
  },
  {
    name: "Approve",
    heading: "Spend confirmed against agreed limits",
    lede: "Scope, quote and spend are checked against your approval thresholds before anyone is instructed.",
    you: "You approve quotes above the agreed threshold.",
    records: "Decision, approver and timestamp recorded.",
    desc: "Manager approving a quote on a laptop or tablet",
    alt: "A manager reviewing an invoice and payment screen on a laptop",
    /* He is the tallest subject of the seven: his head starts a few per cent
       from the top, so anything near centre decapitates him. */
    focus: "center 10%",
  },
  {
    name: "Assign",
    heading: "The right contractor, properly briefed",
    lede: "A vetted contractor is selected by trade, region, availability and suitability, and issued a work order with scope, access and evidence conditions.",
    you: "Nothing — this is ours to run.",
    records: "Contractor, target date and work-order reference.",
    desc: "Contractor receiving a work order, van or toolbag visible",
    alt: "A contractor reading a work order on a phone at an open van of toolboxes",
    /* His cap and the loaded shelves both sit in the upper half. */
    focus: "center 25%",
  },
  {
    name: "Attend",
    heading: "On site, with the context they need",
    lede: "The contractor attends, resolves or makes safe, and records findings with before and after photographs.",
    you: "Site provides access as arranged.",
    records: "Attendance time and findings logged.",
    desc: "Engineer working on site in a commercial unit",
    alt: "A hi-vis engineer working on a wall-mounted electrical panel",
    /* Hard hat and the panel he has his hands in are both above centre. */
    focus: "center 25%",
  },
  {
    name: "Verify",
    heading: "Closed on evidence, not assurance",
    lede: "Evidence, certificates, costs and completion details are checked before the job is allowed to close.",
    you: "You can accept or query the closure.",
    records: "Evidence accepted, job closed, cost reconciled.",
    desc: "Completed repair being photographed and checked",
    alt: "A hi-vis engineer photographing a completed ceiling unit in a corridor",
    /* The completed ceiling unit — the evidence — is near the top, and the
       raised phone and hard hat with it. */
    focus: "center 15%",
  },
  {
    name: "Report",
    heading: "A portfolio view you can act on",
    lede: "Live dashboard plus a monthly portfolio report covering jobs, compliance, spend, repeat faults and recommendations.",
    you: "You review and set priorities for next month.",
    records: "Performance measures and recommendations.",
    desc: "Operations team reviewing a report or dashboard screen",
    alt: "Two colleagues reviewing a performance dashboard on a large monitor",
    /* The monitor is centred left-to-right but its top edge is high; a small
       lift keeps the whole screen and both heads. */
    focus: "center 30%",
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
 *
 * WHY EVERY STEM ENDS `-v3`. The previous pass put the re-shot pictures behind
 * the filenames the superseded ones already had. Static assets are served
 * `Cache-Control: public, max-age=31536000, immutable`, and `immutable` means a
 * browser will not even ask whether the file changed — so every returning
 * visitor kept being shown the old blurred-edge photographs from disk cache
 * while the server was answering correctly to anyone new. The version in the
 * name is what makes the derived `-480/-960/-1400` URLs new too, and a URL
 * nobody has fetched cannot come from anybody's cache.
 *
 * Nothing named `-full` exists under /assets/workflow any more: those files are
 * deleted, so such a path would now be a 404 as well as the wrong picture. A
 * future re-shoot gets a new suffix, never a quiet overwrite of these.
 */
const WORKFLOW_PHOTOS = [
  "/assets/workflow/how-it-works-01-report-v3.jpg",
  "/assets/workflow/how-it-works-02-triage-v3.png",
  "/assets/workflow/how-it-works-03-approve-v3.png",
  "/assets/workflow/how-it-works-04-assign-v3.png",
  "/assets/workflow/how-it-works-05-attend-v3.png",
  "/assets/workflow/how-it-works-06-verify-v3.png",
  "/assets/workflow/how-it-works-07-reporting-v3.png",
] as const;

export function Workflow() {
  const [active, setActive] = useState(0);
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

  /**
   * Arrow keys on the card (or on either arrow button, which bubble up to
   * it) move between stages; Home and End jump to the first and last. The
   * rail used to own this handler; the card does now, so a keyboard user
   * still has every move the rail gave them.
   */
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const key = event.key;
    let next: number | null = null;

    if (key === "ArrowRight" || key === "ArrowDown") next = active + 1;
    else if (key === "ArrowLeft" || key === "ArrowUp") next = active - 1;
    else if (key === "Home") next = 0;
    else if (key === "End") next = COUNT - 1;

    if (next === null) return;
    event.preventDefault();
    setActive(wrap(next));
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
            analysis in one place. Step through the seven stages to see who does what and
            what the system records.
          </p>
        </div>
        <div className="wf reveal">
          {/*
            The card is the stepper. `role="group"` with a name that changes
            with the stage gives a screen reader the "Stage 2 of 7: Triage"
            context the tab list used to supply, and `aria-live` on the body
            announces the new stage when the arrows, a swipe or a key move it.
            The old `role="tabpanel"` / `aria-labelledby="wfTab…"` went with
            the tabs they pointed at — a tabpanel with no tab is an ARIA error.
          */}
          <div
            className="wf__stage"
            ref={stageRef}
            tabIndex={0}
            role="group"
            aria-roledescription="stage"
            aria-label={`Stage ${active + 1} of ${COUNT}: ${stage.name}. Use the arrow keys to move between stages.`}
            onKeyDown={handleKeyDown}
          >
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
              sizes="(min-width: 1360px) 1240px, 92vw"
              className="wf__photo"
              objectPosition={stage.focus}
            />
            <div className="wf__body" id="wfPanel" aria-live="polite">
              <span className="badge badge--amber">
                Stage {active + 1} of {COUNT}
              </span>
              {/* Only the stage's NAME is red. The dash and the explanation
                  after it keep the heading colour. */}
              <h3 className="wf__title">
                <span className="wf__stage-name">{stage.name}</span> — {stage.heading}
              </h3>
              <p className="lede">{stage.lede}</p>
              <dl className="wf__meta">
                <div>
                  <dt>What you do</dt>
                  <dd>{stage.you}</dd>
                </div>
                <div>
                  <dt>What the system records</dt>
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
              aria-label="Previous stage"
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
              aria-label="Next stage"
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
    </section>
  );
}
