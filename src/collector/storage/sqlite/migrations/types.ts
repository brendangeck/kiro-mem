/**
 * Migration types for the SQLite storage backend.
 *
 * Defines the shape that every versioned DDL migration obeys, plus the error
 * raised when the applied-migrations bookkeeping table disagrees with the
 * code-embedded migration list.
 *
 * The migration runner itself lives in `./runner.ts`; this module is
 * intentionally dependency-free (aside from the `better-sqlite3` type import)
 * so both the runner and individual migration modules (e.g. `0001_init.ts`)
 * can import from it without creating a cycle.
 *
 * See:
 * - design.md § Migration runner
 * - Requirements 5.4 (FTS5 / DDL scope owned by migrations) and 9.4
 *   (migration drift detection).
 */

// `better-sqlite3`'s default export is the `Database` constructor; the
// *instance* type lives on the merged `BetterSqlite3` namespace as
// `BetterSqlite3.Database`. Importing the default as a type alias gives us
// access to that namespace without pulling the runtime module into the type
// graph.
import type BetterSqliteDatabase from 'better-sqlite3';

/** A live `better-sqlite3` database handle (instance type). */
type Database = BetterSqliteDatabase.Database;

/**
 * A single versioned DDL migration.
 *
 * The runner applies migrations in strict ascending `version` order, wraps
 * each `up` call in a transaction, and records `{version, name}` in the
 * `_migrations` bookkeeping table on success. A mismatch between a
 * previously-recorded `name` and the code-embedded `name` for the same
 * `version` surfaces as a {@link MigrationDriftError}.
 *
 * Validates: Requirements 5.4, 9.4
 */
export interface Migration {
  /** Strictly increasing version number. Gaps and duplicates are disallowed. */
  readonly version: number;

  /**
   * Human-readable migration name, e.g. `'0001_init'`. Used for drift
   * detection against the `_migrations` table.
   */
  readonly name: string;

  /**
   * Apply the migration's DDL against `db`. The runner wraps this call in a
   * transaction and records the migration on success; implementations should
   * therefore issue raw DDL (`db.exec(...)`) and leave transaction management
   * to the runner.
   */
  up(db: Database): void;
}

/**
 * Raised when the `_migrations` bookkeeping table contains a row for some
 * version `v` whose `name` disagrees with the code-embedded migration of
 * the same version. Indicates that migrations have been renamed or reordered
 * after being applied — a situation the runner refuses to paper over.
 *
 * Validates: Requirement 9.4
 */
export class MigrationDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationDriftError';
  }
}
