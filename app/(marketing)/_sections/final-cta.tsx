"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";

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
 * Five questions on one panel: who you are, how to reach you, and how big the
 * portfolio is. It was a three-step wizard over nine questions including
 * "which service lines are you interested in" — a question asked before the
 * reader has been told what the service lines cost — then a single panel of
 * eight.
 *
 * THREE OF THOSE EIGHT ARE GONE, on the owner's instruction: "Regions",
 * "Approx. maintenance issues per month" and "Biggest problem right now". They
 * were the three that asked a stranger to profile their own estate before
 * anyone had earned the answer, and the last two only existed to be glued back
 * together into a `challenge` string the API happened to have a column for.
 * Removing them is a contract change, not a markup change: /api/leads required
 * `regions` and a 20-character `challenge`, so leaving the fields out without
 * touching the route would have made every submission a 400. The route no
 * longer requires either — see the comment there.
 *
 * KEPT FROM THE WIZARD, because all three earn their place:
 *   · the sessionStorage draft, so a mis-tap on the back gesture does not throw
 *     away a part-filled form (not localStorage — it must not outlive the tab);
 *   · the honeypot, which fails silently rather than telling a bot why;
 *   · focus moving to the field that failed, on every submit, via a fresh error
 *     object so re-submitting into the same error still moves focus.
 */

const SITE_RANGES = ["1–5", "6–10", "11–25", "26+"] as const;

const REVIEW_POINTS = [
  "A review of how repairs are reported and chased today",
  "An honest read on where our contractor depth fits your regions",
  "A written scope and proposal shaped to the portfolio",
];

/** sessionStorage key for the part-completed form. */
const DRAFT_KEY = "mt_review_draft";

/*
 * Every member of this union must name a control that is actually rendered:
 * the focus effect below looks the failed field up by `[name="…"]`, and a
 * field name with no control behind it would move focus nowhere and leave the
 * reader with a message they cannot act on. `regions`, `volume` and `problem`
 * left the union with their inputs.
 */
type ErrorField = "name" | "company" | "email" | "phone" | "sites" | "consent";

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
              {/*
                * The icon lives INSIDE the <dt>, not beside it. A <div> group in
                * a <dl> may only hold <dt> and <dd>, so a sibling <span> made
                * the list invalid — axe reports it as a serious violation and a
                * screen reader loses the term/description pairing. The stacked
                * look is unchanged; `.claim dt` does the stacking now.
                */}
              <dt>
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
                <span className="claim__title">{claim.title}</span>
              </dt>
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
      /* A draft written before the three fields were removed still carries
         `regions`, `volume` and `problem`. They are not read back — there is
         nowhere to put them — and the next keystroke rewrites the draft
         without them, so nothing here has to migrate anything. */
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
        JSON.stringify({ name, company, email, phone, sites }),
      );
    } catch {
      // Storage can be refused. The form still works, it just will not survive.
    }
  }, [name, company, email, phone, sites, sentRange]);

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
    try {
      const response = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          company,
          email,
          phone,
          siteRange: sites,
          /*
           * `challenge` and `regions` are NOT sent, and nothing is invented to
           * stand in for them.
           *
           * `challenge` used to be composed here out of the two dropdowns —
           * "Biggest problem right now: X. Approx. maintenance issues per
           * month: Y." — because the API enforced a 20-character floor left
           * over from the free-text box those dropdowns replaced. With the
           * dropdowns gone there is no answer to compose, and a hard-coded
           * sentence would be a lie told to satisfy a length check. `regions`
           * likewise: an empty array is what we know, so an empty array is
           * what the route stores. Both stopped being required there.
           */
        }),
      });
      const result: { lead?: unknown; error?: string } = await response.json();
      if (!response.ok || !result.lead) {
        throw new Error(result.error || "The request could not be sent.");
      }
      setSentRange(sites);
      try {
        // The lead is safely accepted, so the draft has done its job.
        window.sessionStorage.removeItem(DRAFT_KEY);
      } catch {
        // Nothing to clean up if storage was never available.
      }
    } catch (caught) {
      const message =
        caught instanceof Error && caught.message
          ? caught.message
          : "The request could not be sent. Please try again.";
      setStatus(message);
      setSending(false);
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
        "Contact Us" is looking for — but sending them to an anchor called
        `review`, under a heading that only offered a portfolio review, made
        the nav item read as a mistake. `#contact` names the same place, the
        old anchor still resolves, and the copy below now says both things it
        has always done.
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

              {/* "Number of sites" was the left half of a two-up row whose
                  right half was Regions. Rather than leave a half-width select
                  beside a hole, it takes the whole row — the shape the two
                  dropdowns below it used to have. */}
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
