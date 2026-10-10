import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostizAdapter } from "./postiz";
import { AdapterConfigError, type OutboundMessage } from "../types";

const cfg = { url: "http://localhost:5000", apiKey: "test-key" };

function message(over: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    actionType: "linkedin.post",
    subjectId: "draft-1",
    body: "hello world",
    meta: { integrationId: "int-1" },
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
  it("declares linkedin.post, api mode, no metrics support, and the 90/hour limit", () => {
    const adapter = createPostizAdapter(cfg);
    expect(adapter.id).toBe("postiz");
    expect(adapter.capabilities).toEqual({
      actions: ["linkedin.post"],
      mode: "api",
      supportsMetrics: false,
      supportsReplies: false,
      requestsPerHour: 90,
    });
  });
});

describe("send: payload shape (F1)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the exact Postiz payload for type 'now'", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "abc123" }));

    const adapter = createPostizAdapter(cfg);
    const before = Date.now();
    await adapter.send!(
      message({ subjectId: "draft-1", body: "Hello world!", meta: { integrationId: "int-42" } }),
    );
    const after = Date.now();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:5000/public/v1/posts");
    const body = JSON.parse(init!.body as string);

    expect(body.type).toBe("now");
    expect(body.shortLink).toBe(false);
    expect(body.tags).toEqual([]);
    expect(body.posts).toEqual([
      {
        integration: { id: "int-42" },
        value: [{ content: "Hello world!", image: [] }],
        settings: { __type: "linkedin" },
        group: "draft-1",
      },
    ]);
    const dateMs = Date.parse(body.date);
    expect(dateMs).toBeGreaterThanOrEqual(before);
    expect(dateMs).toBeLessThanOrEqual(after);
  });

  it("posts the exact Postiz payload for type 'schedule'", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "abc123" }));

    const scheduledFor = new Date("2026-01-01T12:00:00.000Z");
    const adapter = createPostizAdapter(cfg);
    await adapter.send!(
      message({
        subjectId: "draft-2",
        body: "Scheduled!",
        scheduledFor,
        meta: { integrationId: "int-7" },
      }),
    );

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init!.body as string);

    expect(body).toEqual({
      type: "schedule",
      date: "2026-01-01T12:00:00.000Z",
      shortLink: false,
      tags: [],
      posts: [
        {
          integration: { id: "int-7" },
          value: [{ content: "Scheduled!", image: [] }],
          settings: { __type: "linkedin" },
          group: "draft-2",
        },
      ],
    });
  });

  it("carries a numeric channel/integration id from message.meta", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "abc123" }));

    const adapter = createPostizAdapter(cfg);
    await adapter.send!(message({ meta: { channelId: 42 } }));

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init!.body as string);
    expect(body.posts[0].integration).toEqual({ id: 42 });
  });
});

describe("send", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns rejected for an unsupported action without calling fetch (F9)", async () => {
    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message({ actionType: "email.cold" }));

    expect(result.status).toBe("rejected");
    expect((result as { reason: string }).reason).toContain("email.cold");
    expect((result as { reason: string }).reason).toContain("linkedin.post");
    expect(fetch).not.toHaveBeenCalled();
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

describe("send: status classification (F2)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const cases: Array<[number, "retry" | "rejected"]> = [
    [400, "rejected"],
    [401, "rejected"],
    [408, "retry"],
    [409, "rejected"],
    [425, "retry"],
    [429, "retry"],
    [500, "retry"],
    [501, "rejected"],
    [502, "retry"],
    [503, "retry"],
    [504, "retry"],
    [505, "rejected"],
  ];

  it.each(cases)("status %i classifies as %s", async (status, expected) => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response("upstream body", { status }));

    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message());

    expect(result.status).toBe(expected);
  });
});

describe("send: Retry-After parsing (F3)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function retryAfterFor(headerValue: string | undefined): Promise<number | null> {
    const fetchMock = vi.mocked(fetch);
    const headers: Record<string, string> =
      headerValue !== undefined ? { "retry-after": headerValue } : {};
    fetchMock.mockResolvedValueOnce(new Response("rate limited", { status: 429, headers }));

    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message());
    return (result as { retryAfterSeconds: number | null }).retryAfterSeconds;
  }

  it("treats a negative value as no guidance rather than retry-immediately", async () => {
    // A negative Retry-After is malformed. Returning 0 would send the caller straight
    // back at a server that just asked it to wait, so the answer is null and the caller
    // applies its own backoff. Asserting null also pins the deliberate exclusion that
    // keeps Date.parse("-5") — which resolves to May 2001 — out of this path.
    expect(await retryAfterFor("-5")).toBeNull();
  });

  it("treats other numeric-looking malformed values as no guidance", async () => {
    expect(await retryAfterFor("+30")).toBeNull();
    expect(await retryAfterFor("-0")).toBeNull();
  });

  it("accepts a plain '0'", async () => {
    expect(await retryAfterFor("0")).toBe(0);
  });

  it("does not parse a fractional value as a whole-second count", async () => {
    // "1.75" matches neither the plain-integer form nor a valid HTTP-date, so this is
    // correctly unparseable rather than silently truncated or rounded up.
    expect(await retryAfterFor("1.75")).toBeNull();
  });

  it("does not parse a hex-looking value via Number()'s hex coercion", async () => {
    // "0x20" is rejected by the /^\d+$/ check and is not a valid HTTP-date either, so
    // this must not resolve to 32 the way Number("0x20") would.
    expect(await retryAfterFor("0x20")).toBeNull();
  });

  it("clamps a past HTTP-date to 0", async () => {
    expect(await retryAfterFor("Wed, 21 Oct 2015 07:28:00 GMT")).toBe(0);
  });

  it("computes the delta for a future HTTP-date", async () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const seconds = await retryAfterFor(future);
    expect(seconds).not.toBeNull();
    expect(seconds as number).toBeGreaterThanOrEqual(58);
    expect(seconds as number).toBeLessThanOrEqual(60);
  });

  it("returns null when the header is absent", async () => {
    expect(await retryAfterFor(undefined)).toBeNull();
  });
});

describe("send: unbounded upstream body is truncated (F5)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("truncates a large rejected body to 500 characters", async () => {
    const fetchMock = vi.mocked(fetch);
    const hugeBody = "x".repeat(5_000_000);
    fetchMock.mockResolvedValueOnce(new Response(hugeBody, { status: 400 }));

    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message());

    expect(result.status).toBe("rejected");
    const reason = (result as { reason: string }).reason;
    expect(reason.length).toBeLessThan(600);
    expect(reason).toContain("…");
  });

  it("truncates a large retryable body to 500 characters", async () => {
    const fetchMock = vi.mocked(fetch);
    const hugeBody = "y".repeat(5_000_000);
    fetchMock.mockResolvedValueOnce(new Response(hugeBody, { status: 500 }));

    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message());

    expect(result.status).toBe("retry");
    const reason = (result as { reason: string }).reason;
    expect(reason.length).toBeLessThan(600);
    expect(reason).toContain("…");
  });
});

describe("send: credential exposure (F6)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("drops the upstream body from a 401 reason even when it carries a fake secret", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: "invalid api key: SUPER-SECRET-KEY" }),
    );

    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message());

    expect(result.status).toBe("rejected");
    const reason = (result as { reason: string }).reason;
    expect(reason).not.toContain("SUPER-SECRET-KEY");
    expect(reason).toContain("POSTIZ_API_KEY");
  });

  it("drops the upstream body from a 403 reason too", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: "key abc-secret-def forbidden" }));

    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message());

    expect(result.status).toBe("rejected");
    expect((result as { reason: string }).reason).not.toContain("abc-secret-def");
  });
});

describe("health: credential exposure (F6)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never leaks a URL's userinfo password into the health detail", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const adapter = createPostizAdapter({
      url: "http://admin:hunter2@postiz.internal:5000",
      apiKey: "test-key",
    });
    const report = await adapter.health();

    expect(report.reachable).toBe(false);
    expect(report.detail).not.toContain("hunter2");
    expect(report.detail).toContain("postiz.internal");
  });
});

describe("send: extractExternalId (F7)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the id out of the nested data envelope rather than the sibling integrationId", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { integrationId: "int-42", data: { id: "post-9" } }));

    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message());

    expect(result).toEqual({ status: "sent", externalId: "post-9", sentAt: expect.any(Date) });
  });

  it("unwraps an array envelope by taking its first element", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "post-9" }] }));

    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message());

    expect((result as { externalId: string | null }).externalId).toBe("post-9");
  });

  it("stringifies a numeric id", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 123 }));

    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message());

    expect((result as { externalId: string | null }).externalId).toBe("123");
  });

  it("returns null, not the channel id, when nothing plausible is found", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { integrationId: "int-42" }));

    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message());

    expect((result as { externalId: string | null }).externalId).toBeNull();
  });
});

describe("send: meta validation (F10)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a non-string, non-number integrationId without calling fetch", async () => {
    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message({ meta: { integrationId: { nested: ["a"] } } }));

    expect(result.status).toBe("rejected");
    expect((result as { reason: string }).reason).toContain("string or number");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a missing integration id without calling fetch", async () => {
    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message({ meta: {} }));

    expect(result.status).toBe("rejected");
    expect((result as { reason: string }).reason).toContain("integration id");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("send: 2xx error envelope (F11)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats a 200 carrying an error field as rejected, not sent", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { error: "duplicate post" }));

    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message());

    expect(result.status).toBe("rejected");
  });

  it("treats a 200 carrying an errors array as rejected, not sent", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { errors: ["bad integration"] }));

    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message());

    expect(result.status).toBe("rejected");
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

describe("credential scrubbing at the text boundary", () => {
  it("does not leak a password carried by the underlying fetch error message", async () => {
    // Regression. redactUrl() sanitized our own configured URL, but the fetch
    // error interpolated next to it carried the full credentialed URL, so the
    // password still reached the health detail.
    const adapter = createPostizAdapter({
      url: "http://admin:hunter2@127.0.0.1:59999",
      apiKey: "k",
    });
    const report = await adapter.health();
    expect(report.reachable).toBe(false);
    expect(report.detail).not.toContain("hunter2");
    expect(report.detail).not.toContain("admin:");
  });

  it("scrubs credentials out of an upstream response body", async () => {
    globalThis.fetch = (async () =>
      new Response("upstream said: http://svc:p4ssw0rd@internal:5000 refused", {
        status: 400,
      })) as unknown as typeof fetch;

    const adapter = createPostizAdapter({ url: "http://localhost:5000", apiKey: "k" });
    const outcome = await adapter.send!({
      actionType: "linkedin.post",
      subjectId: "draft-1",
      body: "hello",
      meta: { integrationId: "int-1" },
    });

    expect(outcome.status).toBe("rejected");
    expect((outcome as { reason: string }).reason).not.toContain("p4ssw0rd");
    expect((outcome as { reason: string }).reason).toContain("//***@");
  });

  it("scrubs credentials out of a send-path network error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connect failed for http://u:s3cret@host:5000/public/v1/posts");
    }) as unknown as typeof fetch;

    const adapter = createPostizAdapter({ url: "http://localhost:5000", apiKey: "k" });
    const outcome = await adapter.send!({
      actionType: "linkedin.post",
      subjectId: "draft-1",
      body: "hello",
      meta: { integrationId: "int-1" },
    });

    expect(outcome.status).toBe("retry");
    expect((outcome as { reason: string }).reason).not.toContain("s3cret");
  });
});
