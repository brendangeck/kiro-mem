/**
 * Property-based tests for `parseEvent` using targeted single-field
 * mutations of arbitrary valid events.
 *
 * Covers Correctness Property P5: for any valid `KiroMemEvent`, breaking
 * exactly one rule causes `parseEvent` to throw `ZodError` and the error
 * path names the mutated field.
 *
 * This is the mirror of `test/arbitrary.property.test.ts` (P1 positive
 * side): valid events round-trip; events with a single targeted break
 * fail — and the failure points at the right field.
 *
 * @see .kiro/specs/event-schema-and-storage/design.md § P5 parseEvent rejects invalid input
 * @see .kiro/specs/event-schema-and-storage/requirements.md § Requirement 2
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ZodError, type ZodIssue } from 'zod';

import { parseEvent, type KiroMemEvent } from '../../src/types/schemas.js';
import { arbitraryEvent } from '../helpers/arbitrary.js';

/**
 * Run `parseEvent` on input that is expected to fail and return the first
 * `ZodIssue` so the caller can assert on `path`. Mirrors the helper in
 * `test/schemas.test.ts` — inlined here to keep this file self-contained.
 */
function firstIssueFor(input: unknown): ZodIssue {
  try {
    parseEvent(input);
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
  throw new Error('parseEvent unexpectedly succeeded');
}

/**
 * A single targeted mutation applied to a valid `KiroMemEvent`. Each
 * mutator breaks exactly one rule in the schema; the test then asserts the
 * resulting `ZodError` points at the field that was broken.
 */
interface Mutator {
  /** Human-readable name used as the test title suffix. */
  readonly name: string;
  /**
   * String fragment that must appear in `issue.path`. For nested paths
   * (e.g. `source.surface`) we use the leaf segment; the parent segment
   * would also work but the leaf is the minimum signal required by
   * Requirement 2.11.
   */
  readonly expectedPathSegment: string;
  /** Produce a single-field-broken copy of the given valid event. */
  mutate(e: KiroMemEvent): unknown;
}

/**
 * The eight mutations required by task 2.4. One per covered requirement.
 * Every mutator preserves all *other* fields of the event so that the only
 * failing rule is the one named in `expectedPathSegment`.
 */
const MUTATORS: readonly Mutator[] = [
  // Requirement 2.2 — event_id must match the ULID regex.
  {
    name: 'event_id (Requirement 2.2)',
    expectedPathSegment: 'event_id',
    mutate: (e) => ({ ...e, event_id: 'not-a-ulid' }),
  },
  // Requirement 2.3 — namespace must match /actor/{a}/project/{p}/.
  {
    name: 'namespace (Requirement 2.3)',
    expectedPathSegment: 'namespace',
    mutate: (e) => ({ ...e, namespace: 'garbage' }),
  },
  // Requirement 2.4 — schema_version must be literal 1.
  {
    name: 'schema_version (Requirement 2.4)',
    expectedPathSegment: 'schema_version',
    mutate: (e) => ({ ...e, schema_version: 2 }),
  },
  // Requirement 2.5 — kind must be one of the four enumerated values.
  {
    name: 'kind (Requirement 2.5)',
    expectedPathSegment: 'kind',
    mutate: (e) => ({ ...e, kind: 'not-a-kind' }),
  },
  // Requirement 2.6 — body.type must be text|message|json. Replace the
  // whole body with one carrying an unknown discriminator so the
  // discriminated-union validator fails on `type`.
  {
    name: 'body.type (Requirement 2.6)',
    expectedPathSegment: 'body',
    mutate: (e) => ({ ...e, body: { type: 'bogus', content: 'x' } }),
  },
  // Requirement 2.8 — valid_time must be a valid ISO 8601 timestamp.
  {
    name: 'valid_time (Requirement 2.8)',
    expectedPathSegment: 'valid_time',
    mutate: (e) => ({ ...e, valid_time: 'not-a-timestamp' }),
  },
  // Requirement 2.9 — when present, content_hash must match
  // sha256:<64-hex>. Assigning a bad value unconditionally both forces
  // the key to exist and breaks it — covering the case where
  // arbitraryEvent() omitted `content_hash` entirely.
  {
    name: 'content_hash (Requirement 2.9)',
    expectedPathSegment: 'content_hash',
    mutate: (e) => ({ ...e, content_hash: 'not-a-hash' }),
  },
  // Requirement 2.10 — source.surface must be 'kiro-cli' | 'kiro-ide'.
  // Preserve the rest of `source` so `version` and `client_id` stay
  // valid — the only broken field is `surface`.
  {
    name: 'source.surface (Requirement 2.10)',
    expectedPathSegment: 'surface',
    mutate: (e) => ({ ...e, source: { ...e.source, surface: 'not-a-surface' } }),
  },
];

describe('parseEvent — property: single-field mutations are rejected (P5)', () => {
  for (const mutator of MUTATORS) {
    it(`rejects a mutated ${mutator.name} and the error path identifies it (Requirement 2.11)`, () => {
      /**
       * **Validates: Requirements 2.2, 2.3, 2.4, 2.5, 2.6, 2.8, 2.9, 2.10, 2.11**
       *
       * For any arbitrary valid `KiroMemEvent`, applying a single targeted
       * mutation to one field MUST cause `parseEvent` to throw `ZodError`,
       * and the first issue's `path` MUST contain the segment naming the
       * mutated field. Together the eight mutators in this suite cover
       * every enumerated rule in Requirement 2.
       */
      fc.assert(
        fc.property(arbitraryEvent(), (e) => {
          const bad = mutator.mutate(e);
          expect(() => parseEvent(bad)).toThrow(ZodError);

          const issue = firstIssueFor(bad);
          expect(issue.path).toContain(mutator.expectedPathSegment);
        }),
      );
    });
  }
});
