import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gate, localDayWindowUtc, localHourFor, type GateQueries } from "./gate";
import type { OperatorPolicy } from "./engine";
import { LEVEL } from "./levels";

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

/** Builds a full `GateQueries` with inert defaults, overridable per test.
 * `writtenRows` collects every row passed to `writeActionLog` so a test can
 * assert on what actually got written without re-deriving it. */
function makeQueries(over: Partial<GateQueries> = {}) {
  const writtenRows: unknown[] = [];
  let nextId = 1;
  const queries: GateQueries = {
    loadPolicy: vi.fn().mockResolvedValue(policy()),
    loadTimezone: vi.fn().mockResolvedValue("UTC"),
    countSentToday: vi.fn().mockResolvedValue(0),
    writeActionLog: vi.fn().mockImplementation(async (row: unknown) => {
      writtenRows.push(row);
      return `log-${nextId++}`;
    }),
    ...over,
  };
  return { queries, writtenRows };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.LOOP_KILL_SWITCH;
});

describe("decision recording", () => {
  it("writes a row for an allowed decision", async () => {
    const { queries, writtenRows } = makeQueries({
      loadPolicy: vi.fn().mockResolvedValue(policy()),
    });
    const result = await gate({ operatorId: "op-1", actionType: "email.cold" }, queries);

    expect(result.evaluation.decision).toBe("allowed");
    expect(queries.writeActionLog).toHaveBeenCalledTimes(1);
    expect(writtenRows[0]).toMatchObject({
      decision: "allowed",
      reason: result.evaluation.reason,
    });
    expect(result.actionLogId).toBe("log-1");
  });

  it("writes a row for a deferred decision (daily cap met)", async () => {
    const { queries, writtenRows } = makeQueries({
      loadPolicy: vi.fn().mockResolvedValue(policy({ dailyCap: 5 })),
      countSentToday: vi.fn().mockResolvedValue(5),
    });
    const result = await gate({ operatorId: "op-1", actionType: "email.cold" }, queries);

    expect(result.evaluation.decision).toBe("deferred");
    expect(result.evaluation.reason).toContain("Daily cap of 5");
    expect(writtenRows[0]).toMatchObject({ decision: "deferred", reason: result.evaluation.reason });
  });

  it("writes a row for a blocked decision (suppressed target)", async () => {
    const { queries, writtenRows } = makeQueries({
      loadPolicy: vi.fn().mockResolvedValue(policy()),
    });
    const result = await gate(
      { operatorId: "op-1", actionType: "email.cold", lead: { icpScore: 90, suppressed: true } },
      queries,
    );

    expect(result.evaluation.decision).toBe("blocked");
    expect(result.evaluation.reason).toContain("suppression");
    expect(writtenRows[0]).toMatchObject({ decision: "blocked", reason: result.evaluation.reason });
  });

  it("writes two rows for two gated calls rather than upserting one", async () => {
    const { queries, writtenRows } = makeQueries();
    const r1 = await gate({ operatorId: "op-1", actionType: "email.cold" }, queries);
    const r2 = await gate({ operatorId: "op-1", actionType: "email.cold" }, queries);

    expect(queries.writeActionLog).toHaveBeenCalledTimes(2);
    expect(writtenRows).toHaveLength(2);
    expect(r1.actionLogId).not.toBe(r2.actionLogId);
  });
});

describe("kill switch", () => {
  it("blocks and still writes a row when the global kill switch is engaged", async () => {
    process.env.LOOP_KILL_SWITCH = "true";
    const { queries, writtenRows } = makeQueries();

    const result = await gate({ operatorId: "op-1", actionType: "email.cold" }, queries);

    expect(result.evaluation.decision).toBe("blocked");
    expect(result.evaluation.reason).toContain("kill switch");
    expect(queries.writeActionLog).toHaveBeenCalledTimes(1);
    expect(writtenRows[0]).toMatchObject({ decision: "blocked" });
  });
});

describe("default policy fallback", () => {
  it("falls back to the shipped default when no policy row exists, so LinkedIn DM does not send", async () => {
    const { queries } = makeQueries({ loadPolicy: vi.fn().mockResolvedValue(null) });

    const result = await gate({ operatorId: "op-1", actionType: "linkedin.dm" }, queries);

    // The shipped default for linkedin.dm starts at DRAFT_ONLY, so a fresh
    // install with no configured policy must not send.
    expect(result.evaluation.effectiveLevel).toBe(LEVEL.DRAFT_ONLY);
    expect(result.evaluation.approval).toBe("forbidden");
    expect(result.evaluation.decision).toBe("blocked");
  });
});

describe("operator-local day window for sentToday", () => {
  it("computes the local day window, not the UTC one, near local midnight", () => {
    // 2026-10-10T01:30:00Z is 2026-10-09 19:30 in America/Denver (MDT, UTC-6)
    // in October: the UTC calendar day and the local calendar day disagree.
    const instant = new Date("2026-10-10T01:30:00Z");
    const { start, end } = localDayWindowUtc(instant, "America/Denver");

    expect(start.toISOString()).toBe("2026-10-09T06:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-10T06:00:00.000Z");
  });

  it("passes the operator-local day window into countSentToday, not the UTC one", async () => {
    vi.setSystemTime(new Date("2026-10-10T01:30:00Z"));
    const { queries } = makeQueries({
      loadTimezone: vi.fn().mockResolvedValue("America/Denver"),
    });

    await gate({ operatorId: "op-1", actionType: "email.cold" }, queries);

    expect(queries.countSentToday).toHaveBeenCalledWith(
      "op-1",
      "email.cold",
      new Date("2026-10-09T06:00:00.000Z"),
      new Date("2026-10-10T06:00:00.000Z"),
    );
  });
});

describe("operator-local quiet hours", () => {
  it("derives the quiet-hours hour in the operator's time zone, not the server's", async () => {
    // 08:00Z is 02:00 in America/Denver (MDT, UTC-6) in October. A narrow
    // quiet window of 1-3 local only triggers under the correct, zone-aware
    // hour (2); the raw UTC hour (8) falls outside it, so a server-hour bug
    // would wrongly allow this instead of deferring it.
    vi.setSystemTime(new Date("2026-10-10T08:00:00Z"));
    const { queries, writtenRows } = makeQueries({
      loadPolicy: vi.fn().mockResolvedValue(policy({ quietHoursStart: 1, quietHoursEnd: 3 })),
      loadTimezone: vi.fn().mockResolvedValue("America/Denver"),
    });

    const result = await gate({ operatorId: "op-1", actionType: "email.cold" }, queries);

    expect(result.evaluation.decision).toBe("deferred");
    expect(result.evaluation.reason).toContain("local hour 2");
    expect(writtenRows[0]).toMatchObject({ decision: "deferred" });
  });

  it("localHourFor reads the hour from the given time zone regardless of the system zone", () => {
    expect(localHourFor(new Date("2026-10-10T08:00:00Z"), "America/Denver")).toBe(2);
    expect(localHourFor(new Date("2026-10-10T08:00:00Z"), "UTC")).toBe(8);
  });
});

describe("unrecordable actions are denied", () => {
  it("does not proceed when the action_log write fails", async () => {
    const { queries } = makeQueries({
      writeActionLog: vi.fn().mockRejectedValue(new Error("connection terminated")),
    });

    const result = await gate({ operatorId: "op-1", actionType: "email.cold" }, queries);

    expect(result.evaluation.decision).toBe("blocked");
    expect(result.evaluation.reason).toContain("Could not write action_log");
    expect(result.evaluation.reason).toContain("connection terminated");
    expect(result.actionLogId).toBeNull();
  });

  it("still throws when the database itself is unreachable for a read", async () => {
    const { queries } = makeQueries({
      loadPolicy: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });

    await expect(gate({ operatorId: "op-1", actionType: "email.cold" }, queries)).rejects.toThrow(
      /DATABASE_URL/,
    );
  });
});

describe("inference usage on the written row", () => {
  it("records provider, model, token counts and cost when the caller supplies usage", async () => {
    const { queries, writtenRows } = makeQueries();

    await gate(
      {
        operatorId: "op-1",
        actionType: "email.cold",
        usage: { provider: "anthropic", model: "claude-haiku-4.5", tokensIn: 120, tokensOut: 45, costUsd: 0.000312 },
      },
      queries,
    );

    expect(writtenRows[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-haiku-4.5",
      tokensIn: 120,
      tokensOut: 45,
      costUsd: "0.000312",
    });
  });

  it("defaults to null provider/model and zero cost when no usage is supplied", async () => {
    const { queries, writtenRows } = makeQueries();

    await gate({ operatorId: "op-1", actionType: "email.cold" }, queries);

    expect(writtenRows[0]).toMatchObject({
      provider: null,
      model: null,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: "0",
    });
  });
});
