/**
 * Shared fixture factories for kiro-learn test suites.
 *
 * These helpers produce minimal, valid `KiroMemEvent` / `MemoryRecord`
 * wire shapes that satisfy every Zod validator in `src/types/schemas.ts`.
 * They exist so tests that want a known-good baseline — especially ones
 * that then apply a single, focused mutation or override — avoid
 * duplicating the 10+ required fields inline.
 *
 * The generators in `test/arbitrary.ts` cover property-based testing;
 * this file is deliberately example-shaped, not property-shaped. Use
 * whichever fits the test's intent.
 *
 * Override semantics mirror the style used in `test/schemas.test.ts`:
 * pass a partial bag of overrides to replace any field on the baseline.
 * `structuredClone` guards against a test mutating state other tests
 * read from.
 *
 * @see .kiro/specs/event-schema-and-storage/design.md § Zod Schemas
 */

import type { KiroMemEvent, MemoryRecord } from '../../src/types/schemas.js';

/**
 * Canonical valid event used as the baseline for {@link makeValidEvent}.
 * Every test that wants a slightly-different event should spread this
 * and override the fields it cares about rather than redefine the whole
 * shape.
 */
const EVENT_BASE: KiroMemEvent = {
  event_id: '01JF8ZS4Y00000000000000000',
  session_id: 'sess-1',
  actor_id: 'alice',
  namespace: '/actor/alice/project/abc/',
  schema_version: 1,
  kind: 'prompt',
  body: { type: 'text', content: 'hello' },
  valid_time: '2026-04-23T20:00:00Z',
  source: { surface: 'kiro-cli', version: '0.1.0', client_id: 'client-1' },
};

/**
 * Build a valid {@link KiroMemEvent} with optional field overrides.
 *
 * The return value is a fresh clone of {@link EVENT_BASE}, so callers can
 * freely mutate it without leaking state between tests. Overrides are
 * typed as `Record<string, unknown>` rather than `Partial<KiroMemEvent>`
 * because `exactOptionalPropertyTypes` makes `Partial` fields implicitly
 * `| undefined`, and the whole point here is to let tests stamp in
 * arbitrary shapes (including known-bad ones). The final cast to
 * `KiroMemEvent` is safe in practice because tests either pass no
 * overrides or verify the result through `parseEvent` / storage writes.
 */
export function makeValidEvent(overrides: Record<string, unknown> = {}): KiroMemEvent {
  return {
    ...structuredClone(EVENT_BASE),
    ...overrides,
  } as KiroMemEvent;
}

/**
 * Canonical valid memory record used as the baseline for
 * {@link makeValidRecord}. Mirrors the record used in
 * `test/schemas.test.ts` so test output stays comparable across suites.
 */
const RECORD_BASE: MemoryRecord = {
  record_id: 'mr_01JF8ZS4Z00000000000000000',
  namespace: '/actor/alice/project/abc/',
  strategy: 'llm-summary',
  title: 'Example record',
  summary: 'A one-line summary of what happened in this session.',
  facts: ['fact one', 'fact two'],
  source_event_ids: ['01JF8ZS4Y00000000000000000'],
  created_at: '2026-04-23T20:00:00Z',
};

/**
 * Build a valid {@link MemoryRecord} with optional field overrides. Same
 * override semantics as {@link makeValidEvent}.
 */
export function makeValidRecord(overrides: Record<string, unknown> = {}): MemoryRecord {
  return {
    ...structuredClone(RECORD_BASE),
    ...overrides,
  } as MemoryRecord;
}
