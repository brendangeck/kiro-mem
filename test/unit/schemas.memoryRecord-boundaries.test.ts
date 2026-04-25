/**
 * Edge-case boundary tests for `MemoryRecordSchema.title` and
 * `MemoryRecordSchema.summary` length rules. Exactly one test per boundary
 * condition (0 / 1 / max / max+1 chars) for each field.
 *
 * @see .kiro/specs/event-schema-and-storage/requirements.md § Requirement 3.5
 * @see .kiro/specs/event-schema-and-storage/tasks.md § Task 2.7
 */

import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { parseMemoryRecord, type MemoryRecord } from '../../src/types/schemas.js';

const validRecordBase: MemoryRecord = {
  record_id: 'mr_01JF8ZS4Z00000000000000000',
  namespace: '/actor/alice/project/abc/',
  strategy: 'llm-summary',
  title: 'Example',
  summary: 'A one-line summary of what happened.',
  facts: ['fact one', 'fact two'],
  source_event_ids: ['01JF8ZS4Y00000000000000000'],
  created_at: '2026-04-23T20:00:00Z',
  concepts: ['typescript'],
  files_touched: ['src/index.ts'],
  observation_type: 'tool_use',
};

/** Deep-clone the baseline and apply an override so mutations never leak. */
function validRecord(overrides: Record<string, unknown> = {}): unknown {
  return {
    ...structuredClone(validRecordBase),
    ...overrides,
  };
}

describe('parseMemoryRecord — title length boundaries (Requirement 3.5)', () => {
  it('rejects title at 0 chars (Requirement 3.5)', () => {
    const input = validRecord({ title: '' });
    expect(() => parseMemoryRecord(input)).toThrow(ZodError);
  });

  it('accepts title at 1 char (Requirement 3.5)', () => {
    const title = 'a'.repeat(1);
    const input = validRecord({ title });
    const result = parseMemoryRecord(input);
    expect(result.title).toHaveLength(1);
    expect(result.title).toBe(title);
  });

  it('accepts title at 200 chars (Requirement 3.5)', () => {
    const title = 'a'.repeat(200);
    const input = validRecord({ title });
    const result = parseMemoryRecord(input);
    expect(result.title).toHaveLength(200);
    expect(result.title).toBe(title);
  });

  it('rejects title at 201 chars (Requirement 3.5)', () => {
    const input = validRecord({ title: 'a'.repeat(201) });
    expect(() => parseMemoryRecord(input)).toThrow(ZodError);
  });
});

describe('parseMemoryRecord — summary length boundaries (Requirement 3.5)', () => {
  it('rejects summary at 0 chars (Requirement 3.5)', () => {
    const input = validRecord({ summary: '' });
    expect(() => parseMemoryRecord(input)).toThrow(ZodError);
  });

  it('accepts summary at 1 char (Requirement 3.5)', () => {
    const summary = 'a'.repeat(1);
    const input = validRecord({ summary });
    const result = parseMemoryRecord(input);
    expect(result.summary).toHaveLength(1);
    expect(result.summary).toBe(summary);
  });

  it('accepts summary at 4000 chars (Requirement 3.5)', () => {
    const summary = 'a'.repeat(4000);
    const input = validRecord({ summary });
    const result = parseMemoryRecord(input);
    expect(result.summary).toHaveLength(4000);
    expect(result.summary).toBe(summary);
  });

  it('rejects summary at 4001 chars (Requirement 3.5)', () => {
    const input = validRecord({ summary: 'a'.repeat(4001) });
    expect(() => parseMemoryRecord(input)).toThrow(ZodError);
  });
});
