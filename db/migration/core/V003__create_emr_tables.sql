-- EMR operational data (blueprint v1.5).
--
-- Clinical data (patients, encounters, orders, results, appointments, vitals,
-- diagnoses) lives in Medplum as FHIR resources. These tables hold what is not
-- clinical: integration message traffic, notifications, and number sequences.

-- ---------------------------------------------------------------------------
-- Number sequences (MRN, order numbers), one counter per tenant and name.
-- Incremented atomically with INSERT .. ON CONFLICT DO UPDATE.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.emr_sequences (
    tenant_id UUID NOT NULL REFERENCES core.tenants(tenant_id) ON DELETE CASCADE,
    name VARCHAR(60) NOT NULL,
    value BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, name)
);

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.emr_notif_template (
    template_id UUID DEFAULT core.uuid_generate_v4() PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES core.tenants(tenant_id) ON DELETE CASCADE,
    event_code VARCHAR(60) NOT NULL,
    language VARCHAR(5) NOT NULL CHECK (language IN ('en', 'ar')),
    channel VARCHAR(20) NOT NULL CHECK (channel IN ('SMS', 'WHATSAPP', 'EMAIL')),
    subject VARCHAR(255),
    body TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by UUID,
    UNIQUE (tenant_id, event_code, language, channel)
);

CREATE TABLE IF NOT EXISTS core.emr_notif_log (
    notif_id UUID DEFAULT core.uuid_generate_v4() PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES core.tenants(tenant_id) ON DELETE CASCADE,
    template_id UUID REFERENCES core.emr_notif_template(template_id) ON DELETE SET NULL,
    event_code VARCHAR(60) NOT NULL,
    channel VARCHAR(20) NOT NULL,
    language VARCHAR(5) NOT NULL,
    recipient VARCHAR(100),
    patient_id VARCHAR(64),
    resource VARCHAR(100),
    body TEXT NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
    provider VARCHAR(30),
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_emr_notif_log_tenant_created
    ON core.emr_notif_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_emr_notif_log_tenant_status
    ON core.emr_notif_log(tenant_id, status);

-- ---------------------------------------------------------------------------
-- Integration message traffic (HL7 v2 inbound)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.emr_msg_inbound (
    message_id UUID DEFAULT core.uuid_generate_v4() PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES core.tenants(tenant_id) ON DELETE CASCADE,
    control_id VARCHAR(100),
    message_type VARCHAR(30),
    source VARCHAR(30) NOT NULL,
    sending_application VARCHAR(100),
    raw_message TEXT NOT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'RECEIVED'
        CHECK (status IN ('RECEIVED', 'PROCESSED', 'FAILED')),
    attempts INTEGER NOT NULL DEFAULT 0,
    received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_emr_msg_inbound_tenant_received
    ON core.emr_msg_inbound(tenant_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emr_msg_inbound_control
    ON core.emr_msg_inbound(tenant_id, control_id);

-- Processing stages of one message, in order: the timeline on the detail page.
CREATE TABLE IF NOT EXISTS core.emr_msg_transaction (
    transaction_id UUID DEFAULT core.uuid_generate_v4() PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES core.tenants(tenant_id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES core.emr_msg_inbound(message_id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    stage VARCHAR(30) NOT NULL,
    status VARCHAR(10) NOT NULL CHECK (status IN ('OK', 'ERROR')),
    detail TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_emr_msg_transaction_message
    ON core.emr_msg_transaction(message_id, seq);

CREATE TABLE IF NOT EXISTS core.emr_msg_error (
    error_id UUID DEFAULT core.uuid_generate_v4() PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES core.tenants(tenant_id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES core.emr_msg_inbound(message_id) ON DELETE CASCADE,
    stage VARCHAR(30) NOT NULL,
    error_code VARCHAR(60) NOT NULL,
    error_message TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_emr_msg_error_message
    ON core.emr_msg_error(message_id);

CREATE TABLE IF NOT EXISTS core.emr_msg_ack (
    ack_id UUID DEFAULT core.uuid_generate_v4() PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES core.tenants(tenant_id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES core.emr_msg_inbound(message_id) ON DELETE CASCADE,
    ack_code VARCHAR(2) NOT NULL CHECK (ack_code IN ('AA', 'AE', 'AR')),
    raw_ack TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_emr_msg_ack_message
    ON core.emr_msg_ack(message_id);

CREATE TABLE IF NOT EXISTS core.emr_msg_retry (
    retry_id UUID DEFAULT core.uuid_generate_v4() PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES core.tenants(tenant_id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES core.emr_msg_inbound(message_id) ON DELETE CASCADE,
    requested_by UUID,
    reason TEXT NOT NULL,
    outcome VARCHAR(10) NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILED')),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_emr_msg_retry_message
    ON core.emr_msg_retry(message_id);

-- ---------------------------------------------------------------------------
-- Permissions the blueprint names that have no live equivalent.
-- (core.permissions allows one permission per module and operation.)
-- ---------------------------------------------------------------------------
INSERT INTO core.modules
    (module_code, module_name, module_name_ar, module_description, is_system_module, display_order)
VALUES
    ('INTEGRATION', 'Integration', 'التكامل', 'HL7 / FHIR message monitor and retry', TRUE, 9),
    ('NOTIFICATIONS', 'Notifications', 'الإشعارات', 'Notification templates and delivery log', TRUE, 10)
ON CONFLICT (module_code) DO NOTHING;

INSERT INTO core.permissions
    (module_id, permission_code, permission_name, permission_name_ar, operation)
SELECT module_id, 'IT:READ', 'View Integration Messages', 'عرض رسائل التكامل', 'READ'
FROM core.modules WHERE module_code = 'INTEGRATION'
ON CONFLICT (module_id, operation) DO NOTHING;

INSERT INTO core.permissions
    (module_id, permission_code, permission_name, permission_name_ar, operation)
SELECT module_id, 'IT:UPDATE', 'Retry Integration Messages', 'إعادة إرسال رسائل التكامل', 'UPDATE'
FROM core.modules WHERE module_code = 'INTEGRATION'
ON CONFLICT (module_id, operation) DO NOTHING;

INSERT INTO core.permissions
    (module_id, permission_code, permission_name, permission_name_ar, operation)
SELECT module_id, 'NOTIF:ADMIN', 'Manage Notification Templates', 'إدارة قوالب الإشعارات', 'UPDATE'
FROM core.modules WHERE module_code = 'NOTIFICATIONS'
ON CONFLICT (module_id, operation) DO NOTHING;
