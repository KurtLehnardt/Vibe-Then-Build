import { desc } from "drizzle-orm";
import { db, schema } from "@/db";

export const dynamic = "force-dynamic";

const STAGES = ["qualified", "discovery_held", "proposal_sent", "verbal", "won", "lost"] as const;

export default async function PipelinePage() {
  const deals = await db
    .select()
    .from(schema.deals)
    .orderBy(desc(schema.deals.createdAt))
    .limit(100);

  const byStage = STAGES.map((stage) => ({
    stage,
    deals: deals.filter((d) => d.stage === stage),
  }));

  return (
    <main>
      <h1>Pipeline</h1>
      <p className="lede">
        Deals with their pricing inputs attached, so a quote can always be re-derived rather than
        remembered. A deal quoted under its own margin floor is flagged here, not at invoice time.
      </p>

      <div className="grid">
        {byStage.map(({ stage, deals: d }) => (
          <div className="tile" key={stage}>
            <div className="k">{stage.replace("_", " ")}</div>
            <div className="v">{d.length}</div>
            <div className="n">
              $
              {d
                .reduce((sum, x) => sum + Number(x.priceQuotedUsd ?? 0), 0)
                .toLocaleString()}{" "}
              quoted
            </div>
          </div>
        ))}
      </div>

      <h2>Deals</h2>
      {deals.length === 0 ? (
        <div className="notice">No deals yet. Deals are created from booked calls.</div>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Deal</th>
                <th>Tier</th>
                <th>Stage</th>
                <th>Annual value</th>
                <th>Quoted</th>
                <th>Floor</th>
                <th>Check</th>
              </tr>
            </thead>
            <tbody>
              {deals.map((d) => {
                const quoted = Number(d.priceQuotedUsd ?? 0);
                const floor = Number(d.priceFloorUsd ?? 0);
                const under = quoted > 0 && floor > 0 && quoted < floor;
                return (
                  <tr key={d.id}>
                    <td>{d.title}</td>
                    <td className="mono">{d.tier}</td>
                    <td className="mono">{d.stage}</td>
                    <td className="mono">${Number(d.annualValueUsd ?? 0).toLocaleString()}</td>
                    <td className="mono">${quoted.toLocaleString()}</td>
                    <td className="mono">${floor.toLocaleString()}</td>
                    <td>{under ? "Below margin floor" : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
