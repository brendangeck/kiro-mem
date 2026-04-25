/**
 * Unit tests for the XML parser module.
 *
 * Tests `parseMemoryXml` and `isGarbageResponse` with specific examples
 * covering valid records, multiple records, invalid types, missing fields,
 * XML unescaping, and garbage detection.
 *
 * @see .kiro/specs/xml-extraction-pipeline/design.md § Component 3
 * @see .kiro/specs/xml-extraction-pipeline/requirements.md § Requirements 4, 5
 */

import { describe, expect, it } from 'vitest';

import {
  isGarbageResponse,
  parseMemoryXml,
  unescapeXml,
} from '../../src/collector/pipeline/xml-parser.js';

// ── unescapeXml ─────────────────────────────────────────────────────────

describe('unescapeXml', () => {
  it('converts all five entity references back to original characters', () => {
    const input = '&lt;div class=&quot;a&quot; data-x=&apos;b&apos;&gt;Tom &amp; Jerry&lt;/div&gt;';
    expect(unescapeXml(input)).toBe(`<div class="a" data-x='b'>Tom & Jerry</div>`);
  });

  it('returns the same string when no entities are present', () => {
    expect(unescapeXml('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(unescapeXml('')).toBe('');
  });
});

// ── parseMemoryXml — single record ──────────────────────────────────────

describe('parseMemoryXml — single record', () => {
  it('parses a single valid <memory_record> block', () => {
    const xml = `
<memory_record type="tool_use">
  <title>Added JWT validation</title>
  <summary>Wrote JWT token validation logic in src/auth.ts</summary>
  <facts>
    <fact>JWT uses RS256</fact>
    <fact>Token expiry checked first</fact>
  </facts>
  <concepts>
    <concept>jwt</concept>
    <concept>authentication</concept>
  </concepts>
  <files>
    <file>src/auth.ts</file>
  </files>
</memory_record>`;

    const records = parseMemoryXml(xml);

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      type: 'tool_use',
      title: 'Added JWT validation',
      summary: 'Wrote JWT token validation logic in src/auth.ts',
      facts: ['JWT uses RS256', 'Token expiry checked first'],
      concepts: ['jwt', 'authentication'],
      files: ['src/auth.ts'],
    });
  });

  it('returns empty arrays for missing optional child elements', () => {
    const xml = `
<memory_record type="decision">
  <title>Chose SQLite over PostgreSQL</title>
  <summary>Selected SQLite for zero-dependency local storage</summary>
</memory_record>`;

    const records = parseMemoryXml(xml);

    expect(records).toHaveLength(1);
    expect(records[0]!.facts).toEqual([]);
    expect(records[0]!.concepts).toEqual([]);
    expect(records[0]!.files).toEqual([]);
  });
});

// ── parseMemoryXml — multiple records ───────────────────────────────────

describe('parseMemoryXml — multiple records', () => {
  it('parses multiple <memory_record> blocks in one response', () => {
    const xml = `
<memory_record type="tool_use">
  <title>First record</title>
  <summary>First summary</summary>
</memory_record>
<memory_record type="discovery">
  <title>Second record</title>
  <summary>Second summary</summary>
  <concepts>
    <concept>testing</concept>
  </concepts>
</memory_record>
<memory_record type="error">
  <title>Third record</title>
  <summary>Third summary</summary>
</memory_record>`;

    const records = parseMemoryXml(xml);

    expect(records).toHaveLength(3);
    expect(records[0]!.type).toBe('tool_use');
    expect(records[0]!.title).toBe('First record');
    expect(records[1]!.type).toBe('discovery');
    expect(records[1]!.title).toBe('Second record');
    expect(records[1]!.concepts).toEqual(['testing']);
    expect(records[2]!.type).toBe('error');
    expect(records[2]!.title).toBe('Third record');
  });
});

// ── parseMemoryXml — invalid type ───────────────────────────────────────

describe('parseMemoryXml — invalid type', () => {
  it('skips records with invalid type attribute', () => {
    const xml = `
<memory_record type="implementation">
  <title>Should be skipped</title>
  <summary>Invalid type</summary>
</memory_record>
<memory_record type="tool_use">
  <title>Valid record</title>
  <summary>This one is valid</summary>
</memory_record>`;

    const records = parseMemoryXml(xml);

    expect(records).toHaveLength(1);
    expect(records[0]!.type).toBe('tool_use');
    expect(records[0]!.title).toBe('Valid record');
  });
});

// ── parseMemoryXml — missing title or summary ───────────────────────────

describe('parseMemoryXml — missing title or summary', () => {
  it('skips records with missing title', () => {
    const xml = `
<memory_record type="tool_use">
  <summary>Has summary but no title</summary>
</memory_record>`;

    expect(parseMemoryXml(xml)).toHaveLength(0);
  });

  it('skips records with missing summary', () => {
    const xml = `
<memory_record type="tool_use">
  <title>Has title but no summary</title>
</memory_record>`;

    expect(parseMemoryXml(xml)).toHaveLength(0);
  });

  it('skips records with empty title', () => {
    const xml = `
<memory_record type="tool_use">
  <title>   </title>
  <summary>Has summary</summary>
</memory_record>`;

    expect(parseMemoryXml(xml)).toHaveLength(0);
  });

  it('skips records with empty summary', () => {
    const xml = `
<memory_record type="tool_use">
  <title>Has title</title>
  <summary>   </summary>
</memory_record>`;

    expect(parseMemoryXml(xml)).toHaveLength(0);
  });
});

// ── parseMemoryXml — XML unescaping ─────────────────────────────────────

describe('parseMemoryXml — XML unescaping', () => {
  it('unescapes entity references in extracted content', () => {
    const xml = `
<memory_record type="tool_use">
  <title>x &lt; 5 &amp;&amp; y &gt; 3</title>
  <summary>Used &quot;strict&quot; mode with &apos;single quotes&apos;</summary>
  <facts>
    <fact>a &amp; b</fact>
  </facts>
  <concepts>
    <concept>C++ &amp; Rust</concept>
  </concepts>
  <files>
    <file>src/a&amp;b.ts</file>
  </files>
</memory_record>`;

    const records = parseMemoryXml(xml);

    expect(records).toHaveLength(1);
    expect(records[0]!.title).toBe('x < 5 && y > 3');
    expect(records[0]!.summary).toBe(`Used "strict" mode with 'single quotes'`);
    expect(records[0]!.facts).toEqual(['a & b']);
    expect(records[0]!.concepts).toEqual(['C++ & Rust']);
    expect(records[0]!.files).toEqual(['src/a&b.ts']);
  });
});

// ── parseMemoryXml — truncation ─────────────────────────────────────────

describe('parseMemoryXml — truncation', () => {
  it('truncates title to 200 characters', () => {
    const longTitle = 'A'.repeat(300);
    const xml = `
<memory_record type="tool_use">
  <title>${longTitle}</title>
  <summary>Short summary</summary>
</memory_record>`;

    const records = parseMemoryXml(xml);

    expect(records).toHaveLength(1);
    expect(records[0]!.title.length).toBe(200);
  });

  it('truncates summary to 4000 characters', () => {
    const longSummary = 'B'.repeat(5000);
    const xml = `
<memory_record type="tool_use">
  <title>Short title</title>
  <summary>${longSummary}</summary>
</memory_record>`;

    const records = parseMemoryXml(xml);

    expect(records).toHaveLength(1);
    expect(records[0]!.summary.length).toBe(4000);
  });
});

// ── parseMemoryXml — empty input ────────────────────────────────────────

describe('parseMemoryXml — empty input', () => {
  it('returns empty array for empty string', () => {
    expect(parseMemoryXml('')).toEqual([]);
  });

  it('returns empty array for whitespace-only string', () => {
    expect(parseMemoryXml('   \n\t  ')).toEqual([]);
  });
});

// ── isGarbageResponse ───────────────────────────────────────────────────

describe('isGarbageResponse', () => {
  it('returns false for empty string', () => {
    expect(isGarbageResponse('')).toBe(false);
  });

  it('returns false for whitespace-only string', () => {
    expect(isGarbageResponse('   \n\t  ')).toBe(false);
  });

  it('returns true for conversational text', () => {
    expect(isGarbageResponse('Sure! Here is the information you requested.')).toBe(true);
  });

  it('returns true for non-XML prose', () => {
    expect(isGarbageResponse('I analyzed the tool observation and found...')).toBe(true);
  });

  it('returns false for string containing <memory_record', () => {
    expect(
      isGarbageResponse('<memory_record type="tool_use"><title>T</title><summary>S</summary></memory_record>'),
    ).toBe(false);
  });

  it('returns false for string containing <skip/> tag', () => {
    expect(isGarbageResponse('<skip/>')).toBe(false);
  });

  it('returns false for string containing <skip> with attributes', () => {
    expect(isGarbageResponse('<skip reason="not relevant"/>')).toBe(false);
  });
});
