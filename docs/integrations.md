# Integrations

## Process boundary, not source merge

Vibe Then Build composes with existing open-source tools at the process boundary rather than merging
their source into this tree. Two integrations ship as of P1:

- **Postiz** handles publishing. Vibe Then Build calls its public API; Postiz's own code never enters
  this repository.
- **OpenOutreach** handles lead discovery. It runs as a separate process and writes a CSV export;
  Vibe Then Build reads that file and never imports or calls into OpenOutreach's code.

Three reasons drove this, not one:

1. **Maintenance cost.** Postiz is Next.js/NestJS/Prisma/Temporal; OpenOutreach is Python/Django.
   Between the two and this project's own stack, a source merge would mean maintaining three
   languages and four databases in one tree. A process boundary means maintaining one API contract
   and one file format instead.
2. **License isolation.** This repository is AGPL-3.0. Postiz is also AGPL-3.0, so merging its
   source would be legally fine but would still cost the maintenance overhead above. OpenOutreach
   is GPL-3.0, which is not compatible with redistributing it inside an AGPL-3.0 tree as combined
   source. Running it as a separate process and reading its CSV output keeps its GPL-3.0 code
   entirely outside this repository, so the question of license compatibility never comes up.
3. **Replaceability.** An adapter behind `src/lib/channels/types.ts` that turns out to be the wrong
   choice is replaceable in a day — swap the implementation, keep the interface. A fork of an
   external tool's source, once it has been modified and merged in-tree, is practically never
   replaced; it has to be maintained forever or ripped out at real cost.

## What's integrated, and what isn't

| Integration | Covers | License | How we talk to it | Without it |
|---|---|---|---|---|
| [Postiz](https://github.com/gitroomhq/postiz-app) | Social publishing and scheduling | AGPL-3.0 | HTTP, `{POSTIZ_URL}/public/v1`, API-key auth, `POST /public/v1/posts` to create a post. Self-hosted rate limit is 90 requests/hour. | `linkedin.post` is unavailable. Nothing else in Vibe Then Build is affected. |
| [OpenOutreach](https://github.com/eracle/OpenOutreach) | ICP-driven B2B lead discovery | GPL-3.0 | Run as its own process; Vibe Then Build reads the CSV it exports to `OPENOUTREACH_EXPORT_DIR`. No API call, no shared process, no shared database. | Lead import from OpenOutreach is unavailable. Leads can still be added by hand or through any other inbound adapter. |

### Deliberately not integrated

**Twenty** (AGPL-3.0) is a full modern CRM and is not integrated, on purpose. Vibe Then Build's pricing,
proposals, and delivery tracking all read and write the same `deals` record in this project's own
schema. Putting a CRM next door, with its own notion of a deal, would create two sources of truth
for the same piece of work — which one is current would become a standing question instead of a
settled one. The lean pipeline in this project's schema is the system of record; nothing else gets
to also claim that role.

**Linki** cannot be used at all, in any form, including as an adapter. Its Sustainable Use License
is source-available, not open source, and it restricts redistribution. This repository is
AGPL-3.0, which requires that source be redistributable under its terms; a Sustainable-Use-licensed
dependency cannot ship inside it. This is not a judgment about Linki's approach — it is the same
no-LinkedIn-automation stance Vibe Then Build takes — it is a hard licensing wall.

## Adding a new adapter

Every integration goes behind `src/lib/channels/types.ts`, which is deliberately thin: an adapter
translates between Vibe Then Build's own types and one external system, and it never decides whether
something may send. That decision belongs to the policy engine, which runs before any adapter is
called.

The interface, as it actually stands:

- `ChannelId` — a string literal union identifying the adapter (`"postiz"`, `"smtp"`, `"gmail"`,
  `"linkedin-assisted"`, `"openoutreach"`, and whatever a new adapter adds to this list).
- `SendMode` — `"api"` for unattended sends over an official interface, `"assisted"` for adapters
  that prepare a message but leave the actual send to a person (required wherever a platform's
  terms forbid software-driven sending), or `"inbound"` for adapters that bring leads in rather
  than sending anything.
- `AdapterCapabilities` — `actions` (the `ActionType`s this adapter can carry; anything else is
  rejected outright), `mode`, `supportsMetrics`, `supportsReplies`, and `requestsPerHour`
  (informational, from the adapter's own published rate limit, or `null` if it doesn't publish
  one).
- `ChannelAdapter` — the adapter itself: a readonly `id` and `capabilities`, a required
  `health(): Promise<HealthReport>`, an optional `send(message: OutboundMessage):
  Promise<SendOutcome>` present only on `"api"` or `"assisted"` adapters, and an optional
  `fetchLeads(limit: number): Promise<InboundLead[]>` present only on `"inbound"` adapters. Callers
  check for the method itself rather than trusting the capability flag alone, so a misconfigured
  adapter fails at the call site instead of partway through a sequence.
- `OutboundMessage`, `SendOutcome`, `InboundLead`, `HealthReport` — the data shapes passed across
  the boundary; see the file itself for field-level documentation.
- `UnsupportedActionError` and `AdapterConfigError` — the two errors an adapter throws: the first
  when handed an action it does not declare support for, the second when required configuration is
  missing, naming the specific env var.

To add an adapter:

1. Add its id to `ChannelId`.
2. Implement `ChannelAdapter` in `src/lib/channels/adapters/`, implementing only what the
   integration can actually do — a publishing adapter has no `fetchLeads`, an inbound source has no
   `send`.
3. Make every required setting an environment variable, documented in `.env.example` the same way
   `POSTIZ_URL`/`POSTIZ_API_KEY`/`OPENOUTREACH_EXPORT_DIR` are: what it's for, that it's optional,
   and what happens when it's unset.
4. Nothing to do for `pnpm preflight` itself: it builds a `Registry` via `buildRegistry` and
   renders one check per adapter straight from it, so a correctly implemented `health()` is
   enough. Register the adapter's factory in `FACTORIES` in `src/lib/channels/registry.ts` and the
   new check appears automatically — skipped when the adapter's config is absent, failed with its
   `health()` detail when configured but unreachable. See
   [Preflight asks the registry, not the integration](#preflight-asks-the-registry-not-the-integration)
   below.
5. Add a row to the integrations table above, and to the Prior art table in `README.md` if the
   integration is itself an open-source project.

## Preflight asks the registry, not the integration

`pnpm preflight` does not probe Postiz or the OpenOutreach export directory on its own. It calls
`buildRegistry(process.env)` and renders exactly what the registry reports: a `skip` for each
adapter in `registry.unavailable`, using the reason the adapter's own `configFromEnv` raised, and
an `ok` or `FAIL` for each adapter in `registry.available`, from the `HealthReport` its `health()`
returned.

This used to be two separate implementations of "is Postiz reachable" — one in the adapter, one
inlined in `scripts/preflight.ts` — and they disagreed. The script checked a different endpoint
than the adapter did, handled a trailing slash on `POSTIZ_URL` differently, and treated an
unrecognized non-5xx response as healthy where the adapter treated it as unreachable. An operator
running preflight against the same Postiz instance the app was about to use could get told
"reachable" by one check and "unreachable" by the other, with no way to tell which one was right.
The OpenOutreach check had the same problem in the other direction: preflight passed on a directory
that existed but held no CSVs, which the adapter's own `health()` correctly refuses, so preflight
could report success while `fetchLeads` returned nothing, indefinitely.

There is now exactly one implementation of "is this integration healthy" per adapter — the
adapter's own `health()` — and both preflight and the running app read it. They cannot drift apart
because there is nothing left to drift: the second implementation was deleted, not synchronized.
