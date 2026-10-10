import { describe, expect, it } from "vitest";
import {
  AmbiguousAdapterError,
  buildRegistry,
  overrideVarFor,
  UnknownAdapterError,
} from "./registry";

function env(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...over } as NodeJS.ProcessEnv;
}

const postizEnv = { POSTIZ_URL: "http://localhost:5000", POSTIZ_API_KEY: "k" };

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
});

describe("senderFor", () => {
  it("returns null when no configured adapter carries the action", () => {
    expect(buildRegistry(env()).senderFor("linkedin.post")).toBeNull();
  });

  it("resolves the single adapter that carries the action", () => {
    expect(buildRegistry(env(postizEnv)).senderFor("linkedin.post")?.id).toBe("postiz");
  });

  it("never offers an inbound source as a sender", () => {
    const r = buildRegistry(env({ OPENOUTREACH_EXPORT_DIR: "/tmp" }));
    expect(r.available.map((a) => a.id)).toEqual(["openoutreach"]);
    expect(r.senderFor("linkedin.post")).toBeNull();
  });

  it("returns null for an action no adapter claims", () => {
    expect(buildRegistry(env(postizEnv)).senderFor("email.cold")).toBeNull();
  });

  it("honors an explicit pin", () => {
    const r = buildRegistry(env({ ...postizEnv, CHANNEL_LINKEDIN_POST: "postiz" }));
    expect(r.senderFor("linkedin.post")?.id).toBe("postiz");
  });

  it("throws rather than silently falling back when a pin names an unavailable adapter", () => {
    const r = buildRegistry(env({ ...postizEnv, CHANNEL_LINKEDIN_POST: "smtp" }));
    expect(() => r.senderFor("linkedin.post")).toThrow(UnknownAdapterError);
    expect(() => r.senderFor("linkedin.post")).toThrow(/not an available adapter/);
  });
});

describe("leadSources", () => {
  it("is empty when no inbound source is configured", () => {
    expect(buildRegistry(env(postizEnv)).leadSources()).toHaveLength(0);
  });

  it("returns the configured inbound source", () => {
    const r = buildRegistry(env({ OPENOUTREACH_EXPORT_DIR: "/tmp" }));
    expect(r.leadSources().map((a) => a.id)).toEqual(["openoutreach"]);
  });

  it("never includes a sending adapter", () => {
    const r = buildRegistry(env({ ...postizEnv, OPENOUTREACH_EXPORT_DIR: "/tmp" }));
    expect(r.leadSources().map((a) => a.id)).toEqual(["openoutreach"]);
  });
});

describe("overrideVarFor", () => {
  it("maps an action type to its env var name", () => {
    expect(overrideVarFor("linkedin.post")).toBe("CHANNEL_LINKEDIN_POST");
    expect(overrideVarFor("email.followup")).toBe("CHANNEL_EMAIL_FOLLOWUP");
    expect(overrideVarFor("research.enrich")).toBe("CHANNEL_RESEARCH_ENRICH");
  });
});

describe("ambiguity", () => {
  it("names the env var that settles a contested action", () => {
    // Constructed directly: no two shipped adapters currently contest an
    // action, but the guard must hold the moment a second sender lands.
    const err = new AmbiguousAdapterError("linkedin.post", ["postiz", "smtp"]);
    expect(err.message).toContain("CHANNEL_LINKEDIN_POST");
    expect(err.message).toContain("postiz, smtp");
  });
});
