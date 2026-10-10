import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostizAdapter } from "./postiz";
import { AdapterConfigError, type OutboundMessage } from "../types";

const cfg = { url: "http://localhost:5000", apiKey: "test-key" };

// File-wide backstop. Individual describe blocks stub and unstub `fetch` around each
// test, but a test that assigns `globalThis.fetch` directly (rather than through
// `vi.stubGlobal`) would otherwise leak that stub into whatever runs next. Saved once,
// reassigned after every test regardless of which describe block it belongs to.
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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
  it("declares linkedin.post, api mode, and no metrics support", () => {
    // Asserting behaviorally rather than by deep-equality against the literal: this
    // adapter has no method that reports back on what it sent, so supportsMetrics must
    // be false; it only carries linkedin.post; and it sends unattended, so mode is
    // "api". A full-object deep-equal here would just restate the implementation.
    const adapter = createPostizAdapter(cfg);
    expect(adapter.id).toBe("postiz");
    expect(adapter.capabilities.actions).toEqual(["linkedin.post"]);
    expect(adapter.capabilities.mode).toBe("api");
    expect(adapter.capabilities.supportsMetrics).toBe(false);
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

  it("trims whitespace around a numeric value before accepting it", async () => {
    // Pins `raw.trim()`: without it, " 120 " fails the /^\d+$/ test and falls through
    // to null instead of 120.
    expect(await retryAfterFor(" 120 ")).toBe(120);
  });
});

describe("send: Retry-After upper clamp", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const MAX_RETRY_AFTER_SECONDS = 86_400;

  async function retryAfterFor(headerValue: string): Promise<number | null> {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response("rate limited", { status: 429, headers: { "retry-after": headerValue } }),
    );

    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message());
    return (result as { retryAfterSeconds: number | null }).retryAfterSeconds;
  }

  // Node's setTimeout silently clamps any delay above INT32_MAX ms (~24.8 days) down to
  // 1ms instead of throwing, so an un-clamped Retry-After reaches the exact hot
  // immediate-retry loop the lower (non-negative) clamp was added to prevent, just
  // reached from the top of the range. Each value below was measured to fire a
  // setTimeout within a few ms of 0 before this fix; all must now clamp to one day.
  it("clamps a huge numeric Retry-After (2147484s) to one day", async () => {
    expect(await retryAfterFor("2147484")).toBe(MAX_RETRY_AFTER_SECONDS);
  });

  it("clamps an enormous numeric Retry-After (10^20 s) to one day", async () => {
    expect(await retryAfterFor("99999999999999999999")).toBe(MAX_RETRY_AFTER_SECONDS);
  });

  it("clamps a far-future HTTP-date Retry-After to one day", async () => {
    expect(await retryAfterFor("Fri, 31 Dec 9999 23:59:59 GMT")).toBe(MAX_RETRY_AFTER_SECONDS);
  });

  it("does not clamp a value exactly at the boundary", async () => {
    expect(await retryAfterFor(String(MAX_RETRY_AFTER_SECONDS))).toBe(MAX_RETRY_AFTER_SECONDS);
  });

  it("clamps a value one second past the boundary", async () => {
    expect(await retryAfterFor(String(MAX_RETRY_AFTER_SECONDS + 1))).toBe(MAX_RETRY_AFTER_SECONDS);
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

describe("send: scrubbing runs before truncation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("still removes a password that would otherwise land past the 500-char cut", async () => {
    // Regression: external() used to be scrubCredentials(truncate(text)). With enough
    // filler ahead of a credentialed URL, the 500-char slice lands inside the userinfo
    // segment and removes the "@" the scrub regex needs, so the password survives in
    // the truncated tail. Scrubbing first, then truncating, fixes this because the
    // replacement happens over the full text before any of it is cut away.
    const filler = "x".repeat(480);
    const credentialedUrl = "http://admin:hunter2@postiz.internal:5000";
    const hugeBody = `${filler}${credentialedUrl}`;

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(hugeBody, { status: 400 }));

    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message());

    expect(result.status).toBe("rejected");
    const reason = (result as { reason: string }).reason;
    expect(reason).not.toContain("hunter2");
  });
});

describe("send: scrubbing a configured API key or a credential-shaped query param", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("replaces a literal occurrence of the configured API key wherever it appears in a body", async () => {
    // The scrubber is handed cfg.apiKey so it can replace the exact configured string
    // regardless of the shape it is embedded in. This is the reliable half: the key is
    // known exactly, so every occurrence of it is caught, not just ones that look like
    // a URL or a query parameter.
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { error: "invalid key", received: "test-key-SUPER-SECRET" }),
    );

    const adapter = createPostizAdapter({ url: "http://localhost:5000", apiKey: "test-key-SUPER-SECRET" });
    const result = await adapter.send!(message());

    expect(result.status).toBe("rejected");
    expect((result as { reason: string }).reason).not.toContain("test-key-SUPER-SECRET");
  });

  it("scrubs a credential-shaped query parameter even when it is not the configured key", async () => {
    // Defense in depth: this body echoes a secret that is not cfg.apiKey (an unrelated
    // token upstream issued), so the literal-key rule cannot catch it. The query-param
    // regex rule is what catches this one instead.
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response("GET /public/v1/posts?apiKey=SUPER-SECRET-KEY returned 400", { status: 400 }),
    );

    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message());

    expect(result.status).toBe("rejected");
    expect((result as { reason: string }).reason).not.toContain("SUPER-SECRET-KEY");
  });

  it("scrubs a token= query parameter the same way", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response("upstream said: retry with ?token=abc123secret", { status: 422 }),
    );

    const adapter = createPostizAdapter(cfg);
    const result = await adapter.send!(message());

    expect(result.status).toBe("rejected");
    expect((result as { reason: string }).reason).not.toContain("abc123secret");
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

describe("send: HTTP request envelope (F5)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Mutation testing found the existing suite green even after: deleting the
  // Authorization header entirely; changing it to `Bearer ${key}`; dropping
  // `content-type: application/json`; changing method from POST to PUT; dropping
  // AbortSignal.timeout; cutting the default timeout from 10s to 1ms; probing /posts
  // instead of /channels in health(); and dropping the trailing-slash strip in
  // apiBase(). Each assertion below was verified to fail when I reintroduced the
  // corresponding mutant by hand, then passed again once the mutant was reverted.
  it("sends the exact URL, method, Authorization header, content-type, and an abort signal", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "abc123" }));

    const adapter = createPostizAdapter(cfg);
    await adapter.send!(message());

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:5000/public/v1/posts");
    expect(init!.method).toBe("POST");
    // Postiz takes the API key directly in the Authorization header; it is not
    // Bearer-prefixed.
    const headers = init!.headers as Record<string, string>;
    expect(headers.authorization).toBe("test-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses the default 10s timeout for send and a 5s cap for health", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "abc123" }));

    const adapter = createPostizAdapter(cfg);
    await adapter.send!(message());
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);

    timeoutSpy.mockClear();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, []));
    await adapter.health();
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);

    timeoutSpy.mockRestore();
  });

  it("probes /public/v1/channels, not /posts, for health", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, []));

    const adapter = createPostizAdapter(cfg);
    await adapter.health();

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:5000/public/v1/channels");
  });

  it("does not double a trailing slash in POSTIZ_URL when building the posts URL", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "abc123" }));

    const adapter = createPostizAdapter({ url: "http://localhost:5000/", apiKey: "test-key" });
    await adapter.send!(message());

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:5000/public/v1/posts");
  });
});

describe("credential scrubbing at the text boundary", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not leak a password carried by the underlying fetch error message", async () => {
    // Regression. redactUrl() sanitized our own configured URL, but the fetch
    // error interpolated next to it carried the full credentialed URL, so the
    // password still reached the health detail. Stubbed so no socket is opened:
    // the stub throws the same error shape a real connect failure against a
    // credentialed URL produces, instead of genuinely dialing 127.0.0.1:59999.
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(
      new Error("connect ECONNREFUSED http://admin:hunter2@127.0.0.1:59999/public/v1/channels"),
    );

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
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response("upstream said: http://svc:p4ssw0rd@internal:5000 refused", { status: 400 }),
    );

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
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(
      new Error("connect failed for http://u:s3cret@host:5000/public/v1/posts"),
    );

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
