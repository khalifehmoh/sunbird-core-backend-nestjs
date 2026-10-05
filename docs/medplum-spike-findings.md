# Medplum spike findings

Results of the de-risking spikes in
[`backend-stack-decision.md`](./backend-stack-decision.md) §"De-risking plan".
Spike code, kept on a branch to read and then delete — it is not the real
patient-management module.

**Ran**: spike 2 (FHIR + UI) in full, spike 5 (auth seam) partially.
**Did not run**: spike 4 (device bridge). Nothing here says anything about
HL7v2/MLLP, DICOM, or the Medplum Agent; that question is still open.

## Verdict

The adoption shape in the ADR holds up. Medplum ran as an internal engine behind
this service, `@medplum/react` rendered on the existing Mantine theme with no
restyling, and the browser never learned that Medplum exists. Nothing found here
argues for reopening the decision.

Two things are more expensive than the ADR implies, both in the same place — the
boundary between Medplum's authorization model and this service's:

1. The gateway's allow-list is not sized by the module you are building; it is
   sized by what the component library asks for (see below).
2. Tenant isolation done in application code is ours to maintain, and `$graphql`
   punches a hole straight through it.

Neither is a blocker for the spike. Both need to be closed before real patient
data flows, and the fix for both is the same: per-tenant Medplum
`AccessPolicy`, which is exactly the part of spike 5 that was not prototyped.

## What was built

| Piece | Where |
|---|---|
| Medplum server + its own Postgres/Redis | `docker-compose.yml`, ports 8103/5433, separate volumes |
| One-command setup and demo data | `scripts/medplum-setup.js`, `npm run medplum:{up,provision,seed,down}` |
| Medplum client (client credentials, auto token refresh) | `src/fhir/medplum.service.ts` |
| FHIR gateway under `/api/v1/fhir/R4` | `src/fhir/fhir-gateway.controller.ts` |
| Tenant scoping rules, as pure functions | `src/fhir/tenant-scope.ts` (+ spec) |
| ADT workflows (A01–A05) | `src/fhir/adt.{controller,service,mapper}.ts` |
| Patient list and detail screens | `sunbird-frontend/src/pages/clinical/`, `src/medplum/` |

Roughly 1,200 lines of backend code plus 300 of tests, and 325 lines of
frontend. The 900-line setup script is mostly demo FHIR resources.

Provisioning is zero-touch and idempotent: the compose file pre-seeds a
super-admin `ClientApplication` via `MEDPLUM_DEFAULT_SUPER_ADMIN_CLIENT_ID/SECRET`,
and `medplum:provision` uses it to create the project, the API's own
`ClientApplication`, and its `ProjectMembership` under fixed UUIDs. `medplum:seed`
writes demo resources as transaction bundles of conditional updates
(`PUT Patient?identifier=…`), so re-running it heals drift instead of duplicating.

## Confirmed

**The UI genuinely looks native.** `SearchControl`, `PatientSummary`,
`ResourceForm`, and `ResourceTable` picked up the app's existing dark Mantine
theme with zero style overrides. `ResourceForm` generates a complete, correct
`Patient` editor — every element, with FHIR's own descriptions as help text —
from the `StructureDefinition` alone. That is the single largest piece of
leverage in Medplum for this project, and it is real.

**One front door works, including for FHIR-native clients.** The frontend's
`MedplumClient` is pointed at `/api/v1/fhir/R4` on this API and authenticates
with the ordinary Sunbird session cookie: no Medplum URL, no Medplum
credentials, no second login. The gateway rewrites Medplum's base URL out of
response bodies, so a client following a Bundle paging link stays on the public
path. Errors come back as `OperationOutcome`, keeping FHIR clients on the FHIR
contract.

**FHIR is a workable storage model for local requirements, not a compromise.**
Bilingual names map to repeated `HumanName` elements with the standard `language`
extension — which is what NPHIES and other R4 consumers expect to receive, and
strictly better than the `*_ar` sibling columns the `core` schema uses. National
ID and Iqama map to their distinct NPHIES identifier systems, MRN to a local one.

**Tenant isolation held under test.** Cross-tenant reads, writes, and deletes
were all rejected through the gateway, returning 404
rather than 403 so the API never confirms that an out-of-scope id exists.

## What cost more than expected

**The allow-list is dictated by the component library, not by your module.**
Rendering one patient summary screen required exposing `$graphql`,
`SearchParameter`, `StructureDefinition`, `ValueSet/$expand`, and nine clinical
resource types — `PatientSummary` alone queries `MedicationRequest`,
`MedicationStatement`, `ServiceRequest`, `DiagnosticReport`, and `Goal` before
it will render. Plan the gateway policy around what `@medplum/react` asks for;
"expose only what this module needs" is not a reachable position while using the
components. Each addition is a real decision, because a resource type on the
read-only list skips tenant filtering by design.

**`$graphql` bypasses the tenant filter.** Search scoping works by forcing a
`_tag` parameter, and there is no equivalent for a GraphQL query body. The
operation is currently forwarded as-is, which is acceptable for a spike with
seeded data and is not acceptable with real PHI. It is not fixable at the
parameter level; it needs Medplum-side authorization.

**Application-level tenant scoping is a standing liability.** One shared Medplum
service account plus "NestJS decides who sees what" is straightforward to write
and test, but every new code path is another chance to leak across tenants, and
the tests only cover the paths someone remembered. `AccessPolicy` per tenant
moves the check to where it cannot be forgotten.

**Small integration edges, worth knowing before repeating this.** The NestJS body
parser ignores `application/fhir+json` until widened. `@medplum/react` sends an
`X-Medplum` header on every call, which fails CORS preflight until allow-listed
even though the gateway drops it. `medplum.getProfile()` is undefined under the
cookie-proxy model, so components that attribute authorship — timeline comments,
signatures — do not work without a real Medplum identity per user.

## Auth seam: what is settled and what is not

Settled: Sunbird's cookie JWT stays the only login users see, the browser holds
no Medplum credential, and the API reaches Medplum with its own client
credentials. That much is prototyped and works.

Not settled, and the substance of spike 5: the API currently talks to Medplum as
a single all-powerful service account, with all per-user and per-tenant
authorization implemented on this side. The alternative — Medplum trusting
Sunbird-issued tokens as an external identity provider, with a per-tenant
`AccessPolicy` and one Medplum identity per user — was not built. It is what
closes the `$graphql` hole and removes the liability above, and it also restores
the authorship-dependent components. **Recommendation: finish spike 5 before
building the real module, not after.**

## ADT pages (A01–A05)

Built on the same Medplum front-door: transactional NestJS actions under
`/api/v1/adt/*` write FHIR `Encounter` / `Location` resources; the UI uses
`PatientSummary`, `SearchControl`, `EncounterTimeline`, and `ResourceInput`
from `@medplum/react`.

| HL7 event | Route | FHIR effect |
|---|---|---|
| A01 Admit | `POST /adt/admit` | `Encounter` class=`IMP`, status=`in-progress`; bed `operationalStatus=O` |
| A04 Register | `POST /adt/register` | `Encounter` class=`AMB`\|`EMER` |
| A02 Transfer | `POST /adt/transfer` | Append `Encounter.location` history; swap bed occupancy |
| A03 Discharge | `POST /adt/discharge` | `Encounter` status=`finished` + disposition; free bed |
| A05 Pre-admit | `POST /adt/preadmit` | `Encounter` status=`planned` |

UI: `/clinical/adt/{admit,register,transfer,discharge,preadmit,beds}` and
`/clinical/encounters`. Blueprint wireframes guided field choice; Medplum /
FHIR conventions win where they disagreed (no parallel `emr_adt_*` tables).

Location seed identifiers are tenant-scoped (`{tenantCode}:WARD-MED-A`) —
unscoped codes collided across tenants on re-seed.


Needs Docker running and the `core` database seeded (tenants are read from it).

```bash
npm run medplum:up        # Medplum server + its Postgres/Redis
npm run medplum:provision # project, service client, membership (idempotent)
npm run medplum:seed      # demo FHIR resources per tenant (idempotent)
npm run start:dev
```

Then, in the frontend repo, `npm run dev` and open `/clinical/patients`.
`npm run medplum:down` removes the containers; Medplum's volumes are separate
from the `core` database, so nothing else is affected.
