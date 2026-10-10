import { describe, expect, it } from "vitest";
import { conversions, margin, weakestStage, type WeekRow } from "./funnel";

function week(over: Partial<WeekRow> = {}): WeekRow {
  return {
    weekStart: new Date("2026-11-03T00:00:00Z"),
    postsPublished: 5,
    impressions: 12_000,
    profileViews: 240,
    connectsAccepted: 36,
    conversationsStarted: 12,
    callsBooked: 3,
    callsHeld: 2,
    proposalsSent: 1,
    dealsWon: 0,
    revenueUsd: 0,
    inferenceCostUsd: 0,
    ...over,
  };
}

describe("conversions", () => {
  it("computes each adjacent stage rate", () => {
    const c = conversions(week());
    expect(c[0]).toEqual({ from: "impressions", to: "profileViews", rate: 0.02 });
    expect(c.find((x) => x.to === "callsHeld")?.rate).toBeCloseTo(2 / 3);
  });

  it("returns null, not zero, when the upstream stage is empty", () => {
    const c = conversions(week({ impressions: 0, profileViews: 0 }));
    expect(c[0]!.rate).toBeNull();
  });
});

describe("weakestStage", () => {
  it("names the worst conversion with enough volume behind it", () => {
    // proposalsSent -> dealsWon is 0%, but off a single proposal; the
    // impressions -> profileViews rate of 2% is the real weak point.
    const w = weakestStage(week());
    expect(w?.from).toBe("impressions");
  });

  it("ignores a stage whose upstream volume is too small to mean anything", () => {
    const w = weakestStage(week({ proposalsSent: 1, dealsWon: 0 }));
    expect(w?.from).not.toBe("proposalsSent");
  });

  it("considers low-volume stages when nothing clears the threshold", () => {
    const tiny = week({
      impressions: 4,
      profileViews: 2,
      connectsAccepted: 1,
      conversationsStarted: 1,
      callsBooked: 1,
      callsHeld: 1,
      proposalsSent: 1,
      dealsWon: 1,
    });
    expect(weakestStage(tiny)?.from).toBe("impressions");
  });

  it("honors a custom minimum upstream volume", () => {
    const w = weakestStage(week(), 100_000);
    expect(w).not.toBeNull();
  });

  it("ignores undefined conversions when choosing", () => {
    const w = weakestStage(week({ impressions: 0, profileViews: 0 }));
    expect(w?.from).not.toBe("impressions");
  });

  it("returns null for a completely empty week", () => {
    const empty = week({
      impressions: 0,
      profileViews: 0,
      connectsAccepted: 0,
      conversationsStarted: 0,
      callsBooked: 0,
      callsHeld: 0,
      proposalsSent: 0,
      dealsWon: 0,
    });
    expect(weakestStage(empty)).toBeNull();
  });
});

describe("margin", () => {
  it("sums revenue and inference cost across weeks", () => {
    const m = margin([
      week({ revenueUsd: 18_000, inferenceCostUsd: 2.4 }),
      week({ revenueUsd: 7_500, inferenceCostUsd: 1.1 }),
    ]);
    expect(m.revenueUsd).toBe(25_500);
    expect(m.inferenceCostUsd).toBeCloseTo(3.5);
    expect(m.grossMarginUsd).toBeCloseTo(25_496.5);
  });

  it("reports no cost share when there is no revenue", () => {
    expect(margin([week({ inferenceCostUsd: 5 })]).inferenceCostShare).toBeNull();
  });

  it("is zero-cost when running fully local", () => {
    const m = margin([week({ revenueUsd: 18_000, inferenceCostUsd: 0 })]);
    expect(m.inferenceCostShare).toBe(0);
    expect(m.grossMarginUsd).toBe(18_000);
  });
});
