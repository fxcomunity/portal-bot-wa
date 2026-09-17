-- Jack Portal admin security schema

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

CREATE INDEX IF NOT EXISTS
portal_admin_sessions_expires_idx
ON portal_admin_sessions (expires_at);

CREATE TABLE IF NOT EXISTS portal_login_attempts (
  ip VARCHAR(80) PRIMARY KEY,
  window_started_at TIMESTAMPTZ
    NOT NULL DEFAULT NOW(),
  attempts INTEGER NOT NULL DEFAULT 0,
  blocked_until TIMESTAMPTZ
);

-- =========================================================
-- BUAT AKUN ADMIN
-- GANTI PASSWORD DI BAWAH SEBELUM MENJALANKAN.
-- Minimal 12 karakter.
-- =========================================================

INSERT INTO portal_admins (
  username,
  password_hash
)
VALUES (
  'admin',
  crypt(
    'GANTI_DENGAN_PASSWORD_KUAT_MIN_12_KARAKTER',
    gen_salt('bf', 12)
  )
)
ON CONFLICT (username)
DO NOTHING;

-- =========================================================
-- CLEANUP ROOM > 12 JAM
-- =========================================================

CREATE OR REPLACE FUNCTION cleanup_stale_chess_rooms()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN

  DELETE FROM chess_rooms
  WHERE updated_at <
    NOW() - INTERVAL '12 hours';

  GET DIAGNOSTICS
    deleted_count = ROW_COUNT;

  RETURN deleted_count;
END;
$$;

-- Manual cleanup:
-- SELECT cleanup_stale_chess_rooms();

-- =========================================================
-- OPTIONAL PG_CRON
-- =========================================================
--
-- Kalau database Neon lu menyediakan pg_cron,
-- aktifkan bagian ini supaya cleanup tetap berjalan
-- walaupun portal sedang tidak menerima request.
--
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
--
-- SELECT cron.schedule(
--   'jack-portal-cleanup-stale-rooms',
--   '*/15 * * * *',
--   $$SELECT cleanup_stale_chess_rooms();$$
-- );

