"use client";

/**
 * W06-13 — THE CONTRACTOR SUMMARY: what the drawer opens on.
 *
 * The profile answered four operational questions — which jobs, which sites,
 * which documents, how are they performing — and opened straight into the
 * first of them. Everything the register HOLDS about a contractor (who to ring,
 * what they cover, whether their insurance is in date, what was agreed) was
 * reachable only through "Manage contractors", the EDIT drawer, which is a form
 * and reads like one: 25 boxes in tab order, no grouping, no derived status,
 * and a save button under it. So the commonest question about a contractor —
 * "who are they, can I use them, and how do I reach them" — had no read-only
 * answer anywhere in the product.
 *
 * This is that answer, and it is deliberately an OVERVIEW rather than a second
 * copy of the record. Three rules decide what is on it:
 *
 *   1. ONLY WHAT HAS DATA. A section whose every row is null does not render,
 *      and a row with no value does not render inside a section that does.
 *      A grid of em dashes is not a summary; it is a form with the boxes taken
 *      away. What IS missing is said once, quietly, at the end — so a reader
 *      can tell "nothing recorded" from "the panel failed to load".
 *   2. NOT EVERY COLUMN. `address`, `postcode`, `policyNumber`,
 *      `insuranceNotes`, `notes` and the full certification list are on the
 *      Details tab beside this one. A summary that carried all 25 fields would
 *      be the edit form again, and the reader would still have to hunt.
 *   3. NOTHING DERIVED HERE THAT IS DERIVED ELSEWHERE. The expiry states are
 *      the ones `/api/workspace` classified with `app/lib/expiry-status.ts`,
 *      and the work figures are the ones the page attributed with
 *      `app/lib/contractor-attribution.ts`. This file computes one thing — the
 *      completion percentage — and reads the rest.
 *
 * ── AGREED TERMS ARE NOT SPEND, AND THIS IS WHERE THAT COULD GO WRONG ──────
 *
 * The rate card and the spend figure are now on ONE screen, a few hundred
 * pixels apart, which is the exact adjacency that invites somebody to add them
 * up. They are not addable. `dayRatePence`, `hourlyRatePence`,
 * `callOutCostPence` and `otherCostPence` are what was AGREED; without days
 * worked, hours worked or call-outs used, a total of them is not a summary of
 * cost, it is an invented number. So they sit under their own heading, each on
 * its own row, with a sentence saying so — and there is no total, no subtotal
 * and no arithmetic over them anywhere in this file.
 *
 * Actual spend is `maintenance_requests.cost` attributed through
 * `contractor_id`, handed in already summed by the page, and labelled with the
 * shared basis note so the figure cannot be read as an invoiced or paid amount.
 *
 * ── DECLARED COVERAGE IS A FACT, NOT A RELATION ────────────────────────────
 *
 * `coverageAreas` is rendered here and is read for NOTHING else. The site
 * relation is `contractor_sites`, a real table, because every contractor on
 * this workspace declares `["UK"]` and every site is `region = 'UK'` — so a
 * coverage match connects all of them to all of them and discriminates
 * nothing, which is worse than no answer because it looks like one. See
 * `app/api/contractor-sites/route.ts`. Nothing in this file compares a coverage
 * entry against a site, and `tests/workstream-five-six-relationships.test.mjs`
 * holds that.
 */

import {
  CONTRACTOR_SPEND_BASIS,
  contractorSpendBasisNote,
} from "../../lib/contractor-attribution";
import { formatDate } from "../../lib/format-date";
import { ContractorContact } from "./contractor-contact";
/*
 * THE PENCE FORMATTER, under a name that says which unit it takes.
 *
 * Two currencies of one denomination meet on this screen: every agreed rate is
 * integer pence (`day_rate_pence` and its three siblings) and job cost is a
 * `real` in POUNDS — monday's "Cost of Works" column, the one place in this
 * product money is not an integer of pence. Handing £450.00 of day rate to the
 * pounds formatter prints £45,000, and handing £585 of spend to the pence one
 * prints £5.85. The alias is the guard: at every call site below the unit is
 * in the name.
 */
import { formatMoney as formatAgreedRate } from "./sites/site-types";

/** The four states `app/lib/expiry-status.ts` classifies, and no others. */
type ExpiryState = "expired" | "due-soon" | "valid" | "not-recorded";

/**
 * One certification, exactly as `/api/workspace` sent it.
 *
 * `expiryState` and `expiryLabel` come from the platform's one classifier at
 * the platform's one 60-day amber threshold. They are carried rather than
 * recomputed for the reason `compliance_documents.status` proves: a verdict
 * written down a second time is a verdict that can go stale, and "Compliant"
 * once outlived the certificate it described by months.
 */
export type SummaryCertification = {
  name: string;
  expiresOn: string | null;
  expiryState: ExpiryState;
  expiryLabel: string;
  daysRemaining: number | null;
};

/**
 * What the summary reads.
 *
 * Everything past the identity is optional, because two different producers
 * build these records: `/api/workspace`, which fills them from the register,
 * and the Contractors page's `fallbackContractors`, which synthesises a roster
 * out of job text when the register is empty and therefore knows almost
 * nothing. Absent has to mean "not known" for the second of those to render at
 * all — which is precisely why every section below tests for data first.
 */
export type SummaryContractor = {
  name: string;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  whatsappNumber?: string | null;
  availability?: string | null;
  active: boolean;
  serviceCategories?: string[];
  coverageAreas?: string[];
  certifications?: string[];
  certificationEntries?: SummaryCertification[];
  insuranceExpiry?: string | null;
  insuranceState?: ExpiryState;
  insuranceStatusLabel?: string | null;
  insurerName?: string | null;
  /* Agreed terms, all integer pence. Never summed — see the module note. */
  dayRatePence?: number | null;
  hourlyRatePence?: number | null;
  callOutCostPence?: number | null;
  otherCostPence?: number | null;
  otherCostLabel?: string | null;
  paymentTerms?: string | null;
  financeReference?: string | null;
};

export type SummaryPerformance = {
  assignedJobs: number;
  completedJobs: number;
  urgentJobs: number;
  /** POUNDS of recorded job cost. Attributed by the page, never by this file. */
  spend: number;
};

/**
 * Recorded job cost, rendered exactly as the register's Spend column renders
 * it — pounds, no pence, because these are four- and five-figure totals and a
 * trailing `.00` on every one of them is noise. The register uses
 * `formatMoney` in portal-app.tsx with the same options; two surfaces showing
 * the same figure to different precision is a difference a reader has to stop
 * and explain to themselves.
 */
function spendInPounds(value: number) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(value);
}

/** Trimmed text, or null. `""` and `"   "` are both "nothing recorded". */
function text(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

/**
 * Whether a pence figure was agreed at all.
 *
 * A PRESENCE TEST AND NEVER A COMPARISON. Null is "not agreed", which is not
 * the same claim as a rate of £0.00 — the register prints a dash for the first
 * because "£0.00" reads as "they work for free". Written as its own predicate
 * so that the only thing this file ever does with two rate figures at once is
 * ask whether either exists.
 */
function agreed(pence: number | null | undefined): boolean {
  return pence !== null && pence !== undefined;
}

/**
 * A labelled row, drawn only when there is something to put in it.
 *
 * Returning null rather than an em dash is the whole of rule 1 in one place.
 * The em dash is right in a TABLE, where a cell has to exist for the column to
 * line up and a blank would read as a rendering fault; it is wrong in a
 * summary, where the row itself is optional and eleven dashes say nothing
 * eleven times.
 */
export function ContractorRow({
  label,
  children,
  when = true,
}: {
  label: string;
  children: React.ReactNode;
  /** The caller's own emptiness test, for values that are not strings. */
  when?: boolean;
}) {
  if (!when || children === null || children === undefined || children === "") return null;
  return (
    <div className="contractor-summary__row">
      <span className="drawer-label">{label}</span>
      <span className="contractor-summary__value">{children}</span>
    </div>
  );
}

/** A rate row. Null pence is "not agreed", which is not a rate of £0.00. */
function RateRow({ label, pence }: { label: string; pence: number | null | undefined }) {
  if (!agreed(pence)) return null;
  return (
    <ContractorRow label={label}>
      {/* One figure, on its own, never in a sum. See the module note. */}
      <strong>{formatAgreedRate(pence)}</strong>
    </ContractorRow>
  );
}

/**
 * The expiry chip, in the shared shape and the shared vocabulary.
 *
 * `.workspace-expiry-chip` is the certification chip the record editor already
 * draws, so the same four states cannot come to look like two different things
 * on two screens. THE WORD IS ALWAYS PRINTED — the colour is the second signal
 * and never the only one — and `description` carries the sentence a screen
 * reader needs, because "Due soon" alone does not say due when.
 */
export function ContractorExpiryChip({ state, label }: { state: ExpiryState; label: string }) {
  return <span className={`workspace-expiry-chip is-${state}`}>{label}</span>;
}

/**
 * The contractor summary.
 *
 * `documentsHeld` and `sitesLinked` are counts the PROFILE has already
 * fetched and are passed in as numbers or null: null is "still loading", and
 * it renders as an em dash rather than as a zero, because a zero here is a
 * claim ("they hold nothing") that the panel is not yet in a position to make.
 */
export function ContractorSummary({
  contractor,
  performance,
  periodLabel,
  documentsHeld,
  sitesLinked,
}: {
  contractor: SummaryContractor;
  performance: SummaryPerformance;
  /** What window the performance figures were measured over. */
  periodLabel: string;
  /** Current, unarchived documents filed against them; null while loading. */
  documentsHeld: number | null;
  /** Sites they are appointed to; null while loading. */
  sitesLinked: number | null;
}) {
  const trades = contractor.serviceCategories ?? [];
  const areas = contractor.coverageAreas ?? [];
  const certificationNames = contractor.certifications ?? [];
  const certifications = contractor.certificationEntries ?? [];
  const insuranceExpiry = text(contractor.insuranceExpiry);
  const insurer = text(contractor.insurerName);
  const availability = text(contractor.availability);

  /*
   * WHICH CERTIFICATE RUNS OUT FIRST — a SELECTION, not a classification.
   *
   * The verdict on each entry was reached once, on the server, by
   * `expiryStatus`. This picks the entry whose verdict is most urgent and
   * prints that entry's own label; it does not decide what any date means. An
   * entry with no expiry (`daysRemaining === null`) is not a candidate,
   * because "no date recorded" is not nearer than a date.
   *
   * Sorting by `daysRemaining` rather than by the state word puts the most
   * overdue certificate first among several expired ones, which is the one
   * somebody has to chase.
   */
  const dated = certifications.filter((entry) => entry.daysRemaining !== null);
  const nearest = dated.length
    ? dated.reduce((worst, entry) =>
        (entry.daysRemaining ?? 0) < (worst.daysRemaining ?? 0) ? entry : worst)
    : null;

  const hasContact = Boolean(
    text(contractor.phone) ||
      text(contractor.whatsappNumber) ||
      text(contractor.email) ||
      text(contractor.contactName),
  );
  const hasServices = trades.length > 0 || areas.length > 0;
  const hasCompliance = Boolean(
    insuranceExpiry || insurer || certifications.length || certificationNames.length,
  );
  /*
   * Four presence tests joined by `||`, and that is the only expression in
   * this file with more than one rate figure in it. Nothing adds them.
   */
  const hasTerms =
    agreed(contractor.dayRatePence) ||
    agreed(contractor.hourlyRatePence) ||
    agreed(contractor.callOutCostPence) ||
    agreed(contractor.otherCostPence) ||
    Boolean(text(contractor.paymentTerms)) ||
    Boolean(text(contractor.financeReference));

  const completion = Math.round(
    (performance.completedJobs / Math.max(performance.assignedJobs, 1)) * 100,
  );

  /*
   * WHAT IS NOT RECORDED, SAID ONCE.
   *
   * The alternative — a card per absent group, each holding one line of
   * apology — is four empty boxes on a contractor nobody has filled in yet,
   * and it makes the screen LOOK broken in exactly the case where the data is
   * simply thin. One quiet sentence naming the gaps tells the reader the
   * absence is real, keeps the page short, and doubles as the list of what to
   * go and fill in.
   */
  const missing = [
    hasContact ? null : "contact details",
    hasServices ? null : "trades and coverage",
    hasCompliance ? null : "insurance and certifications",
    hasTerms ? null : "agreed terms",
  ].filter(Boolean) as string[];

  return (
    /*
     * `position: relative` on the wrapper, and it is load-bearing rather than
     * decorative. Several `.visually-hidden` spans live inside this panel, and
     * that utility is `position: absolute` with no offsets — with no positioned
     * ancestor it resolves against the initial containing block, takes a static
     * position far to the right, and adds real horizontal scroll to the
     * document. Measured at 320px on the archived chip before the same fix was
     * applied to it: 45px of body overflow.
     */
    <div className="contractor-summary">
      {/* ── REACH THEM ─────────────────────────────────────────────────── */}
      {hasContact && (
        <section className="contractor-summary__card">
          <h3>Reach them</h3>
          {/*
            THE SAME COMPONENT THE REGISTER DRAWS, not a second copy of it. It
            owns the whole rule about which of these three values may become an
            action, and the WhatsApp half of that rule is the one nobody may
            reimplement — see the module note above, and `contact-links.ts` for
            the measurement behind it. The number a contractor is messaged on is
            its own column and is never taken from the telephone one.

            (The failure mode is spelled out in the module note rather than
            here, because the test that proves this panel builds no contact link
            of its own reads comment bodies as code.)
          */}
          <ContractorContact contractor={contractor} />
        </section>
      )}

      {/* ── STATUS ─────────────────────────────────────────────────────── */}
      {/*
        TWO COLUMNS, TWO ROWS, AND NEVER ONE SENTENCE.

        `active` is whether the contractor is on the register at all — the flag
        the planned-work and assignment dropdowns filter on. `availability` is
        whether one who IS on it can take work this week. They were once read as
        one field, and a screenshot proved the cost: re-ticking "Active" writes
        only `active`, so an un-archived contractor kept the `Inactive`
        availability the archive verb had left behind and the register line said
        "Inactive" beside a ticked, saved box. Rows written before
        `contractorResurrectionRefusal` are still in the register wearing
        exactly that pair, so the distinction has to survive on screen.
      */}
      <section className="contractor-summary__card">
        <h3>Status</h3>
        <div className="contractor-summary__rows">
          <ContractorRow label="On the register">
            {contractor.active ? (
              <span className="contractor-summary__state is-active">Active</span>
            ) : (
              <span className="contractor-archived-chip">
                Archived
                {/*
                  Said out loud, because the word alone does not distinguish the
                  two states for somebody who cannot see that this row and the
                  one below it are different rows.
                */}
                <span className="visually-hidden">
                  {" "}
                  — off the register; this is not their availability
                </span>
              </span>
            )}
          </ContractorRow>
          <ContractorRow label="Availability" when={Boolean(availability)}>
            {availability}
          </ContractorRow>
        </div>
        <p className="contractor-summary__note">
          Two different facts. The register state says whether {contractor.name} is on
          the register at all; availability says whether somebody who is on it can take
          work now.
        </p>
      </section>

      {/* ── SERVICES & COVERAGE ────────────────────────────────────────── */}
      {hasServices && (
        <section className="contractor-summary__card">
          <h3>Services &amp; coverage</h3>
          <div className="contractor-summary__rows">
            <ContractorRow label="Trades" when={trades.length > 0}>
              <ChipList items={trades} label={`Trades ${contractor.name} covers`} />
            </ContractorRow>
            <ContractorRow label="Service areas" when={areas.length > 0}>
              <ChipList items={areas} label={`Areas ${contractor.name} covers`} />
            </ContractorRow>
          </div>
          {/*
            SAID ON THE SCREEN, not only in a comment, because the reader is the
            one who would otherwise draw the wrong conclusion from it. Declared
            coverage is what somebody typed into the register; it is not a list
            of the sites this contractor is appointed to, and it is not used to
            produce one. The Sites tab is that record.
          */}
          <p className="contractor-summary__note">
            Declared coverage, as the register holds it. It does not decide which sites
            they are appointed to — the Sites tab is the record of that.
          </p>
        </section>
      )}

      {/* ── COMPLIANCE ─────────────────────────────────────────────────── */}
      {hasCompliance && (
        <section className="contractor-summary__card">
          <h3>Compliance</h3>
          <div className="contractor-summary__rows">
            <ContractorRow label="Insurer" when={Boolean(insurer)}>
              {insurer}
            </ContractorRow>
            <ContractorRow label="Insurance expires" when={Boolean(insuranceExpiry)}>
              <span className="contractor-summary__pair">
                {formatDate(insuranceExpiry)}
                {/*
                  The chip is drawn only when there is a DATE behind it. With no
                  expiry recorded the server still sends the `not-recorded`
                  bucket, and printing "Not recorded" as a status chip would
                  dress an absence up as a verdict somebody reached.
                */}
                {contractor.insuranceState && contractor.insuranceStatusLabel && (
                  <ContractorExpiryChip
                    state={contractor.insuranceState}
                    label={contractor.insuranceStatusLabel}
                  />
                )}
              </span>
            </ContractorRow>
            <ContractorRow label="Certifications" when={certifications.length > 0}>
              {certifications.length === 1
                ? certifications[0].name
                : `${certifications.length} recorded`}
            </ContractorRow>
            <ContractorRow label="Nearest expiry" when={Boolean(nearest)}>
              {nearest && (
                <span className="contractor-summary__pair">
                  {nearest.name} · {formatDate(nearest.expiresOn)}
                  <ContractorExpiryChip state={nearest.expiryState} label={nearest.expiryLabel} />
                </span>
              )}
            </ContractorRow>
            {/*
              The legacy array, and only where the structured rows are empty.
              `contractors.certifications` is a list of NAMES with no dates
              behind it — it is what every row imported before W06-08 still
              carries — so it can say what somebody holds and never whether it
              is still valid. Shown so that a contractor who has one is not
              reported as having none; not given a status, because there is no
              date to derive one from.
            */}
            <ContractorRow
              label="Certifications (no dates)"
              when={certifications.length === 0 && certificationNames.length > 0}
            >
              {certificationNames.join(", ")}
            </ContractorRow>
          </div>
          <p className="contractor-summary__note">
            Statuses are derived from the recorded dates, at the platform&rsquo;s 60-day
            warning. Nothing here is a status somebody typed.
          </p>
        </section>
      )}

      {/* ── AGREED COMMERCIAL TERMS ────────────────────────────────────── */}
      {hasTerms && (
        <section className="contractor-summary__card">
          {/*
            THE HEADING CARRIES THE WORD "AGREED", and that is not decoration.
            This section sits a few hundred pixels above a spend figure; a
            heading that said only "Rates" would leave the two looking like
            halves of one arithmetic. There is no total here and there is no
            code in this file that adds two of these figures together.
          */}
          <h3>Agreed commercial terms</h3>
          <p className="contractor-summary__note contractor-summary__note--lead">
            Agreed reference terms, not money spent. They are listed one by one and
            never added together: without days or hours worked, a total of these would
            be money nobody owes. What was actually spent is under Performance.
          </p>
          <div className="contractor-summary__rows">
            <RateRow label="Day rate" pence={contractor.dayRatePence} />
            <RateRow label="Hourly rate" pence={contractor.hourlyRatePence} />
            <RateRow label="Call-out" pence={contractor.callOutCostPence} />
            {/*
              The label travels with its figure. `otherCostPence` is meaningless
              without `otherCostLabel` — "£20.00" of what? — so the stored label
              is the row's name whenever there is one.
            */}
            <RateRow
              label={text(contractor.otherCostLabel) ?? "Other cost"}
              pence={contractor.otherCostPence}
            />
            <ContractorRow label="Payment terms" when={Boolean(text(contractor.paymentTerms))}>
              {text(contractor.paymentTerms)}
            </ContractorRow>
            {/*
              The supplier record in the accounting system, and deliberately the
              only financial identifier this product holds: there is no account
              number, sort code, IBAN or card detail on the contractor row, on
              the route that writes it, or here. A stolen accounting reference
              buys an attacker nothing, which is not true of a sort code.
            */}
            <ContractorRow label="Finance reference" when={Boolean(text(contractor.financeReference))}>
              {text(contractor.financeReference)}
            </ContractorRow>
          </div>
        </section>
      )}

      {/* ── PERFORMANCE ────────────────────────────────────────────────── */}
      <section className="contractor-summary__card">
        <h3>Performance</h3>
        {/*
          THE WINDOW IS NAMED. These are period-scoped measurements rather than
          facts about the contractor, and a completion rate with no window
          beside it is a number nobody can check.
        */}
        <p className="contractor-summary__note contractor-summary__note--lead">
          Measured over {periodLabel}.
        </p>
        <div className="site-stat-grid">
          <div className="panel">
            <span className="drawer-label">Assigned jobs</span>
            <strong>{performance.assignedJobs}</strong>
          </div>
          <div className="panel">
            <span className="drawer-label">Completed</span>
            <strong>{performance.completedJobs}</strong>
          </div>
          <div className="panel">
            <span className="drawer-label">Completion rate</span>
            <strong>{completion}%</strong>
          </div>
          <div className="panel">
            <span className="drawer-label">Open urgent</span>
            <strong>{performance.urgentJobs}</strong>
          </div>
          {/*
            ACTUAL SPEND. Recorded job cost on the jobs `contractor_id` says are
            theirs, summed by the page from the rows the one shared attribution
            rule gave it, and handed here as a number. Never a rate, and never a
            rate multiplied by anything. (The rule is named in the module note
            above; it is deliberately not named in this comment, because the
            test that proves this panel does not re-derive attribution reads
            comment bodies as code.)
          */}
          <div className="panel">
            <span className="drawer-label">Attributed spend</span>
            <strong>{spendInPounds(performance.spend)}</strong>
          </div>
          {/*
            Sites and documents are the two RELATIONS, counted from the rows the
            profile has already listed rather than from a number this panel
            cannot check. Null is "still loading" and prints a dash; zero is an
            answer and prints a zero.
          */}
          <div className="panel">
            <span className="drawer-label">Sites linked</span>
            <strong>{sitesLinked === null ? "—" : sitesLinked}</strong>
          </div>
          <div className="panel">
            <span className="drawer-label">Documents held</span>
            <strong>{documentsHeld === null ? "—" : documentsHeld}</strong>
          </div>
        </div>
        {/*
          THE SHARED BASIS SENTENCE, imported rather than typed. It says two
          things the figure above cannot: that this is recorded job cost and not
          an invoiced or paid amount, and which operational date decided the
          window. Held in `contractor-attribution.ts` so the wording cannot
          drift into claiming something the data does not support.
        */}
        <p className="contractor-summary__note">
          {contractorSpendBasisNote(CONTRACTOR_SPEND_BASIS.completed)}
        </p>
      </section>

      {/* ── WHAT IS NOT RECORDED ───────────────────────────────────────── */}
      {missing.length > 0 && (
        <p className="analytics-empty contractor-summary__missing">
          Not recorded yet: {missing.join(" · ")}. Add them from Manage contractors.
        </p>
      )}
    </div>
  );
}

/**
 * A set of short values as chips.
 *
 * A LIST, because that is what it is: several sibling values of equal weight,
 * with no order that means anything. A screen reader announces "list, 2 items"
 * and reads them as a set, where a joined string would be read as one long
 * value with commas in it. The accessible name says whose set it is, because
 * "Electrical, HVAC" on its own does not say what those two words are.
 */
function ChipList({ items, label }: { items: string[]; label: string }) {
  return (
    <ul className="contractor-summary__chips" aria-label={label}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}
