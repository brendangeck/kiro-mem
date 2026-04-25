/**
 * Property-based tests for the extraction pipeline stage.
 *
 * Feature: collector-pipeline, Property 10: Extraction concurrency bound
 *
 * @see .kiro/specs/collector-pipeline/design.md § Property 10
 * @see .kiro/specs/collector-pipeline/requirements.md § Requirements 9.1, 9.2
 */

import { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KiroMemEvent, StorageBackend } from '../../src/types/index.js';
import { arbitraryEvent } from '../helpers/arbitrary.js';

// ── Mock child_process.spawn ────────────────────────────────────────────

/**
 * Track concurrently active mock processes. Each mock spawn increments
 * `active`, and completing the process decrements it. We record the
 * high-water mark so the property can assert it never exceeds the
 * concurrency limit.
 */
let active = 0;
let maxActive = 0;
const pendingProcesses: Array<{
  proc: EventEmitter;
  stdout: PassThrough;
  stdin: PassThrough;
}> = [];

function resetTracking(): void {
  active = 0;
  maxActive = 0;
  pendingProcesses.length = 0;
}

/**
 * Create a fake ChildProcess-like object that the extraction stage's
 * `spawnKiroCli` can interact with. The process completes after a
 * microtask tick to simulate async work.
 */
function createFakeChildProcess(): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();

  // Assign streams as the extraction stage reads from them
  (proc as unknown as Record<string, unknown>).stdout = stdout;
  (proc as unknown as Record<string, unknown>).stderr = stderr;
  (proc as unknown as Record<string, unknown>).stdin = stdin;
  (proc as unknown as Record<string, unknown>).pid = Math.floor(
    Math.random() * 100000,
  );

   
  proc.kill = (_signal?: number | NodeJS.Signals): boolean => {
    return true;
  };

  active += 1;
  if (active > maxActive) {
    maxActive = active;
  }

  pendingProcesses.push({ proc, stdout, stdin });

  return proc;
}

/**
 * Complete all pending mock processes by writing a valid JSON extraction
 * result to stdout and emitting the 'close' event with exit code 0.
 * Each completion decrements the active count.
 */
function completeAllPending(): void {
  const batch = pendingProcesses.splice(0);
  for (const { proc, stdout, stdin } of batch) {
    // Drain stdin so the write doesn't error
    stdin.resume();

    // Write a valid MemoryRecord-shaped JSON to stdout
    const result = JSON.stringify({
      record_id: `mr_${'0'.repeat(26)}`,
      namespace: '/actor/test/project/test/',
      strategy: 'llm-summary',
      title: 'Test extraction',
      summary: 'A test summary',
      facts: [],
      source_event_ids: ['0'.repeat(26)],
      created_at: new Date().toISOString(),
    });
    stdout.write(result);
    stdout.end();

    active -= 1;

    // Emit close with exit code 0
    proc.emit('close', 0);
  }
}

// Mock the spawn function from node:child_process
vi.mock('node:child_process', () => ({
  spawn: () => createFakeChildProcess(),
}));

// ── Helpers ─────────────────────────────────────────────────────────────

/** Minimal mock StorageBackend that records putMemoryRecord calls. */
function createMockStorage(): StorageBackend {
  return {
    putEvent: vi.fn().mockResolvedValue(undefined),
    getEventById: vi.fn().mockResolvedValue(null),
    putMemoryRecord: vi.fn().mockResolvedValue(undefined),
    searchMemoryRecords: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('ExtractionStage — property: concurrency bound (P10)', () => {
  // Feature: collector-pipeline, Property 10: Extraction concurrency bound

  afterEach(() => {
    resetTracking();
  });

  it('active process count never exceeds the configured concurrency limit', async () => {
    /**
     * **Validates: Requirements 9.1, 9.2**
     *
     * For any sequence of N events where N > concurrency limit, the number
     * of concurrently active kiro-cli processes never exceeds the configured
     * concurrency limit. We use a mock spawner that tracks the active count
     * and assert the high-water mark stays within bounds.
     */

    // We need to dynamically import createExtractionStage AFTER the mock
    // is set up so that the module picks up the mocked spawn.
    const { createExtractionStage } = await import(
      '../../src/collector/pipeline/index.js'
    );

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        arbitraryEvent(),
        async (concurrency, templateEvent) => {
          resetTracking();

          const eventCount = concurrency * 3; // always > concurrency
          const storage = createMockStorage();

          const stage = createExtractionStage({
            storage,
            concurrency,
            queueDepth: eventCount + 10, // large enough to not drop
            timeoutMs: 30_000,
          });

          // Enqueue all events
          for (let i = 0; i < eventCount; i++) {
            const event: KiroMemEvent = {
              ...templateEvent,
              event_id: `${templateEvent.event_id.slice(0, -4)}${String(i).padStart(4, '0')}`,
            };
            stage.enqueue(event);
          }

          // At this point, the stage should have spawned up to `concurrency`
          // processes. The active count tracked by our mock should never
          // have exceeded the limit.
          expect(maxActive).toBeLessThanOrEqual(concurrency);
          expect(stage.active).toBeLessThanOrEqual(concurrency);

          // Complete all pending processes in batches until everything drains
          let iterations = 0;
          const maxIterations = eventCount + 5;
          while (pendingProcesses.length > 0 && iterations < maxIterations) {
            completeAllPending();
            // Allow microtasks to run so the stage picks up completions
            // and spawns the next batch
            await new Promise((resolve) => setTimeout(resolve, 0));
            iterations += 1;

            // After each batch, the invariant must still hold
            expect(maxActive).toBeLessThanOrEqual(concurrency);
          }

          // Drain the stage to ensure everything completes
          await stage.drain(5000);

          // Final assertion: the high-water mark never exceeded the limit
          expect(maxActive).toBeLessThanOrEqual(concurrency);
        },
      ),
      { numRuns: 100 },
    );
  });
});
