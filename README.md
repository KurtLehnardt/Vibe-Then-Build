# Loop Engine

An operator cockpit for a one-person (or few-person) AI software and consulting practice. It holds
the positioning record, drafts content in your own voice, researches and sequences outreach, tracks
the pipeline with pricing attached, records delivery, and reports what the whole loop cost to run.

Self-hosted. Policy-gated. **Free to run** — the default configuration uses local models through
Ollama and needs no cloud API key.

> Status: early. The policy engine, pricing calculator, progress tracking, voice model, model
> router, and schema are implemented and tested. Channel adapters and the job runner are not built
> yet. See [Roadmap](#roadmap).

## Why this exists

Most open-source tools in this space automate the top of the funnel — find leads, send messages,
schedule posts. Very few follow a lead through to delivered work, and almost none tell you what
your margin was. Loop Engine is built around the second half: pricing, delivery, and cost control,
with the acquisition half integrated rather than reinvented. See [Prior art](#prior-art).

## Where it stands on platform terms

This matters enough to state before the install instructions.

LinkedIn's user agreement prohibits automated access, scraping, and software-driven messaging from
member accounts. The LinkedIn API exposes no personal direct messages at all, and posting to a
personal profile requires approved partner access to the Member Posts API. Automated connection and
DM tooling is the leading cause of account restriction — which destroys the exact asset the funnel
depends on.

So Loop Engine does not automate LinkedIn messaging, and it does not ship a headless browser that
logs into your account. For LinkedIn it researches, drafts, sequences, schedules, and records; a
person sends from their own browser session. Channels with an official sending path — Gmail and
SMTP, Upwork and RFP feeds, your own web forms — can send unattended.

The LinkedIn messaging ceiling is set in code at per-item approval, with the reason attached to the
setting, and it is visible in the Policy screen rather than buried in a config file. A fork may
raise it. This build does not.

## Autonomy is a setting, with two ceilings

| Level | Name | Behavior |
|---|---|---|
| 0 | Draft only | The system writes; nothing leaves the instance. |
| 1 | Approve each | Reviewed one at a time before each send. |
| 2 | Approve batch | A queue approved in one pass, then executed on schedule. |
| 3 | Autonomous | Sends unattended inside your guardrails. |

| Action | Ships at | Ceiling | Why the ceiling |
|---|---|---|---|
| `linkedin.connect` | 0 | 1 | Platform terms prohibit automated connection requests. |
| `linkedin.dm` | 0 | 1 | Platform terms prohibit software-driven messaging. |
| `linkedin.post` | 1 | 2 | Published under your name; a person reads it first. |
| `email.cold` | 0 | 3 | Official API with an unsubscribe path. |
| `email.followup` | 1 | 3 | Templated, into threads the recipient already answered. |
| `bid.submit` | 0 | 2 | A bid is a priced commitment. |
| `research.enrich` | 3 | 3 | Reads only; nothing reaches a person. |

The policy engine, model router, cost ledger, and the `action_log` schema are implemented and
tested as the designed path for this: every evaluation — allowed, deferred, or blocked — is meant
to be written to `action_log` with its reason and its model cost, and that table is meant to be the
source of truth for the margin report. **None of that is wired up yet.** Nothing outside the test
suite currently calls `evaluate()`, the router, or the ledger, and nothing writes to `action_log`.
Writing to it lands with the sequence runner, in a later P1 slice. Until then this is a tested
design, not a running safety property — do not rely on the action log existing today.

Guardrails that apply on top of the level: daily caps per action, quiet hours, an ICP score floor,
a suppression list, and a global kill switch that overrides everything.

## Install

Requires Docker and Node 22+.

```bash
git clone <your-fork> loop-engine && cd loop-engine
cp .env.example .env
```

Before starting anything, generate a gateway key and paste it into **both** `LLM_GATEWAY_KEY` and
`LITELLM_MASTER_KEY` in `.env` — they must be the exact same value, and the gateway refuses to
start without one:

```bash
openssl rand -hex 32
```

From here there are two ways to run the stack. Pick one; both put the app on port 3000, so running
them together fails.

**Development (recommended)** — infrastructure in Docker, the app on the host, so you get hot reload
and don't have to rebuild a container on every change:

```bash
docker compose up -d db ollama gateway
docker compose exec ollama ollama pull qwen3:14b
docker compose exec ollama ollama pull qwen3:4b
docker compose exec ollama ollama pull nomic-embed-text

pnpm install
pnpm db:migrate
pnpm seed                            # one operator, conservative policies
pnpm preflight                       # tells you exactly what is still missing
pnpm dev                             # http://localhost:3000
```

**Everything in Docker** — no local Node install needed; the app runs in its own container instead
of on the host:

```bash
docker compose up -d                 # postgres, ollama, litellm gateway, app
docker compose exec ollama ollama pull qwen3:14b
docker compose exec ollama ollama pull qwen3:4b
docker compose exec ollama ollama pull nomic-embed-text

docker compose exec app pnpm db:migrate
docker compose exec app pnpm seed       # one operator, conservative policies
docker compose exec app pnpm preflight  # tells you exactly what is still missing
# the app service is already running: http://localhost:3000
```

A fresh install has every outbound action at level 0 or 1, so nothing can send until you choose to
raise it.

### Running without a GPU

Everything works on CPU, just slower. Swap the drafting model in `.env` for something smaller
(`ollama/qwen3:4b`) if generation feels sluggish. On Apple Silicon with 32GB or more, run Ollama
natively instead of in Docker and point `LLM_GATEWAY_URL` at the host.

### Escalating to a frontier model (optional)

Set `ANTHROPIC_API_KEY` and `MODEL_HARD` to let jobs marked `hard` route to a frontier model. With
those unset, hard jobs fall back to the local drafting model and **the fallback is recorded**, so
you can see where local quality was the binding constraint instead of guessing.

## Architecture

```
src/db/schema.ts            operators, brand, proof, voice, content, drafts, channels,
                            policies, action_log, leads, threads, touches, deals,
                            proposals, engagements, weekly_metrics
src/lib/policy/             the gate every outbound action passes through
src/lib/ai/router.ts        jobs -> models, local first, recorded fallback
src/lib/ai/ledger.ts        per-call cost; local priced at zero, deliberately
src/lib/pricing/            value-based pricing and the margin floor, as code
src/lib/voice/              few-shot voice selection from your own posts
src/lib/progress/           funnel conversion, weakest-stage detection, margin
src/lib/channels/           adapter interface; one integration per external system, behind it
src/app/                    Progress, Approvals, Pipeline, Brand, Policy
```

Local inference is priced at **zero** in the ledger, not at an estimated electricity cost. Power
and hardware are real but belong in a hardware TCO model; mixing them into a per-call ledger makes
per-engagement margin impossible to reconcile against a bank statement.

## Tests

```bash
pnpm test        # policy engine, pricing, ledger, voice selection, funnel math
pnpm typecheck
```

The policy engine is the part worth trusting, so it is the part with the most tests: ceiling
clamping, kill-switch precedence, cap and quiet-hour deferral, ICP floors, and the invariant that
no action ships above its own ceiling.

## Roadmap

- **P0 (this commit)** — schema, policy engine, model router, cost ledger, pricing calculator,
  voice model, progress tracking, read-only cockpit, local stack.
- **P1 (landing now)** — channel adapter interface (`src/lib/channels/types.ts`); publishing
  through Postiz; lead import from OpenOutreach; Gmail/SMTP adapter; LinkedIn draft-and-assist; job
  runner for sequences and scheduling; ICP scoring; reply classification.
- **P2** — proposal generation from discovery notes; e-signature; Upwork and RFP feed adapters with
  fit scoring.
- **P3** — delivery templates and handoff-pack generation; eval runner results; per-engagement
  margin report; adapter contribution guide.

For publishing to social platforms, P1 integrates Postiz rather than rebuilding a scheduler; for
lead discovery it delegates to OpenOutreach. See [Integrations](#integrations) for how and why.

## Integrations

Loop Engine composes with existing open-source tools at the process boundary rather than merging
their source: publishing goes to Postiz over its public API, lead discovery delegates to
OpenOutreach as a separate process whose CSV export is read on disk. Both are optional — unset
their environment variables and the rest of the system runs exactly as before. See
[docs/integrations.md](docs/integrations.md) for the full decision record, including why Twenty
(CRM) was deliberately left out and why Linki cannot be used at all, and for how to add a new
adapter against `src/lib/channels/types.ts`.

## Prior art

Credit where it is due, and an honest map of what already exists. If one of these covers your whole
problem, use it instead.

| Project | License | What it covers |
|---|---|---|
| [Postiz](https://github.com/gitroomhq/postiz-app) | AGPL-3.0 | Social scheduling and publishing at scale. The content-distribution problem is solved here. How we use it: P1 publishes through its public API rather than rebuilding a scheduler — see [Integrations](#integrations). |
| [Twenty](https://github.com/twentyhq/twenty) | AGPL-3.0 | A full modern CRM, far beyond this project's lean pipeline. |
| [OpenOutreach](https://github.com/eracle/OpenOutreach) | GPL-3.0 | ICP-driven B2B lead discovery and email outreach. Takes the same no-LinkedIn-automation stance. How we use it: P1 imports leads from its CSV export as a separate process — see [Integrations](#integrations). |
| [marketing-dashboard](https://github.com/builderz-labs/marketing-dashboard) | MIT | Local-first marketing ops cockpit: CRM, outreach, content, approvals. Closest analogue to this project's shell. |
| [Linki](https://github.com/moaljumaa/linki) | Sustainable Use | Self-hosted LinkedIn + email sequencing with browser-side LinkedIn auth. |
| [LinkedGrow](https://github.com/DigiHold/LinkedGrow) | AGPL-3.0 | Agentic LinkedIn outreach via real-Chrome automation. The approach this project deliberately does not take. |
| [SocialFlow](https://github.com/inbharatai/SocialFlow) | MIT | Six-agent content pipeline with a brand kit, Ollama by default. |
| [PingCRM](https://github.com/sneg55/pingcrm) | AGPL-3.0 | Personal relationship CRM with multi-channel sync and relationship scoring. |
| [ProposalPal](https://github.com/jonlanger/proposalpalv3) | — | Consulting proposal generation with Ollama support. |

What none of them appear to do, and what this project is actually for: a configurable autonomy
policy layer in front of every send, value-based pricing as code with a margin floor, delivery
records with handoff and maintenance state, and one ledger that reports what the loop cost against
what it earned.

## License

AGPL-3.0-or-later. You may self-host, modify, and use it commercially. If you run a modified
version as a network service, the modified source must be available to its users.
