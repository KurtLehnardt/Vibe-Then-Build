import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/db", () => ({ db: { execute } }));

import { GET } from "./route";

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("no gateway in this test")),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    execute.mockReset();
  });

  it("reports a fixed status and never echoes the thrown error's message", async () => {
    execute.mockRejectedValueOnce(
      new Error('password authentication failed for user "postgres" at 10.0.0.5:5432/loop'),
    );

    const res = await GET();
    const body = (await res.json()) as { healthy: boolean; checks: Record<string, string> };

    expect(res.status).toBe(503);
    expect(body.healthy).toBe(false);
    expect(body.checks.database).toBe("unreachable");
    expect(JSON.stringify(body)).not.toContain("10.0.0.5");
    expect(JSON.stringify(body)).not.toContain("postgres");
  });

  it("does not throw when the database rejects with a non-Error value", async () => {
    execute.mockRejectedValueOnce(undefined);

    const res = await GET();
    const body = (await res.json()) as { healthy: boolean; checks: Record<string, string> };

    expect(res.status).toBe(503);
    expect(body.checks.database).toBe("unreachable");
  });

  it("reports healthy when the database check succeeds and the gateway is ok", async () => {
    execute.mockResolvedValueOnce(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    );

    const res = await GET();
    const body = (await res.json()) as { healthy: boolean; checks: Record<string, string> };

    expect(res.status).toBe(200);
    expect(body.healthy).toBe(true);
    expect(body.checks.database).toBe("ok");
  });
});
