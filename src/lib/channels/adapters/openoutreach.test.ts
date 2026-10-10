import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdapterConfigError } from "../types";
import { configFromEnv, createOpenOutreachAdapter, parseLeads } from "./openoutreach";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openoutreach-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeCsv(name: string, contents: string, mtime?: Date): string {
  const full = join(dir, name);
  writeFileSync(full, contents);
  if (mtime) {
    utimesSync(full, mtime, mtime);
  }
  return full;
}

describe("configFromEnv", () => {
  it("throws naming the env var when OPENOUTREACH_EXPORT_DIR is unset", () => {
    const emptyEnv = { NODE_ENV: "test" } as NodeJS.ProcessEnv;
    expect(() => configFromEnv(emptyEnv)).toThrow(AdapterConfigError);
    try {
      configFromEnv(emptyEnv);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterConfigError);
      expect((err as Error).message).toContain("OPENOUTREACH_EXPORT_DIR");
    }
  });
});

describe("parseLeads", () => {
  it("parses a quoted field containing a comma", () => {
    const csv = 'name,company\n"Doe, Jane","Acme, Inc."\n';
    const leads = parseLeads(csv, 10);
    expect(leads).toHaveLength(1);
    expect(leads[0]?.name).toBe("Doe, Jane");
    expect(leads[0]?.company).toBe("Acme, Inc.");
  });

  it("parses an escaped double quote inside a quoted field", () => {
    const csv = 'name,title\n"Jane Doe","VP of ""Growth"""\n';
    const leads = parseLeads(csv, 10);
    expect(leads[0]?.title).toBe('VP of "Growth"');
  });

  it("handles CRLF line endings", () => {
    const csv = "name,company\r\nJane Doe,Acme\r\nJohn Roe,Beta\r\n";
    const leads = parseLeads(csv, 10);
    expect(leads).toHaveLength(2);
    expect(leads[0]?.name).toBe("Jane Doe");
    expect(leads[1]?.name).toBe("John Roe");
  });

  it("handles a trailing newline without producing a phantom row", () => {
    const csv = "name\nJane Doe\n";
    const leads = parseLeads(csv, 10);
    expect(leads).toHaveLength(1);
  });

  it("maps alternate header spellings for every field", () => {
    const csv =
      "full_name,job_title,organization,email,linkedin_url,why,fit_score\n" +
      "Jane Doe,Engineer,Acme,jane@acme.com,https://linkedin.com/in/jane,Good fit,88\n";
    const leads = parseLeads(csv, 10);
    expect(leads).toHaveLength(1);
    const lead = leads[0];
    expect(lead?.name).toBe("Jane Doe");
    expect(lead?.title).toBe("Engineer");
    expect(lead?.company).toBe("Acme");
    expect(lead?.email).toBe("jane@acme.com");
    expect(lead?.linkedinUrl).toBe("https://linkedin.com/in/jane");
    expect(lead?.reason).toBe("Good fit");
    expect(lead?.sourceScore).toBe(88);
  });

  it("skips a row with no usable name", () => {
    const csv = "name,company\n,Acme\nJane Doe,Beta\n";
    const leads = parseLeads(csv, 10);
    expect(leads).toHaveLength(1);
    expect(leads[0]?.name).toBe("Jane Doe");
  });

  it("turns a non-numeric score into null rather than NaN or zero", () => {
    const csv = "name,score\nJane Doe,n/a\n";
    const leads = parseLeads(csv, 10);
    expect(leads[0]?.sourceScore).toBeNull();
    expect(leads[0]?.sourceScore).not.toBeNaN();
  });

  it("respects the limit", () => {
    const csv = "name\nA\nB\nC\nD\n";
    const leads = parseLeads(csv, 2);
    expect(leads).toHaveLength(2);
    expect(leads.map((l) => l.name)).toEqual(["A", "B"]);
  });

  it("ignores unknown columns without erroring", () => {
    const csv = "name,carrier_pigeon_id\nJane Doe,42\n";
    const leads = parseLeads(csv, 10);
    expect(leads).toHaveLength(1);
    expect(leads[0]?.name).toBe("Jane Doe");
  });
});

describe("createOpenOutreachAdapter", () => {
  it("has no send method and declares inbound capabilities", () => {
    const adapter = createOpenOutreachAdapter({ exportDir: dir });
    expect(adapter.id).toBe("openoutreach");
    expect(adapter.send).toBeUndefined();
    expect(adapter.capabilities).toEqual({
      actions: [],
      mode: "inbound",
      supportsMetrics: false,
      supportsReplies: false,
      requestsPerHour: null,
    });
  });

  it("reads the most recently modified CSV when several exist", async () => {
    writeCsv("old.csv", "name\nOld Lead\n", new Date("2020-01-01T00:00:00Z"));
    writeCsv("new.csv", "name\nNew Lead\n", new Date("2024-01-01T00:00:00Z"));
    writeCsv("mid.csv", "name\nMid Lead\n", new Date("2022-01-01T00:00:00Z"));

    const adapter = createOpenOutreachAdapter({ exportDir: dir });
    const leads = await adapter.fetchLeads?.(10);
    expect(leads).toHaveLength(1);
    expect(leads?.[0]?.name).toBe("New Lead");
  });

  it("reports unreachable with an actionable detail for a missing directory", async () => {
    const adapter = createOpenOutreachAdapter({ exportDir: join(dir, "does-not-exist") });
    const health = await adapter.health();
    expect(health.reachable).toBe(false);
    expect(health.detail).toContain("OPENOUTREACH_EXPORT_DIR");
  });

  it("reports unreachable with an actionable detail for a directory with no CSVs", async () => {
    const adapter = createOpenOutreachAdapter({ exportDir: dir });
    const health = await adapter.health();
    expect(health.reachable).toBe(false);
    expect(health.detail).toContain("export");
  });

  it("reports reachable once at least one CSV is present", async () => {
    writeCsv("leads.csv", "name\nJane Doe\n");
    const adapter = createOpenOutreachAdapter({ exportDir: dir });
    const health = await adapter.health();
    expect(health.reachable).toBe(true);
  });
});
