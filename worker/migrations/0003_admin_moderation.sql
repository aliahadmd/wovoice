ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
  CHECK(role IN ('user', 'admin'));
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK(status IN ('active', 'suspended', 'banned'));
ALTER TABLE users ADD COLUMN suspended_until INTEGER;
ALTER TABLE users ADD COLUMN public_status_message TEXT;
ALTER TABLE users ADD COLUMN status_changed_at INTEGER;
ALTER TABLE users ADD COLUMN quota_limit_audio_seconds REAL;
ALTER TABLE users ADD COLUMN quota_override_expires_at INTEGER;
ALTER TABLE users ADD COLUMN last_activity_at INTEGER;

CREATE INDEX idx_users_status_created ON users(status, created_at DESC);
CREATE INDEX idx_users_last_activity ON users(last_activity_at DESC);

ALTER TABLE service_monthly_usage ADD COLUMN moderation_emails INTEGER NOT NULL DEFAULT 0;

DROP TRIGGER enforce_email_budget_insert;
DROP TRIGGER enforce_email_budget_update;

CREATE TRIGGER enforce_email_budget_insert
BEFORE INSERT ON service_monthly_usage
WHEN NEW.verification_emails + NEW.moderation_emails > 2500
BEGIN SELECT RAISE(ABORT, 'EMAIL_RATE_LIMITED'); END;

CREATE TRIGGER enforce_email_budget_update
BEFORE UPDATE ON service_monthly_usage
WHEN NEW.verification_emails + NEW.moderation_emails > 2500
BEGIN SELECT RAISE(ABORT, 'EMAIL_RATE_LIMITED'); END;

DROP TRIGGER enforce_user_quota_insert;
DROP TRIGGER enforce_user_quota_update;

CREATE TRIGGER enforce_user_quota_insert
BEFORE INSERT ON daily_usage
WHEN NEW.used_audio_seconds + NEW.reserved_audio_seconds > COALESCE(
  (
    SELECT CASE
      WHEN quota_limit_audio_seconds IS NOT NULL
        AND quota_override_expires_at IS NOT NULL
        AND quota_override_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
      THEN quota_limit_audio_seconds
      ELSE 600
    END
    FROM users WHERE id = NEW.user_id
  ),
  600
)
BEGIN SELECT RAISE(ABORT, 'USER_QUOTA_EXCEEDED'); END;

CREATE TRIGGER enforce_user_quota_update
BEFORE UPDATE ON daily_usage
WHEN NEW.used_audio_seconds + NEW.reserved_audio_seconds > COALESCE(
  (
    SELECT CASE
      WHEN quota_limit_audio_seconds IS NOT NULL
        AND quota_override_expires_at IS NOT NULL
        AND quota_override_expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
      THEN quota_limit_audio_seconds
      ELSE 600
    END
    FROM users WHERE id = NEW.user_id
  ),
  600
)
BEGIN SELECT RAISE(ABORT, 'USER_QUOTA_EXCEEDED'); END;

CREATE TABLE user_activity_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  request_id TEXT,
  status_code INTEGER,
  outcome_code TEXT,
  model TEXT,
  audio_seconds REAL,
  estimated_neurons REAL,
  estimated_cost_usd REAL,
  latency_ms INTEGER,
  item_count INTEGER,
  device_name TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_activity_user_created ON user_activity_events(user_id, created_at DESC, id DESC);
CREATE INDEX idx_activity_created ON user_activity_events(created_at);

CREATE TABLE admin_audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  internal_reason TEXT NOT NULL,
  before_state TEXT,
  after_state TEXT,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_admin_audit_created ON admin_audit_events(created_at DESC, id DESC);
CREATE INDEX idx_admin_audit_target ON admin_audit_events(target_user_id, created_at DESC);

CREATE TABLE moderation_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  public_message TEXT NOT NULL,
  effective_until INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX idx_moderation_notifications_pending
  ON moderation_notifications(status, next_attempt_at, created_at);
CREATE INDEX idx_moderation_notifications_user
  ON moderation_notifications(user_id, created_at DESC);

CREATE TABLE service_daily_aggregates (
  date_key TEXT PRIMARY KEY,
  registered_users INTEGER NOT NULL DEFAULT 0,
  active_users INTEGER NOT NULL DEFAULT 0,
  login_successes INTEGER NOT NULL DEFAULT 0,
  transcriptions_succeeded INTEGER NOT NULL DEFAULT 0,
  transcriptions_failed INTEGER NOT NULL DEFAULT 0,
  audio_seconds REAL NOT NULL DEFAULT 0,
  estimated_neurons REAL NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  total_latency_ms INTEGER NOT NULL DEFAULT 0,
  latency_samples INTEGER NOT NULL DEFAULT 0,
  sync_operations INTEGER NOT NULL DEFAULT 0,
  quota_rejections INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE service_daily_active_users (
  date_key TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(date_key, user_id)
);
CREATE INDEX idx_service_daily_active_users_date ON service_daily_active_users(date_key);

CREATE TRIGGER increment_daily_active_users
AFTER INSERT ON service_daily_active_users
BEGIN
  UPDATE service_daily_aggregates
  SET active_users = active_users + 1
  WHERE date_key = NEW.date_key;
END;
