/**
 * Migration runner for the SQLite storage backend.
 *
 * Applies a list of code-embedded {@link Migration} objects against an open
 * `better-sqlite3` database handle in strict ascending `version` order,
 * recording each applied version in the `_migrations` bookkeeping table.
 * The runner is idempotent: re-running with the same migration list after
 * every migration has been applied is a no-op.
 *
 * Design reference: `.kiro/specs/event-schema-and-storage/design.md`
 * § Migration runner (algorithmic pseudocode).
 *
 * Validates: Requirements 5.1, 5.2, 5.5, 9.1, 9.2, 9.3, 9.4, 9.5.
 */

import type BetterSqliteDatabase from 'better-sqlite3';

import { MigrationDriftError, type Migration } from './types.js';

/** A live `better-sqlite3` database handle (instance type). */
type Database = BetterSqliteDatabase.Database;

/**
 * DDL used to bootstrap the `_migrations` bookkeeping table.
 *
 * Run outside any transaction *before* the first migration, so the table
 * exists whether or not migration `0001_init` has been applied yet. Kept
 * byte-for-byte in step with the `_migrations` block in
 * {@link ../0001_init.ts} — both paths must produce the same schema so the
 * `IF NOT EXISTS` guard in migration 0001 is a safe no-op after bootstrap.
 */
const MIGRATIONS_TABLE_DDL =
  'CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;';

/**
 * Apply every pending migration in `migrations` to `db`.
 *
 * Behaviour, following the pseudocode in design.md § Migration runner:
 *
 * 1. Validate that `migrations` is strictly ascending by `version`. Gaps
 *    are tolerated (the acceptance criteria in Requirement 9 do not require
 *    a contiguous sequence); duplicates and out-of-order entries are not.
 * 2. Bootstrap the `_migrations` table (via `CREATE TABLE IF NOT EXISTS`)
 *    outside any transaction. This runs before any migration so the runner
 *    does not depend on migration `0001` having already been applied.
 * 3. Read the current `_migrations` rows and drift-check each one against
 *    the code-embedded list:
 *      - if a recorded `(version, name)` disagrees with the in-code name
 *        for the same version, throw {@link MigrationDriftError};
 *      - if a recorded version has no corresponding in-code migration at
 *        all (code has been rolled back or truncated), also throw
 *        `MigrationDriftError`.
 *    No migrations are applied when drift is detected.
 * 4. For every migration whose `version` exceeds the highest already-applied
 *    version, wrap `m.up(db)` and the bookkeeping `INSERT` in a single
 *    `better-sqlite3` transaction via `db.transaction(...)()`. If `up`
 *    throws, the transaction rolls back (leaving `_migrations` unchanged)
 *    and the exception propagates out of `runMigrations`.
 *
 * **Preconditions.**
 * - `db` is open and no other writer is active on it.
 * - `migrations` is strictly ascending by `version` (enforced).
 *
 * **Postconditions.**
 * - Every applied migration has a row in `_migrations` with
 *   `applied_at` set to the UTC ISO 8601 timestamp at insert time.
 * - Re-invoking with the same `migrations` list is a no-op.
 *
 * **Errors.**
 * - `Error` — when `migrations` is not strictly ascending (code bug, not
 *   a DB-vs-code mismatch, so {@link MigrationDriftError} is not used).
 * - {@link MigrationDriftError} — when `_migrations` has a row that the
 *   in-code list cannot match by `(version, name)`.
 * - Any error thrown by `m.up(db)` — transaction rolls back first.
 *
 * Validates: Requirements 5.1, 5.2, 5.5, 9.1, 9.2, 9.3, 9.4, 9.5.
 */
export function runMigrations(db: Database, migrations: readonly Migration[]): void {
  // 1. Validate strict ascending order over the input list. A violation is a
  //    programming mistake in the caller (e.g. mis-ordered migration array),
  //    not drift between code and database, so we throw a plain Error.
  for (let i = 1; i < migrations.length; i++) {
    const prev = migrations[i - 1]!;
    const curr = migrations[i]!;
    if (curr.version <= prev.version) {
      throw new Error(
        `migrations must be strictly ascending; got version ${String(curr.version)} after version ${String(prev.version)}`,
      );
    }
  }

  // 2. Bootstrap the bookkeeping table. `CREATE TABLE IF NOT EXISTS` is safe
  //    to run every time; on a freshly-initialised DB this is the first DDL
  //    to execute, so migration 0001 can still declare the same table with
  //    its own `IF NOT EXISTS` guard without conflict.
  db.exec(MIGRATIONS_TABLE_DDL);

  // 3. Read what has already been applied, in version order.
  const selectApplied = db.prepare<[], { version: number; name: string }>(
    'SELECT version, name FROM _migrations ORDER BY version',
  );
  const applied = selectApplied.all();

  // 3a. Drift check. The applied rows must form a contiguous prefix of
  //     the in-code migrations array. This catches:
  //       - name mismatches (migration renamed after being applied)
  //       - version mismatches (migrations reordered)
  //       - gaps (e.g. DB has [1,3] but code has [1,2,3] — version 2
  //         was somehow skipped and must not remain skipped)
  //       - applied versions with no in-code counterpart (code truncated)
  //     The runner refuses to proceed in any of these cases.
  if (applied.length > migrations.length) {
    throw new MigrationDriftError(
      `migration drift: DB has ${String(applied.length)} applied migrations but code only has ${String(migrations.length)}`,
    );
  }
  for (let i = 0; i < applied.length; i++) {
    const row = applied[i]!;
    const inCode = migrations[i]!;
    if (row.version !== inCode.version || row.name !== inCode.name) {
      throw new MigrationDriftError(
        `migration drift at position ${String(i)}: DB has (${String(row.version)}, ${row.name}), code has (${String(inCode.version)}, ${inCode.name})`,
      );
    }
  }

  // 4. Determine the frontier and apply every migration beyond it.
  const maxApplied = applied.length === 0 ? 0 : applied[applied.length - 1]!.version;

  const insertApplied = db.prepare<[number, string, string]>(
    'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const m of migrations) {
    if (m.version <= maxApplied) continue;

    // `db.transaction(fn)` returns a wrapper that runs `fn` inside a
    // BEGIN/COMMIT, rolling back on any thrown error. Invoking it with `()`
    // executes the transaction. If `m.up` throws, the INSERT below never
    // runs and `_migrations` is left untouched — satisfying Requirement 9.3.
    const apply = db.transaction(() => {
      m.up(db);
      insertApplied.run(m.version, m.name, new Date().toISOString());
    });
    apply();
  }
}
