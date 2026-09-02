# Backend stack decision: NestJS for patient management, ICU, FHIR, and event-driven work

Locked decision plus the risk register and validation spikes behind it, for the team
(3 engineers, 1 not proficient in Java) planning the patient management and ICU
modules.

## Decision

**NestJS stays the backend framework for all new clinical modules, including patient
management, ICU, FHIR integration, and event-driven/Kafka work.** Do not fork any
module back to Spring/Java. This extends `nestjs-stack.mdc`: it is not only a
migration-compatibility rule, it is also the right call for team capacity.

## Why (beyond "everyone can work on it")

The bus-factor problem is disqualifying on its own for a 3-engineer team: if 1 of 3
cannot touch Java, every Java-only module has a single point of failure. That alone
is enough to standardize on NestJS. The rest of this doc exists to answer the
follow-up question honestly: *are we walking into a wall on FHIR, Kafka, complex
workflows, or ICU real-time data by doing so?* Per-risk answer below: no, but each
has a specific library choice to get right up front, not a fundamental gap.

## Risk register

| Risk | Verdict | Why | Action |
|---|---|---|---|
| Kafka client in `@nestjs/microservices` | **Real, but avoidable** | `Transport.KAFKA` wraps `kafkajs`, which has had no release since Feb 2023 ([tulios/kafkajs#1603](https://github.com/tulios/kafkajs/issues/1603)) | Use a custom NestJS transport strategy backed by `@confluentinc/kafka-javascript` (Confluent's officially maintained, `librdkafka`-based, KafkaJS-API-compatible client) or `@platformatic/kafka` (actively developed, ~25% faster than kafkajs in Platformatic's own benchmark). Do **not** ship the default `kafkajs` dependency into a clinical event pipeline. |
| FHIR server/validation maturity | **Closed by Medplum, and a strong fit for this frontend specifically** | Medplum is a full-stack, open-source (Apache-2.0), **TypeScript** FHIR server (Node/Express/Postgres/Redis) with SMART-on-FHIR auth, SOC2 Type 2, and a HIPAA-oriented design — a production CDR used by real healthcare orgs, not a toy client library. `@medplum/react` (the FHIR-aware component library: patient search, resource timelines, forms, questionnaires, scheduling) is built directly on **Mantine v8** — the same UI library already used on the frontend — and `@medplum/react-hooks`'s `useSubscription` gives live-updating UI (e.g. an ICU vitals card) on a FHIR resource change with almost no custom code | Two viable paths, decide per module: (1) self-host Medplum as the clinical data repository and UI-component source, and keep this NestJS service as the admin/org/auth layer around it, or (2) use `@medplum/core`/`fhir-kit-client` inside this service for typed FHIR resources and validation without running the full Medplum stack. Given the Mantine overlap, option (1) is worth prioritizing for the patient-management/ICU screens specifically. No Java/HAPI dependency is required either way. |
| Event automation (react to new/updated clinical data) | **Partly closed by Medplum Bots** | Medplum "Bots" are serverless TypeScript functions triggered by FHIR Subscriptions (webhook-style, on resource create/update), cron schedules, or direct API calls — covers a lot of "when X happens, do Y" event-driven needs (HL7-to-FHIR conversion, notifications, PDF generation, calling third-party APIs) without any Kafka setup | Use Bots for single-hop reactions to clinical data changes. Bots are not a substitute for Kafka if/when true ordered, multi-consumer event streaming is needed across services — keep the Kafka action item below for that case, and treat Bots and Kafka as complementary, not either/or. |
| Complex multi-step workflows / sagas (admission → triage → bed assignment → discharge, with compensation) | **Closed by Temporal** | Temporal's TypeScript SDK supports the saga pattern natively (ordered compensation stack, retries, durable execution) — this is the piece Spring would otherwise win on via Spring State Machine / Camunda, and it's a different tool than Medplum Bots, which are single-step reactions, not durable multi-step orchestration | Model one real care pathway as a Temporal workflow before committing patient-management workflow logic to ad-hoc code or an overloaded chain of Bots. Don't hand-roll saga/compensation logic in application code once workflows get past 2–3 steps. |
| ICU real-time data (bedside monitors, vitals streaming, alarms) | **Good fit, needs a spike** | Node's event loop is strong at many-concurrent-low-CPU-per-message connections (exactly what per-bed vitals streams look like); NestJS Gateways (WebSocket)/MQTT transport, or Medplum's `useSubscription` hook for the UI-facing side, are the natural fit | Prototype with a realistic concurrent-bed count and message rate, and deliberately inject one CPU-bound step (e.g. threshold/alarm evaluation) to confirm it doesn't stall the event loop; move any true CPU-bound work to `worker_threads` or a separate queue consumer if it does. |
| Legacy device/HL7v2 (MLLP), DICOM (imaging), ASTM (lab instruments) interfacing | **Closed by the Medplum Agent** | The **Medplum Agent** is a lightweight, open-source (Apache-2.0), actively maintained service that runs inside the hospital network and bridges HL7v2/MLLP, DICOM, and ASTM to the cloud over secure HTTPS WebSockets — Medplum positions this explicitly as the modern, cloud-native replacement for Mirth Connect following Mirth's move to a commercial license. The device-specific message mapping (see note below) still runs as a TypeScript Bot; the Agent only handles secure protocol bridging, so nobody on the team needs to write Java or operate a full legacy interface engine | Prefer the Medplum Agent over hand-rolling `node-hl7-client`/`node-hl7-server`/`@cosyte/mllp` once Medplum is in the stack for FHIR anyway — it is purpose-built, covers DICOM/ASTM in addition to HL7v2, and is actively maintained. **Reminder from the HL7-adapters discussion:** the Agent does not eliminate the need to map each device's specific message fields by hand — that work is inherent to HL7v2 in any stack — it eliminates the need to build/secure the network bridge and removes the Java dependency entirely. |
| Raw throughput at large multi-hospital scale, or formal FHIR/ONC certification | **Watch, not a current blocker** | JVM/Kafka-Java tends to win at very large sustained throughput, and HAPI-based FHIR servers have broader track record in formal certification contexts than Medplum | Revisit if/when the platform needs to scale past a single hospital's ICU + patient-management load, or needs a specific compliance certification that names a particular FHIR server implementation. Not relevant at current scope. |

## Medplum adoption shape: NestJS is the one front door, Medplum is an internal engine

Medplum's server is a full, separate Express application with its own database
schema, auth, and release process — it cannot be merged into the NestJS process
itself (different framework, different schema than the Flyway-owned `core`
schema, different upgrade lifecycle). Two running services is unavoidable. What
*is* avoidable is making that visible to anyone outside the team. Target shape:

- **One deployment unit**: add the Medplum server (and its own Postgres/Redis) as
  additional services in this repo's `docker-compose.yml`, brought up together
  with `npm run docker:up`, the same way Postgres already is. Not a separately
  managed system.
- **One front door**: no external caller (frontend, third party, mobile app) ever
  talks to Medplum directly. This NestJS service is the only exposed API surface;
  it calls Medplum internally (via `@medplum/core` as a plain client library, the
  same way it already calls TypeORM/Postgres) and serves the result under the
  existing `/api/v1/...` routes. Medplum is an implementation detail behind this
  service, not a second API.
- **One login**: keep Sunbird's existing JWT/cookie auth as the *only* login users
  see. Configure Medplum to trust an external identity provider (its own auth
  supports this) instead of running its own separate signup/login. No second
  login screen, no two independent identities for the same human.
- **One frontend**: `@medplum/react` components are imported directly into the
  existing React app like any other component library — there is no separate
  frontend to stand up.
- **Bots and the Agent are internal plumbing**: background automation and device
  bridging that run as part of this stack's infrastructure, invisible to anyone
  using the product — conceptually the same as a background job worker today.
- **Data ownership stays split even though the deployment doesn't feel split**:
  Medplum's own schema holds FHIR resources (`Patient`, `Encounter`,
  `Observation`, etc.); this service's existing `core` schema keeps owning
  tenants, staff accounts, roles/permissions, and anything that doesn't naturally
  fit the FHIR resource model. That boundary is internal wiring, not something
  users or API callers ever see.
- **Bots vs. Temporal**: use Bots for single-step reactions to FHIR data changes;
  keep Temporal (or equivalent) for genuinely multi-step, compensable care
  pathways. Bots triggering into a Temporal workflow is fine; a long chain of
  Bots standing in for a saga is not.

## Ongoing maintenance effort

Adopting Medplum behind this NestJS service adds real, recurring maintenance
surface, not just one-time integration work:

| Piece | What "maintaining" it means | Cadence | AI-agent-automatable? |
|---|---|---|---|
| Medplum server upgrades | Apply their version upgrade guides and per-release DB migrations, fix breaking API changes, run tests | Periodic — do not let this drift the way Mirth users let Mirth drift | **Yes, largely** — changelog triage, code updates for breaking changes, and test runs are good agent work; human sign-off still required before shipping anything touching patient data |
| Medplum's own Postgres schema | Backups, monitoring — same discipline already applied to the `core` schema | Ongoing, low effort | Partly — backup/monitoring automation is standard DevOps tooling, not really an "AI" task; prefer managed Postgres over self-hosting to remove most of this regardless |
| Redis (new dependency — not run today) | Patching/monitoring | Ongoing, low effort | Same as above — a managed Redis instance removes most of this burden more directly than automation would |
| Bots | Write, test, deploy each automation function | Only when automation logic changes | **Yes** — drafting the function and tests is good agent work; review before deploying anything that touches PHI |
| Medplum Agent (per hospital site) | Approve and apply remote upgrades on physical, on-prem installs | Per-site, occasional | **No** — this is a physical/change-control gate (live equipment on a hospital network, usually inside a maintenance window), not a skill or tooling gap |
| Auth trust config | Keep NestJS-issued tokens and Medplum's trust config in sync | Rare | Partly — an agent can update code when the format changes, but someone has to notice/decide it needs to change |
| Monitoring / on-call | Figure out which of the two services failed and why | Ongoing | **Yes** — log correlation and failure triage across services is a good fit for agent-assisted debugging |

**Bottom line**: a meaningful share of the recurring work (version bumps, Bot
authoring, on-call triage) is genuinely a good fit for AI-agent assistance, and
this team is already positioned to use it that way. What doesn't shrink,
regardless of tooling, is anything gated by compliance sign-off on
patient-data-touching changes or by physical/change-control access to on-prem
equipment — those stay human tasks by design, not by capability gap. Compared to
the original Java/Spring + HAPI + Mirth path, this is still net less effort for
this specific team, since that path adds a second *runtime* (JVM: separate
deploy pipeline, GC tuning, patching) that only 2 of 3 engineers could maintain,
on top of all the same categories of ongoing work above.

## De-risking plan (do before deep investment)

Run these as short, throwaway spikes, not production code, before building the real
patient-management/ICU modules on top of these choices:

1. **Event-driven spike**: a NestJS producer/consumer using `@confluentinc/kafka-javascript` (or start with a lighter broker — NATS/RabbitMQ/Redis Streams via `@nestjs/microservices` — if Kafka's operational overhead isn't justified yet for a 3-person team). Verify retry/idempotency semantics for something like a `vital-sign-recorded` or `patient-admitted` event.
2. **FHIR + UI spike**: add Medplum's server to this repo's `docker-compose.yml`, model `Patient`, `Encounter`, and `Observation`, call it from a NestJS service via `@medplum/core` proxied under `/api/v1/...`, and build one real patient-management screen with `@medplum/react` against the existing Mantine theme — confirming both that the UI looks native and that no external caller ever needs to know Medplum exists as a separate service.
3. **ICU real-time spike**: a WebSocket/MQTT gateway (or Medplum's `useSubscription`) simulating concurrent bedside streams at a realistic bed count and sample rate, load-tested with a deliberately CPU-heavy step included, to confirm event-loop behavior under load.
4. **Device bridge spike**: configure a Medplum Agent endpoint for one real device type (HL7v2/MLLP or DICOM), write the minimal Bot that accepts and acknowledges it, and confirm the message-mapping effort matches expectations from the HL7-adapters discussion.
5. **Auth-seam spike**: decide and prototype how Sunbird's existing JWT/cookie auth and Medplum's auth model relate for the same clinical-app users, before real patient data flows through both systems.
6. **Workflow spike** (optional, do before patient-management workflows get complex): one care pathway modeled as a Temporal TypeScript workflow with saga-style compensation, and confirm it composes cleanly with Bots rather than competing with them.

## Revisit triggers

Reopen this decision only if one of these becomes true, not preemptively:
- The platform needs to scale to multi-hospital/national throughput where JVM Kafka consumers have a proven, measured edge over the Node client actually chosen above.
- A required compliance certification explicitly names a specific FHIR server implementation that Medplum doesn't satisfy.
- The device/interface catalog grows large enough that hand-built HL7v2/MLLP adapters become the team's main maintenance burden — at that point, isolate an interface engine (see table above) rather than reconsidering the whole backend framework.
