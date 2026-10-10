/**
 * Adapter registry.
 *
 * Resolves which adapter carries which action, from configuration alone. The
 * registry is the reason swapping an integration is an env change rather than
 * a code change: nothing in the application names a concrete adapter.
 *
 * Two behaviors here are deliberate and worth stating.
 *
 * An adapter whose configuration is absent is not an error. It is recorded as
 * unavailable, with the reason, and the rest of the registry works. Running
 * Loop Engine without Postiz is a legitimate configuration, not a broken one.
 *
 * Ambiguity, by contrast, is an error. If two configured adapters both claim
 * an action, the registry refuses to pick for you and names the env var that
 * settles it. Silently choosing one would mean posts going somewhere the
 * operator did not intend, which is worse than a startup failure.
 */
import type { ActionType } from "../policy/levels";
import {
  configFromEnv as openOutreachConfigFromEnv,
  createOpenOutreachAdapter,
} from "./adapters/openoutreach";
import { configFromEnv as postizConfigFromEnv, createPostizAdapter } from "./adapters/postiz";
import { AdapterConfigError, type ChannelAdapter, type ChannelId, type HealthReport } from "./types";

type AdapterFactory = (env: NodeJS.ProcessEnv) => ChannelAdapter;

/**
 * Every adapter this build knows how to construct.
 *
 * Each factory reads the env map it is handed rather than `process.env`, so a
 * registry can be built against any environment — which is what makes this
 * testable without mutating the real process.
 */
const FACTORIES: Partial<Record<ChannelId, AdapterFactory>> = {
  postiz: (env) => createPostizAdapter(postizConfigFromEnv(env)),
  openoutreach: (env) => createOpenOutreachAdapter(openOutreachConfigFromEnv(env)),
};

export interface Unavailable {
  id: ChannelId;
  /** Why it could not be constructed, in terms the operator can act on. */
  reason: string;
}

export interface Registry {
  available: ChannelAdapter[];
  unavailable: Unavailable[];
  /** The adapter that carries this action, or null when none is configured. */
  senderFor(actionType: ActionType): ChannelAdapter | null;
  /** Adapters that bring leads in rather than sending anything out. */
  leadSources(): ChannelAdapter[];
  health(): Promise<Array<{ id: ChannelId; report: HealthReport }>>;
}

/** Env var that pins an action to one adapter, e.g. CHANNEL_LINKEDIN_POST=postiz. */
export function overrideVarFor(actionType: ActionType): string {
  return `CHANNEL_${actionType.toUpperCase().replace(/[.\-]/g, "_")}`;
}

export class AmbiguousAdapterError extends Error {
  constructor(actionType: ActionType, candidates: ChannelId[]) {
    super(
      `More than one configured adapter can carry "${actionType}": ` +
        `${candidates.join(", ")}. Set ${overrideVarFor(actionType)} to the one you want.`,
    );
    this.name = "AmbiguousAdapterError";
  }
}

export class UnknownAdapterError extends Error {
  constructor(actionType: ActionType, requested: string, known: ChannelId[]) {
    super(
      `${overrideVarFor(actionType)} is set to "${requested}", which is not an available adapter. ` +
        `Available: ${known.join(", ") || "none"}.`,
    );
    this.name = "UnknownAdapterError";
  }
}

export function buildRegistry(env: NodeJS.ProcessEnv = process.env): Registry {
  const available: ChannelAdapter[] = [];
  const unavailable: Unavailable[] = [];

  for (const [id, factory] of Object.entries(FACTORIES) as Array<[ChannelId, AdapterFactory]>) {
    try {
      available.push(factory(env));
    } catch (e) {
      // A missing env var is an expected state, so it is reported rather than
      // thrown. Anything else is a real defect and must not be swallowed.
      if (e instanceof AdapterConfigError) {
        unavailable.push({ id, reason: e.message });
        continue;
      }
      throw e;
    }
  }

  return {
    available,
    unavailable,

    senderFor(actionType: ActionType): ChannelAdapter | null {
      const candidates = available.filter(
        (a) => typeof a.send === "function" && a.capabilities.actions.includes(actionType),
      );

      const pinned = env[overrideVarFor(actionType)];
      if (pinned) {
        const match = candidates.find((a) => a.id === pinned);
        if (!match) {
          // An explicit instruction that cannot be honored is loud, never a
          // silent fallback: the operator asked for a specific destination.
          throw new UnknownAdapterError(
            actionType,
            pinned,
            candidates.map((a) => a.id),
          );
        }
        return match;
      }

      if (candidates.length === 0) return null;
      if (candidates.length > 1) {
        throw new AmbiguousAdapterError(
          actionType,
          candidates.map((a) => a.id),
        );
      }
      return candidates[0] ?? null;
    },

    leadSources(): ChannelAdapter[] {
      return available.filter(
        (a) => a.capabilities.mode === "inbound" && typeof a.fetchLeads === "function",
      );
    },

    async health() {
      return Promise.all(
        available.map(async (a) => ({ id: a.id, report: await a.health() })),
      );
    },
  };
}
