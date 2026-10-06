# EMR blueprint (v1.5) — implementation notes

Scope: pages 1–31 of `Sunbird_Healthcare_EMR_Blueprint_v1.5`. This file records
where the implementation deliberately differs from the blueprint, what is
stubbed, and what must be done to run it.

## Mapping

| Blueprint | Implemented as |
|---|---|
| Spring Boot services | NestJS modules under `src/emr/*` |
| `pg_notify` event channels | In-process `EmrEventBus` (`emr.adt\|orm\|oru\|sch\|notif\|error`); events publish only after the FHIR commit succeeds |
| Clinical tables | FHIR resources in Medplum (Patient, Encounter, ServiceRequest, DiagnosticReport, Observation, Appointment, Condition); no parallel `emr_*` clinical tables |
| Integration + notification tables | Flyway `V003__create_emr_tables.sql` (messages, transactions, errors, acks, retries, sequences, templates, notification log) |
| Daily summary table | Live queries (`_summary=count`, encounters overlapping the window); responses carry `truncated` when a window exceeds one page |

## Decisions and gaps

- **SIU^S14** is treated as a cancellation (HL7 "modification"); S15 also cancels.
  Rescheduling is cancel + new S12.
- **No outbound HL7.** Inbound only (`POST /emr/integration/inbound`, API key via
  `INTEGRATION_API_KEY`, ≥ 24 chars; unset disables the endpoint).
- **Notifications** use a demo provider that records the message and marks it
  `SENT`; no real SMS/WhatsApp/e-mail gateway is wired.
- **Patient search** by MRN is exact-match only; name and mobile are prefix/contains.
- **Existing tenants must re-run the access-policy provisioning**
  (`npm run medplum:provision`) so the `Appointment` resource is writable.
- **MRN and order numbers** come from Postgres sequences (`emr_sequences`):
  `ORD-YYYY-NNNNN`. Registration retries on a conditional-create collision.
- **Scheduling** is fixed: 30-minute slots, 08:00–16:00, UTC+3, working days
  Sun–Thu (`SCHEDULING` in `src/emr/appointments`). Per-provider calendars are not
  modelled.
- **Patient audit trail** is derived from FHIR `_history` diffs, not an audit table.
- **Public capability statement:** `GET /api/v1/fhir/metadata` (generated from the
  gateway allow-lists); the frontend renders it at `/fhir/metadata`.
- **Test double:** `FakeFhirStore` interprets Encounter `date` as "overlaps" like
  Medplum, but implements only the search parameters the specs need.

## Added beyond the blueprint (UI needs)

- `GET /emr/appointments/providers`, `GET /emr/appointments/:id`
- `GET /emr/patients/:id/encounters`

## Permissions

`PATIENT_MGMT_*` (clinical), `APPOINTMENT_MGMT_*` (scheduling), `IT:READ`,
`IT:UPDATE`, `NOTIF:ADMIN` (added by V003). The UI hides what the user cannot
use; the API guards are authoritative.

## Frontend routes

`/emr/dashboard`, `/emr/patients[/new|/:id|/:id/audit]`, `/emr/orders[/new]`,
`/emr/results[/critical|/:id]`, `/emr/appointments[/new|/:id/cancel]`,
`/emr/vitals[/new]`, `/emr/diagnoses`, `/emr/integration[/transaction/:id|/retry/:id]`,
`/emr/notifications[/templates]`, public `/fhir/metadata`.
`/emr/adt/*` and `/emr/encounters*` redirect to `/clinical/*`.
Pages 25–27 (registration, clinical, integration dashboards) are tabs of
`/emr/dashboard`.

## Running

```bash
npm run db:migrate      # applies V003 (Flyway scripts in db/migration/core)
INTEGRATION_API_KEY=<24+ chars> npm run start:dev
```

## Simulating an external system

```bash
npm run hl7:simulate -- --mrn AR-MED-001-00003 [--order ORD-2026-00002] [--provider <practitioner id>]
npm run hl7:simulate -- --dry-run   # print the messages without sending
```n
Sends ORM (new, cancel), ORU (critical and normal) and, with `--provider`, SIU book/cancel to the inbound endpoint using `INTEGRATION_API_KEY` from `.env` and prints each ACK.
