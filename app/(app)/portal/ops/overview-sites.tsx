"use client";

/**
 * SECTION E — Sites needing attention. §6 of the dashboard master prompt.
 *
 * The card this replaces read "57 open jobs across 2 sites" for a client with
 * ten stores, and one of the two was *Unassigned site*. §6.1 is unambiguous
 * about what that is: "a broken foreign key, not a location", and ranking it
 * against real stores distorted every figure on the card. It is gone from the
 * list and is now a data-quality row with a bulk repair behind it.
 *
 * ── THE FOUR THINGS THAT CHANGED, AND WHY ─────────────────────────────────
 *
 * 1. REAL SITES ONLY (§6.1, gate 31). The header counts sites that exist, and
 *    the subtitle gives the portfolio context the old header never had — "1 of
 *    10 sites has open work" answers the question "is one site bad, or is the
 *    estate quiet?", which the raw count could not.
 *
 * 2. THE DOT ROW IS DELETED (§6.3, gate 32). `●●●●●●●●● +16  17 urgent` had no
 *    key, no scale, and two numbers running into each other. The labelled
 *    ageing bar replaces it: four bands, each with its own count drawn on the
 *    segment, and a key above the list naming the bands and their day ranges,
 *    because §1.3 forbids colour carrying meaning on its own.
 *
 * 3. SHARE OF OPEN WORK IS A PERCENTAGE (§6.3). The old row printed "Share of
 *    open 26" — a count beside a bar, which reads as a second job count. Its
 *    denominator is the header's own "57 open jobs", which is §1.4's rule that
 *    a percentage never appears without a visible denominator.
 *
 * 4. THE INTAKE WARNING (§6.2). Fresh and Ageing both at zero while Overdue and
 *    Critical are not is the single most important fact this card can carry,
 *    and it used to sit as two silent zeros in a legend. Either nothing new is
 *    being logged or request dates are missing, and both are worth a sentence.
 *
 * ── THE HEADER IS NOT `CohortHeader`, DELIBERATELY ────────────────────────
 *
 * Every other card on this page uses it, and this one cannot: `CohortHeader`
 * prints `cohortWording(measure, total)` — "57 jobs requested in this period" —
 * and §6.1 specifies a different sentence, "57 open jobs across 1 site". Open
 * jobs are a SUBSET of the cohort, so printing the cohort verb over an open
 * count would restate the exact confusion §5.1 is fixing on the card above.
 * The header below is therefore the same markup and the same classes, with the
 * count line this section is specified to carry, and it uses the shared
 * `FilterChip` so the chips behave identically. If `CohortHeader` grows a
 * `countText` override, this deletes.
 */

import { useState } from "react";
import { ChartFrame, SeverityBar, DataQualityRow } from "./overview-shared";
import { EmptyState, FilterChip, SkeletonRow } from "./ops-primitives";
import {
  NOT_RECORDED_INK,
  SEVERITY_COLOUR,
  SEVERITY_KEYS,
  SEVERITY_LABEL,
  SEVERITY_RANGE,
} from "../../../lib/overview-meters";
import type {
  AttentionSiteRow,
  CohortMeasure,
  SeverityCounts,
  SitesAttentionPayload,
} from "./overview-contract";

type QueryState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
};

type FilterChipItem = { key: string; label: string; onRemove?: () => void };

const TITLE_ID = "ovw-sites-title";

/**
 * How many rows before "View all" appears.
 *
 * §6.3 asks for "every site with open work", and on this estate that is six.
 * A portfolio of two hundred stores would turn the card into the page, so the
 * list caps and says so — §6.4: "Keep View all but render it only when the list
 * is truncated." Below the cap nothing is hidden and no control is drawn.
 */
const SITE_ROW_LIMIT = 8;

/* ── The sentences §6.1 specifies ─────────────────────────────────────────── */

/**
 * "57 open jobs across 1 site" — and the singular, which the old card got
 * wrong in both halves.
 */
export function attentionHeadline(openTotal: number, siteCount: number): string {
  const jobs = `${openTotal} open ${openTotal === 1 ? "job" : "jobs"}`;
  const sites = `${siteCount} ${siteCount === 1 ? "site" : "sites"}`;
  return `${jobs} across ${sites}`;
}

/**
 * "1 of 10 sites has open work." — portfolio context, §6.1.
 *
 * The verb agrees with the SUBJECT count, not the portfolio one: "1 of 10 sites
 * has", "3 of 10 sites have". A portfolio of zero is not rendered as "0 of 0";
 * it says there is no register yet, because §1.5 keeps zero and "no data"
 * apart.
 */
export function portfolioSubtitle(siteCount: number, portfolioSiteCount: number): string {
  if (portfolioSiteCount <= 0) return "No sites are recorded in this workspace yet.";
  const verb = siteCount === 1 ? "has" : "have";
  const noun = portfolioSiteCount === 1 ? "site" : "sites";
  return `${siteCount} of ${portfolioSiteCount} ${noun} ${verb} open work.`;
}

/**
 * §6.2's intake warning, and the condition it fires on.
 *
 * Nothing under 30 days old while work sits in the 31–60 and 60+ bands is not a
 * quiet month — it is either an intake that has stopped or request dates that
 * are not being recorded, and the two are worth telling apart. The payload's
 * own sentence wins when it carries one; this is the fallback so the warning
 * cannot go missing because an aggregate forgot it.
 */
export function intakeNotice(ageing: SeverityCounts, supplied: string | null): string | null {
  if (supplied) return supplied;
  const fresh = ageing.fresh + ageing.ageing;
  const stale = ageing.overdue + ageing.critical;
  if (fresh > 0 || stale <= 0) return null;
  return (
    "No open job in this portfolio is under 30 days old. Either no new work has been logged " +
    "recently, or request dates are missing — check intake."
  );
}

/**
 * `1 of 12 in date` with a traffic light, and `Not set up` ONLY where the site
 * genuinely has no profile — §6.3.
 *
 * `scored === false` is the payload's way of saying "this site has never been
 * set up", and it is the only thing that may print "Not set up". A site with a
 * profile and nothing in date reads `0 of 12 in date` on a red dot: zero is a
 * fact and it is a different fact from an absent profile (§1.5).
 *
 * The dot takes the severity ramp rather than a fresh set of greens and reds,
 * so a reader who has learned the four bands above has not been handed a second
 * colour language six inches lower.
 */
export function complianceReadout(compliance: {
  satisfied: number;
  applicable: number;
  scored: boolean;
}): { text: string; colour: string; spoken: string } {
  if (!compliance.scored) {
    return {
      text: "Not set up",
      colour: NOT_RECORDED_INK,
      spoken: "no compliance profile is set up",
    };
  }
  if (compliance.applicable <= 0) {
    return {
      text: "Nothing applicable",
      colour: NOT_RECORDED_INK,
      spoken: "no requirements apply",
    };
  }
  const percent = Math.round((compliance.satisfied / compliance.applicable) * 100);
  const colour =
    percent >= 90
      ? SEVERITY_COLOUR.fresh
      : percent >= 60
        ? SEVERITY_COLOUR.ageing
        : SEVERITY_COLOUR.critical;
  return {
    text: `${compliance.satisfied} of ${compliance.applicable} in date`,
    colour,
    spoken: `${compliance.satisfied} of ${compliance.applicable} requirements in date, ${percent} per cent`,
  };
}

/* ── One site ─────────────────────────────────────────────────────────────── */

/**
 * A ROW ON A DESKTOP, A CARD ON A PHONE — §1.8, and the same DOM for both.
 *
 * "Wide tables become stacked cards, one record per card, same fields, primary
 * value first." Nothing here is duplicated for a breakpoint: the figures are a
 * `<dl>` that is a two-column grid at 375px and one row from 768px up, and the
 * open-jobs figure carries `--primary`, which is what makes it the large number
 * on the card and an ordinary column in the row.
 *
 * The oldest-open reference is drawn ALWAYS rather than on hover. §6.3 offers
 * "hover or tap" and §1.8 answers it: "Nothing important sits behind hover
 * alone." A seven-character job reference costs one line and saves the reader a
 * gesture they would have to discover first.
 */
function SiteRow({
  site,
  onToggle,
  onDrill,
  onNavigateToSites,
}: {
  site: AttentionSiteRow;
  onToggle: (key: string, value: string) => void;
  onDrill: (extra: Record<string, string>) => void;
  onNavigateToSites: (query: string) => void;
}) {
  const compliance = complianceReadout(site.compliance);
  const urgent = site.urgentCount > 0;

  return (
    <li className="ovp-site">
      <div className="ovp-site__head">
        <button
          type="button"
          className="ovp-site__name ovp-touch"
          onClick={() => onNavigateToSites(`site=${encodeURIComponent(site.siteId)}`)}
        >
          {site.siteName}
        </button>
        {/*
          Cross-filtering is the page's model (§1.2) and it is a different act
          from opening the record, so it is a different control rather than a
          modifier on the same one. One tap makes every card on the page about
          this store; tapping the chip it adds takes it back off.
        */}
        <button
          type="button"
          className="ops-link ovp-touch ovp-site__focus"
          onClick={() => onToggle("site", site.siteId)}
          aria-label={`Filter this page to ${site.siteName}`}
        >
          Filter page
        </button>
      </div>

      <dl className="ovp-site__figures">
        <div className="ovp-site__figure ovp-site__figure--primary">
          <dt>Open jobs</dt>
          <dd>
            <button
              type="button"
              className="ovp-site__count ovp-touch"
              /*
                `open`, not `in_progress`. §6.3's figure is the site's OPEN
                count, and open means "not completed" — the status model is
                completed / in_progress / attention, so a job needing attention
                is open too. Drilling on `in_progress` alone opened a list
                shorter than the number printed on the button, which is the one
                thing a count that is itself a button may never do.
              */
              onClick={() => onDrill({ site: site.siteId, family: "open" })}
              aria-label={`View the ${site.openCount} open jobs at ${site.siteName}`}
            >
              {site.openCount}
            </button>
          </dd>
        </div>

        <div className="ovp-site__figure">
          <dt>Urgent</dt>
          <dd>
            {/*
              §6.3 — the severity-critical colour above zero, grey at zero. The
              number is the signal and the colour is the second one; neither is
              alone, which is §1.3's rule.
            */}
            <span
              className="ovp-site__urgent"
              style={{ color: urgent ? SEVERITY_COLOUR.critical : NOT_RECORDED_INK }}
            >
              {site.urgentCount}
            </span>
          </dd>
        </div>

        <div className="ovp-site__figure">
          <dt>Oldest open</dt>
          <dd>
            {site.oldestDays === null ? (
              <span className="ovp-site__missing">No open work</span>
            ) : (
              <>
                <span className="ovp-site__days">{site.oldestDays}d</span>
                {site.oldestReference ? (
                  <small className="ovp-site__ref">{site.oldestReference}</small>
                ) : null}
              </>
            )}
          </dd>
        </div>

        <div className="ovp-site__figure">
          <dt>Share of open work</dt>
          <dd>
            <span className="ovp-site__share">{site.shareOfOpen}%</span>
          </dd>
        </div>

        <div className="ovp-site__figure ovp-site__figure--wide">
          <dt>Compliance</dt>
          <dd>
            <span
              className="ovp-dot"
              style={{ background: compliance.colour }}
              aria-hidden="true"
            />
            <span aria-label={`Compliance at ${site.siteName}: ${compliance.spoken}`}>
              {compliance.text}
            </span>
          </dd>
        </div>
      </dl>

      <div className="ovp-site__ageing">
        <SeverityBar
          counts={site.severity}
          showNumbers
          label={`Ageing of open work at ${site.siteName}`}
        />
      </div>
    </li>
  );
}

/* ── The card ─────────────────────────────────────────────────────────────── */

export function SitesAttentionCard({
  state,
  measure: requestedMeasure,
  filterChips,
  onToggle,
  onDrill,
  onOpenRecords,
  onOpenBulkAssign,
  onNavigateToSites,
  onNavigateToCompliance,
}: {
  state: QueryState<SitesAttentionPayload>;
  measure: CohortMeasure;
  filterChips: FilterChipItem[];
  onToggle: (key: string, value: string) => void;
  onDrill: (extra: Record<string, string>) => void;
  onOpenRecords: (query: string) => void;
  onOpenBulkAssign: () => void;
  onNavigateToSites: (query: string) => void;
  onNavigateToCompliance: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const data = state.data;

  /*
   * THE VERB IS THE SERVER'S, NOT THE CONTROL'S.
   *
   * `/api/dashboard/sites-attention` resolves the cohort axis from the query
   * string alone — `parseFilters` cannot see a stored per-user preference — so
   * the page's resolved `measure` is what the reader ASKED for while
   * `data.measure` is what was counted. On a bare `/dashboard` with a saved
   * axis of `completed` the two differ, and this card described its rows as
   * "the jobs completed in this period" over a cohort the server had cut on
   * `requested_at`. The prop therefore arrives as `requestedMeasure` and the
   * local `measure` is what was APPLIED; the intent is still read, for the
   * single render before a payload exists, and this card draws no cohort
   * sentence in that render.
   */
  const measure = data?.measure ?? requestedMeasure;

  if (state.error) {
    return (
      <section className="ops-card ovp-card" id="ops-sites" aria-labelledby={TITLE_ID}>
        <h2 className="ovw-cohort__title" id={TITLE_ID}>
          Sites needing attention
        </h2>
        <p className="ops-error" role="alert">
          {state.error}{" "}
          <button type="button" className="ops-link ovp-touch" onClick={state.reload}>
            Retry
          </button>
        </p>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="ops-card ovp-card" id="ops-sites" aria-labelledby={TITLE_ID}>
        <h2 className="ovw-cohort__title" id={TITLE_ID}>
          Sites needing attention
        </h2>
        {state.loading ? (
          <SkeletonRow lines={5} height={240} />
        ) : (
          <EmptyState>No site figures have been loaded for this period.</EmptyState>
        )}
      </section>
    );
  }

  const axis = measure === "completed" ? "completed" : "requested";
  const truncated = data.sites.length > SITE_ROW_LIMIT;
  const visible = expanded ? data.sites : data.sites.slice(0, SITE_ROW_LIMIT);
  const intake = intakeNotice(data.ageing, data.intakeWarning);
  const ageingTotal = SEVERITY_KEYS.reduce((sum, key) => sum + data.ageing[key], 0);

  return (
    <section className="ops-card ovp-card" id="ops-sites" aria-labelledby={TITLE_ID}>
      {/* See the file header for why this is not `CohortHeader`. */}
      <header className="ovw-cohort">
        <div className="ovw-cohort__titles">
          <h2 className="ovw-cohort__title" id={TITLE_ID}>
            Sites needing attention
          </h2>
          <p className="ovw-cohort__count">
            {attentionHeadline(data.openTotal, data.siteCount)}
          </p>
          <p className="ovw-cohort__subtitle">
            {portfolioSubtitle(data.siteCount, data.portfolioSiteCount)}
          </p>
          {filterChips.length > 0 ? (
            <ul className="ovw-cohort__chips">
              {filterChips.map((chip) => {
                const match = /^(.*?)\s*[=:]\s*(.*)$/.exec(chip.label);
                return (
                  <li key={`${chip.key}-${chip.label}`}>
                    {chip.onRemove ? (
                      <FilterChip
                        label={match ? match[1] : ""}
                        value={match ? match[2] : chip.label}
                        onRemove={chip.onRemove}
                      />
                    ) : (
                      <span className="ovw-cohort__chip">{chip.label}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
        {/* §6.4 — "View all", and only when the list is actually truncated. */}
        {truncated ? (
          <div className="ovw-cohort__action">
            <button
              type="button"
              className="ops-link ovp-touch"
              aria-expanded={expanded}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? `Show the top ${SITE_ROW_LIMIT} only` : `View all ${data.sites.length} →`}
            </button>
          </div>
        ) : null}
      </header>

      {/* ── Age of open work — §6.2 ─────────────────────────────────────── */}
      <ChartFrame
        title="Age of open work"
        table={{
          caption: `Open jobs by age, from jobs ${axis} in this period`,
          head: ["Band", "Days open", "Jobs"],
          rows: SEVERITY_KEYS.map((key) => [
            SEVERITY_LABEL[key],
            SEVERITY_RANGE[key],
            data.ageing[key],
          ]),
        }}
        empty={ageingTotal === 0}
        emptyLabel={`No open jobs among the work ${axis} in this period.`}
        minHeight={120}
      >
        <>
          <SeverityBar counts={data.ageing} showNumbers label="Open jobs by age" />
          {/*
            The key. `SeverityBar` names every band in its accessible label, but
            a sighted reader gets numbers on colours and nothing else — §1.3:
            "Colour never carries meaning alone — every segment has a text label
            and a number."
          */}
          <ul className="ovp-key">
            {SEVERITY_KEYS.map((key) => (
              <li key={key} className="ovp-key__item">
                <span
                  className="ovp-key__swatch"
                  style={{ background: SEVERITY_COLOUR[key] }}
                  aria-hidden="true"
                />
                <span className="ovp-key__label">{SEVERITY_LABEL[key]}</span>
                <span className="ovp-key__range">{SEVERITY_RANGE[key]}</span>
                <strong className="ovp-key__value">{data.ageing[key]}</strong>
              </li>
            ))}
          </ul>
        </>
      </ChartFrame>

      {intake ? (
        <p className="ovw-breakdown__warning ovp-notice" role="note">
          {intake}
          {/*
            `sort: "newest"` used to travel here and was read by nothing at all
            — not by `readDrillFilter`, not by the board — so the link promised
            an ordering it could not deliver and landed on the unfiltered board
            besides. The notice above is a claim about the age of the portfolio's
            OPEN work, so the destination that lets a reader check it is that
            same population, narrowed by the same period and filters this page
            is already showing. The wording follows the destination rather than
            the other way round.
          */}
          <button
            type="button"
            className="ops-link ovp-touch"
            onClick={() => onDrill({ family: "open" })}
          >
            View the open work →
          </button>
        </p>
      ) : null}

      {/* ── The site rows — §6.3 ────────────────────────────────────────── */}
      {data.sites.length === 0 ? (
        <EmptyState>
          No site in this portfolio has open work among the jobs {axis} in this period.
        </EmptyState>
      ) : (
        <ul className="ovp-sites">
          {visible.map((site) => (
            <SiteRow
              key={site.siteId}
              site={site}
              onToggle={onToggle}
              onDrill={onDrill}
              onNavigateToSites={onNavigateToSites}
            />
          ))}
        </ul>
      )}

      {/*
        §6.3 — "Sites without open work collapse into one line." One line, not
        nine rows: a card called "needing attention" that lists nine stores
        needing nothing has taught the reader to scroll past it.
      */}
      {data.quietSites > 0 ? (
        <button
          type="button"
          className="ops-link ovp-touch ovp-quiet"
          onClick={() => onNavigateToSites("hasJobs=no")}
        >
          {data.quietSites} {data.quietSites === 1 ? "site has" : "sites have"} no open work →
        </button>
      ) : null}

      {/* ── Data quality — §6.4. Non-zero items only. ───────────────────── */}
      <DataQualityRow
        items={[
          {
            key: "no_site",
            count: data.dataQuality.jobsWithNoSite,
            sentence: "jobs point at no site in the register",
            /* The bulk view assigns several in one pass — §6.4 and gate 33. */
            actionLabel: "Fix these →",
            onAction: onOpenBulkAssign,
          },
          {
            key: "no_compliance_profile",
            count: data.dataQuality.sitesWithoutComplianceProfile,
            sentence: "sites have no compliance profile",
            actionLabel: "Open compliance →",
            onAction: onNavigateToCompliance,
          },
          {
            key: "no_jobs_no_contact",
            count: data.dataQuality.sitesWithNoJobsAndNoContact,
            sentence: "sites have no jobs and no contact recorded",
            actionLabel: "Fix these →",
            onAction: () => onNavigateToSites("details=incomplete"),
          },
        ]}
      />

      <div className="ovp-footer">
        <button
          type="button"
          className="ops-link ovp-touch"
          onClick={() => onNavigateToSites("")}
        >
          Open the sites register →
        </button>
        {data.dataQuality.jobsWithNoSite > 0 ? (
          /*
            The rows behind the repair, before the repair. Nothing is assigned
            from here — this is the read-only list the bulk view acts on, and
            seeing it first is what makes the Fix action safe to press.
          */
          <button
            type="button"
            className="ops-link ovp-touch"
            onClick={() => onOpenRecords("no_site")}
          >
            List the {data.dataQuality.jobsWithNoSite} jobs with no site →
          </button>
        ) : null}
      </div>
    </section>
  );
}
