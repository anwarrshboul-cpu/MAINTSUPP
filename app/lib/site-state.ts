/**
 * THE THREE THINGS A SITE RECORD SAYS ABOUT ITSELF, AND THE ONE RULE THAT KEEPS
 * THEM FROM CONTRADICTING EACH OTHER.
 *
 * `sites` carries three state columns and they are not three names for one
 * idea. Collapsing them is what produced a register that disagreed with itself,
 * so they are written down here once, in the words the owner settled on:
 *
 *   `lifecycle`  Is the RECORD current or closed. Two values, Current and
 *                Closed, and nothing else. This is the axis a "close this site"
 *                control moves.
 *
 *   `active`     Is the site OPERATIONALLY ELIGIBLE — may work be assigned to
 *                it, may a customer be sent to it, may a location picker offer
 *                it. A boolean, and deliberately not a synonym for "Current":
 *                a warehouse, an office and a legacy row are all current
 *                records that no one should be dispatched to as a shop.
 *
 *   `status`     A CLASSIFICATION for reporting and for the compatibility
 *                surfaces that still read it — 'active', 'closed',
 *                'international', 'other'. It is not an independent switch: it
 *                may never be edited into a value the other two contradict.
 *
 * WHAT WAS WRONG. `stageZeroState` projected `lifecycle` and `active` out of
 * `status` alone, and `/api/workspace` wrote `lifecycle` from raw request text
 * with no validation at all. Between them a caller could store `lifecycle =
 * 'closed'` (lower case, so it matched no branch) on a row whose `status` still
 * said 'active' — a site the register lists as open and the reporting groups
 * file under Closed. An unvalidated NOT NULL text column is not a state
 * machine.
 *
 * WHY 'other' SURVIVES EVERYTHING. 'other' is the register's way of saying it
 * cannot vouch for a row — a legacy import, an internal location, something
 * that is not an active retail site. No other column records that, so closing
 * such a row must not silently reclassify it to 'closed' and reopening it must
 * not promote it to 'active'. `{ status: 'other', lifecycle: 'Current', active:
 * false }` is therefore a VALID trio and is preserved wherever it is found; it
 * is what an internal or non-retail record looks like. Only an explicit status
 * edit moves a row out of 'other'.
 *
 * NO DATABASE IMPORTS. The Sites form, the Manage-data drawer and both write
 * routes all need these rules, and two of those are client components — so this
 * module is pure, and `app/lib/sites-repository.ts` (which does talk to the
 * database) builds on it rather than the other way round.
 */

export const SITE_LIFECYCLE_CURRENT = "Current";
export const SITE_LIFECYCLE_CLOSED = "Closed";

/**
 * The two lifecycle values, in the order a control should offer them.
 *
 * NOT a configurable list, and that is the point of stating it here rather than
 * inline in a component. Site types and site statuses ARE rows in
 * `option_values` that an admin edits; "is this record current or closed" is
 * structural — the register, the reporting groups and every write path branch
 * on exactly these two words. One home for them means the select a user sees
 * and the validation the route applies cannot drift apart, which is precisely
 * what happened while the drawer held its own copy.
 */
export const SITE_LIFECYCLES = [SITE_LIFECYCLE_CURRENT, SITE_LIFECYCLE_CLOSED] as const;

export type SiteLifecycle = (typeof SITE_LIFECYCLES)[number];

/** The four seeded `site_status` values this module reasons about by name. */
export const SITE_STATUS_ACTIVE = "active";
export const SITE_STATUS_CLOSED = "closed";
export const SITE_STATUS_INTERNATIONAL = "international";
export const SITE_STATUS_OTHER = "other";

export type SiteStateTrio = {
  status: string;
  lifecycle: string;
  active: boolean;
};

/**
 * The canonical spelling of a lifecycle, or null if it is not one.
 *
 * Case is forgiven and then CANONICALISED rather than stored as sent, because
 * "closed" plainly means Closed and writing the lower-case string is the bug
 * this function exists to stop — every branch in the product compares against
 * the capitalised word. Anything that is not one of the two is null, and the
 * caller refuses; it is never coerced to a default, because guessing which
 * lifecycle somebody meant by "Banana" is how a site gets closed by a typo.
 */
export function normaliseSiteLifecycle(value: unknown): SiteLifecycle | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return (
    SITE_LIFECYCLES.find((entry) => entry.toLowerCase() === trimmed) ?? null
  );
}

/** The refusal text for a lifecycle that is not one of the two. */
export function siteLifecycleRefusal() {
  return `A site lifecycle must be one of: ${SITE_LIFECYCLES.join(", ")}.`;
}

/**
 * The lifecycle a status PINS, or null when it pins nothing.
 *
 * 'other' pins nothing on purpose — see the note at the top. It is a
 * classification, not a lifecycle, and an unverifiable row can be either
 * current or closed.
 */
function lifecyclePinnedBy(status: string): SiteLifecycle | null {
  if (status === SITE_STATUS_CLOSED) return SITE_LIFECYCLE_CLOSED;
  if (status === SITE_STATUS_ACTIVE || status === SITE_STATUS_INTERNATIONAL) {
    return SITE_LIFECYCLE_CURRENT;
  }
  return null;
}

/**
 * WHAT "AN ACTIVE SITE" MEANS, ONCE, FOR EVERY SURFACE THAT COUNTS THEM.
 *
 * Exported because the Dashboard's "Active sites" tile, the Sites register and
 * the Reports billing engine all have to answer the same question, and the
 * failure mode when they do not is the one the owner actually hit: a tile
 * reading a number nobody else in the product agrees with.
 *
 * The axis is `status`, not `lifecycle` and not `active`. `lifecycle` says
 * whether the RECORD is current — a legacy row nobody can vouch for is a
 * current record and is not an active site. `active` is operational
 * eligibility, which the reconciliation below derives FROM this answer, so
 * counting it instead would be counting this function's own output one step
 * removed. 'other' is excluded on purpose: it is the classification given to a
 * row the register cannot vouch for, and those must never be billed or counted
 * as trading estate.
 *
 * 'international' counts. It is a trading site under a different commercial
 * arrangement, not a closed one.
 */
export function isActiveSiteStatus(status: string): boolean {
  return status === SITE_STATUS_ACTIVE || status === SITE_STATUS_INTERNATIONAL;
}

/** Whether a status, on its own, implies operational eligibility. */
function eligibilityPinnedBy(status: string): boolean {
  return isActiveSiteStatus(status);
}

/**
 * THE ONE RECONCILIATION. Given what an edit asked for and what is stored,
 * answer with a trio that cannot contradict itself.
 *
 * The invariants it guarantees, which `siteStateContradiction` below checks
 * from the outside:
 *
 *   status 'closed'        => lifecycle Closed  and active false
 *   status 'active'        => lifecycle Current and active true
 *   status 'international' => lifecycle Current and active true
 *   status 'other'         => constrains neither: lifecycle either, and
 *                             eligibility whatever an editor has stated
 *                             (defaulting to false when the status moves there)
 *   lifecycle Closed       => active false
 *
 * NOTHING ASKED, NOTHING MOVED. When an edit carries none of the three — a
 * notes-only save, a rename — the stored trio is returned byte for byte. This
 * is the discipline `preserveUnsent` applies to the payload columns, one layer
 * down: a save that did not mention the state must not repair, promote or close
 * anything. It also means a row that is already inconsistent is left alone
 * until somebody edits the state on purpose, rather than being silently closed
 * by an unrelated save.
 */
export function reconcileSiteState(
  requested: { status?: unknown; lifecycle?: unknown; active?: unknown },
  current: SiteStateTrio,
): SiteStateTrio {
  const askedStatus =
    typeof requested.status === "string" && requested.status.trim()
      ? requested.status.trim()
      : null;
  const askedLifecycle = normaliseSiteLifecycle(requested.lifecycle);
  const askedActive = typeof requested.active === "boolean" ? requested.active : null;

  const statusMoved = askedStatus !== null && askedStatus !== current.status;
  if (!statusMoved && askedLifecycle === null && askedActive === null) {
    return { status: current.status, lifecycle: current.lifecycle, active: current.active };
  }

  const storedLifecycle =
    normaliseSiteLifecycle(current.lifecycle) ?? SITE_LIFECYCLE_CURRENT;
  const status = askedStatus ?? current.status;

  // 1. LIFECYCLE. An explicit one wins; otherwise a status that MOVED and pins
  //    a lifecycle decides; otherwise what is stored is kept.
  const lifecycle =
    askedLifecycle ??
    (statusMoved ? lifecyclePinnedBy(status) : null) ??
    storedLifecycle;

  // 2. STATUS. Reconciled against the lifecycle, with 'other' surviving both
  //    directions because nothing else records "cannot be vouched for".
  const settledStatus =
    status === SITE_STATUS_OTHER
      ? SITE_STATUS_OTHER
      : lifecycle === SITE_LIFECYCLE_CLOSED
        ? SITE_STATUS_CLOSED
        : status === SITE_STATUS_CLOSED
          ? SITE_STATUS_ACTIVE
          : status;

  // 3. ACTIVE. Explicit when stated, otherwise implied by a status that moved,
  //    otherwise kept.
  const proposedActive =
    askedActive ??
    (statusMoved || settledStatus !== current.status
      ? eligibilityPinnedBy(settledStatus)
      : current.active);

  /*
   * ONE THING OUTRANKS AN EXPLICIT `active: true`, and only one: a closed
   * record cannot be dispatched to. That is not an opinion somebody may hold a
   * different view of — it is what closed means, and it is the pair the
   * reporting groups and every `active` filter read together.
   *
   * 'other' deliberately does NOT outrank it. Eligibility for an unverifiable
   * row DEFAULTS to false (see `eligibilityPinnedBy`, which is what a status
   * moving to 'other' answers with), but an authorised editor who ticks Active
   * on an internal location is making a statement about that location and it is
   * honoured. Silently discarding the tick and re-rendering it unticked is the
   * failure mode this whole module exists to remove; a control that does not do
   * what it says is worse than no control. Nothing downstream is put at risk by
   * it either — `listRetailSites` excludes 'other' on the STATUS, so an active
   * 'other' row still never reaches a location picker.
   */
  const active =
    lifecycle === SITE_LIFECYCLE_CLOSED || settledStatus === SITE_STATUS_CLOSED
      ? false
      : proposedActive;

  return { status: settledStatus, lifecycle, active };
}

/**
 * The invariant, checked from the outside — the sentence naming what is wrong,
 * or null when the trio is coherent.
 *
 * Written separately from `reconcileSiteState` on purpose. A reconciliation
 * that is also its own proof proves nothing; this reads a stored row and says
 * whether it obeys the rules, which is what the tests assert and what a repair
 * would key on.
 */
export function siteStateContradiction(state: SiteStateTrio): string | null {
  const lifecycle = normaliseSiteLifecycle(state.lifecycle);
  if (!lifecycle) return `lifecycle "${state.lifecycle}" is not Current or Closed`;
  if (lifecycle === SITE_LIFECYCLE_CLOSED && state.active) {
    return "a closed record cannot be operationally active";
  }
  if (state.status === SITE_STATUS_CLOSED) {
    if (lifecycle !== SITE_LIFECYCLE_CLOSED) return "status 'closed' needs lifecycle Closed";
    if (state.active) return "status 'closed' cannot be active";
  }
  if (state.status === SITE_STATUS_ACTIVE || state.status === SITE_STATUS_INTERNATIONAL) {
    if (lifecycle !== SITE_LIFECYCLE_CURRENT) {
      return `status '${state.status}' needs lifecycle Current`;
    }
    if (!state.active) return `status '${state.status}' must be active`;
  }
  /*
   * There is no rule about 'other' here on purpose. It classifies a row the
   * register cannot vouch for and says nothing about either of the other two
   * axes, so all four of `{ other, Current, false }`, `{ other, Current, true }`,
   * `{ other, Closed, false }` and an explicit eligibility either way are
   * coherent. `{ other, Closed, true }` is refused above, by the closed rule,
   * which is where it belongs.
   */
  return null;
}

/**
 * W05-01 — the bounds a coordinate has to be inside to be a coordinate.
 *
 * `latitude` and `longitude` are real columns that until now only the CSV
 * importer could write, under a different capability, with no range check
 * anywhere. A latitude of 480 is not a place; stored, it is a pin the map
 * silently drops or throws into the sea, and nobody notices a wrong coordinate
 * the way they notice a wrong postcode.
 *
 * Exported as numbers rather than baked into a regex so the form can put them
 * on the input's `min`/`max` and the route can refuse with the same figures.
 */
export const LATITUDE_MIN = -90;
export const LATITUDE_MAX = 90;
export const LONGITUDE_MIN = -180;
export const LONGITUDE_MAX = 180;

/**
 * The refusal for a coordinate that is out of range, or null when both are
 * fine. `null` is a cleared coordinate and is always allowed — a site whose
 * position is unknown is an ordinary thing.
 */
export function coordinateRefusal(
  latitude: number | null,
  longitude: number | null,
): string | null {
  if (latitude !== null && (latitude < LATITUDE_MIN || latitude > LATITUDE_MAX)) {
    return `A latitude must be between ${LATITUDE_MIN} and ${LATITUDE_MAX} degrees.`;
  }
  if (longitude !== null && (longitude < LONGITUDE_MIN || longitude > LONGITUDE_MAX)) {
    return `A longitude must be between ${LONGITUDE_MIN} and ${LONGITUDE_MAX} degrees.`;
  }
  return null;
}
