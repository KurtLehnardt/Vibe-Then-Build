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
 * Strips credentials out of free text before it enters a reason or detail string.
 *
 * Three rules, applied in order:
 *
 * 1. URL userinfo (`user:pass@`). Redacting our own configured URL is not sufficient,
 *    because the text we interpolate alongside it is not ours. A fetch failure against
 *    a URL that carries credentials puts the whole credentialed URL into the error
 *    message, so a password reaches the health detail by way of `error.message` rather
 *    than by way of the URL we printed deliberately.
 * 2. Literal occurrences of the configured API key. This is the reliable rule, because
 *    the exact string is known; every occurrence of it is replaced regardless of the
 *    shape it is embedded in.
 * 3. A query-parameter pattern (`?apiKey=...`, `&token=...`, `&access_token=...`,
 *    `&authorization=...`). This is defense in depth for a credential that is not the
 *    one configured here (a different caller's key, a one-time token upstream issued),
 *    not a guarantee: a body that echoes a secret under some other shape still gets
 *    through. The only real guarantee against an echoed secret is not forwarding the
 *    body at all, which is why a 401/403 response is dropped entirely below instead of
 *    being scrubbed.
 */
function scrubCredentials(text: string, apiKey: string): string {
  let scrubbed = text.replace(/\/\/[^/\s@]+@/g, "//***@");
  if (apiKey) {
    scrubbed = scrubbed.split(apiKey).join("***");
  }
  scrubbed = scrubbed.replace(
    /([?&])(api[-_]?key|token|access_token|authorization)=[^&\s]+/gi,
    "$1$2=***",
  );
  return scrubbed;
}

/**
 * Builds the function every piece of text that originates outside this process passes
 * through. A factory rather than a bare function because the literal-key rule in
 * `scrubCredentials` needs the configured API key, and nothing module-level has access
 * to it. Truncates after scrubbing, not before: truncating first can cut the text
 * before the part the scrubber would have matched, letting a credential past the
 * 500-character boundary survive in the slice that remains.
 */
function createExternalScrubber(apiKey: string): (text: string) => string {
  return (text: string) => truncate(scrubCredentials(text, apiKey));
}

/** Upper bound for a parsed Retry-After, in seconds: one day. Node's `setTimeout`
 * silently clamps any delay above INT32_MAX milliseconds (~24.8 days) down to 1ms
 * instead of throwing, so an unbounded Retry-After does not fail safe — it produces
 * exactly the hot immediate-retry loop the lower (non-negative) clamp exists to
 * prevent, just reached from the top of the range instead of the bottom. Measured:
 * `Retry-After: 2147484` (2,147,484s) fires a `setTimeout` after 0ms;
 * `99999999999999999999` fires after 2ms; an HTTP-date of `Fri, 31 Dec 9999 23:59:59
 * GMT` (~2.5e11s away) fires after 1ms. One day is generous for any legitimate
 * Retry-After and well clear of the clamp threshold. */
const MAX_RETRY_AFTER_SECONDS = 86_400;

/** Clamps a parsed Retry-After to a non-negative whole number of seconds no greater
 * than MAX_RETRY_AFTER_SECONDS. */
function clampRetryAfterSeconds(seconds: number): number {
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(0, Math.round(seconds)));
}

/**
 * Accepts a numeric Retry-After only when it is a plain non-negative integer string
 * (optionally surrounded by whitespace) — no sign, no decimal point, no hex. `Number()`
 * alone would also accept "-5", "1.75", and "0x20", none of which Retry-After's
 * seconds-form permits. Both the numeric and the HTTP-date branch finish by clamping to
 * a non-negative whole number of seconds no greater than MAX_RETRY_AFTER_SECONDS, so the
 * two branches agree on what they mean: a negative or fractional value here reaches a
 * caller's `setTimeout(seconds * 1000)` directly, a negative delay fires immediately
 * into a hot retry loop against whatever just rate-limited us, and an oversized one
 * does too by way of Node's own setTimeout clamp (see MAX_RETRY_AFTER_SECONDS above).
 */
function parseRetryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    return clampRetryAfterSeconds(Number(trimmed));
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
    return clampRetryAfterSeconds(deltaMs / 1000);
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
 * There is no `group` field, and none should be added. `subjectId` was considered for
 * it, but `group` is not part of Postiz's verified payload schema, Postiz has an open
 * issue about the public API mishandling `posts[].group`, and its create path is a
 * create-or-update keyed on group — so a stable value there could make a retried send
 * silently replace the earlier post instead of preventing a duplicate, or be rejected
 * outright by a whitelisting DTO. No production caller reads it back either. Unverified
 * upstream behavior for zero present benefit is the wrong trade. Postiz's public API
 * exposes no idempotency key of any kind; see the comment on the fetch-failure path in
 * `send` below for what that means for duplicate posts.
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
        },
      ],
    },
  };
}

export function createPostizAdapter(config?: PostizConfig): ChannelAdapter {
  const cfg = config ?? configFromEnv(process.env);
  const base = apiBase(cfg.url);
  const timeoutMs = cfg.timeoutMs ?? 10_000;
  const external = createExternalScrubber(cfg.apiKey);

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
      // a second, publicly-visible post rather than merely repeating a no-op. Postiz's
      // public API exposes no idempotency key, so nothing in this adapter, and nothing
      // upstream, prevents that duplicate. Preventing it is the caller's responsibility:
      // the caller must record its own send attempts against `message.subjectId` and
      // check that record before honoring this `retry` outcome. This comment must not be
      // read as implying that upstream, or this adapter, already does that job.
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
