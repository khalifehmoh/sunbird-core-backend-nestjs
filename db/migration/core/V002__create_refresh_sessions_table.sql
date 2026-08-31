-- NestJS cookie refresh sessions. The dump uses core.user_sessions for
-- application session rows; this table stores hashed refresh tokens.

CREATE TABLE IF NOT EXISTS core.refresh_sessions (
    session_id UUID DEFAULT core.uuid_generate_v4() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES core.users(user_id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ip_address VARCHAR(64),
    user_agent TEXT,
    last_activity_at TIMESTAMP,
    logout_at TIMESTAMP,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_refresh_sessions_user
    ON core.refresh_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_active
    ON core.refresh_sessions(token_hash, is_revoked);

-- Application-level tenant scoping is used; disable dump RLS if present.
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'core'
    LOOP
        EXECUTE format(
            'ALTER TABLE core.%I DISABLE ROW LEVEL SECURITY',
            r.tablename
        );
    END LOOP;
END
$$;
