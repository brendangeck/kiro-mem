/**
 * Property-based tests for the dedup pipeline stage.
 *
 * Feature: collector-pipeline, Property 5: Dedup rejects duplicate event_ids
 * Feature: collector-pipeline, Property 6: Dedup set respects size bound
 *
 * @see .kiro/specs/collector-pipeline/design.md § Property 5, Property 6
 * @see .kiro/specs/collector-pipeline/requirements.md § Requirements 5.2, 5.3, 5.4
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createDedupStage } from '../src/collector/pipeline/index.js';
import { arbitraryEvent, ulidArb } from './arbitrary.js';

describe('DedupStage — property: rejects duplicate event_ids (P5)', () => {
  // Feature: collector-pipeline, Property 5: Dedup rejects duplicate event_ids
  it('first submission continues, second submission halts with stored: false', async () => {
    /**
     * **Validates: Requirements 5.2, 5.3**
     *
     * For any valid KiroMemEvent, processing it through a fresh dedup stage
     * twice must yield `continue` on the first call and `halt` with
     * `{ stored: false, event_id }` on the second call.
     */
    await fc.assert(
      fc.asyncProperty(arbitraryEvent(), async (event) => {
        const dedup = createDedupStage({ maxSize: 10_000 });

        // First submission — should continue
        const first = await dedup.process(event);
        expect(first.action).toBe('continue');
        if (first.action === 'continue') {
          expect(first.event).toEqual(event);
        }

        // Second submission — should halt with stored: false
        const second = await dedup.process(event);
        expect(second.action).toBe('halt');
        if (second.action === 'halt') {
          expect(second.response.stored).toBe(false);
          expect(second.response.event_id).toBe(event.event_id);
        }
      }),
      { numRuns: 100 },
    );
  });
});


describe('DedupStage — property: set respects size bound (P6)', () => {
  // Feature: collector-pipeline, Property 6: Dedup set respects size bound
  it('internal set never exceeds maxSize for any sequence of distinct events', async () => {
    /**
     * **Validates: Requirements 5.4**
     *
     * For any sequence of N distinct events where N > maxSize, the dedup
     * stage's internal set size never exceeds maxSize. After processing all
     * events, the most recent maxSize event_ids are still in the set (they
     * are recognised as duplicates).
     */
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 2, max: 5 }),
        arbitraryEvent(),
        async (maxSize, multiplier, templateEvent) => {
          const count = maxSize * multiplier; // always > maxSize
          const dedup = createDedupStage({ maxSize });

          // Generate `count` distinct event_ids
          const eventIds: string[] = [];
          const idSet = new Set<string>();
          // Use a seeded fc.sample to get distinct ULIDs
          const candidateIds = fc.sample(ulidArb(), count * 2);
          for (const id of candidateIds) {
            if (idSet.has(id)) continue;
            idSet.add(id);
            eventIds.push(id);
            if (eventIds.length >= count) break;
          }

          // If we couldn't generate enough distinct ids, skip this iteration
          if (eventIds.length < count) return;

          // Process each event through the dedup stage
          for (const eventId of eventIds) {
            const event = { ...templateEvent, event_id: eventId };
            const result = await dedup.process(event);
            expect(result.action).toBe('continue');

            // Invariant: set size never exceeds maxSize
            expect(dedup.size).toBeLessThanOrEqual(maxSize);
          }

          // After processing all events, the most recent maxSize event_ids
          // should still be in the set (recognised as duplicates)
          const recentIds = eventIds.slice(-maxSize);
          for (const eventId of recentIds) {
            const event = { ...templateEvent, event_id: eventId };
            const result = await dedup.process(event);
            expect(result.action).toBe('halt');
            if (result.action === 'halt') {
              expect(result.response.stored).toBe(false);
            }
          }

          // The oldest ids (beyond maxSize) should have been evicted
          const evictedIds = eventIds.slice(0, -maxSize);
          for (const eventId of evictedIds) {
            const event = { ...templateEvent, event_id: eventId };
            const result = await dedup.process(event);
            // Evicted ids are no longer in the set, so they should continue
            expect(result.action).toBe('continue');
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
