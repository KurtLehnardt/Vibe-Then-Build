import type { Dirent } from "node:fs";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterConfigError } from "../types";
import { UnterminatedQuoteError } from "./csv";
import { MAX_CSV_BYTES, configFromEnv, createOpenOutreachAdapter, parseLeads } from "./openoutreach";

// F5 mutant #2 (mtime tie-break `>` -> `>=`): reverses whatever order the
// real readdir returns, so the tie-break test below cannot pass merely
// because this host's filesystem happens to return directory entries
// already sorted by name (true on APFS, not guaranteed on every host). Every
// other test in this file still gets real directory contents, just in the
// opposite of whatever native order the host produces, which is exactly the
// condition that would expose an order-dependent implementation.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const genericReaddir = actual.readdir as (...args: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    readdir: vi.fn(async (...args: unknown[]) => {
      const result = await genericReaddir(...args);
      return Array.isArray(result) ? [...result].reverse() : result;
    }),
  };
});

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

/**
 * Builds CSV text that is exactly `totalBytes` long (in UTF-8, so plain
 * ASCII keeps this exact) and whose one data row would actually import a
 * lead if read. Used by the size-cap tests below instead of a fixture made
 * of one repeated character with no newline, which parses to a header row
 * and zero leads whether the cap exists or not — a fixture that size-cap
 * tests must not use, since it can't tell a working cap apart from a broken
 * one.
 */
function csvOfExactSize(totalBytes: number): string {
  const header = "name,padding\n";
  const prefix = "Jane Doe,";
  const suffix = "\n";
  const paddingLength = totalBytes - header.length - prefix.length - suffix.length;
  if (paddingLength < 0) {
    throw new Error(`csvOfExactSize: ${totalBytes} bytes is too small for this fixture's scaffolding`);
  }
  return header + prefix + "a".repeat(paddingLength) + suffix;
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

  it("recognizes a UTF-8 BOM immediately followed by a quoted header row", () => {
    // F1 regression: Excel's "CSV UTF-8" export and Python's
    // `encoding="utf-8-sig"` with `csv.QUOTE_ALL` both produce a BOM
    // immediately followed by a quoted header. Before the fix, the BOM
    // counted as the header field's first character, so the opening quote
    // right after it read as a literal character instead of opening a
    // quoted section; the header field came out as `"name"` with the quotes
    // retained, matched no known column name, and every row was skipped as
    // nameless, importing zero leads. An unquoted-header BOM alone could not
    // catch this, because trimming away the BOM happened to work by
    // accident in that shape.
    const csv = '﻿"name","email"\r\n"Jane Doe","jane@acme.com"\r\n';
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
    const health = await adapter.health();
    expect(health.reachable).toBe(false);
    // The name of this test has always claimed to cover R_OK vs. F_OK, but
    // the body used to assert only `reachable: false`, which an F_OK mutant
    // also produces: F_OK succeeds against a chmod 000 directory (it still
    // exists), so the code falls through to readdir, which then fails with
    // EACCES, landing on `reachable: false` via the empty-directory branch
    // instead — same verdict, wrong reason. Asserting the detail text is
    // what actually tells the two branches apart, and so what actually
    // proves this is checking R_OK rather than F_OK.
    expect(health.detail).toContain("not readable");
    expect(health.detail).not.toContain("no .csv files");

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

    it("follows a symlink even when its target lives outside the export directory (no containment guarantee)", async () => {
      // F4: this test used to assert the opposite and called it a security
      // property. That was never actually true — a hardlink passes
      // info.isFile() exactly like any other regular file, and exportDir
      // itself can be a symlink that readdir follows regardless — and the
      // only reason the old assertion held was that the dirent-based filter
      // (d.isFile()) rejected every symlink, full stop, including the
      // extremely common `latest.csv -> export-N.csv` layout a real
      // OpenOutreach deployment uses. Filtering on stat's result instead
      // means a resolvable symlink is now accepted, wherever it points; see
      // mostRecentCsv's comment for what is and is not guaranteed.
      const outside = mkdtempSync(join(tmpdir(), "openoutreach-outside-"));
      try {
        const target = join(outside, "secret.csv");
        writeFileSync(target, "name\nJane Doe\n");
        symlinkSync(target, join(dir, "evil.csv"));

        const adapter = createOpenOutreachAdapter({ exportDir: dir });
        const leads = await adapter.fetchLeads?.(10);
        expect(leads).toHaveLength(1);
        expect(leads?.[0]?.name).toBe("Jane Doe");
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("follows a stable latest.csv symlink pointing at a timestamped export in the same directory", async () => {
      // F4 proven problem #1: an extremely common export layout is a
      // `latest.csv` symlink pointing at a timestamped export file. The old
      // dirent filter reported this directory as containing no .csv files
      // at all, which was actively false.
      writeCsv("export-20260101.csv", "name\nJane Doe\n");
      symlinkSync(join(dir, "export-20260101.csv"), join(dir, "latest.csv"));

      const adapter = createOpenOutreachAdapter({ exportDir: dir });
      const health = await adapter.health();
      expect(health.reachable).toBe(true);

      const leads = await adapter.fetchLeads?.(10);
      expect(leads).toHaveLength(1);
      expect(leads?.[0]?.name).toBe("Jane Doe");
    });

    it("finds a CSV even when the dirent's type bit is unavailable (UV_DIRENT_UNKNOWN, as on some network mounts and XFS configurations)", async () => {
      // F4 proven problem #2. The current code never calls the dirent's
      // own isFile(); forcing it to false here and still finding the file
      // is what proves that.
      writeCsv("leads.csv", "name\nJane Doe\n");
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      // Cast away the overloaded signature of `readdir` itself: this mock
      // implementation's return type only needs to satisfy what
      // `mostRecentCsv` actually reads off each entry (`.name`), not every
      // overload `fs.promises.readdir` can take.
      const mockReaddir = readdir as unknown as {
        mockImplementationOnce: (fn: (...args: unknown[]) => Promise<unknown>) => void;
      };
      mockReaddir.mockImplementationOnce(async (...args: unknown[]) => {
        const genericReaddir = actual.readdir as (...args: unknown[]) => Promise<unknown>;
        const entries = (await genericReaddir(...args)) as Dirent[];
        return entries.map((d) => ({ ...d, isFile: () => false }));
      });

      const adapter = createOpenOutreachAdapter({ exportDir: dir });
      const leads = await adapter.fetchLeads?.(10);
      expect(leads).toHaveLength(1);
      expect(leads?.[0]?.name).toBe("Jane Doe");
    });

    it("mutant guard: a directory named *.csv does not shadow a real CSV even when the directory is newer", async () => {
      // F5 mutant #1 (deleting the per-entry stat guard entirely). The
      // existing *.csv-subdirectory test above writes the directory first
      // and the real file after, so the real file is already the newest by
      // mtime and that test would pass even with the guard deleted. Here
      // the directory is created after the real file specifically so it has
      // the later mtime, making the guard load-bearing: without it, the
      // directory would win the tie-break ahead of the real export.
      writeCsv("real.csv", "name\nJane Doe\n", new Date("2020-01-01T00:00:00Z"));
      await mkdir(join(dir, "archive.csv"));

      const adapter = createOpenOutreachAdapter({ exportDir: dir });
      const leads = await adapter.fetchLeads?.(10);
      expect(leads).toHaveLength(1);
      expect(leads?.[0]?.name).toBe("Jane Doe");
    });

    it("matches a .CSV extension case-insensitively", async () => {
      // F5 mutant #4 (case-sensitive extension matching).
      writeCsv("LEADS.CSV", "name\nJane Doe\n");
      const adapter = createOpenOutreachAdapter({ exportDir: dir });
      const leads = await adapter.fetchLeads?.(10);
      expect(leads).toHaveLength(1);
      expect(leads?.[0]?.name).toBe("Jane Doe");
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
      // F5 mutant #3: the previous fixture here was 64 MB of `a` with no
      // newline, which parses to a header row and zero leads whether the
      // cap exists or not — `toEqual([])` passed either way, so this test
      // never actually exercised the cap. This fixture's row would import a
      // lead if read, so the empty result here is only explained by the cap.
      const oversized = join(dir, "huge.csv");
      writeFileSync(oversized, csvOfExactSize(MAX_CSV_BYTES + 1));

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

    it("still reads a CSV whose size is exactly at the cap (boundary, not vacuous)", async () => {
      // F5 mutant #3's other half: `>` becoming `>=` at the boundary check
      // only shows up at exactly MAX_CSV_BYTES, not comfortably under it.
      const atCap = csvOfExactSize(MAX_CSV_BYTES);
      expect(Buffer.byteLength(atCap, "utf-8")).toBe(MAX_CSV_BYTES);
      writeFileSync(join(dir, "at-cap.csv"), atCap);

      const adapter = createOpenOutreachAdapter({ exportDir: dir });
      const leads = await adapter.fetchLeads?.(10);
      expect(leads).toHaveLength(1);
      expect(leads?.[0]?.name).toBe("Jane Doe");
    });
  });

  describe("F3: health() applies the same gates fetchLeads does", () => {
    it("reports unreachable for a truncated export, naming the file and the problem", async () => {
      const truncated = writeCsv("truncated.csv", 'name,company\n"Jane,Acme');
      const adapter = createOpenOutreachAdapter({ exportDir: dir });

      const health = await adapter.health();
      expect(health.reachable).toBe(false);
      expect(health.detail).toContain(truncated);
      expect(health.detail).toContain("truncated");

      // The point of F3: health() and fetchLeads() must agree. Before the
      // fix, health() reported reachable: true for this exact file while
      // fetchLeads returned nothing, indefinitely.
      const leads = await adapter.fetchLeads?.(10);
      expect(leads).toEqual([]);
    });

    it("reports unreachable for an oversized export, naming the file and the cap", async () => {
      const oversized = join(dir, "huge.csv");
      writeFileSync(oversized, csvOfExactSize(MAX_CSV_BYTES + 1));
      const adapter = createOpenOutreachAdapter({ exportDir: dir });

      const health = await adapter.health();
      expect(health.reachable).toBe(false);
      expect(health.detail).toContain(oversized);
      expect(health.detail).toContain("64 MB");

      const leads = await adapter.fetchLeads?.(10);
      expect(leads).toEqual([]);
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
