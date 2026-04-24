# SQLite storage backend

The v1 default implementation of the `StorageBackend` interface. Zero-dependency
local store built on `better-sqlite3` and FTS5.

See the full design in
[`.kiro/specs/event-schema-and-storage/design.md`](../../../../.kiro/specs/event-schema-and-storage/design.md)
and [AGENTS.md](../../../../AGENTS.md) for the kiro-mem architecture.

## DB path

The backend opens a single SQLite file at the path supplied to
`openSqliteStorage({ dbPath })`. The installer writes it to:

```text
~/.kiro-mem/kiro-mem.db
```

No sub-directory layout; WAL/SHM sidecars (when WAL mode is on) sit next to the
primary file. The backend creates any missing parent directories with
`mkdirSync(..., { recursive: true })` on open so first-time opens on a fresh
machine do not require a separate provisioning step.

File-system permissions are the installer's responsibility; storage does not
widen them. `~/.kiro-mem/` is expected to be mode `0700` (owner-only) per
Requirement 12.4.

## Migration policy

Migrations live in `./migrations/`:

- `types.ts` — the `Migration` interface and `MigrationDriftError` class.
- `runner.ts` — `runMigrations(db, migrations)`. Bootstraps the `_migrations`
  bookkeeping table, reads the applied history, checks for drift, and applies
  every migration whose version exceeds the highest applied version. Each
  migration runs inside a `better-sqlite3` transaction (`db.transaction(...)()`);
  a thrown `up` rolls the whole transaction back, including the bookkeeping
  `INSERT`.
- `0001_init.ts` — the v1 initial schema as a single `db.exec(DDL)` call.
- `index.ts` — aggregates the ordered `MIGRATIONS` list and re-exports the
  runner + error types.

Rules:

1. **Append-only.** New migrations are added at the end of `MIGRATIONS` with the
   next integer `version`. Previously-released migrations are never reordered,
   renamed, or edited in place.
2. **Drift is fatal.** If `_migrations` records a version whose `name` disagrees
   with the in-code migration of the same version (or has no in-code
   counterpart at all), `runMigrations` throws `MigrationDriftError` before
   applying anything further.
3. **Forward-only.** v1 has no down-migrations. Rollback is not a supported
   story; a broken migration is rolled back at the transaction level by SQLite
   itself and the developer re-runs with a fix.
4. **Idempotent.** Running `runMigrations` twice with the same list is a no-op.
   Property-tested in `test/migrations.idempotency.property.test.ts`.
5. **Self-contained.** Every migration's DDL is embedded as a string constant
   in its `.ts` file — nothing is read from disk at runtime. The compiled
   `dist/` is safe to copy anywhere without dragging along auxiliary files.

See Requirements 5.1–5.5 and 9.1–9.5.

## Privacy-scrub boundary contract

**Storage does not scrub `<private>…</private>` spans.** Scrubbing is the
*pipeline*'s responsibility (see the collector-pipeline spec); by the time a
value reaches `putEvent`, it has already been processed.

This boundary is deliberate:

- Storage is a sink. Enforcing a scrub here would put the guarantee in the
  wrong layer — a caller that forgot to scrub would still land scrubbed data
  in the database, but it would never see the `<private>` spans again and
  could build mistaken upstream assumptions ("storage protects us").
- Keeping scrub out of storage means every storage backend (SQLite today;
  pgvector and AgentCore Memory later) has the same contract and the same
  responsibilities. Scrubbing logic lives once, in the pipeline.
- Drift-guard: task 8.3 adds a lint-style check that the storage layer does
  not reference `<private>` anywhere. Anyone trying to push scrubbing into the
  storage layer will fail that check and be redirected to the pipeline.

Concretely: when `putEvent(event)` runs, `event.body` and every other field
is treated as-is. The SQLite layer serialises body/source to JSON columns,
stamps `transaction_time`, and inserts — nothing more. See Requirements 10.1,
10.2, 10.3.

## Public surface

- `openSqliteStorage({ dbPath })` → `StorageBackend`. Opens (or creates) the
  database, runs pending migrations, prepares statements, and returns the
  backend. Methods are async wrappers around the synchronous `better-sqlite3`
  driver so callers can swap in any future async backend without a rewrite.
- `sanitizeForFts5(query)` — quotes an arbitrary user string as a single FTS5
  phrase. Used by `searchMemoryRecords`; exported for use in tests.
- Raw statements (`statements.ts`), row shapes (`EventRow`,
  `MemoryRecordRow`), and the migration surface (`runMigrations`,
  `MIGRATIONS`, `Migration`, `MigrationDriftError`) are available for
  backend-internal tooling.
