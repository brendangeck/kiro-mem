import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MIGRATIONS,
  runMigrations,
} from '../src/collector/storage/sqlite/migrations/index.js';

/**
 * Runner happy-path unit tests.
 *
 * Each test opens a fresh `:memory:` database, applies the canonical
 * `MIGRATIONS` list, and inspects `sqlite_master` + `_migrations` to verify
 * the expected schema and bookkeeping rows. Idempotency is covered by the
 * final case; a separate PBT in task 4.8 generalises that over arbitrary
 * prefixes of the migration list.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 9.1, 9.2.
 */
describe('runMigrations — happy path', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, MIGRATIONS);
  });

  afterEach(() => {
    db.close();
  });

  it('creates all expected tables and indexes (Requirement 5.1)', () => {
    const rows = db
      .prepare<[], { name: string; type: string }>(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index')",
      )
      .all();
    const names = new Set(rows.map((r) => r.name));

    // FTS5 virtual tables surface in sqlite_master with type 'table'.
    expect(names.has('events')).toBe(true);
    expect(names.has('memory_records')).toBe(true);
    expect(names.has('memory_records_fts')).toBe(true);
    expect(names.has('_migrations')).toBe(true);

    expect(names.has('idx_events_namespace_valid')).toBe(true);
    expect(names.has('idx_events_session')).toBe(true);
    expect(names.has('idx_events_parent')).toBe(true);
    expect(names.has('idx_memory_records_namespace')).toBe(true);
  });

  it('declares the events table as STRICT (Requirement 5.2)', () => {
    const row = db
      .prepare<[], { sql: string | null }>(
        "SELECT sql FROM sqlite_master WHERE name = 'events'",
      )
      .get();

    expect(row).toBeDefined();
    expect(row?.sql).toBeTruthy();
    expect(row?.sql).toContain('STRICT');
  });

  it('creates the three expected indexes on events (Requirement 5.3)', () => {
    const rows = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'",
      )
      .all();
    const names = new Set(rows.map((r) => r.name));

    expect(names.has('idx_events_namespace_valid')).toBe(true);
    expect(names.has('idx_events_session')).toBe(true);
    expect(names.has('idx_events_parent')).toBe(true);
  });

  it('creates memory_records_fts with the porter unicode61 tokenizer (Requirement 5.4)', () => {
    const row = db
      .prepare<[], { sql: string | null }>(
        "SELECT sql FROM sqlite_master WHERE name = 'memory_records_fts'",
      )
      .get();

    expect(row).toBeDefined();
    expect(row?.sql).toBeTruthy();
    expect(row?.sql).toContain('porter unicode61 remove_diacritics 2');
  });

  it('records migration 0001_init in _migrations with an ISO applied_at (Requirement 9.1)', () => {
    const rows = db
      .prepare<[], { version: number; name: string; applied_at: string }>(
        'SELECT version, name, applied_at FROM _migrations ORDER BY version',
      )
      .all();

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.version).toBe(1);
    expect(row.name).toBe('0001_init');
    expect(typeof row.applied_at).toBe('string');
    expect(Number.isFinite(new Date(row.applied_at).getTime())).toBe(true);
  });

  it('is a no-op when re-invoked with the same migration list (Requirement 9.2)', () => {
    runMigrations(db, MIGRATIONS);

    const { count } = db
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM _migrations')
      .get()!;

    expect(count).toBe(1);
  });
});
