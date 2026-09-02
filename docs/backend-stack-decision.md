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
| FHIR server/validation maturity | **Closed by Medplum** | Medplum is a full-stack, open-source (Apache-2.0), **TypeScript** FHIR server (Node/Express/Postgres/Redis) with SMART-on-FHIR auth, SOC2, and a HIPAA-oriented design — this is not a toy client library, it is a production CDR used by real healthcare orgs | Two viable paths, decide per module: (1) self-host Medplum as the clinical data repository and call its FHIR API from this NestJS service for orchestration/admin logic, or (2) use `@medplum/core`/`fhir-kit-client` inside this service for typed FHIR resources and validation without running the full Medplum stack. Either way, no Java/HAPI dependency is required to get FHIR done properly. |
| Complex multi-step workflows / sagas (admission → triage → bed assignment → discharge, with compensation) | **Closed by Temporal** | Temporal's TypeScript SDK supports the saga pattern natively (ordered compensation stack, retries, durable execution) — this is the piece Spring would otherwise win on via Spring State Machine / Camunda | Model one real care pathway as a Temporal workflow before committing patient-management workflow logic to ad-hoc code. Don't hand-roll saga/compensation logic in application code once workflows get past 2–3 steps. |
| ICU real-time data (bedside monitors, vitals streaming, alarms) | **Good fit, needs a spike** | Node's event loop is strong at many-concurrent-low-CPU-per-message connections (exactly what per-bed vitals streams look like); NestJS Gateways (WebSocket) or the MQTT microservice transport are the natural fit | Prototype with a realistic concurrent-bed count and message rate, and deliberately inject one CPU-bound step (e.g. threshold/alarm evaluation) to confirm it doesn't stall the event loop; move any true CPU-bound work to `worker_threads` or a separate queue consumer if it does. |
| Legacy device/HL7v2 (MLLP) interfacing (lab analyzers, older monitors) | **Workable, less turnkey than Java** | `node-hl7-client`/`node-hl7-server` and `@cosyte/mllp` are real, maintained TypeScript packages that already solve the fiddly low-level part (MLLP byte framing, TCP handling, ACK correlation, TLS). What Java interface engines add on top is not a magic per-device auto-translator — HL7v2 is customized per site/vendor, so the field-by-field message mapping is always custom work, in either stack. What they add is a GUI + scripting workbench for building that mapping, built-in queueing/retry/monitoring, and a community library of starter channels for well-known vendor systems to adapt instead of starting blank | Acceptable to build directly for a handful of device types; budget real time for each device's message mapping regardless of stack. If the device/interface catalog grows large enough that the GUI workbench, queueing, and starter-channel library become worth more than the integration cost, consider running an existing interface engine as an isolated component that talks HL7v2/MLLP to devices and FHIR/REST to this NestJS service — that isolates only the interface-engine piece, not the whole backend, and doesn't require anyone on the team to write Java, only to operate a pre-built engine. **Note:** Mirth Connect itself went commercial/proprietary at v4.6 (March 2025); only v4.5.2-and-earlier remain open source (MPL) and those get no security patches. If an interface engine is needed, evaluate the actively-maintained open-source forks instead — **Open Integration Engine (OIE)** (vendor-neutral, non-profit governed) or **BridgeLink** (Apache-2.0, Innovar Healthcare, optional paid support) — or budget for Mirth's commercial license. |
| Raw throughput at large multi-hospital scale, or formal FHIR/ONC certification | **Watch, not a current blocker** | JVM/Kafka-Java tends to win at very large sustained throughput, and HAPI-based FHIR servers have broader track record in formal certification contexts than Medplum | Revisit if/when the platform needs to scale past a single hospital's ICU + patient-management load, or needs a specific compliance certification that names a particular FHIR server implementation. Not relevant at current scope. |

## De-risking plan (do before deep investment)

Run these as short, throwaway spikes, not production code, before building the real
patient-management/ICU modules on top of these choices:

1. **Event-driven spike**: a NestJS producer/consumer using `@confluentinc/kafka-javascript` (or start with a lighter broker — NATS/RabbitMQ/Redis Streams via `@nestjs/microservices` — if Kafka's operational overhead isn't justified yet for a 3-person team). Verify retry/idempotency semantics for something like a `vital-sign-recorded` or `patient-admitted` event.
2. **FHIR spike**: model `Patient`, `Encounter`, and `Observation` either against a self-hosted Medplum instance or with `@medplum/core`/`fhir-kit-client` directly, and confirm validation behaves as expected against the profiles you actually need.
3. **ICU real-time spike**: a WebSocket or MQTT gateway simulating concurrent bedside streams at a realistic bed count and sample rate, load-tested with a deliberately CPU-heavy step included, to confirm event-loop behavior under load.
4. **Workflow spike** (optional, do before patient-management workflows get complex): one care pathway modeled as a Temporal TypeScript workflow with saga-style compensation.

## Revisit triggers

Reopen this decision only if one of these becomes true, not preemptively:
- The platform needs to scale to multi-hospital/national throughput where JVM Kafka consumers have a proven, measured edge over the Node client actually chosen above.
- A required compliance certification explicitly names a specific FHIR server implementation that Medplum doesn't satisfy.
- The device/interface catalog grows large enough that hand-built HL7v2/MLLP adapters become the team's main maintenance burden — at that point, isolate an interface engine (see table above) rather than reconsidering the whole backend framework.
