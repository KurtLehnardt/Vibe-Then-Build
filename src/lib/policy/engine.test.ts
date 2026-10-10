import { describe, expect, it } from "vitest";
import { ACTION_DEFAULTS } from "./defaults";
import { defaultPolicyFor, evaluate, inQuietHours, type OperatorPolicy } from "./engine";
import { ACTION_TYPES, LEVEL } from "./levels";

function policy(over: Partial<OperatorPolicy> = {}): OperatorPolicy {
  return {
    actionType: "email.cold",
    level: LEVEL.AUTONOMOUS,
    enabled: true,
    dailyCap: 40,
    quietHoursStart: null,
    quietHoursEnd: null,
    minIcpScore: null,
    ...over,
  };
}

const base = { killSwitch: false, sentToday: 0, localHour: 12 } as const;

describe("ceilings", () => {
  it("clamps a LinkedIn DM configured as autonomous down to approve-each", () => {
    const r = evaluate({
      ...base,
      actionType: "linkedin.dm",
      policy: policy({ actionType: "linkedin.dm", level: LEVEL.AUTONOMOUS, dailyCap: 20 }),
    });
    expect(r.effectiveLevel).toBe(LEVEL.APPROVE_EACH);
    expect(r.approval).toBe("each");
    expect(r.clamped).toBe(true);
    expect(r.decision).toBe("allowed");
    expect(r.reason).toContain("prohibits software-driven messaging");
  });

  it("caps bid submission at batch approval", () => {
    const r = evaluate({
      ...base,
      actionType: "bid.submit",
      policy: policy({ actionType: "bid.submit", level: LEVEL.AUTONOMOUS, dailyCap: 10 }),
    });
    expect(r.effectiveLevel).toBe(LEVEL.APPROVE_BATCH);
    expect(r.approval).toBe("batch");
  });

  it("lets cold email reach autonomous unclamped", () => {
    const r = evaluate({ ...base, actionType: "email.cold", policy: policy() });
    expect(r.effectiveLevel).toBe(LEVEL.AUTONOMOUS);
    expect(r.approval).toBe("none");
    expect(r.clamped).toBe(false);
  });

  it("never ships any action above its own ceiling", () => {
    for (const action of ACTION_TYPES) {
      const spec = ACTION_DEFAULTS[action];
      expect(spec.shipsAt).toBeLessThanOrEqual(spec.ceiling);
    }
  });
});

describe("hard stops", () => {
  it("blocks everything when the kill switch is engaged", () => {
    const r = evaluate({ ...base, killSwitch: true, actionType: "email.cold", policy: policy() });
    expect(r.decision).toBe("blocked");
    expect(r.reason).toContain("kill switch");
  });

  it("blocks a disabled action", () => {
    const r = evaluate({ ...base, actionType: "email.cold", policy: policy({ enabled: false }) });
    expect(r.decision).toBe("blocked");
  });

  it("blocks a suppressed target", () => {
    const r = evaluate({ ...base, actionType: "email.cold", policy: policy(), suppressed: true });
    expect(r.decision).toBe("blocked");
    expect(r.reason).toContain("suppression");
  });

  it("sends nothing at draft-only", () => {
    const r = evaluate({
      ...base,
      actionType: "email.cold",
      policy: policy({ level: LEVEL.DRAFT_ONLY }),
    });
    expect(r.decision).toBe("blocked");
    expect(r.approval).toBe("forbidden");
  });

  it("reports the kill switch ahead of a cap breach", () => {
    const r = evaluate({
      ...base,
      killSwitch: true,
      sentToday: 999,
      actionType: "email.cold",
      policy: policy(),
    });
    expect(r.reason).toContain("kill switch");
  });
});

describe("deferrals", () => {
  it("defers rather than blocks inside quiet hours", () => {
    const r = evaluate({
      ...base,
      localHour: 23,
      actionType: "email.cold",
      policy: policy({ quietHoursStart: 21, quietHoursEnd: 7 }),
    });
    expect(r.decision).toBe("deferred");
  });

  it("defers once the daily cap is met", () => {
    const r = evaluate({ ...base, sentToday: 40, actionType: "email.cold", policy: policy() });
    expect(r.decision).toBe("deferred");
    expect(r.reason).toContain("Daily cap of 40");
  });

  it("allows an uncapped action at any volume", () => {
    const r = evaluate({
      ...base,
      sentToday: 10_000,
      actionType: "research.enrich",
      policy: policy({ actionType: "research.enrich", dailyCap: null }),
    });
    expect(r.decision).toBe("allowed");
  });
});

describe("ICP floor", () => {
  it("blocks a lead below the floor", () => {
    const r = evaluate({
      ...base,
      actionType: "email.cold",
      policy: policy({ minIcpScore: 70 }),
      leadIcpScore: 45,
    });
    expect(r.decision).toBe("blocked");
    expect(r.reason).toContain("below the floor");
  });

  it("blocks an unscored lead when a floor is set", () => {
    const r = evaluate({
      ...base,
      actionType: "email.cold",
      policy: policy({ minIcpScore: 70 }),
      leadIcpScore: null,
    });
    expect(r.decision).toBe("blocked");
    expect(r.reason).toContain("unscored");
  });

  it("allows a lead at exactly the floor", () => {
    const r = evaluate({
      ...base,
      actionType: "email.cold",
      policy: policy({ minIcpScore: 70 }),
      leadIcpScore: 70,
    });
    expect(r.decision).toBe("allowed");
  });
});

describe("quiet hours window", () => {
  it("handles a window that wraps midnight", () => {
    expect(inQuietHours(22, 21, 7)).toBe(true);
    expect(inQuietHours(3, 21, 7)).toBe(true);
    expect(inQuietHours(7, 21, 7)).toBe(false);
    expect(inQuietHours(12, 21, 7)).toBe(false);
  });

  it("handles a same-day window", () => {
    expect(inQuietHours(13, 12, 14)).toBe(true);
    expect(inQuietHours(14, 12, 14)).toBe(false);
  });

  it("is disabled when either bound is null", () => {
    expect(inQuietHours(3, null, 7)).toBe(false);
    expect(inQuietHours(3, 21, null)).toBe(false);
  });
});

describe("shipped defaults", () => {
  it("starts LinkedIn messaging at draft-only", () => {
    expect(defaultPolicyFor("linkedin.dm").level).toBe(LEVEL.DRAFT_ONLY);
  });

  it("gives every action a non-empty ceiling reason", () => {
    for (const action of ACTION_TYPES) {
      expect(ACTION_DEFAULTS[action].ceilingReason.length).toBeGreaterThan(10);
    }
  });
});
