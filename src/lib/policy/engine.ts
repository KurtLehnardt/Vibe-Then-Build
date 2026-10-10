import { ACTION_DEFAULTS } from "./defaults";
import {
  approvalFor,
  isLevel,
  LEVEL,
  type ActionType,
  type ApprovalRequirement,
  type Level,
} from "./levels";

export interface OperatorPolicy {
  actionType: ActionType;
  /** What the operator asked for. Clamped to the action's ceiling. */
  level: number;
  enabled: boolean;
  dailyCap: number | null;
  /** Local hour, 0-23, inclusive start and exclusive end. Null disables. */
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  /** Minimum ICP fit score a lead must carry. Null disables. */
  minIcpScore: number | null;
}

export interface EvaluateInput {
  actionType: ActionType;
  policy: OperatorPolicy;
  /** True when the global kill switch is set. Overrides everything. */
  killSwitch: boolean;
  /** Sends of this action type already completed today. */
  sentToday: number;
  /** Operator-local hour, 0-23. */
  localHour: number;
  /** ICP score of the target, when the action targets a lead. */
  leadIcpScore?: number | null;
  /** True when the target is on the suppression list. */
  suppressed?: boolean;
}

export type Decision = "allowed" | "blocked" | "deferred";

export interface Evaluation {
  decision: Decision;
  /** Level actually in force after clamping to the ceiling. */
  effectiveLevel: Level;
  /** What the caller must do before sending. */
  approval: ApprovalRequirement;
  /** Always populated, including on allow, so the action log reads cleanly. */
  reason: string;
  /** True when the operator's configured level was reduced by the ceiling. */
  clamped: boolean;
}

export interface LevelResolution {
  /** The requested level, with invalid input (non-integer or out of 0-3) coerced to draft-only. */
  requested: Level;
  /** The level actually in force, after clamping the (coerced) request to the action's ceiling. */
  effectiveLevel: Level;
  /** True when the ceiling reduced the coerced requested level. */
  clamped: boolean;
}

/**
 * Resolves the level actually in force for an action. This is the one
 * implementation of "clamp the requested level to its ceiling" in the
 * codebase — the settings page and this engine both call it, rather than
 * each re-implementing `Math.min(requested, ceiling)` and risking disagreeing
 * on how an invalid level is handled. An invalid requested level (not an
 * integer 0-3) is coerced to draft-only rather than guessed at, exactly as
 * an unparseable autonomy setting should be treated: refuse to send rather
 * than pick a level nobody asked for.
 */
export function resolveLevel(requestedLevel: number, actionType: ActionType): LevelResolution {
  const spec = ACTION_DEFAULTS[actionType];
  const requested = isLevel(requestedLevel) ? requestedLevel : LEVEL.DRAFT_ONLY;
  const effectiveLevel = Math.min(requested, spec.ceiling) as Level;
  return { requested, effectiveLevel, clamped: effectiveLevel < requested };
}

/**
 * The single gate every outbound action passes through.
 *
 * Checks run in order of severity so the recorded reason names the most
 * serious cause rather than the first one encountered: kill switch, channel
 * disabled, suppression, draft-only level, ICP floor, then the two
 * deferrals (quiet hours, daily cap). The ICP floor runs ahead of the
 * deferrals because a floor failure is permanent — the lead will never pass
 * it — while quiet hours and a met daily cap both clear on their own. Reporting
 * a permanent block as a deferral would have the caller retry a lead forever
 * that can never go out.
 *
 * A "deferred" decision means the action is permitted but not right now —
 * the caller should reschedule rather than drop it. "blocked" means drop.
 */
export function evaluate(input: EvaluateInput): Evaluation {
  const spec = ACTION_DEFAULTS[input.actionType];
  const { requested, effectiveLevel, clamped } = resolveLevel(input.policy.level, input.actionType);
  const approval = approvalFor(effectiveLevel);

  const base = { effectiveLevel, approval, clamped };

  if (input.killSwitch) {
    return { ...base, decision: "blocked", reason: "Global kill switch is engaged." };
  }

  if (!input.policy.enabled) {
    return {
      ...base,
      decision: "blocked",
      reason: `Action ${input.actionType} is disabled in settings.`,
    };
  }

  if (input.suppressed) {
    return { ...base, decision: "blocked", reason: "Target is on the suppression list." };
  }

  if (effectiveLevel === LEVEL.DRAFT_ONLY) {
    return {
      ...base,
      decision: "blocked",
      reason: clamped
        ? `Draft only. Level ${requested} was clamped to ${effectiveLevel}: ${spec.ceilingReason}`
        : "Draft only. Nothing sends at level 0.",
    };
  }

  // The ICP floor is checked ahead of quiet hours and the daily cap even
  // though those two are written first in the day's events, because a floor
  // failure is a block, not a deferral: this target will never clear the
  // floor on its own. Quiet hours and a met cap are both deferrals that
  // clear with time. Checking the deferrals first would report a
  // permanently ineligible lead as "try again later" and retry it forever.
  if (
    input.policy.minIcpScore !== null &&
    (input.leadIcpScore === null || input.leadIcpScore === undefined)
  ) {
    return {
      ...base,
      decision: "blocked",
      reason: `An ICP score floor of ${input.policy.minIcpScore} is set, but this target is unscored.`,
    };
  }

  if (
    input.policy.minIcpScore !== null &&
    input.leadIcpScore !== null &&
    input.leadIcpScore !== undefined &&
    input.leadIcpScore < input.policy.minIcpScore
  ) {
    return {
      ...base,
      decision: "blocked",
      reason: `ICP score ${input.leadIcpScore} is below the floor of ${input.policy.minIcpScore}.`,
    };
  }

  if (inQuietHours(input.localHour, input.policy.quietHoursStart, input.policy.quietHoursEnd)) {
    return {
      ...base,
      decision: "deferred",
      reason: `Quiet hours are in effect at local hour ${input.localHour}.`,
    };
  }

  if (input.policy.dailyCap !== null && input.sentToday >= input.policy.dailyCap) {
    return {
      ...base,
      decision: "deferred",
      reason: `Daily cap of ${input.policy.dailyCap} for ${input.actionType} is already met.`,
    };
  }

  return {
    ...base,
    decision: "allowed",
    reason: clamped
      ? `Allowed at level ${effectiveLevel} (requested ${requested}, clamped: ${spec.ceilingReason})`
      : `Allowed at level ${effectiveLevel}.`,
  };
}

/** Handles windows that wrap midnight, e.g. 21 to 7. */
export function inQuietHours(hour: number, start: number | null, end: number | null): boolean {
  if (start === null || end === null) return false;
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** The policy row a fresh install gets for an action. */
export function defaultPolicyFor(actionType: ActionType): OperatorPolicy {
  const spec = ACTION_DEFAULTS[actionType];
  return {
    actionType,
    level: spec.shipsAt,
    enabled: true,
    dailyCap: spec.defaultDailyCap,
    quietHoursStart: 21,
    quietHoursEnd: 7,
    minIcpScore: null,
  };
}
