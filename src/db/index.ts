import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

type Database = NodePgDatabase<typeof schema>;

let instance: Database | null = null;

/**
 * Connects on first use rather than on import, so `next build` and the test
 * run do not require a live database. The error, when it comes, names the fix.
 */
export function getDb(): Database {
  if (instance) return instance;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env, then run: docker compose up -d db",
    );
  }

  instance = drizzle(new Pool({ connectionString: url }), { schema });
  return instance;
}

/** Ergonomic handle: `db.select()` resolves the connection at call time. */
export const db: Database = new Proxy({} as Database, {
  get: (_target, prop, receiver) => Reflect.get(getDb(), prop, receiver),
});

export { schema };
