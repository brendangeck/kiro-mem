/**
 * Property-based tests for truncation type preservation (Property 7).
 *
 * For any event body and any byte limit, `truncateBody(body, limit).type`
 * SHALL equal `body.type`. Truncation never changes the body variant.
 *
 * **Validates: Requirements 10.2, 10.3, 10.4**
 *
 * @see .kiro/specs/shim/design.md § Correctness Properties — Property 7
 */

import fc from 'fast-check';
import type * as nodeOs from 'node:os';
import { describe, expect, it, vi } from 'vitest';

import { eventBodyArb } from './arbitrary.js';

const tmpBase = '/tmp';
vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return { ...original, homedir: () => tmpBase };
});

const { truncateBody } = await import('../src/shim/shared/index.js');

describe('Property 7: Truncation preserves body type', () => {
  it('truncateBody(body, limit).type === body.type for any body and limit', () => {
    /**
     * **Validates: Requirements 10.2, 10.3, 10.4**
     *
     * For any event body (text, message, json) and any maxBytes value,
     * the truncated result preserves the original body type discriminant.
     */
    fc.assert(
      fc.property(
        eventBodyArb(),
        fc.integer({ min: 10, max: 100_000 }),
        (body, maxBytes) => {
          const result = truncateBody(body, maxBytes);
          expect(result.type).toBe(body.type);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('preserves type for oversized text bodies that force truncation', () => {
    /**
     * **Validates: Requirements 10.2, 10.4**
     *
     * Generate large text bodies (>10 KiB) with small byte limits to
     * ensure truncation actually occurs and the type is still preserved.
     */
    fc.assert(
      fc.property(
        fc.string({ minLength: 10_000, maxLength: 50_000 }),
        fc.integer({ min: 50, max: 500 }),
        (content, maxBytes) => {
          const body = { type: 'text' as const, content };
          const result = truncateBody(body, maxBytes);
          expect(result.type).toBe('text');
        },
      ),
      { numRuns: 50 },
    );
  });

  it('preserves type for oversized json bodies with string tool_response.result', () => {
    /**
     * **Validates: Requirements 10.3**
     *
     * Generate json bodies with large tool_response.result strings and
     * small byte limits to ensure truncation occurs and type is preserved.
     */
    fc.assert(
      fc.property(
        fc.string({ minLength: 10_000, maxLength: 50_000 }),
        fc.integer({ min: 100, max: 500 }),
        (result, maxBytes) => {
          const body = {
            type: 'json' as const,
            data: {
              tool_name: 'test_tool',
              tool_input: { key: 'value' },
              tool_response: { success: true, result },
            },
          };
          const truncated = truncateBody(body, maxBytes);
          expect(truncated.type).toBe('json');
        },
      ),
      { numRuns: 50 },
    );
  });

  it('preserves type for oversized message bodies with many turns', () => {
    /**
     * **Validates: Requirements 10.2, 10.4**
     *
     * Generate message bodies with many turns containing large content
     * and small byte limits to ensure truncation occurs and type is preserved.
     */
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            role: fc.constantFrom('user', 'assistant'),
            content: fc.string({ minLength: 2_000, maxLength: 10_000 }),
          }),
          { minLength: 2, maxLength: 5 },
        ),
        fc.integer({ min: 100, max: 500 }),
        (turns, maxBytes) => {
          const body = { type: 'message' as const, turns };
          const result = truncateBody(body, maxBytes);
          expect(result.type).toBe('message');
        },
      ),
      { numRuns: 50 },
    );
  });
});
