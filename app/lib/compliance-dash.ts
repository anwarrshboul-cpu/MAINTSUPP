/**
 * THE COMPLIANCE DASHBOARD BLOCK'S ONE SOURCE OF TRUTH — pure.
 *
 * Every figure on `.cp-dash` — the score donut, the type rings, the countdown
 * rings, the "who's renewing" donut and the sites gauge — is computed here, in
 * one pass over one classified register, from one instant. No widget counts
 * anything of its own.
 *
 * ── WHAT IS REUSED RATHER THAN REDEFINED ──────────────────────────────────
 *
 * The brief's instruction was to reuse the codebase's definitions where they
 * exist and say so. Every one of these already existed:
 *
 *   · the register is `readComplianceRegister` — the Compliance page, the
 *     Overview's compliance KPI and the digest read the same function;
 *   · the five states are `complianceStateFor`, derived from the due date and
 *     the file count against an injected "today" on every read — never stored,
 *     so a certificate flips from Expiring soon to Expired when its day ends,
 *     with no write;
 *   · the SCORE is `complianceCompletion`: Compliant over every requirement
 *     except those marked not required and those whose responsibility is not
 *     confirmed as the client's. That is the Overview's gauge and the Compliance
 *     page's headline, to the requirement;
 *   · the population a drill opens is `isScoredRow`, the same predicate the
 *     register's `?scored=1` filter applies;
 *   · "who chases it" is `responsibilityFor`, as the register's `?who=` filter
 *     reads it;
 *   · the warning window is `EXPIRY_DUE_SOON_DAYS` (60).
 *
 * ── TWO DEFINITIONS THAT DIFFER FROM THE BRIEF, DELIBERATELY ──────────────
 *
 * The brief's warning window is "a config value in Settings (default 90
 * days)". The product's is 60, a named policy constant with its reasoning
 * written beside it, printed from the constant wherever a window is stated. The
 * countdown therefore splits 60 into thirds — 0–20, 21–40, 41–60 — which is
 * exactly the brief's rule ("three equal parts, so they always add up to
 * Expiring soon") applied to the product's window.
 *
 * And the brief says a certificate on file with no due date should be counted
 * as Missing "if there is no rule". There IS a rule, in `complianceStateFor`:
 * a dated slot that holds a file but no date is Expiring soon — the
 * certificate exists and nobody can say it is in date. It stays that way, and
 * the countdown gives those records a fifth ring, "No due date", shown only
 * when it is not zero, so the rings still sum to Expiring soon rather than
 * silently dropping them.
 *
 * Pure: no database, no clock, no React. `node --test` calls it directly.
 */

import type {
  CpCountdownKey,
  CpCountdownRing,
  CpMetrics,
  CpRegisterFilter,
  CpRenewalSlice,
  CpStatusCounts,
  CpStateKey,
  CpTypeRing,
} from "./compliance-dash-contract";
import { complianceCompletion, expiryStatus } from "./compliance-status";
import {
  dueBandToken,
  isScoredRow,
  NO_RESPONSIBILITY,
  type ComplianceRow,
} from "./compliance-view";
import { QUALITY_ARC } from "./dashboard-policy";
import { drillSiteIds } from "./job-metrics";

/**
 * WHETHER THE PRODUCT KNOWS WHICH REQUIREMENTS APPLY TO WHICH SITE TYPE.
 *
 * It does not. The organisation's compliance template
 * (`workspace_settings.settings.complianceTemplate`) holds a requirement's
 * kind, aliases, whether it is enabled and which board slot it maps to — not
 * the site types it applies to — and a board row's Store Type is a label, not
 * a rule. Applicability is recorded per requirement instead, by marking it
 * "Not required", which the score already excludes. The brief's instruction
 * was to report this rather than guess one, so the payload says so.
 */
const SITE_TYPE_APPLICABILITY = "missing" as const;

/* ── Colours: the brief's tokens, restated for a server that cannot read CSS ─ */

export const CP_COLOURS = {
  compliant: "#25D98B",
  expiring: "#FFD447",
  expired: "#FF4D5E",
  missing: "#FF8A3D",
  due30: "#FF8A3D",
  due60: "#FFD447",
  due90: "#38BDF8",
  other: "#64707B",
  teal: "#12B4A8",
  orange: "#FF8A3D",
  amber: "#FFD447",
  blue: "#38BDF8",
} as const;

/** "Default colour order: teal, orange, amber, blue, --cp-missing, then grey." */
const RENEWAL_SERIES = [
  CP_COLOURS.teal,
  CP_COLOURS.orange,
  CP_COLOURS.amber,
  CP_COLOURS.blue,
  // The fifth slice was the old red `missing`; missing is orange now, which
  // would repeat slice two, so the fifth keeps its red through `expired`.
  CP_COLOURS.expired,
] as const;

const STATUS_OF: Record<string, CpStateKey | undefined> = {
  Compliant: "compliant",
  "Expiring soon": "expiring",
  Expired: "expired",
  Missing: "missing",
};

const STATE_OF: Record<CpStateKey, string> = {
  compliant: "Compliant",
  expiring: "Expiring soon",
  expired: "Expired",
  missing: "Missing",
};

const SCORED: CpRegisterFilter = { scored: ["1"] };

function emptyCounts(): CpStatusCounts {
  return { compliant: 0, expiring: 0, expired: 0, missing: 0 };
}

function sumCounts(counts: CpStatusCounts): number {
  return counts.compliant + counts.expiring + counts.expired + counts.missing;
}

function percentOf(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/** Trim, lower-case, collapse runs of whitespace — the shared label normalisation. */
function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The three countdown windows: thirds of the warning window, inclusive.
 * 60 → 0–20, 21–40, 41–60; the brief's 90 would be 0–30, 31–60, 61–90.
 */
export function countdownBands(windowDays: number) {
  const window = Math.max(3, Math.floor(windowDays));
  const first = Math.round(window / 3);
  const second = Math.round((2 * window) / 3);
  return [
    { key: "band-1" as const, label: `0–${first} days`, fromDays: 0, toDays: first },
    { key: "band-2" as const, label: `${first + 1}–${second} days`, fromDays: first + 1, toDays: second },
    { key: "band-3" as const, label: `${second + 1}–${window} days`, fromDays: second + 1, toDays: window },
  ];
}

export type ComplianceDashInput = {
  /** The register's rows for the whole organisation — `complianceRowsFrom`. */
  rows: readonly ComplianceRow[];
  /** The instant the register was classified at. */
  today: Date;
  portfolio: { id: string; name: string; siteIds: string[] | null };
  portfolios: { id: string; name: string }[];
  /** The header picker's due-date range; it does not move the block's figures. */
  range: { from: string | null; to: string | null; label: string };
  /**
   * Sites the Sites page counts as ACTIVE (`status !== "closed"`, the canonical
   * register) within the portfolio — the sites gauge's universe.
   */
  activeSiteIds: readonly string[];
  warningWindowDays: number;
};

export function buildComplianceDashboard(input: ComplianceDashInput): CpMetrics {
  const today = input.today;
  const allowed = input.portfolio.siteIds ? new Set(input.portfolio.siteIds) : null;
  const inScope = input.rows.filter((row) => !allowed || allowed.has(row.siteId));
  const scored = inScope.filter((row) => isScoredRow(row));

  /* ── The score: the product's own rule, over the portfolio ─────────────── */

  const completion = complianceCompletion(inScope);
  const counts = emptyCounts();
  for (const row of scored) {
    const key = STATUS_OF[row.state];
    if (key) counts[key] += 1;
  }
  const scoreFilters: Record<CpStateKey, CpRegisterFilter> = {
    compliant: { ...SCORED, state: [STATE_OF.compliant] },
    expiring: { ...SCORED, state: [STATE_OF.expiring] },
    expired: { ...SCORED, state: [STATE_OF.expired] },
    missing: { ...SCORED, state: [STATE_OF.missing] },
  };

  /* ── Compliance by type ─────────────────────────────────────────────────── */

  const byKind = new Map<string, CpStatusCounts>();
  for (const row of scored) {
    const key = STATUS_OF[row.state];
    if (!key) continue;
    const tally = byKind.get(row.kind) ?? emptyCounts();
    tally[key] += 1;
    byKind.set(row.kind, tally);
  }
  const ranked = [...byKind.entries()]
    .map(([kind, tally]) => ({ kind, tally, total: sumCounts(tally) }))
    .sort(
      (left, right) =>
        percentOf(left.tally.compliant, left.total) - percentOf(right.tally.compliant, right.total) ||
        right.total - left.total ||
        left.kind.localeCompare(right.kind, "en-GB"),
    );
  const typeRing = (kinds: string[], label: string, key: string, tally: CpStatusCounts): CpTypeRing => {
    const total = sumCounts(tally);
    return {
      key,
      label,
      kinds,
      counts: tally,
      total,
      percent: percentOf(tally.compliant, total),
      filter: { ...SCORED, kind: kinds },
      expiredFilter: { ...SCORED, kind: kinds, state: ["Expired"] },
    };
  };
  const shown = ranked.length > 7 ? ranked.slice(0, 7) : ranked;
  const rest = ranked.length > 7 ? ranked.slice(7) : [];
  const types: CpTypeRing[] = shown.map((entry) => typeRing([entry.kind], entry.kind, entry.kind, entry.tally));
  if (rest.length > 0) {
    const tally = emptyCounts();
    for (const entry of rest) {
      tally.compliant += entry.tally.compliant;
      tally.expiring += entry.tally.expiring;
      tally.expired += entry.tally.expired;
      tally.missing += entry.tally.missing;
    }
    types.push(typeRing(rest.map((entry) => entry.kind), "Other types", "__other__", tally));
  }

  /* ── Renewals: Expired, plus everything Expiring soon ───────────────────── */

  const bands = countdownBands(input.warningWindowDays);
  const renewing = scored.filter((row) => row.state === "Expired" || row.state === "Expiring soon");
  const bucket = new Map<CpCountdownKey, number>([
    ["expired", 0],
    ["band-1", 0],
    ["band-2", 0],
    ["band-3", 0],
    ["no-date", 0],
  ]);
  for (const row of renewing) {
    if (row.state === "Expired") {
      bucket.set("expired", (bucket.get("expired") ?? 0) + 1);
      continue;
    }
    const days = expiryStatus(row.expiry, today).daysRemaining;
    if (days === null) {
      bucket.set("no-date", (bucket.get("no-date") ?? 0) + 1);
      continue;
    }
    const band = bands.find((entry) => days >= entry.fromDays && days <= entry.toDays) ?? bands[bands.length - 1];
    bucket.set(band.key, (bucket.get(band.key) ?? 0) + 1);
  }
  const bandColour: Record<string, string> = {
    "band-1": CP_COLOURS.due30,
    "band-2": CP_COLOURS.due60,
    "band-3": CP_COLOURS.due90,
  };
  const rings: CpCountdownRing[] = [
    {
      key: "expired",
      label: "Expired",
      value: bucket.get("expired") ?? 0,
      colour: CP_COLOURS.expired,
      filter: { ...SCORED, state: ["Expired"] },
    },
    ...bands.map((band) => ({
      key: band.key,
      label: band.label,
      value: bucket.get(band.key) ?? 0,
      colour: bandColour[band.key],
      filter: { ...SCORED, due: [dueBandToken(band.fromDays, band.toDays)] },
    })),
  ];
  /* Shown only when it holds something, so the rings always add up to
     Expiring soon without a permanent fifth zero. */
  if ((bucket.get("no-date") ?? 0) > 0) {
    rings.push({
      key: "no-date",
      label: "No due date",
      value: bucket.get("no-date") ?? 0,
      colour: CP_COLOURS.other,
      filter: { ...SCORED, state: ["Expiring soon"], due: ["none"] },
    });
  }

  /*
   * WHO'S RENEWING — by the party the register says chases each certificate.
   *
   * A compliance requirement carries no contractor id: the schema has none on
   * `compliance_documents` and the board slots name a ROLE ("Fire safety
   * partner", "Electrical contractor") or fall back to the site manager. So
   * every renewal is grouped by that text, normalised, and every one of them is
   * counted as unlinked — which is reported, not hidden. Matching the text to a
   * contractor record by name would be linking silently, which the brief rules
   * out.
   */
  const groups = new Map<string, { label: string; raw: Set<string>; value: number }>();
  let unassigned = 0;
  for (const row of renewing) {
    const raw = (row.responsibility ?? "").trim();
    if (!raw) {
      unassigned += 1;
      continue;
    }
    const key = normalise(raw);
    const group = groups.get(key) ?? { label: raw, raw: new Set<string>(), value: 0 };
    group.raw.add(raw);
    group.value += 1;
    groups.set(key, group);
  }
  const renewalRanked = [...groups.entries()].sort(
    (left, right) => right[1].value - left[1].value || left[1].label.localeCompare(right[1].label, "en-GB"),
  );
  const renewalState = { ...SCORED, state: ["Expired", "Expiring soon"] };
  const renewalSlices: CpRenewalSlice[] = renewalRanked.slice(0, 5).map(([key, group], index) => ({
    key,
    label: group.label,
    value: group.value,
    colour: RENEWAL_SERIES[index % RENEWAL_SERIES.length],
    labels: [...group.raw],
    linked: false,
    filter: { ...renewalState, who: [...group.raw] },
  }));
  const tail = renewalRanked.slice(5);
  if (tail.length > 0) {
    const raw = tail.flatMap(([, group]) => [...group.raw]);
    renewalSlices.push({
      key: "__other__",
      label: "Other",
      value: tail.reduce((sum, [, group]) => sum + group.value, 0),
      colour: CP_COLOURS.other,
      labels: raw,
      linked: false,
      filter: { ...renewalState, who: raw },
    });
  }
  if (unassigned > 0) {
    renewalSlices.push({
      key: "__unassigned__",
      label: "Unassigned",
      value: unassigned,
      /* `--cp-other` at 60%, as the brief draws it. */
      colour: `${CP_COLOURS.other}99`,
      labels: [],
      linked: false,
      filter: { ...renewalState, who: [NO_RESPONSIBILITY] },
    });
  }

  /* ── Sites fully compliant ─────────────────────────────────────────────── */

  /*
   * "Active sites with ≥ 1 applicable requirement and zero Expired or Missing ÷
   * those same active sites." Active is the Sites page's own test on the
   * Sites page's own register, so the universe is the one that page counts.
   * A register row not linked to a site record is not a site and cannot be
   * counted here — it still counts in the score, as it does on the Overview.
   */
  const active = new Set(input.activeSiteIds);
  const perSite = new Map<string, { scored: number; failing: number }>();
  for (const row of scored) {
    if (!active.has(row.siteId)) continue;
    const entry = perSite.get(row.siteId) ?? { scored: 0, failing: 0 };
    entry.scored += 1;
    if (row.state === "Expired" || row.state === "Missing") entry.failing += 1;
    perSite.set(row.siteId, entry);
  }
  const consideredIds = [...perSite.keys()];
  const failingIds = consideredIds.filter((id) => (perSite.get(id)?.failing ?? 0) > 0).sort();
  const fullyCompliant = consideredIds.length - failingIds.length;

  const heldWithoutDueDate = scored.filter((row) => row.state === "Expiring soon" && !row.expiry).length;

  const metrics: CpMetrics = {
    generatedAt: today.toISOString(),
    today: today.toISOString().slice(0, 10),
    portfolio: {
      id: input.portfolio.id,
      name: input.portfolio.name,
      /* The drills' copy: an empty scope is `NO_SITE_IN_SCOPE`, not "no
         narrowing", so a figure counted over no sites opens no rows. */
      siteIds: drillSiteIds(input.portfolio.siteIds),
    },
    portfolios: input.portfolios,
    range: input.range,
    policy: {
      warningWindowDays: input.warningWindowDays,
      bands,
      thresholds: { good: QUALITY_ARC.good, warn: QUALITY_ARC.warn },
    },
    score: {
      percent: completion.scored ? completion.percent : 0,
      scored: completion.scored,
      satisfied: completion.satisfied,
      applicable: completion.applicable,
      counts,
      notRequired: completion.notRequired,
      excluded: completion.excluded,
      filters: scoreFilters,
    },
    types,
    typeCount: ranked.length,
    countdown: { rings, total: renewing.length },
    renewals: {
      slices: renewalSlices,
      total: renewing.length,
      unlinked: renewing.length,
      linked: 0,
      allFilter: renewalState,
    },
    sites: {
      fullyCompliant,
      considered: consideredIds.length,
      percent: percentOf(fullyCompliant, consideredIds.length),
      notFullyCompliantIds: failingIds,
      activeSites: active.size,
    },
    dataGaps: {
      heldWithoutDueDate,
      noDueDate: scored.filter((row) => !row.expiry).length,
      unlinkedResponsibility: renewing.length,
      siteTypeApplicability: SITE_TYPE_APPLICABILITY,
    },
    reconciliation: [],
  };
  metrics.reconciliation = reconcileComplianceDashboard(metrics);
  return metrics;
}

/* ── Reconciliation, asserted rather than assumed ─────────────────────────── */

/**
 * The brief's §5.3 identities, as a function the tests and the route both run.
 * Returned as a list of failures rather than thrown — see `reconcile` in
 * `overview-metrics.ts` for why a dashboard draws and says so instead of 500ing.
 */
export function reconcileComplianceDashboard(metrics: CpMetrics): string[] {
  const failures: string[] = [];
  const { score } = metrics;
  const y = sumCounts(score.counts);
  if (y !== score.applicable) failures.push(`status counts ${y} != requirements ${score.applicable}`);
  if (score.counts.compliant !== score.satisfied) {
    failures.push(`compliant ${score.counts.compliant} != on track ${score.satisfied}`);
  }
  const expected = score.applicable > 0 ? Math.round((score.satisfied / score.applicable) * 100) : 0;
  if (score.percent !== expected) failures.push(`score ${score.percent}% != ${expected}%`);

  const typeTotal = metrics.types.reduce((sum, ring) => sum + ring.total, 0);
  const typeCompliant = metrics.types.reduce((sum, ring) => sum + ring.counts.compliant, 0);
  if (typeTotal !== score.applicable) failures.push(`type rings ${typeTotal} != requirements ${score.applicable}`);
  if (typeCompliant !== score.satisfied) failures.push(`type rings compliant ${typeCompliant} != ${score.satisfied}`);

  const ring = (key: string) => metrics.countdown.rings.find((entry) => entry.key === key)?.value ?? 0;
  if (ring("expired") !== score.counts.expired) {
    failures.push(`expired ring ${ring("expired")} != expired ${score.counts.expired}`);
  }
  const windows = ring("band-1") + ring("band-2") + ring("band-3") + ring("no-date");
  if (windows !== score.counts.expiring) {
    failures.push(`countdown windows ${windows} != expiring soon ${score.counts.expiring}`);
  }
  const renewals = metrics.renewals.slices.reduce((sum, slice) => sum + slice.value, 0);
  if (renewals !== score.counts.expired + score.counts.expiring) {
    failures.push(`who's renewing ${renewals} != expired + expiring ${score.counts.expired + score.counts.expiring}`);
  }
  if (metrics.renewals.total !== metrics.countdown.total) {
    failures.push(`renewals ${metrics.renewals.total} != countdown ${metrics.countdown.total}`);
  }
  const { sites } = metrics;
  if (sites.considered > sites.activeSites) failures.push(`sites considered ${sites.considered} > active ${sites.activeSites}`);
  if (sites.fullyCompliant + sites.notFullyCompliantIds.length !== sites.considered) {
    failures.push(`sites ${sites.fullyCompliant} + ${sites.notFullyCompliantIds.length} != ${sites.considered}`);
  }
  return failures;
}
