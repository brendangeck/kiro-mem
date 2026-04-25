/**
 * Property-based test for the migration runner's idempotency guarantee.
 *
 * Covers Correctness Property P6: for any prefix of the canonical
 * `MIGRATIONS` list, running `runMigrations` twice against the same
 * database produces an identical snapshot of both `sqlite_master` and
 * `_migrations` — re-invocation is a no-op at the schema level *and* at
 * the bookkeeping level.
 *
 * In v1 the canonical list contains a single migration (`migration0001`),
 * so `k ∈ {0, 1}` is a short universe. The property is expressed
 * generally so that additional migrations in later milestones (v2 adds
 * `0002_embeddings`, etc.) extend coverage automatically without a test
 * change.
 *
 * @see .kiro/specs/event-schema-and-storage/design.md § P6 Migration runner idempotency
 * @see .kiro/specs/event-schema-and-storage/requirements.md § Requirement 5.5, 9.5
 */

import Database from 'better-sqlite3';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  MIGRATIONS,
  runMigrations,
} from '../../src/collector/storage/sqlite/migrations/index.js';

/**
 * Row shape returned by the `sqlite_master` snapshot query. Includes every
 * field that drives schema identity: the object's `name`, its `type`
 * (`table` / `index` / `trigger` / …), and its reconstructed `sql`.
 * Auto-generated indexes (e.g. SQLite internal FTS5 shadow objects) have
 * `sql = null`; preserving the column keeps those rows in the snapshot
 * too.
 */
interface SchemaRow {
  name: string;
  type: string;
  sql: string | null;
}

/**
 * Row shape returned by the `_migrations` snapshot query. We deliberately
 * include `applied_at` even though the runner stamps it with
 * `new Date().toISOString()` on each insert: the contract under test is
 * that the *second* `runMigrations` call performs no inserts, so
 * `applied_at` must be identical across both snapshots. Including it
 * sharpens the test — a regression where the runner re-inserted rows (or
 * touched existing ones) would show up as a timestamp drift.
 */
interface MigrationRow {
  version: number;
  name: string;
  applied_at: string;
}

describe('runMigrations — property: idempotency over arbitrary prefixes (P6)', () => {
  it('produces identical sqlite_master and _migrations snapshots on a second invocation', () => {
    /**
     * **Validates: Requirements 5.5, 9.5**
     *
     * For any prefix `MIGRATIONS.slice(0, k)` of the canonical migration
     * list (including the empty prefix `k === 0`), running `runMigrations`
     * twice against a fresh in-memory database MUST leave both the
     * schema catalogue (`sqlite_master`) and the bookkeeping table
     * (`_migrations`) byte-for-byte unchanged between the two calls.
     *
     * The empty-prefix case (`k === 0`) still exercises the runner's
     * `_migrations` bootstrap: the first call creates the table, and
     * the second call must find it already present and apply nothing.
     */
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MIGRATIONS.length }), (k) => {
        const db = new Database(':memory:');
        try {
          const prefix = MIGRATIONS.slice(0, k);

          runMigrations(db, prefix);
          const schemaAfterFirst = db
            .prepare<[], SchemaRow>(
              'SELECT name, type, sql FROM sqlite_master ORDER BY type, name',
            )
            .all();
          const migrationsAfterFirst = db
            .prepare<[], MigrationRow>(
              'SELECT version, name, applied_at FROM _migrations ORDER BY version',
            )
            .all();

          runMigrations(db, prefix);
          const schemaAfterSecond = db
            .prepare<[], SchemaRow>(
              'SELECT name, type, sql FROM sqlite_master ORDER BY type, name',
            )
            .all();
          const migrationsAfterSecond = db
            .prepare<[], MigrationRow>(
              'SELECT version, name, applied_at FROM _migrations ORDER BY version',
            )
            .all();

          expect(schemaAfterSecond).toEqual(schemaAfterFirst);
          expect(migrationsAfterSecond).toEqual(migrationsAfterFirst);
        } finally {
          db.close();
        }
      }),
    );
  });
});
