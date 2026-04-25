/**
 * Unit tests for the SQLite storage backend (`openSqliteStorage`).
 *
 * Covers tasks 5.8–5.12 in the event-schema-and-storage spec:
 *
 * - 5.8  happy-path writes and reads across events + memory records
 * - 5.9  `getEventById` returns `null` for an unknown id
 * - 5.10 `putMemoryRecord` rejects on `record_id` collision
 * - 5.11 FTS5 malformed-query fallback — none of the listed inputs throw
 * - 5.12 data persists across `close()` + reopen, and migrations do not
 *        re-run against the reopened file
 *
 * The PBT suite in task 6 exercises the same backend with generated
 * inputs; these tests pin down specific example cases that the properties
 * either do not cover or would shrink away from (for example, "the exact
 * string `'NEAR'`").
 *
 * Each test gets its own temp directory under `os.tmpdir()` so parallel
 * runs and `afterEach` cleanup cannot clash. The `afterEach` hook closes
 * the backend and recursively removes the temp directory even on test
 * failure, so failing runs do not leak SQLite files into the user's
 * `/tmp`.
 *
 * Validates: Requirements 5.1–5.5, 7.1, 7.2, 8.1, 8.2, 8.5, N4.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import type { StorageBackend } from '../../src/types/index.js';

import { makeValidEvent, makeValidRecord } from '../helpers/fixtures.js';

/**
 * Per-test scratch state. `tmpRoot` is a unique directory under the OS
 * tmpdir; `dbPath` is the SQLite file path inside it. `storage` is the
 * backend under test — tests that need a second open re-bind it.
 */
let tmpRoot: string;
let dbPath: string;
let storage: StorageBackend;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kiro-learn-test-'));
  dbPath = join(tmpRoot, 'kiro-learn.db');
  storage = openSqliteStorage({ dbPath });
});

afterEach(async () => {
  // Use try/catch rather than the backend's idempotent close, because
  // tests that reopen the DB replace `storage` with a new handle; the
  // previous one is already closed and `close()` on it would be a no-op,
  // but we want to be robust to a test that reassigns `storage` and
  // throws before its inner close runs.
  try {
    await storage.close();
  } catch {
    // swallow; cleanup must not mask the real test failure
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Task 5.8 — happy-path writes and reads.
 *
 * Walks the primary public surface once: two events + two records go in,
 * both events round-trip through `getEventById`, and a namespace-scoped
 * search returns both records. No mutations, no adversarial inputs;
 * this is the "does the wiring work at all" smoke test.
 *
 * Validates: Requirements 5.1–5.4, 7.1, 7.2, 8.1.
 */
describe('SQLite backend — happy path (task 5.8)', () => {
  it('round-trips events and returns memory records via search', async () => {
    const event1 = makeValidEvent({
      event_id: '01JF8ZS4Y00000000000000001',
      body: { type: 'text', content: 'first event' },
    });
    const event2 = makeValidEvent({
      event_id: '01JF8ZS4Y00000000000000002',
      kind: 'tool_use',
      body: { type: 'json', data: { tool: 'echo', input: 'ping' } },
    });

    await storage.putEvent(event1);
    await storage.putEvent(event2);

    // Both events must deep-equal the values we wrote. The backend
    // tracks `transaction_time` internally but does not surface it, so
    // a direct `toEqual` is valid here.
    expect(await storage.getEventById(event1.event_id)).toEqual(event1);
    expect(await storage.getEventById(event2.event_id)).toEqual(event2);

    const record1 = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000001',
      title: 'First record',
      summary: 'summary alpha about the investigation',
      source_event_ids: [event1.event_id],
    });
    const record2 = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000002',
      title: 'Second record',
      summary: 'summary beta about the refactor',
      source_event_ids: [event2.event_id],
    });

    await storage.putMemoryRecord(record1);
    await storage.putMemoryRecord(record2);

    // The query `summary` appears as a whole token in both records'
    // `summary` field, so FTS5 should return both. Ordering depends on
    // FTS5 rank, which we do not assert on here — only that both records
    // are present and no others leak in.
    const hits = await storage.searchMemoryRecords({
      namespace: record1.namespace,
      query: 'summary',
      limit: 10,
    });

    expect(hits).toHaveLength(2);
    const hitIds = new Set(hits.map((h) => h.record_id));
    expect(hitIds.has(record1.record_id)).toBe(true);
    expect(hitIds.has(record2.record_id)).toBe(true);
  });
});

/**
 * Task 5.9 — `getEventById` returns `null` for unknown ids.
 *
 * The contract is explicit about not throwing here: the not-found case
 * is part of the normal control flow (e.g. a consumer checking whether
 * an event has already landed before acting on it).
 *
 * Validates: Requirement 7.2.
 */
describe('SQLite backend — getEventById not found (task 5.9)', () => {
  it('returns null for an id that was never written', async () => {
    const result = await storage.getEventById('01JF8ZS4Y99999999999999999');
    expect(result).toBeNull();
  });
});

/**
 * Task 5.10 — `putMemoryRecord` rejects on `record_id` collision.
 *
 * Records are not deduplicated at the storage layer: a colliding
 * `record_id` indicates an upstream bug (the extractor minted the same
 * id twice), and silently swallowing it would mask that. The backend
 * relies on the `PRIMARY KEY` constraint on `memory_records.record_id`
 * and lets the resulting `SQLITE_CONSTRAINT_PRIMARYKEY` error propagate.
 *
 * Validates: Requirement 8.2.
 */
describe('SQLite backend — putMemoryRecord collision (task 5.10)', () => {
  it('rejects when the same record_id is written twice', async () => {
    const original = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000010',
      title: 'Original title',
    });
    const duplicate = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000010',
      title: 'Different title — same id',
    });

    await storage.putMemoryRecord(original);

    await expect(storage.putMemoryRecord(duplicate)).rejects.toThrow(/UNIQUE|PRIMARY|constraint/i);
  });
});

/**
 * Task 5.11 — FTS5 malformed-query fallback.
 *
 * `sanitizeForFts5` wraps every user query in a phrase — `"..."` with
 * any interior `"` doubled — which neutralises most adversarial input.
 * A handful of shapes still either (a) stay valid phrases that FTS5
 * happily matches or (b) produce a sanitised form FTS5 rejects, which
 * triggers the LIKE fallback. The contract that matters at this layer
 * is uniform regardless of which path runs: the call returns
 * `MemoryRecord[]` without throwing.
 *
 * The test populates one record first so the LIKE fallback (and the
 * FTS5 path, for queries that survive sanitisation) have something to
 * either match or not. Assertions are intentionally shape-only — no
 * claim about *which* records come back, because the two paths rank
 * differently.
 *
 * Validates: Requirement 8.5.
 */
describe('SQLite backend — FTS5 malformed-query fallback (task 5.11)', () => {
  beforeEach(async () => {
    await storage.putMemoryRecord(
      makeValidRecord({
        record_id: 'mr_01JF8ZS4Z00000000000000020',
        title: 'Fallback corpus',
        summary: 'arbitrary content so LIKE and FTS5 have something to scan',
      }),
    );
  });

  const namespace = '/actor/alice/project/abc/';

  // Each of these query strings is either a classic FTS5 footgun or a
  // shape the spec's task list calls out explicitly. What unites them is
  // that a naive implementation would let them bubble up as a
  // `SqliteError` to the caller; the backend must not.
  const cases: Array<[label: string, query: string]> = [
    ['bare asterisk', '*'],
    ['unbalanced double-quote', '"'],
    ['bare NEAR without parens', 'NEAR'],
    ['empty string', ''],
  ];

  for (const [label, query] of cases) {
    it(`returns an array without throwing for ${label} (query: ${JSON.stringify(query)})`, async () => {
      const result = await storage.searchMemoryRecords({
        namespace,
        query,
        limit: 10,
      });

      expect(Array.isArray(result)).toBe(true);
      // Defensive: every returned row must still respect namespace
      // isolation, regardless of which path served the query.
      for (const r of result) {
        expect(r.namespace.startsWith(namespace)).toBe(true);
      }
    });
  }
});

/**
 * Task 5.12 — persistence across close + reopen; migrations do not re-run.
 *
 * The first open writes an event and a record, then closes cleanly.
 * The second open against the same file must see the same data and
 * must leave `_migrations` untouched (one row for `0001_init`, not two).
 * The migration runner already guards re-application via
 * `MAX(applied_version)`, but a regression there would silently double
 * the row count; asserting the exact count is the cheapest way to catch
 * it.
 *
 * The test opens a sibling read-only `Database` handle on the file to
 * inspect `_migrations` directly — the public `StorageBackend` interface
 * does not expose migration metadata, and probing it via the public
 * surface would require adding a test-only method. A readonly sibling
 * handle is a smaller imposition on the production surface.
 *
 * Validates: Requirements 5.5, N4.
 */
describe('SQLite backend — persistence across close + reopen (task 5.12)', () => {
  it('reads back events and records from a reopened database without re-running migrations', async () => {
    const event = makeValidEvent({
      event_id: '01JF8ZS4Y00000000000000030',
      body: { type: 'text', content: 'persist across reopen' },
    });
    const record = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000030',
      title: 'Persistent record',
      summary: 'should survive a close and reopen',
      source_event_ids: [event.event_id],
    });

    await storage.putEvent(event);
    await storage.putMemoryRecord(record);
    await storage.close();

    // Reopen the same file. `beforeEach`'s reference to `storage` is
    // overwritten so the shared `afterEach` closes this handle (and
    // swallows any double-close on the already-closed original).
    storage = openSqliteStorage({ dbPath });

    expect(await storage.getEventById(event.event_id)).toEqual(event);

    const hits = await storage.searchMemoryRecords({
      namespace: record.namespace,
      query: 'persistent',
      limit: 10,
    });
    const hitIds = new Set(hits.map((h) => h.record_id));
    expect(hitIds.has(record.record_id)).toBe(true);

    // Cross-check `_migrations` via a throwaway readonly handle. Opening
    // a second writer on the same file while `storage` is active would
    // work (SQLite allows it in WAL mode), but `readonly: true` makes
    // the intent explicit and cannot accidentally mutate state.
    const probe = new Database(dbPath, { readonly: true });
    try {
      const { count } = probe
        .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM _migrations')
        .get()!;
      expect(count).toBe(1);
    } finally {
      probe.close();
    }
  });
});
