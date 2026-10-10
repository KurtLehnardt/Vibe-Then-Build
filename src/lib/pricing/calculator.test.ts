import { describe, expect, it } from "vitest";
import { annualValue, priceBand, type ValueInputs } from "./calculator";

const claimsIntake: ValueInputs = {
  monthlyVolume: 800,
  minutesPerRun: 12,
  loadedHourlyRate: 45,
  automationShare: 0.7,
  annualErrorCostAvoided: 30_000,
  annualRevenueUnlocked: 0,
};

describe("annualValue", () => {
  it("converts volume and handling time into recoverable labor", () => {
    // 800 x 12 min x 12 months = 1920 hours; x $45 x 0.7 = $60,480
    const { laborSavings } = annualValue(claimsIntake);
    expect(laborSavings).toBe(60_480);
  });

  it("adds error and revenue effects to labor savings", () => {
    const { total } = annualValue(claimsIntake);
    expect(total).toBe(90_480);
  });

  it("clamps an automation share above 1 instead of inflating value", () => {
    const { laborSavings } = annualValue({ ...claimsIntake, automationShare: 1.5 });
    expect(laborSavings).toBe(86_400);
  });

  it("returns zero labor savings when nothing is automated", () => {
    const { laborSavings } = annualValue({ ...claimsIntake, automationShare: 0 });
    expect(laborSavings).toBe(0);
  });
});

describe("priceBand", () => {
  it("prices inside the capture band when value supports it", () => {
    const band = priceBand(claimsIntake, { deliveryCostUsd: 4_000 });
    expect(band.lowUsd).toBe(9_048);
    expect(band.highUsd).toBe(18_096);
    expect(band.floorUsd).toBe(14_000);
    expect(band.belowFloor).toBe(false);
  });

  it("lifts the quote to the margin floor when the band's low end is under it", () => {
    const band = priceBand(claimsIntake, { deliveryCostUsd: 4_000 });
    // Band low is 9,048 but the floor is 14,000, so the floor is what you quote.
    expect(band.recommendedUsd).toBe(14_000);
  });

  it("flags a deal whose entire band sits under the floor", () => {
    const band = priceBand(claimsIntake, { deliveryCostUsd: 30_000 });
    expect(band.belowFloor).toBe(true);
    expect(band.rationale).toContain("decline the work");
  });

  it("honors a custom capture band and floor multiple", () => {
    const band = priceBand(claimsIntake, {
      deliveryCostUsd: 4_000,
      captureLow: 0.25,
      captureHigh: 0.4,
      marginFloorMultiple: 2,
    });
    expect(band.lowUsd).toBe(22_620);
    expect(band.floorUsd).toBe(8_000);
    expect(band.recommendedUsd).toBe(22_620);
  });

  it("explains itself in terms a client would recognize", () => {
    const band = priceBand(claimsIntake, { deliveryCostUsd: 4_000 });
    expect(band.rationale).toContain("$60,480");
    expect(band.rationale).toContain("10%");
  });
});
