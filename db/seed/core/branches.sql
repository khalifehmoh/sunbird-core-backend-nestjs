INSERT INTO core.branches (
    tenant_id,
    branch_code,
    branch_name,
    branch_name_ar,
    branch_type,
    license_number,
    contact_email,
    contact_phone,
    address,
    city,
    region,
    is_headquarters,
    status
)
SELECT
    tenant.tenant_id,
    seed.branch_code,
    seed.branch_name,
    seed.branch_name_ar,
    seed.branch_type,
    seed.license_number,
    seed.contact_email,
    seed.contact_phone,
    seed.address,
    seed.city,
    seed.region,
    seed.is_headquarters,
    seed.status::core.tenant_status
FROM core.tenants AS tenant
CROSS JOIN (
    VALUES
        (
            'HOSP-001-HQ',
            'Riyadh Headquarters',
            'المقر الرئيسي بالرياض',
            'MAIN',
            'LIC-HOSP-001-RUH',
            'riyadh@hospital.example',
            '+966-11-555-0101',
            'King Fahd Road',
            'Riyadh',
            'Riyadh',
            TRUE,
            'ACTIVE'
        ),
        (
            'HOSP-001-JED',
            'Jeddah Regional Branch',
            'فرع جدة الإقليمي',
            'REGIONAL',
            'LIC-HOSP-001-JED',
            'jeddah@hospital.example',
            '+966-12-555-0102',
            'Prince Sultan Road',
            'Jeddah',
            'Makkah',
            FALSE,
            'ACTIVE'
        ),
        (
            'HOSP-001-DMM',
            'Dammam Satellite Branch',
            'فرع الدمام',
            'SATELLITE',
            'LIC-HOSP-001-DMM',
            'dammam@hospital.example',
            '+966-13-555-0103',
            'Gulf Road',
            'Dammam',
            'Eastern Province',
            FALSE,
            'ACTIVE'
        )
) AS seed (
    branch_code,
    branch_name,
    branch_name_ar,
    branch_type,
    license_number,
    contact_email,
    contact_phone,
    address,
    city,
    region,
    is_headquarters,
    status
)
WHERE tenant.tenant_code = 'HOSP-001'
  AND tenant.is_deleted = FALSE
ON CONFLICT (tenant_id, branch_code) DO NOTHING;
