-- Sunbird Core schema baseline from medical_core_db-v0.3 dump (2026-08-15).
-- 16 tables, enums, indexes, FKs, and updated_at triggers.
-- Row-level security from the dump is omitted: NestJS scopes by tenant in application code.

--
-- PostgreSQL database dump
--

-- Dumped from database version 11.21
-- Dumped by pg_dump version 11.21

--
-- Name: core; Type: SCHEMA; Schema: -; Owner: postgres
--

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: 
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA core;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: 
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA core;

--
-- Name: action_type; Type: TYPE; Schema: core; Owner: postgres
--

CREATE TYPE core.action_type AS ENUM (
    'LOGIN',
    'LOGOUT',
    'FAILED_LOGIN',
    'CREATE',
    'READ',
    'UPDATE',
    'DELETE',
    'ASSIGN_ROLE',
    'REVOKE_ROLE',
    'GRANT_PERMISSION',
    'REVOKE_PERMISSION',
    'ACTIVATE',
    'DEACTIVATE',
    'LOCK',
    'UNLOCK'
);

--
-- Name: entity_type; Type: TYPE; Schema: core; Owner: postgres
--

CREATE TYPE core.entity_type AS ENUM (
    'TENANT',
    'BRANCH',
    'USER',
    'GROUP',
    'ROLE',
    'PERMISSION',
    'MODULE',
    'CONFIG'
);

--
-- Name: tenant_status; Type: TYPE; Schema: core; Owner: postgres
--

CREATE TYPE core.tenant_status AS ENUM (
    'ACTIVE',
    'SUSPENDED',
    'INACTIVE'
);

--
-- Name: user_status; Type: TYPE; Schema: core; Owner: postgres
--

CREATE TYPE core.user_status AS ENUM (
    'ACTIVE',
    'SUSPENDED',
    'LOCKED',
    'INACTIVE'
);

--
-- Name: user_type; Type: TYPE; Schema: core; Owner: postgres
--

CREATE TYPE core.user_type AS ENUM (
    'INTERNAL',
    'EXTERNAL',
    'SERVICE_ACCOUNT'
);

--
-- Name: update_timestamp(); Type: FUNCTION; Schema: core; Owner: postgres
--

CREATE FUNCTION core.update_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;

--
-- Name: audit_logs; Type: TABLE; Schema: core; Owner: postgres
--

CREATE TABLE core.audit_logs (
    audit_id uuid DEFAULT core.uuid_generate_v4() NOT NULL,
    tenant_id uuid,
    user_id uuid,
    action_type core.action_type NOT NULL,
    entity_type core.entity_type NOT NULL,
    entity_id uuid,
    entity_name character varying(255),
    old_value jsonb,
    new_value jsonb,
    ip_address character varying(50),
    user_agent text,
    session_id uuid,
    success boolean DEFAULT true,
    error_message text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

--
-- Name: TABLE audit_logs; Type: COMMENT; Schema: core; Owner: postgres
--

COMMENT ON TABLE core.audit_logs IS 'Comprehensive audit trail for compliance - 3 year retention';

--
-- Name: branches; Type: TABLE; Schema: core; Owner: postgres
--

CREATE TABLE core.branches (
    branch_id uuid DEFAULT core.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    branch_code character varying(50) NOT NULL,
    branch_name character varying(255) NOT NULL,
    branch_name_ar character varying(255),
    branch_type character varying(50),
    license_number character varying(100),
    contact_email character varying(255),
    contact_phone character varying(50),
    address text,
    city character varying(100),
    region character varying(100),
    is_headquarters boolean DEFAULT false,
    status core.tenant_status DEFAULT 'ACTIVE'::core.tenant_status,
    is_deleted boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by uuid,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_by uuid,
    deleted_at timestamp without time zone,
    deleted_by uuid,
    CONSTRAINT branches_branch_type_check CHECK (((branch_type)::text = ANY ((ARRAY['MAIN'::character varying, 'REGIONAL'::character varying, 'SATELLITE'::character varying])::text[])))
);

--
-- Name: TABLE branches; Type: COMMENT; Schema: core; Owner: postgres
--

COMMENT ON TABLE core.branches IS 'Branch locations - single level structure, no sub-branches';

--
-- Name: group_members; Type: TABLE; Schema: core; Owner: postgres
--

CREATE TABLE core.group_members (
    member_id uuid DEFAULT core.uuid_generate_v4() NOT NULL,
    group_id uuid NOT NULL,
    user_id uuid NOT NULL,
    joined_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    joined_by uuid,
    is_deleted boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by uuid,
    deleted_at timestamp without time zone,
    deleted_by uuid
);

--
-- Name: TABLE group_members; Type: COMMENT; Schema: core; Owner: postgres
--

COMMENT ON TABLE core.group_members IS 'Group membership - associates users with groups';

--
-- Name: group_roles; Type: TABLE; Schema: core; Owner: postgres
--

CREATE TABLE core.group_roles (
    group_role_id uuid DEFAULT core.uuid_generate_v4() NOT NULL,
    group_id uuid NOT NULL,
    role_id uuid NOT NULL,
    assigned_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    assigned_by uuid,
    is_deleted boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by uuid,
    deleted_at timestamp without time zone,
    deleted_by uuid
);

--
-- Name: TABLE group_roles; Type: COMMENT; Schema: core; Owner: postgres
--

COMMENT ON TABLE core.group_roles IS 'Assignment of roles to groups - users inherit group roles';

--
-- Name: groups; Type: TABLE; Schema: core; Owner: postgres
--

CREATE TABLE core.groups (
    group_id uuid DEFAULT core.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    group_code character varying(50) NOT NULL,
    group_name character varying(255) NOT NULL,
    group_name_ar character varying(255),
    group_description text,
    status core.tenant_status DEFAULT 'ACTIVE'::core.tenant_status,
    is_deleted boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by uuid,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_by uuid,
    deleted_at timestamp without time zone,
    deleted_by uuid
);

--
-- Name: TABLE groups; Type: COMMENT; Schema: core; Owner: postgres
--

COMMENT ON TABLE core.groups IS 'User groups for simplified role assignment - tenant level scope';

--
-- Name: modules; Type: TABLE; Schema: core; Owner: postgres
--

CREATE TABLE core.modules (
    module_id uuid DEFAULT core.uuid_generate_v4() NOT NULL,
    module_code character varying(50) NOT NULL,
    module_name character varying(255) NOT NULL,
    module_name_ar character varying(255),
    module_description text,
    is_system_module boolean DEFAULT false,
    display_order integer,
    status core.tenant_status DEFAULT 'ACTIVE'::core.tenant_status,
    is_deleted boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by uuid,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_by uuid,
    deleted_at timestamp without time zone,
    deleted_by uuid
);

--
-- Name: TABLE modules; Type: COMMENT; Schema: core; Owner: postgres
--

COMMENT ON TABLE core.modules IS 'System modules/features that can be secured';

--
-- Name: password_reset_tokens; Type: TABLE; Schema: core; Owner: postgres
--

CREATE TABLE core.password_reset_tokens (
    token_id uuid DEFAULT core.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    token_hash character varying(255) NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    used_at timestamp without time zone,
    used_ip character varying(50),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_token_expiry CHECK ((expires_at > created_at))
);

--
-- Name: TABLE password_reset_tokens; Type: COMMENT; Schema: core; Owner: postgres
--

COMMENT ON TABLE core.password_reset_tokens IS 'Email-based password reset tokens - 24 hour expiry';

--
-- Name: permissions; Type: TABLE; Schema: core; Owner: postgres
--

CREATE TABLE core.permissions (
    permission_id uuid DEFAULT core.uuid_generate_v4() NOT NULL,
    module_id uuid NOT NULL,
    permission_code character varying(50) NOT NULL,
    permission_name character varying(255) NOT NULL,
    permission_name_ar character varying(255),
    operation character varying(50) NOT NULL,
    permission_description text,
    is_deleted boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by uuid,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_by uuid,
    deleted_at timestamp without time zone,
    deleted_by uuid,
    CONSTRAINT permissions_operation_check CHECK (((operation)::text = ANY ((ARRAY['CREATE'::character varying, 'READ'::character varying, 'UPDATE'::character varying, 'DELETE'::character varying, 'EXPORT'::character varying, 'PRINT'::character varying, 'APPROVE'::character varying])::text[])))
);

--
-- Name: TABLE permissions; Type: COMMENT; Schema: core; Owner: postgres
--

COMMENT ON TABLE core.permissions IS 'Module + Operation combinations that define granular permissions';

--
-- Name: role_permissions; Type: TABLE; Schema: core; Owner: postgres
--

CREATE TABLE core.role_permissions (
    role_permission_id uuid DEFAULT core.uuid_generate_v4() NOT NULL,
    role_id uuid NOT NULL,
    permission_id uuid NOT NULL,
    granted_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    granted_by uuid,
    is_deleted boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by uuid,
    deleted_at timestamp without time zone,
    deleted_by uuid
);

--
-- Name: TABLE role_permissions; Type: COMMENT; Schema: core; Owner: postgres
--

COMMENT ON TABLE core.role_permissions IS 'Assignment of permissions to roles';

--
-- Name: roles; Type: TABLE; Schema: core; Owner: postgres
--

CREATE TABLE core.roles (
    role_id uuid DEFAULT core.uuid_generate_v4() NOT NULL,
    tenant_id uuid,
    role_code character varying(50) NOT NULL,
    role_name character varying(255) NOT NULL,
    role_name_ar character varying(255),
    role_description text,
    is_system_role boolean DEFAULT false,
    status core.tenant_status DEFAULT 'ACTIVE'::core.tenant_status,
    is_deleted boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by uuid,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_by uuid,
    deleted_at timestamp without time zone,
    deleted_by uuid
);

--
-- Name: TABLE roles; Type: COMMENT; Schema: core; Owner: postgres
--

COMMENT ON TABLE core.roles IS 'Roles for RBAC - can be system-wide or tenant-specific';

--
-- Name: COLUMN roles.tenant_id; Type: COMMENT; Schema: core; Owner: postgres
--

COMMENT ON COLUMN core.roles.tenant_id IS 'NULL for system roles, populated for tenant-specific roles';

--
-- Name: tenant_config; Type: TABLE; Schema: core; Owner: postgres
--

CREATE TABLE core.tenant_config (
    config_id uuid DEFAULT core.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    config_key character varying(100) NOT NULL,
    config_value jsonb NOT NULL,
    config_description text,
    is_encrypted boolean DEFAULT false,
    is_deleted boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by uuid,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_by uuid,
    deleted_at timestamp without time zone,
    deleted_by uuid
);

--
-- Name: TABLE tenant_config; Type: COMMENT; Schema: core; Owner: postgres
--

COMMENT ON TABLE core.tenant_config IS 'Tenant-specific configuration and settings stored as key-value pairs';

--
-- Name: tenants; Type: TABLE; Schema: core; Owner: postgres
--

CREATE TABLE core.tenants (
    tenant_id uuid DEFAULT core.uuid_generate_v4() NOT NULL,
    parent_tenant_id uuid,
    tenant_code character varying(50) NOT NULL,
    tenant_name character varying(255) NOT NULL,
    tenant_name_ar character varying(255),
    organization_type character varying(50),
    license_number character varying(100),
    tax_number character varying(50),
    contact_email character varying(255),
    contact_phone character varying(50),
    address text,
    city character varying(100),
    region character varying(100),
    country character varying(50) DEFAULT 'SA'::character varying,
    status core.tenant_status DEFAULT 'ACTIVE'::core.tenant_status,
    subscription_type character varying(50),
    subscription_start_date date,
    subscription_end_date date,
    max_users integer DEFAULT 50,
    max_branches integer DEFAULT 10,
    is_deleted boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by uuid,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_by uuid,
    deleted_at timestamp without time zone,
    deleted_by uuid,
    CONSTRAINT chk_subscription_dates CHECK (((subscription_end_date IS NULL) OR (subscription_end_date >= subscription_start_date))),
    CONSTRAINT tenants_organization_type_check CHECK (((organization_type)::text = ANY ((ARRAY['HOSPITAL'::character varying, 'NETWORK'::character varying, 'CLINIC'::character varying, 'LAB'::character varying, 'PHARMACY'::character varying])::text[]))),
    CONSTRAINT tenants_subscription_type_check CHECK (((subscription_type)::text = ANY ((ARRAY['BASIC'::character varying, 'PROFESSIONAL'::character varying, 'ENTERPRISE'::character varying])::text[])))
);

--
-- Name: TABLE tenants; Type: COMMENT; Schema: core; Owner: postgres
--

COMMENT ON TABLE core.tenants IS 'Master table for tenants/organizations - supports hospital networks and individual hospitals';

--
-- Name: COLUMN tenants.parent_tenant_id; Type: COMMENT; Schema: core; Owner: postgres
--

COMMENT ON COLUMN core.tenants.parent_tenant_id IS 'For hospital networks - links child hospital to parent network';

--
-- Name: user_roles; Type: TABLE; Schema: core; Owner: postgres
--

CREATE TABLE core.user_roles (
    user_role_id uuid DEFAULT core.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    role_id uuid NOT NULL,
    assigned_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    assigned_by uuid,
    is_deleted boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by uuid,
    deleted_at timestamp without time zone,
    deleted_by uuid
);

--
-- Name: TABLE user_roles; Type: COMMENT; Schema: core; Owner: postgres
--

COMMENT ON TABLE core.user_roles IS 'Assignment of roles to users';

--
-- Name: user_sessions; Type: TABLE; Schema: core; Owner: postgres
--

CREATE TABLE core.user_sessions (
    session_id uuid DEFAULT core.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    session_token character varying(255) NOT NULL,
    ip_address character varying(50),
    user_agent text,
    login_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    last_activity_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    logout_at timestamp without time zone,
    expires_at timestamp without time zone NOT NULL,
    is_active boolean DEFAULT true,
    CONSTRAINT chk_session_expiry CHECK ((expires_at > login_at))
);

--
-- Name: TABLE user_sessions; Type: COMMENT; Schema: core; Owner: postgres
--

COMMENT ON TABLE core.user_sessions IS 'Active user sessions - 30 minute timeout on inactivity';

--
-- Name: user_tenant_access; Type: TABLE; Schema: core; Owner: postgres
--

CREATE TABLE core.user_tenant_access (
    access_id uuid DEFAULT core.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    access_granted_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    access_granted_by uuid,
    status core.tenant_status DEFAULT 'ACTIVE'::core.tenant_status,
    is_deleted boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by uuid,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_by uuid,
    deleted_at timestamp without time zone,
    deleted_by uuid
);

--
-- Name: TABLE user_tenant_access; Type: COMMENT; Schema: core; Owner: postgres
--

COMMENT ON TABLE core.user_tenant_access IS 'Multi-tenant access - users can access multiple tenants';

--
-- Name: users; Type: TABLE; Schema: core; Owner: postgres
--

CREATE TABLE core.users (
    user_id uuid DEFAULT core.uuid_generate_v4() NOT NULL,
    tenant_id uuid NOT NULL,
    default_branch_id uuid,
    username character varying(100) NOT NULL,
    email character varying(255) NOT NULL,
    email_verified boolean DEFAULT false,
    mobile_number character varying(20),
    mobile_verified boolean DEFAULT false,
    first_name character varying(100) NOT NULL,
    last_name character varying(100) NOT NULL,
    first_name_ar character varying(100),
    last_name_ar character varying(100),
    employee_id character varying(50),
    national_id character varying(255),
    password_hash character varying(255) NOT NULL,
    password_salt character varying(255),
    require_password_change boolean DEFAULT true,
    password_last_changed_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    failed_login_attempts integer DEFAULT 0,
    account_locked_until timestamp without time zone,
    last_login_at timestamp without time zone,
    last_login_ip character varying(50),
    status core.user_status DEFAULT 'ACTIVE'::core.user_status,
    user_type core.user_type DEFAULT 'INTERNAL'::core.user_type,
    language_preference character varying(10) DEFAULT 'en'::character varying,
    timezone character varying(50) DEFAULT 'Asia/Riyadh'::character varying,
    mfa_enabled boolean DEFAULT false,
    mfa_secret character varying(255),
    external_ad_id character varying(255),
    external_system_id character varying(255),
    is_deleted boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by uuid,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_by uuid,
    deleted_at timestamp without time zone,
    deleted_by uuid,
    CONSTRAINT users_language_preference_check CHECK (((language_preference)::text = ANY ((ARRAY['en'::character varying, 'ar'::character varying])::text[])))
);

--
-- Name: TABLE users; Type: COMMENT; Schema: core; Owner: postgres
--

COMMENT ON TABLE core.users IS 'User accounts with email-based authentication';

--
-- Name: COLUMN users.password_hash; Type: COMMENT; Schema: core; Owner: postgres
--

COMMENT ON COLUMN core.users.password_hash IS 'bcrypt hashed password - use crypt(password, gen_salt(bf)) to hash';

--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (audit_id);

--
-- Name: branches branches_pkey; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.branches
    ADD CONSTRAINT branches_pkey PRIMARY KEY (branch_id);

--
-- Name: branches branches_tenant_id_branch_code_key; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.branches
    ADD CONSTRAINT branches_tenant_id_branch_code_key UNIQUE (tenant_id, branch_code);

--
-- Name: group_members group_members_group_id_user_id_key; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.group_members
    ADD CONSTRAINT group_members_group_id_user_id_key UNIQUE (group_id, user_id);

--
-- Name: group_members group_members_pkey; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.group_members
    ADD CONSTRAINT group_members_pkey PRIMARY KEY (member_id);

--
-- Name: group_roles group_roles_group_id_role_id_key; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.group_roles
    ADD CONSTRAINT group_roles_group_id_role_id_key UNIQUE (group_id, role_id);

--
-- Name: group_roles group_roles_pkey; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.group_roles
    ADD CONSTRAINT group_roles_pkey PRIMARY KEY (group_role_id);

--
-- Name: groups groups_pkey; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.groups
    ADD CONSTRAINT groups_pkey PRIMARY KEY (group_id);

--
-- Name: groups groups_tenant_id_group_code_key; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.groups
    ADD CONSTRAINT groups_tenant_id_group_code_key UNIQUE (tenant_id, group_code);

--
-- Name: modules modules_module_code_key; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.modules
    ADD CONSTRAINT modules_module_code_key UNIQUE (module_code);

--
-- Name: modules modules_pkey; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.modules
    ADD CONSTRAINT modules_pkey PRIMARY KEY (module_id);

--
-- Name: password_reset_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (token_id);

--
-- Name: password_reset_tokens password_reset_tokens_token_hash_key; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_token_hash_key UNIQUE (token_hash);

--
-- Name: permissions permissions_module_id_operation_key; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.permissions
    ADD CONSTRAINT permissions_module_id_operation_key UNIQUE (module_id, operation);

--
-- Name: permissions permissions_pkey; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (permission_id);

--
-- Name: role_permissions role_permissions_pkey; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (role_permission_id);

--
-- Name: role_permissions role_permissions_role_id_permission_id_key; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.role_permissions
    ADD CONSTRAINT role_permissions_role_id_permission_id_key UNIQUE (role_id, permission_id);

--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (role_id);

--
-- Name: roles roles_tenant_id_role_code_key; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.roles
    ADD CONSTRAINT roles_tenant_id_role_code_key UNIQUE (tenant_id, role_code);

--
-- Name: tenant_config tenant_config_pkey; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.tenant_config
    ADD CONSTRAINT tenant_config_pkey PRIMARY KEY (config_id);

--
-- Name: tenant_config tenant_config_tenant_id_config_key_key; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.tenant_config
    ADD CONSTRAINT tenant_config_tenant_id_config_key_key UNIQUE (tenant_id, config_key);

--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (tenant_id);

--
-- Name: tenants tenants_tenant_code_key; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.tenants
    ADD CONSTRAINT tenants_tenant_code_key UNIQUE (tenant_code);

--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (user_role_id);

--
-- Name: user_roles user_roles_user_id_role_id_key; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.user_roles
    ADD CONSTRAINT user_roles_user_id_role_id_key UNIQUE (user_id, role_id);

--
-- Name: user_sessions user_sessions_pkey; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (session_id);

--
-- Name: user_sessions user_sessions_session_token_key; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.user_sessions
    ADD CONSTRAINT user_sessions_session_token_key UNIQUE (session_token);

--
-- Name: user_tenant_access user_tenant_access_pkey; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.user_tenant_access
    ADD CONSTRAINT user_tenant_access_pkey PRIMARY KEY (access_id);

--
-- Name: user_tenant_access user_tenant_access_user_id_tenant_id_key; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.user_tenant_access
    ADD CONSTRAINT user_tenant_access_user_id_tenant_id_key UNIQUE (user_id, tenant_id);

--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (user_id);

--
-- Name: users users_tenant_id_email_key; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.users
    ADD CONSTRAINT users_tenant_id_email_key UNIQUE (tenant_id, email);

--
-- Name: users users_tenant_id_username_key; Type: CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.users
    ADD CONSTRAINT users_tenant_id_username_key UNIQUE (tenant_id, username);

--
-- Name: idx_audit_action; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_audit_action ON core.audit_logs USING btree (action_type);

--
-- Name: idx_audit_created; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_audit_created ON core.audit_logs USING btree (created_at DESC);

--
-- Name: idx_audit_entity; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_audit_entity ON core.audit_logs USING btree (entity_type, entity_id);

--
-- Name: idx_audit_tenant; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_audit_tenant ON core.audit_logs USING btree (tenant_id);

--
-- Name: idx_audit_tenant_date; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_audit_tenant_date ON core.audit_logs USING btree (tenant_id, created_at DESC);

--
-- Name: idx_audit_user; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_audit_user ON core.audit_logs USING btree (user_id);

--
-- Name: idx_branches_hq; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_branches_hq ON core.branches USING btree (tenant_id) WHERE ((is_headquarters = true) AND (is_deleted = false));

--
-- Name: idx_branches_status; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_branches_status ON core.branches USING btree (tenant_id, status) WHERE (is_deleted = false);

--
-- Name: idx_branches_tenant; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_branches_tenant ON core.branches USING btree (tenant_id) WHERE (is_deleted = false);

--
-- Name: idx_group_members_group; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_group_members_group ON core.group_members USING btree (group_id) WHERE (is_deleted = false);

--
-- Name: idx_group_members_user; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_group_members_user ON core.group_members USING btree (user_id) WHERE (is_deleted = false);

--
-- Name: idx_group_roles_group; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_group_roles_group ON core.group_roles USING btree (group_id) WHERE (is_deleted = false);

--
-- Name: idx_group_roles_role; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_group_roles_role ON core.group_roles USING btree (role_id) WHERE (is_deleted = false);

--
-- Name: idx_groups_code; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_groups_code ON core.groups USING btree (tenant_id, group_code) WHERE (is_deleted = false);

--
-- Name: idx_groups_tenant; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_groups_tenant ON core.groups USING btree (tenant_id) WHERE (is_deleted = false);

--
-- Name: idx_modules_code; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_modules_code ON core.modules USING btree (module_code) WHERE (is_deleted = false);

--
-- Name: idx_modules_status; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_modules_status ON core.modules USING btree (status) WHERE (is_deleted = false);

--
-- Name: idx_password_reset_expiry; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_password_reset_expiry ON core.password_reset_tokens USING btree (expires_at) WHERE (used_at IS NULL);

--
-- Name: idx_password_reset_token; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_password_reset_token ON core.password_reset_tokens USING btree (token_hash);

--
-- Name: idx_password_reset_user; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_password_reset_user ON core.password_reset_tokens USING btree (user_id);

--
-- Name: idx_permissions_module; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_permissions_module ON core.permissions USING btree (module_id) WHERE (is_deleted = false);

--
-- Name: idx_permissions_operation; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_permissions_operation ON core.permissions USING btree (operation) WHERE (is_deleted = false);

--
-- Name: idx_role_permissions_permission; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_role_permissions_permission ON core.role_permissions USING btree (permission_id) WHERE (is_deleted = false);

--
-- Name: idx_role_permissions_role; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_role_permissions_role ON core.role_permissions USING btree (role_id) WHERE (is_deleted = false);

--
-- Name: idx_roles_code; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_roles_code ON core.roles USING btree (role_code) WHERE (is_deleted = false);

--
-- Name: idx_roles_system; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_roles_system ON core.roles USING btree (is_system_role) WHERE (is_deleted = false);

--
-- Name: idx_roles_tenant; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_roles_tenant ON core.roles USING btree (tenant_id) WHERE (is_deleted = false);

--
-- Name: idx_tenant_config_key; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_tenant_config_key ON core.tenant_config USING btree (tenant_id, config_key) WHERE (is_deleted = false);

--
-- Name: idx_tenant_config_tenant; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_tenant_config_tenant ON core.tenant_config USING btree (tenant_id) WHERE (is_deleted = false);

--
-- Name: idx_tenants_code; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_tenants_code ON core.tenants USING btree (tenant_code) WHERE (is_deleted = false);

--
-- Name: idx_tenants_parent; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_tenants_parent ON core.tenants USING btree (parent_tenant_id) WHERE (is_deleted = false);

--
-- Name: idx_tenants_status; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_tenants_status ON core.tenants USING btree (status) WHERE (is_deleted = false);

--
-- Name: idx_user_roles_role; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_user_roles_role ON core.user_roles USING btree (role_id) WHERE (is_deleted = false);

--
-- Name: idx_user_roles_user; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_user_roles_user ON core.user_roles USING btree (user_id) WHERE (is_deleted = false);

--
-- Name: idx_user_sessions_expiry; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_user_sessions_expiry ON core.user_sessions USING btree (expires_at) WHERE (is_active = true);

--
-- Name: idx_user_sessions_tenant; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_user_sessions_tenant ON core.user_sessions USING btree (tenant_id) WHERE (is_active = true);

--
-- Name: idx_user_sessions_token; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_user_sessions_token ON core.user_sessions USING btree (session_token) WHERE (is_active = true);

--
-- Name: idx_user_sessions_user; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_user_sessions_user ON core.user_sessions USING btree (user_id) WHERE (is_active = true);

--
-- Name: idx_user_tenant_access_status; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_user_tenant_access_status ON core.user_tenant_access USING btree (user_id, tenant_id, status) WHERE (is_deleted = false);

--
-- Name: idx_user_tenant_access_tenant; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_user_tenant_access_tenant ON core.user_tenant_access USING btree (tenant_id) WHERE (is_deleted = false);

--
-- Name: idx_user_tenant_access_user; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_user_tenant_access_user ON core.user_tenant_access USING btree (user_id) WHERE (is_deleted = false);

--
-- Name: idx_users_branch; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_users_branch ON core.users USING btree (default_branch_id) WHERE (is_deleted = false);

--
-- Name: idx_users_email; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_users_email ON core.users USING btree (email) WHERE (is_deleted = false);

--
-- Name: idx_users_employee; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_users_employee ON core.users USING btree (employee_id) WHERE (is_deleted = false);

--
-- Name: idx_users_status; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_users_status ON core.users USING btree (status) WHERE (is_deleted = false);

--
-- Name: idx_users_tenant; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_users_tenant ON core.users USING btree (tenant_id) WHERE (is_deleted = false);

--
-- Name: idx_users_username; Type: INDEX; Schema: core; Owner: postgres
--

CREATE INDEX idx_users_username ON core.users USING btree (tenant_id, username) WHERE (is_deleted = false);

--
-- Name: branches trg_branches_update; Type: TRIGGER; Schema: core; Owner: postgres
--

CREATE TRIGGER trg_branches_update BEFORE UPDATE ON core.branches FOR EACH ROW EXECUTE FUNCTION core.update_timestamp();

--
-- Name: groups trg_groups_update; Type: TRIGGER; Schema: core; Owner: postgres
--

CREATE TRIGGER trg_groups_update BEFORE UPDATE ON core.groups FOR EACH ROW EXECUTE FUNCTION core.update_timestamp();

--
-- Name: modules trg_modules_update; Type: TRIGGER; Schema: core; Owner: postgres
--

CREATE TRIGGER trg_modules_update BEFORE UPDATE ON core.modules FOR EACH ROW EXECUTE FUNCTION core.update_timestamp();

--
-- Name: permissions trg_permissions_update; Type: TRIGGER; Schema: core; Owner: postgres
--

CREATE TRIGGER trg_permissions_update BEFORE UPDATE ON core.permissions FOR EACH ROW EXECUTE FUNCTION core.update_timestamp();

--
-- Name: roles trg_roles_update; Type: TRIGGER; Schema: core; Owner: postgres
--

CREATE TRIGGER trg_roles_update BEFORE UPDATE ON core.roles FOR EACH ROW EXECUTE FUNCTION core.update_timestamp();

--
-- Name: tenant_config trg_tenant_config_update; Type: TRIGGER; Schema: core; Owner: postgres
--

CREATE TRIGGER trg_tenant_config_update BEFORE UPDATE ON core.tenant_config FOR EACH ROW EXECUTE FUNCTION core.update_timestamp();

--
-- Name: tenants trg_tenants_update; Type: TRIGGER; Schema: core; Owner: postgres
--

CREATE TRIGGER trg_tenants_update BEFORE UPDATE ON core.tenants FOR EACH ROW EXECUTE FUNCTION core.update_timestamp();

--
-- Name: user_tenant_access trg_user_tenant_access_update; Type: TRIGGER; Schema: core; Owner: postgres
--

CREATE TRIGGER trg_user_tenant_access_update BEFORE UPDATE ON core.user_tenant_access FOR EACH ROW EXECUTE FUNCTION core.update_timestamp();

--
-- Name: users trg_users_update; Type: TRIGGER; Schema: core; Owner: postgres
--

CREATE TRIGGER trg_users_update BEFORE UPDATE ON core.users FOR EACH ROW EXECUTE FUNCTION core.update_timestamp();

--
-- Name: audit_logs audit_logs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.audit_logs
    ADD CONSTRAINT audit_logs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(tenant_id) ON DELETE CASCADE;

--
-- Name: audit_logs audit_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.audit_logs
    ADD CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.users(user_id) ON DELETE SET NULL;

--
-- Name: branches branches_tenant_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.branches
    ADD CONSTRAINT branches_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(tenant_id) ON DELETE CASCADE;

--
-- Name: group_members group_members_group_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.group_members
    ADD CONSTRAINT group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES core.groups(group_id) ON DELETE CASCADE;

--
-- Name: group_members group_members_user_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.group_members
    ADD CONSTRAINT group_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.users(user_id) ON DELETE CASCADE;

--
-- Name: group_roles group_roles_group_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.group_roles
    ADD CONSTRAINT group_roles_group_id_fkey FOREIGN KEY (group_id) REFERENCES core.groups(group_id) ON DELETE CASCADE;

--
-- Name: group_roles group_roles_role_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.group_roles
    ADD CONSTRAINT group_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES core.roles(role_id) ON DELETE CASCADE;

--
-- Name: groups groups_tenant_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.groups
    ADD CONSTRAINT groups_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(tenant_id) ON DELETE CASCADE;

--
-- Name: password_reset_tokens password_reset_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.users(user_id) ON DELETE CASCADE;

--
-- Name: permissions permissions_module_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.permissions
    ADD CONSTRAINT permissions_module_id_fkey FOREIGN KEY (module_id) REFERENCES core.modules(module_id) ON DELETE CASCADE;

--
-- Name: role_permissions role_permissions_permission_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.role_permissions
    ADD CONSTRAINT role_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES core.permissions(permission_id) ON DELETE CASCADE;

--
-- Name: role_permissions role_permissions_role_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.role_permissions
    ADD CONSTRAINT role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES core.roles(role_id) ON DELETE CASCADE;

--
-- Name: roles roles_tenant_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.roles
    ADD CONSTRAINT roles_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(tenant_id) ON DELETE CASCADE;

--
-- Name: tenant_config tenant_config_tenant_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.tenant_config
    ADD CONSTRAINT tenant_config_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(tenant_id) ON DELETE CASCADE;

--
-- Name: tenants tenants_parent_tenant_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.tenants
    ADD CONSTRAINT tenants_parent_tenant_id_fkey FOREIGN KEY (parent_tenant_id) REFERENCES core.tenants(tenant_id);

--
-- Name: user_roles user_roles_role_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.user_roles
    ADD CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES core.roles(role_id) ON DELETE CASCADE;

--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.users(user_id) ON DELETE CASCADE;

--
-- Name: user_sessions user_sessions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.user_sessions
    ADD CONSTRAINT user_sessions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(tenant_id) ON DELETE CASCADE;

--
-- Name: user_sessions user_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.user_sessions
    ADD CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.users(user_id) ON DELETE CASCADE;

--
-- Name: user_tenant_access user_tenant_access_tenant_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.user_tenant_access
    ADD CONSTRAINT user_tenant_access_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(tenant_id) ON DELETE CASCADE;

--
-- Name: user_tenant_access user_tenant_access_user_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.user_tenant_access
    ADD CONSTRAINT user_tenant_access_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.users(user_id) ON DELETE CASCADE;

--
-- Name: users users_default_branch_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.users
    ADD CONSTRAINT users_default_branch_id_fkey FOREIGN KEY (default_branch_id) REFERENCES core.branches(branch_id);

--
-- Name: users users_tenant_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: postgres
--

ALTER TABLE ONLY core.users
    ADD CONSTRAINT users_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(tenant_id) ON DELETE CASCADE;
