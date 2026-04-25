/**
 * Unit tests for the new required fields on `MemoryRecordSchema`:
 * `concepts`, `files_touched`, and `observation_type`.
 *
 * Covers:
 * - Records with all three new fields pass validation
 * - Records missing any of the new fields fail validation
 * - Boundary values for `concepts` element length (max 100)
 * - Boundary values for `files_touched` element length (max 500)
 * - All valid `observation_type` enum values are accepted
 * - Invalid `observation_type` values are rejected
 *
 * @see .kiro/specs/xml-extraction-pipeline/requirements.md § Requirement 8
 * @see .kiro/specs/xml-extraction-pipeline/tasks.md § Task 1.3
 */

import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { parseMemoryRecord, type MemoryRecord } from '../../src/types/schemas.js';

/** Baseline valid record including all new required fields. */
const validRecordBase: MemoryRecord = {
  record_id: 'mr_01JF8ZS4Z00000000000000000',
  namespace: '/actor/alice/project/abc/',
  strategy: 'llm-summary',
  title: 'Example',
  summary: 'A one-line summary of what happened.',
  facts: ['fact one', 'fact two'],
  source_event_ids: ['01JF8ZS4Y00000000000000000'],
  created_at: '2026-04-23T20:00:00Z',
  concepts: ['typescript', 'testing'],
  files_touched: ['src/types/schemas.ts'],
  observation_type: 'tool_use',
};

/** Deep-clone the baseline and apply overrides. */
function validRecord(overrides: Record<string, unknown> = {}): unknown {
  return {
    ...structuredClone(validRecordBase),
    ...overrides,
  };
}

describe('parseMemoryRecord — new required fields happy path (Requirement 8.1, 8.2, 8.3)', () => {
  it('accepts a record with all three new fields present', () => {
    const input = validRecord();
    const result = parseMemoryRecord(input);
    expect(result.concepts).toEqual(['typescript', 'testing']);
    expect(result.files_touched).toEqual(['src/types/schemas.ts']);
    expect(result.observation_type).toBe('tool_use');
  });

  it('accepts a record with empty concepts and files_touched arrays', () => {
    const input = validRecord({ concepts: [], files_touched: [] });
    const result = parseMemoryRecord(input);
    expect(result.concepts).toEqual([]);
    expect(result.files_touched).toEqual([]);
  });
});

describe('parseMemoryRecord — missing new fields are rejected (Requirement 8.1, 8.2, 8.3)', () => {
  it('rejects a record missing concepts', () => {
    const input = validRecord();
    delete (input as Record<string, unknown>).concepts;
    expect(() => parseMemoryRecord(input)).toThrow(ZodError);
  });

  it('rejects a record missing files_touched', () => {
    const input = validRecord();
    delete (input as Record<string, unknown>).files_touched;
    expect(() => parseMemoryRecord(input)).toThrow(ZodError);
  });

  it('rejects a record missing observation_type', () => {
    const input = validRecord();
    delete (input as Record<string, unknown>).observation_type;
    expect(() => parseMemoryRecord(input)).toThrow(ZodError);
  });
});

describe('parseMemoryRecord — observation_type enum values (Requirement 8.3)', () => {
  const validTypes = ['tool_use', 'decision', 'error', 'discovery', 'pattern'] as const;

  for (const type of validTypes) {
    it(`accepts observation_type: "${type}"`, () => {
      const input = validRecord({ observation_type: type });
      const result = parseMemoryRecord(input);
      expect(result.observation_type).toBe(type);
    });
  }

  it('rejects an invalid observation_type value', () => {
    const input = validRecord({ observation_type: 'invalid_type' });
    expect(() => parseMemoryRecord(input)).toThrow(ZodError);
  });
});

describe('parseMemoryRecord — concepts element length boundaries (Requirement 8.1)', () => {
  it('rejects a concept with 0 chars (empty string)', () => {
    const input = validRecord({ concepts: [''] });
    expect(() => parseMemoryRecord(input)).toThrow(ZodError);
  });

  it('accepts a concept with 1 char', () => {
    const input = validRecord({ concepts: ['a'] });
    const result = parseMemoryRecord(input);
    expect(result.concepts).toEqual(['a']);
  });

  it('accepts a concept at exactly 100 chars', () => {
    const concept = 'a'.repeat(100);
    const input = validRecord({ concepts: [concept] });
    const result = parseMemoryRecord(input);
    expect(result.concepts[0]).toHaveLength(100);
  });

  it('rejects a concept at 101 chars', () => {
    const concept = 'a'.repeat(101);
    const input = validRecord({ concepts: [concept] });
    expect(() => parseMemoryRecord(input)).toThrow(ZodError);
  });
});

describe('parseMemoryRecord — files_touched element length boundaries (Requirement 8.2)', () => {
  it('rejects a file path with 0 chars (empty string)', () => {
    const input = validRecord({ files_touched: [''] });
    expect(() => parseMemoryRecord(input)).toThrow(ZodError);
  });

  it('accepts a file path with 1 char', () => {
    const input = validRecord({ files_touched: ['a'] });
    const result = parseMemoryRecord(input);
    expect(result.files_touched).toEqual(['a']);
  });

  it('accepts a file path at exactly 500 chars', () => {
    const filePath = 'a'.repeat(500);
    const input = validRecord({ files_touched: [filePath] });
    const result = parseMemoryRecord(input);
    expect(result.files_touched[0]).toHaveLength(500);
  });

  it('rejects a file path at 501 chars', () => {
    const filePath = 'a'.repeat(501);
    const input = validRecord({ files_touched: [filePath] });
    expect(() => parseMemoryRecord(input)).toThrow(ZodError);
  });
});
