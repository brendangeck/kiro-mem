import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migration0001 } from '../../src/collector/storage/sqlite/migrations/0001_init.js';
import {
  runMigrations,
  type Migration,
} from '../../src/collector/storage/sqlite/migrations/index.js';

/**
 * Rollback-on-failure unit test.
 *
 * When a migration's `up` throws mid-flight, the runner wraps both the
 * user-supplied DDL and the `_migrations` bookkeeping insert in a single
 * `better-sqlite3` transaction. A thrown error must leave the database
 * exactly as it was before the migration started: no bookkeeping row for
 * the failed version, and no lingering DDL side effects from whatever the
 * migration managed to run before it threw.
 *
 * This test proves that by:
 *   1. applying the canonical `migration0001` first to establish a
 *      known-good baseline;
 *   2. snapshotting `sqlite_master` and `_migrations`;
 *   3. running a fake version-2 migration whose `up` first issues a
 *      `CREATE TABLE should_not_exist (...)` and *then* throws;
 *   4. asserting the throw propagates, `_migrations` is unchanged, and
 *      `should_not_exist` was rolled back alongside the bookkeeping insert.
 *
 * Validates: Requirement 9.3
 */
describe('runMigrations — rollback on failure', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('rolls back the full transaction when a migration throws (Requirement 9.3)', () => {
    // 1. Apply the canonical migration 0001 to establish a baseline. The
    //    fake migration we're about to add needs a pre-existing applied
    //    version so we can meaningfully assert _migrations is unchanged.
    runMigrations(db, [migration0001]);

    // 2. Snapshot schema + bookkeeping state before the failing migration.
    const schemaBefore = db
      .prepare<[], { name: string; type: string; sql: string | null }>(
        "SELECT name, type, sql FROM sqlite_master ORDER BY type, name",
      )
      .all();
    const migrationsBefore = db
      .prepare<[], { version: number; name: string; applied_at: string }>(
        'SELECT version, name, applied_at FROM _migrations ORDER BY version',
      )
      .all();

    // Sanity: baseline looks right — one row for 0001_init, and no
    //         `should_not_exist` table yet.
    expect(migrationsBefore).toHaveLength(1);
    expect(migrationsBefore[0]?.name).toBe('0001_init');
    expect(
      schemaBefore.some((r) => r.name === 'should_not_exist'),
    ).toBe(false);

    // 3. Define a fake version-2 migration whose `up` first creates a
    //    table and then throws. Creating the table *before* throwing is
    //    the whole point: if the runner's transaction boundary is wrong,
    //    the CREATE TABLE will survive even though the bookkeeping
    //    INSERT never ran.
    const fakeMigration: Migration = {
      version: 2,
      name: '0002_fake_failure',
      up: (d) => {
        d.exec('CREATE TABLE should_not_exist (x TEXT)');
        throw new Error('boom');
      },
    };

    // 4a. The failure must propagate out of runMigrations.
    expect(() => runMigrations(db, [migration0001, fakeMigration])).toThrow(
      'boom',
    );

    // 4b. `_migrations` still contains only version 1. No row for version 2.
    const migrationsAfter = db
      .prepare<[], { version: number; name: string; applied_at: string }>(
        'SELECT version, name, applied_at FROM _migrations ORDER BY version',
      )
      .all();
    expect(migrationsAfter).toEqual(migrationsBefore);
    expect(migrationsAfter.some((r) => r.version === 2)).toBe(false);

    // 4c. The CREATE TABLE inside the failing migration was rolled back
    //     along with the rest of the transaction. This is the critical
    //     assertion: bookkeeping *and* DDL both revert on failure.
    const shouldNotExist = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE name = 'should_not_exist'",
      )
      .all();
    expect(shouldNotExist).toEqual([]);

    // 4d. Full schema snapshot is identical to the pre-failure snapshot —
    //     nothing else leaked either.
    const schemaAfter = db
      .prepare<[], { name: string; type: string; sql: string | null }>(
        "SELECT name, type, sql FROM sqlite_master ORDER BY type, name",
      )
      .all();
    expect(schemaAfter).toEqual(schemaBefore);
  });
});
