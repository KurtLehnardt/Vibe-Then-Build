/**
 * Checks the local stack before first run and prints what is missing, with the
 * exact command to fix each item. Run with: pnpm preflight
 */
export {};

import { buildRegistry } from "../src/lib/channels/registry";
import type { ChannelId } from "../src/lib/channels/types";

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

// Display name only — every other fact about an adapter (how it's probed,
// what counts as healthy) lives in the adapter's own health(), not here.
const ADAPTER_LABELS: Partial<Record<ChannelId, string>> = {
  postiz: "Postiz",
  openoutreach: "OpenOutreach",
};

function labelFor(id: ChannelId): string {
  return ADAPTER_LABELS[id] ?? id;
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
];

// Integration checks come from the registry itself rather than a bespoke
// probe per integration. preflight used to re-implement "is Postiz reachable"
// and "is the OpenOutreach export dir usable" on its own, and that copy
// disagreed with the adapters' own health() — different endpoints, different
// pass/fail thresholds. Asking the registry means there is exactly one
// implementation of "is this integration healthy," and preflight and the
// running system always agree on the answer.
//
// Building the registry and collecting its reports is wrapped because preflight
// is the tool an operator reaches for when something is already wrong. A bug in
// an adapter's constructor must not answer that with a stack trace and no check
// list: the Postgres and gateway results are exactly what the operator came for,
// and they are still worth printing when an integration cannot even be built.
try {
  const registry = buildRegistry(process.env);

  for (const unavailable of registry.unavailable) {
    checks.push({
      name: `${labelFor(unavailable.id)} reachable`,
      run: async () => skip(unavailable.reason),
    });
  }

  // One registry.health() call covers every available adapter, including the
  // per-adapter timeout the registry itself enforces — preflight does not
  // re-implement that, either.
  const healthReports = await registry.health();

  for (const { id, report } of healthReports) {
    checks.push({
      name: `${labelFor(id)} reachable`,
      run: async () => (report.reachable ? null : report.detail),
    });
  }
} catch (e) {
  const detail = e instanceof Error ? e.message : String(e);
  checks.push({
    name: "Integrations",
    run: async () =>
      `Could not inspect the configured integrations: ${detail}. ` +
      `The checks above are still accurate; this is a defect in an adapter, not in your setup.`,
  });
}

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
