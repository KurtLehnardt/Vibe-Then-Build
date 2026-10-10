/**
 * Seeds one operator with the shipped conservative policy set, so a fresh
 * install is immediately safe to click around in. Idempotent.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index";
import { ACTION_TYPES } from "../src/lib/policy/levels";
import { defaultPolicyFor } from "../src/lib/policy/engine";

const email = process.env.SEED_EMAIL ?? "operator@localhost";
const name = process.env.SEED_NAME ?? "Operator";
const timezone = process.env.OPERATOR_TZ ?? "UTC";

const existing = await db.select().from(schema.operators).where(eq(schema.operators.email, email));

const operator =
  existing[0] ??
  (
    await db.insert(schema.operators).values({ name, email, timezone }).returning()
  )[0]!;

console.log(`operator ${operator.email} (${operator.id})`);

for (const actionType of ACTION_TYPES) {
  const p = defaultPolicyFor(actionType);
  await db
    .insert(schema.policies)
    .values({
      operatorId: operator.id,
      actionType,
      level: p.level,
      dailyCap: p.dailyCap,
      quietHoursStart: p.quietHoursStart,
      quietHoursEnd: p.quietHoursEnd,
      minIcpScore: p.minIcpScore,
      enabled: p.enabled,
    })
    .onConflictDoNothing();
  console.log(`  policy ${actionType} -> level ${p.level}`);
}

await db
  .insert(schema.brandProfiles)
  .values({ operatorId: operator.id })
  .onConflictDoNothing();

console.log("\nSeeded. Nothing is set above level 1, so nothing can send yet.");
process.exit(0);
