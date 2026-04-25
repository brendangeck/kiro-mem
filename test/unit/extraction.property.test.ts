/**
 * Property-based tests for the extraction pipeline stage.
 *
 * Feature: collector-pipeline, Property 10: Extraction concurrency bound
 *
 * @see .kiro/specs/collector-pipeline/design.md § Property 10
 * @see .kiro/specs/collector-pipeline/requirements.md § Requirements 9.1, 9.2
 */

import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KiroMemEvent, StorageBackend } from '../../src/types/index.js';
import { arbitraryEvent } from '../helpers/arbitrary.js';

// ── Mock ACP client ─────────────────────────────────────────────────────

/**
 * Track concurrently active mock ACP sessions. Each mock session creation
 * increments `active`, and completing (resolving sendPrompt + destroy)
 * decrements it. We record the high-water mark so the property can assert
 * it never exceeds the concurrency limit.
 */
let active = 0;
let maxActive = 0;

interface PendingSession {
  resolveSendPrompt: (text: string) => void;
  destroyed: boolean;
}

const pendingSessions: PendingSession[] = [];

function resetTracking(): void {
  active = 0;
  maxActive = 0;
  pendingSessions.length = 0;
}

/**
 * Mock `createAcpSession` that returns a controllable AcpSession.
 * The session's `sendPrompt` blocks until we resolve it externally.
 */
vi.mock('../../src/collector/pipeline/acp-client.js', () => ({
  createAcpSession: vi.fn().mockImplementation(() => {
    active += 1;
    if (active > maxActive) {
      maxActive = active;
    }

    let resolveSendPrompt!: (text: string) => void;
    const sendPromptPromise = new Promise<string>((resolve) => {
      resolveSendPrompt = resolve;
    });

    const entry: PendingSession = {
      resolveSendPrompt,
      destroyed: false,
    };
    pendingSessions.push(entry);

    return Promise.resolve({
      sendPrompt: vi.fn().mockImplementation(() => sendPromptPromise),
      destroy: vi.fn().mockImplementation(() => {
        if (!entry.destroyed) {
          entry.destroyed = true;
          active -= 1;
        }
      }),
    });
  }),
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

/**
 * Valid XML response that produces one memory record when parsed.
 */
const VALID_XML_RESPONSE = `
<memory_record type="tool_use">
  <title>Test extraction</title>
  <summary>A test summary</summary>
  <facts><fact>fact one</fact></facts>
  <concepts><concept>testing</concept></concepts>
  <files><file>src/test.ts</file></files>
</memory_record>
`.trim();

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
     * of concurrently active ACP sessions never exceeds the configured
     * concurrency limit. We use a mock ACP client that tracks the active
     * count and assert the high-water mark stays within bounds.
     */

    // We need to dynamically import createExtractionStage AFTER the mock
    // is set up so that the module picks up the mocked ACP client.
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
            maxRetries: 1, // single attempt to keep things simple
          });

          // Enqueue all events
          for (let i = 0; i < eventCount; i++) {
            const event: KiroMemEvent = {
              ...templateEvent,
              event_id: `${templateEvent.event_id.slice(0, -4)}${String(i).padStart(4, '0')}`,
            };
            stage.enqueue(event);
          }

          // Allow microtasks to run so sessions are created
          await new Promise((resolve) => setTimeout(resolve, 0));

          // At this point, the stage should have created up to `concurrency`
          // ACP sessions. The active count tracked by our mock should never
          // have exceeded the limit.
          expect(maxActive).toBeLessThanOrEqual(concurrency);
          expect(stage.active).toBeLessThanOrEqual(concurrency);

          // Complete all pending sessions in batches until everything drains
          let iterations = 0;
          const maxIterations = eventCount + 5;
          while (pendingSessions.length > 0 && iterations < maxIterations) {
            const batch = pendingSessions.splice(0);
            for (const session of batch) {
              session.resolveSendPrompt(VALID_XML_RESPONSE);
            }
            // Allow microtasks to run so the stage picks up completions
            // and creates the next batch of sessions
            await new Promise((resolve) => setTimeout(resolve, 10));
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
      { numRuns: 50 },
    );
  });
});
