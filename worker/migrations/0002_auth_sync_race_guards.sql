ALTER TABLE authorization_codes ADD COLUMN challenge_id TEXT;

CREATE UNIQUE INDEX idx_authorization_codes_challenge
  ON authorization_codes(challenge_id)
  WHERE challenge_id IS NOT NULL;

CREATE TRIGGER enforce_sync_version_progression
BEFORE UPDATE ON sync_items
WHEN NEW.version != OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'SYNC_CONFLICT'); END;
