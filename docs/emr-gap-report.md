# EMR blueprint v1.5 versus the implementation

Source: `sunbird-frontend/docs/Sunbird_Healthcare_EMR_Blueprint_v1.5 (1).docx.md`.
Method: a live run against the running stack (NestJS on :8080, real Medplum, Postgres,
Redis) as the local `SUPER_ADMIN` of tenant `AR-MED-001`, plus the HL7 simulator
(`npm run hl7:simulate`), plus a read of the frontend routes and pages. The e2e suites
in `test/live/` repeat the API part of this run on demand.

Status words: **Implemented**, **Partial**, **Missing**, **Deviates** (built differently
on purpose, reason given).

## Defects found by the live run

- **Fixed: MRN search returned nothing.** `q=AR-MED-001-00005` was treated as a name
  because the MRN pattern allowed only one hyphen. Unit tests used `T1-00042` so they
  never caught it. The pattern now accepts any number of segments before the sequence.
  Regression case added to `patients.service.spec.ts`.
- **Fixed: ED patients never appeared in the worklist.** ED registration (A04) creates
  the Encounter as `arrived`, but the worklist, its counts and the overview only looked
  for `in-progress`, so the ED chip was always empty and `counts.ed` was always 0.
  Active now means `arrived`, `triaged` or `in-progress`. Unit test added; the live ADT
  suite covers it.
- **Fixed: cancelling an order returned `patientName: null, mrn: null`.** The response
  now looks the patient up like `GET /emr/orders/:id` does.
- **Open, minor: `patientDisplay` is always `null`** on ADT encounter responses
  (`Encounter.subject.display` is never written). Nothing in the frontend reads it.
- **Open, minor: transferring to the bed the patient already occupies returns 200**
  and emits another A02. The code tolerates this on purpose
  (`previousBedId !== bed.id`); the blueprint is silent. Needs a product call.
- **Open, note: the session `permissions` list for `SUPER_ADMIN` does not contain
  `IT:READ`, `IT:UPDATE` or `NOTIF:ADMIN`.** Platform admins bypass the check, so the
  pages work. Any non-platform IT user needs those permissions granted through a role
  (V003 only creates the permission rows).

- **Open, note: anyone can self-register into a tenant** by sending its `tenantCode` to
  `POST /auth/register`. The new user has no role and no permissions (every EMR route
  returns 403 for them), but the account is created. Worth gating before production.
- **Open, note: ED and OPD visits cannot be closed through the API.** Discharge is
  inpatient only and there is no status-update endpoint, so test and demo OPD/ED visits
  stay open and count in the worklist and dashboard.

## Test coverage

- Unit: 400+ Jest specs against an in-memory FHIR store (`npm test`).
- Live e2e, real Medplum and Postgres: `npm run test:e2e:live` (`test/live/`). 60 tests:
  patients (10), ADT (20), orders and HL7 (11), appointments and SIU (8), vitals (4),
  diagnoses (3), integration retry (4). Needs the docker stack and
  `MEDPLUM_ENABLED=true`; the data it creates is tagged `E2E<run>` and is not deleted.
- Browser: Playwright in the frontend repo (`npm run test:e2e`).

## Cross-cutting (section 1)

- JWT with tenant in claims, 15 min access / 7 day refresh: **Partial**. Cookie JWT, tenant
  is resolved from the user record; `branch_id` is not embedded in the claims.
- MRN-first, no orphan data: **Implemented**. Orders, results, vitals, diagnoses and
  appointments reject an unknown patient (HL7 returns AE `PATIENT_NOT_FOUND`).
- Master + log tables with JSONB old/new: **Deviates**. Clinical data lives in FHIR
  (Medplum); history comes from FHIR `_history` diffs (page 30). Only sequences,
  notifications and integration messages are Postgres tables (V003).
- Soft delete on 38 tables: **Deviates**. No `emr_*` clinical tables; FHIR resources are
  never physically deleted by this API (cancel = `revoked` / `entered-in-error`).
- Bilingual `_ar` fields: **Implemented** for patient names and notification templates.
  i18next RTL toggle is a frontend-wide concern, not part of this work.
- `sp_emr_notif_fire` on ADT/SCH: **Implemented** as an in-process listener on the event
  bus (verified live: registering, admitting and discharging a patient produced
  `NOTIF_PATIENT_WELCOME`, `NOTIF_ADT_ADMIT`, `NOTIF_ADT_DISCHARGE`, all SENT).
- `pg_notify` channels: **Deviates**. Same six channel names, but an in-process bus
  that publishes after the FHIR commit. Not Kafka-ready and not cross-process.
- API surfaces `/api/v1/emr/*` and HL7 inbound: **Implemented**. FHIR is proxied under
  `/api/v1/fhir/R4/*` (Bundle writes go through that gateway) rather than a literal
  `/api/v1/fhir/Bundle` route: **Deviates**.
- Permission strings (`ADT:CREATE`, `ORDER:CREATE`, `SCH:*`, `VITALS:CREATE`): **Deviates**.
  Existing codes are reused (`PATIENT_MGMT_*`, `APPOINTMENT_MGMT_*`). `IT:READ`,
  `IT:UPDATE`, `NOTIF:ADMIN` are real.

## Pages

- **1 Dashboard**: Implemented. 8 KPI cards, activity line chart, critical alert panel
  (60 s poll).
- **2 Working list**: Partial. Master-detail, filter chips with counts, search by name,
  MRN, mobile (MRN fix above), action toolbar. The detail pane shows the overview
  cards only; the Overview/Encounters/Orders/Results/Vitals/Notes tab strip named on
  this page is not in the pane (the tabs live on the profile page, 3), and there is no
  Notes feature.
- **3 Profile**: Implemented (7 tabs).
- **4 Registration**: Implemented. 3-step stepper, MRN assigned server side, duplicate
  national id rejected with 409, welcome SMS queued.
- **5 Admit**: Implemented. Bed conflicts return 409, second active admission 409.
  "Triggers HL7 outbound" is **Missing** (no outbound HL7 at all).
- **6 Register OPD/ED**: Implemented.
- **7 Transfer**: Implemented (see the same-bed note).
- **8 Discharge**: Implemented. LOS returned, bed released, second discharge 400,
  discharge SMS sent.
- **9 Pre-admission**: Implemented (status `planned`). Converting creates a new `IP-`
  encounter and marks the planned one `cancelled` in one transaction, so the patient's
  encounter list shows both. The blueprint only says "Converts to A01".
- **10 Encounter list**: Implemented (`/clinical/encounters`, `/emr/encounters`
  redirects).
- **11 New order**: Implemented. LOINC catalog search, `ORD-YYYY-nnnnn` numbers.
- **12 Order list**: Implemented. Filters and inline cancel. The blueprint does not ask
  for live updates; the list now polls every 15 s and toasts new orders as a convenience
  (not in the blueprint).
- **13 Result viewer, 14 Result list, 15 Critical alerts**: Implemented. Critical values
  are found by scanning because Medplum has no `Observation.interpretation` search.
  Polling on page 15 is 60 s as specified.
- **16 Schedule**: Partial. Week grid per provider with free/booked/blocked colours,
  week navigation, Today. The Day/Week/Month toggle is **Missing**; week only.
- **17 Book**: Partial. Slot picker plus form, but not the side-by-side calendar
  layout; slots are a grid per day.
- **18 Cancel**: Implemented. S14 is treated as cancellation (see notes).
- **19 Vitals entry, 20 Vitals display**: Implemented, critical flag evaluated server side.
- **21 Diagnoses**: Implemented.
- **22 to 24 Integration monitor, detail, retry**: Implemented. IT permission required;
  monitor polls every 30 s.
- **25 to 27 Dashboard zones**: Implemented (tabs on the dashboard; integration tab
  gated by `IT:READ`).
- **28 Notification log, 29 Template manager**: Implemented. Delivery goes through a
  demo provider that records the message and marks it SENT; no real SMS/WhatsApp gateway.
- **30 Patient audit**: Implemented from FHIR `_history` field diffs. The separate
  "EMR change log (JSONB diff)" section is **Deviates** (one source, not two).
- **31 Capability statement**: Implemented, public.

## Known behaviour outside the blueprint

- Live orders and "new order" notification were requested in conversation; the document
  describes neither. Only the order/result list polling and toast exist.
- Scheduling rules are fixed in code (30 min slots, 08:00 to 16:00, UTC+3, Sunday to
  Thursday); there is no clinic configuration.
