# Event-driven spike findings (Bots + BullMQ, no Kafka)

Results of de-risking spike 1 in
[`backend-stack-decision.md`](./backend-stack-decision.md).

**Reaction under test:** when an inpatient `Encounter` becomes `status=finished`
(ADT A03), write a FHIR `Communication` standing in for `NOTIF_ADT_DISCHARGE`.
Same side-effect, two delivery paths, tagged `event-path=bot|bullmq`.

## Verdict

**Bots + BullMQ on Medplum Redis can carry single-hop clinical reactions without
Kafka.** Prefer:

| Pattern | Use when |
|---|---|
| **Medplum Bot** (Subscription → `Bot/…`) | Reaction lives next to FHIR data, needs Medplum’s auth/context, and should not depend on Nest being up |
| **BullMQ** (Subscription → Nest rest-hook → queue on Medplum Redis) | Reaction needs Nest services (SMS gateway, audit DB, Sunbird permissions), retries under Nest ops, or code that belongs in this repo |
| **Kafka** | Still deferred — only when ordered, replayable, multi-consumer streams are measured as necessary |

Both paths completed in the local demo (`npm run events:demo`) within ~1s of
discharge.

**UI:** after Confirm discharge, the discharge page stays put and opens a live
SSE watch (`GET /api/v1/events/notifications/:id/stream?timeoutMs=15000`)
immediately. Navigating away first meant both Communications were already
written before the panel mounted (badges always teal). The API owns timeout
and emits empty watching (~1.5s) → Bot → pause (~1.8s) → BullMQ → complete
so the badge flips are visible (real reactions are faster).
Encounter detail still supports `?watchEvents=1` for re-watching.

## What was built

| Piece | Where |
|---|---|
| BullMQ worker + Subscription webhook | `src/events/` (`EVENTS_ENABLED=true`) |
| Shared Communication builder | `src/events/discharge-notification.ts` |
| Bot + dual Subscriptions provisioner | `scripts/medplum-events.js` → `npm run medplum:events` |
| End-to-end admit → discharge → poll | `scripts/events-demo.mjs` → `npm run events:demo` |
| Medplum Redis published on host | `docker-compose.yml` port **6380** |
| Local outbound rest-hooks | `MEDPLUM_ALLOW_UNSAFE_OUTBOUND=true` (dev only) |

Compare outcomes:

```http
GET /api/v1/events/notifications/{encounterId}
```

## How to re-run

```bash
# Medplum already up from medplum:up; Nest with EVENTS_ENABLED=true
npm run medplum:events
npm run events:demo
```

## Footguns discovered (and how we cleared them)

1. **Project feature `bots`** — `$deploy` returns `Bots not enabled` until
   `Project.features` includes `"bots"` (super-admin). Also need
   `MEDPLUM_VM_CONTEXT_BOTS_ENABLED=true`.
2. **Bot membership vs `runAsUser`** — a Bot created via raw FHIR POST has no
   `ProjectMembership`; Subscription exec fails with
   `Could not find project membership for bot`. Spike uses `runAsUser: true` so
   the Bot runs as the Encounter author (Sunbird `ClientApplication`).
3. **vmcontext is CommonJS** — deploy **plain `exports.handler` JS**, not ESM
   `import`/`export`. `$deploy` does not reliably strip TypeScript imports for
   vmcontext; `$execute` then fails with
   `Cannot use import statement outside a module`.
4. **Outbound rest-hook SSRF guard** — Medplum 5.1.x skips non-HTTPS /
   private-network Subscription endpoints unless
   `MEDPLUM_ALLOW_UNSAFE_OUTBOUND=true`. Without it, Bot Subscriptions fire and
   HTTP webhooks never enqueue. **Production must use HTTPS webhooks and leave
   this flag off.**
5. **Redis restart** — Medplum’s BullMQ subscription worker dies if Redis
   briefly disappears; recreate/restart `medplum-server` after Redis is healthy.
6. **Idempotency** — both writers stamp deterministic identifiers
   (`discharge-{encounterId}-{path}`) so retries do not duplicate notifications.

## Pattern guidance for Sunbird

- **Discharge SMS / WhatsApp / email** → BullMQ (needs Nest + outbound providers).
  Local demo uses a **log + FHIR Communication** sink (`provider=demo`, no paid
  gateway); swap the sink for Twilio/Unifonic later.
- **FHIR-only enrichment** (tag a resource, create related `Task`/`Communication`
  inside Medplum) → Bot.
- **Cross-service fan-out with ordering / replay** → still the Kafka revisit
  trigger; do not stretch Bots or BullMQ into a log.

## Open (not this spike)

- Per-tenant Medplum `AccessPolicy` (auth-seam remainder).
- Production webhook TLS + secret rotation.
- Dead-letter / ops dashboards for failed BullMQ jobs and Bot `AuditEvent`s.
