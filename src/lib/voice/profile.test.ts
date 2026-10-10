import { describe, expect, it } from "vitest";
import { buildDraftPrompt, score, selectExamples, type Sample } from "./profile";

const rated = (id: string, impressions: number, reactions: number): Sample => ({
  id,
  body: `post ${id}`,
  impressions,
  reactions,
  comments: 0,
});

describe("score", () => {
  it("computes engagement per thousand impressions", () => {
    expect(score(rated("a", 10_000, 50)).engagementRate).toBe(5);
  });

  it("returns null when impressions are unknown", () => {
    expect(score({ id: "a", body: "x", impressions: null, reactions: 9, comments: 1 }).engagementRate).toBeNull();
  });

  it("returns null rather than dividing by zero", () => {
    expect(score(rated("a", 0, 5)).engagementRate).toBeNull();
  });
});

describe("selectExamples", () => {
  it("ranks rated samples by engagement rate", () => {
    const picked = selectExamples([rated("low", 10_000, 10), rated("high", 1_000, 50)], 2);
    expect(picked.map((p) => p.id)).toEqual(["high", "low"]);
  });

  it("keeps unrated samples instead of discarding them", () => {
    const unrated: Sample = { id: "new", body: "x", impressions: null, reactions: null, comments: null };
    const picked = selectExamples([unrated], 5);
    expect(picked.map((p) => p.id)).toEqual(["new"]);
  });

  it("puts rated samples ahead of unrated ones", () => {
    const unrated: Sample = { id: "new", body: "x", impressions: null, reactions: null, comments: null };
    const picked = selectExamples([unrated, rated("hit", 1_000, 40)], 2);
    expect(picked[0]!.id).toBe("hit");
  });

  it("respects the limit", () => {
    const many = Array.from({ length: 20 }, (_, i) => rated(`p${i}`, 1_000, i));
    expect(selectExamples(many, 3)).toHaveLength(3);
  });
});

describe("buildDraftPrompt", () => {
  it("forbids citing proof when none is verified", () => {
    const { user } = buildDraftPrompt({
      wedgeStatement: null,
      examples: [],
      format: "teardown",
      idea: "claims intake",
      verifiedProof: [],
    });
    expect(user).toContain("cite none");
  });

  it("includes verified proof when present", () => {
    const { user } = buildDraftPrompt({
      wedgeStatement: "I cut claims-intake time for mid-size P&C carriers",
      examples: [],
      format: "teardown",
      idea: "claims intake",
      verifiedProof: ["Cut intake handling from 12 min to 3 min at Acme"],
    });
    expect(user).toContain("12 min to 3 min");
  });

  it("notes the absence of voice examples instead of sending an empty block", () => {
    const { system } = buildDraftPrompt({
      wedgeStatement: null,
      examples: [],
      format: "build_log",
      idea: "x",
      verifiedProof: [],
    });
    expect(system).toContain("No voice examples imported yet");
  });

  it("carries the positioning statement into the system prompt", () => {
    const { system } = buildDraftPrompt({
      wedgeStatement: "P&C claims intake",
      examples: [],
      format: "build_log",
      idea: "x",
      verifiedProof: [],
    });
    expect(system).toContain("P&C claims intake");
  });
});
