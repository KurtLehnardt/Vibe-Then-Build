import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AmbiguousAdapterError,
  buildRegistry,
  IncompatibleAdapterError,
  overrideVarFor,
  UnknownAdapterError,
} from "./registry";
import type { ActionType } from "../policy/levels";
import type { ChannelAdapter, ChannelId, HealthReport, SendMode } from "./types";

function env(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...over } as NodeJS.ProcessEnv;
}

const postizEnv = { POSTIZ_URL: "http://localhost:5000", POSTIZ_API_KEY: "k" };

/**
 * Stub adapters, rather than the two shipped ones.
 *
 * Mutation testing showed every guard in `senderFor` and `leadSources` could be
 * deleted with the old suite still green, because no two shipped adapters
 * contest an action and neither one both lacks `send` and claims an action.
 * These stubs exist to make each guard independently falsifiable.
 */
function stubAdapter(opts: {
  id: ChannelId;
  actions?: ActionType[];
  mode?: SendMode;
  withSend?: boolean;
  withFetchLeads?: boolean;
  health?: () => Promise<HealthReport>;
}): ChannelAdapter {
  const adapter: ChannelAdapter = {
    id: opts.id,
    capabilities: {
      actions: opts.actions ?? [],
      mode: opts.mode ?? "api",
      supportsMetrics: false,
      supportsReplies: false,
      requestsPerHour: null,
    },
    health: opts.health ?? (async () => ({ reachable: true, detail: "Stub is healthy." })),
  };

  // A sender by default, an inbound source by default, and either overridable:
  // the point of these stubs is that each guard can be falsified independently.
  const wantsSend = opts.withSend ?? (opts.mode ?? "api") !== "inbound";
  if (wantsSend) {
    adapter.send = async () => ({
      status: "sent",
      externalId: `${opts.id}-1`,
      sentAt: new Date("2026-01-01T00:00:00Z"),
    });
  }
  if (opts.withFetchLeads) {
    adapter.fetchLeads = async () => [{ name: "Stub Lead" }];
  }
  return adapter;
}

function registryOf(adapters: ChannelAdapter[], e: NodeJS.ProcessEnv = env()) {
  const factories = Object.fromEntries(adapters.map((a) => [a.id, () => a]));
  return buildRegistry(e, factories);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("availability", () => {
  it("records an unconfigured adapter as unavailable instead of throwing", () => {
    const r = buildRegistry(env());
    expect(r.available).toHaveLength(0);
    expect(r.unavailable.map((u) => u.id).sort()).toEqual(["openoutreach", "postiz"]);
  });

  it("explains why each unavailable adapter is unavailable", () => {
    const r = buildRegistry(env());
    expect(r.unavailable.find((u) => u.id === "postiz")?.reason).toContain("POSTIZ_URL");
    expect(r.unavailable.find((u) => u.id === "openoutreach")?.reason).toContain(
      "OPENOUTREACH_EXPORT_DIR",
    );
  });

  it("constructs an adapter once its configuration is present", () => {
    const r = buildRegistry(env(postizEnv));
    expect(r.available.map((a) => a.id)).toEqual(["postiz"]);
    expect(r.unavailable.map((u) => u.id)).toEqual(["openoutreach"]);
  });

  it("propagates a non-configuration failure rather than hiding it as unavailable", () => {
    const boom = () => {
      throw new Error("adapter constructor is broken");
    };
    expect(() => buildRegistry(env(), { postiz: boom })).toThrow("adapter constructor is broken");
  });
});

describe("senderFor", () => {
  it("returns null when no configured adapter carries the action", () => {
    expect(registryOf([]).senderFor("linkedin.post")).toBeNull();
  });

  it("resolves the single adapter that carries the action", () => {
    const r = registryOf([stubAdapter({ id: "postiz", actions: ["linkedin.post"] })]);
    expect(r.senderFor("linkedin.post")?.id).toBe("postiz");
  });

  it("refuses to choose when two configured adapters both claim the action", () => {
    const r = registryOf([
      stubAdapter({ id: "postiz", actions: ["linkedin.post"] }),
      stubAdapter({ id: "smtp", actions: ["linkedin.post"] }),
    ]);
    expect(() => r.senderFor("linkedin.post")).toThrow(AmbiguousAdapterError);
    expect(() => r.senderFor("linkedin.post")).toThrow(/CHANNEL_LINKEDIN_POST/);
  });

  it("ignores an adapter that claims the action but has no send method", () => {
    const r = registryOf([
      stubAdapter({ id: "postiz", actions: ["linkedin.post"], withSend: false, mode: "inbound" }),
    ]);
    expect(r.available.map((a) => a.id)).toEqual(["postiz"]);
    expect(r.senderFor("linkedin.post")).toBeNull();
  });

  it("returns null for an action no adapter claims", () => {
    const r = registryOf([stubAdapter({ id: "postiz", actions: ["linkedin.post"] })]);
    expect(r.senderFor("email.cold")).toBeNull();
  });

  it("honors an explicit pin", () => {
    const r = registryOf(
      [
        stubAdapter({ id: "postiz", actions: ["linkedin.post"] }),
        stubAdapter({ id: "smtp", actions: ["linkedin.post"] }),
      ],
      env({ CHANNEL_LINKEDIN_POST: "smtp" }),
    );
    expect(r.senderFor("linkedin.post")?.id).toBe("smtp");
  });

  it("says the adapter cannot carry the action when a pin names a configured one", () => {
    const r = registryOf(
      [stubAdapter({ id: "postiz", actions: ["linkedin.post"] })],
      env({ CHANNEL_EMAIL_COLD: "postiz" }),
    );
    expect(() => r.senderFor("email.cold")).toThrow(IncompatibleAdapterError);
    expect(() => r.senderFor("email.cold")).toThrow(/configured but cannot carry/);
  });

  it("says the adapter is unknown when a pin names one that is not configured", () => {
    const r = registryOf(
      [stubAdapter({ id: "postiz", actions: ["linkedin.post"] })],
      env({ CHANNEL_LINKEDIN_POST: "gmail" }),
    );
    expect(() => r.senderFor("linkedin.post")).toThrow(UnknownAdapterError);
    expect(() => r.senderFor("linkedin.post")).toThrow(/Available: postiz/);
  });
});

describe("leadSources", () => {
  it("is empty when no inbound source is configured", () => {
    const r = registryOf([stubAdapter({ id: "postiz", actions: ["linkedin.post"] })]);
    expect(r.leadSources()).toHaveLength(0);
  });

  it("returns the configured inbound source", () => {
    const r = registryOf([
      stubAdapter({ id: "openoutreach", mode: "inbound", withFetchLeads: true }),
    ]);
    expect(r.leadSources().map((a) => a.id)).toEqual(["openoutreach"]);
  });

  it("excludes a sending adapter even when it exposes fetchLeads", () => {
    const r = registryOf([
      stubAdapter({ id: "postiz", mode: "api", actions: ["linkedin.post"], withFetchLeads: true }),
    ]);
    expect(r.leadSources()).toHaveLength(0);
  });

  it("excludes an inbound adapter that has no fetchLeads method", () => {
    const r = registryOf([stubAdapter({ id: "openoutreach", mode: "inbound" })]);
    expect(r.available.map((a) => a.id)).toEqual(["openoutreach"]);
    expect(r.leadSources()).toHaveLength(0);
  });
});

describe("health", () => {
  it("reports every adapter", async () => {
    const r = registryOf([
      stubAdapter({ id: "postiz", actions: ["linkedin.post"] }),
      stubAdapter({ id: "openoutreach", mode: "inbound", withFetchLeads: true }),
    ]);
    const reports = await r.health();
    expect(reports.map((x) => x.id).sort()).toEqual(["openoutreach", "postiz"]);
    expect(reports.every((x) => x.report.reachable)).toBe(true);
  });

  it("keeps reporting the other adapters when one throws", async () => {
    const r = registryOf([
      stubAdapter({
        id: "openoutreach",
        mode: "inbound",
        withFetchLeads: true,
        health: async () => {
          throw new Error("ENOENT: dangling symlink");
        },
      }),
      stubAdapter({ id: "postiz", actions: ["linkedin.post"] }),
    ]);
    const reports = await r.health();
    expect(reports).toHaveLength(2);
    expect(reports.find((x) => x.id === "postiz")?.report.reachable).toBe(true);

    const broken = reports.find((x) => x.id === "openoutreach")?.report;
    expect(broken?.reachable).toBe(false);
    expect(broken?.detail).toContain("ENOENT: dangling symlink");
  });

  it.each([
    ["a string", "boom"],
    ["undefined", undefined],
    ["null", null],
  ])("survives an adapter that throws %s rather than an Error", async (_label, thrown) => {
    // Anything can be thrown in JavaScript. Reading `.message` off a thrown
    // `undefined` would itself throw, out of the very catch meant to contain it.
    const r = registryOf([
      stubAdapter({
        id: "openoutreach",
        mode: "inbound",
        health: async () => {
          throw thrown;
        },
      }),
      stubAdapter({ id: "postiz", actions: ["linkedin.post"] }),
    ]);

    const reports = await r.health();
    expect(reports).toHaveLength(2);
    expect(reports.find((x) => x.id === "postiz")?.report.reachable).toBe(true);
    expect(reports.find((x) => x.id === "openoutreach")?.report.reachable).toBe(false);
  });

  it("times out an adapter that never answers instead of hanging the whole check", async () => {
    vi.useFakeTimers();
    const r = registryOf([
      stubAdapter({ id: "openoutreach", mode: "inbound", health: () => new Promise(() => {}) }),
      stubAdapter({ id: "postiz", actions: ["linkedin.post"] }),
    ]);

    const pending = r.health();
    await vi.advanceTimersByTimeAsync(10_000);
    const reports = await pending;

    expect(reports).toHaveLength(2);
    expect(reports.find((x) => x.id === "postiz")?.report.reachable).toBe(true);
    const hung = reports.find((x) => x.id === "openoutreach")?.report;
    expect(hung?.reachable).toBe(false);
    expect(hung?.detail).toContain("did not report health within 10 seconds");
  });
});

describe("overrideVarFor", () => {
  it("maps an action type to its env var name", () => {
    expect(overrideVarFor("linkedin.post")).toBe("CHANNEL_LINKEDIN_POST");
    expect(overrideVarFor("email.followup")).toBe("CHANNEL_EMAIL_FOLLOWUP");
    expect(overrideVarFor("research.enrich")).toBe("CHANNEL_RESEARCH_ENRICH");
  });
});
