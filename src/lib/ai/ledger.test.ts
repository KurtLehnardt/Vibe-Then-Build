import { describe, expect, it } from "vitest";
import { costUsd, LOCAL_RATE, rateFor } from "./ledger";

describe("costUsd", () => {
  it("prices local inference at zero", () => {
    expect(costUsd(500_000, 200_000, LOCAL_RATE)).toBe(0);
  });

  it("prices input and output separately", () => {
    const rate = { inPerMillion: 3, outPerMillion: 15 };
    expect(costUsd(1_000_000, 1_000_000, rate)).toBe(18);
  });

  it("rounds to the six decimals the column stores", () => {
    const rate = { inPerMillion: 3, outPerMillion: 15 };
    expect(costUsd(1, 1, rate)).toBe(0.000018);
  });

  it("returns zero for an empty call", () => {
    expect(costUsd(0, 0, { inPerMillion: 3, outPerMillion: 15 })).toBe(0);
  });
});

describe("rateFor", () => {
  it("always prices ollama at zero, even if a rate is configured", () => {
    expect(rateFor("ollama", { ollama: { inPerMillion: 9, outPerMillion: 9 } })).toEqual(LOCAL_RATE);
  });

  it("falls back to zero for an unknown provider rather than guessing", () => {
    expect(rateFor("anthropic", {})).toEqual(LOCAL_RATE);
  });
});
