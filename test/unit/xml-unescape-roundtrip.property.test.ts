/**
 * Property-based test for XML escape/unescape round-trip.
 *
 * Feature: xml-extraction-pipeline, Property 6: XML unescape reverses escape
 *
 * For any string `s` that does not contain pre-existing XML entity
 * references, `unescapeXml(escapeXml(s)) === s`.
 *
 * @see .kiro/specs/xml-extraction-pipeline/design.md § Property 6
 * @see .kiro/specs/xml-extraction-pipeline/requirements.md § Requirement 3.3
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { escapeXml } from '../../src/collector/pipeline/xml-framer.js';
import { unescapeXml } from '../../src/collector/pipeline/xml-parser.js';

/**
 * Arbitrary string that does not contain pre-existing XML entity references.
 * We filter out strings containing `&amp;`, `&lt;`, `&gt;`, `&quot;`, or
 * `&apos;` since the round-trip property only holds for strings without
 * pre-existing entities.
 */
const stringWithoutEntities = fc.string().filter((s) => {
  return (
    !s.includes('&amp;') &&
    !s.includes('&lt;') &&
    !s.includes('&gt;') &&
    !s.includes('&quot;') &&
    !s.includes('&apos;')
  );
});

describe('escapeXml/unescapeXml — property: round-trip (P6)', () => {
  it('unescapeXml(escapeXml(s)) === s for strings without pre-existing entities', () => {
    /**
     * **Validates: Requirement 3.3**
     *
     * For any string that does not contain XML entity references,
     * applying `escapeXml` then `unescapeXml` SHALL produce the original
     * string.
     */
    fc.assert(
      fc.property(stringWithoutEntities, (s) => {
        const roundTripped = unescapeXml(escapeXml(s));
        expect(roundTripped).toBe(s);
      }),
      { numRuns: 200 },
    );
  });
});
