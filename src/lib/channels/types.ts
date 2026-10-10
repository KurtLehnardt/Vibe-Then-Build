/**
 * Channel adapter interface.
 *
 * A channel is anything that can carry an action to the outside world, or
 * bring work in from it. Adapters are deliberately thin: they translate
 * between Loop Engine's own types and one external system, and they never
 * decide whether something may send. That decision belongs to the policy
 * engine, which runs before any adapter is called.
 *
 * Every integration lives behind this interface so that swapping one for
 * another is configuration rather than a code change. Publishing through
 * Postiz today and something else tomorrow should touch one env var.
 */
import type { ActionType } from "../policy/levels";

export type ChannelId = "postiz" | "smtp" | "gmail" | "linkedin-assisted" | "openoutreach";

/**
 * How an adapter reaches its target.
 *
 * - "api" sends unattended over an official interface.
 * - "assisted" prepares the message and records it, but a person performs the
 *   send from their own session. Used where a platform's terms forbid
 *   software-driven sending.
 * - "inbound" does not send at all; it brings leads or opportunities in.
 */
export type SendMode = "api" | "assisted" | "inbound";

export interface AdapterCapabilities {
  /** Actions this adapter can carry. Anything else is rejected outright. */
  actions: readonly ActionType[];
  mode: SendMode;
  /** True when the adapter can report back on what it sent. */
  supportsMetrics: boolean;
  /** True when the adapter can poll for replies. */
  supportsReplies: boolean;
  /** Adapter-side rate limit, if it publishes one. Informational. */
  requestsPerHour: number | null;
}

export interface OutboundMessage {
  actionType: ActionType;
  /** Loop Engine's own id for the draft or touch being sent. */
  subjectId: string;
  body: string;
  /** Subject line for email; ignored by adapters that have no concept of it. */
  subject?: string;
  /** Recipient address or handle. Absent for broadcast posts. */
  to?: string;
  /** When to send. Absent means as soon as the adapter will take it. */
  scheduledFor?: Date;
  /** Adapter-specific extras, validated by the adapter, never by the caller. */
  meta?: Record<string, unknown>;
}

export type SendOutcome =
  /** The adapter accepted it and it is sent or queued upstream. */
  | { status: "sent"; externalId: string | null; sentAt: Date }
  /** The adapter prepared it; a person must complete the send. */
  | { status: "prepared"; instructions: string; payload: Record<string, unknown> }
  /** The adapter refused. Retrying the identical request will fail again. */
  | { status: "rejected"; reason: string }
  /** A transient upstream failure. Safe and correct to retry later. */
  | { status: "retry"; reason: string; retryAfterSeconds: number | null };

export interface InboundLead {
  name: string;
  title?: string | null;
  company?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
  /** Why the source believes this lead fits. Kept verbatim for the operator. */
  reason?: string | null;
  /** Source-assigned fit score, 0-100, if the source produces one. */
  sourceScore?: number | null;
}

export interface HealthReport {
  reachable: boolean;
  /** Plain-language detail, and when unreachable, the command that fixes it. */
  detail: string;
}

/**
 * Adapters implement only what they can do. A publishing adapter has no
 * `fetchLeads`; an inbound source has no `send`. Callers check for the method
 * rather than relying on a capability flag alone, so a misconfigured adapter
 * fails at the call site instead of halfway through a sequence.
 */
export interface ChannelAdapter {
  readonly id: ChannelId;
  readonly capabilities: AdapterCapabilities;

  /** Confirms the adapter is configured and its upstream is reachable. */
  health(): Promise<HealthReport>;

  /** Present on adapters whose mode is "api" or "assisted". */
  send?(message: OutboundMessage): Promise<SendOutcome>;

  /** Present on adapters whose mode is "inbound". */
  fetchLeads?(limit: number): Promise<InboundLead[]>;
}

/** Thrown when required configuration is missing, naming the env var to set. */
export class AdapterConfigError extends Error {
  constructor(adapter: ChannelId, missing: string, hint: string) {
    super(`Adapter "${adapter}" needs ${missing}. ${hint}`);
    this.name = "AdapterConfigError";
  }
}
