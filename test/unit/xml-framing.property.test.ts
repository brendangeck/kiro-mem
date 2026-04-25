/**
 * Property-based test for XML framing well-formedness.
 *
 * Feature: xml-extraction-pipeline, Property 2: XML framing well-formedness
 *
 * For any valid `KiroMemEvent`, `frameEvent(event)` returns a string that
 * starts with `<tool_observation>` and ends with `</tool_observation>`,
 * contains exactly one `<tool_name>`, one `<timestamp>`, and one `<input>`
 * element.
 *
 * @see .kiro/specs/xml-extraction-pipeline/design.md § Property 2
 * @see .kiro/specs/xml-extraction-pipeline/requirements.md § Requirements 2.1, 2.2, 2.6
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { frameEvent } from '../../src/collector/pipeline/xml-framer.js';
import { arbitraryEvent } from '../helpers/arbitrary.js';

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count += 1;
    pos = idx + needle.length;
  }
  return count;
}

describe('frameEvent — property: XML framing well-formedness (P2)', () => {
  it('output starts with <tool_observation>, ends with </tool_observation>, and contains exactly one of each required element', () => {
    /**
     * **Validates: Requirements 2.1, 2.2, 2.6**
     *
     * For any valid KiroMemEvent, `frameEvent` SHALL return a string that:
     * - starts with `<tool_observation>`
     * - ends with `</tool_observation>`
     * - contains exactly one `<tool_name>` element
     * - contains exactly one `<timestamp>` element
     * - contains exactly one `<input>` element
     */
    fc.assert(
      fc.property(arbitraryEvent(), (event) => {
        const xml = frameEvent(event);

        // Must start and end with the root element
        expect(xml.startsWith('<tool_observation>')).toBe(true);
        expect(xml.endsWith('</tool_observation>')).toBe(true);

        // Exactly one of each required element (opening + closing tag pairs)
        expect(countOccurrences(xml, '<tool_name>')).toBe(1);
        expect(countOccurrences(xml, '</tool_name>')).toBe(1);

        expect(countOccurrences(xml, '<timestamp>')).toBe(1);
        expect(countOccurrences(xml, '</timestamp>')).toBe(1);

        expect(countOccurrences(xml, '<input>')).toBe(1);
        expect(countOccurrences(xml, '</input>')).toBe(1);
      }),
      { numRuns: 200 },
    );
  });
});
