/**
 * Property-based test for XML escape round-trip safety.
 *
 * Feature: xml-extraction-pipeline, Property 1: XML escape round-trip safety
 *
 * For any string `s`, `escapeXml(s)` produces output containing zero raw
 * `<`, `>`, `&`, `"`, or `'` characters that were present in the original
 * input.
 *
 * @see .kiro/specs/xml-extraction-pipeline/design.md § Property 1
 * @see .kiro/specs/xml-extraction-pipeline/requirements.md § Requirements 3.1, 3.2
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { escapeXml } from '../../src/collector/pipeline/xml-framer.js';

describe('escapeXml — property: XML escape round-trip safety (P1)', () => {
  it('escapeXml output contains no raw <, >, &, ", \' characters', () => {
    /**
     * **Validates: Requirements 3.1, 3.2**
     *
     * For any arbitrary string, `escapeXml` SHALL replace all occurrences
     * of `<`, `>`, `&`, `"`, and `'` with their corresponding XML entity
     * references, producing output with zero raw special characters.
     */
    fc.assert(
      fc.property(fc.string(), (s) => {
        const escaped = escapeXml(s);

        // The escaped output must not contain any raw XML special characters.
        // We check that none of the five special chars appear as raw chars.
        // Entity references like &amp; contain '&' but that '&' is part of
        // the entity syntax, not a raw special char from the input. We verify
        // by checking that after removing all valid entity references, no
        // special chars remain.
        const withoutEntities = escaped
          .replace(/&amp;/g, '')
          .replace(/&lt;/g, '')
          .replace(/&gt;/g, '')
          .replace(/&quot;/g, '')
          .replace(/&apos;/g, '');

        expect(withoutEntities).not.toContain('<');
        expect(withoutEntities).not.toContain('>');
        expect(withoutEntities).not.toContain('&');
        expect(withoutEntities).not.toContain('"');
        expect(withoutEntities).not.toContain("'");
      }),
      { numRuns: 200 },
    );
  });
});
