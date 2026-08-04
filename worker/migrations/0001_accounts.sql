PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email_lookup TEXT NOT NULL UNIQUE,
  email_ciphertext TEXT NOT NULL,
  email_nonce TEXT NOT NULL,
  email_key_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  verified_at INTEGER NOT NULL,
  terms_version TEXT NOT NULL,
  wrapped_vault_key TEXT,
  wrapped_vault_nonce TEXT,
  vault_key_version INTEGER
);

CREATE TABLE login_challenges (
  id TEXT PRIMARY KEY,
  email_lookup TEXT NOT NULL,
  email_ciphertext TEXT NOT NULL,
  email_nonce TEXT NOT NULL,
  intent TEXT NOT NULL CHECK(intent IN ('login', 'delete')),
  code_hash TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resend_after INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX idx_login_challenges_email_created
  ON login_challenges(email_lookup, created_at DESC);

CREATE TABLE authorization_codes (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('login', 'delete')),
  code_challenge TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX idx_authorization_codes_user ON authorization_codes(user_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  authorization_code_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL,
  access_hash TEXT NOT NULL UNIQUE,
  access_expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX idx_sessions_user ON sessions(user_id, created_at DESC);

CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  replaced_by TEXT,
  parent_id TEXT UNIQUE
);
CREATE INDEX idx_refresh_tokens_session ON refresh_tokens(session_id);

CREATE TABLE daily_usage (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date_key TEXT NOT NULL,
  used_audio_seconds REAL NOT NULL DEFAULT 0,
  reserved_audio_seconds REAL NOT NULL DEFAULT 0,
  used_neurons REAL NOT NULL DEFAULT 0,
  reserved_neurons REAL NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, date_key)
);

CREATE TABLE global_daily_usage (
  date_key TEXT PRIMARY KEY,
  used_neurons REAL NOT NULL DEFAULT 0,
  reserved_neurons REAL NOT NULL DEFAULT 0
);

CREATE TABLE quota_reservations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date_key TEXT NOT NULL,
  audio_seconds REAL NOT NULL,
  reserved_neurons REAL NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reserved', 'completed', 'released'))
);
CREATE INDEX idx_quota_reservations_expiry ON quota_reservations(status, expires_at);

CREATE TRIGGER enforce_user_quota_insert
BEFORE INSERT ON daily_usage
WHEN NEW.used_audio_seconds + NEW.reserved_audio_seconds > 600
BEGIN SELECT RAISE(ABORT, 'USER_QUOTA_EXCEEDED'); END;

CREATE TRIGGER enforce_user_quota_update
BEFORE UPDATE ON daily_usage
WHEN NEW.used_audio_seconds + NEW.reserved_audio_seconds > 600
BEGIN SELECT RAISE(ABORT, 'USER_QUOTA_EXCEEDED'); END;

CREATE TRIGGER enforce_global_quota_insert
BEFORE INSERT ON global_daily_usage
WHEN NEW.used_neurons + NEW.reserved_neurons > 8000
BEGIN SELECT RAISE(ABORT, 'SERVICE_DAILY_LIMIT_REACHED'); END;

CREATE TRIGGER enforce_global_quota_update
BEFORE UPDATE ON global_daily_usage
WHEN NEW.used_neurons + NEW.reserved_neurons > 8000
BEGIN SELECT RAISE(ABORT, 'SERVICE_DAILY_LIMIT_REACHED'); END;

CREATE TABLE service_monthly_usage (
  month_key TEXT PRIMARY KEY,
  verification_emails INTEGER NOT NULL DEFAULT 0
);

CREATE TRIGGER enforce_email_budget_insert
BEFORE INSERT ON service_monthly_usage
WHEN NEW.verification_emails > 2500
BEGIN SELECT RAISE(ABORT, 'EMAIL_RATE_LIMITED'); END;

CREATE TRIGGER enforce_email_budget_update
BEFORE UPDATE ON service_monthly_usage
WHEN NEW.verification_emails > 2500
BEGIN SELECT RAISE(ABORT, 'EMAIL_RATE_LIMITED'); END;

CREATE TABLE sync_items (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK(item_type IN ('history', 'dictionary', 'analytics')),
  item_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  key_version INTEGER NOT NULL,
  nonce TEXT,
  ciphertext TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  modified_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, item_type, item_id)
);

CREATE TABLE sync_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sync_changes_user_seq ON sync_changes(user_id, seq);
