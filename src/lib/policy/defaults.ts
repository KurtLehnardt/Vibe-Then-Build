import { LEVEL, type ActionType, type Level } from "./levels";

export interface ActionDefault {
  /** Level a fresh install starts at. */
  shipsAt: Level;
  /** Highest level this build will honor, whatever the operator configures. */
  ceiling: Level;
  /** Why the ceiling exists. Shown in the settings UI next to the control. */
  ceilingReason: string;
  /** Conservative starting cap on sends per day. null means uncapped. */
  defaultDailyCap: number | null;
}

/**
 * Two ceilings are below L3, and both are deliberate.
 *
 * LinkedIn messaging is capped at per-item approval because LinkedIn's user
 * agreement prohibits software-driven messaging from member accounts, and
 * automated DM tooling is the leading cause of account restriction. Bid and
 * proposal submission is capped at batch approval because it commits a price.
 *
 * A fork may raise these. The published default does not.
 */
export const ACTION_DEFAULTS: Record<ActionType, ActionDefault> = {
  "linkedin.connect": {
    shipsAt: LEVEL.DRAFT_ONLY,
    ceiling: LEVEL.APPROVE_EACH,
    ceilingReason:
      "LinkedIn's user agreement prohibits automated connection requests from member accounts.",
    defaultDailyCap: 20,
  },
  "linkedin.dm": {
    shipsAt: LEVEL.DRAFT_ONLY,
    ceiling: LEVEL.APPROVE_EACH,
    ceilingReason:
      "LinkedIn's user agreement prohibits software-driven messaging, and the API exposes no personal messaging.",
    defaultDailyCap: 20,
  },
  "linkedin.post": {
    shipsAt: LEVEL.APPROVE_EACH,
    ceiling: LEVEL.APPROVE_BATCH,
    ceilingReason:
      "Published under your own name to your own audience; a person reads it before it ships.",
    defaultDailyCap: 3,
  },
  "email.cold": {
    shipsAt: LEVEL.DRAFT_ONLY,
    ceiling: LEVEL.AUTONOMOUS,
    ceilingReason: "Official API with an unsubscribe path; bounded by your own volume caps.",
    defaultDailyCap: 40,
  },
  "email.followup": {
    shipsAt: LEVEL.APPROVE_EACH,
    ceiling: LEVEL.AUTONOMOUS,
    ceilingReason: "Templated, low variance, sent into threads the recipient already answered.",
    defaultDailyCap: 60,
  },
  "bid.submit": {
    shipsAt: LEVEL.DRAFT_ONLY,
    ceiling: LEVEL.APPROVE_BATCH,
    ceilingReason: "A submitted bid is a priced commitment, so it always gets human eyes.",
    defaultDailyCap: 10,
  },
  "research.enrich": {
    shipsAt: LEVEL.AUTONOMOUS,
    ceiling: LEVEL.AUTONOMOUS,
    ceilingReason: "Reads only. Nothing reaches another person.",
    defaultDailyCap: null,
  },
};
