import { sql } from "drizzle-orm";
import { db } from "@/db";

export async function GET() {
  const checks: Record<string, string> = {};

  try {
    await db.execute(sql`select 1`);
    checks.database = "ok";
  } catch (e) {
    // This endpoint is unauthenticated, so the caller gets a fixed status
    // only. The real error can carry a connection string, host name, or
    // schema detail, and goes to the server log instead. `e` is not
    // guaranteed to be an Error — a thrown non-Error value would itself
    // throw on `.message` — so it is logged as-is rather than cast.
    console.error("Health check: database query failed.", e);
    checks.database = "unreachable";
  }

  const gateway = process.env.LLM_GATEWAY_URL ?? "http://localhost:4000";
  try {
    const res = await fetch(`${gateway}/health/liveliness`, { signal: AbortSignal.timeout(2000) });
    checks.gateway = res.ok ? "ok" : `status ${res.status}`;
  } catch {
    checks.gateway = "unreachable";
  }

  checks.killSwitch = process.env.LOOP_KILL_SWITCH === "true" ? "engaged" : "off";

  const healthy = checks.database === "ok" && checks.gateway === "ok";
  return Response.json({ healthy, checks }, { status: healthy ? 200 : 503 });
}
