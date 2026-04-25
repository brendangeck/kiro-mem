/**
 * Property-based tests for `parseEvent` using the fast-check arbitraries in
 * `test/arbitrary.ts`.
 *
 * Covers Correctness Property P1 (validator side): every generated valid
 * `KiroMemEvent` round-trips through `parseEvent` unchanged.
 *
 * @see .kiro/specs/event-schema-and-storage/design.md § Correctness Properties
 * @see .kiro/specs/event-schema-and-storage/requirements.md § Requirement 2.1
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseEvent } from '../../src/types/schemas.js';
import { arbitraryEvent } from '../helpers/arbitrary.js';

describe('parseEvent — property: arbitrary valid events round-trip (P1)', () => {
  it('accepts every generated event and returns it unchanged', () => {
    /**
     * **Validates: Requirements 2.1**
     *
     * For any arbitrary valid `KiroMemEvent`, `parseEvent` must succeed and
     * return a value deeply equal to the input. This anchors the "validator
     * side" of Correctness Property P1.
     */
    fc.assert(
      fc.property(arbitraryEvent(), (e) => {
        const parsed = parseEvent(e);
        expect(parsed).toEqual(e);
      }),
    );
  });
});
