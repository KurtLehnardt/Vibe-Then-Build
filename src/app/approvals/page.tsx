import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const pending = await db
    .select()
    .from(schema.drafts)
    .where(eq(schema.drafts.status, "pending_approval"))
    .orderBy(desc(schema.drafts.createdAt))
    .limit(50);

  return (
    <main>
      <h1>Approvals</h1>
      <p className="lede">
        Nothing in this queue has left the instance. This view is read-only for now: there is no
        approve action yet, so a draft cannot be marked ready from here. Once approving exists, it
        will still pass through the policy gate at send time, so an approval alone will never
        bypass a daily cap, quiet hours, or the kill switch.
      </p>

      {pending.length === 0 ? (
        <div className="notice">
          The queue is empty. Drafts appear here once content or outreach generation runs.
        </div>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>Hook</th>
                <th>Body</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((d) => (
                <tr key={d.id}>
                  <td className="mono">{d.actionType}</td>
                  <td>{d.hook ?? "—"}</td>
                  <td>{d.body.slice(0, 140)}{d.body.length > 140 ? "…" : ""}</td>
                  <td className="mono">{d.createdAt.toISOString().slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
