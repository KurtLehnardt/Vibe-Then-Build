import { db, schema } from "@/db";
import { ACTION_DEFAULTS } from "@/lib/policy/defaults";
import { ACTION_TYPES, approvalFor, isLevel, type Level } from "@/lib/policy/levels";

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
        Every outbound action passes through this table before it sends. You set the level; the
        ceiling is what this build will not exceed, and each ceiling states its reason.
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
              const requested = row && isLevel(row.level) ? row.level : spec.shipsAt;
              const effective = Math.min(requested, spec.ceiling) as Level;
              const clamped = effective < requested;
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
