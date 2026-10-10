import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ enums */

export const actionTypeEnum = pgEnum("action_type", [
  "linkedin.connect",
  "linkedin.dm",
  "linkedin.post",
  "email.cold",
  "email.followup",
  "bid.submit",
  "research.enrich",
]);

export const channelKindEnum = pgEnum("channel_kind", [
  "linkedin",
  "email",
  "upwork",
  "rfp",
  "webform",
  "x",
]);

export const contentFormatEnum = pgEnum("content_format", [
  "teardown",
  "build_log",
  "contrarian",
  "result_doc",
  "checklist",
]);

export const draftStatusEnum = pgEnum("draft_status", [
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "scheduled",
  "sent",
]);

export const threadStateEnum = pgEnum("thread_state", [
  "engaged",
  "connected",
  "value_sent",
  "asked",
  "replied",
  "booked",
  "dead",
]);

export const replyClassEnum = pgEnum("reply_class", [
  "interested",
  "not_now",
  "wrong_person",
  "hostile",
  "unclear",
]);

export const dealTierEnum = pgEnum("deal_tier", ["diagnostic", "build", "operate"]);

export const dealStageEnum = pgEnum("deal_stage", [
  "qualified",
  "discovery_held",
  "proposal_sent",
  "verbal",
  "won",
  "lost",
]);

export const maintenanceTierEnum = pgEnum("maintenance_tier", [
  "none",
  "monitor",
  "monitor_fix",
  "operate",
]);

export const decisionEnum = pgEnum("policy_decision", ["allowed", "blocked", "deferred"]);

/* -------------------------------------------------------------- operators */

export const operators = pgTable("operators", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------------- brand core */

export const brandProfiles = pgTable(
  "brand_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    wedgeStatement: text("wedge_statement"),
    icpIndustry: text("icp_industry"),
    icpRole: text("icp_role"),
    icpPain: text("icp_pain"),
    // The expensive-problem test: annualized cost of the pain, in dollars.
    painAnnualCostUsd: numeric("pain_annual_cost_usd", { precision: 12, scale: 2 }),
    notes: text("notes"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // One brand profile per operator. Without this, seed's onConflictDoNothing()
  // has no conflict target to act on, and seeding twice inserts a second
  // profile that pages silently pick between with .limit(1).
  (t) => [uniqueIndex("brand_profiles_operator_idx").on(t.operatorId)],
);

export const proofItems = pgTable("proof_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  operatorId: uuid("operator_id").notNull().references(() => operators.id, { onDelete: "cascade" }),
  claim: text("claim").notNull(),
  metric: text("metric"),
  value: text("value"),
  source: text("source"),
  // Unverified proof may be drafted with but is flagged in the UI, so nobody
  // accidentally ships a number they cannot defend on a call.
  verified: boolean("verified").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Past posts imported to teach the voice model. Embedding is stored as a
 * JSON array rather than pgvector so the base install needs no extension. */
export const voiceSamples = pgTable(
  "voice_samples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id").notNull().references(() => operators.id, { onDelete: "cascade" }),
    channel: channelKindEnum("channel").notNull(),
    body: text("body").notNull(),
    impressions: integer("impressions"),
    reactions: integer("reactions"),
    comments: integer("comments"),
    embedding: jsonb("embedding").$type<number[]>(),
    postedAt: timestamp("posted_at", { withTimezone: true }),
  },
  (t) => [index("voice_samples_operator_idx").on(t.operatorId)],
);

/* ---------------------------------------------------------------- content */

export const contentIdeas = pgTable("content_ideas", {
  id: uuid("id").primaryKey().defaultRandom(),
  operatorId: uuid("operator_id").notNull().references(() => operators.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  raw: text("raw").notNull(),
  format: contentFormatEnum("format"),
  used: boolean("used").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id").notNull().references(() => operators.id, { onDelete: "cascade" }),
    ideaId: uuid("idea_id").references(() => contentIdeas.id, { onDelete: "set null" }),
    actionType: actionTypeEnum("action_type").notNull(),
    hook: text("hook"),
    body: text("body").notNull(),
    status: draftStatusEnum("status").notNull().default("draft"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("drafts_status_idx").on(t.operatorId, t.status)],
);

/* --------------------------------------------------------------- channels */

export const channels = pgTable(
  "channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id").notNull().references(() => operators.id, { onDelete: "cascade" }),
    kind: channelKindEnum("kind").notNull(),
    label: text("label").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    // "api" sends unattended; "assisted" means a person sends from their own
    // browser session and the system only prepares and records the message.
    authMode: text("auth_mode").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>(),
  },
  (t) => [uniqueIndex("channels_operator_kind_label_idx").on(t.operatorId, t.kind, t.label)],
);

/* --------------------------------------------------------------- policies */

export const policies = pgTable(
  "policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id").notNull().references(() => operators.id, { onDelete: "cascade" }),
    actionType: actionTypeEnum("action_type").notNull(),
    /** 0 draft-only, 1 approve-each, 2 approve-batch, 3 autonomous. */
    level: integer("level").notNull(),
    dailyCap: integer("daily_cap"),
    quietHoursStart: integer("quiet_hours_start"),
    quietHoursEnd: integer("quiet_hours_end"),
    minIcpScore: integer("min_icp_score"),
    enabled: boolean("enabled").notNull().default(true),
  },
  (t) => [uniqueIndex("policies_operator_action_idx").on(t.operatorId, t.actionType)],
);

/** Every policy evaluation is recorded, allowed or blocked, with the model
 * cost attributed to it. This table is the margin report's source of truth. */
export const actionLog = pgTable(
  "action_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id").notNull().references(() => operators.id, { onDelete: "cascade" }),
    actionType: actionTypeEnum("action_type").notNull(),
    subjectId: uuid("subject_id"),
    engagementId: uuid("engagement_id"),
    effectiveLevel: integer("effective_level").notNull(),
    decision: decisionEnum("decision").notNull(),
    reason: text("reason").notNull(),
    provider: text("provider"),
    model: text("model"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("action_log_operator_created_idx").on(t.operatorId, t.createdAt),
    index("action_log_engagement_idx").on(t.engagementId),
  ],
);

/* ------------------------------------------------------- audience, outreach */

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id").notNull().references(() => operators.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    title: text("title"),
    company: text("company"),
    source: text("source").notNull(),
    email: text("email"),
    linkedinUrl: text("linkedin_url"),
    /** 0-100 fit against the brand profile's ICP record. */
    icpScore: integer("icp_score"),
    scoreReason: text("score_reason"),
    suppressed: boolean("suppressed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("leads_operator_score_idx").on(t.operatorId, t.icpScore)],
);

export const outreachThreads = pgTable(
  "outreach_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
    channelKind: channelKindEnum("channel_kind").notNull(),
    /** 1-4, matching the Engage / Connect / Value / Ask sequence. */
    step: integer("step").notNull().default(1),
    state: threadStateEnum("state").notNull().default("engaged"),
    lastTouchAt: timestamp("last_touch_at", { withTimezone: true }),
    nextTouchAt: timestamp("next_touch_at", { withTimezone: true }),
  },
  (t) => [index("outreach_threads_next_idx").on(t.nextTouchAt)],
);

export const touches = pgTable("touches", {
  id: uuid("id").primaryKey().defaultRandom(),
  threadId: uuid("thread_id").notNull().references(() => outreachThreads.id, { onDelete: "cascade" }),
  direction: text("direction").notNull(),
  body: text("body").notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  replyClass: replyClassEnum("reply_class"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------- pipeline and proposals */

export const deals = pgTable(
  "deals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id").notNull().references(() => operators.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    tier: dealTierEnum("tier").notNull(),
    stage: dealStageEnum("stage").notNull().default("qualified"),
    /** Value-pricing inputs, kept so a quote can always be re-derived. */
    annualValueUsd: numeric("annual_value_usd", { precision: 12, scale: 2 }),
    deliveryCostUsd: numeric("delivery_cost_usd", { precision: 12, scale: 2 }),
    priceQuotedUsd: numeric("price_quoted_usd", { precision: 12, scale: 2 }),
    priceFloorUsd: numeric("price_floor_usd", { precision: 12, scale: 2 }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("deals_operator_stage_idx").on(t.operatorId, t.stage)],
);

export const proposals = pgTable("proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id").notNull().references(() => deals.id, { onDelete: "cascade" }),
  options: jsonb("options").$type<Array<{ name: string; priceUsd: number; scope: string }>>(),
  recommendedOption: text("recommended_option"),
  body: text("body"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------------- delivery ops */

export const engagements = pgTable("engagements", {
  id: uuid("id").primaryKey().defaultRandom(),
  operatorId: uuid("operator_id").notNull().references(() => operators.id, { onDelete: "cascade" }),
  dealId: uuid("deal_id").references(() => deals.id, { onDelete: "set null" }),
  clientName: text("client_name").notNull(),
  template: text("template"),
  acceptanceCriteria: text("acceptance_criteria"),
  accuracyTarget: numeric("accuracy_target", { precision: 5, scale: 2 }),
  accuracyActual: numeric("accuracy_actual", { precision: 5, scale: 2 }),
  handoffPackUrl: text("handoff_pack_url"),
  maintenanceTier: maintenanceTierEnum("maintenance_tier").notNull().default("none"),
  monthlyRetainerUsd: numeric("monthly_retainer_usd", { precision: 10, scale: 2 }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  renewsAt: timestamp("renews_at", { withTimezone: true }),
});

/* ------------------------------------------------------------- progress */

/** One row per operator per ISO week. This is what the progress dashboard
 * reads; it is recomputed from the tables above rather than hand-edited. */
export const weeklyMetrics = pgTable(
  "weekly_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id").notNull().references(() => operators.id, { onDelete: "cascade" }),
    weekStart: timestamp("week_start", { withTimezone: true }).notNull(),
    postsPublished: integer("posts_published").notNull().default(0),
    impressions: integer("impressions").notNull().default(0),
    profileViews: integer("profile_views").notNull().default(0),
    connectsAccepted: integer("connects_accepted").notNull().default(0),
    conversationsStarted: integer("conversations_started").notNull().default(0),
    callsBooked: integer("calls_booked").notNull().default(0),
    callsHeld: integer("calls_held").notNull().default(0),
    proposalsSent: integer("proposals_sent").notNull().default(0),
    dealsWon: integer("deals_won").notNull().default(0),
    revenueUsd: numeric("revenue_usd", { precision: 12, scale: 2 }).notNull().default("0"),
    inferenceCostUsd: numeric("inference_cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
  },
  (t) => [uniqueIndex("weekly_metrics_operator_week_idx").on(t.operatorId, t.weekStart)],
);
