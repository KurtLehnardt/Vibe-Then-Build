/**
 * Progress tracking.
 *
 * Six funnel stages plus the money. The point is not the totals but the
 * conversion between adjacent stages: that is what names the broken step.
 */
export interface WeekRow {
  weekStart: Date;
  postsPublished: number;
  impressions: number;
  profileViews: number;
  connectsAccepted: number;
  conversationsStarted: number;
  callsBooked: number;
  callsHeld: number;
  proposalsSent: number;
  dealsWon: number;
  revenueUsd: number;
  inferenceCostUsd: number;
}

export interface Conversion {
  from: string;
  to: string;
  rate: number | null;
}

export const FUNNEL_ORDER = [
  "impressions",
  "profileViews",
  "connectsAccepted",
  "conversationsStarted",
  "callsBooked",
  "callsHeld",
  "proposalsSent",
  "dealsWon",
] as const;

export type FunnelStage = (typeof FUNNEL_ORDER)[number];

/** Null rather than zero when the upstream stage is empty — an undefined
 * conversion is not the same as a zero conversion, and showing 0% for a week
 * with no activity makes a quiet week look like a broken funnel. */
export function conversions(row: WeekRow): Conversion[] {
  const out: Conversion[] = [];
  for (let i = 0; i < FUNNEL_ORDER.length - 1; i++) {
    const from = FUNNEL_ORDER[i]!;
    const to = FUNNEL_ORDER[i + 1]!;
    const upstream = row[from];
    out.push({ from, to, rate: upstream > 0 ? row[to] / upstream : null });
  }
  return out;
}

/**
 * The stage with the worst conversion, which is where to work next.
 *
 * Conversions computed off a handful of events are noise: one proposal that
 * has not closed yet reads as a 0% close rate and would pin this to the bottom
 * of the funnel every week. Stages whose upstream volume is below
 * `minUpstream` are therefore ignored — unless none qualify, in which case all
 * defined conversions are considered rather than reporting nothing at all.
 */
export function weakestStage(row: WeekRow, minUpstream = 10): Conversion | null {
  const defined = conversions(row).filter((c) => c.rate !== null);
  if (defined.length === 0) return null;

  const eligible = defined.filter((c) => row[c.from as FunnelStage] >= minUpstream);
  const pool = eligible.length > 0 ? eligible : defined;
  return pool.reduce((worst, c) => (c.rate! < worst.rate! ? c : worst));
}

export interface MarginSummary {
  revenueUsd: number;
  inferenceCostUsd: number;
  grossMarginUsd: number;
  /** Null when there is no revenue; a ratio against zero says nothing. */
  inferenceCostShare: number | null;
}

export function margin(rows: WeekRow[]): MarginSummary {
  const revenueUsd = sum(rows.map((r) => r.revenueUsd));
  const inferenceCostUsd = sum(rows.map((r) => r.inferenceCostUsd));
  return {
    revenueUsd,
    inferenceCostUsd,
    grossMarginUsd: revenueUsd - inferenceCostUsd,
    inferenceCostShare: revenueUsd > 0 ? inferenceCostUsd / revenueUsd : null,
  };
}

function sum(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0);
}
