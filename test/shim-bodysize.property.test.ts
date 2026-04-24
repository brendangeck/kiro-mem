/**
 * Property-based tests for body size bound (Property 4).
 *
 * For any event body (text, message, json) of arbitrary size,
 * `truncateBody(body, maxBytes)` produces a body whose
 * `Buffer.byteLength(JSON.stringify(result), 'utf8')` is ≤
 * `maxBytes + 26` (marker length).
 *
 * **Validates: Requirements 10.1, 10.2, 10.3, 10.4**
 *
 * @see .kiro/specs/shim/design.md § Correctness Properties — Property 4
 */

import fc from 'fast-check';
import type * as nodeOs from 'node:os';
import { describe, expect, it, vi } from 'vitest';

const tmpBase = '/tmp';
vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return { ...original, homedir: () => tmpBase };
});

const { truncateBody } = await import('../src/shim/shared/index.js');

/** Marker is ' [truncated by kiro-learn]' — 26 UTF-8 bytes. */
const MARKER_LEN = Buffer.byteLength(' [truncated by kiro-learn]', 'utf8'); // 26

describe('Property 4: Body size bound', () => {
  it('truncateBody output size ≤ maxBytes + marker for text bodies', () => {
    /**
     * **Validates: Requirements 10.1, 10.2**
     *
     * For any text body with large content and any maxBytes value,
     * the truncated result serialized size never exceeds maxBytes + marker.
     */
    fc.assert(
      fc.property(
        fc.string({ minLength: 100, maxLength: 10_000 }),
        fc.integer({ min: 100, max: 10_000 }),
        (content, maxBytes) => {
          const body = { type: 'text' as const, content };
          const result = truncateBody(body, maxBytes);
          const size = Buffer.byteLength(JSON.stringify(result), 'utf8');
          expect(size).toBeLessThanOrEqual(maxBytes + MARKER_LEN);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('truncateBody output size ≤ maxBytes + marker for json bodies with string tool_response.result', () => {
    /**
     * **Validates: Requirements 10.1, 10.3**
     *
     * For any json body where `data.tool_response.result` is a large string,
     * the truncated result serialized size never exceeds maxBytes + marker.
     */
    fc.assert(
      fc.property(
        fc.string({ minLength: 100, maxLength: 10_000 }),
        fc.integer({ min: 200, max: 10_000 }),
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
          const size = Buffer.byteLength(JSON.stringify(truncated), 'utf8');
          expect(size).toBeLessThanOrEqual(maxBytes + MARKER_LEN);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('truncateBody output size ≤ maxBytes + marker for message bodies', () => {
    /**
     * **Validates: Requirements 10.1, 10.2**
     *
     * For any message body with large turn content and any maxBytes value
     * above the structural envelope overhead, the truncated result
     * serialized size never exceeds maxBytes + marker. The minimum
     * maxBytes is set to 300 to accommodate the JSON envelope of up to
     * 5 turns (roles, array brackets, etc.).
     */
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            role: fc.constantFrom('user', 'assistant'),
            content: fc.string({ minLength: 100, maxLength: 10_000 }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        fc.integer({ min: 300, max: 10_000 }),
        (turns, maxBytes) => {
          const body = { type: 'message' as const, turns };
          const result = truncateBody(body, maxBytes);
          const size = Buffer.byteLength(JSON.stringify(result), 'utf8');
          expect(size).toBeLessThanOrEqual(maxBytes + MARKER_LEN);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('truncateBody output size ≤ maxBytes + marker for json bodies with non-string data', () => {
    /**
     * **Validates: Requirements 10.1, 10.4**
     *
     * For any json body where data is a large object (no string
     * tool_response.result), the truncated result serialized size never
     * exceeds maxBytes + marker.
     */
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 10, maxLength: 200 }), {
          minLength: 5,
          maxLength: 50,
        }),
        fc.integer({ min: 200, max: 10_000 }),
        (items, maxBytes) => {
          // Build a large object without a string tool_response.result
          const data: Record<string, string> = {};
          for (let i = 0; i < items.length; i++) {
            data[`key_${String(i)}`] = items[i]!;
          }
          const body = { type: 'json' as const, data };
          const truncated = truncateBody(body, maxBytes);
          const size = Buffer.byteLength(JSON.stringify(truncated), 'utf8');
          expect(size).toBeLessThanOrEqual(maxBytes + MARKER_LEN);
        },
      ),
      { numRuns: 50 },
    );
  });
});
