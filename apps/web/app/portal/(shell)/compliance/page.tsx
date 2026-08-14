import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getViewerState, serverFetch } from "../../../../lib/session";
import {
  canSeeCompliance,
  formatDate,
  type ComplianceCalendar,
  type ComplianceCalendarItem,
  type ComplianceOverview,
} from "../../../../lib/portal";
import ComplianceRegister from "./compliance-register";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Compliance" };

/**
 * The compliance screen.
 *
 * THE DENOMINATOR IS PRINTED, ALWAYS. The headline is not "82%" — it is
 * "82% · 18 of 22 required documents in date", with the count of excluded
 * `not_required` rows beside it. A percentage on its own is how this product
 * once showed 82% one week and 26% the next with no certificate having changed:
 * the requirement list grew from nine entries to twelve, the denominator moved,
 * and nothing on screen said so. Every figure below states what it is a
 * fraction of.
 *
 * The score and the calendar are server-rendered from two requests; the
 * register underneath is a client component because uploading a certificate and
 * marking a requirement not required are writes, and the screen has to re-read
 * the API afterwards rather than patch a number locally.
 */

/** "in 12 days", "8 days ago" — the number people actually act on. */
function when(days: number): string {
  if (days < 0) return `${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} ago`;
  if (days === 0) return "today";
  return `in ${days} ${days === 1 ? "day" : "days"}`;
}

function CalendarTable({
  caption,
  rows,
  tone,
}: {
  caption: string;
  rows: ComplianceCalendarItem[];
  tone: string;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="p-panel">
      <div className="p-section-head">
        <h2>{caption}</h2>
        <span className="p-muted p-small">
          {rows.length} {rows.length === 1 ? "certificate" : "certificates"}
        </span>
      </div>
      {/* Wide content scrolls inside its own wrapper; the page never does. */}
      <div className="p-tablewrap">
        <table className="p-table">
          <thead>
            <tr>
              <th className="p-sticky">Store</th>
              <th>Document</th>
              <th>Expiry</th>
              <th className="p-num">When</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.site_id}-${row.kind}`}>
                <th scope="row" className="p-sticky">
                  {row.site_name}
                </th>
                <td>{row.label}</td>
                <td className="p-mono">{formatDate(row.expiry_date) ?? row.expiry_date}</td>
                <td className="p-num">
                  <span className={tone}>{when(row.days_left)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default async function CompliancePage() {
  const state = await getViewerState();
  if (state.kind !== "ok") return null;

  /*
   * The nav does not draw this link for a contractor, but the URL is typeable.
   * Not the security boundary — `siteScopeFor` denies them in the API and this
   * page would render an empty register either way. It only decides whether
   * they see a blank screen or the one page they do have.
   */
  if (!canSeeCompliance(state.viewer.actor)) redirect("/portal/dashboard");

  const [overview, calendar] = await Promise.all([
    serverFetch<ComplianceOverview>("/compliance"),
    serverFetch<ComplianceCalendar>("/compliance/calendar?months=12"),
  ]);

  if (!overview.ok) {
    return (
      <div className="card card--empty">
        <h1>Compliance</h1>
        <p className="muted">{overview.error}</p>
      </div>
    );
  }

  const { summary, sites, requirements, expiringWithinDays, canManage } = overview.data;
  const diary = calendar.ok ? calendar.data : null;

  return (
    <>
      <h1 className="p-h1">Compliance</h1>
      <p className="p-lede">
        Every store is measured against the same {requirements.length}-document
        list. A document nobody asks for is marked not required, with a reason,
        and leaves the count entirely.
      </p>

      <section className="p-panel">
        <div className="p-section-head">
          <h2>Compliance score</h2>
        </div>

        {/*
          The denominator, in words, immediately under the number. This sentence
          is the point of the panel: it is what makes a score that moved because
          the requirement list changed distinguishable from one that moved
          because a certificate lapsed.
        */}
        <p className="p-h1 p-mono" style={{ fontSize: 34, marginBottom: 2 }}>
          {summary.percent === null ? "—" : `${summary.percent}%`}
        </p>
        <p className="p-note" style={{ marginTop: 0 }}>
          <strong>
            {summary.inDate} of {summary.required} required documents in date
          </strong>{" "}
          across {summary.sites} {summary.sites === 1 ? "store" : "stores"}
          {summary.notRequired > 0 ? (
            <>
              {" "}
              · {summary.notRequired} marked not required and excluded from the
              count
            </>
          ) : null}
          . In date means Valid or Expiring; a certificate expiring within{" "}
          {expiringWithinDays} days has not lapsed yet.
        </p>

        <dl className="p-stats" style={{ marginTop: 14, marginBottom: 0 }}>
          <div className="p-stat">
            <dt>Valid</dt>
            <dd>{summary.valid}</dd>
            <p className="p-stat-note">more than {expiringWithinDays} days left</p>
          </div>
          <div className="p-stat">
            <dt>Expiring</dt>
            <dd>{summary.expiring}</dd>
            <p className="p-stat-note">within {expiringWithinDays} days</p>
          </div>
          <div className="p-stat">
            <dt>Expired</dt>
            <dd className={summary.expired ? "p-bad" : undefined}>{summary.expired}</dd>
            <p className="p-stat-note">past its date</p>
          </div>
          <div className="p-stat">
            <dt>Missing</dt>
            <dd>{summary.missing}</dd>
            <p className="p-stat-note">nothing on file</p>
          </div>
          <div className="p-stat">
            <dt>Not required</dt>
            <dd>{summary.notRequired}</dd>
            <p className="p-stat-note">excluded from the {summary.required}</p>
          </div>
        </dl>
      </section>

      <div className="p-section">
        <div className="p-section-head">
          <h2>The next twelve months</h2>
          <span className="p-muted p-small">
            {diary ? `${diary.expired.length} expired · ${diary.soon.length} within ${diary.expiringWithinDays} days` : ""}
          </span>
        </div>

        {!diary ? (
          <div className="card card--empty">
            <p className="muted">{calendar.ok ? "" : calendar.error}</p>
          </div>
        ) : diary.expired.length + diary.soon.length + diary.later.length === 0 ? (
          <div className="card card--empty">
            <p className="muted">
              Nothing with an expiry date is on file yet. Certificates with dates
              appear here as they are added.
            </p>
          </div>
        ) : (
          <>
            <CalendarTable caption="Already expired" rows={diary.expired} tone="p-bad" />
            <CalendarTable
              caption={`Next three months (within ${diary.expiringWithinDays} days)`}
              rows={diary.soon}
              tone="p-mono"
            />
            <CalendarTable
              caption="Later this year"
              rows={diary.later}
              tone="p-muted"
            />
          </>
        )}
      </div>

      <div className="p-section">
        <div className="p-section-head">
          <h2>Stores</h2>
          <span className="p-muted p-small">
            {sites.length} {sites.length === 1 ? "store" : "stores"}
          </span>
        </div>

        {sites.length === 0 ? (
          <div className="card card--empty">
            <p className="muted">No stores are in your scope.</p>
          </div>
        ) : (
          <ComplianceRegister
            sites={sites}
            requirementCount={requirements.length}
            expiringWithinDays={expiringWithinDays}
            canManage={canManage}
          />
        )}
      </div>
    </>
  );
}
