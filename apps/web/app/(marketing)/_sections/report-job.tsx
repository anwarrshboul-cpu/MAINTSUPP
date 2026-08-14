"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import type { DragEvent, FormEvent } from "react";
import { api } from "@/lib/api";
import {
  acceptAttribute,
  describeAccepted,
  rejectionFor,
  uploadFile,
  useUploadLimits,
  type IntakeTicket,
} from "@/lib/uploads";

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
 * ── WHAT CHANGED IN THE MOVE TO THE RAILWAY API ────────────────────────────
 *
 * The legacy form posted to `/api/maintenance`, a route in the Vite app that
 * wrote a monday-shaped row straight onto the live board, then uploaded each
 * file to `/api/files` in a follow-up request. It sent a `priority` and an
 * `engineer_required` derived from lookup tables, because those were the
 * board's columns.
 *
 * `POST /public/report-a-job` is not that endpoint. It writes to
 * `job_requests` — a queue a coordinator triages — never to `jobs`, precisely
 * because this form is open to the internet. It takes the fault category and
 * the P-code as they are typed, so both lookup tables are gone rather than
 * ported: mapping a category onto a board option here would be inventing a
 * value the API neither asks for nor stores.
 *
 * THREE FIELDS THAT USED TO BE SMUGGLED INSIDE THE DESCRIPTION NOW HAVE
 * COLUMNS. The old board had nowhere to put the postcode, the access window or
 * the P-code, so all three were appended to the description text. Each is a
 * real field on the request now and is sent as one.
 *
 * ── PHOTOGRAPHS ARE UPLOADED, NOT NAMED ────────────────────────────────────
 *
 * This form used to send `photos: ["IMG_0001.jpg"]` — the filenames of files
 * that never left the device. The API deliberately treats a bare string as no
 * evidence that any bytes exist and creates no attachment from it, so every
 * request arrived with zero photographs while the product's own rule is that
 * requests without clear pictures are declined.
 *
 * The real flow, and the one below: each file goes to
 * `POST /public/intake/upload`, which stages the bytes and answers with a claim
 * ticket; the tickets are what `photos` carries, and
 * `POST /public/report-a-job` claims them into `attachments` inside the same
 * transaction that writes the request. Half of that cannot happen — a request
 * whose pictures did not attach is exactly the state the transaction exists to
 * prevent — so the form uploads first and submits only when every file has a
 * ticket.
 */

/* ── attachments ──────────────────────────────────────────────────────────── */

const MAX_FILES = 6;

/**
 * One picked file, and everything the reporter is owed about it.
 *
 * A photograph that failed to upload MUST stay visible as a failure. It cannot
 * quietly drop out of the list: the request would then either be refused for
 * having no pictures, or filed missing the one that showed the fault, and the
 * reporter would have no way to tell which.
 */
type Picked = {
  id: string;
  file: File;
  /** An object URL for the local preview. Revoked when the entry goes. */
  url: string;
  state: "ready" | "uploading" | "uploaded" | "failed";
  /** The `pending_uploads` id this file was staged as. */
  ticket?: string;
  error?: string;
  /*
   * Set when the browser cannot draw the preview. A PDF has no picture, and
   * Chrome and Firefox cannot decode the HEIC an iPhone produces — leaving an
   * <img> to fail there paints a torn-page icon and spills the whole filename
   * across the tile, which reads as a file that did not attach at all.
   */
  undrawable?: boolean;
};

/** "JPG", "HEIC", "PDF" — what to write on a tile that cannot show a picture. */
const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  const tail = dot > 0 ? name.slice(dot + 1, dot + 6) : "";
  return tail ? tail.toUpperCase() : "FILE";
};

/* ── what the request records ─────────────────────────────────────────────── */

/** The four urgencies. The P-code is what the API stores, verbatim. */
const URGENCIES = [
  { id: "p1", code: "P1", label: "P1 — Critical, site unsafe or cannot trade" },
  { id: "p2", code: "P2", label: "P2 — Urgent, trading impaired" },
  { id: "p3", code: "P3", label: "P3 — Routine" },
  { id: "p4", code: "P4", label: "P4 — Cosmetic / quote request" },
] as const;

/** The eight fault categories, sent as the label the reporter chose. */
const CATEGORIES = [
  "Electrical & lighting",
  "Plumbing & leaks",
  "Doors, locks & shutters",
  "HVAC & air conditioning",
  "Glazing",
  "Signage",
  "Drainage",
  "Other",
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
   * Photographs are mandatory, and the API is the reason.
   *
   * `POST /public/report-a-job` rejects a request with an empty `photos` array
   * — "Requests without clear pictures are declined" is its own wording, and it
   * is the monday intake rule the coordinators already work to. Checking it
   * here means the reporter is told beside the upload buttons rather than by a
   * 400 after they have filled in eleven fields.
   *
   * The value handed to this check is the number of attachments as a string,
   * because `CHECKS` is a list of string validators; see the call site.
   */
  ["rjUpload", (v) => (Number(v) > 0 ? "" : "Attach at least one photo of the fault.")],
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
  /* Uncontrolled, like every other field here: it is never read by a human and
     never restored, so it does not need to survive a re-render. */
  const websiteRef = useRef<HTMLInputElement>(null);

  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  /* Read inside handlers that would otherwise close over a stale render, and
     needed at unmount so every object URL is revoked. */
  const pickedRef = useRef<Picked[]>([]);
  /* A counter, not a random id: these keys only need to be unique within one
     list, and a ref keeps the increment out of render — the same file picked,
     removed and picked again must not reuse a key that React has seen. */
  const pickSeq = useRef(0);

  /* What the API will actually take, asked at runtime rather than restated
     here — see lib/uploads.ts. Null until it answers; the checks below fall
     back to letting the server refuse, which it does anyway. */
  const limits = useUploadLimits();

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

  /** One entry changes; the ref and the state stay in step. */
  function patch(id: string, changes: Partial<Picked>) {
    commit(
      pickedRef.current.map((item) =>
        item.id === id ? { ...item, ...changes } : item,
      ),
    );
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
      const rejection = rejectionFor(file, limits);
      if (rejection) {
        message = rejection;
        continue;
      }
      pickSeq.current += 1;
      next.push({
        id: `pick-${pickSeq.current}`,
        file,
        url: URL.createObjectURL(file),
        state: "ready",
      });
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

  /**
   * Stages every file that has no ticket yet, and answers with the full set of
   * tickets — or null if any of them failed.
   *
   * SEQUENTIAL, on purpose. This is a phone on a shop's mobile signal: six
   * parallel multipart uploads share one narrow uplink, so they all finish at
   * roughly the same late moment and the progress line cannot say anything
   * truthful in the meantime. One at a time also means a rate-limited or
   * refused file stops at its own tile instead of five more being sent after
   * the answer that says stop.
   *
   * Files that already carry a ticket are skipped, so pressing Submit again
   * after one failure re-sends only what failed.
   */
  async function stagePhotographs(): Promise<string[] | null> {
    const queue = pickedRef.current.filter((item) => !item.ticket);
    let sent = 0;

    for (const item of queue) {
      sent += 1;
      setStatus({
        text: `Uploading photograph ${sent} of ${queue.length}…`,
        tone: "",
      });
      patch(item.id, { state: "uploading", error: undefined });

      const result = await uploadFile<IntakeTicket>(
        "/public/intake/upload",
        item.file,
      );
      if (!result.ok) {
        patch(item.id, { state: "failed", error: result.error });
        continue;
      }
      patch(item.id, { state: "uploaded", ticket: result.data.photo });
    }

    const tickets = pickedRef.current
      .map((item) => item.ticket)
      .filter((value): value is string => Boolean(value));
    return tickets.length === pickedRef.current.length ? tickets : null;
  }

  const failures = picked.filter((item) => item.state === "failed");

  const fieldClass = (name: string) => `field${errors[name] ? " is-invalid" : ""}`;
  const invalid = (name: string) => (errors[name] ? true : undefined);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setStatus({ text: "", tone: "" });

    // A bot filled a field no human can see. Fail silently rather than tell it
    // why — and never reach the network.
    if (websiteRef.current?.value) return;

    /* Collected, not returned on the first failure. */
    const found: Record<string, string> = {};
    for (const [name, check] of CHECKS) {
      /* Two of the checks are not text inputs: urgency is a radio group held in
         state, and the attachment count is state too. */
      const value =
        name === "rjUrgency" ? urgency
        : name === "rjUpload" ? String(pickedRef.current.length)
        : valueOf(form, name);
      const message = check(value);
      if (message) found[name] = message;
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
        const target = form.querySelector<HTMLElement>(`#${first}`);
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
        target?.focus({ preventScroll: true });
      }
      setStatus({
        text: "Check the highlighted fields and submit again.",
        tone: "is-error",
      });
      return;
    }

    const category = valueOf(form, "rjCategory");
    /*
     * The API's floor is ten characters and this field is optional, so it is
     * padded rather than left to fail.
     *
     * Appended, not substituted: "leak" is four characters and would be
     * rejected, but it is also the most useful thing on the form. Replacing it
     * with the category would throw away what the reporter actually said, so
     * both go, and a reporter who wrote a real sentence sees nothing added.
     */
    const detail = valueOf(form, "rjDesc").trim();
    const description =
      detail.length >= 10
        ? detail
        : [detail, `${category} fault reported from the website.`]
            .filter(Boolean)
            .join(" — ");

    setSubmitting(true);

    /*
     * The photographs go FIRST, and the request only if all of them arrived.
     *
     * Submitting with a partial set would file a request whose pictures the
     * reporter believes they attached and a coordinator cannot find — and the
     * fix ("attach it again") is only available while this form is still on
     * screen with the files still in it.
     */
    const photos = await stagePhotographs();
    if (!photos) {
      setSubmitting(false);
      setStatus({
        text: "Some photographs did not upload — they are marked below. Try again, or remove them and take another.",
        tone: "is-error",
      });
      return;
    }

    setStatus({ text: "Creating your maintenance request…", tone: "" });

    const result = await api<{ ok: true; reference: string }>("/public/report-a-job", {
      method: "POST",
      body: JSON.stringify({
        siteName: valueOf(form, "rjSite"),
        contactName: valueOf(form, "rjName"),
        phone: valueOf(form, "rjPhone"),
        email: valueOf(form, "rjEmail"),
        address: valueOf(form, "rjAddress"),
        postcode: valueOf(form, "rjPostcode").toUpperCase(),
        faultCategory: category,
        urgency,
        description,
        accessWindow: valueOf(form, "rjAccess"),
        photos,
        /* Sent as well as checked above. The early return catches a bot driving
           the real form; forwarding the field is what catches one that posts
           straight at the endpoint, because the API runs the same trap and
           answers with a fake reference without writing a row. */
        website: websiteRef.current?.value ?? "",
      }),
    });

    setSubmitting(false);

    if (!result.ok) {
      /*
       * A ticket is single-use and the claim happens inside the request's own
       * transaction, so "one of your photographs has expired" means nothing was
       * filed at all. Sending the reporter back to a Submit button holding the
       * same spent tickets would fail identically forever — dropping them makes
       * the next attempt re-upload the bytes, which is the only thing that can
       * work.
       */
      if (result.status === 400 && /photograph/i.test(result.error)) {
        commit(
          pickedRef.current.map((item) => ({
            ...item,
            state: "ready" as const,
            ticket: undefined,
          })),
        );
      }
      setStatus({ text: result.error, tone: "is-error" });
      return;
    }

    form.reset();
    clearAttachments();
    setUrgency("");
    setErrors({});
    setStatus({
      text: `Request received. Your reference is ${result.data.reference} — quote it if you call us. The operations team can now begin triage.`,
      tone: "is-ok",
    });
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
            required. <strong>One issue per ticket</strong> — report separate faults
            separately, so each gets its own reference, its own contractor and its own
            close-out evidence.
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
                  {CATEGORIES.map((label) => (
                    <option key={label}>{label}</option>
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
                    <label htmlFor={`rjUrgency-${entry.id}`}>{entry.label}</label>
                  </Fragment>
                ))}
              </div>
              <p className="field__err" id="rjUrgency-err" hidden={!errors.rjUrgency}>
                {errors.rjUrgency}
              </p>
            </fieldset>

            <div className="field">
              <label htmlFor="rjDesc">
                Description <span className="hint">optional</span>
              </label>
              <textarea
                id="rjDesc"
                name="description"
                rows={3}
                placeholder="What's the problem?"
              />
            </div>

            <div className={fieldClass("rjUpload")}>
              <span className="lbl">
                Photo upload {req}{" "}
                <span className="hint">a photo of the fault, and one of the asset nameplate</span>
              </span>
              <div
                className={`upload${dragOver ? " is-over" : ""}`}
                id="rjUpload"
                /* Focusable only programmatically: a failed submit scrolls to
                   the first problem and focuses it, and a plain div cannot take
                   focus. It stays out of the tab order — the three buttons
                   inside it are the real controls. */
                tabIndex={-1}
                aria-invalid={invalid("rjUpload")}
                aria-describedby={errors.rjUpload ? "rjUpload-err" : undefined}
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
                {/*
                  There is no "Record video" button any more.

                  The API's allow-list is JPEG, PNG, WebP, HEIC and PDF, checked
                  against the file's magic number — no video type can become an
                  attachment, whatever it is named. A button whose every outcome
                  is a refusal, after a 40MB upload over mobile data, is worse
                  than no button: it teaches people the form is broken.
                */}
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
                id="rjLibrary"
                ref={libraryRef}
                /* The picker offers what the API accepts, asked at runtime. */
                accept={acceptAttribute(limits)}
                hidden
                multiple
                aria-label="Choose photos from your device"
                onChange={(event) => {
                  accept(event.currentTarget.files);
                  event.currentTarget.value = "";
                }}
              />

              <ul className="thumbs" id="rjThumbs" aria-live="polite">
                {picked.map((item, index) => (
                  <li key={item.id} className={`is-${item.state}`}>
                    {item.undrawable || !/^image\//i.test(item.file.type) ? (
                      <span className="docbadge">{extensionOf(item.file.name)}</span>
                    ) : (
                      // next/image cannot serve a blob: object URL, and these
                      // previews never leave the device.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.url}
                        alt={item.file.name}
                        onError={() => patch(item.id, { undrawable: true })}
                      />
                    )}
                    {item.state !== "ready" ? (
                      <span className={`upstate upstate--${item.state}`}>
                        {item.state === "uploading"
                          ? "Sending…"
                          : item.state === "uploaded"
                            ? "Sent"
                            : "Failed"}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="rm"
                      data-i={index}
                      /* Removing a file mid-upload would leave a request in
                         flight for an entry nothing is left to record. */
                      disabled={item.state === "uploading"}
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
                  nameplate saves a return visit. {describeAccepted(limits)}
                  {limits ? `, up to ${limits.maxMb}MB each` : ""}.
                </p>
              )}
              {/*
                Which file failed, and why, named one by one.

                A count would not do: the reporter has to know whether the
                photograph that shows the fault is the one that did not arrive,
                and the message from the API ("that file's contents do not match
                the type it was sent as", "too many uploads") is the only thing
                that says what to do next.
              */}
              {failures.length > 0 && (
                <ul className="uploadfails" aria-live="polite">
                  {failures.map((item) => (
                    <li key={item.id}>
                      {item.file.name} — {item.error}
                    </li>
                  ))}
                </ul>
              )}
              {/* Two separate messages: one for a file that was refused, one for
                  no files at all. They can both be true at once. */}
              <p className="field__err" data-err="rjFiles" hidden={!filesError}>
                {filesError}
              </p>
              <p className="field__err" id="rjUpload-err" hidden={!errors.rjUpload}>
                {errors.rjUpload}
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

            {/* Honeypot. Off-screen via `.hp` rather than display:none — some
                bots skip what is not rendered. */}
            <div className="hp" aria-hidden="true">
              <label htmlFor="rjWebsite">Website</label>
              <input
                type="text"
                id="rjWebsite"
                name="website"
                ref={websiteRef}
                tabIndex={-1}
                autoComplete="off"
              />
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
