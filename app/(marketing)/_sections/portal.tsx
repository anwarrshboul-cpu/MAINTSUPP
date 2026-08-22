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


export function Portal() {
  const [view, setView] = useState<View>("overview");

  const current = TABS.find((tab) => tab.view === view) ?? TABS[0];
  // The other three views are self-describing; only the overview is a wall of
  // figures that needs explaining.
  const isOverview = view === "overview";


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
          </div>
        </div>
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
          Sample data shown. Client data is only visible to authorised users after
          secure login.
        </p>
        <p className="center reveal" style={{ marginTop: 24 }}>
          {/* A text link, not a button, and pointing at /portal — the same
              label and destination the nav uses, so the two cannot drift. */}
          <Link className="portal__login" href="/portal">
            Portal Login
          </Link>
        </p>
      </div>
    </section>
  );
}
