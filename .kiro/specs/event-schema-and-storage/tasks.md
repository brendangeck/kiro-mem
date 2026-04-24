# Implementation Plan: Event Schema and Storage

Tasks are organized to land in dependency order: types first (everything imports them), then storage interface, then migration runner, then SQLite backend, then property-based tests. PBT tasks are marked `[PBT]` and correspond to the correctness properties in [design.md § Correctness Properties](./design.md#correctness-properties).

All tasks should be executed against the constraints in [requirements.md](./requirements.md) and the shapes in [design.md](./design.md).

- [x] 1. Add project dependencies and scaffolding
  - Add `better-sqlite3@^12`, `zod@^3.23` to `dependencies` in `package.json`.
  - Add `@types/better-sqlite3`, `fast-check` to `devDependencies` in `package.json`.
  - Run `npm install` to refresh the lockfile.
  - Verify `npm run typecheck` still passes after the dependency install.
  - _Requirements: 13.1, 13.2, 13.3_

- [ ] 2. Define canonical types and Zod validators in `src/types/`
  - [x] 2.1 Replace the hand-written interfaces in `src/types/index.ts` with Zod-schema-derived types.
    - Create `src/types/schemas.ts` with `EventSchema`, `EventBodySchema`, `EventSourceSchema`, `MemoryRecordSchema` and the regex constants `ULID_RE`, `RECORD_ID_RE`, `NAMESPACE_RE`, `CONTENT_HASH_RE` per [design.md § Zod Schemas](./design.md#zod-schemas).
    - Re-export `type KiroMemEvent = z.infer<typeof EventSchema>` and `type MemoryRecord = z.infer<typeof MemoryRecordSchema>` from `src/types/index.ts` to keep the public import path unchanged.
    - Export `parseEvent(input: unknown): KiroMemEvent` and `parseMemoryRecord(input: unknown): MemoryRecord` helpers.
    - Keep the existing re-exports from `src/index.ts`; confirm `EventKind`, `EventBody`, `EventSource`, `StorageBackend` still resolve.
  - [x] 2.2 Write example-level unit tests for the schema surface
    - One test per branch of `EventBody` (text / message / json).
    - One test per enumerated value of `kind`.
    - One test for the optional `content_hash` field (present + absent).
    - One test confirming `ZodError.issues[0].path` identifies the broken field for each top-level violation.
    - _Requirements: 1.1–1.5, 2.1, 2.6, 2.11, 3.1_
  - [x] 2.3 [PBT] Property: `parseEvent` accepts arbitrary valid events (round-trip through schema).
    - Build an `arbitraryEvent()` generator in `test/arbitrary.ts` that produces a valid `KiroMemEvent` (ULID gen, namespace gen, body variants, ISO timestamps).
    - Assert: `parseEvent(e) deep-equals e` for any generated `e`.
    - _Requirements: 2.1, Correctness Property P1 (validator side)_
  - [x] 2.4 [PBT] Property: `parseEvent` rejects mutated inputs
    - Generate a valid event, then apply a single targeted mutation (break `event_id`, break `namespace`, flip `schema_version`, corrupt `kind`, mismatch `body.type`, break `valid_time`, break `content_hash`, break `source.surface`).
    - Assert: `parseEvent` throws `ZodError` AND the error path names the mutated field.
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 2.8, 2.9, 2.10, 2.11, Correctness Property P5_
  - [x] 2.5 Edge-case test: oversized body (≥ 1 MiB) is rejected
    - Exactly one test per variant with content just over 1 MiB.
    - _Requirements: 2.7, 12.3_
  - [x] 2.6 [PBT] Property: `parseMemoryRecord` round-trips valid records and rejects mutations
    - Build `arbitraryMemoryRecord()` generator.
    - Two properties: valid → succeeds; one-field mutation → fails.
    - _Requirements: 3.2, 3.3, 3.4_
  - [x] 2.7 Edge-case tests: title/summary length boundaries
    - title at 0, 1, 200, 201 chars. summary at 0, 1, 4000, 4001 chars.
    - _Requirements: 3.5_

- [ ] 3. Define the `StorageBackend` interface in `src/collector/storage/`
  - [x] 3.1 Expand `src/collector/storage/index.ts`
    - Re-export `StorageBackend` from `src/types/index.ts` (preserving current surface).
    - Add a `SearchParams` type (`{ namespace: string; query: string; limit: number }`) if not already in types, and re-export it.
    - Add a TSDoc block documenting every method's contract from [design.md § Key Functions](./design.md#key-functions-with-formal-specifications).
  - [x] 3.2 Type-level example test
    - Write a compile-only test that asserts the interface has the five methods with the expected signatures.
    - Use a dummy class that `implements StorageBackend` to force the structural check.
    - _Requirements: 4.1–4.6, 11.3_

- [ ] 4. Build the migration runner in `src/collector/storage/sqlite/migrations/`
  - [x] 4.1 Create `src/collector/storage/sqlite/migrations/types.ts`
    - Export `Migration` interface (`{ version: number; name: string; up: (db: Database) => void }`).
    - Export `MigrationDriftError` class extending `Error`.
  - [x] 4.2 Create `src/collector/storage/sqlite/migrations/runner.ts`
    - Implement `runMigrations(db, migrations)` per the algorithmic pseudocode in [design.md § Migration runner](./design.md#migration-runner).
    - Wrap each migration's `up` call in `db.transaction(...)()`.
    - Insert `_migrations` bookkeeping rows with `applied_at = new Date().toISOString()`.
  - [x] 4.3 Create `src/collector/storage/sqlite/migrations/0001_init.ts`
    - Embed the DDL from [design.md § SQLite DDL](./design.md#sqlite-ddl-migration-0001) as a string constant.
    - Export as `const migration0001: Migration = { version: 1, name: '0001_init', up: db => db.exec(DDL) }`.
  - [x] 4.4 Create `src/collector/storage/sqlite/migrations/index.ts` that exports the ordered migration list (`[migration0001]`).
  - [x] 4.5 Unit tests: runner happy path
    - Open an `:memory:` DB, run migrations, query `sqlite_master` and `_migrations` to verify the expected schema and bookkeeping rows.
    - _Requirements: 5.1–5.4, 9.1, 9.2_
  - [x] 4.6 Unit test: rollback on failure
    - Register a fake migration whose `up` throws.
    - Assert `_migrations` has no row for that version AND the schema is unchanged.
    - _Requirements: 9.3_
  - [x] 4.7 Unit test: drift detection
    - Run migration 1, then overwrite its `name` in `_migrations` directly, then call `runMigrations` again.
    - Assert `MigrationDriftError` is thrown.
    - _Requirements: 9.4_
  - [x] 4.8 [PBT] Property: migration runner idempotency
    - For any prefix of the canonical migration list, running `runMigrations` twice produces an identical snapshot of `sqlite_schema` and `_migrations`.
    - _Requirements: 5.5, 9.5, Correctness Property P6_

- [ ] 5. Implement the SQLite backend in `src/collector/storage/sqlite/`
  - [x] 5.1 Create `src/collector/storage/sqlite/statements.ts`
    - Prepared statements for: insert event, select event by id, insert memory record, insert into FTS, select memory records with FTS MATCH + namespace prefix, LIKE-fallback query.
    - Statements are prepared lazily on first use per `Database` instance.
  - [x] 5.2 Implement `openSqliteStorage(opts)` in `src/collector/storage/sqlite/index.ts`
    - Open the DB file at `opts.dbPath` (create directories as needed).
    - Run migrations.
    - Return a `StorageBackend` object whose methods call into the prepared statements.
    - Wrap synchronous `better-sqlite3` calls with `Promise.resolve` / `Promise.reject` to satisfy the async interface.
  - [x] 5.3 Implement `putEvent`
    - Serialize `body` and `source` with `JSON.stringify`.
    - Stamp `transaction_time` with `new Date().toISOString()` on new inserts.
    - Use `INSERT OR IGNORE` for idempotency.
    - _Requirements: 6.1, 6.2, 6.3, 11.1, 11.2, 12.1_
  - [x] 5.4 Implement `getEventById`
    - Return `null` when the row is not found.
    - Deserialize `body_json` and `source_json`.
    - _Requirements: 7.1, 7.2_
  - [x] 5.5 Implement `putMemoryRecord`
    - Wrap the two INSERTs (`memory_records` + `memory_records_fts`) in `db.transaction(...)()`.
    - Reject with an error on PK collision (surface the SQLite `SQLITE_CONSTRAINT` code).
    - _Requirements: 8.1, 8.2_
  - [x] 5.6 Implement `searchMemoryRecords`
    - Primary path: FTS5 `MATCH` with quoted phrase from `sanitizeForFts5`, joined to `memory_records` and filtered by namespace prefix.
    - Fallback path on FTS5 error: LIKE-based query ordered by `created_at DESC`.
    - Enforce the `limit`.
    - _Requirements: 8.3, 8.4, 8.5, 12.2_
  - [x] 5.7 Implement `close`
    - Call `db.close()`; guard against double-close.
    - _Requirements: 4.6, N4_
  - [x] 5.8 Unit test: happy-path writes and reads
    - Open an in-temp-dir DB, write a couple of events and memory records, read them back.
    - _Requirements: 5.1–5.4, 7.1, 7.2, 8.1_
  - [x] 5.9 Unit test: `getEventById` returns null for unknown id
    - _Requirements: 7.2_
  - [x] 5.10 Unit test: `putMemoryRecord` collision rejects
    - _Requirements: 8.2_
  - [x] 5.11 Unit tests: FTS5 malformed-query fallback
    - Cover: bare `*`, unbalanced `"`, `NEAR` without parens, empty after sanitization.
    - Assert each returns results via LIKE path without throwing.
    - _Requirements: 8.5_
  - [x] 5.12 Unit test: persistence across close + reopen
    - Write records, close, reopen same path, read records back, confirm migrations do not re-run.
    - _Requirements: 5.5, N4_

- [ ] 6. Property-based tests for the SQLite backend
  - [x] 6.1 [PBT] Property: round-trip integrity (P1)
    - Arbitrary valid event → `putEvent` → `getEventById` → deep-equals original in every public field.
    - _Requirements: 7.1, Correctness Property P1_
  - [x] 6.2 [PBT] Property: `putEvent` idempotency (P2)
    - Arbitrary valid event. Call `putEvent` twice. Confirm: (a) exactly one row exists for `event_id`; (b) `transaction_time` on the stored row equals the value from the first call (captured via an internal test-only SELECT).
    - _Requirements: 6.2, 6.3, 6.4, Correctness Property P2_
  - [x] 6.3 [PBT] Property: namespace isolation on search (P3)
    - Generate two distinct namespaces `n1`, `n2`. Populate records under both. Run `searchMemoryRecords({ namespace: n1, ... })`. Assert every returned record's namespace starts with `n1` and no record stored under `n2` appears.
    - _Requirements: 8.4, Correctness Property P3_
  - [x] 6.4 [PBT] Property: `searchMemoryRecords` honours `limit`
    - Populate with `N > limit` records that all match. Assert `result.length ≤ limit`.
    - _Requirements: 8.3_
  - [x] 6.5 [PBT] Property: stored-event schema invariants (P4)
    - After `putEvent`, read the row back, reconstruct the wire JSON, and assert `parseEvent` accepts it; `schema_version === 1`; `namespace` matches `NAMESPACE_RE`; both `valid_time` and `transaction_time` parse as finite dates.
    - _Requirements: 11.1, 11.2, Correctness Property P4_
  - [x] 6.6 [PBT] Property: FTS5 query sanitization is safe
    - For any input string, `sanitizeForFts5(q)` output starts with `"`, ends with `"`, and has no unescaped interior `"` (every interior `"` is doubled).
    - Then: the sanitized query, when passed to SQLite's `fts MATCH`, does not throw `SqliteError` for any generator output.
    - _Requirements: 12.2_

- [ ] 7. Integration and smoke tests
  - [x] 7.1 Write an integration test that uses `os.tmpdir()` + a unique subdir to simulate the `~/.kiro-mem/` layout
    - Open storage, run 100 sequential `putEvent` + `putMemoryRecord`, search, close.
    - Reopen same DB, verify data persists.
    - _Requirements: 5.1–5.4, 5.5, 11.1, N4_
  - [x] 7.2 Delete the existing `test/smoke.test.ts` or extend it so the existing type-level smoke remains green alongside the new suites.
    - _Requirements: 1.5_
  - [x] 7.3 Verify `npm run typecheck && npm run lint && npm run test` is green.

- [ ] 8. Documentation and code guards
  - [x] 8.1 Add TSDoc to every public export in `src/types/` and `src/collector/storage/` referencing the corresponding requirement ID.
  - [x] 8.2 Add a README stub at `src/collector/storage/sqlite/README.md` documenting the DB path, the migration policy, and the privacy-scrub boundary contract.
    - Restate: storage does not scrub; pipeline scrubs before calling `putEvent`.
    - _Requirements: 10.1, 10.2_
  - [x] 8.3 Add a lint-style test that greps `src/collector/storage/**/*.ts` for the token `<private>` and asserts zero matches — guards against future drift where someone adds scrubbing into the storage layer.
    - _Requirements: 10.3_
  - [x] 8.4 Build the package (`npm run build`) and confirm the compiled `dist/collector/storage/sqlite/migrations/` contains the DDL as string constants (self-contained).
    - _Requirements: 13.4_

## Execution order summary

1. Task 1 (deps) unblocks everything.
2. Task 2 (types + Zod) unblocks 3, 5, 6.
3. Task 3 (interface) is independent after Task 2.
4. Task 4 (migrations) depends on Task 1 only.
5. Task 5 (SQLite impl) depends on Tasks 2, 3, 4.
6. Task 6 (PBT suite) depends on Task 5.
7. Task 7 (integration/smoke) depends on all prior.
8. Task 8 (docs + guards) can run alongside Task 5 once types exist.
