import { db, schema } from "@/db";
import { ACTION_DEFAULTS } from "@/lib/policy/defaults";
import { resolveLevel } from "@/lib/policy/engine";
import { ACTION_TYPES, approvalFor } from "@/lib/policy/levels";

export const dynamic = "force-dynamic";

const LEVEL_NAME = ["Draft only", "Approve each", "Approve batch", "Autonomous"] as const;

export default async function SettingsPage() {
  const rows = await db.select().from(schema.policies);
  const configured = new Map(rows.map((r) => [r.actionType, r]));
  const killSwitch = process.env.LOOP_KILL_SWITCH === "true";

  return (
    <main>
      <h1>Policy</h1>
      <p className="lede">
        Every outbound action is designed to pass through this evaluation before it sends. No
        caller is wired to it yet, so this table shows what each action is configured to do, not
        live enforcement — see the Roadmap. You set the level; the ceiling is what this build will
        not exceed, and each ceiling states its reason.
      </p>

      {killSwitch && (
        <div className="notice">
          <strong>The kill switch is engaged.</strong> No action of any kind can send while
          LOOP_KILL_SWITCH is true, whatever the levels below say.
        </div>
      )}

      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Action</th>
              <th>Set to</th>
              <th>In force</th>
              <th>Approval</th>
              <th>Daily cap</th>
              <th>Ceiling</th>
            </tr>
          </thead>
          <tbody>
            {ACTION_TYPES.map((action) => {
              const spec = ACTION_DEFAULTS[action];
              const row = configured.get(action);
              // No configured row yet: show the shipped default. A row with
              // an invalid stored level is handled by resolveLevel the same
              // way the engine handles it, rather than this page guessing on
              // its own and disagreeing with what actually ships.
              const rawRequested = row ? row.level : spec.shipsAt;
              const { requested, effectiveLevel: effective, clamped } = resolveLevel(
                rawRequested,
                action,
              );
              return (
                <tr key={action}>
                  <td className="mono">{action}</td>
                  <td>
                    <span className={`pill l${requested}`}>{LEVEL_NAME[requested]}</span>
                  </td>
                  <td>
                    {clamped ? (
                      <span className={`pill l${effective}`}>
                        {LEVEL_NAME[effective]} (clamped)
                      </span>
                    ) : (
                      <span className="mono">same</span>
                    )}
                  </td>
                  <td className="mono">{approvalFor(effective)}</td>
                  <td className="mono">{row?.dailyCap ?? spec.defaultDailyCap ?? "none"}</td>
                  <td>{spec.ceilingReason}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
