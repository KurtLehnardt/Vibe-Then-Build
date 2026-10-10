import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostizAdapter } from "./postiz";
import { AdapterConfigError, UnsupportedActionError, type OutboundMessage } from "../types";

const cfg = { url: "http://localhost:5000", apiKey: "test-key" };

function message(over: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    actionType: "linkedin.post",
    subjectId: "draft-1",
    body: "hello world",
    ...over,
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("createPostizAdapter config", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws AdapterConfigError naming POSTIZ_URL when missing", () => {
    delete process.env.POSTIZ_URL;
    process.env.POSTIZ_API_KEY = "x";
    expect(() => createPostizAdapter()).toThrow(AdapterConfigError);
    expect(() => createPostizAdapter()).toThrow(/POSTIZ_URL/);
  });

  it("throws AdapterConfigError naming POSTIZ_API_KEY when missing", () => {
    process.env.POSTIZ_URL = "http://localhost:5000";
    delete process.env.POSTIZ_API_KEY;
    expect(() => createPostizAdapter()).toThrow(AdapterConfigError);
    expect(() => createPostizAdapter()).toThrow(/POSTIZ_API_KEY/);
    expect(() => createPostizAdapter()).toThrow(/Settings.*Public API/);
  });
});

describe("createPostizAdapter capabilities", () => {
  it("declares linkedin.post, api mode, and the 90/hour limit", () => {
    const adapter = createPostizAdapter(cfg);
    expect(adapter.id).toBe("postiz");
    expect(adapter.capabilities).toEqual({
      actions: ["linkedin.post"],
      mode: "api",
      supportsMetrics: true,
      supportsReplies: false,
      requestsPerHour: 90,
    });
  });
});

describe("send", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an unsupported action without calling fetch", async () => {
    const adapter = createPostizAdapter(cfg);
    await expect(adapter.send!(message({ actionType: "email.cold" }))).rejects.toThrow(
      UnsupportedActionError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends type 'now' when scheduledFor is absent", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "abc123" }));

    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message());

    expect(result).toEqual({ status: "sent", externalId: "abc123", sentAt: expect.any(Date) });
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init!.body as string);
    expect(body.type).toBe("now");
    expect(body.date).toBeUndefined();
  });

  it("sends type 'schedule' with the date when scheduledFor is present", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "abc123" }));

    const scheduledFor = new Date("2026-01-01T12:00:00.000Z");
    const adapter = createPostizAdapter(cfg);
    await adapter.send!(message({ scheduledFor }));

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init!.body as string);
    expect(body.type).toBe("schedule");
    expect(body.date).toBe(scheduledFor.toISOString());
  });

  it("carries channel/integration ids from message.meta", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "abc123" }));

    const adapter = createPostizAdapter(cfg);
    await adapter.send!(message({ meta: { integrationId: "int-42" } }));

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init!.body as string);
    expect(body.integration).toEqual({ id: "int-42" });
  });

  it("returns sent with the external id on 2xx", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { postId: "post-9" }));

    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message());

    expect(result).toEqual({ status: "sent", externalId: "post-9", sentAt: expect.any(Date) });
  });

  it("returns externalId: null when no plausible id field is found", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message());

    expect(result).toEqual({ status: "sent", externalId: null, sentAt: expect.any(Date) });
  });

  it("returns retry and parses Retry-After on 429", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response("rate limited", { status: 429, headers: { "retry-after": "30" } }),
    );

    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message());

    expect(result.status).toBe("retry");
    expect((result as { retryAfterSeconds: number | null }).retryAfterSeconds).toBe(30);
  });

  it("returns retryAfterSeconds: null on 429 without a Retry-After header", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response("rate limited", { status: 429 }));

    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message());

    expect(result.status).toBe("retry");
    expect((result as { retryAfterSeconds: number | null }).retryAfterSeconds).toBeNull();
  });

  it("returns retry on 500", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response("server error", { status: 500 }));

    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message());

    expect(result.status).toBe("retry");
  });

  it("returns rejected (not retry) on 400 and includes the upstream body", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response("invalid integration id", { status: 400 }));

    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message());

    expect(result.status).toBe("rejected");
    expect((result as { reason: string }).reason).toContain("invalid integration id");
  });

  it("returns retry on a fetch rejection (network/timeout error)", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(new Error("fetch failed"));

    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message());

    expect(result.status).toBe("retry");
    expect((result as { reason: string }).reason).toContain("fetch failed");
  });
});

describe("health", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports reachable on 2xx from the channels endpoint", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, []));

    const adapter = createPostizAdapter(cfg);
    const report = await adapter.health();

    expect(report.reachable).toBe(true);
  });

  it("reports unreachable with the docker fix command when fetch fails", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const adapter = createPostizAdapter(cfg);
    const report = await adapter.health();

    expect(report.reachable).toBe(false);
    expect(report.detail).toContain("docker compose up -d postiz");
  });

  it("reports unreachable with an auth-specific detail on 401", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));

    const adapter = createPostizAdapter(cfg);
    const report = await adapter.health();

    expect(report.reachable).toBe(false);
    expect(report.detail).toContain("POSTIZ_API_KEY");
  });
});
