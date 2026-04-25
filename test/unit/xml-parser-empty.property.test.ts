/**
 * Property-based test for empty input handling.
 *
 * Feature: xml-extraction-pipeline, Property 4: XML parse returns empty for empty input
 *
 * Generate whitespace-only strings, verify `parseMemoryXml` returns `[]`
 * and `isGarbageResponse` returns `false`.
 *
 * @see .kiro/specs/xml-extraction-pipeline/design.md § Property 4
 * @see .kiro/specs/xml-extraction-pipeline/requirements.md § Requirements 5.1, 5.4
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  isGarbageResponse,
  parseMemoryXml,
} from '../../src/collector/pipeline/xml-parser.js';

// ── Arbitrary ───────────────────────────────────────────────────────────

/**
 * Arbitrary whitespace-only string (including the empty string).
 * Uses only space, tab, newline, and carriage return characters.
 */
const whitespaceOnlyArb = fc
  .array(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 0, maxLength: 50 })
  .map((chars) => chars.join(''));

// ── Property test ───────────────────────────────────────────────────────

describe('parseMemoryXml / isGarbageResponse — property: empty input (P4)', () => {
  it('parseMemoryXml returns [] for whitespace-only strings', () => {
    /**
     * **Validates: Requirements 5.1, 5.4**
     *
     * For any whitespace-only string (including empty), `parseMemoryXml`
     * SHALL return an empty array.
     */
    fc.assert(
      fc.property(whitespaceOnlyArb, (s) => {
        expect(parseMemoryXml(s)).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it('isGarbageResponse returns false for whitespace-only strings', () => {
    /**
     * **Validates: Requirements 5.1, 5.4**
     *
     * For any whitespace-only string (including empty), `isGarbageResponse`
     * SHALL return `false`.
     */
    fc.assert(
      fc.property(whitespaceOnlyArb, (s) => {
        expect(isGarbageResponse(s)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});
