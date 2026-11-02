CREATE TABLE ai_config_revisions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('draft', 'published')),
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  source_revision_id TEXT REFERENCES ai_config_revisions(id),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_config_revisions_version ON ai_config_revisions(version DESC);

CREATE TABLE ai_config_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  active_revision_id TEXT REFERENCES ai_config_revisions(id),
  draft_revision_id TEXT REFERENCES ai_config_revisions(id)
);
INSERT INTO ai_config_state(id, version) VALUES(1, 0);

CREATE TRIGGER immutable_ai_config_revision
BEFORE UPDATE OF id, version, kind, config_json, source_revision_id, reason, created_at ON ai_config_revisions
BEGIN SELECT RAISE(ABORT, 'AI_CONFIG_REVISION_IMMUTABLE'); END;
