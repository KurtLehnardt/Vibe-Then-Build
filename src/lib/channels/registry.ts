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
  constructor(actionType: ActionType, requested: string, available: ChannelId[]) {
    super(
      `${overrideVarFor(actionType)} is set to "${requested}", which is not an available adapter. ` +
        `Available: ${available.join(", ") || "none"}.`,
    );
    this.name = "UnknownAdapterError";
  }
}

/**
 * Distinct from UnknownAdapterError on purpose. An operator who pins a real,
 * configured adapter to an action it cannot carry needs to be told that, not
 * told the adapter does not exist — the previous single error sent them to fix
 * the wrong thing.
 */
export class IncompatibleAdapterError extends Error {
  constructor(actionType: ActionType, requested: ChannelId, capable: ChannelId[]) {
    super(
      `${overrideVarFor(actionType)} is set to "${requested}", which is configured but cannot ` +
        `carry "${actionType}". Adapters that can: ${capable.join(", ") || "none"}.`,
    );
    this.name = "IncompatibleAdapterError";
  }
}

/**
 * Longest a single adapter may take to report health before the registry gives
 * up on it. The Postiz adapter bounds its own HTTP call, but filesystem calls
 * have no inherent timeout, so one hung network mount would otherwise hang the
 * whole health check.
 */
const HEALTH_TIMEOUT_MS = 10_000;

/** Converts anything an adapter's health call can do into a report. */
async function reportFor(adapter: ChannelAdapter): Promise<HealthReport> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      adapter.health(),
      new Promise<HealthReport>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              reachable: false,
              detail: `The ${adapter.id} adapter did not report health within ${HEALTH_TIMEOUT_MS / 1000} seconds.`,
            }),
          HEALTH_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (e) {
    // An adapter that throws from health() is a defect in that adapter, but it
    // must not take the other adapters' reports down with it. Anything at all
    // can be thrown in JavaScript, so this must not assume an Error: reading
    // `.message` off a thrown `undefined` would itself throw, which is exactly
    // the failure this catch exists to prevent.
    const detail = e instanceof Error ? e.message : String(e);
    return {
      reachable: false,
      detail: `The ${adapter.id} adapter failed while reporting health: ${detail}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function buildRegistry(
  env: NodeJS.ProcessEnv = process.env,
  factories: Partial<Record<ChannelId, AdapterFactory>> = FACTORIES,
): Registry {
  const available: ChannelAdapter[] = [];
  const unavailable: Unavailable[] = [];

  for (const [id, factory] of Object.entries(factories) as Array<[ChannelId, AdapterFactory]>) {
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
        // An explicit instruction that cannot be honored is loud, never a
        // silent fallback: the operator asked for a specific destination.
        const capable = candidates.find((a) => a.id === pinned);
        if (capable) return capable;

        const configured = available.find((a) => a.id === pinned);
        if (configured) {
          throw new IncompatibleAdapterError(
            actionType,
            configured.id,
            candidates.map((a) => a.id),
          );
        }
        throw new UnknownAdapterError(
          actionType,
          pinned,
          available.map((a) => a.id),
        );
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
      // Every adapter is reported on, even when another one throws or hangs.
      return Promise.all(
        available.map(async (a) => ({ id: a.id, report: await reportFor(a) })),
      );
    },
  };
}
