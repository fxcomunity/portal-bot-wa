CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS portal_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS portal_admin_sessions (
  id BIGSERIAL PRIMARY KEY,
  admin_id UUID NOT NULL
    REFERENCES portal_admins(id)
    ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  ip_address VARCHAR(80),
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS portal_admin_sessions_expires_idx
ON portal_admin_sessions (expires_at);

CREATE TABLE IF NOT EXISTS portal_login_attempts (
  ip VARCHAR(80) PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts INTEGER NOT NULL DEFAULT 0,
  blocked_until TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS chess_rooms_updated_at_idx
ON chess_rooms (updated_at);

CREATE INDEX IF NOT EXISTS chess_matches_finished_at_idx
ON chess_matches (finished_at);

INSERT INTO portal_admins (
  username,
  password_hash,
  active
)
VALUES (
  'admin',
  crypt('2006-03-14', gen_salt('bf', 12)),
  TRUE
)
ON CONFLICT (username)
DO UPDATE SET
  password_hash = crypt('2006-03-14', gen_salt('bf', 12)),
  active = TRUE,
  updated_at = NOW();

DELETE FROM portal_admin_sessions
WHERE admin_id = (
  SELECT id
  FROM portal_admins
  WHERE username = 'admin'
);

CREATE OR REPLACE FUNCTION cleanup_stale_chess_rooms()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM chess_rooms
  WHERE updated_at < NOW() - INTERVAL '12 hours';

  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  RETURN deleted_count;
END;
$$;
