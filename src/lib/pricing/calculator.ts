/**
 * Value-based pricing, as code.
 *
 * The rule the calculator encodes: price a build at a share of the value it
 * creates in its first year, and never below a multiple of what it costs you
 * to deliver. When those two disagree, the floor wins and the deal is flagged
 * rather than silently underpriced.
 */
export interface ValueInputs {
  /** Times the process runs per month. */
  monthlyVolume: number;
  /** Minutes of human handling per run, today. */
  minutesPerRun: number;
  /** Fully loaded hourly cost of the person doing it, in dollars. */
  loadedHourlyRate: number;
  /** Share of handling time the system removes, 0 to 1. */
  automationShare: number;
  /** Annual cost of errors and rework the system prevents, in dollars. */
  annualErrorCostAvoided: number;
  /** Annual revenue the system unlocks, in dollars. Often zero; that is fine. */
  annualRevenueUnlocked: number;
}

export interface PriceInputs {
  /** Your own cost to deliver: hours times internal rate, plus subcontractors. */
  deliveryCostUsd: number;
  /** Share of year-one value to capture. Defaults to the 10-20% band. */
  captureLow?: number;
  captureHigh?: number;
  /** Minimum multiple of delivery cost. Below this, do not take the work. */
  marginFloorMultiple?: number;
}

export interface PriceBand {
  annualValueUsd: number;
  laborSavingsUsd: number;
  lowUsd: number;
  highUsd: number;
  floorUsd: number;
  /** The number to quote: the band's low end, lifted to the floor if needed. */
  recommendedUsd: number;
  /** True when year-one value cannot support the margin floor. */
  belowFloor: boolean;
  /** Plain-language explanation, suitable for pasting into a proposal. */
  rationale: string;
}

export const DEFAULTS = {
  captureLow: 0.1,
  captureHigh: 0.2,
  marginFloorMultiple: 3.5,
} as const;

export function annualValue(v: ValueInputs): { total: number; laborSavings: number } {
  const hoursPerYear = (v.monthlyVolume * v.minutesPerRun * 12) / 60;
  const laborSavings = hoursPerYear * v.loadedHourlyRate * clamp01(v.automationShare);
  const total = laborSavings + v.annualErrorCostAvoided + v.annualRevenueUnlocked;
  return { total: round2(total), laborSavings: round2(laborSavings) };
}

export function priceBand(v: ValueInputs, p: PriceInputs): PriceBand {
  const captureLow = p.captureLow ?? DEFAULTS.captureLow;
  const captureHigh = p.captureHigh ?? DEFAULTS.captureHigh;
  const floorMultiple = p.marginFloorMultiple ?? DEFAULTS.marginFloorMultiple;

  const { total, laborSavings } = annualValue(v);
  const lowUsd = round2(total * captureLow);
  const highUsd = round2(total * captureHigh);
  const floorUsd = round2(p.deliveryCostUsd * floorMultiple);

  const belowFloor = highUsd < floorUsd;
  const recommendedUsd = round2(Math.max(lowUsd, floorUsd));

  const rationale = belowFloor
    ? `Year-one value of ${usd(total)} cannot support a price of ${usd(floorUsd)}, which is ` +
      `${floorMultiple}x your delivery cost of ${usd(p.deliveryCostUsd)}. Narrow the scope, ` +
      `find more value, or decline the work.`
    : `The process consumes ${usd(laborSavings)} of recoverable labor per year. With error ` +
      `and revenue effects, year-one value is ${usd(total)}. Capturing ${pct(captureLow)} to ` +
      `${pct(captureHigh)} puts the price between ${usd(lowUsd)} and ${usd(highUsd)}, against ` +
      `a floor of ${usd(floorUsd)}.`;

  return { annualValueUsd: total, laborSavingsUsd: laborSavings, lowUsd, highUsd, floorUsd, recommendedUsd, belowFloor, rationale };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function usd(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
