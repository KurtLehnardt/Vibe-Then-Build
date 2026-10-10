/**
 * Checks the local stack before first run and prints what is missing, with the
 * exact command to fix each item. Run with: pnpm preflight
 */
export {};

/**
 * A check reports one of three outcomes, and the distinction matters to the
 * reader: null means it passed, a Skipped means the integration is not
 * configured and that is a legitimate state, and a string is a real failure
 * whose text names the command that fixes it. Printing a skip as "ok" would
 * tell an operator that Postiz is reachable when it was never configured.
 */
interface Skipped {
  skipped: string;
}

type CheckResult = string | Skipped | null;

function skip(reason: string): Skipped {
  return { skipped: reason };
}

const checks: Array<{ name: string; run: () => Promise<CheckResult> }> = [
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
  {
    name: "Postiz reachable",
    run: async () => {
      const url = process.env.POSTIZ_URL;
      const key = process.env.POSTIZ_API_KEY;
      if (!url || !key) {
        return skip("POSTIZ_URL or POSTIZ_API_KEY is unset, so publishing is unavailable.");
      }
      try {
        const res = await fetch(`${url}/public/v1/posts`, {
          headers: { Authorization: key },
          signal: AbortSignal.timeout(3000),
        });
        // A rejected key is a configuration failure, not a healthy instance:
        // reporting it as reachable would hide the one problem this check
        // exists to catch. Other 4xx responses mean the endpoint answered,
        // which is all this check needs to prove.
        if (res.status === 401 || res.status === 403) {
          return `Postiz at ${url} rejected the API key (${res.status}). Generate a new one in Postiz under Settings -> Public API and update POSTIZ_API_KEY.`;
        }
        return res.status >= 500
          ? `Postiz at ${url} returned ${res.status}. Run: docker compose up -d postiz`
          : null;
      } catch (e) {
        return `Cannot reach Postiz at ${url}. Run: docker compose up -d postiz (${(e as Error).message})`;
      }
    },
  },
  {
    name: "OpenOutreach export directory",
    run: async () => {
      const dir = process.env.OPENOUTREACH_EXPORT_DIR;
      if (!dir) {
        return skip("OPENOUTREACH_EXPORT_DIR is unset, so lead import is unavailable.");
      }
      const { access } = await import("node:fs/promises");
      try {
        await access(dir);
        return null;
      } catch {
        return `OPENOUTREACH_EXPORT_DIR is set to ${dir}, which does not exist. Run: mkdir -p ${dir}`;
      }
    },
  },
];

let failed = 0;
let skipped = 0;

for (const check of checks) {
  const result = await check.run();

  if (result === null) {
    console.log(`  ok    ${check.name}`);
    continue;
  }

  if (typeof result === "object") {
    skipped++;
    console.log(`  skip  ${check.name}\n        ${result.skipped}`);
    continue;
  }

  failed++;
  console.log(`  FAIL  ${check.name}\n        ${result}`);
}

const tail = skipped > 0 ? ` ${skipped} optional integration(s) not configured.` : "";

console.log(
  failed === 0
    ? `\nPreflight passed. Start with: pnpm dev${tail}`
    : `\n${failed} check(s) need attention before the loop will run.${tail}`,
);

// Skips never fail the run; an unconfigured optional integration is a choice.
process.exit(failed === 0 ? 0 : 1);
