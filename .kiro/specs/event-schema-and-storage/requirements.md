# Requirements: Event Schema and Storage

## Introduction

This document derives functional and non-functional requirements from [design.md](./design.md). It defines the v1 data foundation for kiro-learn: the canonical `Event` wire schema, the `MemoryRecord` storage shape, the pluggable `StorageBackend` interface, and the SQLite + FTS5 implementation of that interface.

These requirements are scoped to the data-layer contract. Downstream specs (collector-receiver, collector-pipeline, collector-enrichment, shim, installer) consume this contract and are out of scope.

## User Stories

### Story 1: Collector authors want a stable Event schema

As a collector or shim author, I want a single canonical `Event` schema with a well-documented validator, so that every component (shim, receiver, pipeline, storage) speaks the same wire format without drift.

### Story 2: Storage backend authors want a pluggable interface

As a storage backend author (SQLite today, pgvector or AgentCore Memory later), I want a minimal `StorageBackend` interface that every backend implements identically, so that swapping backends does not cascade changes through the pipeline, receiver, or enrichment layers.

### Story 3: Pipeline authors want idempotent writes

As a pipeline author, I want `putEvent` to be safe to call multiple times with the same `event_id`, so that shim retries and collector restarts do not produce duplicate events.

### Story 4: Enrichment authors want namespace-scoped search

As an enrichment author, I want `searchMemoryRecords({ namespace, ... })` to return only records under that namespace, so that a developer's memory in project A is never surfaced when they are working in project B.

### Story 5: Installer authors want self-managing migrations

As an installer author, I want the storage layer to apply its own DDL migrations automatically on startup, so that `kiro-learn init` and subsequent upgrades don't require a separate migration step.

### Story 6: Future AgentCore migrators want field-level compatibility

As a future engineer migrating to Bedrock AgentCore Memory, I want every Event field, every MemoryRecord field, and the namespace convention to map one-to-one onto AgentCore's primitives, so that the migration is a field-mapping exercise, not a rewrite.

## Acceptance Criteria (EARS format)

### Requirement 1: Event schema definition

**User Story:** As a collector author, I want a single canonical Event type.

1.1 WHEN the project is built, THE `src/types/index.ts` module SHALL export a `KiroMemEvent` type with fields: `event_id`, optional `parent_event_id`, `session_id`, `actor_id`, `namespace`, `schema_version` (literal `1`), `kind`, `body`, `valid_time`, `source`, optional `content_hash`.

1.2 WHEN the project is built, THE types module SHALL export an `EventKind` type as the string-literal union `'prompt' | 'tool_use' | 'session_summary' | 'note'`.

1.3 WHEN the project is built, THE types module SHALL export an `EventBody` discriminated-union type with variants `{ type: 'text', content: string }`, `{ type: 'message', turns: Array<{ role, content }> }`, and `{ type: 'json', data: unknown }`.

1.4 WHEN the project is built, THE types module SHALL export an `EventSource` type with fields `surface: 'kiro-cli' | 'kiro-ide'`, `version: string`, `client_id: string`.

1.5 WHEN a downstream module imports from `kiro-learn` (the package's main entry), THE module SHALL see `KiroMemEvent`, `EventKind`, `EventBody`, `EventSource`, `MemoryRecord`, and `StorageBackend` re-exported.

### Requirement 2: Event Zod validator

**User Story:** As a receiver author, I want to validate incoming JSON against the Event schema.

2.1 WHEN arbitrary input is passed to `parseEvent`, THE function SHALL return a typed `KiroMemEvent` on success OR throw `ZodError` on failure.

2.2 WHEN the input's `event_id` does not match the ULID regex `^[0-9A-HJKMNP-TV-Z]{26}$`, THE validator SHALL reject it.

2.3 WHEN the input's `namespace` does not match `^/actor/[^/]+/project/[^/]+/$`, THE validator SHALL reject it.

2.4 WHEN the input's `schema_version` is not literally `1`, THE validator SHALL reject it.

2.5 WHEN the input's `kind` is not one of the four enumerated values, THE validator SHALL reject it.

2.6 WHEN the input's `body.type` is not `'text' | 'message' | 'json'`, or the variant's required fields are missing, THE validator SHALL reject it.

2.7 WHEN the serialized body exceeds 1 MiB, THE validator SHALL reject it.

2.8 WHEN `valid_time` is not a valid ISO 8601 string, THE validator SHALL reject it.

2.9 WHEN `content_hash` is present and does not match `^sha256:[0-9a-f]{64}$`, THE validator SHALL reject it.

2.10 WHEN `source.surface` is not `'kiro-cli'` or `'kiro-ide'`, THE validator SHALL reject it.

2.11 WHEN the validator rejects input, THE `ZodError` SHALL include a path identifying which field failed.

### Requirement 3: MemoryRecord type and validator

3.1 WHEN the project is built, THE types module SHALL export a `MemoryRecord` type with fields `record_id`, `namespace`, `strategy`, `title`, `summary`, `facts`, `source_event_ids`, `created_at`.

3.2 WHEN arbitrary input is passed to `parseMemoryRecord`, THE function SHALL return a typed `MemoryRecord` on success OR throw `ZodError` on failure.

3.3 WHEN the input's `record_id` does not match `^mr_[0-9A-HJKMNP-TV-Z]{26}$`, THE validator SHALL reject it.

3.4 WHEN the input's `source_event_ids` is an empty array, THE validator SHALL reject it.

3.5 WHEN the input's `title` length is 0 or exceeds 200 chars, or `summary` length is 0 or exceeds 4000 chars, THE validator SHALL reject it.

### Requirement 4: StorageBackend interface

**User Story:** As a storage backend author, I want one fixed interface.

4.1 WHEN the project is built, THE `src/collector/storage/index.ts` module SHALL export the `StorageBackend` interface with methods `putEvent`, `getEventById`, `putMemoryRecord`, `searchMemoryRecords`, `close`.

4.2 WHEN `putEvent(event)` is called, THE method SHALL return a `Promise<void>`.

4.3 WHEN `getEventById(eventId)` is called, THE method SHALL return `Promise<KiroMemEvent | null>`.

4.4 WHEN `putMemoryRecord(record)` is called, THE method SHALL return `Promise<void>`.

4.5 WHEN `searchMemoryRecords({ namespace, query, limit })` is called, THE method SHALL return `Promise<MemoryRecord[]>`.

4.6 WHEN `close()` is called, THE method SHALL return `Promise<void>` AND subsequent calls SHALL be safe (no error thrown).

### Requirement 5: SQLite backend — schema

**User Story:** As an installer author, I want a known-good DDL.

5.1 WHEN the SQLite backend is opened for the first time against an empty file, THE migration runner SHALL create tables `events`, `memory_records`, `memory_records_fts`, and `_migrations` per the DDL in [design.md § SQLite DDL](./design.md#sqlite-ddl-migration-0001).

5.2 WHEN the `events` table is created, THE table SHALL be declared `STRICT`.

5.3 WHEN the `events` table is created, THE table SHALL include the indexes `idx_events_namespace_valid`, `idx_events_session`, `idx_events_parent`.

5.4 WHEN the `memory_records_fts` virtual table is created, THE table SHALL use FTS5 with tokenizer `porter unicode61 remove_diacritics 2`.

5.5 WHEN the DB is opened a second time, THE migration runner SHALL detect that migration `0001` is already applied AND apply nothing.

### Requirement 6: SQLite backend — idempotent event writes

**User Story:** As a pipeline author, I want safe retries.

6.1 WHEN `putEvent(e)` is called and no row with `event_id = e.event_id` exists, THE backend SHALL insert a new row with `transaction_time` stamped as the current UTC ISO 8601 time.

6.2 WHEN `putEvent(e)` is called and a row with `event_id = e.event_id` already exists, THE backend SHALL leave the existing row unchanged AND SHALL return without error.

6.3 WHEN `putEvent(e)` has been called at least once, THE row count for `event_id = e.event_id` SHALL equal 1.

6.4 WHEN `putEvent(e)` is called twice, THE stored `transaction_time` SHALL equal the value written on the first call. (This is **testable as a property**.)

### Requirement 7: SQLite backend — round-trip integrity

**User Story:** As a collector author, I want round-trip guarantees.

7.1 WHEN `putEvent(e)` has been called for a valid Event `e`, THE subsequent call to `getEventById(e.event_id)` SHALL return an object structurally equal to `e` in every public field. (Collector-assigned `transaction_time` is not surfaced through the public `KiroMemEvent` type and is therefore exempt.) (This is **testable as a property**.)

7.2 WHEN `getEventById(id)` is called with an id for which no row exists, THE method SHALL return `null`.

### Requirement 8: SQLite backend — memory record writes and search

**User Story:** As an enrichment author, I want to store and search records.

8.1 WHEN `putMemoryRecord(r)` is called, THE backend SHALL insert into both `memory_records` and `memory_records_fts` in a single transaction.

8.2 WHEN `putMemoryRecord(r)` is called and a row with `record_id = r.record_id` already exists, THE method SHALL reject with an error. (Collisions indicate a bug upstream; records are not deduplicated.)

8.3 WHEN `searchMemoryRecords({ namespace, query, limit })` is called against a populated DB, THE result SHALL contain at most `limit` records.

8.4 WHEN `searchMemoryRecords({ namespace, query, limit })` returns, THE `.namespace` of every returned record SHALL start with `namespace`. (Namespace isolation; **testable as a property**.)

8.5 WHEN `searchMemoryRecords` receives a `query` that FTS5 rejects as malformed, THE method SHALL fall back to a LIKE-based match ordered by `created_at DESC` rather than failing the call. (Availability over rank quality.)

### Requirement 9: Migration runner

9.1 WHEN `runMigrations` is called against an empty DB, THE runner SHALL apply every provided migration in ascending version order.

9.2 WHEN `runMigrations` is called and the DB already has migration version `n` recorded, THE runner SHALL apply only migrations with `version > n`.

9.3 WHEN a migration's `up` function throws, THE runner SHALL roll back the transaction AND SHALL NOT record the migration in `_migrations`.

9.4 WHEN `_migrations` contains a row for version `v` whose `name` differs from the code-embedded migration of version `v`, THE runner SHALL throw a `MigrationDriftError` before applying further migrations.

9.5 WHEN `runMigrations` is called twice with the same migration list, THE second call SHALL be a no-op (idempotency, **testable as a property**).

### Requirement 10: Privacy contract (documentation)

**User Story:** As a security reviewer, I want the scrub boundary documented.

10.1 WHEN the design document is shipped, IT SHALL state that privacy scrubbing of `<private>...</private>` spans is the pipeline's responsibility and not the storage layer's.

10.2 WHEN the design document is shipped, IT SHALL state that `putEvent` is called by the pipeline only after scrubbing is complete.

10.3 WHEN storage-layer code is written, IT SHALL NOT perform or attempt any privacy scrub. (Guards against future drift.)

### Requirement 11: Bi-temporal reservation

11.1 WHEN an Event is stored, THE `valid_time` and `transaction_time` values SHALL both be persisted.

11.2 WHEN `transaction_time` is not supplied by the caller, THE SQLite backend SHALL stamp it at insert time using the current UTC ISO 8601 clock.

11.3 WHEN the v1 `searchMemoryRecords` surface is called, IT SHALL NOT accept temporal filter parameters. (v1 retrieval is lexical only; bi-temporal query surface is deferred to v5.)

### Requirement 12: Security and input-handling posture

12.1 WHEN any SQL is constructed in the SQLite backend, IT SHALL use prepared statements with parameter binding. (No string concatenation into SQL.)

12.2 WHEN `searchMemoryRecords` receives user-controlled text in `query`, IT SHALL quote the query as an FTS5 phrase (doubling embedded `"`) rather than splicing it as raw syntax.

12.3 WHEN an Event body is larger than 1 MiB (serialized), THE validator SHALL reject it at the boundary rather than allowing the storage layer to handle an oversized write.

12.4 WHEN the SQLite file is created, THE directory `~/.kiro-learn/` SHALL be writable only by the owning user (mode `0700`). Enforcement is the installer's responsibility, but storage SHALL NOT widen permissions.

### Requirement 13: Dependencies and toolchain

13.1 WHEN the build runs, THE package SHALL depend on `better-sqlite3` at version `^12`.

13.2 WHEN the build runs, THE package SHALL depend on `zod` at version `^3.23`.

13.3 WHEN the test suite runs, THE package SHALL depend on `fast-check` as a dev dependency.

13.4 WHEN the package is published, THE compiled `dist/` SHALL be self-contained (all migration DDL embedded as string constants, no runtime file-system discovery).

## Non-functional Requirements

### Performance

- N1. WHEN writing events on commodity developer hardware (Apple M-series, Intel i7, or equivalent), THE 95th-percentile `putEvent` latency SHALL be under 5 ms end-to-end.
- N2. WHEN `searchMemoryRecords` runs against a corpus of 1000 memory records, THE median latency SHALL be under 50 ms.

### Reliability

- N3. WHEN the process crashes mid-write, THE DB SHALL remain consistent (default `better-sqlite3` WAL behavior satisfies this; no custom work required).
- N4. WHEN `close()` is called, THE underlying SQLite handle SHALL be released and a subsequent `close()` SHALL be a no-op.

### Forward compatibility

- N5. WHEN v2's embedding tables are added, THE schema change SHALL be a new migration (version 0002) with no rewrite of `events` or `memory_records`.
- N6. WHEN v4's AgentCore Memory adapter is written, EVERY public field on `KiroMemEvent` and `MemoryRecord` SHALL have a direct counterpart in AgentCore's API surface. (Design-time commitment; verified by inspection at v4 time.)

## Out of Scope (explicit)

The following are **not** in this spec and are not tested by the property suite here. Each has a dedicated downstream spec.

- HTTP receiver (`POST /v1/events` endpoint, request/response shape, enrichment response)
- Pipeline processors (dedup logic beyond the SQLite PK, privacy scrub, extraction)
- `kiro-cli` integration for LLM extraction
- Enrichment assembly and latency-budget logic
- Shim behavior (local spool, event building from cwd)
- Installer (`kiro-learn init`, daemon lifecycle, PID file, `~/.kiro-learn/` bootstrap)
- Embeddings, semantic search, hybrid retrieval (v2+)
- pgvector and AgentCore Memory adapters (v4)

Downstream specs will bind to the interfaces and contracts defined here. Any change to the Event or MemoryRecord shape requires reopening this spec, not editing in a downstream spec.
