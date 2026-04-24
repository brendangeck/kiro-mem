/**
 * Property-based tests for `parseMemoryRecord`.
 *
 * Two properties, both driven by the `arbitraryMemoryRecord()` generator in
 * `test/arbitrary.ts`:
 *
 * - Round-trip (Requirement 3.2): every valid `MemoryRecord` passes the
 *   validator unchanged.
 * - Single-field mutation rejection (Requirements 3.3, 3.4): breaking one
 *   rule causes `parseMemoryRecord` to throw `ZodError`, with the error path
 *   naming the mutated field.
 *
 * Mirrors the style of `test/parseEvent.mutation.property.test.ts` — a
 * `Mutator[]` table and a `for...of` loop generating one `it(...)` per
 * mutator.
 *
 * @see .kiro/specs/event-schema-and-storage/design.md § Zod Schemas
 * @see .kiro/specs/event-schema-and-storage/requirements.md § Requirement 3
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ZodError, type ZodIssue } from 'zod';

import { parseMemoryRecord, type MemoryRecord } from '../src/types/schemas.js';
import { arbitraryMemoryRecord } from './arbitrary.js';

/**
 * Run `parseMemoryRecord` on input expected to fail and return the first
 * `ZodIssue` so the caller can assert on `path`.
 */
function firstIssueFor(input: unknown): ZodIssue {
  try {
    parseMemoryRecord(input);
  } catch (err) {
    expect(err).toBeInstanceOf(ZodError);
    const issues = (err as ZodError).issues;
    expect(issues.length).toBeGreaterThan(0);
    const first = issues[0];
    if (first === undefined) {
      throw new Error('ZodError has no issues');
    }
    return first;
  }
  throw new Error('parseMemoryRecord unexpectedly succeeded');
}

/**
 * A single targeted mutation applied to a valid `MemoryRecord`. Each mutator
 * breaks exactly one rule in the schema; the test asserts the resulting
 * `ZodError` points at the field that was broken.
 */
interface Mutator {
  /** Human-readable name used as the test title suffix. */
  readonly name: string;
  /** Segment that must appear in `issue.path` for the first failing rule. */
  readonly expectedPathSegment: string;
  /** Produce a single-field-broken copy of the given valid record. */
  mutate(r: MemoryRecord): unknown;
}

/**
 * Mutators covering Requirements 3.3 and 3.4. Each preserves every other
 * field so the only failing rule is the one named in `expectedPathSegment`.
 */
const MUTATORS: readonly Mutator[] = [
  // Requirement 3.3 — record_id must match `mr_<ULID>`.
  {
    name: 'record_id (Requirement 3.3)',
    expectedPathSegment: 'record_id',
    mutate: (r) => ({ ...r, record_id: 'not-a-record-id' }),
  },
  // Requirement 3.4 — source_event_ids must be non-empty.
  {
    name: 'source_event_ids (Requirement 3.4)',
    expectedPathSegment: 'source_event_ids',
    mutate: (r) => ({ ...r, source_event_ids: [] }),
  },
];

describe('parseMemoryRecord — property: arbitrary valid records round-trip', () => {
  it('accepts every generated record and returns it unchanged (Requirement 3.2)', () => {
    /**
     * **Validates: Requirements 3.2**
     *
     * For any arbitrary valid `MemoryRecord`, `parseMemoryRecord` must
     * succeed and return a value deeply equal to the input.
     */
    fc.assert(
      fc.property(arbitraryMemoryRecord(), (r) => {
        const parsed = parseMemoryRecord(r);
        expect(parsed).toEqual(r);
      }),
    );
  });
});

describe('parseMemoryRecord — property: single-field mutations are rejected', () => {
  for (const mutator of MUTATORS) {
    it(`rejects a mutated ${mutator.name} and the error path identifies it`, () => {
      /**
       * **Validates: Requirements 3.3, 3.4**
       *
       * For any arbitrary valid `MemoryRecord`, applying a single targeted
       * mutation MUST cause `parseMemoryRecord` to throw `ZodError`, and the
       * first issue's `path` MUST contain the segment naming the mutated
       * field.
       */
      fc.assert(
        fc.property(arbitraryMemoryRecord(), (r) => {
          const bad = mutator.mutate(r);
          expect(() => parseMemoryRecord(bad)).toThrow(ZodError);

          const issue = firstIssueFor(bad);
          expect(issue.path).toContain(mutator.expectedPathSegment);
        }),
      );
    });
  }
});
