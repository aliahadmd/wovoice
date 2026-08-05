CREATE TABLE admin_login_challenges (
  id TEXT PRIMARY KEY,
  email_lookup TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resend_after INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX idx_admin_login_challenges_email_created
  ON admin_login_challenges(email_lookup, created_at DESC);
CREATE INDEX idx_admin_login_challenges_expiry
  ON admin_login_challenges(expires_at);

CREATE TABLE admin_browser_sessions (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL UNIQUE REFERENCES admin_login_challenges(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX idx_admin_browser_sessions_token ON admin_browser_sessions(token_hash);
CREATE INDEX idx_admin_browser_sessions_user ON admin_browser_sessions(user_id, created_at DESC);
CREATE INDEX idx_admin_browser_sessions_expiry
  ON admin_browser_sessions(idle_expires_at, absolute_expires_at);
