import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MIGRATIONS,
  MigrationDriftError,
  runMigrations,
} from '../../src/collector/storage/sqlite/migrations/index.js';

/**
 * Drift-detection unit test.
 *
 * The runner treats the `_migrations` bookkeeping table as the authoritative
 * record of what was actually applied to this database. If the `name` column
 * for a given `version` disagrees with the code-embedded migration of the
 * same version, migrations have been renamed or reordered after being
 * applied — a situation that is indistinguishable from a corrupted history,
 * and one the runner refuses to silently proceed through.
 *
 * This test proves that by:
 *   1. applying the canonical `MIGRATIONS` list to establish a clean history
 *      (one row in `_migrations` with `name = '0001_init'`);
 *   2. directly rewriting the recorded `name` to something else, simulating
 *      a history that no longer lines up with the code;
 *   3. re-running `runMigrations` with the same in-code list and asserting
 *      the runner throws `MigrationDriftError` with a message that names
 *      both the recorded and in-code identifiers.
 *
 * Validates: Requirement 9.4
 */
describe('runMigrations — drift detection', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('throws MigrationDriftError when _migrations.name disagrees with code (Requirement 9.4)', () => {
    // 1. Apply the canonical migration list. This leaves `_migrations` with
    //    exactly one row: (version=1, name='0001_init', applied_at=<iso>).
    runMigrations(db, MIGRATIONS);

    // Sanity-check the baseline so the mutation in step 2 is meaningful.
    const baseline = db
      .prepare<[], { version: number; name: string }>(
        'SELECT version, name FROM _migrations ORDER BY version',
      )
      .all();
    expect(baseline).toEqual([{ version: 1, name: '0001_init' }]);

    // 2. Overwrite the recorded name in-place to simulate a history that no
    //    longer matches the code. A real-world version of this scenario is
    //    someone renaming `0001_init.ts` in-tree after it has already been
    //    applied to a developer's DB.
    db.prepare('UPDATE _migrations SET name = ? WHERE version = ?').run(
      '0001_tampered',
      1,
    );

    // 3a. Re-running the runner must refuse to proceed.
    expect(() => runMigrations(db, MIGRATIONS)).toThrow(MigrationDriftError);

    // 3b. The error message should name both identifiers so an operator
    //     can see exactly what drifted. We assert on the fragments rather
    //     than the full string so the test stays robust to wording tweaks.
    expect(() => runMigrations(db, MIGRATIONS)).toThrow(/0001_tampered/);
    expect(() => runMigrations(db, MIGRATIONS)).toThrow(/0001_init/);
  });
});
