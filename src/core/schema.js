// porter stemming over unicode61; '_' is a token character so snake_case identifiers stay whole
// in the content column while their parts live in the decomposed_tokens column.
const TOKENIZE = `tokenize = "porter unicode61 remove_diacritics 2 tokenchars '_'"`;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  project_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, key)
);

-- Subsystem A: long-term memory -------------------------------------------------
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('architecture', 'convention', 'decision', 'fix', 'task')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  source_type TEXT NOT NULL DEFAULT 'agent_observation'
    CHECK (source_type IN ('user_instruction', 'agent_observation', 'test_result')),
  is_contested INTEGER NOT NULL DEFAULT 0,
  contest_note TEXT,
  needs_verification INTEGER NOT NULL DEFAULT 0,
  scope_paths TEXT NOT NULL DEFAULT '[]',
  invalidation_rule TEXT,
  tags TEXT NOT NULL DEFAULT '',
  keywords TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_verified_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id, category, confidence);
CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(project_id, content_hash);

-- Subsystem J: version log. No FK on memory_id on purpose: history must outlive deleted
-- memories so deletions can be rolled back.
CREATE TABLE IF NOT EXISTS memory_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  content_before TEXT,
  content_after TEXT,
  snapshot_before TEXT,
  snapshot_after TEXT,
  altered_reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_versions_memory ON memory_versions(memory_id, id);
CREATE INDEX IF NOT EXISTS idx_memory_versions_project ON memory_versions(project_id, id);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED, title, content, keywords, tags,
  ${TOKENIZE}
);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (id, title, content, keywords, tags)
  VALUES (new.id, new.title, new.content, new.keywords, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  DELETE FROM memories_fts WHERE id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF title, content, keywords, tags ON memories BEGIN
  DELETE FROM memories_fts WHERE id = old.id;
  INSERT INTO memories_fts (id, title, content, keywords, tags)
  VALUES (new.id, new.title, new.content, new.keywords, new.tags);
END;

-- Subsystem C: code index ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS indexed_files (
  project_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL,
  file_hash TEXT NOT NULL,
  language TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, file_path)
);

CREATE TABLE IF NOT EXISTS code_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  language TEXT,
  symbol_type TEXT NOT NULL,
  symbol_name TEXT,
  parent_symbol TEXT,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  chunk_hash TEXT NOT NULL,
  decomposed_tokens TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON code_chunks(project_id, file_path);
CREATE INDEX IF NOT EXISTS idx_chunks_symbol ON code_chunks(project_id, symbol_name);

-- External-content FTS5 index over code_chunks (no duplicated text), kept in sync by triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS code_search_index USING fts5(
  file_path, symbol_name, decomposed_tokens, content,
  content = 'code_chunks', content_rowid = 'id',
  ${TOKENIZE}
);
CREATE TRIGGER IF NOT EXISTS code_chunks_ai AFTER INSERT ON code_chunks BEGIN
  INSERT INTO code_search_index (rowid, file_path, symbol_name, decomposed_tokens, content)
  VALUES (new.id, new.file_path, new.symbol_name, new.decomposed_tokens, new.content);
END;
CREATE TRIGGER IF NOT EXISTS code_chunks_ad AFTER DELETE ON code_chunks BEGIN
  INSERT INTO code_search_index (code_search_index, rowid, file_path, symbol_name, decomposed_tokens, content)
  VALUES ('delete', old.id, old.file_path, old.symbol_name, old.decomposed_tokens, old.content);
END;
CREATE TRIGGER IF NOT EXISTS code_chunks_au AFTER UPDATE ON code_chunks BEGIN
  INSERT INTO code_search_index (code_search_index, rowid, file_path, symbol_name, decomposed_tokens, content)
  VALUES ('delete', old.id, old.file_path, old.symbol_name, old.decomposed_tokens, old.content);
  INSERT INTO code_search_index (rowid, file_path, symbol_name, decomposed_tokens, content)
  VALUES (new.id, new.file_path, new.symbol_name, new.decomposed_tokens, new.content);
END;

-- Subsystem D: checkpoints ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT,
  kind TEXT NOT NULL DEFAULT 'manual',
  goal TEXT NOT NULL,
  files_touched TEXT NOT NULL DEFAULT '[]',
  state_payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_project ON checkpoints(project_id, created_at);

-- Subsystem B: evicted payload recovery store --------------------------------------
CREATE TABLE IF NOT EXISTS evicted_payloads (
  hash TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  command TEXT,
  exit_code INTEGER,
  original_size INTEGER NOT NULL,
  line_count INTEGER NOT NULL,
  stub TEXT,
  signal TEXT,
  error_signature TEXT,
  raw_content TEXT NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evicted_project ON evicted_payloads(project_id, last_seen_at);

CREATE TABLE IF NOT EXISTS command_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  command TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER,
  output_signature TEXT,
  output_hash TEXT,
  error_signature TEXT,
  evicted_hash TEXT,
  line_count INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_project ON command_runs(project_id, command, created_at);

-- Subsystem F: investigation ledger ---------------------------------------------------
CREATE TABLE IF NOT EXISTS investigations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  root_question TEXT,
  hypothesis TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('in_progress', 'confirmed_solution', 'dead_end', 'partially_valid')),
  notes TEXT,
  inspected_paths TEXT NOT NULL DEFAULT '[]',
  error_signature TEXT,
  keywords TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_investigations_project ON investigations(project_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_investigations_sig ON investigations(project_id, error_signature);

CREATE VIRTUAL TABLE IF NOT EXISTS investigations_fts USING fts5(
  id UNINDEXED, hypothesis, root_question, notes, keywords,
  ${TOKENIZE}
);
CREATE TRIGGER IF NOT EXISTS investigations_ai AFTER INSERT ON investigations BEGIN
  INSERT INTO investigations_fts (id, hypothesis, root_question, notes, keywords)
  VALUES (new.id, new.hypothesis, new.root_question, new.notes, new.keywords);
END;
CREATE TRIGGER IF NOT EXISTS investigations_ad AFTER DELETE ON investigations BEGIN
  DELETE FROM investigations_fts WHERE id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS investigations_au AFTER UPDATE OF hypothesis, root_question, notes, keywords ON investigations BEGIN
  DELETE FROM investigations_fts WHERE id = old.id;
  INSERT INTO investigations_fts (id, hypothesis, root_question, notes, keywords)
  VALUES (new.id, new.hypothesis, new.root_question, new.notes, new.keywords);
END;

-- Subsystem G: error signatures and their verified fixes --------------------------------
CREATE TABLE IF NOT EXISTS error_signatures (
  project_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  sample TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  fix_summary TEXT,
  fix_files TEXT NOT NULL DEFAULT '[]',
  fix_diff TEXT,
  investigation_id TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  resolved_at INTEGER,
  PRIMARY KEY (project_id, signature)
);

-- Subsystem I: telemetry (local only) ----------------------------------------------------
CREATE TABLE IF NOT EXISTS telemetry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  tool TEXT,
  latency_ms REAL,
  input_chars INTEGER,
  output_chars INTEGER,
  tokens_saved INTEGER,
  hit INTEGER,
  meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telemetry ON telemetry_events(project_id, created_at);
`;

// v2: Jev engine. Evicted payloads record the model's retention probability; the Ollama embedding
// cache from v1 builds is dropped (semantic reranking now uses the in-process Jev Score primitive).
const SCHEMA_V2 = `
ALTER TABLE evicted_payloads ADD COLUMN p_keep REAL;
DROP TABLE IF EXISTS chunk_embeddings;
`;

/** Ordered migrations; PRAGMA user_version = number of migrations applied. */
export const MIGRATIONS = [SCHEMA_V1, SCHEMA_V2];
