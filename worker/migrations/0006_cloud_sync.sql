-- Cloud sync (v2): history, dictionary, and analytics are stored per account and
-- encrypted by the Worker, so signing in is all a device needs. Each account has
-- its own data key, wrapped by the SYNC_KEK Worker secret (envelope encryption);
-- records are AES-GCM ciphertext bound to their account, type, and id. The v1
-- tables (sync_items, sync_changes) and vault columns stay until the v1 sunset.

ALTER TABLE users ADD COLUMN data_key_wrapped TEXT;
ALTER TABLE users ADD COLUMN data_key_nonce TEXT;
ALTER TABLE users ADD COLUMN data_key_kek_version INTEGER;
ALTER TABLE users ADD COLUMN history_sync_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN history_retention_days INTEGER
  CHECK(history_retention_days IS NULL OR history_retention_days IN (30, 90, 365));
-- Set when a device that held the v1 vault key has re-uploaded its contents
-- through v2; the v1 ciphertext is purged after a grace period.
ALTER TABLE users ADD COLUMN sync_v1_migrated_at INTEGER;

CREATE TABLE sync_records (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK(item_type IN ('history', 'dictionary', 'analytics')),
  item_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  -- Generation of the account data key that sealed this record (1 until rotated).
  key_version INTEGER,
  nonce TEXT,
  ciphertext TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  -- The record's own creation time (from its payload), for history retention.
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, item_type, item_id)
);
CREATE INDEX idx_sync_records_retention
  ON sync_records(item_type, deleted, created_at);

CREATE TRIGGER enforce_sync_record_version_progression
BEFORE UPDATE OF version ON sync_records
WHEN NEW.version != OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'SYNC_CONFLICT'); END;

-- One change row per record, always at the record's latest write: each write
-- replaces the record's earlier row, so the feed never grows past the record count.
CREATE TABLE sync_record_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, item_type, item_id)
);
CREATE INDEX idx_sync_record_changes_user_seq ON sync_record_changes(user_id, seq);
