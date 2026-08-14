"use client";

/**
 * What an engineer needs before they arrive — L.
 *
 * The thing this replaces is a WhatsApp message. How do I get in, who do I ask
 * for, where do I park, when does the unit open, what happened last time. The
 * columns for all of it have existed on `sites` since the site register was
 * built; none of it was ever served to the one person who needs it, so it was
 * either passed on by hand or found out at the door.
 *
 * TWO KINDS OF FIELD, and the difference is the whole design. Most of these
 * are typed by a coordinator and are, today, empty on all 31 sites — so the
 * pack says "not recorded yet" in plain words rather than drawing a row of
 * blanks that reads like the answer is "nothing". "Previous access problems"
 * is the other kind: nobody types it, it is counted from this site's own job
 * history, and it is the one part that is populated on day one.
 *
 * Phone numbers are `tel:` links, because the reader is holding a phone and
 * standing outside. The access URL opens in its own tab; a portal that swallows
 * the job link would leave them with no way back.
 */

import { useState } from "react";

export type ArrivalPack = {
  addressLines: string[];
  postcode: string | null;
  managerName: string | null;
  managerPhone: string | null;
  outOfHours: string | null;
  accessMethod: string | null;
  accessContact: string | null;
  accessUrl: string | null;
  accessNotes: string | null;
  openingHours: string | null;
  parking: string | null;
  keysAndAlarm: string | null;
  deliveries: string | null;
  pastAccessProblems: Array<{ when: string | null; what: string }>;
};

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="arrival__fact">
      <dt>{label}</dt>
      <dd className={value ? "" : "is-missing"}>{value || "Not recorded yet"}</dd>
    </div>
  );
}

/** A number the reader can dial, or the plain text when it is not one. */
function Contact({ label, value }: { label: string; value: string | null }) {
  if (!value) return <Fact label={label} value={null} />;
  const digits = value.replace(/[^\d+]/g, "");
  return (
    <div className="arrival__fact">
      <dt>{label}</dt>
      <dd>
        {digits.length >= 7 ? (
          <a href={`tel:${digits}`}>{value}</a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

function shortDate(value: string | null) {
  if (!value) return "";
  const parsed = new Date(value.length <= 10 ? `${value}T00:00:00Z` : value.replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(parsed);
}

export function ArrivalPack({ pack }: { pack: ArrivalPack }) {
  const [open, setOpen] = useState(false);

  const recorded = [
    pack.accessMethod,
    pack.accessContact,
    pack.accessNotes,
    pack.openingHours,
    pack.parking,
    pack.keysAndAlarm,
    pack.deliveries,
    pack.managerPhone,
    pack.outOfHours,
  ].filter((value) => value && value.trim()).length;

  const problems = pack.pastAccessProblems ?? [];

  return (
    <section className="job-link__card arrival">
      <button
        type="button"
        className="arrival__toggle"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>
          <strong>Before you arrive</strong>
          <small>
            {/*
              Counted, not claimed. "9 details" on a site nobody has filled in
              would be the same lie as a blank row that looks complete.
            */}
            {recorded
              ? `${recorded} detail${recorded === 1 ? "" : "s"} recorded`
              : "Nothing recorded yet"}
            {problems.length
              ? ` · ${problems.length} past access problem${problems.length === 1 ? "" : "s"}`
              : ""}
          </small>
        </span>
        <span className="arrival__chevron" aria-hidden="true">
          {open ? "−" : "+"}
        </span>
      </button>

      {open && (
        <div className="arrival__body">
          {problems.length > 0 && (
            <div className="arrival__warning">
              <strong>This site has been hard to get into before</strong>
              <ul>
                {problems.map((problem, index) => (
                  <li key={`${problem.when ?? index}`}>
                    {problem.what}
                    {problem.when ? <em> · {shortDate(problem.when)}</em> : null}
                  </li>
                ))}
              </ul>
              <small>
                Taken from this site&rsquo;s own job history, not from a note
                anybody has to keep up to date.
              </small>
            </div>
          )}

          <dl className="arrival__facts">
            <Fact label="How to get in" value={pack.accessMethod} />
            <Contact label="Access contact" value={pack.accessContact} />
            <Fact label="Access notes" value={pack.accessNotes} />
            <Fact label="Keys and alarm" value={pack.keysAndAlarm} />
            <Fact label="Opening hours" value={pack.openingHours} />
            <Fact label="Parking" value={pack.parking} />
            <Fact label="Deliveries" value={pack.deliveries} />
            <Contact label="Site manager" value={pack.managerPhone} />
            <Contact label="Out of hours" value={pack.outOfHours} />
          </dl>

          {pack.accessUrl && (
            <a
              className="job-link__map"
              href={pack.accessUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open the access portal
            </a>
          )}

          {recorded === 0 && (
            <p className="arrival__empty">
              Nobody has filled in this site&rsquo;s access details yet. Ask your
              coordinator before you travel — and once you know, ask them to
              record it here so the next visit is easier.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
