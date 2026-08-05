-- Drift DAG schema (PRD §13.2). Forward-only and idempotent.

CREATE TABLE IF NOT EXISTS drift_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS intents (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT,
  git_sha     TEXT NOT NULL UNIQUE,
  author_type INTEGER NOT NULL,           -- 0 = HUMAN, 1 = AGENT
  author_id   TEXT NOT NULL,
  model       TEXT,
  prompt      TEXT NOT NULL,
  timestamp   INTEGER NOT NULL,           -- epoch milliseconds
  object_path TEXT NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES intents(id)
);

CREATE INDEX IF NOT EXISTS idx_intents_git_sha ON intents(git_sha);
CREATE INDEX IF NOT EXISTS idx_intents_timestamp ON intents(timestamp);

CREATE TABLE IF NOT EXISTS intent_files (
  intent_id     TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  mutation_type INTEGER NOT NULL,         -- 0 ADDED, 1 MODIFIED, 2 DELETED, 3 MOVED, 4 RENAMED
  node_ids      TEXT NOT NULL DEFAULT '[]',
  summary       TEXT,
  PRIMARY KEY (intent_id, file_path),
  FOREIGN KEY (intent_id) REFERENCES intents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_intent_files_path ON intent_files(file_path);
