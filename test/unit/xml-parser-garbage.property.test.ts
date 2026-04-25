/**
 * Property-based test for garbage detection correctness.
 *
 * Feature: xml-extraction-pipeline, Property 5: Garbage detection correctness
 *
 * - Generate non-empty strings without `<memory_record` or `<skip`
 *   substrings, verify `isGarbageResponse` returns `true`.
 * - Generate strings containing `<memory_record` or `<skip`, verify
 *   `isGarbageResponse` returns `false`.
 *
 * @see .kiro/specs/xml-extraction-pipeline/design.md § Property 5
 * @see .kiro/specs/xml-extraction-pipeline/requirements.md § Requirements 5.2, 5.3, 5.4
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { isGarbageResponse } from '../../src/collector/pipeline/xml-parser.js';

// ── Arbitraries ─────────────────────────────────────────────────────────

/**
 * Arbitrary non-empty string that does not contain `<memory_record` or
 * `<skip` substrings and is not whitespace-only.
 *
 * We generate a printable string and strip any accidental occurrences of
 * the forbidden substrings, then filter to ensure the result is non-empty
 * after trimming.
 */
const garbageStringArb = fc
  .string({ minLength: 1, maxLength: 200 })
  .map((s) => s.replace(/<memory_record/g, '').replace(/<skip/g, ''))
  .filter((s) => {
    const trimmed = s.trim();
    return (
      trimmed.length > 0 &&
      !trimmed.includes('<memory_record') &&
      !trimmed.includes('<skip')
    );
  });

/**
 * Arbitrary string that contains `<memory_record` somewhere in it.
 * We inject the tag into a generated string.
 */
const stringWithMemoryRecordArb = fc
  .tuple(
    fc.string({ maxLength: 50 }),
    fc.string({ maxLength: 50 }),
  )
  .map(([before, after]) => `${before}<memory_record${after}`);

/**
 * Arbitrary string that contains `<skip` somewhere in it.
 */
const stringWithSkipArb = fc
  .tuple(
    fc.string({ maxLength: 50 }),
    fc.string({ maxLength: 50 }),
  )
  .map(([before, after]) => `${before}<skip${after}`);

// ── Property tests ──────────────────────────────────────────────────────

describe('isGarbageResponse — property: garbage detection correctness (P5)', () => {
  it('returns true for non-empty strings without <memory_record or <skip', () => {
    /**
     * **Validates: Requirements 5.2, 5.3, 5.4**
     *
     * For any non-empty string that does not contain `<memory_record` or
     * `<skip`, `isGarbageResponse` SHALL return `true`.
     */
    fc.assert(
      fc.property(garbageStringArb, (s) => {
        expect(isGarbageResponse(s)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('returns false for strings containing <memory_record', () => {
    /**
     * **Validates: Requirements 5.2, 5.3, 5.4**
     *
     * For any string containing `<memory_record`, `isGarbageResponse`
     * SHALL return `false`.
     */
    fc.assert(
      fc.property(stringWithMemoryRecordArb, (s) => {
        expect(isGarbageResponse(s)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('returns false for strings containing <skip', () => {
    /**
     * **Validates: Requirements 5.2, 5.3, 5.4**
     *
     * For any string containing `<skip`, `isGarbageResponse` SHALL
     * return `false`.
     */
    fc.assert(
      fc.property(stringWithSkipArb, (s) => {
        expect(isGarbageResponse(s)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});
