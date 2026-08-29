"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

/**
 * SECTION 10 — Trust strip, then the final CTA.
 *
 * A merge of two sections. The trust strip was the head of the dark `Trust`
 * section, whose other half was a rotating carousel of three testimonials
 * attributed to "Leading UK retail group", "Multi-site leisure operator" and
 * "Franchise group", each beside a stock portrait of someone who never said it.
 * That is gone: the brief does not list it among the ten, and an unattributable
 * quote next to a photograph of a stranger is worth less than nothing.
 *
 * The strip's four claims changed with it. They were a counter animating to
 * "1000+ tickets coordinated", "Multi-site", "One" and "Every job" — one
 * unverifiable number and three fragments. The four below are each a checkable
 * statement, and the fourth is the disclosure the footer is legally required to
 * make anyway.
 *
 * ── THE FORM ───────────────────────────────────────────────────────────────
 *
 * Eight questions on one panel, which is the brief's list exactly. It was a
 * three-step wizard over nine questions including "which service lines are you
 * interested in" — a question asked before the reader has been told what the
 * service lines cost, and one the brief drops.
 *
 * KEPT FROM THE WIZARD, because all three earn their place:
 *   · the sessionStorage draft, so a mis-tap on the back gesture does not throw
 *     away a part-filled form (not localStorage — it must not outlive the tab);
 *   · the honeypot, which fails silently rather than telling a bot why;
 *   · focus moving to the field that failed, on every submit, via a fresh error
 *     object so re-submitting into the same error still moves focus.
 *
 * It posts to `POST /public/portfolio-review` on the Railway API rather than
 * the legacy app's own `/api/leads`. The success shape changed with it: the old
 * route echoed the row it had written and the code checked for it, where the
 * new one answers `{ ok: true }` and nothing else. Checking for a `lead` that
 * is never sent would have failed every successful submission.
 */

const SITE_RANGES = ["1–5", "6–10", "11–25", "26+"] as const;
const ISSUE_VOLUMES = ["<5", "5–15", "15–40", "40+"] as const;
const PROBLEMS = [
  "Slow repairs",
  "Missing certificates",
  "Too many contractors",
  "No visibility",
  "Cost control",
  "Other",
] as const;

const REVIEW_POINTS = [
  "A review of how repairs are reported and chased today",
  "An honest read on where our contractor depth fits your regions",
  "A written scope and proposal shaped to the portfolio",
];

/** sessionStorage key for the part-completed form. */
const DRAFT_KEY = "mt_review_draft";

type ErrorField =
  | "name"
  | "company"
  | "email"
  | "phone"
  | "sites"
  | "regions"
  | "volume"
  | "problem"
  | "consent";

type FieldError = { field: ErrorField; message: string };

function CircleTick({ size }: { size: "ic--sm" | "ic--lg" }) {
  return (
    <svg
      className={`ic ${size}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="m8 12 3 3 5-6" />
    </svg>
  );
}

/* ── the trust strip ──────────────────────────────────────────────────────── */

const CLAIMS = [
  {
    title: "Vetted contractors",
    body: "Insurance & competence checked",
    icon: (
      <>
        <path d="M12 21s8-3.5 8-9V5l-8-3-8 3v7c0 5.5 8 9 8 9Z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
  },
  {
    title: "Documented evidence",
    body: "Standard on every job",
    icon: (
      <>
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2Z" />
        <circle cx="12" cy="13" r="4" />
      </>
    ),
  },
  {
    title: "Data protection",
    body: "ICO registered",
    icon: (
      <>
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </>
    ),
  },
  {
    title: "Maintsupp",
    body: "A trading name of Maintauk Ltd",
    icon: (
      <>
        <path d="M3 21V8l9-5 9 5v13" />
        <path d="M2 21h20M9 21v-6h6v6" />
      </>
    ),
  },
];

export function TrustStrip() {
  return (
    <section className="section section--dark trustbar" id="trust" aria-label="How we operate">
      <div className="wrap">
        <dl className="claims">
          {CLAIMS.map((claim) => (
            <div className="claim claim--iconed" key={claim.title}>
              <span className="claim__ic">
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
                  {claim.icon}
                </svg>
              </span>
              <dt>{claim.title}</dt>
              <dd>{claim.body}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

/* ── the CTA ──────────────────────────────────────────────────────────────── */

export function FinalCta() {
  const formRef = useRef<HTMLFormElement>(null);

  const [error, setError] = useState<FieldError | null>(null);
  const [status, setStatus] = useState("");
  const [sending, setSending] = useState(false);
  /** Set on success; holds the site range to echo back in the confirmation. */
  const [sentRange, setSentRange] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [sites, setSites] = useState("");
  const [regions, setRegions] = useState("");
  const [volume, setVolume] = useState("");
  const [problem, setProblem] = useState("");
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState("");

  const restored = useRef(false);
  /* eslint-disable react-hooks/set-state-in-effect -- restoring during render
     is not an option: the server has no sessionStorage, so a lazy initialiser
     would render empty fields on the server and filled ones on the client, and
     hydration would mismatch. The effect runs once, guarded by `restored`. */
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    try {
      const raw = window.sessionStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw) as Record<string, unknown>;
      if (typeof draft.name === "string") setName(draft.name);
      if (typeof draft.company === "string") setCompany(draft.company);
      if (typeof draft.email === "string") setEmail(draft.email);
      if (typeof draft.phone === "string") setPhone(draft.phone);
      if (typeof draft.sites === "string") setSites(draft.sites);
      if (typeof draft.regions === "string") setRegions(draft.regions);
      if (typeof draft.volume === "string") setVolume(draft.volume);
      if (typeof draft.problem === "string") setProblem(draft.problem);
      /* Consent is deliberately NOT restored: an accepted privacy notice has to
         be an action taken on this submission, not inherited from a draft. */
    } catch {
      // A malformed or unreadable draft is not worth interrupting anyone over.
    }
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (sentRange) return;
    try {
      window.sessionStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ name, company, email, phone, sites, regions, volume, problem }),
      );
    } catch {
      // Storage can be refused. The form still works, it just will not survive.
    }
  }, [name, company, email, phone, sites, regions, volume, problem, sentRange]);

  // A fresh object on every failure, so re-submitting into the same error still
  // moves focus back to the control that needs attention.
  useEffect(() => {
    if (!error) return;
    const control = formRef.current?.querySelector<HTMLElement>(`[name="${error.field}"]`);
    control?.scrollIntoView({ behavior: "smooth", block: "center" });
    control?.focus({ preventScroll: true });
  }, [error]);

  function fail(field: ErrorField, message: string) {
    setError({ field, message });
    return false;
  }

  function valid() {
    setError(null);
    if (!name.trim()) return fail("name", "Enter your name.");
    if (!company.trim()) return fail("company", "Enter your company name.");
    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(email.trim())) {
      return fail("email", "Enter a valid work email address.");
    }
    if (!phone.trim()) return fail("phone", "Enter a contact number.");
    if (!sites) return fail("sites", "Choose how many sites you operate.");
    if (!regions.trim()) return fail("regions", "Tell us which regions they are in.");
    if (!volume) return fail("volume", "Choose roughly how many issues you see a month.");
    if (!problem) return fail("problem", "Choose the problem that matters most today.");
    if (!consent) return fail("consent", "Please accept the privacy notice.");
    return true;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Honeypot: a bot filled a field no human can see. Fail silently rather
    // than tell it why.
    if (website) return;
    if (!valid()) return;

    setSending(true);
    setStatus("");

    const result = await api("/public/portfolio-review", {
      method: "POST",
      body: JSON.stringify({
        name,
        company,
        email,
        phone,
        siteRange: sites,
        /*
         * `challenge` is composed, not typed.
         *
         * It was a free-text box with a 20-character floor, which the API still
         * enforces. The brief replaces it with two dropdowns, so the two
         * answers are written into the field that carries them — rather than
         * dropping the volume on the floor because there is no column named
         * after it. Both sentences together clear twenty characters whichever
         * options are chosen.
         */
        challenge: `Biggest problem right now: ${problem}. Approx. maintenance issues per month: ${volume}.`,
        /* Regions is free text now, and the API takes a list. Split on commas
           so "Midlands, North" arrives as two regions rather than one oddly
           named one. */
        regions: regions
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
        /* The API stores a service list; the brief dropped the question that
           filled it. Sent empty rather than guessed — asking which service
           lines someone wants before they have been told what the lines cost
           is the question this form was rebuilt to remove. */
        services: [],
        /* Sent as well as checked above. The early return catches a bot driving
           the real form; forwarding the field is what catches one that posts
           straight at the endpoint, because the API runs the same trap and
           answers `{ ok: true }` without writing a row. */
        website,
      }),
    });

    if (!result.ok) {
      setStatus(result.error);
      setSending(false);
      return;
    }

    setSentRange(sites);
    try {
      // The lead is safely accepted, so the draft has done its job.
      window.sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      // Nothing to clean up if storage was never available.
    }
  }

  const errorFor = (field: ErrorField) => (error?.field === field ? error.message : null);
  const invalid = (field: ErrorField) => (error?.field === field ? true : undefined);
  const fieldClass = (field: ErrorField) =>
    `field${error?.field === field ? " is-invalid" : ""}`;

  return (
    <section className="section finalcta" id="review">
      {/*
        TWO NAMES FOR ONE PLACE. The section is `#review` because that is where
        "Book a Portfolio Review" has always pointed, from the header, the
        drawer and the footer. It is also the only form on the page that asks
        who you are and how to reach you, so it is what a reader clicking
        "Contact Us" in the navigation is looking for — but sending them to an
        anchor called `review`, under a heading that only offered a portfolio
        review, made the nav item read as a mistake. `#contact` names the same
        place, the old anchor still resolves, and the copy below says both
        things it has always done. Matches the canonical landing page.
      */}
      <div className="wrap finalcta__inner" id="contact">
        <div>
          <p className="eyebrow">Contact us or book a portfolio review</p>
          <h2 className="h2">
            Not sure where your maintenance is leaking time and money?
          </h2>
          <p className="lede">
            Book a free portfolio review — 30 minutes, no obligation. Or use the
            same form to tell us what you need.
          </p>
          <ul className="ticks" style={{ marginTop: 22 }}>
            {REVIEW_POINTS.map((point) => (
              <li key={point}>
                <CircleTick size="ic--sm" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
          <p className="note">
            Best suited to multi-site commercial operators seeking ongoing coordination
            rather than one-off domestic repairs.
          </p>
        </div>

        <form className="stepform" id="leadForm" ref={formRef} noValidate onSubmit={handleSubmit}>
          {sentRange !== null ? (
            <div className="leadsent">
              <CircleTick size="ic--lg" />
              <h3>Request received</h3>
              <p>
                Thank you. We review the portfolio details and come back within one working
                day, by your preferred method.
              </p>
              <p className="leadsent__meta">
                Portfolio size noted: <strong>{sentRange}</strong>
              </p>
            </div>
          ) : (
            <>
              <div className="stepform__grid stepform__grid--2">
                <div className={fieldClass("name")}>
                  <label htmlFor="lfName">Name</label>
                  <input
                    type="text"
                    id="lfName"
                    name="name"
                    autoComplete="name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    aria-invalid={invalid("name")}
                  />
                  {errorFor("name") && <p className="field__err">{errorFor("name")}</p>}
                </div>
                <div className={fieldClass("company")}>
                  <label htmlFor="lfCompany">Company</label>
                  <input
                    type="text"
                    id="lfCompany"
                    name="company"
                    autoComplete="organization"
                    value={company}
                    onChange={(event) => setCompany(event.target.value)}
                    aria-invalid={invalid("company")}
                  />
                  {errorFor("company") && <p className="field__err">{errorFor("company")}</p>}
                </div>
              </div>

              <div className="stepform__grid stepform__grid--2">
                <div className={fieldClass("email")}>
                  <label htmlFor="lfEmail">Email</label>
                  <input
                    type="email"
                    id="lfEmail"
                    name="email"
                    inputMode="email"
                    autoComplete="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    aria-invalid={invalid("email")}
                  />
                  {errorFor("email") && <p className="field__err">{errorFor("email")}</p>}
                </div>
                <div className={fieldClass("phone")}>
                  <label htmlFor="lfPhone">Phone</label>
                  <input
                    type="tel"
                    id="lfPhone"
                    name="phone"
                    inputMode="tel"
                    autoComplete="tel"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    aria-invalid={invalid("phone")}
                  />
                  {errorFor("phone") && <p className="field__err">{errorFor("phone")}</p>}
                </div>
              </div>

              <div className="stepform__grid stepform__grid--2">
                <div className={fieldClass("sites")}>
                  <label htmlFor="lfSites">Number of sites</label>
                  <select
                    id="lfSites"
                    name="sites"
                    value={sites}
                    onChange={(event) => setSites(event.target.value)}
                    aria-invalid={invalid("sites")}
                  >
                    <option value="">Select</option>
                    {SITE_RANGES.map((range) => (
                      <option key={range}>{range}</option>
                    ))}
                  </select>
                  {errorFor("sites") && <p className="field__err">{errorFor("sites")}</p>}
                </div>
                <div className={fieldClass("regions")}>
                  <label htmlFor="lfRegions">Regions</label>
                  <input
                    type="text"
                    id="lfRegions"
                    name="regions"
                    placeholder="Midlands, North, London"
                    value={regions}
                    onChange={(event) => setRegions(event.target.value)}
                    aria-invalid={invalid("regions")}
                  />
                  {errorFor("regions") && <p className="field__err">{errorFor("regions")}</p>}
                </div>
              </div>

              <div className={fieldClass("volume")}>
                <label htmlFor="lfVolume">Approx. maintenance issues per month</label>
                <select
                  id="lfVolume"
                  name="volume"
                  value={volume}
                  onChange={(event) => setVolume(event.target.value)}
                  aria-invalid={invalid("volume")}
                >
                  <option value="">Select</option>
                  {ISSUE_VOLUMES.map((entry) => (
                    <option key={entry}>{entry}</option>
                  ))}
                </select>
                {errorFor("volume") && <p className="field__err">{errorFor("volume")}</p>}
              </div>

              <div className={fieldClass("problem")}>
                <label htmlFor="lfProblem">Biggest problem right now</label>
                <select
                  id="lfProblem"
                  name="problem"
                  value={problem}
                  onChange={(event) => setProblem(event.target.value)}
                  aria-invalid={invalid("problem")}
                >
                  <option value="">Select</option>
                  {PROBLEMS.map((entry) => (
                    <option key={entry}>{entry}</option>
                  ))}
                </select>
                {errorFor("problem") && <p className="field__err">{errorFor("problem")}</p>}
              </div>

              {/* Honeypot. Off-screen rather than display:none — some bots skip
                  what is not rendered. */}
              <div className="hp" aria-hidden="true">
                <label htmlFor="lfWebsite">Website</label>
                <input
                  type="text"
                  id="lfWebsite"
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                  value={website}
                  onChange={(event) => setWebsite(event.target.value)}
                />
              </div>

              <label className={`consent${error?.field === "consent" ? " is-invalid" : ""}`}>
                <input
                  type="checkbox"
                  name="consent"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                <span>
                  I agree to Maintsupp contacting me about this enquiry, as described in the{" "}
                  <Link href="/privacy">Privacy Policy</Link>.
                </span>
              </label>
              {errorFor("consent") && <p className="field__err">{errorFor("consent")}</p>}

              <button
                className="btn btn--primary btn--block"
                type="submit"
                disabled={sending}
                style={{ marginTop: 18 }}
              >
                {sending ? "Sending…" : "Book My Portfolio Review"}
              </button>
              {status && (
                <p className="formstatus is-error" role="status">
                  {status}
                </p>
              )}
            </>
          )}
        </form>
      </div>
    </section>
  );
}
