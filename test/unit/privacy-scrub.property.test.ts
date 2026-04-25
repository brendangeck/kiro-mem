/**
 * Property-based test for privacy scrub completeness.
 *
 * Feature: collector-pipeline, Property 1: Privacy scrub completeness
 *
 * For any event with `<private>` spans, scrubbing then `JSON.stringify`
 * produces zero occurrences of `<private>`.
 *
 * @see .kiro/specs/collector-pipeline/design.md § Property 1
 * @see .kiro/specs/collector-pipeline/requirements.md § Requirements 4.3, 6.1, 6.2, 6.3, 6.5, 6.6, 7.1
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createPrivacyScrubStage } from '../../src/collector/pipeline/index.js';
import { arbitraryCleanEvent, arbitraryEvent, arbitraryEventWithPrivateSpans } from '../helpers/arbitrary.js';

// Feature: collector-pipeline, Property 1: Privacy scrub completeness
describe('PrivacyScrubStage — property: scrub completeness (P1)', () => {
  it('scrubbing then JSON.stringify produces zero occurrences of <private>', async () => {
    /**
     * **Validates: Requirements 4.3, 6.1, 6.2, 6.3, 6.5, 6.6, 7.1**
     *
     * For any valid KiroMemEvent whose body contains one or more
     * `<private>...</private>` spans (including nested and unclosed tags),
     * applying the privacy scrub stage and then serializing the entire
     * result via `JSON.stringify` SHALL produce a string containing zero
     * occurrences of the substring `<private>`.
     */
    const stage = createPrivacyScrubStage();

    await fc.assert(
      fc.asyncProperty(arbitraryEventWithPrivateSpans(), async (event) => {
        const result = await stage.process(event);

        // The scrub stage always continues (never halts).
        expect(result.action).toBe('continue');
        if (result.action !== 'continue') return;

        const serialized = JSON.stringify(result.event);

        // The serialized output must contain zero occurrences of <private>.
        expect(serialized).not.toContain('<private>');
        expect(serialized).not.toContain('</private>');
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: collector-pipeline, Property 2: Privacy scrub idempotency
describe('PrivacyScrubStage — property: scrub idempotency (P2)', () => {
  it('scrub(scrub(event)) deep-equals scrub(event)', async () => {
    /**
     * **Validates: Requirements 7.2**
     *
     * For any valid KiroMemEvent, applying the privacy scrub stage twice
     * SHALL produce an output identical (deep-equal) to applying it once.
     * That is, `scrub(scrub(event))` deep-equals `scrub(event)`.
     */
    const stage = createPrivacyScrubStage();

    await fc.assert(
      fc.asyncProperty(arbitraryEvent(), async (event) => {
        const result1 = await stage.process(event);
        expect(result1.action).toBe('continue');
        if (result1.action !== 'continue') return;

        const result2 = await stage.process(result1.event);
        expect(result2.action).toBe('continue');
        if (result2.action !== 'continue') return;

        expect(result2.event).toStrictEqual(result1.event);
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: collector-pipeline, Property 3: Privacy scrub immutability
describe('PrivacyScrubStage — property: scrub immutability (P3)', () => {
  it('original event is not mutated by scrubbing', async () => {
    /**
     * **Validates: Requirements 6.7**
     *
     * For any valid KiroMemEvent, applying the privacy scrub stage SHALL
     * NOT mutate the original event object. A deep clone taken before
     * scrubbing SHALL deep-equal the original after scrubbing completes.
     */
    const stage = createPrivacyScrubStage();

    await fc.assert(
      fc.asyncProperty(arbitraryEvent(), async (event) => {
        // Take a deep clone before scrubbing via JSON round-trip to
        // normalise prototypes (structuredClone can diverge on
        // null-prototype objects produced by fast-check generators).
        const cloneBefore = JSON.parse(JSON.stringify(event)) as typeof event;

        // Run the event through the privacy scrub stage
        const result = await stage.process(event);

        // The scrub stage always continues (never halts).
        expect(result.action).toBe('continue');

        // The original event must be unchanged — deep-equal to the clone
        expect(JSON.parse(JSON.stringify(event))).toStrictEqual(cloneBefore);
      }),
      { numRuns: 100 },
    );
  });
});


// Feature: collector-pipeline, Property 4: Privacy scrub identity on clean input
describe('PrivacyScrubStage — property: scrub identity on clean input (P4)', () => {
  it('scrubbing an event with no <private> substring produces a deep-equal result', async () => {
    /**
     * **Validates: Requirements 6.4**
     *
     * For any valid KiroMemEvent whose body contains zero occurrences of
     * the substring `<private>`, applying the privacy scrub stage SHALL
     * produce an event that deep-equals the input.
     */
    const stage = createPrivacyScrubStage();

    await fc.assert(
      fc.asyncProperty(arbitraryCleanEvent(), async (event) => {
        // Precondition: the event body has no <private> substring.
        const serialized = JSON.stringify(event);
        expect(serialized).not.toContain('<private>');

        const result = await stage.process(event);

        // The scrub stage always continues (never halts).
        expect(result.action).toBe('continue');
        if (result.action !== 'continue') return;

        // The output must deep-equal the input since there was nothing to scrub.
        expect(result.event).toStrictEqual(event);
      }),
      { numRuns: 100 },
    );
  });
});
