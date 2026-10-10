/**
 * Postiz publishing adapter.
 *
 * Postiz (self-hosted) exposes a public API at `{POSTIZ_URL}/public/v1`,
 * authenticated with an API key in the `Authorization` header. This adapter
 * only carries `linkedin.post` for now; Postiz supports more networks, but
 * until another action is wired up and tested here, claiming support for it
 * would be a lie the policy engine could act on.
 *
 * The create-post endpoint is rate limited upstream to 90 requests/hour on a
 * self-hosted instance by default (tunable there via Postiz's own
 * `API_LIMIT`). We report that number as `requestsPerHour` so callers can
 * throttle before they get a 429, but we do not enforce it ourselves — this
 * adapter is stateless and has no queue to hold work back with.
 */
import type {
  AdapterCapabilities,
  ChannelAdapter,
  HealthReport,
  OutboundMessage,
  SendOutcome,
} from "../types";
import { AdapterConfigError } from "../types";
import type { ActionType } from "../../policy/levels";

const ADAPTER_ID = "postiz" as const;
const SUPPORTED_ACTIONS: readonly ActionType[] = ["linkedin.post"];

/**
 * Postiz's `settings.__type` must name the provider the post goes to; it is not
 * inferred from the integration id. Only `linkedin.post` is wired up today, so this is
 * a constant rather than a map — add an entry (and a test freezing its payload) before
 * adding a second action here.
 */
const POSTIZ_SETTINGS_TYPE = "linkedin";

/** Upstream bodies are unbounded in principle and have been observed in the megabytes;
 * truncate before any of it enters a `reason` or `detail` string headed for a database
 * column or a log line. */
const MAX_REASON_BODY_CHARS = 500;

/**
 * Exactly these statuses are retryable. 408 (Request Timeout) and 425 (Too Early) are
 * the client/server equivalent of "try again", not "this request is wrong" — unlike
 * 501 (Not Implemented) and 505 (HTTP Version Not Supported), which describe something
 * that fails identically on every retry. 409 (Conflict) stays out of this set too: it
 * means the request collided with current state, which an identical retry will not
 * fix.
 */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface PostizConfig {
  /** Base URL of the Postiz instance, e.g. "http://localhost:5000". No trailing slash required. */
  url: string;
  apiKey: string;
  /** Milliseconds before a request to Postiz is abandoned. Defaults to 10s. */
  timeoutMs?: number;
}

/** Reads POSTIZ_URL and POSTIZ_API_KEY, throwing a specific, actionable error for whichever is missing. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): PostizConfig {
  const url = env.POSTIZ_URL;
  const apiKey = env.POSTIZ_API_KEY;
  if (!url) {
    throw new AdapterConfigError(
      ADAPTER_ID,
      "POSTIZ_URL",
      "Set it to the base URL of your self-hosted Postiz instance, e.g. http://localhost:5000.",
    );
  }
  if (!apiKey) {
    throw new AdapterConfigError(
      ADAPTER_ID,
      "POSTIZ_API_KEY",
      "Generate one in Postiz under Settings → Public API, then set POSTIZ_API_KEY.",
    );
  }
  return { url, apiKey };
}

function apiBase(url: string): string {
  return `${url.replace(/\/+$/, "")}/public/v1`;
}

/** Strips userinfo (user:pass@) out of a URL before it appears in any message. A
 * credential embedded in POSTIZ_URL (e.g. http://admin:hunter2@postiz.internal:5000)
 * must never leak into a health detail or a log line. Falls back to the raw string if
 * it does not parse as a URL. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Truncates upstream body text to MAX_REASON_BODY_CHARS before it enters a reason or
 * detail string. */
function truncate(text: string): string {
  return text.length > MAX_REASON_BODY_CHARS ? `${text.slice(0, MAX_REASON_BODY_CHARS)}…` : text;
}

/**
 * Strips userinfo out of any URL appearing in free text.
 *
 * Redacting our own configured URL is not sufficient, because the text we
 * interpolate alongside it is not ours. A fetch failure against a URL that
 * carries credentials puts the whole credentialed URL into the error message,
 * so a password reaches the health detail by way of `error.message` rather
 * than by way of the URL we printed deliberately. Scrubbing at the boundary
 * where external text enters a message catches both paths, and any future one.
 */
function scrubCredentials(text: string): string {
  return text.replace(/\/\/[^/\s@]+@/g, "//***@");
}

/** Every piece of text that originates outside this process passes through here. */
function external(text: string): string {
  return scrubCredentials(truncate(text));
}

/**
 * Accepts a numeric Retry-After only when it is a plain non-negative integer string
 * (optionally surrounded by whitespace) — no sign, no decimal point, no hex. `Number()`
 * alone would also accept "-5", "1.75", and "0x20", none of which Retry-After's
 * seconds-form permits. Both the numeric and the HTTP-date branch finish by clamping to
 * a non-negative whole number of seconds, so the two branches agree on what they mean:
 * a negative or fractional value here reaches a caller's `setTimeout(seconds * 1000)`
 * directly, and a negative delay fires immediately into a hot retry loop against
 * whatever just rate-limited us.
 */
function parseRetryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.max(0, Math.round(Number(trimmed)));
  }
  // A value that looks like a number but is not a plain non-negative integer is
  // malformed, and malformed means "no guidance" rather than "retry immediately".
  // This case is excluded explicitly because Date.parse would otherwise accept it:
  // Date.parse("-5") returns May 2001, a past date, which would clamp to zero and
  // send the caller straight back at a server that just asked it to wait.
  if (/^[+-]?[\d.]+$/.test(trimmed)) return null;

  // Retry-After may also be an HTTP date; fall back to the delta from now.
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    const deltaMs = asDate - Date.now();
    return Math.max(0, Math.round(deltaMs / 1000));
  }
  return null;
}

/**
 * Postiz's response shape for a created post is not pinned down across versions, so we
 * look for the most plausible id field in order rather than assuming one. The `data` or
 * `post` envelope is checked before a bare `id`/`postId` on the current object, and
 * recursed into when present — Postiz nests the created resource there, and an array at
 * either level is unwrapped by taking its first element. `integrationId` is never a
 * candidate: it names the channel the post went through, not the post itself, so
 * treating it as a plausible id would record every post sent through one channel under
 * that channel's own id. Returning null here (instead of throwing) keeps a successful
 * send from failing just because we could not identify its id.
 */
function extractExternalId(body: unknown): string | null {
  if (Array.isArray(body)) {
    return body.length > 0 ? extractExternalId(body[0]) : null;
  }
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;

  const envelope = obj.data ?? obj.post;
  if (envelope !== undefined) {
    return extractExternalId(envelope);
  }

  const candidates = [obj.id, obj.postId, obj.post_id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
    if (typeof candidate === "number") return String(candidate);
  }
  return null;
}

/** A 2xx response can still wrap a failure. An `error` or `errors` field is treated as
 * proof of that regardless of status code; anything else with no recognizable id stays
 * `sent` with `externalId: null` rather than inventing a failure that was not reported. */
function hasErrorIndicator(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const obj = body as Record<string, unknown>;
  return obj.error != null || obj.errors != null;
}

type PayloadResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * Builds the Postiz create-post payload. `scheduledFor` present means "schedule";
 * absent means send as soon as Postiz will take it, which still requires a concrete
 * `date` — Postiz's schema has no "now" sentinel for that field, so the current time is
 * sent explicitly.
 *
 * `meta.integrationId` (or `meta.channelId`) is the only adapter-specific extra this
 * adapter reads, and `types.ts` promises callers that `meta` is validated by the
 * adapter, never by the caller — so anything other than a string or a number here is
 * rejected rather than forwarded, and a missing id is rejected rather than posted as
 * `undefined`.
 *
 * `posts[0].group` carries `subjectId`, Loop Engine's own id for the draft being sent.
 * Postiz has no idempotency-key field in its public schema, so `group` is the only
 * place a stable key fits. Treat it as a correlation id for our own records, not as
 * upstream de-duplication: Postiz has an open issue about the public API mishandling
 * `posts[].group`, so nothing here may assume Postiz acts on it. Preventing a
 * duplicate post is the caller's job, and the key is what makes that check possible.
 */
function toPostizPayload(message: OutboundMessage): PayloadResult {
  const rawId = message.meta?.integrationId ?? message.meta?.channelId;
  if (rawId === undefined || rawId === null) {
    return {
      ok: false,
      reason:
        "Postiz requires an integration id. Set message.meta.integrationId (or meta.channelId) to the target channel's id.",
    };
  }
  if (typeof rawId !== "string" && typeof rawId !== "number") {
    return {
      ok: false,
      reason: `Postiz requires message.meta.integrationId (or meta.channelId) to be a string or number; received ${typeof rawId}.`,
    };
  }

  const date = message.scheduledFor ?? new Date();

  return {
    ok: true,
    payload: {
      type: message.scheduledFor ? "schedule" : "now",
      date: date.toISOString(),
      shortLink: false,
      tags: [],
      posts: [
        {
          integration: { id: rawId },
          value: [{ content: message.body, image: [] }],
          settings: { __type: POSTIZ_SETTINGS_TYPE },
          group: message.subjectId,
        },
      ],
    },
  };
}

export function createPostizAdapter(config?: PostizConfig): ChannelAdapter {
  const cfg = config ?? configFromEnv(process.env);
  const base = apiBase(cfg.url);
  const timeoutMs = cfg.timeoutMs ?? 10_000;

  function headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: cfg.apiKey,
    };
  }

  const capabilities: AdapterCapabilities = {
    actions: SUPPORTED_ACTIONS,
    mode: "api",
    // This adapter has no method that reports back on what it sent, and `ChannelAdapter`
    // has no slot for one today; claiming otherwise would be a lie the policy engine
    // could act on, same as claiming an unsupported action would be.
    supportsMetrics: false,
    supportsReplies: false,
    requestsPerHour: 90,
  };

  async function send(message: OutboundMessage): Promise<SendOutcome> {
    if (!SUPPORTED_ACTIONS.includes(message.actionType)) {
      // `SendOutcome` already has a status for exactly this case — "rejected" is
      // documented as "retrying the identical request will fail again", which is true
      // of an unsupported action — and the sibling OpenOutreach adapter has no
      // throwing path at all. Throwing here was an inconsistent seam; report it the
      // same way every other rejection is reported instead.
      return {
        status: "rejected",
        reason: `Adapter "${ADAPTER_ID}" does not support action "${message.actionType}". It supports: ${SUPPORTED_ACTIONS.join(", ") || "nothing"}.`,
      };
    }

    const payloadResult = toPostizPayload(message);
    if (!payloadResult.ok) {
      return { status: "rejected", reason: payloadResult.reason };
    }

    let res: Response;
    try {
      res = await fetch(`${base}/posts`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payloadResult.payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // A network failure or client-side abort is transient by nature, but "transient"
      // is not "harmless": the request may have already reached Postiz and been queued
      // before the response (or the connection) was lost, so a retry here can produce
      // a second, publicly-visible post rather than merely repeating a no-op. That is
      // exactly why toPostizPayload attaches `group` from `subjectId`. The caller must
      // check for an already-published post carrying that key before honoring this
      // retry; Postiz is not known to de-duplicate on `group` and must not be relied
      // on to do it.
      const detail = err instanceof Error ? err.message : String(err);
      return {
        status: "retry",
        reason: `Could not reach Postiz: ${external(detail)}`,
        retryAfterSeconds: null,
      };
    }

    if (res.ok) {
      const body: unknown = await res.json().catch(() => null);
      if (hasErrorIndicator(body)) {
        return {
          status: "rejected",
          reason: `Postiz returned ${res.status} but the body carries an error: ${external(JSON.stringify(body))}`,
        };
      }
      return { status: "sent", externalId: extractExternalId(body), sentAt: new Date() };
    }

    if (res.status === 401 || res.status === 403) {
      // Never forward the upstream body for an auth failure: Postiz's error payloads
      // have been observed to echo back the API key it just rejected, and that would
      // put the credential into a persisted reason. A fixed, actionable message is
      // sent instead, matching what health() already does for the same two statuses.
      return {
        status: "rejected",
        reason: `Postiz rejected the API key (${res.status}). Check POSTIZ_API_KEY against Postiz Settings → Public API.`,
      };
    }

    const bodyText = external(await res.text().catch(() => ""));

    if (RETRYABLE_STATUSES.has(res.status)) {
      return {
        status: "retry",
        reason: `Postiz returned ${res.status}. Body: ${bodyText}`,
        retryAfterSeconds: parseRetryAfterSeconds(res.headers),
      };
    }

    // Any other 4xx (or an unrecognized 5xx such as 501/505) means the request itself
    // was wrong, or fails for a reason a retry cannot change. Retrying an identical
    // request will fail the same way, so this is rejected rather than queued for retry.
    return {
      status: "rejected",
      reason: `Postiz rejected the request with ${res.status}. Body: ${bodyText}`,
    };
  }

  async function health(): Promise<HealthReport> {
    try {
      const res = await fetch(`${base}/channels`, {
        method: "GET",
        headers: headers(),
        signal: AbortSignal.timeout(Math.min(timeoutMs, 5_000)),
      });

      if (res.ok) {
        return { reachable: true, detail: "Postiz responded to /public/v1/channels." };
      }

      if (res.status === 401 || res.status === 403) {
        return {
          reachable: false,
          detail: `Postiz rejected the API key (${res.status}). Check POSTIZ_API_KEY against Postiz Settings → Public API.`,
        };
      }

      return {
        reachable: false,
        detail: `Postiz returned ${res.status} from /public/v1/channels. If it is not running, start it with "docker compose up -d postiz".`,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        reachable: false,
        detail: `Could not reach Postiz at ${redactUrl(cfg.url)}: ${external(detail)}. If it is not running, start it with "docker compose up -d postiz".`,
      };
    }
  }

  return {
    id: ADAPTER_ID,
    capabilities,
    health,
    send,
  };
}
