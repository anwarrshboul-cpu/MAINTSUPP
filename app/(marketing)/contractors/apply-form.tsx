"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";

/*
 * The contractor application form.
 *
 * Validation behaves exactly as the landing page's two forms do, because a
 * visitor should not have to learn a second set of manners on the same site:
 * EVERY invalid field is reported at once rather than one per submit, each one
 * gets an inline message and a red outline, and the first offender is scrolled
 * to and focused.
 *
 * The browser's own `required` attributes are deliberately absent. They would
 * fire first and stop after the first field, which is the behaviour this whole
 * pattern exists to replace — and the server validates the same rules again
 * anyway, because nothing arriving over the wire is trusted.
 */

const TRADES = [
  "Electrical & lighting",
  "Plumbing & leaks",
  "Doors, locks & shutters",
  "HVAC & air conditioning",
  "Glazing",
  "Signage",
  "Drainage",
  "General maintenance & handyman",
  "Fire & compliance",
  "CCTV & security",
  "Other",
];

const YEARS = ["<1", "1–3", "3–5", "5+"];

/* Matches the server's. See the note there on why it is not a full parser. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

type Fields = {
  company: string;
  contactName: string;
  email: string;
  phone: string;
  trades: string[];
  regions: string;
  insured: string;
  yearsTrading: string;
  certifications: string;
  notes: string;
  consent: boolean;
};

const EMPTY: Fields = {
  company: "",
  contactName: "",
  email: "",
  phone: "",
  trades: [],
  regions: "",
  insured: "",
  yearsTrading: "",
  certifications: "",
  notes: "",
  consent: false,
};

/* Order matters twice over: it is the order the fields appear in, and it is the
   order the first-error scroll walks. */
const CHECKS: Array<[keyof Fields, (value: Fields) => string]> = [
  ["company", (f) => (f.company.trim() ? "" : "Enter your company or trading name.")],
  ["contactName", (f) => (f.contactName.trim() ? "" : "Tell us who we would be speaking to.")],
  [
    "email",
    (f) => {
      if (!f.email.trim()) return "Enter an email address.";
      if (!EMAIL.test(f.email.trim())) return "Enter a valid email address, such as name@company.co.uk.";
      return "";
    },
  ],
  [
    "phone",
    (f) => {
      if (!f.phone.trim()) return "Enter a contact number.";
      if (f.phone.replace(/[^0-9+]/g, "").length < 10) {
        return "Enter a full contact number, including the area or mobile prefix.";
      }
      return "";
    },
  ],
  ["trades", (f) => (f.trades.length ? "" : "Choose at least one trade.")],
  ["regions", (f) => (f.regions.trim() ? "" : "Tell us which regions you cover.")],
  ["insured", (f) => (f.insured ? "" : "Tell us whether public liability insurance is in place.")],
  ["consent", (f) => (f.consent ? "" : "Please confirm you are happy for us to hold these details.")],
];

export function ContractorApply() {
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof Fields, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<{ text: string; tone: "" | "is-ok" | "is-error" }>({
    text: "",
    tone: "",
  });

  const set = <K extends keyof Fields>(key: K) => (value: Fields[K]) =>
    setFields((current) => ({ ...current, [key]: value }));

  const invalid = (key: keyof Fields) => (errors[key] ? true : undefined);
  const fieldClass = (key: keyof Fields) => `field${errors[key] ? " is-invalid" : ""}`;
  const describedBy = (key: keyof Fields) => (errors[key] ? `${key}-err` : undefined);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;

    const found: Partial<Record<keyof Fields, string>> = {};
    for (const [name, check] of CHECKS) {
      const message = check(fields);
      if (message) found[name] = message;
    }
    setErrors(found);

    const first = CHECKS.map(([name]) => name).find((name) => found[name]);
    if (first) {
      setStatus({ text: "", tone: "" });
      /* Scroll first, then focus without scrolling again — a focus() that
         scrolls would undo the smooth scroll it was meant to complete. */
      const target = form.querySelector<HTMLElement>(`#${String(first)}`);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.focus({ preventScroll: true });
      return;
    }

    setSubmitting(true);
    setStatus({ text: "Sending your application…", tone: "" });
    try {
      const response = await fetch("/api/contractor-applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      const result = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "The application could not be submitted.");
      }
      setFields(EMPTY);
      setErrors({});
      setStatus({
        text:
          "Application received. We will review your details and come back to you — approval requires document checks before any work is assigned.",
        tone: "is-ok",
      });
    } catch (error) {
      setStatus({
        text: error instanceof Error ? error.message : "The application could not be submitted.",
        tone: "is-error",
      });
    } finally {
      setSubmitting(false);
    }
  }

  const req = <span className="req" aria-hidden="true">*</span>;

  return (
    <form className="form contractor-form" id="contractorForm" noValidate onSubmit={onSubmit}>
      <div className="form-grid">
        <div className={fieldClass("company")}>
          <label htmlFor="company">Company / trading name {req}</label>
          <input
            id="company"
            name="company"
            type="text"
            value={fields.company}
            aria-invalid={invalid("company")}
            aria-describedby={describedBy("company")}
            onChange={(event) => set("company")(event.target.value)}
          />
          <p className="field__err" id="company-err" hidden={!errors.company}>
            {errors.company}
          </p>
        </div>

        <div className={fieldClass("contactName")}>
          <label htmlFor="contactName">Contact name {req}</label>
          <input
            id="contactName"
            name="contactName"
            type="text"
            value={fields.contactName}
            aria-invalid={invalid("contactName")}
            aria-describedby={describedBy("contactName")}
            onChange={(event) => set("contactName")(event.target.value)}
          />
          <p className="field__err" id="contactName-err" hidden={!errors.contactName}>
            {errors.contactName}
          </p>
        </div>

        <div className={fieldClass("email")}>
          <label htmlFor="email">Email {req}</label>
          <input
            id="email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={fields.email}
            aria-invalid={invalid("email")}
            aria-describedby={describedBy("email")}
            onChange={(event) => set("email")(event.target.value)}
          />
          <p className="field__err" id="email-err" hidden={!errors.email}>
            {errors.email}
          </p>
        </div>

        <div className={fieldClass("phone")}>
          <label htmlFor="phone">Phone {req}</label>
          <input
            id="phone"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={fields.phone}
            aria-invalid={invalid("phone")}
            aria-describedby={describedBy("phone")}
            onChange={(event) => set("phone")(event.target.value)}
          />
          <p className="field__err" id="phone-err" hidden={!errors.phone}>
            {errors.phone}
          </p>
        </div>
      </div>

      {/*
        Trades is a checkbox group, not a <select multiple>. A multiple-select
        needs a modifier key to pick a second option on a desktop and collapses
        to an unlabelled scroll box on a phone — for eleven options that a
        contractor will usually tick three of, checkboxes are the control people
        can actually operate. A fieldset gives the group one accessible name.
      */}
      <fieldset className={`${fieldClass("trades")} fieldset`} id="trades" tabIndex={-1}>
        <legend>Trades {req}</legend>
        <div
          className="checkgroup"
          role="group"
          aria-invalid={invalid("trades")}
          aria-describedby={describedBy("trades")}
        >
          {TRADES.map((trade) => {
            const id = `trade-${trade.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
            const on = fields.trades.includes(trade);
            return (
              <label className="checkchip" key={trade} htmlFor={id}>
                <input
                  id={id}
                  type="checkbox"
                  name="trades"
                  value={trade}
                  checked={on}
                  onChange={() =>
                    set("trades")(
                      on ? fields.trades.filter((item) => item !== trade) : [...fields.trades, trade],
                    )
                  }
                />
                <span>{trade}</span>
              </label>
            );
          })}
        </div>
        <p className="field__err" id="trades-err" hidden={!errors.trades}>
          {errors.trades}
        </p>
      </fieldset>

      <div className={fieldClass("regions")}>
        <label htmlFor="regions">Regions covered {req}</label>
        <input
          id="regions"
          name="regions"
          type="text"
          placeholder="e.g. Greater London, Home Counties"
          value={fields.regions}
          aria-invalid={invalid("regions")}
          aria-describedby={describedBy("regions")}
          onChange={(event) => set("regions")(event.target.value)}
        />
        <p className="field__err" id="regions-err" hidden={!errors.regions}>
          {errors.regions}
        </p>
      </div>

      <fieldset className={`${fieldClass("insured")} fieldset`} id="insured" tabIndex={-1}>
        <legend>Public liability insurance in place? {req}</legend>
        <div
          className="chipgroup"
          role="radiogroup"
          aria-invalid={invalid("insured")}
          aria-describedby={describedBy("insured")}
        >
          {["Yes", "No"].map((option) => (
            <span key={option}>
              <input
                id={`insured-${option.toLowerCase()}`}
                type="radio"
                name="insured"
                value={option}
                checked={fields.insured === option}
                onChange={() => set("insured")(option)}
              />
              <label htmlFor={`insured-${option.toLowerCase()}`}>{option}</label>
            </span>
          ))}
        </div>
        <p className="field__err" id="insured-err" hidden={!errors.insured}>
          {errors.insured}
        </p>
      </fieldset>

      <div className="form-grid">
        <div className="field">
          <label htmlFor="yearsTrading">Years trading</label>
          <select
            id="yearsTrading"
            name="yearsTrading"
            value={fields.yearsTrading}
            onChange={(event) => set("yearsTrading")(event.target.value)}
          >
            <option value="">Select…</option>
            {YEARS.map((option) => (
              <option value={option} key={option}>
                {option}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="certifications">Certifications &amp; registrations</label>
          <input
            id="certifications"
            name="certifications"
            type="text"
            placeholder="e.g. NICEIC, Gas Safe, F-Gas"
            value={fields.certifications}
            onChange={(event) => set("certifications")(event.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="notes">Anything else</label>
        <textarea
          id="notes"
          name="notes"
          rows={4}
          value={fields.notes}
          onChange={(event) => set("notes")(event.target.value)}
        />
      </div>

      <div className={fieldClass("consent")}>
        <label className="consent" htmlFor="consent">
          <input
            id="consent"
            name="consent"
            type="checkbox"
            checked={fields.consent}
            aria-invalid={invalid("consent")}
            aria-describedby={describedBy("consent")}
            onChange={(event) => set("consent")(event.target.checked)}
          />
          <span>
            I am happy for Maintsupp to hold these details in order to assess this
            application, as described in the{" "}
            <Link href="/privacy">Privacy Policy</Link>. {req}
          </span>
        </label>
        <p className="field__err" id="consent-err" hidden={!errors.consent}>
          {errors.consent}
        </p>
      </div>

      <button className="btn btn--primary btn--lg" type="submit" disabled={submitting}>
        {submitting ? "Sending…" : "Submit Application"}
      </button>

      {/* Announced, not just shown: a reader who submitted from the keyboard is
          at the button, and the outcome appears below it. */}
      <p
        className={`formstatus ${status.tone}`}
        role="status"
        aria-live="polite"
        hidden={!status.text}
      >
        {status.text}
      </p>
    </form>
  );
}
