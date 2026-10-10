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
import { AdapterConfigError, UnsupportedActionError } from "../types";
import type { ActionType } from "../../policy/levels";

const ADAPTER_ID = "postiz" as const;
const SUPPORTED_ACTIONS: readonly ActionType[] = ["linkedin.post"];

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

/** Parses Retry-After as whole seconds. Returns null rather than guessing when the header is absent or unparseable. */
function parseRetryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds;
  // Retry-After may also be an HTTP date; fall back to the delta from now.
  const asDate = Date.parse(raw);
  if (!Number.isNaN(asDate)) {
    const deltaMs = asDate - Date.now();
    return deltaMs > 0 ? Math.round(deltaMs / 1000) : 0;
  }
  return null;
}

/**
 * Postiz's response shape for a created post is not pinned down across
 * versions, so we look for the most plausible id field in order rather than
 * assuming one. Returning null here (instead of throwing) keeps a successful
 * send from failing just because we could not identify its id.
 */
function extractExternalId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const candidates = [obj.id, obj.postId, obj.post_id, obj.integrationId];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
    if (typeof candidate === "number") return String(candidate);
  }
  // Some endpoints wrap the created resource in a "data" or "post" envelope.
  const nested = obj.data ?? obj.post;
  if (nested && typeof nested === "object") return extractExternalId(nested);
  return null;
}

/** Builds the Postiz create-post payload. `scheduledFor` present means "schedule"; absent means send as soon as Postiz will take it. */
function toPostizPayload(message: OutboundMessage): Record<string, unknown> {
  const integrationId = message.meta?.integrationId ?? message.meta?.channelId ?? null;
  return {
    type: message.scheduledFor ? "schedule" : "now",
    date: message.scheduledFor ? message.scheduledFor.toISOString() : undefined,
    content: message.body,
    integration: integrationId !== null ? { id: integrationId } : undefined,
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
    supportsMetrics: true,
    supportsReplies: false,
    requestsPerHour: 90,
  };

  async function send(message: OutboundMessage): Promise<SendOutcome> {
    if (!SUPPORTED_ACTIONS.includes(message.actionType)) {
      throw new UnsupportedActionError(ADAPTER_ID, message.actionType, SUPPORTED_ACTIONS);
    }

    let res: Response;
    try {
      res = await fetch(`${base}/posts`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(toPostizPayload(message)),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // A network failure or timeout is transient by nature: the request may
      // never have reached Postiz, so retrying it is safe and correct.
      const detail = err instanceof Error ? err.message : String(err);
      return { status: "retry", reason: `Could not reach Postiz: ${detail}`, retryAfterSeconds: null };
    }

    if (res.ok) {
      const body: unknown = await res.json().catch(() => null);
      return { status: "sent", externalId: extractExternalId(body), sentAt: new Date() };
    }

    const bodyText = await res.text().catch(() => "");

    if (res.status === 429 || res.status >= 500) {
      // 429 and 5xx are upstream's way of saying "not now" rather than "no":
      // the same request will very likely succeed later, so it is retryable.
      return {
        status: "retry",
        reason: `Postiz returned ${res.status}. Body: ${bodyText}`,
        retryAfterSeconds: parseRetryAfterSeconds(res.headers),
      };
    }

    // Any other 4xx means the request itself was wrong (bad payload, auth,
    // unknown integration). Retrying an identical request will fail the same
    // way, so this is rejected rather than queued for retry.
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
        detail: `Could not reach Postiz at ${cfg.url}: ${detail}. If it is not running, start it with "docker compose up -d postiz".`,
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
