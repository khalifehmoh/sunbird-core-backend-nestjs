/**
 * Shared helpers for the Medplum provisioning scripts.
 *
 * Provisioning is the only place the Medplum super-admin credentials are used.
 * The API itself never sees them: at runtime it holds one Project Admin
 * client per tenant (from the registry file this module writes) and acts on a
 * user's behalf through that user's ProjectMembership.
 *
 * Every id is derived from the Sunbird id it represents, so provisioning can be
 * re-run at any time and converges on the same resources.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ORG_SYSTEM = 'https://sunbird.health/fhir/tenant-code';
const BRANCH_SYSTEM = 'https://sunbird.health/fhir/branch-code';
const USER_ID_SYSTEM = 'https://sunbird.health/fhir/user-id';
const SYSTEM_MEMBER_ID = 'system';

/**
 * Types that belong to a patient or a place, so they carry the branch in
 * `meta.accounts` and are filtered by it.
 */
const BRANCH_SCOPED_TYPES = [
  'AllergyIntolerance',
  'Communication',
  'Condition',
  'Coverage',
  'DiagnosticReport',
  'Encounter',
  'Goal',
  'Immunization',
  'Location',
  'MedicationRequest',
  'MedicationStatement',
  'Observation',
  'Patient',
  'QuestionnaireResponse',
  'RelatedPerson',
  'ServiceRequest',
  'Task',
];

/** Tenant-wide reference data: readable by every member, written by admins. */
const TENANT_SHARED_TYPES = ['Organization', 'Practitioner', 'PractitionerRole'];

/** Terminology and conformance content `@medplum/react` renders forms from. */
const TERMINOLOGY_TYPES = [
  'CodeSystem',
  'Questionnaire',
  'SearchParameter',
  'StructureDefinition',
  'ValueSet',
];

/** Deterministic UUID (v5 layout) from the parts that identify a resource. */
function uuidFor(...parts) {
  const hash = crypto
    .createHash('sha1')
    .update(`sunbird-medplum:${parts.join(':')}`)
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function getToken(baseUrl, clientId, clientSecret) {
  const response = await fetch(new URL('oauth2/token', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Token request failed (${response.status}): ${text}`);
  }
  return JSON.parse(text).access_token;
}

/**
 * One FHIR call. `extended` asks Medplum for the extended meta (accounts,
 * author) and lets project admins write `meta.accounts`.
 */
async function fhir(baseUrl, token, method, url, body, { extended } = {}) {
  const response = await fetch(new URL(`fhir/R4/${url}`, baseUrl), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/fhir+json',
      ...(body ? { 'Content-Type': 'application/fhir+json' } : {}),
      ...(extended ? { 'X-Medplum': 'extended' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${url} failed (${response.status}): ${text}`);
  }
  return text ? JSON.parse(text) : undefined;
}

function loadRegistry(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { version: 1, tenants: {} };
  }
}

function saveRegistry(file, registry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Holds client secrets: owner-only, and the directory is gitignored.
  fs.writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(file, 0o600);
}

function accessPolicies(tenantId) {
  const branchScoped = (parameterized) =>
    BRANCH_SCOPED_TYPES.map((resourceType) =>
      parameterized
        ? {
            resourceType,
            criteria: `${resourceType}?_compartment=%branch`,
          }
        : { resourceType },
    );
  const shared = (readonly) =>
    TENANT_SHARED_TYPES.map((resourceType) => ({
      resourceType,
      ...(readonly ? { readonly: true } : {}),
    }));
  const terminology = TERMINOLOGY_TYPES.map((resourceType) => ({
    resourceType,
    readonly: true,
  }));

  return {
    branch: {
      resourceType: 'AccessPolicy',
      id: uuidFor('policy', tenantId, 'branch'),
      name: 'Sunbird branch member',
      // Parameterized by the membership: `%branch` is its branch Organization.
      // `compartment` also stamps that branch onto everything the member
      // creates, which is what the `_compartment` criteria filter on.
      compartment: { reference: '%branch' },
      resource: [
        ...branchScoped(true),
        ...shared(true),
        ...terminology,
      ],
    },
    tenant: {
      resourceType: 'AccessPolicy',
      id: uuidFor('policy', tenantId, 'tenant'),
      name: 'Sunbird tenant-wide member',
      resource: [...branchScoped(false), ...shared(false), ...terminology],
    },
  };
}

/**
 * Creates or converges one tenant: Project, service client, branch
 * Organizations, access policies, the `system` member, and a membership per
 * eligible Sunbird user. Returns the registry record for the tenant.
 */
async function provisionTenant({ baseUrl, adminToken, tenant, branches, users, previous }) {
  const call = (method, url, body) =>
    fhir(baseUrl, adminToken, method, url, body);
  const tenantId = tenant.tenant_id;
  const projectId = uuidFor('project', tenantId);
  const clientId = uuidFor('client', tenantId);
  const clientSecret =
    previous?.clientSecret ?? crypto.randomBytes(32).toString('hex');
  const rootOrgId = uuidFor('org', tenantId);
  const projectRef = { reference: `Project/${projectId}` };
  const inProject = { project: projectId };

  await call('PUT', `Project/${projectId}`, {
    resourceType: 'Project',
    id: projectId,
    name: tenant.tenant_name,
    description: `Clinical data for Sunbird tenant ${tenant.tenant_code}.`,
    // Validate every write against the FHIR R4 StructureDefinitions.
    strictMode: true,
    // Bots back the event-driven spike (npm run medplum:events).
    features: ['bots'],
  });
  await call('PUT', `ClientApplication/${clientId}`, {
    resourceType: 'ClientApplication',
    id: clientId,
    meta: inProject,
    name: `Sunbird Core API (${tenant.tenant_code})`,
    description:
      'Server-to-server client. Always used with X-Medplum-On-Behalf-Of; browsers never use this.',
    secret: clientSecret,
  });
  // Project Admin is what allows On-Behalf-Of. It is also why the API must
  // never call without that header.
  await call('PUT', `ProjectMembership/${clientId}`, {
    resourceType: 'ProjectMembership',
    id: clientId,
    meta: inProject,
    project: projectRef,
    user: { reference: `ClientApplication/${clientId}` },
    profile: { reference: `ClientApplication/${clientId}` },
    admin: true,
  });

  await call('PUT', `Organization/${rootOrgId}`, {
    resourceType: 'Organization',
    id: rootOrgId,
    meta: inProject,
    identifier: [{ system: ORG_SYSTEM, value: tenant.tenant_code }],
    active: true,
    name: tenant.tenant_name,
    alias: tenant.tenant_name_ar ? [tenant.tenant_name_ar] : undefined,
    type: [
      {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/organization-type',
            code: 'prov',
            display: 'Healthcare Provider',
          },
        ],
      },
    ],
  });

  const branchOrgIds = {};
  for (const branch of branches) {
    const id = uuidFor('org', branch.branch_id);
    branchOrgIds[branch.branch_id] = id;
    await call('PUT', `Organization/${id}`, {
      resourceType: 'Organization',
      id,
      meta: inProject,
      identifier: [
        {
          system: BRANCH_SYSTEM,
          value: `${tenant.tenant_code}:${branch.branch_code}`,
        },
      ],
      active: true,
      name: branch.branch_name,
      alias: branch.branch_name_ar ? [branch.branch_name_ar] : undefined,
      partOf: { reference: `Organization/${rootOrgId}` },
    });
  }

  const policies = accessPolicies(tenantId);
  for (const policy of Object.values(policies)) {
    await call('PUT', `AccessPolicy/${policy.id}`, {
      ...policy,
      meta: inProject,
    });
  }

  /**
   * A Sunbird identity as a Medplum User + Practitioner + ProjectMembership.
   * The User is project-scoped with no email and no password, so the identity
   * can only ever be reached through On-Behalf-Of: there is no password-reset
   * or login path for it.
   */
  async function ensureMember(key, { firstName, lastName, branchId }) {
    const userRef = uuidFor('user', tenantId, key);
    const practitionerId = uuidFor('practitioner', tenantId, key);
    const membershipId = uuidFor('membership', tenantId, key);

    await call('PUT', `User/${userRef}`, {
      resourceType: 'User',
      id: userRef,
      meta: inProject,
      project: projectRef,
      firstName,
      lastName,
      externalId: key,
    });
    await call('PUT', `Practitioner/${practitionerId}`, {
      resourceType: 'Practitioner',
      id: practitionerId,
      meta: inProject,
      active: true,
      identifier: [{ system: USER_ID_SYSTEM, value: key }],
      name: [{ given: [firstName], family: lastName }],
    });

    const access = branchId
      ? {
          access: [
            {
              policy: { reference: `AccessPolicy/${policies.branch.id}` },
              parameter: [
                {
                  name: 'branch',
                  valueReference: {
                    reference: `Organization/${branchOrgIds[branchId]}`,
                  },
                },
              ],
            },
          ],
        }
      : { accessPolicy: { reference: `AccessPolicy/${policies.tenant.id}` } };
    await call('PUT', `ProjectMembership/${membershipId}`, {
      resourceType: 'ProjectMembership',
      id: membershipId,
      meta: inProject,
      project: projectRef,
      user: { reference: `User/${userRef}` },
      profile: { reference: `Practitioner/${practitionerId}` },
      externalId: key,
      userName: key,
      active: true,
      ...access,
    });
    return { membershipId, practitionerId, ...(branchId ? { branchId } : {}) };
  }

  const members = {};
  members[SYSTEM_MEMBER_ID] = await ensureMember(SYSTEM_MEMBER_ID, {
    firstName: 'Sunbird',
    lastName: 'System',
  });

  const skipped = [];
  for (const user of users) {
    if (!user.default_branch_id || !branchOrgIds[user.default_branch_id]) {
      // Fail closed: a user with no (valid) branch gets no clinical access
      // rather than tenant-wide access. Tenant-wide roles belong to the real
      // role-to-policy mapping.
      skipped.push(user.username);
      continue;
    }
    members[user.user_id] = await ensureMember(user.user_id, {
      firstName: user.first_name,
      lastName: user.last_name,
      branchId: user.default_branch_id,
    });
  }

  // Memberships for users who left, were deactivated or lost their branch.
  // Medplum keeps honouring an On-Behalf-Of membership even when it is marked
  // inactive, so the membership is deleted, not just flagged.
  const keep = new Set([clientId, ...Object.values(members).map((m) => m.membershipId)]);
  const existing = await call(
    'GET',
    `ProjectMembership?project=Project/${projectId}&_count=1000`,
  );
  const removed = [];
  for (const { resource } of existing.entry ?? []) {
    if (keep.has(resource.id)) continue;
    await call('DELETE', `ProjectMembership/${resource.id}`);
    removed.push(resource.externalId ?? resource.id);
  }

  return {
    record: {
      tenantCode: tenant.tenant_code,
      projectId,
      clientId,
      clientSecret,
      organizationId: rootOrgId,
      branches: branchOrgIds,
      members,
    },
    skipped,
    removed,
  };
}

module.exports = {
  BRANCH_SCOPED_TYPES,
  SYSTEM_MEMBER_ID,
  accessPolicies,
  fhir,
  getToken,
  loadRegistry,
  saveRegistry,
  provisionTenant,
  uuidFor,
};
