/**
 * Unit tests for the updated extraction stage.
 *
 * Tests `invokeCompressor` and `runExtraction` (via `createExtractionStage`)
 * with mocked ACP sessions returning controlled XML responses.
 *
 * @see .kiro/specs/xml-extraction-pipeline/tasks.md § Task 6.5
 * @see .kiro/specs/xml-extraction-pipeline/requirements.md § Requirements 6.1–6.8
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StorageBackend, MemoryRecord } from '../../src/types/index.js';
import { makeValidEvent } from '../helpers/fixtures.js';

// ── Mock ACP client ─────────────────────────────────────────────────────

/**
 * Queue of responses that mock sessions will return from sendPrompt.
 * Each call to createAcpSession shifts the next response from the queue.
 */
const responseQueue: Array<string | Error> = [];

/**
 * Tracks all mock sessions created so tests can inspect destroy calls.
 */
const mockSessions: Array<{
  sendPrompt: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}> = [];

/**
 * The mock factory. We use `vi.hoisted` to ensure the mock function
 * reference is stable across module resets, while the queue/sessions
 * arrays are module-level and survive `vi.resetModules()`.
 */
vi.mock('../../src/collector/pipeline/acp-client.js', () => ({
  createAcpSession: vi.fn(() => {
    const response = responseQueue.shift();
    const session = {
      sendPrompt: vi.fn(() => {
        if (response instanceof Error) {
          return Promise.reject(response);
        }
        return Promise.resolve(response ?? '');
      }),
      destroy: vi.fn(),
    };
    mockSessions.push(session);
    return Promise.resolve(session);
  }),
}));

// ── Helpers ─────────────────────────────────────────────────────────────

function createMockStorage(): StorageBackend & {
  putMemoryRecord: ReturnType<typeof vi.fn>;
} {
  return {
    putEvent: vi.fn().mockResolvedValue(undefined),
    getEventById: vi.fn().mockResolvedValue(null),
    putMemoryRecord: vi.fn().mockResolvedValue(undefined),
    searchMemoryRecords: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/** Valid XML response with a single memory record. */
const SINGLE_RECORD_XML = `
<memory_record type="tool_use">
  <title>Added JWT validation</title>
  <summary>Wrote JWT token validation logic in src/auth.ts</summary>
  <facts>
    <fact>JWT validation uses RS256 algorithm</fact>
  </facts>
  <concepts>
    <concept>jwt</concept>
    <concept>authentication</concept>
  </concepts>
  <files>
    <file>src/auth.ts</file>
  </files>
</memory_record>
`.trim();

/** Valid XML response with multiple memory records. */
const MULTI_RECORD_XML = `
<memory_record type="tool_use">
  <title>First record</title>
  <summary>First summary</summary>
  <facts><fact>fact one</fact></facts>
  <concepts><concept>concept-a</concept></concepts>
  <files><file>src/a.ts</file></files>
</memory_record>
<memory_record type="discovery">
  <title>Second record</title>
  <summary>Second summary</summary>
  <facts><fact>fact two</fact></facts>
  <concepts><concept>concept-b</concept></concepts>
  <files><file>src/b.ts</file></files>
</memory_record>
<memory_record type="decision">
  <title>Third record</title>
  <summary>Third summary</summary>
  <facts><fact>fact three</fact></facts>
  <concepts><concept>concept-c</concept></concepts>
  <files><file>src/c.ts</file></files>
</memory_record>
`.trim();

/** Garbage (conversational) response with no XML tags. */
const GARBAGE_RESPONSE =
  'Sure! Here is the information you requested about the code changes.';

// ── Tests ───────────────────────────────────────────────────────────────

beforeEach(() => {
  responseQueue.length = 0;
  mockSessions.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('invokeCompressor', () => {
  it('returns parsed records from valid XML response', async () => {
    responseQueue.push(SINGLE_RECORD_XML);

    const { invokeCompressor } = await import(
      '../../src/collector/pipeline/index.js'
    );

    const event = makeValidEvent({ kind: 'tool_use' });
    const records = await invokeCompressor(event, 30_000, 3);

    expect(records).toHaveLength(1);
    expect(records[0]!.type).toBe('tool_use');
    expect(records[0]!.title).toBe('Added JWT validation');
    expect(records[0]!.summary).toContain('JWT token validation');
  });

  it('returns empty array for empty response (skip signal)', async () => {
    responseQueue.push('   \n  ');

    const { invokeCompressor } = await import(
      '../../src/collector/pipeline/index.js'
    );

    const event = makeValidEvent();
    const records = await invokeCompressor(event, 30_000, 3);

    expect(records).toEqual([]);
  });

  it('retries on garbage response and succeeds on next attempt', async () => {
    responseQueue.push(GARBAGE_RESPONSE, SINGLE_RECORD_XML);

    const { invokeCompressor } = await import(
      '../../src/collector/pipeline/index.js'
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const event = makeValidEvent();
    const records = await invokeCompressor(event, 30_000, 3);

    expect(records).toHaveLength(1);
    expect(records[0]!.title).toBe('Added JWT validation');
    // Should have created 2 sessions (one for garbage, one for success)
    expect(mockSessions).toHaveLength(2);
    // Should have logged a warning about garbage
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('garbage detected'),
    );
  });

  it('throws after maxRetries exhausted on garbage responses', async () => {
    responseQueue.push(GARBAGE_RESPONSE, GARBAGE_RESPONSE, GARBAGE_RESPONSE);

    const { invokeCompressor } = await import(
      '../../src/collector/pipeline/index.js'
    );

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const event = makeValidEvent();

    await expect(invokeCompressor(event, 30_000, 3)).rejects.toThrow(
      /non-XML response/,
    );
    // Should have created exactly 3 sessions (one per retry)
    expect(mockSessions).toHaveLength(3);
  });

  it('retries on transient errors and succeeds', async () => {
    responseQueue.push(new Error('connection reset'), SINGLE_RECORD_XML);

    const { invokeCompressor } = await import(
      '../../src/collector/pipeline/index.js'
    );

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const event = makeValidEvent();
    const records = await invokeCompressor(event, 30_000, 3);

    expect(records).toHaveLength(1);
    expect(mockSessions).toHaveLength(2);
  });

  it('throws after maxRetries exhausted on transient errors', async () => {
    responseQueue.push(new Error('fail 1'), new Error('fail 2'));

    const { invokeCompressor } = await import(
      '../../src/collector/pipeline/index.js'
    );

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const event = makeValidEvent();

    await expect(invokeCompressor(event, 30_000, 2)).rejects.toThrow('fail 2');
    expect(mockSessions).toHaveLength(2);
  });

  it('always destroys ACP session on success', async () => {
    responseQueue.push(SINGLE_RECORD_XML);

    const { invokeCompressor } = await import(
      '../../src/collector/pipeline/index.js'
    );

    const event = makeValidEvent();
    await invokeCompressor(event, 30_000, 3);

    expect(mockSessions).toHaveLength(1);
    expect(mockSessions[0]!.destroy).toHaveBeenCalledTimes(1);
  });

  it('always destroys ACP session on failure', async () => {
    responseQueue.push(new Error('boom'));

    const { invokeCompressor } = await import(
      '../../src/collector/pipeline/index.js'
    );

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const event = makeValidEvent();

    await expect(invokeCompressor(event, 30_000, 1)).rejects.toThrow('boom');
    expect(mockSessions).toHaveLength(1);
    expect(mockSessions[0]!.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys all sessions across retries', async () => {
    responseQueue.push(
      GARBAGE_RESPONSE,
      new Error('transient'),
      SINGLE_RECORD_XML,
    );

    const { invokeCompressor } = await import(
      '../../src/collector/pipeline/index.js'
    );

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const event = makeValidEvent();
    await invokeCompressor(event, 30_000, 3);

    expect(mockSessions).toHaveLength(3);
    for (const session of mockSessions) {
      expect(session.destroy).toHaveBeenCalledTimes(1);
    }
  });

  it('returns multiple records from a single response', async () => {
    responseQueue.push(MULTI_RECORD_XML);

    const { invokeCompressor } = await import(
      '../../src/collector/pipeline/index.js'
    );

    const event = makeValidEvent();
    const records = await invokeCompressor(event, 30_000, 3);

    expect(records).toHaveLength(3);
    expect(records[0]!.title).toBe('First record');
    expect(records[1]!.title).toBe('Second record');
    expect(records[2]!.title).toBe('Third record');
  });
});

describe('createExtractionStage — runExtraction', () => {
  it('stores a single record from extraction', async () => {
    responseQueue.push(SINGLE_RECORD_XML);

    const { createExtractionStage } = await import(
      '../../src/collector/pipeline/index.js'
    );

    const storage = createMockStorage();
    const stage = createExtractionStage({
      storage,
      concurrency: 1,
      queueDepth: 10,
      timeoutMs: 30_000,
      maxRetries: 3,
    });

    const event = makeValidEvent({
      event_id: '01JF8ZS4Y00000000000000000',
      namespace: '/actor/alice/project/abc/',
    });

    stage.enqueue(event);
    await stage.drain(5000);

    expect(storage.putMemoryRecord).toHaveBeenCalledTimes(1);
    const storedRecord = storage.putMemoryRecord.mock.calls[0]![0] as MemoryRecord;
    expect(storedRecord.record_id).toMatch(/^mr_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(storedRecord.namespace).toBe('/actor/alice/project/abc/');
    expect(storedRecord.strategy).toBe('llm-summary');
    expect(storedRecord.source_event_ids).toEqual(['01JF8ZS4Y00000000000000000']);
    expect(storedRecord.title).toBe('Added JWT validation');
    expect(storedRecord.observation_type).toBe('tool_use');
  });

  it('stores multiple records from a single event with unique IDs', async () => {
    responseQueue.push(MULTI_RECORD_XML);

    const { createExtractionStage } = await import(
      '../../src/collector/pipeline/index.js'
    );

    const storage = createMockStorage();
    const stage = createExtractionStage({
      storage,
      concurrency: 1,
      queueDepth: 10,
      timeoutMs: 30_000,
      maxRetries: 3,
    });

    const event = makeValidEvent({
      event_id: '01JF8ZS4Y00000000000000000',
      namespace: '/actor/alice/project/abc/',
    });

    stage.enqueue(event);
    await stage.drain(5000);

    // Should store 3 records
    expect(storage.putMemoryRecord).toHaveBeenCalledTimes(3);

    // All record IDs should be unique ULIDs
    const recordIds = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const record = storage.putMemoryRecord.mock.calls[i]![0] as MemoryRecord;
      expect(record.record_id).toMatch(/^mr_[0-9A-HJKMNP-TV-Z]{26}$/);
      recordIds.add(record.record_id);
      // All records should share the same source event
      expect(record.source_event_ids).toEqual(['01JF8ZS4Y00000000000000000']);
      expect(record.namespace).toBe('/actor/alice/project/abc/');
      expect(record.strategy).toBe('llm-summary');
    }

    // All 3 record IDs must be unique
    expect(recordIds.size).toBe(3);

    // Verify individual record content
    const first = storage.putMemoryRecord.mock.calls[0]![0] as MemoryRecord;
    const second = storage.putMemoryRecord.mock.calls[1]![0] as MemoryRecord;
    const third = storage.putMemoryRecord.mock.calls[2]![0] as MemoryRecord;
    expect(first.title).toBe('First record');
    expect(first.observation_type).toBe('tool_use');
    expect(second.title).toBe('Second record');
    expect(second.observation_type).toBe('discovery');
    expect(third.title).toBe('Third record');
    expect(third.observation_type).toBe('decision');
  });

  it('does not crash the pipeline on extraction failure', async () => {
    // All retries fail
    responseQueue.push(
      new Error('fail 1'),
      new Error('fail 2'),
      new Error('fail 3'),
    );

    const { createExtractionStage } = await import(
      '../../src/collector/pipeline/index.js'
    );

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = createMockStorage();
    const stage = createExtractionStage({
      storage,
      concurrency: 1,
      queueDepth: 10,
      timeoutMs: 30_000,
      maxRetries: 3,
    });

    const event = makeValidEvent();
    stage.enqueue(event);

    // Should not throw — extraction failures are caught and logged
    await stage.drain(5000);

    expect(storage.putMemoryRecord).not.toHaveBeenCalled();
  });

  it('stores nothing for empty response (skip)', async () => {
    responseQueue.push('');

    const { createExtractionStage } = await import(
      '../../src/collector/pipeline/index.js'
    );

    const storage = createMockStorage();
    const stage = createExtractionStage({
      storage,
      concurrency: 1,
      queueDepth: 10,
      timeoutMs: 30_000,
      maxRetries: 3,
    });

    const event = makeValidEvent();
    stage.enqueue(event);
    await stage.drain(5000);

    expect(storage.putMemoryRecord).not.toHaveBeenCalled();
  });

  it('validates maxRetries option', async () => {
    const { createExtractionStage } = await import(
      '../../src/collector/pipeline/index.js'
    );

    const storage = createMockStorage();

    expect(() =>
      createExtractionStage({
        storage,
        concurrency: 1,
        queueDepth: 10,
        timeoutMs: 30_000,
        maxRetries: 0,
      }),
    ).toThrow('maxRetries must be a positive integer');

    expect(() =>
      createExtractionStage({
        storage,
        concurrency: 1,
        queueDepth: 10,
        timeoutMs: 30_000,
        maxRetries: -1,
      }),
    ).toThrow('maxRetries must be a positive integer');
  });

  it('defaults maxRetries to 3 when not specified', async () => {
    // Provide 3 garbage responses — should exhaust all 3 retries
    responseQueue.push(GARBAGE_RESPONSE, GARBAGE_RESPONSE, GARBAGE_RESPONSE);

    const { createExtractionStage } = await import(
      '../../src/collector/pipeline/index.js'
    );

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = createMockStorage();
    const stage = createExtractionStage({
      storage,
      concurrency: 1,
      queueDepth: 10,
      timeoutMs: 30_000,
      // maxRetries not specified — should default to 3
    });

    const event = makeValidEvent();
    stage.enqueue(event);
    await stage.drain(5000);

    // Should have created exactly 3 sessions (default maxRetries = 3)
    expect(mockSessions).toHaveLength(3);
  });
});
