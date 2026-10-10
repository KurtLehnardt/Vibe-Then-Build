import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdapterConfigError } from "../types";
import { UnterminatedQuoteError } from "./csv";
import { MAX_CSV_BYTES, configFromEnv, createOpenOutreachAdapter, parseLeads } from "./openoutreach";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openoutreach-test-"));
});

afterEach(() => {
  // A permission test below strips the directory's own read/execute bits to
  // prove the health check actually needs them; restore them first or the
  // recursive remove can't even list what it's deleting.
  chmodSync(dir, 0o700);
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

  it("recognizes a UTF-8 BOM on the header row (relies on normalizeHeader's trim())", () => {
    // trim() is what strips the leading U+FEFF here; this is pinned
    // deliberately so that reliance is never accidentally removed by a
    // change that looks like a no-op (e.g. swapping trim() for a
    // hand-rolled whitespace strip that doesn't also strip U+FEFF).
    const csv = "﻿name,email\nJane Doe,jane@acme.com\n";
    const leads = parseLeads(csv, 10);
    expect(leads).toHaveLength(1);
    expect(leads[0]?.name).toBe("Jane Doe");
    expect(leads[0]?.email).toBe("jane@acme.com");
  });

  it("returns no leads when limit is zero", () => {
    const csv = "name\nJane Doe\n";
    expect(parseLeads(csv, 0)).toEqual([]);
  });

  it("returns no leads when limit is negative", () => {
    const csv = "name\nJane Doe\n";
    expect(parseLeads(csv, -1)).toEqual([]);
  });

  it("throws rather than importing a truncated export with an unterminated quote", () => {
    // F5 repro: OpenOutreach killed mid-write leaves a dangling quote. The
    // pre-fix behavior silently imported {name: "Jane,Acme", company: null}
    // instead of reporting the file as broken.
    const csv = 'name,company\n"Jane,Acme';
    expect(() => parseLeads(csv, 10)).toThrow(UnterminatedQuoteError);
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
    // F8: this used to assert `toContain("export")`, which also matches the
    // missing-directory message (it contains "exported") and so could not
    // tell the two failure branches apart. This substring is unique to the
    // "directory exists but is empty" branch.
    expect(health.detail).toContain("no .csv files");
    expect(health.detail).not.toContain("OPENOUTREACH_EXPORT_DIR");
  });

  it("reports reachable once at least one CSV is present", async () => {
    writeCsv("leads.csv", "name\nJane Doe\n");
    const adapter = createOpenOutreachAdapter({ exportDir: dir });
    const health = await adapter.health();
    expect(health.reachable).toBe(true);
  });

  it("reports unreachable (not rejected) when the export directory is unreadable (R_OK, not just F_OK)", async () => {
    writeCsv("leads.csv", "name\nJane Doe\n");
    const unreadable = join(dir, "locked");
    await mkdir(unreadable);
    chmodSync(unreadable, 0o000);

    const adapter = createOpenOutreachAdapter({ exportDir: unreadable });
    await expect(adapter.health()).resolves.toEqual(
      expect.objectContaining({ reachable: false }),
    );

    // Restore so afterEach's recursive rm of the parent `dir` can descend
    // into it.
    chmodSync(unreadable, 0o700);
  });

  describe("F1/F2: filesystem entries that are not plain files", () => {
    it("health() does not reject when the directory contains a dangling symlink", async () => {
      symlinkSync(join(dir, "nowhere"), join(dir, "link.csv"));
      const adapter = createOpenOutreachAdapter({ exportDir: dir });
      await expect(adapter.health()).resolves.toEqual(
        expect.objectContaining({ reachable: false }),
      );
    });

    it("fetchLeads() does not reject when the directory contains a dangling symlink", async () => {
      symlinkSync(join(dir, "nowhere"), join(dir, "link.csv"));
      const adapter = createOpenOutreachAdapter({ exportDir: dir });
      await expect(adapter.fetchLeads?.(10)).resolves.toEqual([]);
    });

    it("fetchLeads() does not reject when a subdirectory is named *.csv, and ignores it", async () => {
      await mkdir(join(dir, "archive.csv"));
      writeCsv("real.csv", "name\nJane Doe\n");
      const adapter = createOpenOutreachAdapter({ exportDir: dir });
      const leads = await adapter.fetchLeads?.(10);
      expect(leads).toHaveLength(1);
      expect(leads?.[0]?.name).toBe("Jane Doe");
    });

    it("does not follow a symlink pointing at a real CSV outside the export directory", async () => {
      // The export directory is written by a separate process; a symlink
      // inside it pointing elsewhere must not be treated as an export, even
      // when its target is a perfectly valid CSV.
      const outside = mkdtempSync(join(tmpdir(), "openoutreach-outside-"));
      try {
        const target = join(outside, "secret.csv");
        writeFileSync(target, "name\nShould Not Appear\n");
        symlinkSync(target, join(dir, "evil.csv"));

        const adapter = createOpenOutreachAdapter({ exportDir: dir });
        const leads = await adapter.fetchLeads?.(10);
        expect(leads).toEqual([]);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  describe("F3: deterministic mtime tie-break", () => {
    it("picks the lexicographically last filename when mtimes are identical", async () => {
      const tie = new Date("2024-06-01T00:00:00Z");
      // Written out of alphabetical order on purpose, so a pass only because
      // readdir happened to return names sorted would not go undetected.
      writeCsv("bbb.csv", "name\nBbb\n", tie);
      writeCsv("aaa.csv", "name\nAaa\n", tie);
      writeCsv("ccc.csv", "name\nCcc\n", tie);

      const adapter = createOpenOutreachAdapter({ exportDir: dir });
      const leads = await adapter.fetchLeads?.(10);
      expect(leads?.[0]?.name).toBe("Ccc");
    });
  });

  describe("F4: oversized export is refused unread", () => {
    it("returns no leads when the latest CSV exceeds the size cap", async () => {
      const oversized = join(dir, "huge.csv");
      writeFileSync(oversized, Buffer.alloc(MAX_CSV_BYTES + 1, "a".charCodeAt(0)));

      const adapter = createOpenOutreachAdapter({ exportDir: dir });
      const leads = await adapter.fetchLeads?.(10);
      expect(leads).toEqual([]);
    });

    it("still reads a CSV at or under the size cap", async () => {
      writeCsv("ok.csv", "name\nJane Doe\n");
      const adapter = createOpenOutreachAdapter({ exportDir: dir });
      const leads = await adapter.fetchLeads?.(10);
      expect(leads).toHaveLength(1);
    });
  });

  describe("F5: truncated export on disk", () => {
    it("fetchLeads() returns no leads (not a rejection) for a file with an unterminated quote", async () => {
      writeCsv("truncated.csv", 'name,company\n"Jane,Acme');
      const adapter = createOpenOutreachAdapter({ exportDir: dir });
      await expect(adapter.fetchLeads?.(10)).resolves.toEqual([]);
    });
  });
});
