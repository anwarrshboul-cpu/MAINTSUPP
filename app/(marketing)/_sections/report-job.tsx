"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import type { DragEvent, FormEvent } from "react";

/**
 * SECTION 2 — Report a Job.
 *
 * This was the right-hand column of the hero. It is its own section now, which
 * is what let the hero become a hero: one proposition, two buttons and three
 * chips, instead of a headline sharing the fold with an eleven-field form.
 *
 * THE TITLE APPEARS ONCE. It is the section heading. The card used to repeat
 * it in its own head — "Report a Job" above the section called "Report a Job" —
 * so the card now opens straight onto the fields with a single line of
 * instruction.
 *
 * ── TWO BUGS INHERITED FROM THE OLD FORM, BOTH FIXED HERE ──────────────────
 *
 * Neither was visible from the page: the form said "Request … received" both
 * times, because the API accepted the submission and quietly corrected it.
 *
 *  1. IT WROTE A PRIORITY THE BOARD DOES NOT HAVE. Trading-impaired reports
 *     were sent as `"High"`. The board's Priority column carries exactly three
 *     labels — Medium, Low, Urgent (db/monday-board-spec.ts, captured from
 *     monday) — and `configuredValue` in app/lib/options-repository.ts falls
 *     back to the DEFAULT when a value does not match. So the second-most
 *     urgent thing a store can report arrived at the bottom of the pile.
 *
 *  2. IT WROTE THREE ENGINEER TYPES THAT DO NOT EXIST. `HVAC`, `Plumber` and
 *     `Specialist`, against an option set of `Plummer`, `Electrician`,
 *     `Handyman`, `Other`. Same silent fallback: three of the five branches
 *     landed on the default trade. (`Plummer` is monday's own typo, reproduced
 *     deliberately so imported rows map one-to-one — see the board spec.)
 *
 * Both maps below are written against the option sets rather than invented, and
 * `tests/stage-eleven-marketing.test.mjs` compares them to the spec so the next
 * label change on monday fails a test instead of a submission.
 */

/* ── attachments ──────────────────────────────────────────────────────────── */

const MAX_FILES = 6;
const MAX_MB = 25;
const OK_TYPES = /^(image\/(jpeg|png|webp|heic|heif)|video\/(mp4|quicktime|webm|3gpp))$/i;

type Picked = { file: File; url: string };

/* ── what the board can actually store ────────────────────────────────────── */

/**
 * The four urgencies the spec asks for, against the three the board has.
 *
 * P1 and P2 both map to `Urgent` because the alternative is worse: `Medium` is
 * the same label a routine job gets, and a store that cannot trade properly is
 * not a routine job. The four-way distinction is not lost — the P-code is
 * written into the description, which is the field triage reads first.
 */
const URGENCIES = [
  {
    id: "p1",
    code: "P1",
    label: "P1 — Critical, site unsafe or cannot trade",
    /* The response time each priority buys, in the approved reference's own
       words. A reporter choosing between P1 and P3 is really choosing between
       four hours and five days, and the form was not telling them that. */
    sla: "Within 4 hrs",
    priority: "Urgent",
  },
  { id: "p2", code: "P2", label: "P2 — Urgent, trading impaired", sla: "Next working day", priority: "Urgent" },
  { id: "p3", code: "P3", label: "P3 — Routine", sla: "5 working days", priority: "Medium" },
  { id: "p4", code: "P4", label: "P4 — Cosmetic / quote request", sla: "Quoted, then scheduled", priority: "Low" },
] as const;

/** The eight fault categories, each mapped onto a real `engineer_required` option. */
const CATEGORIES = [
  { label: "Electrical & lighting", engineer: "Electrician" },
  { label: "Plumbing & leaks", engineer: "Plummer" },
  { label: "Doors, locks & shutters", engineer: "Handyman" },
  { label: "HVAC & air conditioning", engineer: "Other" },
  { label: "Glazing", engineer: "Other" },
  { label: "Signage", engineer: "Other" },
  { label: "Drainage", engineer: "Plummer" },
  { label: "Other", engineer: "Other" },
] as const;

/* ── validation ───────────────────────────────────────────────────────────── */

/**
 * UK postcode, in the form the Royal Mail specification allows.
 *
 * Deliberately not exhaustive about which letters may appear where — that
 * version rejects real postcodes as they are introduced. This checks the SHAPE
 * (one or two letters, a digit, an optional letter or digit, then a space and
 * the inward code), which is what catches the actual mistake: a house number,
 * a partial code, or the town typed into the wrong box.
 */
const POSTCODE = /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}$/;
const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/;

/**
 * Every required field, in the order it appears on screen.
 *
 * The order matters twice: the first error is the one scrolled to, and it must
 * be the first problem the reader would reach going down the form.
 */
const CHECKS: Array<[string, (value: string) => string]> = [
  ["rjSite", (v) => (v.trim() ? "" : "Tell us which site or store this is for.")],
  ["rjName", (v) => (v.trim() ? "" : "Tell us who is reporting this.")],
  [
    "rjPhone",
    (v) => {
      if (!v.trim()) return "A contact number is needed so the contractor can arrange access.";
      if (v.replace(/[^0-9+]/g, "").length < 10) {
        return "Enter a full contact number, including the area or mobile prefix.";
      }
      return "";
    },
  ],
  [
    "rjEmail",
    (v) => {
      if (!v.trim()) return "An email address is needed for the job reference.";
      if (!EMAIL.test(v.trim())) return "Enter a valid email address.";
      return "";
    },
  ],
  ["rjAddress", (v) => (v.trim() ? "" : "Enter the site address.")],
  [
    "rjPostcode",
    (v) => {
      if (!v.trim()) return "Enter the site postcode.";
      if (!POSTCODE.test(v.trim())) return "Enter a valid UK postcode, such as E14 5AA.";
      return "";
    },
  ],
  ["rjCategory", (v) => (v ? "" : "Choose the fault category.")],
  ["rjUrgency", (v) => (v ? "" : "Choose how urgent this is.")],
  /*
   * Description and evidence are required in the approved reference, and the
   * reason is operational rather than editorial: a coordinator triaging "P1,
   * Electrical, Oxford Street" with no sentence and no photograph has to ring
   * the store back before they can even choose a trade. Both were optional.
   */
  [
    "rjDesc",
    (v) =>
      v.trim().length >= 10
        ? ""
        : "Describe the fault — a sentence is enough, and it decides who we send.",
  ],
];

type FieldValue = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function valueOf(form: HTMLFormElement, id: string) {
  return String(form.querySelector<FieldValue>(`#${id}`)?.value ?? "");
}

/* ── the section ──────────────────────────────────────────────────────────── */

export function ReportJob() {
  const [urgency, setUrgency] = useState("");
  const [picked, setPicked] = useState<Picked[]>([]);
  const [filesError, setFilesError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  /*
   * EVERY invalid field is flagged, not just the first.
   *
   * This was a single `{ name, message }`, so a form submitted empty reported
   * one problem, and the next one only after the first was fixed — eight round
   * trips to fill in eight fields. The spec asks for an inline message and a
   * red outline on every missing or invalid field at once, and a map is what
   * makes that possible.
   */
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<{ text: string; tone: "" | "is-ok" | "is-error" }>({
    text: "",
    tone: "",
  });

  const cameraRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  /* Read inside handlers that would otherwise close over a stale render, and
     needed at unmount so every object URL is revoked. */
  const pickedRef = useRef<Picked[]>([]);

  useEffect(
    () => () => {
      for (const item of pickedRef.current) URL.revokeObjectURL(item.url);
    },
    [],
  );

  function commit(next: Picked[]) {
    pickedRef.current = next;
    setPicked(next);
  }

  function accept(list: FileList | null) {
    if (!list || list.length === 0) return;
    let message = "";
    const next = [...pickedRef.current];
    for (const file of Array.from(list)) {
      if (next.length >= MAX_FILES) {
        message = `You can attach up to ${MAX_FILES} files.`;
        continue;
      }
      if (!OK_TYPES.test(file.type)) {
        message = "That file type is not accepted. Use JPG, PNG, WEBP or MP4.";
        continue;
      }
      if (file.size > MAX_MB * 1024 * 1024) {
        message = `Each file must be ${MAX_MB}MB or smaller.`;
        continue;
      }
      next.push({ file, url: URL.createObjectURL(file) });
    }
    setFilesError(message);
    if (next.length !== pickedRef.current.length) commit(next);
  }

  function removeAt(index: number) {
    const next = [...pickedRef.current];
    const [gone] = next.splice(index, 1);
    if (gone) URL.revokeObjectURL(gone.url);
    commit(next);
  }

  function clearAttachments() {
    for (const item of pickedRef.current) URL.revokeObjectURL(item.url);
    commit([]);
  }

  const fieldClass = (name: string) => `field${errors[name] ? " is-invalid" : ""}`;
  const invalid = (name: string) => (errors[name] ? true : undefined);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setStatus({ text: "", tone: "" });

    /* Collected, not returned on the first failure. */
    const found: Record<string, string> = {};
    for (const [name, check] of CHECKS) {
      const value = name === "rjUrgency" ? urgency : valueOf(form, name);
      const message = check(value);
      if (message) found[name] = message;
    }
    /*
     * Evidence is required too, and it cannot go in CHECKS because the files
     * live in component state rather than in a form field. Same collected-
     * errors pass, so a reporter missing both a description and a photograph
     * is told both at once rather than one, then the other.
     */
    if (picked.length === 0) {
      found.rjUpload = "Add at least one photo or video of the fault.";
    }
    setErrors(found);

    if (Object.keys(found).length > 0) {
      /*
       * Scrolled to, then focused — and in that order.
       *
       * `focus()` alone jumps the field to wherever the browser decides, which
       * on a phone is usually under the sticky header. Scrolling first puts the
       * field in the middle of the screen; `preventScroll` then stops the focus
       * call from undoing it.
       */
      const first = CHECKS.map(([name]) => name).find((name) => found[name]);
      if (first) {
        const target =
          first === "rjUrgency"
            ? form.querySelector<HTMLElement>("#rjUrgency")
            : form.querySelector<HTMLElement>(`#${first}`);
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
        target?.focus({ preventScroll: true });
      }
      setStatus({
        text: "Check the highlighted fields and submit again.",
        tone: "is-error",
      });
      return;
    }

    const files = pickedRef.current.map((item) => item.file);
    const category = valueOf(form, "rjCategory");
    const engineer =
      CATEGORIES.find((entry) => entry.label === category)?.engineer ?? "Other";
    const chosen = URGENCIES.find((entry) => entry.code === urgency);
    const priority = chosen?.priority ?? "Medium";

    /*
     * The description carries the P-code and the access window.
     *
     * Three of the spec's fields have no column of their own on the board —
     * the P-code (three priority labels, four urgencies), the postcode and the
     * access window. Losing them would be worse than a slightly longer
     * description: the postcode is how a contractor is matched to a region and
     * the access window is the single most common reason for a wasted visit.
     */
    const detail = valueOf(form, "rjDesc").trim();
    const access = valueOf(form, "rjAccess").trim();
    const description = [
      `[${urgency}] ${chosen?.label.replace(/^P\d — /, "") ?? ""}`.trim(),
      detail || `${category} fault reported from the website.`,
      `Site address: ${valueOf(form, "rjAddress").trim()}, ${valueOf(form, "rjPostcode").trim().toUpperCase()}`,
      access ? `Preferred access: ${access}` : "",
      `Reported by ${valueOf(form, "rjName").trim()} · ${valueOf(form, "rjEmail").trim()}`,
    ]
      .filter(Boolean)
      .join("\n");

    setSubmitting(true);
    setStatus({ text: "Creating your maintenance request…", tone: "" });

    try {
      const response = await fetch("/api/report-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: valueOf(form, "rjSite"),
          requester: valueOf(form, "rjName"),
          contact: valueOf(form, "rjPhone"),
          description,
          category,
          engineer,
          priority,
        }),
      });
      const result = (await response.json()) as {
        request?: { id: string };
        uploadToken?: string;
        error?: string;
      };
      if (!response.ok || !result.request) {
        throw new Error(result.error || "The request could not be submitted.");
      }
      let failed = 0;
      for (const file of files) {
        const upload = new FormData();
        upload.append("file", file);
        upload.append("requestId", result.request.id);
        upload.append("kind", "issue");
        if (result.uploadToken) upload.append("uploadToken", result.uploadToken);
        const uploadResponse = await fetch("/api/files", { method: "POST", body: upload });
        if (!uploadResponse.ok) failed++;
      }
      form.reset();
      clearAttachments();
      setUrgency("");
      setErrors({});
      setStatus({
        text: `Request ${result.request.id} received.${
          failed
            ? ` ${failed} attachment(s) could not be uploaded.`
            : " The operations team can now begin triage."
        }`,
        tone: "is-ok",
      });
    } catch (caught) {
      setStatus({
        text:
          caught instanceof Error && caught.message
            ? caught.message
            : "The request could not be submitted. Please try again.",
        tone: "is-error",
      });
    } finally {
      setSubmitting(false);
    }
  }

  /** The asterisk, and the one explanation of it, said once at the top. */
  const req = (
    <span className="req" aria-hidden="true">
      *
    </span>
  );

  return (
    <section className="section" id="report">
      <div className="wrap">
        <div className="reveal">
          <p className="eyebrow">Report a job</p>
          {/* The section heading IS the title. The card below opens on the
              fields — it used to repeat this line in its own header. */}
          <h2 className="h2">Report a Job</h2>
          <p className="lede">
            One form, straight into triage. Fields marked <span className="req">*</span> are
            required.
          </p>
        </div>

        <aside className="qj reveal">
          <form className="qj__form" id="rjForm" noValidate onSubmit={onSubmit}>
            <div className="qj__row">
              <div className={fieldClass("rjSite")}>
                <label htmlFor="rjSite">Site / store name {req}</label>
                <input
                  type="text"
                  id="rjSite"
                  name="site"
                  placeholder="Which store or site?"
                  autoComplete="off"
                  aria-invalid={invalid("rjSite")}
                  aria-describedby={errors.rjSite ? "rjSite-err" : undefined}
                />
                <p className="field__err" id="rjSite-err" hidden={!errors.rjSite}>
                  {errors.rjSite}
                </p>
              </div>
              <div className={fieldClass("rjName")}>
                <label htmlFor="rjName">Contact name {req}</label>
                <input
                  type="text"
                  id="rjName"
                  name="name"
                  autoComplete="name"
                  placeholder="Who is reporting this?"
                  aria-invalid={invalid("rjName")}
                  aria-describedby={errors.rjName ? "rjName-err" : undefined}
                />
                <p className="field__err" id="rjName-err" hidden={!errors.rjName}>
                  {errors.rjName}
                </p>
              </div>
            </div>

            <div className="qj__row">
              <div className={fieldClass("rjPhone")}>
                <label htmlFor="rjPhone">Phone number {req}</label>
                <input
                  type="tel"
                  id="rjPhone"
                  name="phone"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="For access on the day"
                  aria-invalid={invalid("rjPhone")}
                  aria-describedby={errors.rjPhone ? "rjPhone-err" : undefined}
                />
                <p className="field__err" id="rjPhone-err" hidden={!errors.rjPhone}>
                  {errors.rjPhone}
                </p>
              </div>
              <div className={fieldClass("rjEmail")}>
                <label htmlFor="rjEmail">Email {req}</label>
                <input
                  type="email"
                  id="rjEmail"
                  name="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@company.co.uk"
                  aria-invalid={invalid("rjEmail")}
                  aria-describedby={errors.rjEmail ? "rjEmail-err" : undefined}
                />
                <p className="field__err" id="rjEmail-err" hidden={!errors.rjEmail}>
                  {errors.rjEmail}
                </p>
              </div>
            </div>

            <div className={fieldClass("rjAddress")}>
              <label htmlFor="rjAddress">Site address {req}</label>
              <input
                type="text"
                id="rjAddress"
                name="address"
                autoComplete="street-address"
                placeholder="Street, town"
                aria-invalid={invalid("rjAddress")}
                aria-describedby={errors.rjAddress ? "rjAddress-err" : undefined}
              />
              <p className="field__err" id="rjAddress-err" hidden={!errors.rjAddress}>
                {errors.rjAddress}
              </p>
            </div>

            <div className="qj__row">
              <div className={fieldClass("rjPostcode")}>
                <label htmlFor="rjPostcode">Postcode {req}</label>
                <input
                  type="text"
                  id="rjPostcode"
                  name="postcode"
                  autoComplete="postal-code"
                  autoCapitalize="characters"
                  placeholder="E14 5AA"
                  aria-invalid={invalid("rjPostcode")}
                  aria-describedby={errors.rjPostcode ? "rjPostcode-err" : undefined}
                />
                <p className="field__err" id="rjPostcode-err" hidden={!errors.rjPostcode}>
                  {errors.rjPostcode}
                </p>
              </div>
              <div className={fieldClass("rjCategory")}>
                <label htmlFor="rjCategory">Fault category {req}</label>
                <select
                  id="rjCategory"
                  name="category"
                  defaultValue=""
                  aria-invalid={invalid("rjCategory")}
                  aria-describedby={errors.rjCategory ? "rjCategory-err" : undefined}
                >
                  <option value="">Select fault category</option>
                  {CATEGORIES.map((entry) => (
                    <option key={entry.label}>{entry.label}</option>
                  ))}
                </select>
                <p className="field__err" id="rjCategory-err" hidden={!errors.rjCategory}>
                  {errors.rjCategory}
                </p>
              </div>
            </div>

            {/*
              Urgency is radios, not a dropdown.

              Four options whose wording is the whole point — "site unsafe or
              cannot trade" against "trading impaired" — and a collapsed select
              hides three of the four at the moment the reader is deciding
              between them. `.chipgroup` is the page's existing radio pattern.
            */}
            <fieldset
              className={`field${errors.rjUrgency ? " is-invalid" : ""}`}
              id="rjUrgency"
              tabIndex={-1}
              aria-invalid={invalid("rjUrgency")}
              aria-describedby={errors.rjUrgency ? "rjUrgency-err" : undefined}
            >
              <legend className="lbl">Urgency {req}</legend>
              {/* Input then label, as direct children — `.chipgroup` styles the
                  checked state through `input:checked + label`, so a wrapper
                  element between them switches the whole pattern off. */}
              <div className="chipgroup">
                {URGENCIES.map((entry) => (
                  <Fragment key={entry.id}>
                    <input
                      type="radio"
                      id={`rjUrgency-${entry.id}`}
                      name="urgency"
                      value={entry.code}
                      checked={urgency === entry.code}
                      onChange={() => setUrgency(entry.code)}
                    />
                    <label htmlFor={`rjUrgency-${entry.id}`}>
                      {entry.label}
                      <span className="chip__sla">{entry.sla}</span>
                    </label>
                  </Fragment>
                ))}
              </div>
              <p className="field__err" id="rjUrgency-err" hidden={!errors.rjUrgency}>
                {errors.rjUrgency}
              </p>
            </fieldset>

            <div className={fieldClass("rjDesc")}>
              <label htmlFor="rjDesc">
                Description {req}
              </label>
              <textarea
                id="rjDesc"
                name="description"
                rows={3}
                placeholder="What's the problem?"
                aria-invalid={invalid("rjDesc")}
                aria-describedby={errors.rjDesc ? "rjDesc-err" : undefined}
              />
              <p className="field__err" id="rjDesc-err" hidden={!errors.rjDesc}>
                {errors.rjDesc}
              </p>
            </div>

            <div className="field">
              <span className="lbl">
                Photos or video {req}
              </span>
              <div
                className={`upload${dragOver ? " is-over" : ""}`}
                id="rjUpload"
                onDragEnter={(event: DragEvent<HTMLDivElement>) => {
                  event.preventDefault();
                  setDragOver(true);
                }}
                onDragOver={(event: DragEvent<HTMLDivElement>) => {
                  event.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={(event: DragEvent<HTMLDivElement>) => {
                  event.preventDefault();
                  setDragOver(false);
                }}
                onDrop={(event: DragEvent<HTMLDivElement>) => {
                  event.preventDefault();
                  setDragOver(false);
                  if (event.dataTransfer?.files) accept(event.dataTransfer.files);
                }}
              >
                <button
                  type="button"
                  className="upload__btn"
                  data-capture="camera"
                  onClick={() => cameraRef.current?.click()}
                >
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
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2Z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                  Take a photo
                </button>
                <button
                  type="button"
                  className="upload__btn"
                  data-capture="video"
                  onClick={() => videoRef.current?.click()}
                >
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
                    <path d="m23 7-7 5 7 5V7Z" />
                    <rect x="1" y="5" width="15" height="14" rx="2" />
                  </svg>
                  Record video
                </button>
                <button
                  type="button"
                  className="upload__btn"
                  data-capture="library"
                  onClick={() => libraryRef.current?.click()}
                >
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
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <path d="m7 9 5-5 5 5M12 4v12" />
                  </svg>
                  Choose files
                </button>
              </div>

              <input
                type="file"
                id="rjCamera"
                ref={cameraRef}
                accept="image/*"
                capture="environment"
                hidden
                multiple
                aria-label="Take a photo of the issue"
                onChange={(event) => {
                  accept(event.currentTarget.files);
                  event.currentTarget.value = "";
                }}
              />
              <input
                type="file"
                id="rjVideo"
                ref={videoRef}
                accept="video/*"
                capture="environment"
                hidden
                aria-label="Record a video of the issue"
                onChange={(event) => {
                  accept(event.currentTarget.files);
                  event.currentTarget.value = "";
                }}
              />
              <input
                type="file"
                id="rjLibrary"
                ref={libraryRef}
                accept="image/*,video/*"
                hidden
                multiple
                aria-label="Choose photos or video from your device"
                onChange={(event) => {
                  accept(event.currentTarget.files);
                  event.currentTarget.value = "";
                }}
              />

              <ul className="thumbs" id="rjThumbs" aria-live="polite">
                {picked.map((item, index) => (
                  <li key={item.url}>
                    {/^video\//i.test(item.file.type) ? (
                      <>
                        <video src={item.url} muted playsInline preload="metadata" />
                        <span className="vidbadge">VIDEO</span>
                      </>
                    ) : (
                      // next/image cannot serve a blob: object URL, and these
                      // previews never leave the device.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.url} alt={item.file.name} />
                    )}
                    <button
                      type="button"
                      className="rm"
                      data-i={index}
                      aria-label={`Remove ${item.file.name}`}
                      onClick={() => removeAt(index)}
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
                        <path d="M18 6 6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
              {picked.length > 0 && (
                <p className="uploadinfo">
                  {picked.length} of {MAX_FILES} attached — a photo of the fault and the asset
                  nameplate saves a return visit.
                </p>
              )}
              {/* Two ways this block can be wrong — a rejected file, or no
                  file at all — and one place to say so. */}
              <p
                className="field__err"
                data-err="rjFiles"
                hidden={!filesError && !errors.rjUpload}
              >
                {filesError || errors.rjUpload}
              </p>
            </div>

            <div className="field">
              <label htmlFor="rjAccess">
                Preferred access window <span className="hint">optional</span>
              </label>
              <select id="rjAccess" name="access" defaultValue="">
                <option value="">When can a contractor attend?</option>
                <option>Any time during opening hours</option>
                <option>Before opening only</option>
                <option>After closing only</option>
                <option>By arrangement — call me first</option>
                <option>Permit required from the centre</option>
              </select>
            </div>

            <button className="btn btn--primary btn--block" type="submit" disabled={submitting}>
              {submitting ? (
                "Submitting…"
              ) : (
                <>
                  Submit Job
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
                </>
              )}
            </button>

            <p className="qj__note">
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
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              For existing Maintsupp clients. Not a client yet?{" "}
              <a href="#review">Book a free portfolio review</a> below.
            </p>
            <p
              className={`formstatus${status.tone ? ` ${status.tone}` : ""}`}
              data-status
              role="status"
            >
              {status.text}
            </p>
          </form>
        </aside>
      </div>
    </section>
  );
}
