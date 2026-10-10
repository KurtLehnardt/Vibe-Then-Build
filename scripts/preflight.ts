/**
 * Checks the local stack before first run and prints what is missing, with the
 * exact command to fix each item. Run with: pnpm preflight
 */
export {};

const checks: Array<{ name: string; run: () => Promise<string | null> }> = [
  {
    name: "Postgres reachable",
    run: async () => {
      const url = process.env.DATABASE_URL;
      if (!url) return 'DATABASE_URL is unset. Run: cp .env.example .env';
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 3000 });
      try {
        await pool.query("select 1");
        return null;
      } catch (e) {
        return `Cannot connect to ${url}. Run: docker compose up -d db (${(e as Error).message})`;
      } finally {
        await pool.end();
      }
    },
  },
  {
    name: "Inference gateway reachable",
    run: async () => {
      const url = process.env.LLM_GATEWAY_URL ?? "http://localhost:4000";
      try {
        const res = await fetch(`${url}/health/liveliness`, { signal: AbortSignal.timeout(3000) });
        return res.ok ? null : `Gateway at ${url} returned ${res.status}.`;
      } catch {
        return `No gateway at ${url}. Run: docker compose up -d gateway`;
      }
    },
  },
  {
    name: "Drafting model pulled",
    run: async () => {
      const model = (process.env.MODEL_DRAFTING ?? "ollama/qwen3:14b").replace(/^ollama\//, "");
      try {
        const res = await fetch("http://localhost:11434/api/tags", {
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return `Ollama returned ${res.status}.`;
        const body = (await res.json()) as { models?: Array<{ name: string }> };
        const have = (body.models ?? []).some((m) => m.name.startsWith(model.split(":")[0]!));
        return have ? null : `Model ${model} is not pulled. Run: ollama pull ${model}`;
      } catch {
        return "Ollama is not reachable on :11434. Run: docker compose up -d ollama";
      }
    },
  },
  {
    name: "Kill switch state",
    run: async () =>
      process.env.LOOP_KILL_SWITCH === "true"
        ? "The kill switch is ON, so nothing will send. Set LOOP_KILL_SWITCH=false when ready."
        : null,
  },
];

let failed = 0;
for (const check of checks) {
  const problem = await check.run();
  if (problem) {
    failed++;
    console.log(`  FAIL  ${check.name}\n        ${problem}`);
  } else {
    console.log(`  ok    ${check.name}`);
  }
}

console.log(
  failed === 0
    ? "\nPreflight passed. Start with: pnpm dev"
    : `\n${failed} check(s) need attention before the loop will run.`,
);
process.exit(failed === 0 ? 0 : 1);
