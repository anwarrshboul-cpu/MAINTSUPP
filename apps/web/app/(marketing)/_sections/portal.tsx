"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { PhotoSlot } from "./photo";

/**
 * Client portal — four dashboard views in a browser frame, with explainer pins
 * over the overview. Ported from the standalone landing page: markup, class
 * names, copy and pin coordinates are the source's.
 */

type View = "overview" | "jobs" | "compliance" | "spend";

type Tab = {
  view: View;
  label: string;
  /** The path shown in the fake address bar; Spend is filed under reports. */
  url: string;
  icon: ReactNode;
  slot: string;
  desc: string;
  alt: string;
};

const TABS: readonly Tab[] = [
  {
    view: "overview",
    label: "Overview",
    url: "overview",
    icon: (
      <svg
        className="ic ic--sm"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 14 16 9" />
        <path d="M3.5 18a9 9 0 1 1 17 0" />
      </svg>
    ),
    slot: "dashboard-overview",
    desc: "Client portal — Dashboard Overview",
    alt: "The client portal overview screen, showing sample counts for open, overdue and completed jobs",
  },
  {
    view: "jobs",
    label: "Jobs",
    url: "jobs",
    icon: (
      <svg
        className="ic ic--sm"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="8" y="2" width="8" height="4" rx="1" />
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      </svg>
    ),
    slot: "dashboard-jobs",
    desc: "Client portal — Live job list",
    alt: "The client portal job list, showing sample jobs with status, site and priority",
  },
  {
    view: "compliance",
    label: "Compliance",
    url: "compliance",
    icon: (
      <svg
        className="ic ic--sm"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 21s8-3.5 8-9V5l-8-3-8 3v7c0 5.5 8 9 8 9Z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    ),
    slot: "dashboard-compliance",
    desc: "Client portal — Compliance overview",
    alt: "The client portal compliance screen, showing sample certificates and expiry dates by site",
  },
  {
    view: "spend",
    label: "Spend",
    url: "reports",
    icon: (
      <svg
        className="ic ic--sm"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M7 21h10M8 12h6M9 21V9a4 4 0 0 1 7-2.6" />
      </svg>
    ),
    slot: "dashboard-spend",
    desc: "Client portal — Spend and reporting",
    alt: "The client portal spend screen, showing sample cost by site and trade",
  },
];

type Spot = {
  /** Percentages of the design, so the pins stay aligned at every width. */
  x: number;
  y: number;
  w: number;
  h: number;
  t: string;
  b: string;
};

const SPOTS: readonly Spot[] = [
  { x: 16.5, y: 10.0, w: 14.2, h: 19.0, t: "Active units", b: "Every unit under coordination, grouped by sector. Click through in the live portal for the site register." },
  { x: 31.2, y: 10.0, w: 14.2, h: 19.0, t: "Requiring attention", b: "Units with an open issue that is ageing, awaiting parts or awaiting your approval." },
  { x: 45.9, y: 10.0, w: 14.2, h: 19.0, t: "Open jobs", b: "Live count with estimated value, so you can see committed spend before it lands as invoices." },
  { x: 60.6, y: 10.0, w: 14.2, h: 19.0, t: "Overdue", b: "Anything past its agreed target. This is the number we are judged on, and it is never hidden." },
  { x: 75.3, y: 10.0, w: 14.2, h: 19.0, t: "Completed in 7 days", b: "Closed with photo evidence, notes and cost reconciled against the approved quote." },
  { x: 90.0, y: 10.0, w: 9.2, h: 19.0, t: "Compliance", b: "Share of tracked requirements on schedule, with the month-on-month movement." },
  { x: 16.5, y: 30.5, w: 47.0, h: 35.0, t: "Units requiring attention", b: "The worklist your coordinator is actually working, in priority order, with days open and the next action." },
  { x: 64.5, y: 30.5, w: 34.5, h: 35.0, t: "Jobs by status", b: "Where the open work sits — assigned, awaiting parts, on hold or scheduled." },
  { x: 16.5, y: 66.5, w: 28.0, h: 31.0, t: "Spend trend", b: "Rolling spend so finance can see the shape of the year, not just this month." },
  { x: 45.5, y: 66.5, w: 25.0, h: 31.0, t: "Compliance score", b: "Requirements on track against total, with the certificates driving it." },
  { x: 71.5, y: 66.5, w: 27.5, h: 31.0, t: "Jobs by trade", b: "Which trades your estate consumes most — the starting point for a planned intervention." },
];

export function Portal() {
  const [view, setView] = useState<View>("overview");
  const [openSpot, setOpenSpot] = useState<number | null>(null);
  const [hintGone, setHintGone] = useState(false);

  const current = TABS.find((tab) => tab.view === view) ?? TABS[0];
  // The other three views are self-describing; only the overview is a wall of
  // figures that needs explaining.
  const isOverview = view === "overview";

  useEffect(() => {
    // A click anywhere that is not on a pin closes the open tip. React's own
    // handler runs first, so a click on a pin has already toggled by the time
    // this sees it — and the closest() test then leaves it alone.
    function onClick(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".hotspot")) setOpenSpot(null);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpenSpot(null);
    }
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <section className="section" id="portal">
      <div className="wrap">
        <div className="reveal">
          <p className="eyebrow">Client portal</p>
          <h2 className="h2">Total visibility. Total control.</h2>
          <p className="lede">
            Authorised users see live jobs, compliance dates, approvals, spend and
            evidence across their permitted sites — and nothing from anyone else’s
            portfolio.
          </p>
        </div>
        <div className="tabs reveal" role="tablist" aria-label="Dashboard views" id="dashTabs">
          {TABS.map((tab) => (
            <button
              key={tab.view}
              type="button"
              role="tab"
              aria-selected={tab.view === view}
              onClick={() => setView(tab.view)}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        <div className="dashshot reveal" id="dashShot">
          <div className="dashshot__frame">
            <span className="dashshot__dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="dashshot__url" id="dashUrl">
              portal.maintsupp.com / {current.url}
            </span>
            <span className="dashshot__tag">Sample data</span>
          </div>
          <div className="dashshot__stage">
            {/* All four stay mounted: a screenshot already decoded should not be
                torn down and refetched when the visitor tabs back to it. */}
            {TABS.map((tab) => (
              <PhotoSlot
                key={tab.view}
                slot={tab.slot}
                w={1672}
                h={941}
                alt={tab.alt}
                desc={tab.desc}
                className={`dashshot__img${tab.view === view ? " is-on" : ""}`}
              />
            ))}
            <div className="hotspots" id="dashHotspots" hidden={!isOverview}>
              {SPOTS.map((spot, index) => {
                const low = spot.y > 55;
                const mid = spot.x + spot.w / 2;
                const edge = mid > 74 ? " hotspot--right" : mid < 26 ? " hotspot--left" : "";
                return (
                  <button
                    key={spot.t}
                    type="button"
                    className={`hotspot${low ? " hotspot--low" : ""}${edge}${
                      openSpot === index ? " is-on" : ""
                    }`}
                    style={{
                      left: `${spot.x}%`,
                      top: `${spot.y}%`,
                      width: `${spot.w}%`,
                      height: `${spot.h}%`,
                    }}
                    aria-label={`${spot.t}: ${spot.b}`}
                    onClick={(event) => {
                      event.preventDefault();
                      // Tap toggles this one and closes the rest.
                      setOpenSpot((open) => (open === index ? null : index));
                      setHintGone(true);
                    }}
                    onMouseEnter={() => setHintGone(true)}
                  >
                    <span className="hotspot__tip">
                      <strong>{spot.t}</strong>
                      {spot.b}
                    </span>
                  </button>
                );
              })}
            </div>
            <p
              className={`dashhint${hintGone ? " is-gone" : ""}`}
              id="dashHint"
              hidden={!isOverview}
            >
              <svg
                className="ic ic--xs"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M9 11.5 12 8l3 3.5M12 8v8" />
                <circle cx="12" cy="12" r="10" />
              </svg>
              Hover or tap any figure to see what it means
            </p>
          </div>
        </div>
        {/*
          The same eleven explanations, as a list, for phones.

          The overlay above positions its buttons as percentages of the
          screenshot, so at 320px they measure 41x31 — under the 44px touch
          minimum, and impossible to grow: six of them sit 42px apart with a
          1.4px gap between neighbours. Rather than ship a tap target a thumb
          cannot hit, `marketing.css` hides the overlay below 760px and shows
          this instead, where the copy needs no tap at all.

          `hidden={!isOverview}` mirrors the overlay: these labels describe the
          overview screenshot specifically, so they go away with it when
          another tab is selected. No extra bytes — SPOTS is already in the
          bundle to render the tips.
        */}
        <dl className="spotlist" hidden={!isOverview}>
          {SPOTS.map((spot) => (
            <div key={spot.t}>
              <dt>{spot.t}</dt>
              <dd>{spot.b}</dd>
            </div>
          ))}
        </dl>
        {/* The six things a client opens it to see. Written as a plain list
            rather than another set of cards — the dashboard above is the
            illustration, and a second illustration of the same thing is what
            the rest of this rebuild was removing. */}
        <ul className="ticks portal__points reveal">
          {[
            "Open jobs by priority and site",
            "Assignment and attendance status in real time",
            "Compliance due in 90/60/30 days",
            "Spend by site and trade",
            "Contractor performance scores",
            "Quotes waiting for your approval",
          ].map((point) => (
            <li key={point}>
              <svg
                className="ic ic--sm"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
              <span>{point}</span>
            </li>
          ))}
        </ul>
        <p className="lede portal__promise reveal">
          Every client gets portfolio visibility — no spreadsheets, no chasing for
          updates.
        </p>
        <p className="note reveal">
          The client portal, shown with sample data. The public website never queries
          live portal records — that boundary is enforced on the server, not in the
          browser.
        </p>
        <p className="center reveal" style={{ marginTop: 24 }}>
          {/* `/portal`, not the legacy `/dashboard`. The front door in this app
              is the portal sign-in — one name for one door, the same one the
              header, the utility bar and the footer use. */}
          <Link className="btn btn--primary btn--lg" href="/portal">
            Open Client Portal
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
          </Link>
        </p>
      </div>
    </section>
  );
}
