import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db, schema } from "../../db";
import { defaultPolicyFor, evaluate, type Decision, type Evaluation, type OperatorPolicy } from "./engine";
import type { ActionType } from "./levels";

/**
 * The gate.
 *
 * `gate()` is the only sanctioned path from "something wants to send" to
 * "something actually sends." It loads the operator's policy, derives the
 * operator-local clock, calls `evaluate()` for the decision, and writes the
 * one `action_log` row that decision produces. Callers never call
 * `evaluate()` directly and never write `action_log` themselves — if they
 * did, the README's claim that every evaluation is recorded would again be
 * false for whatever path skipped this file.
 */

/** Inference usage for the same unit of work the action represents, when the
 * caller already knows it (e.g. a draft was generated before the send was
 * gated). Optional because many actions, like `linkedin.connect`, carry no
 * model cost at all. */
export interface InferenceUsage {
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

/** The subset of a lead row `evaluate()` needs. Omit entirely for actions
 * that do not target a lead (e.g. `bid.submit`, `research.enrich`); supply it
 * whenever one exists so the ICP floor and suppression list are honored. */
export interface GateLead {
  icpScore: number | null;
  suppressed: boolean;
}

export interface GateInput {
  operatorId: string;
  actionType: ActionType;
  subjectId?: string;
  engagementId?: string;
  lead?: GateLead;
  usage?: InferenceUsage;
}

export interface GateResult {
  evaluation: Evaluation;
  /** Id of the action_log row written for this call, or null when the write
   * itself failed — see `queries.writeActionLog` below. A caller that later
   * learns the real inference cost (e.g. after the model call completes)
   * attaches it to this same row rather than writing a second one. */
  actionLogId: string | null;
}

type ActionLogInsert = typeof schema.actionLog.$inferInsert;

/**
 * Injection seam.
 *
 * The test environment has no database, so `gate()` must be testable without
 * one. Two shapes were available: accept an injectable `db` handle, or
 * accept a small set of named query functions. A `db` handle means tests
 * have to fake drizzle's fluent query builder (`.select().from().where()
 * .limit()`, chained in exactly the order production code happens to call
 * it) — that couples tests to call shape, not behavior, and breaks on a
 * harmless refactor of the query itself. Four named functions describe what
 * `gate()` needs in terms of the domain (load a policy, load a timezone,
 * count today's sends, write a log row), so a test supplies a `vi.fn()` per
 * behavior it cares about and the production call site stays a single
 * `gate(input)` call with no handle threaded through. That is the choice
 * made here: `GateQueries`, defaulted to real implementations backed by the
 * shared `db` handle, overridable per call for tests.
 */
export interface GateQueries {
  loadPolicy(operatorId: string, actionType: ActionType): Promise<OperatorPolicy | null>;
  loadTimezone(operatorId: string): Promise<string>;
  /** Count of this action type's `allowed` decisions for this operator with
   * `createdAt` in `[start, end)`. The caller (`gate()`) has already
   * computed `start`/`end` as the operator-local day's UTC boundaries. */
  countSentToday(
    operatorId: string,
    actionType: ActionType,
    start: Date,
    end: Date,
  ): Promise<number>;
  /** Inserts one action_log row and returns its id. Must throw rather than
   * return a sentinel on failure, so `gate()` can tell "wrote a row" from
   * "did not" without inspecting a magic value. */
  writeActionLog(row: ActionLogInsert): Promise<string>;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const defaultQueries: GateQueries = {
  async loadPolicy(operatorId, actionType) {
    const rows = await db
      .select()
      .from(schema.policies)
      .where(and(eq(schema.policies.operatorId, operatorId), eq(schema.policies.actionType, actionType)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      actionType: row.actionType,
      level: row.level,
      enabled: row.enabled,
      dailyCap: row.dailyCap,
      quietHoursStart: row.quietHoursStart,
      quietHoursEnd: row.quietHoursEnd,
      minIcpScore: row.minIcpScore,
    };
  },

  async loadTimezone(operatorId) {
    const rows = await db
      .select({ timezone: schema.operators.timezone })
      .from(schema.operators)
      .where(eq(schema.operators.id, operatorId))
      .limit(1);
    // An operator id that does not resolve (bad caller, a race with a
    // delete) must not crash the gate. UTC is the conservative fallback:
    // quiet hours and the daily cap window are still enforced, just not
    // zone-corrected.
    return rows[0]?.timezone ?? "UTC";
  },

  async countSentToday(operatorId, actionType, start, end) {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.actionLog)
      .where(
        and(
          eq(schema.actionLog.operatorId, operatorId),
          eq(schema.actionLog.actionType, actionType),
          eq(schema.actionLog.decision, "allowed"),
          gte(schema.actionLog.createdAt, start),
          lt(schema.actionLog.createdAt, end),
        ),
      );
    return rows[0]?.count ?? 0;
  },

  async writeActionLog(row) {
    const rows = await db.insert(schema.actionLog).values(row).returning({ id: schema.actionLog.id });
    const id = rows[0]?.id;
    if (!id) {
      throw new Error("action_log insert returned no row.");
    }
    return id;
  },
};

/** Operator-local wall-clock parts of `instant` in `timeZone`, read via
 * `Intl.DateTimeFormat` rather than a date library — the task budget allows
 * no new dependency, and this is the one built-in that knows IANA zone
 * rules. `hour12: false` formats midnight as "24"; normalized to 0 below so
 * it is a valid hour for both `evaluate()` and `Date.UTC`. */
function zonedParts(instant: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(instant);
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) {
      throw new Error(`Intl.DateTimeFormat produced no "${type}" part for time zone "${timeZone}".`);
    }
    return Number(part.value);
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Operator-local hour, 0-23, for the quiet-hours check. Must be derived in
 * the operator's stored time zone rather than the server's, or a server
 * running in UTC would defer every operator's evening sends at the wrong
 * wall-clock moment. */
export function localHourFor(instant: Date, timeZone: string): number {
  return zonedParts(instant, timeZone).hour;
}

/**
 * Start (inclusive) and end (exclusive) of the operator-local calendar day
 * containing `instant`, expressed as UTC instants so they can be compared
 * against `action_log.created_at` directly.
 *
 * "Today" for a daily send cap has to mean the operator's calendar day, not
 * UTC's — otherwise an operator several hours behind UTC has their cap reset
 * mid-afternoon for them, and one ahead of UTC has it reset the previous
 * evening. Both are wrong relative to what "today" means to the person
 * reading the dashboard.
 *
 * Implementation: read `instant`'s wall-clock parts in `timeZone`, diff that
 * against `instant` itself to get the zone's current UTC offset, then apply
 * that same offset to local midnight. This is exact except across a DST
 * transition that falls on the boundary day itself, which is the
 * Intl-only, no-new-dependency budget's acceptable edge.
 */
export function localDayWindowUtc(instant: Date, timeZone: string): { start: Date; end: Date } {
  const p = zonedParts(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offsetMs = asIfUtc - instant.getTime();
  const localMidnightAsIfUtc = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);
  const start = new Date(localMidnightAsIfUtc - offsetMs);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/** Any value other than unset, "", "0" or "false" (case-insensitive) counts
 * as engaged, so "1", "true", or "on" all work without an operator needing
 * to remember one exact spelling for an emergency control. */
function killSwitchEngaged(): boolean {
  const raw = process.env.LOOP_KILL_SWITCH?.trim().toLowerCase();
  if (!raw) return false;
  return raw !== "0" && raw !== "false";
}

/**
 * Gate one outbound action.
 *
 * `queries` defaults to the real database and only needs overriding in
 * tests (see `GateQueries` above). Pass a partial object; anything omitted
 * falls back to the real implementation.
 */
export async function gate(input: GateInput, queries: Partial<GateQueries> = {}): Promise<GateResult> {
  const q: GateQueries = { ...defaultQueries, ...queries };
  const now = new Date();

  let policyRow: OperatorPolicy | null;
  let timezone: string;
  try {
    [policyRow, timezone] = await Promise.all([
      q.loadPolicy(input.operatorId, input.actionType),
      q.loadTimezone(input.operatorId),
    ]);
  } catch (err) {
    // This is the one class of failure gate() is allowed to throw for: the
    // database itself is unreachable, which is a defect to fix, not a
    // decision to record. Name the fix so whoever sees this in a log knows
    // what to do next.
    throw new Error(
      `gate() could not read policy/timezone from the database for operator ${input.operatorId}. ` +
        `Confirm DATABASE_URL is set and the database is reachable (docker compose up -d db). ` +
        `Cause: ${describeError(err)}`,
    );
  }

  // No policy row means a fresh install, or an action type the operator
  // never configured. Falling back to the shipped default rather than
  // failing is what keeps a fresh instance safe instead of broken — and the
  // shipped defaults (see defaults.ts) are conservative, so this fallback
  // denies by default rather than opening a hole.
  const policy = policyRow ?? defaultPolicyFor(input.actionType);

  const { start, end } = localDayWindowUtc(now, timezone);
  let sentToday: number;
  try {
    sentToday = await q.countSentToday(input.operatorId, input.actionType, start, end);
  } catch (err) {
    throw new Error(
      `gate() could not count today's sends from action_log for operator ${input.operatorId}. ` +
        `Confirm DATABASE_URL is set and the database is reachable (docker compose up -d db). ` +
        `Cause: ${describeError(err)}`,
    );
  }

  const evaluation = evaluate({
    actionType: input.actionType,
    policy,
    killSwitch: killSwitchEngaged(),
    sentToday,
    localHour: localHourFor(now, timezone),
    leadIcpScore: input.lead?.icpScore,
    suppressed: input.lead?.suppressed,
  });

  const row: ActionLogInsert = {
    operatorId: input.operatorId,
    actionType: input.actionType,
    subjectId: input.subjectId ?? null,
    engagementId: input.engagementId ?? null,
    effectiveLevel: evaluation.effectiveLevel,
    decision: evaluation.decision,
    reason: evaluation.reason,
    provider: input.usage?.provider ?? null,
    model: input.usage?.model ?? null,
    tokensIn: input.usage?.tokensIn ?? 0,
    tokensOut: input.usage?.tokensOut ?? 0,
    costUsd: input.usage ? String(input.usage.costUsd) : "0",
  };

  try {
    const actionLogId = await q.writeActionLog(row);
    return { evaluation, actionLogId };
  } catch (err) {
    // The action_log row is the only record an operator can ever audit this
    // decision against. An evaluation that cannot be written is, for every
    // practical purpose, an action nobody can account for — so this is not
    // treated as "the database hiccuped, proceed anyway." It is downgraded
    // to blocked (never silently upgraded to allowed) and the reason says
    // why, so a caller surfacing this to a human sees both the original
    // decision and the fact that nothing was recorded for it.
    const d: Decision = "blocked";
    return {
      evaluation: {
        ...evaluation,
        decision: d,
        reason:
          `Could not write action_log; denying rather than sending unrecorded. ` +
          `Evaluation was ${evaluation.decision} (${evaluation.reason}). Write error: ${describeError(err)}`,
      },
      actionLogId: null,
    };
  }
}
