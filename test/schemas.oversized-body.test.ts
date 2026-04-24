/**
 * Edge-case tests for the 1 MiB serialized-body cap enforced by
 * `EventBodySchema` in `src/types/schemas.ts`.
 *
 * One test per body variant, each constructed with content just over
 * 1 MiB (1_048_577 bytes of ASCII, which serializes to at least as many
 * bytes of JSON). Asserts `parseEvent` throws `ZodError` and the error
 * path identifies `body` as the offending field.
 *
 * @see .kiro/specs/event-schema-and-storage/requirements.md § Requirement 2.7
 * @see .kiro/specs/event-schema-and-storage/requirements.md § Requirement 12.3
 * @see .kiro/specs/event-schema-and-storage/design.md § Validation rules (Event)
 */

import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { parseEvent, type KiroMemEvent } from '../src/types/schemas.js';

/** 1 MiB + 1 byte — the smallest size that must be rejected. */
const OVER_LIMIT = 1_048_577;

const validEventBase: KiroMemEvent = {
  event_id: '01JF8ZS4Y00000000000000000',
  session_id: 'sess-1',
  actor_id: 'alice',
  namespace: '/actor/alice/project/abc/',
  schema_version: 1,
  kind: 'prompt',
  body: { type: 'text', content: 'hi' },
  valid_time: '2026-04-23T20:00:00Z',
  source: { surface: 'kiro-cli', version: '0.1.0', client_id: 'client-1' },
};

/**
 * Clone the minimal-valid event and override the `body` field with the
 * oversized payload under test. Everything else stays valid so the only
 * failing rule is the serialized-size cap.
 */
function eventWithBody(body: unknown): unknown {
  return { ...structuredClone(validEventBase), body };
}

describe('parseEvent — oversized body rejection (Requirements 2.7, 12.3)', () => {
  it('rejects a text body with content just over 1 MiB', () => {
    const bad = eventWithBody({
      type: 'text',
      content: 'a'.repeat(OVER_LIMIT),
    });

    expect(() => parseEvent(bad)).toThrow(ZodError);
  });

  it('rejects a message body whose serialized size just exceeds 1 MiB', () => {
    const bad = eventWithBody({
      type: 'message',
      turns: [{ role: 'user', content: 'x'.repeat(OVER_LIMIT) }],
    });

    expect(() => parseEvent(bad)).toThrow(ZodError);
  });

  it('rejects a json body whose serialized size just exceeds 1 MiB', () => {
    const bad = eventWithBody({
      type: 'json',
      data: { blob: 'y'.repeat(OVER_LIMIT) },
    });

    expect(() => parseEvent(bad)).toThrow(ZodError);
  });
});
