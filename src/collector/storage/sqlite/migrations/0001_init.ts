/**
 * Migration 0001 — initial v1 schema.
 *
 * Creates the first-version on-disk schema for the SQLite storage backend:
 * the `events` table (with namespace/session/parent indexes), the
 * `memory_records` table (with its companion FTS5 virtual table for lexical
 * search), and the `_migrations` bookkeeping table the runner uses to track
 * which DDL has been applied.
 *
 * The DDL is embedded here as a string constant so the compiled `dist/` is
 * self-contained — no file-system discovery at runtime. `CREATE TABLE IF NOT
 * EXISTS` / `CREATE INDEX IF NOT EXISTS` / `CREATE VIRTUAL TABLE IF NOT
 * EXISTS` guards are belt-and-braces: the migration runner itself already
 * guards against re-applying a recorded migration, but the `IF NOT EXISTS`
 * clauses keep partial-apply / crash-during-migration retries safe without
 * needing a separate down-migration path (v1 is forward-only).
 *
 * See:
 * - design.md § SQLite DDL (migration 0001) — the authoritative DDL text.
 * - Requirements 5.1, 5.2, 5.3, 5.4.
 */

import type { Migration } from './types.js';

/**
 * The raw DDL applied by migration 0001. Exported so tests can inspect the
 * schema text directly without opening a database.
 *
 * Contents (in order):
 * 1. `events` — STRICT table keyed by `event_id`, with indexes on
 *    `(namespace, valid_time)`, `session_id`, and `parent_event_id`.
 * 2. `memory_records` — STRICT table keyed by `record_id`, with a
 *    `namespace` index for prefix-scoped retrieval.
 * 3. `memory_records_fts` — FTS5 virtual table over `title`, `summary`, and
 *    `facts_text`; `record_id` and `namespace` are carried UNINDEXED so we
 *    can join back to `memory_records` and filter by namespace prefix
 *    without a separate lookup.
 * 4. `_migrations` — STRICT bookkeeping table used by the migration runner
 *    to record applied versions.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4
 */
export const DDL = `
CREATE TABLE IF NOT EXISTS events (
  event_id         TEXT PRIMARY KEY,
  parent_event_id  TEXT,
  session_id       TEXT NOT NULL,
  actor_id         TEXT NOT NULL,
  namespace        TEXT NOT NULL,
  schema_version   INTEGER NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('prompt','tool_use','session_summary','note')),
  body_json        TEXT NOT NULL,
  valid_time       TEXT NOT NULL,
  transaction_time TEXT NOT NULL,
  source_json      TEXT NOT NULL,
  content_hash     TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_events_namespace_valid
  ON events (namespace, valid_time);
CREATE INDEX IF NOT EXISTS idx_events_session
  ON events (session_id);
CREATE INDEX IF NOT EXISTS idx_events_parent
  ON events (parent_event_id);

CREATE TABLE IF NOT EXISTS memory_records (
  record_id             TEXT PRIMARY KEY,
  namespace             TEXT NOT NULL,
  strategy              TEXT NOT NULL,
  title                 TEXT NOT NULL,
  summary               TEXT NOT NULL,
  facts_json            TEXT NOT NULL,
  source_event_ids_json TEXT NOT NULL,
  created_at            TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_memory_records_namespace
  ON memory_records (namespace);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_records_fts USING fts5(
  record_id UNINDEXED,
  namespace UNINDEXED,
  title,
  summary,
  facts_text,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS _migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;
`;

/**
 * Migration 0001: initial schema.
 *
 * The runner wraps `up` in a transaction and records
 * `{version: 1, name: '0001_init'}` in the `_migrations` table on success,
 * so this implementation is just a single `db.exec(DDL)` — all statements
 * in the DDL blob are applied in one call (`better-sqlite3`'s `exec` runs
 * every `;`-separated statement sequentially).
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4
 */
export const migration0001: Migration = {
  version: 1,
  name: '0001_init',
  up: (db) => db.exec(DDL),
};
