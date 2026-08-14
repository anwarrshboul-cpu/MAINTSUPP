"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "../../../../lib/api";
import {
  acceptAttribute,
  describeAccepted,
  rejectionFor,
  uploadFile,
  useUploadLimits,
  type IntakeTicket,
} from "../../../../lib/uploads";
import type { Site } from "../../../../lib/portal";

/**
 * Report a job, from inside the portal.
 *
 * ── THE SAME INTAKE PATH AS THE PUBLIC FORM ───────────────────────────────
 * This posts to `POST /public/report-a-job` — the very endpoint the landing
 * page uses — and there is deliberately no authenticated twin of it. A second
 * route would be a second copy of the intake rules ("photographs are
 * mandatory", "one issue per ticket", the ten-character floor on the
 * description), and the copy that drifts is the one that quietly starts
 * accepting requests with no pictures. It writes to `job_requests`, so a store
 * manager's report lands in the coordinators' triage queue exactly like a
 * stranger's, rather than putting an unchecked row onto the board.
 *
 * What being signed in changes is not where the report goes — it is how much
 * of it the reporter has to type. The site list is their own (the API scopes
 * `/jobs/meta/sites` to the sites their account was given), the address and
 * postcode come with the site they pick, and their name, number and email are
 * already on their profile.
 *
 * ── PHOTOGRAPHS ARE UPLOADED, NOT NAMED ───────────────────────────────────
 * Each file goes to `POST /public/intake/upload`, which stages the bytes and
 * answers with a single-use claim ticket; the tickets are what `photos`
 * carries, and the report endpoint claims them into `attachments` inside the
 * same transaction that writes the request. The API treats a bare filename as
 * no evidence that any bytes exist, so sending names would file every report
 * with zero photographs.
 *
 * This is why the form uses `uploadFile` per file rather than `useUploadQueue`,
 * exactly as `app/(marketing)/_sections/report-job.tsx` does: the queue's
 * `send()` returns counts and discards each response body, and the response
 * body is where the ticket is. The queue is the right tool for the contractor's
 * evidence upload, where nothing needs to come back.
 */

const MAX_FILES = 6;

/** The eight categories the public form offers, sent as the label chosen. */
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

/** The four urgencies. The P-code is what the API stores, verbatim. */
const URGENCIES = [
  { code: "P1", label: "P1 — Critical, site unsafe or cannot trade" },
  { code: "P2", label: "P2 — Urgent, trading impaired" },
  { code: "P3", label: "P3 — Routine" },
  { code: "P4", label: "P4 — Cosmetic / quote request" },
] as const;

/**
 * UK postcode, by shape rather than by an exhaustive list of valid prefixes —
 * that version rejects real postcodes as new ones are introduced. This catches
 * the actual mistake: a house number, a partial code, or the town.
 */
const POSTCODE = /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}$/;
const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/;

type Picked = {
  id: string;
  file: File;
  state: "ready" | "uploading" | "uploaded" | "failed";
  /** The `pending_uploads` id this file was staged as. */
  ticket?: string;
  error?: string;
};

export default function ReportForm({
  sites,
  sitesError,
  contactName,
  phone,
  email,
}: {
  sites: Site[];
  sitesError: string | null;
  contactName: string;
  phone: string;
  email: string;
}) {
  // One site means there is nothing to choose; pre-select it.
  const [siteId, setSiteId] = useState(sites.length === 1 ? sites[0].id : "");
  const site = sites.find((entry) => entry.id === siteId) ?? null;

  const [address, setAddress] = useState(sites.length === 1 ? (sites[0].address ?? "") : "");
  const [postcode, setPostcode] = useState(
    sites.length === 1 ? (sites[0].postcode ?? "") : "",
  );
  const [name, setName] = useState(contactName);
  const [tel, setTel] = useState(phone);
  const [mail, setMail] = useState(email);
  const [category, setCategory] = useState("");
  const [urgency, setUrgency] = useState("");
  const [description, setDescription] = useState("");
  const [accessWindow, setAccessWindow] = useState("");

  const [picked, setPicked] = useState<Picked[]>([]);
  const [filesError, setFilesError] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState("");
  const [reference, setReference] = useState<string | null>(null);

  /* Read inside the upload loop, which would otherwise close over the list as
     it was when Submit was pressed. */
  const pickedRef = useRef<Picked[]>([]);
  const pickSeq = useRef(0);
  const limits = useUploadLimits();

  useEffect(() => {
    pickedRef.current = picked;
  }, [picked]);

  function commit(next: Picked[]) {
    pickedRef.current = next;
    setPicked(next);
  }

  function patch(id: string, changes: Partial<Picked>) {
    commit(
      pickedRef.current.map((item) => (item.id === id ? { ...item, ...changes } : item)),
    );
  }

  function chooseSite(id: string) {
    setSiteId(id);
    const chosen = sites.find((entry) => entry.id === id);
    /*
     * Overwritten, not merged. Picking a different store and keeping the last
     * one's address is how a fault gets reported against the wrong shop — and
     * the field stays editable, so a correction survives.
     */
    setAddress(chosen?.address ?? "");
    setPostcode(chosen?.postcode ?? "");
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
      const why = rejectionFor(file, limits);
      if (why) {
        message = why;
        continue;
      }
      pickSeq.current += 1;
      next.push({ id: `pick-${pickSeq.current}`, file, state: "ready" });
    }
    setFilesError(message);
    commit(next);
  }

  /**
   * Stages every file that has no ticket yet and answers with the full set, or
   * null if any of them failed.
   *
   * SEQUENTIAL, on purpose: this is a phone on a shop's mobile signal, and six
   * parallel uploads share one narrow uplink so they all land late together.
   * One at a time also means a rate-limited file stops at its own row instead
   * of five more being sent after the answer that said stop.
   */
  async function stagePhotographs(): Promise<string[] | null> {
    const queue = pickedRef.current.filter((item) => !item.ticket);
    let sent = 0;

    for (const item of queue) {
      sent += 1;
      setStatus(`Uploading photograph ${sent} of ${queue.length}…`);
      patch(item.id, { state: "uploading", error: undefined });

      const result = await uploadFile<IntakeTicket>("/public/intake/upload", item.file);
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

  function validate(): Record<string, string> {
    const found: Record<string, string> = {};
    if (!siteId) found.site = "Choose which of your sites this is for.";
    if (!name.trim()) found.name = "Tell us who is reporting this.";
    if (tel.replace(/[^0-9+]/g, "").length < 10) {
      found.phone = "A full contact number, so the contractor can arrange access.";
    }
    if (!EMAIL.test(mail.trim())) found.email = "Enter a valid email address.";
    if (!address.trim()) found.address = "Enter the site address.";
    if (!POSTCODE.test(postcode.trim())) {
      found.postcode = "Enter a valid UK postcode, such as E14 5AA.";
    }
    if (!category) found.category = "Choose the fault category.";
    if (!urgency) found.urgency = "Choose how urgent this is.";
    // The API's own floor. Said here so it is answered beside the field rather
    // than by a 400 after eleven of them have been filled in.
    if (description.trim().length < 10) {
      found.description = "Describe the fault in a sentence — at least ten characters.";
    }
    if (pickedRef.current.length === 0) {
      found.photos = "Attach at least one photograph of the fault.";
    }
    return found;
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus("");
    setReference(null);

    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setStatus("Check the highlighted fields and submit again.");
      return;
    }

    setSubmitting(true);

    /*
     * The photographs go FIRST, and the request only if every one of them
     * arrived. Submitting with a partial set files a report whose pictures the
     * reporter believes they attached and a coordinator cannot find — and the
     * fix is only available while this form is still on screen holding them.
     */
    const photos = await stagePhotographs();
    if (!photos) {
      setSubmitting(false);
      setStatus(
        "Some photographs did not upload — they are marked below. Try again, or remove them and take another.",
      );
      return;
    }

    setStatus("Filing your request…");

    const result = await api<{ ok: true; reference: string }>("/public/report-a-job", {
      method: "POST",
      body: JSON.stringify({
        siteName: site?.name ?? "",
        contactName: name,
        phone: tel,
        email: mail,
        address,
        postcode: postcode.toUpperCase(),
        faultCategory: category,
        urgency,
        description,
        accessWindow,
        photos,
      }),
    });

    setSubmitting(false);

    if (!result.ok) {
      /*
       * A ticket is single-use and is claimed inside the request's own
       * transaction, so "one of your photographs has expired" means nothing was
       * filed at all. Sending the reporter back to Submit holding the same
       * spent tickets would fail identically forever; dropping them makes the
       * next attempt re-upload the bytes, which is the only thing that can work.
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
      setStatus(result.error);
      return;
    }

    setReference(result.data.reference);
    setStatus("");
    setErrors({});
    commit([]);
    setCategory("");
    setUrgency("");
    setDescription("");
    setAccessWindow("");
  }

  const failures = picked.filter((item) => item.state === "failed");
  const invalid = (field: string) => (errors[field] ? true : undefined);
  const problem = (field: string) =>
    errors[field] ? (
      <span className="p-bad p-small" role="alert">
        {errors[field]}
      </span>
    ) : null;

  if (sitesError) {
    return (
      <div className="card card--empty">
        <p className="muted">{sitesError}</p>
      </div>
    );
  }

  if (sites.length === 0) {
    return (
      <div className="card card--empty">
        <p className="muted">
          Your account is not attached to a site yet, so there is nothing to
          report against. A coordinator sets that on the Members page.
        </p>
      </div>
    );
  }

  return (
    <form className="p-panel" onSubmit={onSubmit} noValidate>
      <div aria-live="polite" aria-atomic="true">
        {reference ? (
          <p className="alert alert--good">
            Request received. Your reference is <strong>{reference}</strong> — quote
            it if you ring us. A coordinator checks it and turns it into a job.{" "}
            <Link href="/portal/dashboard">Back to the board</Link>
          </p>
        ) : null}
        {status ? <p className="alert alert--bad">{status}</p> : null}
      </div>

      <div className="p-grid2">
        <label className="p-field">
          <span>Which site *</span>
          <select
            className="p-select"
            value={siteId}
            onChange={(event) => chooseSite(event.target.value)}
            aria-invalid={invalid("site")}
            disabled={submitting}
          >
            <option value="">Choose…</option>
            {sites.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
          {problem("site")}
        </label>

        <label className="p-field">
          <span>Fault category *</span>
          <select
            className="p-select"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            aria-invalid={invalid("category")}
            disabled={submitting}
          >
            <option value="">Choose…</option>
            {CATEGORIES.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
          {problem("category")}
        </label>

        <label className="p-field">
          <span>Site address *</span>
          <input
            className="p-input"
            type="text"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            autoComplete="street-address"
            aria-invalid={invalid("address")}
            disabled={submitting}
          />
          {problem("address")}
        </label>

        <label className="p-field">
          <span>Postcode *</span>
          <input
            className="p-input"
            type="text"
            value={postcode}
            onChange={(event) => setPostcode(event.target.value)}
            autoComplete="postal-code"
            autoCapitalize="characters"
            placeholder="E14 5AA"
            aria-invalid={invalid("postcode")}
            disabled={submitting}
          />
          {problem("postcode")}
        </label>

        <label className="p-field">
          <span>Your name *</span>
          <input
            className="p-input"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="name"
            aria-invalid={invalid("name")}
            disabled={submitting}
          />
          {problem("name")}
        </label>

        <label className="p-field">
          <span>Contact number *</span>
          <input
            className="p-input"
            type="tel"
            inputMode="tel"
            value={tel}
            onChange={(event) => setTel(event.target.value)}
            autoComplete="tel"
            placeholder="For access on the day"
            aria-invalid={invalid("phone")}
            disabled={submitting}
          />
          {problem("phone")}
        </label>

        <label className="p-field">
          <span>Email *</span>
          <input
            className="p-input"
            type="email"
            inputMode="email"
            value={mail}
            onChange={(event) => setMail(event.target.value)}
            autoComplete="email"
            aria-invalid={invalid("email")}
            disabled={submitting}
          />
          {problem("email")}
        </label>

        <label className="p-field">
          <span>Access window</span>
          <select
            className="p-select"
            value={accessWindow}
            onChange={(event) => setAccessWindow(event.target.value)}
            disabled={submitting}
          >
            <option value="">When can a contractor attend?</option>
            <option>Any time during opening hours</option>
            <option>Before opening only</option>
            <option>After closing only</option>
            <option>By arrangement — call me first</option>
            <option>Permit required from the centre</option>
          </select>
        </label>
      </div>

      {/*
        Radios, not a dropdown. The wording is the whole point — "site unsafe or
        cannot trade" against "trading impaired" — and a collapsed select hides
        three of the four at the moment the reader is deciding between them.
      */}
      <fieldset className="p-field" style={{ marginTop: 12, border: 0, padding: 0 }}>
        <legend>
          <span className="p-small p-muted">Urgency *</span>
        </legend>
        <div className="p-checks">
          {URGENCIES.map((entry) => (
            <label className="p-check" key={entry.code}>
              <input
                type="radio"
                name="urgency"
                value={entry.code}
                checked={urgency === entry.code}
                onChange={() => setUrgency(entry.code)}
                disabled={submitting}
              />
              <span>{entry.label}</span>
            </label>
          ))}
        </div>
        {problem("urgency")}
      </fieldset>

      <label className="p-field" style={{ marginTop: 12 }}>
        <span>What is wrong? *</span>
        <textarea
          className="p-textarea"
          rows={4}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="One fault per report. What has happened, and what cannot be used because of it?"
          aria-invalid={invalid("description")}
          disabled={submitting}
        />
        {problem("description")}
      </label>

      <label className="p-field" style={{ marginTop: 12 }}>
        <span>Photographs *</span>
        <input
          className="p-input"
          type="file"
          multiple
          accept={acceptAttribute(limits)}
          aria-invalid={invalid("photos")}
          disabled={submitting}
          onChange={(event) => {
            accept(event.currentTarget.files);
            // Cleared so the same file picked twice still fires a change.
            event.currentTarget.value = "";
          }}
        />
        {problem("photos")}
      </label>

      {picked.length > 0 ? (
        <ul className="sendq" aria-live="polite">
          {picked.map((item) => (
            <li key={item.id}>
              <span className="sendq__name">{item.file.name}</span>
              <span
                className={`sendq__st sendq__st--${item.state === "uploaded" ? "sent" : item.state === "uploading" ? "sending" : item.state}`}
              >
                {item.state === "uploading"
                  ? "Uploading…"
                  : item.state === "uploaded"
                    ? "Sent"
                    : item.state === "failed"
                      ? "Failed"
                      : "Ready"}
              </span>
              {item.error ? <span className="sendq__why">{item.error}</span> : null}
              {item.state !== "uploading" ? (
                <button
                  type="button"
                  className="p-btn p-btn--ghost p-btn--sm"
                  disabled={submitting}
                  onClick={() =>
                    commit(pickedRef.current.filter((entry) => entry.id !== item.id))
                  }
                >
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {/* Two separate messages: one for a file that was refused, one for no
          files at all. They can both be true at once. */}
      {filesError ? (
        <p className="p-bad p-small" role="alert">
          {filesError}
        </p>
      ) : null}
      {failures.length > 0 ? (
        <ul className="sendq" aria-live="polite">
          {failures.map((item) => (
            <li key={`fail-${item.id}`}>
              <span className="sendq__why">
                {item.file.name} — {item.error}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="p-note">
        A photograph of the fault and one of the asset nameplate saves a return
        visit. {describeAccepted(limits)}
        {limits ? `, up to ${limits.maxMb}MB each` : ""}, up to {MAX_FILES} files.
        Requests without clear pictures are declined.
      </p>

      <div className="p-btnrow" style={{ marginTop: 12 }}>
        <button className="p-btn p-btn--wide" type="submit" disabled={submitting}>
          {submitting ? "Submitting…" : "Submit report"}
        </button>
      </div>
    </form>
  );
}
