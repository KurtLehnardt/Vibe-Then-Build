/**
 * Autonomy levels.
 *
 * Every outbound action in Vibe Then Build is configured at one of these levels.
 * The operator chooses the level; the ceiling in `defaults.ts` is what the
 * published build refuses to exceed, and each ceiling has a stated reason.
 */
export const LEVEL = {
  /** The system writes; nothing leaves the instance. */
  DRAFT_ONLY: 0,
  /** Reviewed one at a time before each send. */
  APPROVE_EACH: 1,
  /** A whole queue approved in one pass, then executed on schedule. */
  APPROVE_BATCH: 2,
  /** Sends unattended inside the configured guardrails. */
  AUTONOMOUS: 3,
} as const;

export type Level = (typeof LEVEL)[keyof typeof LEVEL];

export const ACTION_TYPES = [
  "linkedin.connect",
  "linkedin.dm",
  "linkedin.post",
  "email.cold",
  "email.followup",
  "bid.submit",
  "research.enrich",
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

/** What a caller must do before the action may actually send. */
export type ApprovalRequirement = "none" | "each" | "batch" | "forbidden";

export function approvalFor(level: Level): ApprovalRequirement {
  switch (level) {
    case LEVEL.DRAFT_ONLY:
      return "forbidden";
    case LEVEL.APPROVE_EACH:
      return "each";
    case LEVEL.APPROVE_BATCH:
      return "batch";
    case LEVEL.AUTONOMOUS:
      return "none";
  }
}

export function isLevel(n: number): n is Level {
  return n === 0 || n === 1 || n === 2 || n === 3;
}
