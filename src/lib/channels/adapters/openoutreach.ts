/**
 * OpenOutreach inbound lead-source adapter.
 *
 * OpenOutreach (github.com/eracle/OpenOutreach) is a separate GPL-3.0 Python
 * process that does ICP-driven B2B lead discovery and writes its results to
 * CSV. Loop Engine is AGPL-3.0 TypeScript, so the two never share a process
 * or a codebase: this adapter only ever reads a CSV file that OpenOutreach
 * already produced. It must never shell into OpenOutreach or import any of
 * its code.
 *
 * This is an inbound source, not a channel that sends: it has no `send`
 * method at all, per the interface's note that `send` is optional for
 * exactly this reason.
 */
import { constants as fsConstants } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  AdapterCapabilities,
  ChannelAdapter,
  HealthReport,
  InboundLead,
} from "../types";
import { AdapterConfigError } from "../types";
import { parseCsv } from "./csv";

export interface OpenOutreachConfig {
  /** Directory OpenOutreach exports its lead CSVs into. */
  exportDir: string;
}

const ENV_VAR = "OPENOUTREACH_EXPORT_DIR";

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): OpenOutreachConfig {
  const exportDir = env[ENV_VAR];
  if (!exportDir) {
    throw new AdapterConfigError(
      "openoutreach",
      ENV_VAR,
      `Set ${ENV_VAR} to the directory OpenOutreach writes its exported lead CSVs into (its export output path).`,
    );
  }
  return { exportDir };
}

const CAPABILITIES: AdapterCapabilities = {
  // This adapter brings leads in; it never sends anything.
  actions: [],
  mode: "inbound",
  supportsMetrics: false,
  supportsReplies: false,
  requestsPerHour: null,
};

// Header aliases, matched case-insensitively. OpenOutreach's export schema
// is not pinned down across its templates, so every spelling it is known to
// use is accepted and anything else is ignored rather than rejected.
const NAME_KEYS = ["name", "full_name", "fullname"];
const TITLE_KEYS = ["title", "job_title", "position"];
const COMPANY_KEYS = ["company", "organization", "company_name"];
const EMAIL_KEYS = ["email"];
const LINKEDIN_KEYS = ["linkedin", "linkedin_url", "profile_url"];
const REASON_KEYS = ["reason", "why", "explanation"];
const SCORE_KEYS = ["score", "fit_score"];

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase();
}

function findColumn(headers: string[], keys: string[]): number | null {
  for (const key of keys) {
    const idx = headers.indexOf(key);
    if (idx !== -1) return idx;
  }
  return null;
}

function cellAt(row: string[], idx: number | null): string | undefined {
  if (idx === null) return undefined;
  return row[idx];
}

function nonEmpty(v: string | undefined): string | null {
  if (v === undefined) return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toScore(v: string | undefined): number | null {
  const s = nonEmpty(v);
  if (s === null) return null;
  const n = Number(s);
  // A non-numeric score is dropped to null rather than coerced to 0: zero is
  // a real, low fit score, and using it here would misrepresent "the source
  // didn't give a score" as "the source scored this lead at the bottom."
  return Number.isFinite(n) ? n : null;
}

/** Parses OpenOutreach CSV text into leads, stopping once `limit` is reached. */
export function parseLeads(csvText: string, limit: number): InboundLead[] {
  const rows = parseCsv(csvText);
  if (rows.length === 0) return [];

  const headerRow = rows[0] ?? [];
  const headers = headerRow.map(normalizeHeader);

  const nameIdx = findColumn(headers, NAME_KEYS);
  const titleIdx = findColumn(headers, TITLE_KEYS);
  const companyIdx = findColumn(headers, COMPANY_KEYS);
  const emailIdx = findColumn(headers, EMAIL_KEYS);
  const linkedinIdx = findColumn(headers, LINKEDIN_KEYS);
  const reasonIdx = findColumn(headers, REASON_KEYS);
  const scoreIdx = findColumn(headers, SCORE_KEYS);

  const leads: InboundLead[] = [];
  for (let r = 1; r < rows.length && leads.length < limit; r++) {
    const row = rows[r];
    if (!row) continue;

    const name = nonEmpty(cellAt(row, nameIdx));
    // A row with no usable name can't be shown to an operator as a lead, so
    // it is skipped rather than imported with a blank identity.
    if (name === null) continue;

    leads.push({
      name,
      title: nonEmpty(cellAt(row, titleIdx)),
      company: nonEmpty(cellAt(row, companyIdx)),
      email: nonEmpty(cellAt(row, emailIdx)),
      linkedinUrl: nonEmpty(cellAt(row, linkedinIdx)),
      reason: nonEmpty(cellAt(row, reasonIdx)),
      sourceScore: toScore(cellAt(row, scoreIdx)),
    });
  }

  return leads;
}

/** Returns the full path of the most recently modified .csv in `dir`, or null. */
async function mostRecentCsv(dir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }

  const csvNames = entries.filter((n) => n.toLowerCase().endsWith(".csv"));
  if (csvNames.length === 0) return null;

  let newestPath: string | null = null;
  let newestMtimeMs = -Infinity;
  for (const name of csvNames) {
    const full = join(dir, name);
    const info = await stat(full);
    if (info.mtimeMs > newestMtimeMs) {
      newestMtimeMs = info.mtimeMs;
      newestPath = full;
    }
  }
  return newestPath;
}

export function createOpenOutreachAdapter(config?: OpenOutreachConfig): ChannelAdapter {
  const cfg = config ?? configFromEnv();

  return {
    id: "openoutreach",
    capabilities: CAPABILITIES,

    async health(): Promise<HealthReport> {
      try {
        await access(cfg.exportDir, fsConstants.R_OK);
      } catch {
        return {
          reachable: false,
          detail:
            `Export directory ${cfg.exportDir} does not exist or is not readable. ` +
            `Run OpenOutreach's export step to create it, or set ${ENV_VAR} to the ` +
            `directory it actually writes CSVs into.`,
        };
      }

      const latest = await mostRecentCsv(cfg.exportDir);
      if (latest === null) {
        return {
          reachable: false,
          detail:
            `${cfg.exportDir} exists but contains no .csv files. ` +
            `Run OpenOutreach's export step to produce one before fetching leads.`,
        };
      }

      return { reachable: true, detail: `Most recent export: ${latest}.` };
    },

    async fetchLeads(limit: number): Promise<InboundLead[]> {
      const latest = await mostRecentCsv(cfg.exportDir);
      if (latest === null) return [];

      const text = await readFile(latest, "utf-8");
      return parseLeads(text, limit);
    },
  };
}
