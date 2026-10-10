import { db, schema } from "@/db";

export const dynamic = "force-dynamic";

export default async function BrandPage() {
  const [profile] = await db.select().from(schema.brandProfiles).limit(1);
  const proof = await db.select().from(schema.proofItems).limit(50);
  const samples = await db.select().from(schema.voiceSamples).limit(1);

  return (
    <main>
      <h1>Brand core</h1>
      <p className="lede">
        The positioning wedge, the ICP record every lead is scored against, and the proof library
        drafting is allowed to cite. Unverified proof may be drafted around but is never presented
        as a number.
      </p>

      <h2>Wedge</h2>
      <div className="notice">
        {profile?.wedgeStatement ?? "No wedge statement set yet. One sentence a stranger can repeat."}
      </div>

      <h2>ICP record</h2>
      <div className="grid">
        <div className="tile">
          <div className="k">Industry</div>
          <div className="v" style={{ fontSize: "1rem" }}>{profile?.icpIndustry ?? "—"}</div>
        </div>
        <div className="tile">
          <div className="k">Role</div>
          <div className="v" style={{ fontSize: "1rem" }}>{profile?.icpRole ?? "—"}</div>
        </div>
        <div className="tile">
          <div className="k">Recurring pain</div>
          <div className="v" style={{ fontSize: "1rem" }}>{profile?.icpPain ?? "—"}</div>
        </div>
        <div className="tile">
          <div className="k">Annual cost of pain</div>
          <div className="v">
            ${Number(profile?.painAnnualCostUsd ?? 0).toLocaleString()}
          </div>
          <div className="n">Under $10k/yr fails the expensive-problem test</div>
        </div>
      </div>

      <h2>Proof library</h2>
      {proof.length === 0 ? (
        <div className="notice">
          No proof recorded. Drafting will decline to cite numbers until something is here.
        </div>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Claim</th>
                <th>Metric</th>
                <th>Value</th>
                <th>Verified</th>
              </tr>
            </thead>
            <tbody>
              {proof.map((p) => (
                <tr key={p.id}>
                  <td>{p.claim}</td>
                  <td className="mono">{p.metric ?? "—"}</td>
                  <td className="mono">{p.value ?? "—"}</td>
                  <td className="mono">{p.verified ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Voice model</h2>
      <div className="notice">
        {samples.length === 0
          ? "No posts imported. Drafting will write plainly until a corpus exists."
          : "Voice examples imported. Drafts select the highest-engagement samples as few-shot examples."}
      </div>
    </main>
  );
}
