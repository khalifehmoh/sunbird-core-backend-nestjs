# Medplum spike findings

Results of the de-risking spikes in
[`backend-stack-decision.md`](./backend-stack-decision.md) §"De-risking plan".
Spike code, kept on a branch to read and then delete — it is not the real
patient-management module.

**Ran**: spike 2 (FHIR + UI) in full, spike 5 (auth seam: Project per tenant +
On-Behalf-Of) in full — see [Spike 5 results](#spike-5-results).
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
2. Tenant isolation done in application code is ours to maintain, and it has
   five confirmed bypasses — not only `$graphql`, but also cross-tenant
   overwrite and delete through conditional writes (see
   [Confirmed tenant bypasses](#confirmed-tenant-bypasses)).

Neither was a blocker for the spike. The fix for both was the same: put the
tenant boundary inside Medplum — one `Project` per tenant, with this service
calling On-Behalf-Of the real user. That is now built and passes its acceptance
checks; see [Spike 5 results](#spike-5-results). The bypass table below
describes the earlier application-level design.

## What was built

| Piece | Where |
|---|---|
| Medplum server + its own Postgres/Redis | `docker-compose.yml`, ports 8103/5433, separate volumes |
| One-command setup and demo data | `scripts/medplum-setup.js`, `npm run medplum:{up,provision,seed,down}` |
| Per-tenant Medplum clients, every call On-Behalf-Of a membership | `src/fhir/medplum.service.ts`, `medplum-registry.ts`, `medplum-actor.ts` |
| FHIR gateway under `/api/v1/fhir/R4` | `src/fhir/fhir-gateway.controller.ts` |
| Reference-integrity check for writes | `src/fhir/references.ts` (+ spec) |
| `PATIENT_MGMT_*` permission checks | `src/auth/permissions.ts`, `permissions.guard.ts` |
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

**Tenant isolation held for the paths that were tested.** Cross-tenant reads,
writes, and deletes *by id*, and type-level searches, were all rejected or
scoped through the gateway, returning 404 rather than 403 so the API never
confirms that an out-of-scope id exists. Other request shapes are not covered —
see [Confirmed tenant bypasses](#confirmed-tenant-bypasses).

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

### Confirmed tenant bypasses

Search scoping works by forcing a `_tag` parameter onto type-level searches and
checking the tag on instance reads. Every request shape that does neither goes
to Medplum under the shared service account, which can see every tenant.
Reproduced by driving the real `FhirGatewayController` as a tenant A user
against a stub `MedplumService` that records what is forwarded; that Medplum
accepts each shape is confirmed from `@medplum/fhir-router` (`PUT`/`DELETE`/
`PATCH :resourceType` are conditional update/delete/patch). Controls passed:
`GET Patient/<tenant-B-id>` → 404, and `GET Patient?name=…` gets `_tag` forced.

| # | Request (as tenant A) | What the gateway does | Effect |
|---|---|---|---|
| 1 | `PUT Patient?identifier=<nphies national id>` | Tags the body for tenant A, forwards the caller's query **without** `_tag` | Overwrites whichever patient matches, in any tenant, and re-tags it to tenant A — the record moves across tenants. National IDs are not secret. |
| 2 | `DELETE Patient?identifier=…` | Forwards the caller's query without `_tag` | Deletes another tenant's patient |
| 3 | `POST $graphql` | Forwards the body as-is | Reads every tenant's data |
| 4 | `GET Observation?_include=Observation:subject` (and `_revinclude`) | Forces `_tag` on the base type only; included entries pass through | Returns another tenant's `Patient` once a reference to it exists |
| 5 | `POST Observation` with `subject: Patient/<tenant-B-id>` | Tags the body; never checks references | Plants data on another tenant's patient — combined with #4 it is a read; it also shows up in that tenant's `Patient/<id>/$everything`, which is forwarded untouched |

Related, not a bypass of tenant scope but of role: neither the gateway, the ADT
controller, nor the frontend `clinical` routes check `PATIENT_MGMT_*` permission
codes, so any authenticated user in a tenant (including lab-only accounts) can
read and write all 20 writable clinical resource types and run ADT actions. There is no
branch-level scoping at all.

None of these is fixable by adding more checks to the gateway without the list
growing with every FHIR feature the components use — which is the
"standing liability" below in concrete form. All five disappear once tenants
are separate Medplum Projects and calls carry the end user's identity.

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
signatures — do not work without a real Medplum identity per user. The spike
commit left `package-lock.json` out of sync with `package.json` (missing
`@emnapi/core`/`@emnapi/runtime`), so `npm ci` — and therefore `npm run setup`
and any CI/Docker build using it — fails until the lockfile is regenerated.

## Auth seam: what is settled and what is not

Settled: Sunbird's cookie JWT stays the only login users see, the browser holds
no Medplum credential, and the API reaches Medplum with its own client
credentials. That much is prototyped and works.

Not settled, and the substance of spike 5: the API currently talks to Medplum as
a single all-powerful service account, with all per-user and per-tenant
authorization implemented on this side.

Decided since: keep this service as the only caller, but stop calling as the
bare service account. Medplum's
[On-Behalf-Of](https://www.medplum.com/docs/auth/on-behalf-of) feature is built
for exactly this shape ("the Customer Server Side App is the only system
component that interacts with Medplum Server"): the API authenticates as a
Project Admin `ClientApplication` and sends
`X-Medplum-On-Behalf-Of: ProjectMembership/<id>` per request. Medplum then
resolves the access policy from that membership — `fhir/accesspolicy.ts` uses
`onBehalfOfMembership ?? realMembership` — and records the user as author and
in `AuditEvent`. This replaces the earlier idea of Medplum trusting Sunbird
JWTs as an external identity provider, which would have required this service
to become an OIDC provider with a userinfo endpoint for no benefit, since no
caller talks to Medplum directly.

Two constraints from Medplum's source shape the design. On-Behalf-Of across
Projects is refused unless the caller is a super admin, so one
`ClientApplication` per tenant Project. And a request that omits the header
runs with the client's Project Admin rights, so `MedplumService` must make the
header mandatory rather than optional. **Recommendation unchanged: finish
spike 5 before building the real module, not after.**

## Spike 5 results

Implemented on branch `cursor/spike5-project-per-tenant-on-behalf-of-a932`, run
against Medplum 5.2.1 (self-hosted, Postgres 16, Redis) with three tenants,
two branches in tenant A and one user per role. Reproduce with
`npm run medplum:up && npm run medplum:seed`, then
`SPIKE_TEST_PASSWORD=... npm run medplum:check`. **36 of 36 acceptance checks
pass**, including the five bypasses from
[Confirmed tenant bypasses](#confirmed-tenant-bypasses) (the old
`tenant-scope.ts` and its tag injection are deleted).

**What now enforces the boundary**

- One Medplum `Project` per tenant, one Project Admin `ClientApplication` per
  Project, branches as `Organization` resources `partOf` the tenant root.
  Provisioning is idempotent and derives every id from the Sunbird id
  (`scripts/lib/medplum-admin.js`); the per-tenant client credentials and the
  user-to-membership map live in `.medplum/tenants.json` (mode 0600, gitignored).
- Every FHIR, ADT and events call carries
  `X-Medplum-On-Behalf-Of: ProjectMembership/<id>`. `MedplumService` has no
  method that can send without an actor, and `no-restricted-imports` blocks
  runtime imports of `@medplum/core` outside `src/fhir/medplum.service.ts` so
  nothing else can open a raw client.
- Branch scope is a parameterized `AccessPolicy`: `compartment: %branch` on the
  policy stamps the branch onto everything the member creates, and the criteria
  `Type?_compartment=%branch` filters every read, search, `_include`, `$graphql`
  and `$everything` at the SQL level.
- `PATIENT_MGMT_*` codes are checked on the gateway, the ADT routes and the
  events routes. Platform admins keep their bypass; `TENANT_ADMIN` does not.

**Where the plan was wrong, and what was done instead**

| Plan said | What the spike found |
|---|---|
| Tag patients to branches with `$set-accounts` | `$set-accounts` needs Project Admin, which On-Behalf-Of users do not have. The parameterized policy's `compartment` does the stamping on write instead, with no extra call. |
| Create users with `/admin/projects/:id/invite` | Also needs project admin. Users are created by provisioning as `User` (project-scoped, `externalId`, no email, no password) + `Practitioner` + `ProjectMembership` with deterministic ids. With no password and no email there is no login or reset path to the identity. |
| A request without the header fails | In Medplum an empty or missing header is not an error: the call runs with the client's Project Admin rights. `MedplumService` therefore makes the actor mandatory and the registry fails closed for unknown users. A bogus or cross-Project membership id is a 400 from Medplum. |
| Deactivate a membership when a user leaves | Medplum keeps honouring an inactive membership for On-Behalf-Of. Provisioning deletes the membership and the registry drops the user. |
| Medplum enforces reference rules | It does not check that a write's references are readable by the writer: `POST Observation` with `subject: Patient/<other tenant or branch>` is accepted. This is the one hole the boundary does not close by itself, so the gateway runs a reference check on writes (`references.ts`); the acceptance check covers cross-tenant `Observation` and cross-branch `Encounter`. |
| `auth/me` On-Behalf-Of may restore `getProfile()` | It does not: Medplum answers with the `ClientApplication`. Authorship-dependent components (timeline comments, signatures) still need the frontend to be given the user's `Practitioner` some other way. Left open. |
| `AuditEvent` names the user | `AuditEvent` is off by default in Medplum and was not enabled. Authorship is on the resource instead: `meta.onBehalfOf` is the user's `Practitioner`, `meta.author` is the `ClientApplication`. |

**Other observations**

- `$everything` on an invisible id and on a nonexistent id both answer 403, so
  there is no existence oracle across tenants.
- Branch isolation does not extend to resources written by the automation
  identity. The event notifications are written without a branch, so they are
  read by first reading the Encounter as the caller (404 if it is not in their
  branch) and then reading the Communication as the tenant's `system` member.
- Event Bots and Subscriptions are Project configuration, which On-Behalf-Of
  users cannot write, so `npm run medplum:events` creates a Bot and two
  Subscriptions in every tenant Project and tags the webhook with
  `?tenantId=` so the BullMQ worker acts inside the right Project. A native
  (non-Docker) Medplum needs `"allowUnsafeOutbound": true` in its config file,
  not an environment variable, before it will POST to localhost.
- The admit, transfer and discharge flow and both notification paths (Bot and
  BullMQ) still work end to end per tenant.

**Still open**: tenant-wide roles beyond the single branch (a user with no
valid default branch gets no clinical access rather than tenant-wide access),
the role-to-policy catalogue, enabling `AuditEvent`, `getProfile()`, frontend
`clinical` route gating, and the production sync between `core` and Medplum.

## Spike 5 plan: Project per tenant + On-Behalf-Of

> Historical: this is the plan as written before the spike. Where the
> implementation differs, [Spike 5 results](#spike-5-results) is authoritative.

Throwaway spike code on the spike branch, same as spikes 1–2. The goal is to
prove the boundary holds and the provisioning is tractable, not to build the
real sync.

**Build**

1. **Provisioning (extend `scripts/medplum-setup.js`)**: for each `core.tenants`
   row, create a Medplum `Project`, a Project Admin `ClientApplication`, and a
   root `Organization`; for each branch, an `Organization` `partOf` the root.
   Super-admin credentials are used here and nowhere else. Record the Medplum
   ids against the tenant and branch (spike: a JSON map or env file is fine;
   real module: columns on `core.tenants`/`core.branches` plus a secret store
   for client credentials).
2. **Memberships**: for each `user_tenant_access` row, invite a `Practitioner`
   into that tenant's Project (`/admin/projects/:id/invite`, `sendEmail:
   false`), with `access` entries parameterized by the user's branches against
   one branch-scoped `AccessPolicy` (`Patient?_compartment=%branch`, likewise
   for `Encounter`, `Observation`, …). Store the membership id. Branch
   assignment needs a user↔branch table; for the spike, derive it from
   `users.default_branch_id`.
3. **Tag patients to branches**: seed and ADT writes call `$set-accounts` on
   the `Patient` with the branch `Organization`, so related resources inherit
   the compartment.
4. **`MedplumService`**: one cached client per tenant Project; the request
   method takes the caller's membership id and refuses to send without it.
   Add a lint rule (`no-restricted-imports` on `@medplum/core` outside
   `src/fhir/medplum.service.ts`) so nothing else can open a raw client.
5. **Gateway and ADT**: resolve tenant client + membership from `req.user`,
   forward with On-Behalf-Of. Delete `src/fhir/tenant-scope.ts`, the tag
   injection on writes, and the post-read tag checks. Keep the resource-type
   allow-list (it still limits surface area), and add `PATIENT_MGMT_*`
   permission checks on the gateway and ADT routes and the frontend
   `clinical` routes.
6. **Authorship**: check whether answering `auth/me` through the gateway
   On-Behalf-Of the user restores `medplum.getProfile()` in the browser; if
   not, record what the authorship-dependent components need.

**Acceptance tests** (e2e against a running Medplum, two tenants, two branches
in tenant A, one user per branch):

- The five rows in [Confirmed tenant bypasses](#confirmed-tenant-bypasses),
  rerun as tenant A: none returns, modifies, deletes, or references a tenant B
  resource.
- Branch scope: the Olaya-branch user sees Olaya patients only, gets 404 on a
  Malaz patient by id, and `$graphql` returns Olaya patients only.
- A request built without a membership id fails inside `MedplumService`
  rather than reaching Medplum.
- `AuditEvent` and `meta.author` on a write name the Sunbird user's
  `Practitioner`, not the `ClientApplication`.
- The existing admit → discharge → notification flow (spike 1) still works.

**Until this lands**: no real PHI on the spike stack. If it is shown to anyone
outside the team before then, remove `$graphql` from `ALLOWED_OPERATIONS` and
reject type-level `PUT`/`PATCH`/`DELETE` in the gateway — this breaks some
`@medplum/react` components, which is acceptable for a demo.

**Out of scope**: the production sync between `core` and Medplum (outbox or
synchronous provisioning, reconciliation job), mapping the full Sunbird role
catalogue to access policies, and the `core` schema changes themselves — those
belong to the real module, informed by what this spike shows.

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
