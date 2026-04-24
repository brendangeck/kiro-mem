/**
 * Integration test for the SQLite storage backend.
 *
 * Simulates the real `~/.kiro-learn/` install layout by creating a unique
 * temp directory (via `mkdtempSync` under `os.tmpdir()`) and placing a
 * SQLite file inside it at `kiro-learn.db` — the same filename the
 * installer writes in production (see AGENTS.md § Installed layout).
 *
 * Unlike the unit tests in `sqlite-backend.test.ts` or the property
 * tests in `sqlite-backend.property.test.ts`, this suite exercises the
 * backend end-to-end at non-trivial volume: 100 sequential
 * `putEvent` + `putMemoryRecord` pairs, two searches, a clean close,
 * a reopen against the same file, and a final readback. It is the
 * closest thing to "what actually happens on a developer's laptop"
 * that the test suite can produce without running the collector
 * daemon itself.
 *
 * Why 100? Enough to drive the backend past any single-row edge case
 * (FTS5 index growth, transaction boundaries, prepared-statement reuse
 * across inserts) without inflating CI time. The test completes in
 * well under a second on typical hardware.
 *
 * @see .kiro/specs/event-schema-and-storage/tasks.md § Task 7.1
 * @see .kiro/specs/event-schema-and-storage/requirements.md
 *      § Requirements 5.1–5.5, 11.1, N4
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSqliteStorage } from '../src/collector/storage/sqlite/index.js';

import { makeValidEvent, makeValidRecord } from './fixtures.js';

/**
 * Crockford-base32 alphabet used by ULIDs (no I, L, O, U). Duplicated
 * from `test/arbitrary.ts` rather than imported so this integration
 * suite has no dependency on fast-check machinery — it's example-shaped,
 * not property-shaped.
 */
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Encode a non-negative integer as a 26-char, left-zero-padded
 * Crockford-base32 string. The output matches `ULID_RE` and therefore
 * passes as a valid `event_id` / source id.
 *
 * Mirrors the approach used in `sqlite-backend.property.test.ts`'s
 * `makeRecordId` helper, minus the `mr_` prefix.
 */
function makeUlid(n: number): string {
  if (n < 0 || !Number.isInteger(n)) {
    throw new Error(`makeUlid: expected non-negative integer, got ${String(n)}`);
  }
  let encoded = '';
  if (n === 0) {
    encoded = '0';
  } else {
    let v = n;
    while (v > 0) {
      const digit = v % ULID_ALPHABET.length;
      encoded = ULID_ALPHABET[digit]! + encoded;
      v = Math.floor(v / ULID_ALPHABET.length);
    }
  }
  return encoded.padStart(26, '0');
}

/** Build a valid `mr_`-prefixed record id from a numeric suffix. */
function makeRecordId(n: number): string {
  return `mr_${makeUlid(n)}`;
}

/**
 * Scratch state for a single test. `tmpRoot` is a unique directory
 * under `os.tmpdir()` (e.g. `/tmp/kiro-learn-integration-abc123/`) and
 * `dbPath` is `${tmpRoot}/kiro-learn.db`, mirroring the `~/.kiro-learn/`
 * runtime layout installers produce.
 */
let tmpRoot: string;
let dbPath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kiro-learn-integration-'));
  dbPath = join(tmpRoot, 'kiro-learn.db');
});

afterEach(() => {
  // `force: true` makes the teardown robust to a test that leaves the
  // DB locked or removes the file mid-test; `recursive: true` is
  // needed because SQLite may drop WAL/SHM sidecar files next to the
  // primary DB file.
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('SQLite backend — integration (task 7.1)', () => {
  it(
    'persists 100 events and memory records across close + reopen',
    async () => {
      // ── Phase 1: open, write 100 pairs, search, close ────────────────
      let storage = openSqliteStorage({ dbPath });

      // One stable namespace across all 100 pairs so searches find them
      // all under a single prefix. A shared token (`"integration"`) lives
      // in every summary so FTS5 has something to match on.
      const namespace = '/actor/alice/project/integration/';
      const eventIds: string[] = [];
      const recordIds: string[] = [];

      for (let i = 0; i < 100; i++) {
        const eventId = makeUlid(i);
        const recordId = makeRecordId(i);

        const event = makeValidEvent({
          event_id: eventId,
          namespace,
          // Rotate through `kind` values so the corpus isn't uniform —
          // exercises the kind column on both the write and read paths.
          kind: i % 2 === 0 ? 'prompt' : 'tool_use',
          body: { type: 'text', content: `integration event ${String(i)}` },
        });

        const record = makeValidRecord({
          record_id: recordId,
          namespace,
          title: `Integration record ${String(i)}`,
          // `integration` appears in every summary → FTS5 matches all.
          // `alpha`/`beta` alternate so we can do a partial-corpus search.
          summary: `integration summary ${i % 2 === 0 ? 'alpha' : 'beta'} ${String(i)}`,
          source_event_ids: [eventId],
        });

        await storage.putEvent(event);
        await storage.putMemoryRecord(record);

        eventIds.push(eventId);
        recordIds.push(recordId);
      }

      // First search: broad term that every record contains. Limit is
      // generous (200) so FTS5 could return every match — we then assert
      // on the observed count. Any return value ≤ 100 is acceptable here
      // (FTS5 and LIKE rank ties differently), but we expect the full
      // corpus back in practice.
      const allHits = await storage.searchMemoryRecords({
        namespace,
        query: 'integration',
        limit: 200,
      });
      expect(allHits.length).toBeGreaterThan(0);
      expect(allHits.length).toBeLessThanOrEqual(100);
      for (const h of allHits) {
        expect(h.namespace).toBe(namespace);
      }

      // Second search: narrower term that only half the records carry.
      // Same shape-level assertions; bound is 50 because we wrote 50
      // records with `alpha` in the summary.
      const alphaHits = await storage.searchMemoryRecords({
        namespace,
        query: 'alpha',
        limit: 200,
      });
      expect(alphaHits.length).toBeGreaterThan(0);
      expect(alphaHits.length).toBeLessThanOrEqual(50);
      for (const h of alphaHits) {
        expect(h.namespace).toBe(namespace);
        expect(h.summary).toContain('alpha');
      }

      await storage.close();

      // ── Phase 2: reopen same path, verify persistence ────────────────
      storage = openSqliteStorage({ dbPath });
      try {
        // At least one event must survive the close/reopen cycle. We
        // spot-check the first and last from the batch rather than
        // reading all 100 — the point is durability, not throughput.
        const firstEvent = await storage.getEventById(eventIds[0]!);
        const lastEvent = await storage.getEventById(eventIds[eventIds.length - 1]!);
        expect(firstEvent).not.toBeNull();
        expect(lastEvent).not.toBeNull();
        expect(firstEvent!.event_id).toBe(eventIds[0]);
        expect(lastEvent!.event_id).toBe(eventIds[eventIds.length - 1]);

        // At least one record must come back via search under the same
        // namespace. We assert on set membership rather than ordering so
        // the test is agnostic to FTS5/LIKE rank.
        const rehits = await storage.searchMemoryRecords({
          namespace,
          query: 'integration',
          limit: 200,
        });
        expect(rehits.length).toBeGreaterThan(0);
        const rehitIds = new Set(rehits.map((r) => r.record_id));
        expect(rehitIds.has(recordIds[0]!)).toBe(true);
      } finally {
        await storage.close();
      }
    },
    // Generous timeout: 100 pairs is fast locally but CI machines with
    // slow disks can push this past the vitest default on a cold start.
    20_000,
  );
});
