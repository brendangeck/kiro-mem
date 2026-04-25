/**
 * Property-based test for title and summary length enforcement.
 *
 * Feature: xml-extraction-pipeline, Property 9: Title and summary length enforcement
 *
 * Generate `<memory_record>` XML with title > 200 chars and summary > 4000
 * chars, parse via `parseMemoryXml`, verify `title.length <= 200` and
 * `summary.length <= 4000`.
 *
 * @see .kiro/specs/xml-extraction-pipeline/design.md § Property 9
 * @see .kiro/specs/xml-extraction-pipeline/requirements.md § Requirements 4.6, 4.7
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { escapeXml } from '../../src/collector/pipeline/xml-framer.js';
import { parseMemoryXml } from '../../src/collector/pipeline/xml-parser.js';

// ── Arbitraries ─────────────────────────────────────────────────────────

/** Arbitrary observation type. */
const typeArb = fc.constantFrom(
  'tool_use',
  'decision',
  'error',
  'discovery',
  'pattern',
);

/**
 * Arbitrary string longer than 200 chars for oversized titles.
 * Uses alphanumeric characters to avoid XML tag interference.
 */
const longTitleArb = fc
  .string({ minLength: 201, maxLength: 400 })
  .map((s) => s.replace(/[<>&"']/g, 'x'))
  .filter((s) => s.trim().length > 200);

/**
 * Arbitrary string longer than 4000 chars for oversized summaries.
 */
const longSummaryArb = fc
  .string({ minLength: 4001, maxLength: 5000 })
  .map((s) => s.replace(/[<>&"']/g, 'x'))
  .filter((s) => s.trim().length > 4000);

// ── Serializer ──────────────────────────────────────────────────────────

function buildXml(type: string, title: string, summary: string): string {
  return [
    `<memory_record type="${type}">`,
    `  <title>${escapeXml(title)}</title>`,
    `  <summary>${escapeXml(summary)}</summary>`,
    '</memory_record>',
  ].join('\n');
}

// ── Property test ───────────────────────────────────────────────────────

describe('parseMemoryXml — property: title and summary length enforcement (P9)', () => {
  it('truncates title to 200 chars when input exceeds limit', () => {
    /**
     * **Validates: Requirements 4.6, 4.7**
     *
     * For any `<memory_record>` with title > 200 chars, `parseMemoryXml`
     * SHALL truncate the title to at most 200 characters.
     */
    fc.assert(
      fc.property(typeArb, longTitleArb, (type, title) => {
        // Use a short summary so the record is valid
        const xml = buildXml(type, title, 'A valid summary');
        const parsed = parseMemoryXml(xml);

        expect(parsed.length).toBe(1);
        expect(parsed[0]!.title.length).toBeLessThanOrEqual(200);
      }),
      { numRuns: 100 },
    );
  });

  it('truncates summary to 4000 chars when input exceeds limit', () => {
    /**
     * **Validates: Requirements 4.6, 4.7**
     *
     * For any `<memory_record>` with summary > 4000 chars, `parseMemoryXml`
     * SHALL truncate the summary to at most 4000 characters.
     */
    fc.assert(
      fc.property(typeArb, longSummaryArb, (type, summary) => {
        // Use a short title so the record is valid
        const xml = buildXml(type, 'A valid title', summary);
        const parsed = parseMemoryXml(xml);

        expect(parsed.length).toBe(1);
        expect(parsed[0]!.summary.length).toBeLessThanOrEqual(4000);
      }),
      { numRuns: 100 },
    );
  });
});
