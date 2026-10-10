import { desc } from "drizzle-orm";
import { db, schema } from "@/db";
import { conversions, margin, weakestStage, type WeekRow } from "@/lib/progress/funnel";

export const dynamic = "force-dynamic";

function toRow(r: typeof schema.weeklyMetrics.$inferSelect): WeekRow {
  return {
    weekStart: r.weekStart,
    postsPublished: r.postsPublished,
    impressions: r.impressions,
    profileViews: r.profileViews,
    connectsAccepted: r.connectsAccepted,
    conversationsStarted: r.conversationsStarted,
    callsBooked: r.callsBooked,
    callsHeld: r.callsHeld,
    proposalsSent: r.proposalsSent,
    dealsWon: r.dealsWon,
    revenueUsd: Number(r.revenueUsd),
    inferenceCostUsd: Number(r.inferenceCostUsd),
  };
}

const LABEL: Record<string, string> = {
  impressions: "Impressions",
  profileViews: "Profile views",
  connectsAccepted: "Connects accepted",
  conversationsStarted: "Conversations",
  callsBooked: "Calls booked",
  callsHeld: "Calls held",
  proposalsSent: "Proposals sent",
  dealsWon: "Deals won",
};

export default async function ProgressPage() {
  const raw = await db
    .select()
    .from(schema.weeklyMetrics)
    .orderBy(desc(schema.weeklyMetrics.weekStart))
    .limit(12);

  const rows = raw.map(toRow);
  const latest = rows[0];
  const money = margin(rows);
  const weak = latest ? weakestStage(latest) : null;

  return (
    <main>
      <h1>Progress</h1>
      <p className="lede">
        Outreach, clients, and sales for the last {rows.length || 0} recorded week
        {rows.length === 1 ? "" : "s"}. The conversion between stages is what names the broken
        step, so the weakest one is called out rather than left to be eyeballed.
      </p>

      {!latest ? (
        <div className="notice">
          No weeks recorded yet. Run <strong>pnpm seed</strong>, then log a week from the outreach
          and pipeline tables to populate this view.
        </div>
      ) : (
        <>
          <div className="grid">
            {Object.entries(LABEL).map(([key, label]) => (
              <div className="tile" key={key}>
                <div className="k">{label}</div>
                <div className="v">{latest[key as keyof WeekRow]!.toLocaleString()}</div>
              </div>
            ))}
          </div>

          <h2>Stage conversion, latest week</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>From</th>
                  <th>To</th>
                  <th>Rate</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {conversions(latest).map((c) => (
                  <tr key={`${c.from}-${c.to}`}>
                    <td>{LABEL[c.from]}</td>
                    <td>{LABEL[c.to]}</td>
                    <td className="mono">
                      {c.rate === null ? "—" : `${(c.rate * 100).toFixed(1)}%`}
                    </td>
                    <td>
                      {c.rate === null
                        ? "No upstream activity, so this rate is undefined."
                        : weak && weak.from === c.from
                          ? "Weakest stage. Work here first."
                          : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2>Money</h2>
          <div className="grid">
            <div className="tile">
              <div className="k">Revenue</div>
              <div className="v">${money.revenueUsd.toLocaleString()}</div>
              <div className="n">Across the weeks shown</div>
            </div>
            <div className="tile">
              <div className="k">Inference cost</div>
              <div className="v">${money.inferenceCostUsd.toFixed(2)}</div>
              <div className="n">Zero while running fully local</div>
            </div>
            <div className="tile">
              <div className="k">Gross margin</div>
              <div className="v">${money.grossMarginUsd.toLocaleString()}</div>
              <div className="n">Revenue less inference</div>
            </div>
            <div className="tile">
              <div className="k">Cost share</div>
              <div className="v">
                {money.inferenceCostShare === null
                  ? "—"
                  : `${(money.inferenceCostShare * 100).toFixed(2)}%`}
              </div>
              <div className="n">Inference as a share of revenue</div>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
