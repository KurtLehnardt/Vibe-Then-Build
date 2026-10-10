CREATE TYPE "public"."action_type" AS ENUM('linkedin.connect', 'linkedin.dm', 'linkedin.post', 'email.cold', 'email.followup', 'bid.submit', 'research.enrich');--> statement-breakpoint
CREATE TYPE "public"."channel_kind" AS ENUM('linkedin', 'email', 'upwork', 'rfp', 'webform', 'x');--> statement-breakpoint
CREATE TYPE "public"."content_format" AS ENUM('teardown', 'build_log', 'contrarian', 'result_doc', 'checklist');--> statement-breakpoint
CREATE TYPE "public"."deal_stage" AS ENUM('qualified', 'discovery_held', 'proposal_sent', 'verbal', 'won', 'lost');--> statement-breakpoint
CREATE TYPE "public"."deal_tier" AS ENUM('diagnostic', 'build', 'operate');--> statement-breakpoint
CREATE TYPE "public"."policy_decision" AS ENUM('allowed', 'blocked', 'deferred');--> statement-breakpoint
CREATE TYPE "public"."draft_status" AS ENUM('draft', 'pending_approval', 'approved', 'rejected', 'scheduled', 'sent');--> statement-breakpoint
CREATE TYPE "public"."maintenance_tier" AS ENUM('none', 'monitor', 'monitor_fix', 'operate');--> statement-breakpoint
CREATE TYPE "public"."reply_class" AS ENUM('interested', 'not_now', 'wrong_person', 'hostile', 'unclear');--> statement-breakpoint
CREATE TYPE "public"."thread_state" AS ENUM('engaged', 'connected', 'value_sent', 'asked', 'replied', 'booked', 'dead');--> statement-breakpoint
CREATE TABLE "action_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"action_type" "action_type" NOT NULL,
	"subject_id" uuid,
	"engagement_id" uuid,
	"effective_level" integer NOT NULL,
	"decision" "policy_decision" NOT NULL,
	"reason" text NOT NULL,
	"provider" text,
	"model" text,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"wedge_statement" text,
	"icp_industry" text,
	"icp_role" text,
	"icp_pain" text,
	"pain_annual_cost_usd" numeric(12, 2),
	"notes" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"kind" "channel_kind" NOT NULL,
	"label" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"auth_mode" text NOT NULL,
	"config" jsonb
);
--> statement-breakpoint
CREATE TABLE "content_ideas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"source" text NOT NULL,
	"raw" text NOT NULL,
	"format" "content_format",
	"used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"lead_id" uuid,
	"title" text NOT NULL,
	"tier" "deal_tier" NOT NULL,
	"stage" "deal_stage" DEFAULT 'qualified' NOT NULL,
	"annual_value_usd" numeric(12, 2),
	"delivery_cost_usd" numeric(12, 2),
	"price_quoted_usd" numeric(12, 2),
	"price_floor_usd" numeric(12, 2),
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"idea_id" uuid,
	"action_type" "action_type" NOT NULL,
	"hook" text,
	"body" text NOT NULL,
	"status" "draft_status" DEFAULT 'draft' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engagements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"deal_id" uuid,
	"client_name" text NOT NULL,
	"template" text,
	"acceptance_criteria" text,
	"accuracy_target" numeric(5, 2),
	"accuracy_actual" numeric(5, 2),
	"handoff_pack_url" text,
	"maintenance_tier" "maintenance_tier" DEFAULT 'none' NOT NULL,
	"monthly_retainer_usd" numeric(10, 2),
	"started_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"renews_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"company" text,
	"source" text NOT NULL,
	"email" text,
	"linkedin_url" text,
	"icp_score" integer,
	"score_reason" text,
	"suppressed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outreach_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"channel_kind" "channel_kind" NOT NULL,
	"step" integer DEFAULT 1 NOT NULL,
	"state" "thread_state" DEFAULT 'engaged' NOT NULL,
	"last_touch_at" timestamp with time zone,
	"next_touch_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"action_type" "action_type" NOT NULL,
	"level" integer NOT NULL,
	"daily_cap" integer,
	"quiet_hours_start" integer,
	"quiet_hours_end" integer,
	"min_icp_score" integer,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proof_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"claim" text NOT NULL,
	"metric" text,
	"value" text,
	"source" text,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"options" jsonb,
	"recommended_option" text,
	"body" text,
	"sent_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "touches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"body" text NOT NULL,
	"approved_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"reply_class" "reply_class",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"channel" "channel_kind" NOT NULL,
	"body" text NOT NULL,
	"impressions" integer,
	"reactions" integer,
	"comments" integer,
	"embedding" jsonb,
	"posted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "weekly_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"week_start" timestamp with time zone NOT NULL,
	"posts_published" integer DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"profile_views" integer DEFAULT 0 NOT NULL,
	"connects_accepted" integer DEFAULT 0 NOT NULL,
	"conversations_started" integer DEFAULT 0 NOT NULL,
	"calls_booked" integer DEFAULT 0 NOT NULL,
	"calls_held" integer DEFAULT 0 NOT NULL,
	"proposals_sent" integer DEFAULT 0 NOT NULL,
	"deals_won" integer DEFAULT 0 NOT NULL,
	"revenue_usd" numeric(12, 2) DEFAULT '0' NOT NULL,
	"inference_cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_log" ADD CONSTRAINT "action_log_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_profiles" ADD CONSTRAINT "brand_profiles_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_ideas" ADD CONSTRAINT "content_ideas_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_idea_id_content_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."content_ideas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_threads" ADD CONSTRAINT "outreach_threads_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_items" ADD CONSTRAINT "proof_items_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "touches" ADD CONSTRAINT "touches_thread_id_outreach_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."outreach_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_samples" ADD CONSTRAINT "voice_samples_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_metrics" ADD CONSTRAINT "weekly_metrics_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_log_operator_created_idx" ON "action_log" USING btree ("operator_id","created_at");--> statement-breakpoint
CREATE INDEX "action_log_engagement_idx" ON "action_log" USING btree ("engagement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_operator_kind_label_idx" ON "channels" USING btree ("operator_id","kind","label");--> statement-breakpoint
CREATE INDEX "deals_operator_stage_idx" ON "deals" USING btree ("operator_id","stage");--> statement-breakpoint
CREATE INDEX "drafts_status_idx" ON "drafts" USING btree ("operator_id","status");--> statement-breakpoint
CREATE INDEX "leads_operator_score_idx" ON "leads" USING btree ("operator_id","icp_score");--> statement-breakpoint
CREATE INDEX "outreach_threads_next_idx" ON "outreach_threads" USING btree ("next_touch_at");--> statement-breakpoint
CREATE UNIQUE INDEX "policies_operator_action_idx" ON "policies" USING btree ("operator_id","action_type");--> statement-breakpoint
CREATE INDEX "voice_samples_operator_idx" ON "voice_samples" USING btree ("operator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_metrics_operator_week_idx" ON "weekly_metrics" USING btree ("operator_id","week_start");