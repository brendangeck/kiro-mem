/**
 * Property-based test for XML parse extracts all valid records.
 *
 * Feature: xml-extraction-pipeline, Property 3: XML parse extracts all valid records
 *
 * Generate arrays of `RawMemoryFields`, serialize to well-formed
 * `<memory_record>` XML, parse back via `parseMemoryXml`, verify the count
 * and field values match.
 *
 * @see .kiro/specs/xml-extraction-pipeline/design.md § Property 3
 * @see .kiro/specs/xml-extraction-pipeline/requirements.md § Requirements 4.1, 4.2
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { escapeXml } from '../../src/collector/pipeline/xml-framer.js';
import {
  parseMemoryXml,
  type ObservationType,
  type RawMemoryFields,
} from '../../src/collector/pipeline/xml-parser.js';

// ── Arbitraries ─────────────────────────────────────────────────────────

/** Arbitrary valid observation type. */
const observationTypeArb: fc.Arbitrary<ObservationType> = fc.constantFrom(
  'tool_use' as const,
  'decision' as const,
  'error' as const,
  'discovery' as const,
  'pattern' as const,
);

/**
 * Arbitrary non-empty string that stays within title length (≤ 200 chars)
 * and does not contain XML tag-like substrings that would confuse the
 * regex parser. Stable under trim (no leading/trailing whitespace).
 */
const safeTitleArb = fc
  .string({ minLength: 1, maxLength: 200 })
  .map((s) => s.replace(/<\/?[a-z_]+>/g, '').trim())
  .filter((s) => s.length > 0);

/**
 * Arbitrary non-empty string that stays within summary length (≤ 4000 chars).
 * Stable under trim.
 */
const safeSummaryArb = fc
  .string({ minLength: 1, maxLength: 500 })
  .map((s) => s.replace(/<\/?[a-z_]+>/g, '').trim())
  .filter((s) => s.length > 0);

/**
 * Arbitrary non-empty string for facts/concepts/files.
 * Stable under trim (no leading/trailing whitespace).
 */
const safeItemArb = fc
  .string({ minLength: 1, maxLength: 100 })
  .map((s) => s.replace(/<\/?[a-z_]+>/g, '').trim())
  .filter((s) => s.length > 0);

/** Arbitrary `RawMemoryFields` with valid, bounded content. */
const rawMemoryFieldsArb: fc.Arbitrary<RawMemoryFields> = fc.record({
  type: observationTypeArb,
  title: safeTitleArb,
  summary: safeSummaryArb,
  facts: fc.array(safeItemArb, { minLength: 0, maxLength: 3 }),
  concepts: fc.array(safeItemArb, { minLength: 0, maxLength: 3 }),
  files: fc.array(safeItemArb, { minLength: 0, maxLength: 3 }),
});

// ── Serializer ──────────────────────────────────────────────────────────

/** Serialize a `RawMemoryFields` to a well-formed `<memory_record>` XML block. */
function serializeRecord(r: RawMemoryFields): string {
  const lines: string[] = [];
  lines.push(`<memory_record type="${r.type}">`);
  lines.push(`  <title>${escapeXml(r.title)}</title>`);
  lines.push(`  <summary>${escapeXml(r.summary)}</summary>`);
  if (r.facts.length > 0) {
    lines.push('  <facts>');
    for (const f of r.facts) {
      lines.push(`    <fact>${escapeXml(f)}</fact>`);
    }
    lines.push('  </facts>');
  }
  if (r.concepts.length > 0) {
    lines.push('  <concepts>');
    for (const c of r.concepts) {
      lines.push(`    <concept>${escapeXml(c)}</concept>`);
    }
    lines.push('  </concepts>');
  }
  if (r.files.length > 0) {
    lines.push('  <files>');
    for (const f of r.files) {
      lines.push(`    <file>${escapeXml(f)}</file>`);
    }
    lines.push('  </files>');
  }
  lines.push('</memory_record>');
  return lines.join('\n');
}

// ── Property test ───────────────────────────────────────────────────────

describe('parseMemoryXml — property: XML parse extracts all valid records (P3)', () => {
  it('round-trips N records through serialize → parse with matching count and fields', () => {
    /**
     * **Validates: Requirements 4.1, 4.2**
     *
     * For any array of RawMemoryFields with valid types and non-empty
     * title/summary, serializing to XML and parsing back SHALL produce
     * the same count and matching field values.
     */
    fc.assert(
      fc.property(
        fc.array(rawMemoryFieldsArb, { minLength: 0, maxLength: 5 }),
        (records) => {
          const xml = records.map(serializeRecord).join('\n');
          const parsed = parseMemoryXml(xml);

          // Count must match
          expect(parsed.length).toBe(records.length);

          // Field values must match
          for (let i = 0; i < records.length; i++) {
            const original = records[i]!;
            const result = parsed[i]!;

            expect(result.type).toBe(original.type);
            expect(result.title).toBe(original.title.slice(0, 200));
            expect(result.summary).toBe(original.summary.slice(0, 4000));
            expect(result.facts).toEqual(original.facts);
            expect(result.concepts).toEqual(original.concepts);
            expect(result.files).toEqual(original.files);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
